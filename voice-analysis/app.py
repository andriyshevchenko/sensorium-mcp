"""
Voice Analysis v2 microservice — transformer-based models.

Upgrade from v1 (ECAPA-TDNN + SVM/SVR):
  - Emotion:     emotion2vec+ base (FunASR, 9-class, 4788h training data)
  - ADV:         audeering wav2vec2-large-robust-12-ft-emotion-msp-dim (continuous 0-1)
  - Age+Gender:  audeering wav2vec2-large-robust-24-ft-age-gender (MAE ~7-11yr)
  - Height:      REMOVED (scientifically unreliable in adult humans)

All values on 0-1 scale for arousal/dominance/valence.
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
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# Max upload size: 25 MB (Telegram voice messages are typically < 1 MB)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

ALLOWED_CONTENT_TYPES = {
    "audio/ogg", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac",
    "audio/mp4", "audio/webm", "audio/aac", "video/ogg",
    "application/ogg", "application/octet-stream",
}

GENDER_LABELS = ["child", "female", "male"]

# Fallback ADV lookup (0-1 scale) used when the audeering emotion-dim model
# is unavailable. Derived from Russell's circumplex / Warriner norms,
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
# Model singletons (loaded at startup)
# ---------------------------------------------------------------------------
emotion_model: Any = None       # FunASR AutoModel (emotion2vec+ base)
emotion_dim_model: Any = None   # audonnx Model (arousal/dominance/valence)
age_gender_model: Any = None    # audonnx Model (age + gender)

# Cached output key mappings discovered during startup probing
_emotion_dim_keys: dict[str, str] = {}   # maps "arousal"/"dominance"/"valence" → actual output key
_age_gender_keys: dict[str, str] = {}    # maps "age"/"gender" → actual output key

# Limit concurrent inference to avoid OOM on small containers
_inference_semaphore = asyncio.Semaphore(2)


def _probe_audonnx_model(model: Any, name: str, sr: int = 16000) -> dict[str, Any]:
    """Run synthetic audio through an audonnx model and log output structure."""
    signal = np.zeros(sr, dtype=np.float32)  # 1 second of silence
    output = model(signal, sr)
    logger.info("  [%s] output type: %s", name, type(output).__name__)
    if isinstance(output, dict):
        for key, val in output.items():
            shape = val.shape if hasattr(val, "shape") else "N/A"
            dtype = val.dtype if hasattr(val, "dtype") else type(val).__name__
            sample = val.flat[0] if hasattr(val, "flat") and val.size > 0 else val
            logger.info("  [%s]   '%s': shape=%s, dtype=%s, sample=%s", name, key, shape, dtype, sample)
    elif isinstance(output, np.ndarray):
        logger.info("  [%s]   ndarray shape=%s, dtype=%s", name, output.shape, output.dtype)
    return output


@asynccontextmanager
async def lifespan(app: FastAPI):
    global emotion_model, emotion_dim_model, age_gender_model

    logger.info("Loading voice analysis v2 models...")

    # 1. Emotion: emotion2vec+ base via FunASR
    try:
        from funasr import AutoModel as FunASRAutoModel
        emotion_model = FunASRAutoModel(model="iic/emotion2vec_plus_base")
        logger.info("  ✓ emotion2vec+ base loaded")
    except Exception:
        logger.exception("  ✗ emotion2vec+ base failed to load")

    # 2. Dimensional emotion (ADV): audeering wav2vec2 MSP-dim via audonnx
    try:
        import audonnx
        from huggingface_hub import snapshot_download
        model_path = snapshot_download(
            "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim",
        )
        emotion_dim_model = audonnx.load(model_path)
        logger.info("  ✓ audeering emotion-dim model loaded")
        # Probe output structure to discover key names
        probe = _probe_audonnx_model(emotion_dim_model, "emotion-dim")
        if isinstance(probe, dict):
            for semantic in ("arousal", "dominance", "valence"):
                # Try exact match first, then partial match
                if semantic in probe:
                    _emotion_dim_keys[semantic] = semantic
                else:
                    for key in probe:
                        if semantic in key.lower():
                            _emotion_dim_keys[semantic] = key
                            break
            logger.info("  [emotion-dim] key mapping: %s", _emotion_dim_keys)
    except Exception:
        logger.exception("  ✗ audeering emotion-dim model failed to load")

    # 3. Age + Gender: audeering wav2vec2 via audonnx
    try:
        import audonnx
        from huggingface_hub import snapshot_download
        model_path = snapshot_download(
            "audeering/wav2vec2-large-robust-24-ft-age-gender",
        )
        age_gender_model = audonnx.load(model_path)
        logger.info("  ✓ audeering age-gender model loaded")
        # Probe output structure
        probe = _probe_audonnx_model(age_gender_model, "age-gender")
        if isinstance(probe, dict):
            for semantic in ("age", "gender"):
                if semantic in probe:
                    _age_gender_keys[semantic] = semantic
                else:
                    for key in probe:
                        if semantic in key.lower():
                            _age_gender_keys[semantic] = key
                            break
            logger.info("  [age-gender] key mapping: %s", _age_gender_keys)
    except Exception:
        logger.exception("  ✗ audeering age-gender model failed to load")

    logger.info("Model loading complete.")
    yield
    emotion_model = emotion_dim_model = age_gender_model = None
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
    if emotion_dim_model is not None:
        try:
            output = emotion_dim_model(waveform, 16000)
            if isinstance(output, dict):
                for semantic in ("arousal", "dominance", "valence"):
                    key = _emotion_dim_keys.get(semantic, semantic)
                    if key in output:
                        val = output[key]
                        result[semantic] = round(
                            float(val.flat[0] if hasattr(val, "flat") else val), 4,
                        )
                        adv_from_model = True
            elif isinstance(output, np.ndarray) and output.size >= 3:
                result["arousal"] = round(float(output.flat[0]), 4)
                result["dominance"] = round(float(output.flat[1]), 4)
                result["valence"] = round(float(output.flat[2]), 4)
                adv_from_model = True
            else:
                logger.warning("emotion_dim: unexpected output type %s", type(output).__name__)
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
    if age_gender_model is not None:
        try:
            output = age_gender_model(waveform, 16000)
            if isinstance(output, dict):
                # Age — model may return 0-1 normalized or raw years
                age_key = _age_gender_keys.get("age", "age")
                if age_key in output:
                    age_val = output[age_key]
                    age_float = float(
                        age_val.flat[0] if hasattr(age_val, "flat") else age_val,
                    )
                    # Heuristic: values in [0, 1] are normalized → scale to years.
                    # Values > 1 are already in years. Note: infants don't produce
                    # analyzable speech, so 0-1 year-old edge case is irrelevant.
                    if age_float <= 1.0:
                        age_float = age_float * 100
                    result["age_estimate"] = round(age_float, 1)
                # Gender (child / female / male)
                gender_key = _age_gender_keys.get("gender", "gender")
                if gender_key in output:
                    gender_probs = output[gender_key]
                    if hasattr(gender_probs, "flatten"):
                        gender_probs = gender_probs.flatten()
                    idx = int(np.argmax(gender_probs))
                    result["gender"] = (
                        GENDER_LABELS[idx] if idx < len(GENDER_LABELS) else "unknown"
                    )
            elif isinstance(output, np.ndarray):
                logger.warning(
                    "age_gender returned ndarray — shape: %s. "
                    "Expected dict with keys %s. Probed keys: %s",
                    output.shape, ["age", "gender"], _age_gender_keys,
                )
        except Exception:
            logger.exception("Age/gender estimation failed")
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
