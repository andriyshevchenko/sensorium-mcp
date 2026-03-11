#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
RESOURCE_GROUP="rg-voice-analysis"
APP_NAME="voice-analysis"
LOCATION="westeurope"
IMAGE_TAG="voice-analysis:latest"

# ---------------------------------------------------------------------------
# 1. Create resource group
# ---------------------------------------------------------------------------
echo ">>> Creating resource group: ${RESOURCE_GROUP} in ${LOCATION}..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

# ---------------------------------------------------------------------------
# 2. Deploy Bicep template
# ---------------------------------------------------------------------------
echo ">>> Deploying Bicep template..."
DEPLOY_OUTPUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$(dirname "$0")/main.bicep" \
  --parameters location="$LOCATION" appName="$APP_NAME" imageName="$IMAGE_TAG" \
  --query "properties.outputs" \
  --output json)

ACR_NAME=$(echo "$DEPLOY_OUTPUT" | jq -r '.acrName.value')
ACR_LOGIN_SERVER=$(echo "$DEPLOY_OUTPUT" | jq -r '.acrLoginServer.value')
APP_URL=$(echo "$DEPLOY_OUTPUT" | jq -r '.containerAppUrl.value')

echo "    ACR:  ${ACR_LOGIN_SERVER}"
echo "    App:  ${APP_URL}"

# ---------------------------------------------------------------------------
# 3. Build & push Docker image to ACR
# ---------------------------------------------------------------------------
echo ">>> Logging in to ACR..."
az acr login --name "$ACR_NAME"

echo ">>> Building and pushing Docker image..."
az acr build \
  --registry "$ACR_NAME" \
  --image "$IMAGE_TAG" \
  --file Dockerfile \
  ..

# ---------------------------------------------------------------------------
# 4. Update Container App with the new image
# ---------------------------------------------------------------------------
echo ">>> Updating Container App with new image..."
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "${ACR_LOGIN_SERVER}/${IMAGE_TAG}"

# ---------------------------------------------------------------------------
# 5. Done
# ---------------------------------------------------------------------------
echo ""
echo "========================================="
echo "  Deployment complete!"
echo "  App URL: ${APP_URL}"
echo "========================================="
