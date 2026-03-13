"""
Voice Analysis v2 microservice — transformer-based models.

Upgrade from v1 (ECAPA-TDNN + SVM/SVR):
  - Emotion:     emotion2vec+ base (FunASR, 9-class, 4788h training data)
  - ADV:         audeering wav2vec2-large-robust-12-ft-emotion-msp-dim (continuous 0-1)
  - Age+Gender:  audeering wav2vec2-large-robust-24-ft-age-gender (MAE ~7-11yr)
  - Height:      REMOVED (scientifically unreliable in adult humans)

All ADV values on 0-1 scale. Age output is 0-1 normalized (×100 for years).
"""

import asyncio
import io
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from typing import Any

import librosa
import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from transformers import Wav2Vec2Processor
from transformers.models.wav2vec2.modeling_wav2vec2 import (
    Wav2Vec2Model,
    Wav2Vec2PreTrainedModel,
)

logger = logging.getLogger(__name__)

# Max upload size: 25 MB (Telegram voice messages are typically < 1 MB)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

ALLOWED_CONTENT_TYPES = {
    "audio/ogg", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac",
    "audio/mp4", "audio/webm", "audio/aac", "video/ogg",
    "application/ogg", "application/octet-stream",
}

# Age-gender model softmax output order (from model card example).
GENDER_LABELS = ["female", "male", "child"]

# Fallback ADV lookup (0-1 scale) when audeering emotion-dim model is
# unavailable.  Derived from Russell's circumplex / Warriner norms,
# converted from 1-5 to 0-1 via (val - 1) / 4.
EMOTION_ADV_FALLBACK: dict[str, dict[str, float]] = {
    "angry":     {"arousal": 0.825, "dominance": 0.725, "valence": 0.200},
    "disgusted": {"arousal": 0.600, "dominance": 0.550, "valence": 0.175},
    "fearful":   {"arousal": 0.775, "dominance": 0.150, "valence": 0.150},
    "happy":     {"arousal": 0.750, "dominance": 0.700, "valence": 0.850},
    "neutral":   {"arousal": 0.250, "dominance": 0.500, "valence": 0.550},
    "other":     {"arousal": 0.375, "dominance": 0.375, "valence": 0.375},
    "sad":       {"arousal": 0.275, "dominance": 0.225, "valence": 0.150},
    "surprised": {"arousal": 0.800, "dominance": 0.450, "valence": 0.525},
    "unknown":   {"arousal": 0.375, "dominance": 0.375, "valence": 0.375},
}


# ---------------------------------------------------------------------------
# audeering wav2vec2 model classes (adapted from HuggingFace model cards).
# Paper: https://arxiv.org/abs/2306.16962
# License: CC-BY-NC-SA-4.0
# ---------------------------------------------------------------------------

class _RegressionHead(nn.Module):
    """Single regression/classification head for wav2vec2 pooled outputs."""

    def __init__(self, config, num_labels: int | None = None):
        super().__init__()
        n = num_labels if num_labels is not None else config.num_labels
        self.dense = nn.Linear(config.hidden_size, config.hidden_size)
        self.dropout = nn.Dropout(config.final_dropout)
        self.out_proj = nn.Linear(config.hidden_size, n)

    def forward(self, features, **kwargs):
        x = self.dropout(features)
        x = self.dense(x)
        x = torch.tanh(x)
        x = self.dropout(x)
        return self.out_proj(x)


class EmotionDimModel(Wav2Vec2PreTrainedModel):
    """Arousal/Dominance/Valence regression (audeering, 12-layer, MSP-Podcast).

    Returns (hidden_states, logits) where logits is [arousal, dominance, valence]
    each in approximately 0..1.
    """

    def __init__(self, config):
        super().__init__(config)
        self.config = config
        self.wav2vec2 = Wav2Vec2Model(config)
        self.classifier = _RegressionHead(config)   # num_labels = 3
        self.init_weights()

    def forward(self, input_values):
        outputs = self.wav2vec2(input_values)
        hidden_states = torch.mean(outputs[0], dim=1)
        logits = self.classifier(hidden_states)
        return hidden_states, logits


