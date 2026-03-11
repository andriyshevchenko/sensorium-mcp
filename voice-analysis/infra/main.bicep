// ---------------------------------------------------------------------------
// Voice Analysis — Azure Container Apps + ACR (Managed Identity)
//
// Deploys:
//   1. Log Analytics workspace (required by Container Apps Environment)
//   2. Azure Container Registry (Basic SKU, NO admin user)
//   3. Container Apps Environment (Consumption plan)
//   4. Container App with system-assigned managed identity (AcrPull role)
//   5. Health probes for startup readiness
// ---------------------------------------------------------------------------

@description('Azure region for all resources')
param location string = 'northeurope'

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

// Built-in role: AcrPull (7f951dda-4ed3-4680-a7ca-43fe172d538d)
var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

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
// Container App — managed identity, health probes, scale-to-zero
// ---------------------------------------------------------------------------
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
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
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: '${acr.properties.loginServer}/${imageName}'
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            { name: 'HF_HOME', value: '/app/hf_cache' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8000
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 30   // allow up to 5 min for model loading
              timeoutSeconds: 5
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8000
              }
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 5
            }
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
// Role Assignment: Container App → AcrPull on the registry
// ---------------------------------------------------------------------------
resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, app.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output acrLoginServer string = acr.properties.loginServer
