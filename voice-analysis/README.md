# Voice Analysis Microservice (VANPY)

A FastAPI service that performs rich voice analysis using VANPY's HuggingFace models:
- **Emotion** — 7 classes: angry, disgust, fearful, happy, neutral/calm, sad, surprised
- **Gender** — male/female classification (98.9% accuracy on VoxCeleb2)
- **Age** — estimated age in years (MAE ~7 years)

All models by Gregory Koushnir (Ben-Gurion University). Paper: [arxiv.org/abs/2502.17579](https://arxiv.org/abs/2502.17579)

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (shows which models are loaded) |
| `/analyze` | POST | Analyze audio file (multipart `file` field) |

### Example

```bash
curl -X POST https://your-service.example.com/analyze \
  -F "file=@voice.ogg" \
  | jq .
```

```json
{
  "duration_seconds": 12.5,
  "emotion": "neutral/calm",
  "gender": "male",
  "age_estimate": 32.4
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

When configured, voice messages will show analysis alongside the transcript:
```
[Voice message — 12s | tone: fearful, speaker: male, ~30yr, transcribed]: Fix the login bug, it's been broken all day
```