class AgeGenderModel(Wav2Vec2PreTrainedModel):
    """Age regression + gender classification (audeering, 24-layer).

    Returns (hidden_states, logits_age, logits_gender):
      - logits_age:    shape (batch, 1) in ~0..1, multiply by 100 for years
      - logits_gender: shape (batch, 3) softmax [female, male, child]
    """

    def __init__(self, config):
        super().__init__(config)
        self.config = config
        self.wav2vec2 = Wav2Vec2Model(config)
        self.age = _RegressionHead(config, num_labels=1)
        self.gender = _RegressionHead(config, num_labels=3)
        self.init_weights()

    def forward(self, input_values):
        outputs = self.wav2vec2(input_values)
        hidden_states = torch.mean(outputs[0], dim=1)
        logits_age = self.age(hidden_states)
        logits_gender = torch.softmax(self.gender(hidden_states), dim=1)
        return hidden_states, logits_age, logits_gender


# ---------------------------------------------------------------------------
# Model singletons (loaded at startup)
# ---------------------------------------------------------------------------
emotion_model: Any = None                           # FunASR AutoModel
emotion_dim_model: EmotionDimModel | None = None
emotion_dim_processor: Wav2Vec2Processor | None = None
age_gender_model: AgeGenderModel | None = None
age_gender_processor: Wav2Vec2Processor | None = None

