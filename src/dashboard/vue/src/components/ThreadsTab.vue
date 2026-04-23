<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, getToken } from '../api'
import type { ThreadEntry } from '../types'

// ── State ────────────────────────────────────────────────────────────────────

const threads = ref<ThreadEntry[]>([])
const loading = ref(true)
const error = ref('')

// Children cache: rootThreadId → children[]
const childrenMap = ref<Record<number, ThreadEntry[]>>({})
const expandedRoots = ref<Set<number>>(new Set())

// Create form
const showCreateForm = ref(false)
const createForm = ref({ name: '', threadId: 0, client: 'claude', workingDirectory: '' })
const createStatus = ref('')
const creating = ref(false)

// Inline name editing
const editingNameId = ref<number | null>(null)
const editingNameValue = ref('')

// Inline CWD editing
const editingCwdId = ref<number | null>(null)
const editingCwdValue = ref('')

// Branch creation
const branchingRoot = ref<number | null>(null)
const branchForm = ref({ name: '', threadId: 0, client: 'claude', workingDirectory: '' })
const branchStatus = ref('')
const branchCreating = ref(false)

// Thread starting
const startingThreadId = ref<number | null>(null)

// Memory sync
const syncingThreadId = ref<number | null>(null)

// Convert to root
const convertingThreadId = ref<number | null>(null)

// Agent type options
const agentTypes = ['claude', 'copilot', 'codex', 'openai_codex', 'copilot_claude', 'copilot_codex', 'cursor'] as const

// ── Badge config ─────────────────────────────────────────────────────────────

const badgeConfig: Record<string, { emoji: string; classes: string }> = {
  root:   { emoji: '🟢', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
  daily:  { emoji: '🔵', classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  branch: { emoji: '🟣', classes: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  worker: { emoji: '🟡', classes: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
}

// ── Computed ─────────────────────────────────────────────────────────────────

const roots = computed(() => threads.value.filter(t => t.type === 'root'))
const dailySessions = computed(() => threads.value.filter(t => t.type === 'daily'))
const branches = computed(() => threads.value.filter(t => t.type === 'branch'))
const workers = computed(() => threads.value.filter(t => t.type === 'worker'))

// ── Data loading ─────────────────────────────────────────────────────────────

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api<{ threads?: ThreadEntry[] }>('/api/threads')
    threads.value = data.threads ?? []
  } catch (e: unknown) {
    error.value = (e as Error).message || 'Failed to load threads'
  } finally {
    loading.value = false
  }
}

async function loadChildren(rootThreadId: number) {
  try {
    const data = await api<{ threads?: ThreadEntry[] }>(`/api/threads/${rootThreadId}/children`)
    childrenMap.value[rootThreadId] = data.threads ?? []
  } catch {
    childrenMap.value[rootThreadId] = []
  }
}

function toggleExpand(rootThreadId: number) {
  if (expandedRoots.value.has(rootThreadId)) {
    expandedRoots.value.delete(rootThreadId)
  } else {
    expandedRoots.value.add(rootThreadId)
    void loadChildren(rootThreadId)
  }
}

// ── Create root thread ───────────────────────────────────────────────────────

async function createThread() {
  if (!createForm.value.name.trim() || !createForm.value.threadId) return
  creating.value = true
  createStatus.value = ''
  try {
    const r = await fetch('/api/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: createForm.value.threadId,
        name: createForm.value.name.trim(),
        type: 'root',
        client: createForm.value.client,
        keepAlive: true,
        ...(createForm.value.workingDirectory.trim() ? { workingDirectory: createForm.value.workingDirectory.trim() } : {}),
      }),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
      throw new Error(err.error ?? r.statusText)
    }
    createStatus.value = 'Created ✓'
    createForm.value = { name: '', threadId: 0, client: 'claude', workingDirectory: '' }
    showCreateForm.value = false
    setTimeout(() => { createStatus.value = '' }, 3000)
    await load()
  } catch (e: unknown) {
    createStatus.value = 'Error: ' + (e as Error).message
  } finally {
    creating.value = false
  }
}

// ── Create branch ────────────────────────────────────────────────────────────

