FROM python:3.11-slim

# System dependencies for librosa/soundfile (OGG support), ffmpeg, and git (for pip git deps)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libsndfile1 ffmpeg git && \
    rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd -m -s /bin/bash appuser

WORKDIR /app

# HuggingFace model cache inside the container
ENV HF_HOME=/app/hf_cache

COPY requirements.txt .
# Install CPU-only torch first (much smaller, ~200MB vs ~2GB for CUDA), then the rest.
# funasr uses torch; audeering models use transformers + torch for inference.
RUN pip install --no-cache-dir \
    torch==2.5.1+cpu torchaudio==2.5.1+cpu \
    --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r requirements.txt && \
    python -c "import torch; assert '+cpu' in torch.__version__, f'Expected CPU torch, got {torch.__version__}'"

COPY app.py .
COPY warmup.py .

# Pre-download all models during build to bake weights into the image layer.
# v3 models: emotion2vec+ base (~350MB), audeering emotion-dim (~1.2GB),
# audeering age-gender (~1.2GB), PANNs CNN14 (~300MB). Total ~3.0GB of model weights.
RUN python warmup.py

# PANNs stores weights in ~/panns_data (i.e. /root/panns_data during build).
# Copy to appuser home so the model is found at runtime.
RUN cp -r /root/panns_data /home/appuser/panns_data

RUN chown -R appuser:appuser /app /home/appuser/panns_data
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
