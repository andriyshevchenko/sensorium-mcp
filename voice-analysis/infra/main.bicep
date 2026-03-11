// ---------------------------------------------------------------------------
// Voice Analysis — Base Infrastructure (ACR + Container Apps Environment)
//
// Deploys:
//   1. Log Analytics workspace (required by Container Apps Environment)
//   2. Azure Container Registry (Basic SKU, NO admin user)
//   3. Container Apps Environment (Consumption plan)
//
// The Container App itself is created/updated via CLI after the image is
// built and pushed to ACR. This avoids the chicken-and-egg problem where
// the Bicep deploy hangs waiting for an image that hasn't been built yet.
// ---------------------------------------------------------------------------

@description('Azure region for all resources')
param location string = 'northeurope'

@description('Base name for all resources')
param appName string = 'voice-analysis'

// ---------------------------------------------------------------------------
// Derived names
// ---------------------------------------------------------------------------
var acrName = replace('${appName}acr', '-', '')
var envName = '${appName}-env'
var logName = '${appName}-log'

// ---------------------------------------------------------------------------
// Log Analytics (required by Container Apps Environment)
// ---------------------------------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ---------------------------------------------------------------------------
// Azure Container Registry — NO admin user, pull via managed identity
// ---------------------------------------------------------------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// ---------------------------------------------------------------------------
// Container Apps Environment
// ---------------------------------------------------------------------------
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output envName string = env.name
output envId string = env.id
