// ---------------------------------------------------------------------------
// Voice Emotion Analysis — Azure Container Apps + ACR
//
// Deploys:
//   1. Log Analytics workspace (required by Container Apps Environment)
//   2. Azure Container Registry (Basic SKU, admin enabled)
//   3. Container Apps Environment (Consumption plan)
//   4. Container App (scale-to-zero, 1 vCPU / 2Gi RAM)
// ---------------------------------------------------------------------------

@description('Azure region for all resources')
param location string = 'westeurope'

@description('Base name for all resources')
param appName string = 'voice-analysis'

@description('Container image (repo:tag) — pushed to ACR after initial deploy')
param imageName string = 'voice-analysis:latest'

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
// Azure Container Registry
// ---------------------------------------------------------------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: true }
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
// Container App — scale-to-zero, HTTP ingress on port 8000
// ---------------------------------------------------------------------------
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'http'
      }
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: '${acr.properties.loginServer}/${imageName}'
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            { name: 'HF_HOME', value: '/app/hf_cache' }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '1' } }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acr.properties.loginServer
