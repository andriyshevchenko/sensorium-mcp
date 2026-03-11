# Voice Emotion Analysis Microservice

A lightweight FastAPI service that detects emotion from voice audio using a wav2vec2-based model from HuggingFace.

## What it does

Accepts an audio file (OGG, WAV, etc.) and returns:
- **emotion** — one of: angry, calm, disgust, fearful, happy, neutral, sad, surprised
- **confidence** — 0.0 to 1.0
- **duration_seconds** — length of the audio

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/analyze` | POST | Analyze audio file (multipart `file` field) |

### Example

```bash
curl -X POST https://your-service.example.com/analyze \
  -F "file=@voice.ogg" \
  | jq .
```

```json
{
  "emotion": "calm",
  "confidence": 0.8234,
  "duration_seconds": 12.5
}
```

## Deploy to Azure Container Apps

The `infra/` directory contains a Bicep template and deploy script for Azure Container Apps with **scale-to-zero** (you only pay when processing a voice message).

### Prerequisites

- Azure CLI (`az`) logged in
- An Azure subscription

### Deploy

```bash
# Optional: customize these
export RESOURCE_GROUP=rg-voice-analysis
export LOCATION=westeurope

chmod +x infra/deploy.sh
./infra/deploy.sh
```

This will:
1. Create a resource group
2. Deploy ACR + Container Apps Environment + Container App via Bicep
3. Build and push the Docker image to ACR
4. Print the service URL

### Cost estimate

With scale-to-zero and ~20 voice messages/day (average 15s each):
- **Container Apps**: ~$0.50–2.00/month (consumption pricing, idle = $0)
- **ACR Basic**: ~$5/month
- **Total**: ~$5–7/month

## Local development

```bash
pip install -r requirements.txt
python app.py
# → http://localhost:8000
```

## Integration with remote-copilot-mcp

Set the `VOICE_ANALYSIS_URL` environment variable:

```json
{
  "env": {
    "VOICE_ANALYSIS_URL": "https://voice-analysis.your-region.azurecontainerapps.io"
  }
}
```

When configured, voice messages will show emotion alongside the transcript:
```
[Voice message — 12s | tone: frustrated (87%), transcribed]: Fix the login bug, it's been broken all day
```
