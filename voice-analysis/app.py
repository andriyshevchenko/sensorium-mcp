"""
Voice Analysis microservice powered by VANPY models.

Accepts an audio file (OGG/WAV/etc.) via POST /analyze and returns rich
speaker analysis using VANPY's HuggingFace models:
- Emotion classification (7 classes) via SpeechBrain ECAPA + SVM
- Gender classification via SpeechBrain ECAPA + SVM
- Age estimation via ECAPA + Librosa features + ANN

All models by Gregory Koushnir (Ben-Gurion University), Apache 2.0 license.
Paper: https://arxiv.org/abs/2502.17579

NOTE: Must run with a single uvicorn worker (no --workers > 1).
"""

import asyncio
import io
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import joblib
import librosa
import numpy as np
import pandas as pd
import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from huggingface_hub import hf_hub_download
from speechbrain.inference.speaker import EncoderClassifier
from voice_emotion_classification import EmotionClassificationPipeline

logger = logging.getLogger(__name__)

# Max upload size: 25 MB (Telegram voice messages are typically < 1 MB)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

ALLOWED_CONTENT_TYPES = {
    "audio/ogg", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac",
    "audio/mp4", "audio/webm", "audio/aac", "video/ogg",
    "application/ogg", "application/octet-stream",  # Telegram sends as octet-stream
}

# Models loaded at startup
emotion_pipeline: EmotionClassificationPipeline | None = None
gender_pipeline = None
age_model = None
speechbrain_encoder: EncoderClassifier | None = None


def _load_emotion() -> EmotionClassificationPipeline:
    """Load VANPY 7-class emotion model (ECAPA + SVM)."""
    return EmotionClassificationPipeline.from_pretrained(
        "griko/emotion_7_cls_svm_ecapa_ravdess"
    )


def _load_gender():
    """Load VANPY gender classification model (ECAPA + SVM)."""
    model_path = hf_hub_download(
        repo_id="griko/gender_cls_svm_ecapa_voxceleb",
        filename="svm_model.pkl",
    )
    return joblib.load(model_path)


def _load_age():
    """Load VANPY age estimation model (ECAPA + Librosa + ANN)."""
    model_path = hf_hub_download(
        repo_id="griko/age_reg_ann_ecapa_librosa_combined",
        filename="ann_model.pkl",
    )
    return joblib.load(model_path)


def _get_encoder() -> EncoderClassifier:
    """Get or create the shared SpeechBrain ECAPA encoder."""
    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": "cpu"},
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global emotion_pipeline, gender_pipeline, age_model, speechbrain_encoder
    logger.info("Loading VANPY models...")

    try:
        emotion_pipeline = _load_emotion()
        logger.info("  ✓ Emotion model loaded")
    except Exception:
        logger.exception("  ✗ Emotion model failed to load")

    try:
        speechbrain_encoder = _get_encoder()
        logger.info("  ✓ SpeechBrain ECAPA encoder loaded")
    except Exception:
        logger.exception("  ✗ SpeechBrain encoder failed to load")

    try:
        gender_pipeline = _load_gender()
        logger.info("  ✓ Gender model loaded")
    except Exception:
        logger.exception("  ✗ Gender model failed to load")

    try:
        age_model = _load_age()
        logger.info("  ✓ Age model loaded")
    except Exception:
        logger.exception("  ✗ Age model failed to load")

    logger.info("Model loading complete.")
    yield
    emotion_pipeline = gender_pipeline = age_model = speechbrain_encoder = None
    logger.info("Models unloaded.")


app = FastAPI(title="Voice Analysis Service (VANPY)", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models": {
            "emotion": emotion_pipeline is not None,
            "gender": gender_pipeline is not None,
            "age": age_model is not None,
        },
    }


def _extract_ecapa_embedding(waveform: np.ndarray, sr: int) -> np.ndarray:
    """Extract 192-dim ECAPA embedding from audio waveform."""
    wave_tensor = torch.from_numpy(waveform).float()
    if sr != 16000:
        wave_tensor = torchaudio.functional.resample(wave_tensor, sr, 16000)
    if wave_tensor.abs().max() > 1:
        wave_tensor = wave_tensor / wave_tensor.abs().max()

    inputs = wave_tensor.unsqueeze(0)
    wav_lens = torch.tensor([1.0])
    with torch.no_grad():
        embedding = speechbrain_encoder.encode_batch(inputs, wav_lens)
    return embedding.squeeze().cpu().numpy()


