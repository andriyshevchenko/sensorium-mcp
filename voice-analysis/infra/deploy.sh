#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deploy the Voice Analysis microservice to Azure Container Apps.
#
# Prerequisites:
#   - Azure CLI (`az`) logged in
#   - Docker (for local build) OR `az acr build` (cloud build — used here)
# ---------------------------------------------------------------------------
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-voice-analysis}"
LOCATION="${LOCATION:-westeurope}"
APP_NAME="${APP_NAME:-voice-analysis}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

ACR_NAME=$(echo "${APP_NAME}acr" | tr -d '-')
IMAGE_NAME="${APP_NAME}:${IMAGE_TAG}"

echo "==> Creating resource group: ${RESOURCE_GROUP} in ${LOCATION}"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> Deploying Bicep template..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$(dirname "$0")/main.bicep" \
  --parameters location="$LOCATION" appName="$APP_NAME" imageName="$IMAGE_NAME" \
  --output none

ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer --output tsv)

echo "==> Building and pushing image to ACR: ${ACR_LOGIN_SERVER}/${IMAGE_NAME}"
az acr build \
  --registry "$ACR_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "$IMAGE_NAME" \
  --file "$(dirname "$0")/../Dockerfile" \
  "$(dirname "$0")/.."

echo "==> Updating Container App with new image..."
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "${ACR_LOGIN_SERVER}/${IMAGE_NAME}" \
  --output none

APP_URL=$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query "properties.configuration.ingress.fqdn" --output tsv)

echo ""
echo "============================================="
echo " Deployed successfully!"
echo " URL: https://${APP_URL}"
echo " Health: https://${APP_URL}/health"
echo " Analyze: POST https://${APP_URL}/analyze"
echo "============================================="
