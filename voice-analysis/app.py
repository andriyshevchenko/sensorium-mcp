"""
Voice Analysis microservice powered by VANPY models.

Accepts an audio file (OGG/WAV/etc.) via POST /analyze and returns rich
speaker analysis using VANPY's HuggingFace models:
- Emotion classification (7 classes) via SpeechBrain ECAPA + SVM
- Gender classification via SpeechBrain ECAPA + SVM
- Age estimation via ECAPA + Librosa features + ANN

All models by Gregory Koushnir (Ben-Gurion University), Apache 2.0 license.
Paper: https://arxiv.org/abs/2502.17579
"""

import io
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# Models loaded at startup
emotion_pipeline = None
gender_pipeline = None
age_model = None
speechbrain_encoder = None


def _load_emotion():
    """Load VANPY 7-class emotion model (ECAPA + SVM)."""
    from voice_emotion_classification import EmotionClassificationPipeline
    return EmotionClassificationPipeline.from_pretrained(
        "griko/emotion_7_cls_svm_ecapa_ravdess"
    )


def _load_gender():
    """Load VANPY gender classification model (ECAPA + SVM)."""
    import joblib
    from huggingface_hub import hf_hub_download
    model_path = hf_hub_download(
        repo_id="griko/gender_cls_svm_ecapa_voxceleb",
        filename="svm_model.pkl",
    )
    return joblib.load(model_path)


def _load_age():
    """Load VANPY age estimation model (ECAPA + Librosa + ANN)."""
    import joblib
    from huggingface_hub import hf_hub_download
    # The combined model uses both ECAPA embeddings and librosa features
    model_path = hf_hub_download(
        repo_id="griko/age_reg_ann_ecapa_librosa_combined",
        filename="ann_model.pkl",
    )
    return joblib.load(model_path)


def _get_encoder():
    """Get or create the shared SpeechBrain ECAPA encoder."""
    from speechbrain.inference.speaker import EncoderClassifier
    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": "cpu"},
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global emotion_pipeline, gender_pipeline, age_model, speechbrain_encoder
    logger.info("Loading VANPY models...")

    emotion_pipeline = _load_emotion()
    logger.info("  ✓ Emotion model loaded")

    speechbrain_encoder = _get_encoder()
    logger.info("  ✓ SpeechBrain ECAPA encoder loaded")

    gender_pipeline = _load_gender()
    logger.info("  ✓ Gender model loaded")

    age_model = _load_age()
    logger.info("  ✓ Age model loaded")

    logger.info("All models ready.")
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
    import torch
    import torchaudio

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


def _extract_librosa_features(waveform: np.ndarray, sr: int) -> np.ndarray:
    """Extract librosa features (MFCCs, spectral, etc.) for the age model."""
    features = {}
    # MFCCs
    mfccs = librosa.feature.mfcc(y=waveform, sr=sr, n_mfcc=13)
    for i in range(13):
        features[f"mfcc_{i}"] = float(np.mean(mfccs[i]))
    # Delta MFCCs
    delta = librosa.feature.delta(mfccs)
    for i in range(13):
        features[f"delta_mfcc_{i}"] = float(np.mean(delta[i]))
    # Spectral features
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


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if emotion_pipeline is None:
        raise HTTPException(status_code=503, detail="Models not loaded yet")

    # Read and decode audio
    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        waveform, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
        duration = float(librosa.get_duration(y=waveform, sr=sr))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to decode audio")
        raise HTTPException(status_code=400, detail=f"Could not process audio: {e}")

    result = {"duration_seconds": round(duration, 3)}

    # Emotion classification (uses its own encoder internally)
    try:
        # Write to temp file since the pipeline expects a file path
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, waveform, 16000)
            emotions = emotion_pipeline(tmp.name)
            result["emotion"] = emotions[0] if emotions else "unknown"
            Path(tmp.name).unlink(missing_ok=True)
    except Exception as e:
        logger.exception("Emotion classification failed")
        result["emotion"] = None
        result["emotion_error"] = str(e)

    # Extract shared ECAPA embedding for gender + age
    try:
        embedding = _extract_ecapa_embedding(waveform, 16000)
        import pandas as pd

        # Gender classification
        try:
            emb_df = pd.DataFrame(
                [embedding],
                columns=[f"{i}_speechbrain_embedding" for i in range(192)],
            )
            gender_pred = gender_pipeline.predict(emb_df)
            result["gender"] = gender_pred[0] if len(gender_pred) > 0 else None
        except Exception as e:
            logger.exception("Gender classification failed")
            result["gender"] = None

        # Age estimation (uses ECAPA + librosa features)
        try:
            librosa_feats = _extract_librosa_features(waveform, 16000)
            # Combine embedding columns + librosa feature columns
            combined = {}
            for i in range(192):
                combined[f"{i}_speechbrain_embedding"] = embedding[i]
            combined.update(librosa_feats)
            age_df = pd.DataFrame([combined])
            age_pred = age_model.predict(age_df)
            result["age_estimate"] = round(float(age_pred[0]), 1)
        except Exception as e:
            logger.exception("Age estimation failed")
            result["age_estimate"] = None

    except Exception as e:
        logger.exception("Embedding extraction failed")
        result["gender"] = None
        result["age_estimate"] = None

    return JSONResponse(content=result)


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
