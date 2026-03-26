<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '../api'
import type { StatusResponse, Session } from '../types'

const props = defineProps<{ status: StatusResponse | null }>()

const sessions = ref<Session[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const data = await api<StatusResponse>('/api/status')
    sessions.value = (data.sessions || []).slice().sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (a.status !== 'active' && b.status === 'active') return 1
      return b.lastActivity - a.lastActivity
    })
  } finally {
    loading.value = false
  }
}

const sortedSessions = computed(() => {
  const src = props.status?.sessions ?? sessions.value
  return src.slice().sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1
    if (a.status !== 'active' && b.status === 'active') return 1
    return b.lastActivity - a.lastActivity
  })
})

function sessionStatusInfo(s: Session): { label: string; color: string } {
  const idle = Math.floor((Date.now() - s.lastActivity) / 60000)
  if (s.status === 'disconnected') {
    return { label: `Disconnected${idle > 0 ? ` — ${idle}m ago` : ''}`, color: 'text-muted' }
  }
  if (idle < 5) return { label: 'Active', color: 'text-success' }
  if (idle < 30) return { label: `Idle ${idle}m`, color: 'text-warn' }
  return { label: `Dormant ${idle}m`, color: 'text-danger' }
}

function pollLabel(s: Session): string {
  if (!s.lastWaitCallAt) return ''
  const waitAgo = Math.floor((Date.now() - s.lastWaitCallAt) / 60000)
  if (waitAgo < 5) {
    return `Polling — ${waitAgo === 0 ? 'just now' : waitAgo + 'm ago'}`
  }
  return `Last poll — ${waitAgo}m ago`
}

function pollClass(s: Session): string {
  if (!s.lastWaitCallAt) return ''
  const waitAgo = Math.floor((Date.now() - s.lastWaitCallAt) / 60000)
  return waitAgo < 5 ? 'text-success' : 'text-warn'
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <div v-if="loading && sortedSessions.length === 0" class="text-center py-12 text-textSecondary">Loading sessions...</div>

    <div v-else-if="sortedSessions.length === 0" class="text-center text-textSecondary py-12">No sessions</div>

    <div v-else class="space-y-3">
      <div
        v-for="s in sortedSessions"
        :key="s.mcpSessionId"
        :class="['glass rounded-xl p-4 animate-slide-up', s.status === 'disconnected' ? 'opacity-60' : '']"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span :class="['w-2.5 h-2.5 rounded-full', s.status === 'disconnected' ? 'bg-muted' : (Math.floor((Date.now() - s.lastActivity) / 60000) < 5 ? 'bg-success' : Math.floor((Date.now() - s.lastActivity) / 60000) < 30 ? 'bg-warn' : 'bg-danger')]"></span>
            <div>
              <div class="font-medium">
                <template v-if="s.topicName">
                  <span class="text-accentLight">{{ s.topicName }}</span>
                  <span class="text-textSecondary text-xs"> (thread {{ s.threadId }})</span>
                </template>
                <template v-else-if="s.threadId != null">Thread {{ s.threadId }}</template>
                <template v-else><span class="text-muted italic">Awaiting start_session…</span></template>
              </div>
              <div class="text-xs text-textSecondary font-mono">{{ s.mcpSessionId.slice(0, 12) }}...</div>
            </div>
          </div>
          <div class="text-right">
            <div class="flex items-center gap-2 justify-end">
              <span :class="['text-sm font-medium', sessionStatusInfo(s).color]">{{ sessionStatusInfo(s).label }}</span>
              <span v-if="pollLabel(s)" :class="['text-xs ml-2', pollClass(s)]">{{ pollLabel(s) }}</span>
            </div>
            <div class="text-xs text-textSecondary">{{ s.transportType }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