async function createBranch(rootThreadId: number) {
  if (!branchForm.value.name.trim() || !branchForm.value.threadId) return
  branchCreating.value = true
  branchStatus.value = ''
  try {
    const r = await fetch('/api/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: branchForm.value.threadId,
        name: branchForm.value.name.trim(),
        type: 'branch',
        rootThreadId,
        client: branchForm.value.client,
        ...(branchForm.value.workingDirectory.trim() ? { workingDirectory: branchForm.value.workingDirectory.trim() } : {}),
      }),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
      throw new Error(err.error ?? r.statusText)
    }
    branchStatus.value = 'Branch created ✓'
    branchForm.value = { name: '', threadId: 0, client: 'claude', workingDirectory: '' }
    branchingRoot.value = null
    setTimeout(() => { branchStatus.value = '' }, 3000)
    await load()
    void loadChildren(rootThreadId)
  } catch (e: unknown) {
    branchStatus.value = 'Error: ' + (e as Error).message
  } finally {
    branchCreating.value = false
  }
}

// ── Toggle keep-alive ────────────────────────────────────────────────────────

function startRename(thread: ThreadEntry) {
  editingNameId.value = thread.threadId
  editingNameValue.value = thread.name
}

async function submitRename(threadId: number) {
  const newName = editingNameValue.value.trim()
  editingNameId.value = null
  if (!newName) return
  try {
    const r = await fetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: newName }),
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to rename thread: ' + (e as Error).message
  }
}

function startCwdEdit(thread: ThreadEntry) {
  editingCwdId.value = thread.threadId
  editingCwdValue.value = thread.workingDirectory ?? ''
}

async function submitCwdEdit(threadId: number) {
  const newCwd = editingCwdValue.value.trim()
  editingCwdId.value = null
  try {
    const r = await fetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workingDirectory: newCwd || null }),
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to update working directory: ' + (e as Error).message
  }
}

async function toggleKeepAlive(thread: ThreadEntry) {
  try {
    const r = await fetch(`/api/threads/${thread.threadId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keepAlive: !thread.keepAlive }),
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to toggle keep-alive: ' + (e as Error).message
  }
}

async function changeClient(thread: ThreadEntry, newClient: string) {
  try {
    const r = await fetch(`/api/threads/${thread.threadId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client: newClient }),
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to change agent type: ' + (e as Error).message
  }
}

async function toggleDailyRotation(thread: ThreadEntry) {
  try {
    const r = await fetch(`/api/threads/${thread.threadId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dailyRotation: !thread.dailyRotation }),
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to toggle daily rotation: ' + (e as Error).message
  }
}

async function toggleAutonomousMode(thread: ThreadEntry) {
  try {
    const r = await fetch(`/api/threads/${thread.threadId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ autonomousMode: !thread.autonomousMode }),
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to toggle autonomous mode: ' + (e as Error).message
  }
}

// ── Archive thread ───────────────────────────────────────────────────────────

async function archiveThread(thread: ThreadEntry) {
  if (!confirm(`Archive thread "${thread.name}" (${thread.threadId})?`)) return
  try {
    const r = await fetch(`/api/threads/${thread.threadId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to archive: ' + (e as Error).message
  }
}

// ── Start thread ────────────────────────────────────────────────────────────

async function startThread(thread: ThreadEntry) {
  if (!confirm(`Start thread "${thread.name}" (${thread.threadId})?`)) return
  startingThreadId.value = thread.threadId
  try {
    const r = await fetch(`/api/threads/${thread.threadId}/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
      throw new Error(err.error ?? r.statusText)
    }
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to start thread: ' + (e as Error).message
  } finally {
    startingThreadId.value = null
  }
}

// ── Sync to root ────────────────────────────────────────────────────────────

function syncToRoot(_thread: ThreadEntry) {
  createStatus.value = 'Sync to Root — not yet implemented'
  setTimeout(() => { createStatus.value = '' }, 3000)
}

// ── Convert to root ──────────────────────────────────────────────────────────

