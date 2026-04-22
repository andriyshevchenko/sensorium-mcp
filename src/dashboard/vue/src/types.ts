export interface Session {
  mcpSessionId: string
  threadId: number | null
  topicName?: string
  lastActivity: number
  transportType: string
  status: 'active' | 'disconnected'
  lastWaitCallAt: number | null
}

export interface MemoryNote {
  noteId: number
  type: 'fact' | 'preference' | 'pattern' | 'entity' | 'relationship'
  content: string
  keywords: string[]
  confidence: number
  priority: number
  accessCount: number
  createdAt: string
  updatedAt: string
}


export interface MemoryStats {
  totalSemanticNotes: number
  totalEpisodes: number
  unconsolidatedEpisodes: number
  totalProcedures: number
}

export interface StatusResponse {
  uptime: number
  activeSessions: number
  memory: MemoryStats
  sessions?: Session[]
}

export interface Skill {
  name: string
  source: string
  triggers: string[]
  replacesOrchestrator: boolean
  content: string
}

export interface DrivePreset {
  key: string
  label: string
  content: string
}

export interface McpServerConfig {
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface ThreadEntry {
  id: number
  threadId: number
  name: string
  type: 'root' | 'daily' | 'branch' | 'worker'
  rootThreadId: number | null
  badge: string
  client: string
  maxRetries: number
  cooldownMs: number
  keepAlive: boolean
  dailyRotation: boolean
  autonomousMode: boolean
  telegramTopicId: number | null
  identityPrompt: string | null
  workingDirectory: string | null
  createdAt: string
  lastActiveAt: string | null
  sessionResetAt: string | null
  status: 'active' | 'archived' | 'expired' | 'exited'
}
