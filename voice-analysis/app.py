"""
Voice Emotion Analysis microservice.

Accepts an audio file (OGG/WAV/etc.) via POST /analyze and returns
emotion classification results using a wav2vec2-based model from HuggingFace.
"""

import io
import logging
from contextlib import asynccontextmanager

import librosa
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from transformers import pipeline

logger = logging.getLogger(__name__)

emotion_classifier = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global emotion_classifier
    logger.info("Loading emotion classification model...")
    emotion_classifier = pipeline(
        "audio-classification",
        model="ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition",
    )
    logger.info("Model loaded successfully.")
    yield
    emotion_classifier = None
    logger.info("Model unloaded.")


app = FastAPI(title="Voice Emotion Analysis Service", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    if emotion_classifier is None:
        raise HTTPException(status_code=500, detail="Model not loaded")

    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        waveform, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
        duration_seconds = float(librosa.get_duration(y=waveform, sr=sr))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to read or decode audio file")
        raise HTTPException(
            status_code=400, detail=f"Could not process audio file: {e}"
        )

    try:
        results = emotion_classifier(
            {"raw": waveform.astype(np.float32), "sampling_rate": 16000}
        )
        top = results[0]
        return JSONResponse(
            content={
                "emotion": top["label"],
                "confidence": round(float(top["score"]), 4),
                "duration_seconds": round(duration_seconds, 3),
            }
        )
    except Exception as e:
        logger.exception("Emotion classification failed")
        raise HTTPException(
            status_code=500, detail=f"Classification error: {e}"
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
