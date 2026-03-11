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
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY warmup.py .

# Pre-download all HuggingFace models during build to avoid cold-start downloads.
# This bakes ~1-2 GB of model weights into the image layer.
RUN python warmup.py

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
