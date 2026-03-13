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
# Install CPU-only torch first (much smaller, ~200MB vs ~2GB for CUDA), then the rest
RUN pip install --no-cache-dir \
    torch==2.5.1+cpu torchaudio==2.5.1+cpu \
    --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY warmup.py .

# Pre-download all HuggingFace models during build to avoid cold-start downloads.
# This bakes ~1-2 GB of model weights into the image layer.
RUN python warmup.py

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
