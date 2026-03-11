"""
Voice Analysis microservice powered by VANPY models.

Accepts an audio file (OGG/WAV/etc.) via POST /analyze and returns rich
speaker analysis using VANPY's HuggingFace models — all running on a single
shared SpeechBrain ECAPA-TDNN 192-dim speaker embedding:

  - Emotion classification (7 classes) — SVM on ECAPA
  - Arousal / Dominance / Valence intensity from emotion label
  - Gender classification — SVM on ECAPA
  - Age estimation (years) — SVR on ECAPA
  - Height estimation (cm) — SVR on ECAPA

All models by Gregory Koushnir (Ben-Gurion University), Apache 2.0.
Paper: https://arxiv.org/abs/2502.17579

NOTE: Must run with a single uvicorn worker (no --workers > 1).
"""

import asyncio
import io
import logging
from contextlib import asynccontextmanager
from typing import Any

import joblib
import librosa
import numpy as np
import pandas as pd
import torch
import torchaudio
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from huggingface_hub import hf_hub_download
from speechbrain.inference.speaker import EncoderClassifier

logger = logging.getLogger(__name__)

# Max upload size: 25 MB (Telegram voice messages are typically < 1 MB)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

ALLOWED_CONTENT_TYPES = {
    "audio/ogg", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac",
    "audio/mp4", "audio/webm", "audio/aac", "video/ogg",
    "application/ogg", "application/octet-stream",
}

# ---------------------------------------------------------------------------
# Label constants
# ---------------------------------------------------------------------------

GENDER_LABELS = ["female", "male"]  # from config.json in HF repo

EMOTION_LABELS = [
    "angry", "disgust", "fearful", "happy", "neutral/calm", "sad", "surprised",
]

# Arousal / Dominance / Valence mapping for RAVDESS 7-class emotions.
# Values on a 1-5 scale based on established affective computing literature
# (Russell's circumplex model, Warriner et al. VAD norms).
EMOTION_ADV: dict[str, dict[str, float]] = {
    "angry":        {"arousal": 4.3, "dominance": 3.9, "valence": 1.8},
    "disgust":      {"arousal": 3.4, "dominance": 3.2, "valence": 1.7},
    "fearful":      {"arousal": 4.1, "dominance": 1.6, "valence": 1.6},
    "happy":        {"arousal": 4.0, "dominance": 3.8, "valence": 4.4},
    "neutral/calm": {"arousal": 2.0, "dominance": 3.0, "valence": 3.2},
    "sad":          {"arousal": 2.1, "dominance": 1.9, "valence": 1.6},
    "surprised":    {"arousal": 4.2, "dominance": 2.8, "valence": 3.1},
}

# ---------------------------------------------------------------------------
# Feature column names shared by all ECAPA-based models (192 dims)
# ---------------------------------------------------------------------------
ECAPA_COLUMNS = [f"{i}_speechbrain_embedding" for i in range(192)]


# ---------------------------------------------------------------------------
# Model singletons (loaded at startup)
# ---------------------------------------------------------------------------
speechbrain_encoder: EncoderClassifier | None = None
emotion_pipeline: dict | None = None   # {"model": SVM}
gender_pipeline: dict | None = None    # {"model": SVM, "scaler": StandardScaler}
age_pipeline: dict | None = None       # {"model": SVR, "scaler": StandardScaler}
height_pipeline: dict | None = None    # {"model": SVR, "scaler": StandardScaler}

# Limit concurrent inference to avoid OOM on small containers
_inference_semaphore = asyncio.Semaphore(2)


def _load_svm(repo_id: str, model_file: str = "svm_model.joblib",
              scaler_file: str | None = "scaler.joblib") -> dict:
    """Generic loader for joblib SVM/SVR model + optional scaler from HuggingFace."""
    model_path = hf_hub_download(repo_id=repo_id, filename=model_file)
    result = {"model": joblib.load(model_path)}
    if scaler_file:
        scaler_path = hf_hub_download(repo_id=repo_id, filename=scaler_file)
        result["scaler"] = joblib.load(scaler_path)
    return result


@asynccontextmanager
async def lifespan(app: FastAPI):
    global speechbrain_encoder, emotion_pipeline, gender_pipeline
    global age_pipeline, height_pipeline

    logger.info("Loading VANPY models...")

    # 1. Shared ECAPA encoder (required by all classifiers)
    try:
        speechbrain_encoder = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            run_opts={"device": "cpu"},
        )
        logger.info("  ✓ SpeechBrain ECAPA encoder loaded")
    except Exception:
        logger.exception("  ✗ SpeechBrain encoder failed — all models disabled")
        yield
        return

    # 2. Emotion
    try:
        emotion_pipeline = _load_svm(
            "griko/emotion_7_cls_svm_ecapa_ravdess",
            model_file="svm_model.joblib",
            scaler_file=None,
        )
        logger.info("  ✓ Emotion model loaded")
    except Exception:
        logger.exception("  ✗ Emotion model failed to load")

    # 3. Gender
    try:
        gender_pipeline = _load_svm("griko/gender_cls_svm_ecapa_voxceleb")
        logger.info("  ✓ Gender model loaded")
    except Exception:
        logger.exception("  ✗ Gender model failed to load")

    # 4. Age
    try:
        age_pipeline = _load_svm(
            "griko/age_reg_svr_ecapa_voxceleb2",
            model_file="model.joblib",
            scaler_file="scaler.joblib",
        )
        logger.info("  ✓ Age model loaded")
    except Exception:
        logger.exception("  ✗ Age model failed to load")

    # 5. Height
    try:
        height_pipeline = _load_svm(
            "griko/height_reg_svr_ecapa_voxceleb",
            model_file="svr_model.joblib",
            scaler_file="scaler.joblib",
        )
        logger.info("  ✓ Height model loaded")
    except Exception:
        logger.exception("  ✗ Height model failed to load")

    logger.info("Model loading complete.")
    yield
    speechbrain_encoder = None
    emotion_pipeline = gender_pipeline = age_pipeline = height_pipeline = None
    logger.info("Models unloaded.")


