# syntax=docker/dockerfile:1

FROM python:3.11-slim AS base

# System deps for librosa / soundfile (OGG support)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# HuggingFace cache inside the container
ENV HF_HOME=/app/hf_cache

# Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY app.py .

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