# Limit concurrent inference to avoid OOM on small containers
_inference_semaphore = asyncio.Semaphore(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global emotion_model
    global emotion_dim_model, emotion_dim_processor
    global age_gender_model, age_gender_processor

    logger.info("Loading voice analysis v2 models...")

    # 1. Emotion: emotion2vec+ base via FunASR
    try:
        from funasr import AutoModel as FunASRAutoModel
        emotion_model = FunASRAutoModel(model="iic/emotion2vec_plus_base")
        logger.info("  ✓ emotion2vec+ base loaded")
    except Exception:
        logger.exception("  ✗ emotion2vec+ base failed to load")

    # 2. Dimensional emotion (ADV): audeering wav2vec2 (12-layer, MSP-Podcast)
    try:
        name = "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
        emotion_dim_processor = Wav2Vec2Processor.from_pretrained(name)
        emotion_dim_model = EmotionDimModel.from_pretrained(name)
        emotion_dim_model.eval()
        logger.info("  ✓ audeering emotion-dim model loaded")
    except Exception:
        logger.exception("  ✗ audeering emotion-dim model failed to load")

    # 3. Age + Gender: audeering wav2vec2 (24-layer)
    try:
        name = "audeering/wav2vec2-large-robust-24-ft-age-gender"
        age_gender_processor = Wav2Vec2Processor.from_pretrained(name)
        age_gender_model = AgeGenderModel.from_pretrained(name)
        age_gender_model.eval()
        logger.info("  ✓ audeering age-gender model loaded")
    except Exception:
        logger.exception("  ✗ audeering age-gender model failed to load")

    logger.info("Model loading complete.")
    yield
    emotion_model = None
    emotion_dim_model = emotion_dim_processor = None
    age_gender_model = age_gender_processor = None
    logger.info("Models unloaded.")


app = FastAPI(title="Voice Analysis v2", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": 2,
        "models": {
            "emotion": emotion_model is not None,
            "emotion_dim": emotion_dim_model is not None,
            "age_gender": age_gender_model is not None,
        },
    }


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------

def _process_audeering(
    waveform: np.ndarray,
    sr: int,
    processor: Wav2Vec2Processor,
    model: Wav2Vec2PreTrainedModel,
) -> tuple:
    """Run audio through an audeering wav2vec2 model."""
    y = processor(waveform, sampling_rate=sr)
    y = np.array(y["input_values"][0]).reshape(1, -1)
    y = torch.from_numpy(y)
    with torch.no_grad():
        return model(y)


def _run_analysis(audio_bytes: bytes) -> dict:
    """Run all ML inference synchronously (called via asyncio.to_thread)."""
    waveform, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    duration = float(librosa.get_duration(y=waveform, sr=sr))
    result: dict[str, Any] = {"duration_seconds": round(duration, 3)}

    # --- Emotion (categorical, 9 classes) ---
    emotion_label: str | None = None
    if emotion_model is not None:
        try:
            # emotion2vec expects a file path — write temp WAV
            fd, tmp_path = tempfile.mkstemp(suffix=".wav")
            try:
                os.close(fd)   # close fd before sf.write to avoid double-open
                sf.write(tmp_path, waveform, 16000)
                res = emotion_model.generate(
                    input=tmp_path,
                    granularity="utterance",
                    extract_embedding=False,
                )
            finally:
                os.unlink(tmp_path)

            if res and len(res) > 0:
                entry = res[0]
                scores = entry.get("scores", [])
                labels = entry.get("labels", [])
                if scores and labels:
                    best_idx = int(np.argmax(scores))
                    emotion_label = labels[best_idx] if best_idx < len(labels) else None
                    result["emotion"] = emotion_label
                    result["emotion_scores"] = {
                        label: round(float(score), 4)
                        for label, score in zip(labels, scores)
                    }
        except Exception:
            logger.exception("Emotion classification failed")
            result["emotion"] = None

    # --- Dimensional emotion: arousal / dominance / valence (0-1 scale) ---
    adv_from_model = False
    if emotion_dim_model is not None and emotion_dim_processor is not None:
        try:
            _, logits = _process_audeering(
                waveform, 16000, emotion_dim_processor, emotion_dim_model,
            )
            adv = logits.squeeze().cpu().numpy()   # shape (3,)
            result["arousal"] = round(float(adv[0]), 4)
            result["dominance"] = round(float(adv[1]), 4)
            result["valence"] = round(float(adv[2]), 4)
            adv_from_model = True
        except Exception:
            logger.exception("Dimensional emotion (ADV) failed")

    # Fallback: derive ADV from categorical emotion label
    if not adv_from_model and emotion_label:
        fallback = EMOTION_ADV_FALLBACK.get(emotion_label)
        if fallback:
            result["arousal"] = fallback["arousal"]
            result["dominance"] = fallback["dominance"]
            result["valence"] = fallback["valence"]

    # --- Age + Gender ---
    if age_gender_model is not None and age_gender_processor is not None:
        try:
            _, logits_age, logits_gender = _process_audeering(
                waveform, 16000, age_gender_processor, age_gender_model,
            )
            # Age: output is normalized ~0..1, multiply by 100 for years
            age_float = logits_age.squeeze().item()
            result["age_estimate"] = round(age_float * 100, 1)
            # Gender: softmax probabilities [female, male, child]
            gender_probs = logits_gender.squeeze().cpu().numpy()
            idx = int(np.argmax(gender_probs))
            result["gender"] = (
                GENDER_LABELS[idx] if idx < len(GENDER_LABELS) else "unknown"
            )
        except Exception:
            logger.exception("Age/gender estimation failed")

    return _sanitize_for_json(result)


def _sanitize_for_json(obj: Any) -> Any:
    """Recursively convert numpy types to native Python for JSON serialization."""
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj


# ---------------------------------------------------------------------------
# HTTP endpoint
# ---------------------------------------------------------------------------

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    # Validate content type
    ct = (file.content_type or "").lower()
    if ct and ct not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content type: {ct}. Expected audio/*.",
        )

    # Read with streaming size limit to prevent OOM from oversized uploads
    try:
        chunks: list[bytes] = []
        total = 0
        while chunk := await file.read(256 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large (>{MAX_UPLOAD_BYTES} bytes).",
                )
            chunks.append(chunk)
        audio_bytes = b"".join(chunks)
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to read upload")
        raise HTTPException(status_code=400, detail="Failed to read uploaded file")

    # Run all ML inference off the event loop to keep /health responsive
    try:
        async with _inference_semaphore:
            result = await asyncio.wait_for(
                asyncio.to_thread(_run_analysis, audio_bytes),
                timeout=120.0,
            )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Analysis timed out")
    except Exception:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail="Internal analysis error")

    return JSONResponse(content=result)


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