app = FastAPI(title="Voice Analysis Service (VANPY)", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models": {
            "encoder": speechbrain_encoder is not None,
            "emotion": emotion_pipeline is not None,
            "gender": gender_pipeline is not None,
            "age": age_pipeline is not None,
            "height": height_pipeline is not None,
        },
    }


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------

def _extract_ecapa_embedding(waveform: np.ndarray, sr: int) -> np.ndarray:
    """Extract 192-dim ECAPA embedding from audio waveform."""
    wave_tensor = torch.from_numpy(waveform).float()
    if wave_tensor.numel() == 0:
        raise ValueError("Audio waveform is empty after decoding")
    if sr != 16000:
        wave_tensor = torchaudio.functional.resample(wave_tensor, sr, 16000)
    peak = wave_tensor.abs().max()
    if peak > 1:
        wave_tensor = wave_tensor / peak

    inputs = wave_tensor.unsqueeze(0)
    wav_lens = torch.tensor([1.0])
    with torch.no_grad():
        embedding = speechbrain_encoder.encode_batch(inputs, wav_lens)
    return embedding.squeeze().cpu().numpy()


def _predict(pipeline: dict, emb_df: pd.DataFrame) -> Any:
    """Run scaler (if present) → model.predict on an embedding DataFrame."""
    features = emb_df
    if "scaler" in pipeline:
        features = pipeline["scaler"].transform(features)
    return pipeline["model"].predict(features)


def _run_analysis(audio_bytes: bytes) -> dict:
    """Run all ML inference synchronously (called via asyncio.to_thread)."""
    waveform, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    duration = float(librosa.get_duration(y=waveform, sr=sr))
    result: dict = {"duration_seconds": round(duration, 3)}

    if speechbrain_encoder is None:
        return result

    # Extract the single shared embedding used by ALL classifiers
    try:
        embedding = _extract_ecapa_embedding(waveform, 16000)
        emb_df = pd.DataFrame([embedding], columns=ECAPA_COLUMNS)
    except Exception:
        logger.exception("ECAPA embedding extraction failed")
        return result

    # --- Emotion classification ---
    if emotion_pipeline is not None:
        try:
            pred = _predict(emotion_pipeline, emb_df)
            raw = pred[0] if pred is not None and len(pred) > 0 else None
            # SVM may return a string label or an integer index
            if isinstance(raw, str):
                emotion_label = raw
            elif raw is not None:
                idx = int(raw)
                emotion_label = EMOTION_LABELS[idx] if 0 <= idx < len(EMOTION_LABELS) else str(idx)
            else:
                emotion_label = None
            result["emotion"] = emotion_label
            # Add arousal / dominance / valence
            if emotion_label:
                adv = EMOTION_ADV.get(emotion_label)
                if adv:
                    result["arousal"] = adv["arousal"]
                    result["dominance"] = adv["dominance"]
                    result["valence"] = adv["valence"]
        except Exception:
            logger.exception("Emotion classification failed")
            result["emotion"] = None

    # --- Gender classification ---
    if gender_pipeline is not None:
        try:
            pred = _predict(gender_pipeline, emb_df)
            raw = pred[0] if pred is not None and len(pred) > 0 else None
            if isinstance(raw, str):
                result["gender"] = raw
            elif raw is not None:
                idx = int(raw)
                result["gender"] = GENDER_LABELS[idx] if 0 <= idx < len(GENDER_LABELS) else str(idx)
            else:
                result["gender"] = None
        except Exception:
            logger.exception("Gender classification failed")
            result["gender"] = None

    # --- Age estimation ---
    if age_pipeline is not None:
        try:
            pred = _predict(age_pipeline, emb_df)
            result["age_estimate"] = round(float(pred[0]), 1) if pred is not None else None
        except Exception:
            logger.exception("Age estimation failed")
            result["age_estimate"] = None

    # --- Height estimation ---
    if height_pipeline is not None:
        try:
            pred = _predict(height_pipeline, emb_df)
            result["height_estimate_cm"] = round(float(pred[0]), 1) if pred is not None else None
        except Exception:
            logger.exception("Height estimation failed")
            result["height_estimate_cm"] = None

    return _sanitize_for_json(result)


def _sanitize_for_json(obj: Any) -> Any:
    """Recursively convert numpy types to native Python for JSON serialization."""
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj


# ---------------------------------------------------------------------------
# HTTP endpoint
# ---------------------------------------------------------------------------

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if speechbrain_encoder is None:
        raise HTTPException(status_code=503, detail="No models loaded")

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
                    detail=f"File too large (>{MAX_UPLOAD_BYTES} bytes). Max: {MAX_UPLOAD_BYTES}.",
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
                timeout=60.0,
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
