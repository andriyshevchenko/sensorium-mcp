<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../api'

interface Snapshot {
  name: string
  createdAt: string
  mcpVersion: string
  description: string
  sizeBytes: number
}

const snapshots = ref<Snapshot[]>([])
const loading = ref(true)
const creating = ref(false)
const deleting = ref<string | null>(null)
const description = ref('')
const statusMsg = ref('')
const statusOk = ref(true)
const confirmDelete = ref<string | null>(null)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function showStatus(msg: string, ok: boolean) {
  statusMsg.value = msg
  statusOk.value = ok
  setTimeout(() => { statusMsg.value = '' }, 4000)
}

async function load() {
  loading.value = true
  try {
    const data = await api<{ snapshots: Snapshot[] }>('/api/snapshots')
    snapshots.value = data.snapshots
  } catch (e: unknown) {
    showStatus('Failed to load snapshots: ' + (e as Error).message, false)
  } finally {
    loading.value = false
  }
}

async function createSnapshot() {
  if (creating.value) return
  creating.value = true
  try {
    await api('/api/snapshots', {
      method: 'POST',
      body: JSON.stringify({ description: description.value }),
    })
    description.value = ''
    showStatus('Snapshot created ✓', true)
    await load()
  } catch (e: unknown) {
    showStatus('Error: ' + (e as Error).message, false)
  } finally {
    creating.value = false
  }
}

function askDelete(name: string) {
  confirmDelete.value = name
}

function cancelDelete() {
  confirmDelete.value = null
}

async function doDelete() {
  const name = confirmDelete.value
  if (!name || deleting.value) return
  confirmDelete.value = null
  deleting.value = name
  try {
    await api(`/api/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' })
    showStatus('Deleted ✓', true)
    await load()
  } catch (e: unknown) {
    showStatus('Error: ' + (e as Error).message, false)
  } finally {
    deleting.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <!-- Create Snapshot -->
    <div class="glass rounded-xl p-6 mb-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="text-lg font-semibold">Snapshots</h3>
          <p class="text-sm text-textSecondary mt-1">Create and manage data directory snapshots</p>
        </div>
        <span v-if="statusMsg" :class="['text-sm', statusOk ? 'text-success' : 'text-danger']">{{ statusMsg }}</span>
      </div>
      <div class="flex flex-wrap gap-3 items-center">
        <input
          v-model="description"
          type="text"
          placeholder="Description (optional)"
          class="flex-1 min-w-48 px-3 py-2 rounded-xl bg-surface border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
          @keydown.enter="createSnapshot"
        />
        <button
          @click="createSnapshot"
          :disabled="creating"
          class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-sm font-medium transition whitespace-nowrap"
        >
          <span v-if="creating" class="flex items-center gap-2">
            <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
            Creating…
          </span>
          <span v-else>+ Create Snapshot</span>
        </button>
      </div>
    </div>

    <!-- Snapshot List -->
    <div class="glass rounded-xl p-6">
      <div v-if="loading" class="text-center py-8 text-textSecondary text-sm">Loading…</div>
      <div v-else-if="snapshots.length === 0" class="text-center py-12 text-textSecondary text-sm">No snapshots yet</div>
      <div v-else class="space-y-2">
        <div
          v-for="snap in snapshots"
          :key="snap.name"
          class="glass rounded-xl p-4 border border-transparent hover:border-gray-700 transition"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2 mb-1">
                <span class="font-medium text-sm font-mono">{{ snap.name }}</span>
                <span class="type-badge" style="background:rgba(99,102,241,0.15);color:#818cf8">v{{ snap.mcpVersion }}</span>
                <span class="text-xs text-muted">{{ formatSize(snap.sizeBytes) }}</span>
              </div>
              <div class="text-xs text-muted">
                {{ formatDate(snap.createdAt) }}<template v-if="snap.description"> · {{ snap.description }}</template>
              </div>
            </div>
            <button
              @click="askDelete(snap.name)"
              :disabled="deleting === snap.name"
              class="px-3 py-1.5 rounded-lg bg-card hover:bg-red-900/40 border border-gray-700 hover:border-red-700 text-xs text-textSecondary hover:text-red-400 transition disabled:opacity-50 shrink-0"
            >{{ deleting === snap.name ? '…' : 'Delete' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Dialog -->
    <div v-if="confirmDelete" class="fixed inset-0 z-50 flex items-center justify-center bg-surface/80 backdrop-blur-sm">
      <div class="glass rounded-2xl p-6 max-w-sm w-full mx-4">
        <h3 class="text-base font-semibold mb-2">Delete Snapshot</h3>
        <p class="text-sm text-textSecondary mb-4">
          Delete <span class="font-mono text-textPrimary">{{ confirmDelete }}</span>? This cannot be undone.
        </p>
        <div class="flex gap-3">
          <button
            @click="doDelete"
            class="flex-1 px-4 py-2 rounded-xl bg-danger hover:opacity-80 text-white text-sm font-medium transition"
          >Delete</button>
          <button
            @click="cancelDelete"
            class="flex-1 px-4 py-2 rounded-xl bg-card hover:bg-cardHover border border-gray-700 text-sm text-textSecondary hover:text-textPrimary transition"
          >Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>
