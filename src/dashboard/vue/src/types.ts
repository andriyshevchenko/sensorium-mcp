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

export interface Episode {
  episodeId: string
  threadId: number
  type: string
  modality: string
  content: string
  importance: number
  consolidated: boolean
  createdAt: string
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

export interface Topic {
  topic: string
  semanticCount: number
  proceduralCount: number
  lastUpdated: string
}