def _extract_librosa_features(waveform: np.ndarray, sr: int) -> dict[str, float]:
    """Extract librosa features (MFCCs, spectral, etc.) for the age model."""
    features: dict[str, float] = {}
    mfccs = librosa.feature.mfcc(y=waveform, sr=sr, n_mfcc=13)
    for i in range(13):
        features[f"mfcc_{i}"] = float(np.mean(mfccs[i]))
    delta = librosa.feature.delta(mfccs)
    for i in range(13):
        features[f"delta_mfcc_{i}"] = float(np.mean(delta[i]))
    features["spectral_centroid"] = float(np.mean(
        librosa.feature.spectral_centroid(y=waveform, sr=sr)
    ))
    features["spectral_bandwidth"] = float(np.mean(
        librosa.feature.spectral_bandwidth(y=waveform, sr=sr)
    ))
    features["zero_crossing_rate"] = float(np.mean(
        librosa.feature.zero_crossing_rate(y=waveform)
    ))
    return features


def _run_analysis(audio_bytes: bytes) -> dict:
    """Run all ML inference synchronously (called via asyncio.to_thread)."""
    waveform, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    duration = float(librosa.get_duration(y=waveform, sr=sr))
    result: dict = {"duration_seconds": round(duration, 3)}

    # Emotion classification (uses its own encoder internally)
    if emotion_pipeline is not None:
        tmp_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
                sf.write(tmp_path, waveform, 16000)
            emotions = emotion_pipeline(tmp_path)
            result["emotion"] = emotions[0] if emotions else "unknown"
        except Exception as e:
            logger.exception("Emotion classification failed")
            result["emotion"] = None
            result["emotion_error"] = str(e)
        finally:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)
    else:
        result["emotion"] = None

    # Extract shared ECAPA embedding for gender + age
    if speechbrain_encoder is not None:
        try:
            embedding = _extract_ecapa_embedding(waveform, 16000)

            # Gender classification
            if gender_pipeline is not None:
                try:
                    emb_df = pd.DataFrame(
                        [embedding],
                        columns=[f"{i}_speechbrain_embedding" for i in range(192)],
                    )
                    gender_pred = gender_pipeline.predict(emb_df)
                    result["gender"] = (
                        gender_pred[0]
                        if gender_pred is not None and len(gender_pred) > 0
                        else None
                    )
                except Exception as e:
                    logger.exception("Gender classification failed")
                    result["gender"] = None
            else:
                result["gender"] = None

            # Age estimation (uses ECAPA + librosa features)
            if age_model is not None:
                try:
                    librosa_feats = _extract_librosa_features(waveform, 16000)
                    combined: dict = {}
                    for i in range(192):
                        combined[f"{i}_speechbrain_embedding"] = embedding[i]
                    combined.update(librosa_feats)
                    age_df = pd.DataFrame([combined])
                    age_pred = age_model.predict(age_df)
                    result["age_estimate"] = round(float(age_pred[0]), 1)
                except Exception as e:
                    logger.exception("Age estimation failed")
                    result["age_estimate"] = None
            else:
                result["age_estimate"] = None

        except Exception as e:
            logger.exception("Embedding extraction failed")
            result["gender"] = None
            result["age_estimate"] = None
    else:
        result["gender"] = None
        result["age_estimate"] = None

    return result


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if emotion_pipeline is None and speechbrain_encoder is None:
        raise HTTPException(status_code=503, detail="No models loaded")

    # Validate content type
    ct = (file.content_type or "").lower()
    if ct and ct not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content type: {ct}. Expected audio/*.",
        )

    # Read with size limit
    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        if len(audio_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({len(audio_bytes)} bytes). Max: {MAX_UPLOAD_BYTES}.",
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read upload: {e}")

    # Run all ML inference off the event loop to keep /health responsive
    try:
        result = await asyncio.to_thread(_run_analysis, audio_bytes)
    except Exception as e:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis error: {e}")

    return JSONResponse(content=result)


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
