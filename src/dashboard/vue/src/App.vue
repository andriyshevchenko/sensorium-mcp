<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api, setToken } from './api'
import type { StatusResponse } from './types'
import SessionsTab from './components/SessionsTab.vue'
import MemoryNotesTab from './components/MemoryNotesTab.vue'
import TemplatesTab from './components/TemplatesTab.vue'
import SkillsTab from './components/SkillsTab.vue'
import ThreadsTab from './components/ThreadsTab.vue'
import SettingsTab from './components/SettingsTab.vue'

const TOKEN_KEY = 'sensorium_token'

const authenticated = ref(false)
const tokenInput = ref('')
const authError = ref('')
const connecting = ref(false)

const status = ref<StatusResponse | null>(null)
const currentTab = ref('sessions')

let refreshTimer: ReturnType<typeof setInterval> | null = null

const tabs = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'notes', label: 'Memory Notes' },
  { id: 'templates', label: 'Templates' },
  { id: 'skills', label: 'Skills' },
  { id: 'threads', label: 'Threads' },
  { id: 'settings', label: 'Settings' },
]

const tabComponents = {
  sessions: SessionsTab,
  notes: MemoryNotesTab,
  templates: TemplatesTab,
  skills: SkillsTab,
  threads: ThreadsTab,
  settings: SettingsTab,
}

const currentTabComponent = computed(() => tabComponents[currentTab.value as keyof typeof tabComponents])

const uptime = computed(() => {
  if (!status.value) return '—'
  const s = Math.floor(status.value.uptime)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
})

async function authenticate() {
  const t = tokenInput.value.trim() || 'no-auth'
  connecting.value = true
  authError.value = ''
  try {
    setToken(t)
    await fetchStatus()
    localStorage.setItem(TOKEN_KEY, t)
    authenticated.value = true
    startRefresh()
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string }
    if (err.status === 401) {
      authError.value = 'Invalid token'
    } else {
      authError.value = err.message ?? 'Connection failed'
    }
    setToken('')
  } finally {
    connecting.value = false
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY)
  authenticated.value = false
  tokenInput.value = ''
  status.value = null
  if (refreshTimer) clearInterval(refreshTimer)
  setToken('')
}

async function fetchStatus() {
  status.value = await api<StatusResponse>('/api/status')
}

function startRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(fetchStatus, 30000)
}

onMounted(async () => {
  const saved = localStorage.getItem(TOKEN_KEY)
  if (saved) {
    tokenInput.value = saved
    try {
      setToken(saved)
      await fetchStatus()
      authenticated.value = true
      startRefresh()
    } catch {
      localStorage.removeItem(TOKEN_KEY)
      setToken('')
    }
  }
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <!-- Auth Overlay -->
  <div v-if="!authenticated" class="fixed inset-0 z-50 flex items-center justify-center bg-surface/95 backdrop-blur-sm">
    <div class="glass rounded-2xl p-8 max-w-md w-full mx-4 animate-slide-up">
      <div class="flex items-center gap-3 mb-6">
        <div class="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
          <svg class="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-semibold">Sensorium MCP</h2>
          <p class="text-sm text-textSecondary">Enter your API token</p>
        </div>
      </div>
      <input
        v-model="tokenInput"
        type="password"
        placeholder="MCP_HTTP_SECRET"
        class="w-full px-4 py-3 rounded-xl bg-surface border border-gray-700 text-textPrimary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition font-mono text-sm"
        @keydown.enter="authenticate"
      />
      <button
        @click="authenticate"
        :disabled="connecting"
        class="w-full mt-4 px-4 py-3 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white font-medium transition"
      >
        {{ connecting ? 'Connecting...' : 'Connect' }}
      </button>
      <p v-if="authError" class="mt-3 text-sm text-danger">{{ authError }}</p>
    </div>
  </div>

  <!-- Main Dashboard -->
  <div v-else class="min-h-screen font-sans text-textPrimary animate-fade-in">
    <!-- Header -->
    <header class="glass sticky top-0 z-40 border-b border-gray-800/50">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center">
            <span class="text-white text-sm font-bold">S</span>
          </div>
          <div>
            <h1 class="text-lg font-semibold tracking-tight">Sensorium MCP</h1>
            <p class="text-xs text-textSecondary">Agent Dashboard</p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2 text-sm">
            <span class="w-2 h-2 rounded-full bg-success animate-pulse-slow"></span>
            <span class="text-textSecondary">Connected</span>
          </div>
          <div class="text-sm text-textSecondary font-mono">{{ uptime }}</div>
          <button @click="logout" class="text-sm text-muted hover:text-textSecondary transition">Disconnect</button>
        </div>
      </div>
    </header>

    <!-- Stats bar -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div class="glass rounded-xl p-4 stat-glow animate-slide-up">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-success">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </span>
            <span class="text-xs text-textSecondary font-medium uppercase tracking-wider">Sessions</span>
          </div>
          <div class="text-2xl font-bold font-mono">{{ status?.activeSessions ?? 0 }}</div>
        </div>
        <div class="glass rounded-xl p-4 stat-glow animate-slide-up">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-accentLight">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            </span>
            <span class="text-xs text-textSecondary font-medium uppercase tracking-wider">Notes</span>
          </div>
          <div class="text-2xl font-bold font-mono">{{ status?.memory?.totalSemanticNotes ?? 0 }}</div>
        </div>
        <div class="glass rounded-xl p-4 stat-glow animate-slide-up">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-warn">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            </span>
            <span class="text-xs text-textSecondary font-medium uppercase tracking-wider">Episodes</span>
          </div>
          <div class="text-2xl font-bold font-mono">{{ status?.memory?.totalEpisodes ?? 0 }}</div>
        </div>
        <div class="glass rounded-xl p-4 stat-glow animate-slide-up">
          <div class="flex items-center gap-2 mb-2">
            <span :class="(status?.memory?.unconsolidatedEpisodes ?? 0) > 10 ? 'text-danger' : 'text-success'">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </span>
            <span class="text-xs text-textSecondary font-medium uppercase tracking-wider">Unconsolidated</span>
          </div>
          <div class="text-2xl font-bold font-mono">{{ status?.memory?.unconsolidatedEpisodes ?? 0 }}</div>
        </div>
        <div class="glass rounded-xl p-4 stat-glow animate-slide-up">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-accent">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </span>
            <span class="text-xs text-textSecondary font-medium uppercase tracking-wider">Procedures</span>
          </div>
          <div class="text-2xl font-bold font-mono">{{ status?.memory?.totalProcedures ?? 0 }}</div>
        </div>
        <div class="glass rounded-xl p-4 stat-glow animate-slide-up">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-success">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M12 5l7 7-7 7"/></svg>
            </span>
            <span class="text-xs text-textSecondary font-medium uppercase tracking-wider">Uptime</span>
          </div>
          <div class="text-2xl font-bold font-mono">{{ uptime }}</div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6">
      <nav class="flex gap-6 border-b border-gray-800/50 mb-6">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="currentTab = tab.id"
          :class="['pb-3 text-sm font-medium transition', currentTab === tab.id ? 'tab-active' : 'tab-inactive']"
        >
          {{ tab.label }}
        </button>
      </nav>
    </div>

    <!-- Tab Content -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 pb-12">
      <component :is="currentTabComponent" :status="status" />
    </div>
  </div>
</template>