async function convertToRoot(thread: ThreadEntry) {
  if (!confirm(`Convert "${thread.name}" to a root thread? This will detach it from its parent.`)) return
  convertingThreadId.value = thread.threadId
  try {
    const r = await fetch(`/api/threads/${thread.threadId}/convert-to-root`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
      throw new Error(err.error ?? r.statusText)
    }
    error.value = ''
    createStatus.value = `Converted "${thread.name}" to root ✓`
    setTimeout(() => { createStatus.value = '' }, 3000)
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to convert: ' + (e as Error).message
  } finally {
    convertingThreadId.value = null
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

function statusClass(status: string): string {
  if (status === 'active') return 'text-success'
  if (status === 'archived') return 'text-muted'
  return 'text-warn'
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in space-y-6">
    <!-- Header -->
    <div class="glass rounded-xl p-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-2">
        <div>
          <h3 class="text-lg font-semibold">Thread Registry</h3>
          <p class="text-sm text-textSecondary mt-1">Manage conversation threads, branches, and daily sessions</p>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="createStatus" :class="createStatus.startsWith('Error') ? 'text-danger' : 'text-success'" class="text-sm">{{ createStatus }}</span>
          <button
            @click="showCreateForm = !showCreateForm"
            class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition"
          >
            {{ showCreateForm ? 'Cancel' : '+ New Root Thread' }}
          </button>
          <button @click="load" class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm hover:bg-surface transition">
            ↻ Refresh
          </button>
        </div>
      </div>

      <!-- Create form -->
      <div v-if="showCreateForm" class="mt-4 p-4 rounded-xl bg-surface border border-gray-700/50 space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label class="block text-xs text-textSecondary mb-1">Name</label>
            <input
              v-model="createForm.name"
              type="text"
              placeholder="e.g. Main Workspace"
              class="w-full px-3 py-2 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
            />
          </div>
          <div>
            <label class="block text-xs text-textSecondary mb-1">Thread ID</label>
            <input
              v-model.number="createForm.threadId"
              type="number"
              min="1"
              placeholder="Telegram thread ID"
              class="w-full px-3 py-2 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
            />
          </div>
          <div>
            <label class="block text-xs text-textSecondary mb-1">Client</label>
            <select
              v-model="createForm.client"
              class="w-full px-3 py-2 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none focus:border-accent transition appearance-none"
            >
              <option v-for="at in agentTypes" :key="at" :value="at">{{ at }}</option>
            </select>
          </div>
        </div>
        <div>
          <label class="block text-xs text-textSecondary mb-1">Working Directory (optional)</label>
          <input
            v-model="createForm.workingDirectory"
            type="text"
            placeholder="e.g. C:\src\my-project"
            class="w-full px-3 py-2 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition font-mono"
          />
        </div>
        <div class="flex justify-end">
          <button
            @click="createThread"
            :disabled="creating || !createForm.name.trim() || !createForm.threadId"
            class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-sm font-medium transition"
          >
            {{ creating ? 'Creating…' : 'Create Root Thread' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Loading / Error -->
    <div v-if="loading && threads.length === 0" class="text-center py-12 text-textSecondary">Loading threads…</div>
    <div v-else-if="error" class="text-center py-8 text-danger text-sm">{{ error }}</div>
    <div v-else-if="threads.length === 0" class="text-center py-12 text-textSecondary">No threads registered</div>

    <!-- Roots Section -->
    <div v-if="roots.length > 0">
      <h4 class="text-sm font-medium text-textSecondary uppercase tracking-wider mb-3">🟢 Root Threads</h4>
      <div class="space-y-3">
        <div v-for="t in roots" :key="t.id" class="glass rounded-xl overflow-hidden">
          <!-- Root card -->
          <div class="p-4">
            <div class="flex flex-wrap items-center gap-3">
              <!-- Badge -->
              <span :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', badgeConfig[t.type]?.classes]">
                {{ badgeConfig[t.type]?.emoji }} {{ t.type.toUpperCase() }}
              </span>
              <!-- Name (double-click to edit) -->
              <input
                v-if="editingNameId === t.threadId"
                v-model="editingNameValue"
                @blur="submitRename(t.threadId)"
                @keyup.enter="($event.target as HTMLInputElement).blur()"
                @keyup.escape="editingNameId = null"
                class="font-semibold bg-card border border-accent rounded px-1 py-0 text-textPrimary focus:outline-none w-40"
                ref="nameInput"
              />
              <span v-else class="font-semibold cursor-pointer hover:text-accent transition" @dblclick="startRename(t)" title="Double-click to rename">{{ t.name }}</span>
              <!-- Status -->
              <span :class="['text-xs font-medium', statusClass(t.status)]">{{ t.status }}</span>
              <span class="text-xs text-muted font-mono">ID: {{ t.threadId }}</span>
              <!-- Agent type selector -->
              <select
                :value="t.client"
                @change="changeClient(t, ($event.target as HTMLSelectElement).value)"
                class="px-2 py-0.5 rounded-lg bg-card border border-gray-700 text-xs text-textPrimary focus:outline-none focus:border-accent transition appearance-none cursor-pointer"
                title="Agent type"
              >
                <option v-for="at in agentTypes" :key="at" :value="at">{{ at }}</option>
              </select>
              <span class="text-xs text-muted">{{ formatDate(t.lastActiveAt) }}</span>
              <!-- Inline CWD editing -->
              <input
                v-if="editingCwdId === t.threadId"
                v-model="editingCwdValue"
                @keyup.enter="submitCwdEdit(t.threadId)"
                @keyup.escape="editingCwdId = null"
                @blur="submitCwdEdit(t.threadId)"
                type="text"
                placeholder="Set working directory…"
                class="text-xs font-mono bg-card border border-accent rounded px-1 py-0 text-textPrimary focus:outline-none w-48"
              />
              <span
                v-else
                class="text-xs text-muted font-mono truncate max-w-[200px] cursor-pointer hover:text-accent transition"
                :title="(t.workingDirectory ?? 'Click to set CWD') + ' (dblclick to edit)'"
                @dblclick="startCwdEdit(t)"
              >📁 {{ t.workingDirectory ?? '—' }}</span>

              <div class="ml-auto flex items-center gap-3">
                <!-- Start button -->
                <button
                  @click="startThread(t)"
                  :disabled="startingThreadId === t.threadId"
                  class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
                  title="Start thread"
                >
                  {{ startingThreadId === t.threadId ? 'Starting…' : '▶ Start' }}
                </button>

                <!-- Keep-alive toggle -->
                <div class="flex items-center gap-1.5">
                  <button
                    @click="toggleKeepAlive(t)"
                    :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', t.keepAlive ? 'bg-accent' : 'bg-gray-700']"
                    title="Toggle keep-alive"
                  >
                    <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', t.keepAlive ? 'translate-x-4' : 'translate-x-0.5']" />
                  </button>
                  <span class="text-xs text-muted">Keep-alive</span>
                </div>

                <!-- Daily Rotation toggle -->
                <div class="flex items-center gap-1.5">
                  <button
                    @click="toggleDailyRotation(t)"
                    :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', t.dailyRotation ? 'bg-blue-500' : 'bg-gray-700']"
                    title="Toggle daily rotation"
                  >
                    <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', t.dailyRotation ? 'translate-x-4' : 'translate-x-0.5']" />
                  </button>
                  <span class="text-xs text-muted">Daily</span>
                </div>

                <!-- Autonomous Mode toggle -->
                <div class="flex items-center gap-1.5">
                  <button
                    @click="toggleAutonomousMode(t)"
                    :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', t.autonomousMode ? 'bg-orange-500' : 'bg-gray-700']"
                    title="Toggle autonomous mode"
                  >
                    <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', t.autonomousMode ? 'translate-x-4' : 'translate-x-0.5']" />
                  </button>
                  <span class="text-xs text-muted">Auto</span>
                </div>

                <!-- Expand children -->
                <button
                  @click="toggleExpand(t.threadId)"
                  class="px-2 py-1 rounded-lg text-xs bg-card border border-gray-700 hover:bg-surface transition"
                >
                  {{ expandedRoots.has(t.threadId) ? '▾ Children' : '▸ Children' }}
                </button>

                <!-- Create branch -->
                <button
                  @click="branchingRoot = branchingRoot === t.threadId ? null : t.threadId; branchForm = { name: '', threadId: 0, client: 'claude', workingDirectory: '' }; branchStatus = ''"
                  class="px-2 py-1 rounded-lg text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 transition"
                >
                  + Branch
                </button>

                <!-- Archive root thread -->
                <button
                  @click="archiveThread(t)"
                  class="px-2 py-1 rounded-lg text-xs bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition"
                >
                  Archive
                </button>
              </div>
            </div>

            <!-- Branch creation form (inline) -->
            <div v-if="branchingRoot === t.threadId" class="mt-3 p-3 rounded-lg bg-surface border border-purple-500/20 space-y-2">
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  v-model="branchForm.name"
                  type="text"
                  placeholder="Branch name"
                  class="px-3 py-1.5 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
                />
                <input
                  v-model.number="branchForm.threadId"
                  type="number"
                  min="1"
                  placeholder="Thread ID"
                  class="px-3 py-1.5 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
                />
                <select
                  v-model="branchForm.client"
                  class="px-3 py-1.5 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none focus:border-accent transition appearance-none"
                >
                  <option v-for="at in agentTypes" :key="at" :value="at">{{ at }}</option>
                </select>
              </div>
              <input
                v-model="branchForm.workingDirectory"
                type="text"
                placeholder="Working directory (optional)"
                class="w-full px-3 py-1.5 rounded-lg bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition font-mono"
              />
              <div class="flex items-center gap-2">
                <button
                  @click="createBranch(t.threadId)"
                  :disabled="branchCreating || !branchForm.name.trim() || !branchForm.threadId"
                  class="px-3 py-1.5 rounded-lg bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-xs font-medium transition"
                >
                  {{ branchCreating ? 'Creating…' : 'Create Branch' }}
                </button>
                <span v-if="branchStatus" :class="branchStatus.startsWith('Error') ? 'text-danger' : 'text-success'" class="text-xs">{{ branchStatus }}</span>
              </div>
            </div>
          </div>

          <!-- Children list -->
          <div v-if="expandedRoots.has(t.threadId) && childrenMap[t.threadId]" class="border-t border-gray-700/30 bg-surface/30 px-4 py-3 space-y-2">
            <div v-if="childrenMap[t.threadId].length === 0" class="text-xs text-muted py-1">No children</div>
            <div
              v-for="child in childrenMap[t.threadId]"
              :key="child.id"
              class="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-card/50 border border-gray-700/30"
            >
              <span :class="['inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium border', badgeConfig[child.type]?.classes]">
                {{ badgeConfig[child.type]?.emoji }} {{ child.type.toUpperCase() }}
              </span>
              <span class="text-sm font-medium">{{ child.name }}</span>
              <span :class="['text-xs', statusClass(child.status)]">{{ child.status }}</span>
              <span class="text-xs text-muted font-mono">ID: {{ child.threadId }}</span>
              <!-- Agent type selector for children -->
              <select
                :value="child.client"
                @change="changeClient(child, ($event.target as HTMLSelectElement).value)"
                class="px-2 py-0.5 rounded-lg bg-card border border-gray-700 text-xs text-textPrimary focus:outline-none focus:border-accent transition appearance-none cursor-pointer"
                title="Agent type"
              >
                <option v-for="at in agentTypes" :key="at" :value="at">{{ at }}</option>
              </select>
              <span class="text-xs text-muted">{{ formatDate(child.lastActiveAt) }}</span>
              <div class="ml-auto flex items-center gap-3">
                <!-- Start button for children -->
                <button
                  @click="startThread(child)"
                  :disabled="startingThreadId === child.threadId"
                  class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
                  title="Start thread"
                >
                  {{ startingThreadId === child.threadId ? 'Starting…' : '▶ Start' }}
                </button>
                <!-- Sync to Root button for branches/workers -->
                <button
                  v-if="child.rootThreadId"
                  @click="syncToRoot(child)"
                  :disabled="syncingThreadId === child.threadId"
                  class="px-2 py-1 rounded-lg text-xs bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-50 transition"
                  title="Sync memory to root thread"
                >
                  {{ syncingThreadId === child.threadId ? 'Syncing…' : '⟳ Sync to Root' }}
                </button>
                <!-- Convert to Root button for branches -->
                <button
                  v-if="child.type === 'branch' || child.type === 'daily'"
                  @click="convertToRoot(child)"
                  :disabled="convertingThreadId === child.threadId"
                  class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
                  title="Convert to independent root thread"
                >
                  {{ convertingThreadId === child.threadId ? 'Converting…' : '↑ To Root' }}
                </button>
                <!-- Keep-alive toggle for branches -->
                <div v-if="child.type === 'branch'" class="flex items-center gap-1.5">
                  <button
                    @click="toggleKeepAlive(child)"
                    :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', child.keepAlive ? 'bg-accent' : 'bg-gray-700']"
                    title="Toggle keep-alive"
                  >
                    <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', child.keepAlive ? 'translate-x-4' : 'translate-x-0.5']" />
                  </button>
                  <span class="text-xs text-muted">Keep-alive</span>
                </div>
                <!-- Autonomous Mode toggle for branches -->
                <div v-if="child.type === 'branch'" class="flex items-center gap-1.5">
                  <button
                    @click="toggleAutonomousMode(child)"
                    :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', child.autonomousMode ? 'bg-orange-500' : 'bg-gray-700']"
                    title="Toggle autonomous mode"
                  >
                    <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', child.autonomousMode ? 'translate-x-4' : 'translate-x-0.5']" />
                  </button>
                  <span class="text-xs text-muted">Auto</span>
                </div>
                <button
                  v-if="child.type !== 'root'"
                  @click="archiveThread(child)"
                  class="px-2 py-0.5 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Daily Sessions -->
    <div v-if="dailySessions.length > 0">
      <h4 class="text-sm font-medium text-textSecondary uppercase tracking-wider mb-3">🔵 Daily Sessions</h4>
      <div class="space-y-2">
        <div
          v-for="t in dailySessions"
          :key="t.id"
          class="glass rounded-xl p-4 flex flex-wrap items-center gap-3"
        >
          <span :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', badgeConfig[t.type]?.classes]">
            {{ badgeConfig[t.type]?.emoji }} {{ t.type.toUpperCase() }}
          </span>
          <span class="font-medium">{{ t.name }}</span>
          <span :class="['text-xs font-medium', statusClass(t.status)]">{{ t.status }}</span>
          <span class="text-xs text-muted font-mono">ID: {{ t.threadId }}</span>
          <span class="text-xs text-textSecondary">{{ t.client }}</span>
          <span class="text-xs text-muted">{{ formatDate(t.lastActiveAt) }}</span>
          <div class="ml-auto flex items-center gap-2">
            <button
              @click="startThread(t)"
              :disabled="startingThreadId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
              title="Start thread"
            >
              {{ startingThreadId === t.threadId ? 'Starting…' : '▶ Start' }}
            </button>
            <button
              v-if="t.rootThreadId"
              @click="syncToRoot(t)"
              :disabled="syncingThreadId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-50 transition"
              title="Sync memory to root thread"
            >
              {{ syncingThreadId === t.threadId ? 'Syncing…' : '⟳ Sync to Root' }}
            </button>
            <button
              @click="archiveThread(t)"
              class="px-2 py-1 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition"
            >
              Archive
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Branches -->
    <div v-if="branches.length > 0">
      <h4 class="text-sm font-medium text-textSecondary uppercase tracking-wider mb-3">🟣 Branches</h4>
      <div class="space-y-2">
        <div
          v-for="t in branches"
          :key="t.id"
          class="glass rounded-xl p-4 flex flex-wrap items-center gap-3"
        >
          <span :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', badgeConfig[t.type]?.classes]">
            {{ badgeConfig[t.type]?.emoji }} {{ t.type.toUpperCase() }}
          </span>
          <span class="font-medium">{{ t.name }}</span>
          <span :class="['text-xs font-medium', statusClass(t.status)]">{{ t.status }}</span>
          <span class="text-xs text-muted font-mono">ID: {{ t.threadId }}</span>
          <select
            :value="t.client"
            @change="changeClient(t, ($event.target as HTMLSelectElement).value)"
            class="px-2 py-0.5 rounded-lg bg-card border border-gray-700 text-xs text-textPrimary focus:outline-none focus:border-accent transition appearance-none cursor-pointer"
            title="Agent type"
          >
            <option v-for="at in agentTypes" :key="at" :value="at">{{ at }}</option>
          </select>
          <span class="text-xs text-muted">{{ formatDate(t.lastActiveAt) }}</span>
          <div class="ml-auto flex items-center gap-3">
            <button
              @click="startThread(t)"
              :disabled="startingThreadId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
              title="Start thread"
            >
              {{ startingThreadId === t.threadId ? 'Starting…' : '▶ Start' }}
            </button>
            <button
              v-if="t.rootThreadId"
              @click="syncToRoot(t)"
              :disabled="syncingThreadId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-50 transition"
              title="Sync memory to root thread"
            >
              {{ syncingThreadId === t.threadId ? 'Syncing…' : '⟳ Sync to Root' }}
            </button>
            <div class="flex items-center gap-1.5">
              <button
                @click="toggleKeepAlive(t)"
                :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', t.keepAlive ? 'bg-accent' : 'bg-gray-700']"
                title="Toggle keep-alive"
              >
                <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', t.keepAlive ? 'translate-x-4' : 'translate-x-0.5']" />
              </button>
              <span class="text-xs text-muted">Keep-alive</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                @click="toggleAutonomousMode(t)"
                :class="['relative inline-flex h-5 w-9 items-center rounded-full transition-colors', t.autonomousMode ? 'bg-orange-500' : 'bg-gray-700']"
                title="Toggle autonomous mode"
              >
                <span :class="['inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform', t.autonomousMode ? 'translate-x-4' : 'translate-x-0.5']" />
              </button>
              <span class="text-xs text-muted">Auto</span>
            </div>
            <button
              @click="archiveThread(t)"
              class="px-2 py-1 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition"
            >
              Archive
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Workers -->
    <div v-if="workers.length > 0">
      <h4 class="text-sm font-medium text-textSecondary uppercase tracking-wider mb-3">🟡 Workers</h4>
      <div class="space-y-2">
        <div
          v-for="t in workers"
          :key="t.id"
          class="glass rounded-xl p-4 flex flex-wrap items-center gap-3"
        >
          <span :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', badgeConfig[t.type]?.classes]">
            {{ badgeConfig[t.type]?.emoji }} {{ t.type.toUpperCase() }}
          </span>
          <span class="font-medium">{{ t.name }}</span>
          <span :class="['text-xs font-medium', statusClass(t.status)]">{{ t.status }}</span>
          <span class="text-xs text-muted font-mono">ID: {{ t.threadId }}</span>
          <select
            :value="t.client"
            @change="changeClient(t, ($event.target as HTMLSelectElement).value)"
            class="px-2 py-0.5 rounded-lg bg-card border border-gray-700 text-xs text-textPrimary focus:outline-none focus:border-accent transition appearance-none cursor-pointer"
            title="Agent type"
          >
            <option v-for="at in agentTypes" :key="at" :value="at">{{ at }}</option>
          </select>
          <span class="text-xs text-muted">{{ formatDate(t.lastActiveAt) }}</span>
          <div class="ml-auto flex items-center gap-2">
            <button
              @click="startThread(t)"
              :disabled="startingThreadId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
              title="Start thread"
            >
              {{ startingThreadId === t.threadId ? 'Starting…' : '▶ Start' }}
            </button>
            <button
              v-if="t.rootThreadId"
              @click="syncToRoot(t)"
              :disabled="syncingThreadId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-50 transition"
              title="Sync memory to root thread"
            >
              {{ syncingThreadId === t.threadId ? 'Syncing…' : '⟳ Sync to Root' }}
            </button>
            <button
              @click="archiveThread(t)"
              class="px-2 py-1 rounded-lg text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition"
            >
              Archive
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
