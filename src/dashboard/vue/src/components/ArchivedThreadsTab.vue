<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, getToken } from '../api'
import type { ThreadEntry } from '../types'

const threads = ref<ThreadEntry[]>([])
const loading = ref(true)
const error = ref('')
const summaries = ref<Record<number, string | null>>({})
const generatingIds = ref<Record<number, boolean>>({})
const summaryProgress = ref({ done: 0, total: 0 })
const unarchivingId = ref<number | null>(null)
const filterType = ref<string>('all')

const SUMMARY_CONCURRENCY = 3
let summaryGeneration = 0

const badgeConfig: Record<string, { emoji: string; classes: string }> = {
  root:   { emoji: '🟢', classes: 'bg-green-500/20 text-green-400 border-green-500/30' },
  daily:  { emoji: '🔵', classes: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  branch: { emoji: '🟣', classes: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
}

const filtered = computed(() => {
  if (filterType.value === 'all') return threads.value
  return threads.value.filter(t => t.type === filterType.value)
})

const typeCounts = computed(() => {
  const counts: Record<string, number> = { all: threads.value.length }
  for (const t of threads.value) {
    counts[t.type] = (counts[t.type] ?? 0) + 1
  }
  return counts
})

const isBuildingSummaries = computed(() => Object.values(generatingIds.value).some(Boolean))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api<{ threads?: ThreadEntry[] }>('/api/threads/archived')
    threads.value = data.threads ?? []
    summaries.value = {}
    generatingIds.value = {}
    if (threads.value.length > 0) {
      void buildAllSummaries()
    }
  } catch (e: unknown) {
    error.value = (e as Error).message || 'Failed to load archived threads'
  } finally {
    loading.value = false
  }
}

async function buildAllSummaries() {
  const gen = ++summaryGeneration
  const queue = [...threads.value]
  summaryProgress.value = { done: 0, total: queue.length }

  async function worker() {
    while (queue.length > 0 && gen === summaryGeneration) {
      const thread = queue.shift()!
      generatingIds.value = { ...generatingIds.value, [thread.threadId]: true }
      try {
        const r = await fetch(`/api/threads/${thread.threadId}/summary`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${getToken()}` },
        })
        if (gen !== summaryGeneration) return
        if (r.ok) {
          const data = await r.json() as { summary?: string }
          if (data.summary) {
            summaries.value = { ...summaries.value, [thread.threadId]: data.summary }
          }
        }
      } catch {
        // skip failed summaries silently
      } finally {
        if (gen === summaryGeneration) {
          const { [thread.threadId]: _, ...rest } = generatingIds.value
          generatingIds.value = rest
          summaryProgress.value = { ...summaryProgress.value, done: summaryProgress.value.done + 1 }
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(SUMMARY_CONCURRENCY, queue.length) }, () => worker())
  await Promise.all(workers)
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = Date.now()
  const diffMs = now - d.getTime()
  const mins = Math.floor(diffMs / 60000)
  const hours = Math.floor(diffMs / 3600000)
  const days = Math.floor(diffMs / 86400000)
  const months = Math.floor(days / 30)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 30) return `${days}d ago`
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

async function unarchive(thread: ThreadEntry) {
  if (!confirm(`Unarchive thread "${thread.name}" (${thread.threadId})?`)) return
  unarchivingId.value = thread.threadId
  try {
    const r = await fetch(`/api/threads/${thread.threadId}/unarchive`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
      throw new Error(err.error ?? r.statusText)
    }
    await load()
  } catch (e: unknown) {
    error.value = 'Failed to unarchive: ' + (e as Error).message
  } finally {
    unarchivingId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in space-y-6">
    <!-- Header -->
    <div class="glass rounded-xl p-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-2">
        <div>
          <h3 class="text-lg font-semibold">Archived Threads</h3>
          <p class="text-sm text-textSecondary mt-1">{{ threads.length }} archived thread{{ threads.length !== 1 ? 's' : '' }} — auto-purged after 180 days</p>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="isBuildingSummaries" class="text-xs text-accentLight animate-pulse">
            Building summaries… {{ summaryProgress.done }}/{{ summaryProgress.total }}
          </span>
          <button @click="load" class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm hover:bg-surface transition">
            ↻ Refresh
          </button>
        </div>
      </div>

      <!-- Type filter pills -->
      <div v-if="threads.length > 0" class="flex flex-wrap gap-2 mt-3">
        <button
          v-for="ft in ['all', 'root', 'branch', 'daily']"
          :key="ft"
          @click="filterType = ft"
          :class="[
            'px-3 py-1 rounded-full text-xs font-medium border transition',
            filterType === ft
              ? 'bg-accent/20 text-accent border-accent/30'
              : 'bg-card border-gray-700 text-textSecondary hover:border-gray-600'
          ]"
        >
          {{ ft === 'all' ? 'All' : ft.charAt(0).toUpperCase() + ft.slice(1) }}
          <span class="ml-1 opacity-60">({{ typeCounts[ft] ?? 0 }})</span>
        </button>
      </div>
    </div>

    <!-- Loading / Error / Empty -->
    <div v-if="loading && threads.length === 0" class="text-center py-12 text-textSecondary">Loading archived threads…</div>
    <div v-else-if="error" class="text-center py-8 text-danger text-sm">{{ error }}</div>
    <div v-else-if="threads.length === 0" class="text-center py-12 text-textSecondary">No archived threads</div>

    <!-- Thread list -->
    <div v-if="filtered.length > 0" class="space-y-3">
      <div
        v-for="t in filtered"
        :key="t.id"
        class="glass rounded-xl p-4"
      >
        <div class="flex flex-wrap items-start gap-3">
          <!-- Left: badge + info -->
          <div class="flex-1 min-w-0 space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <span :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', badgeConfig[t.type]?.classes]">
                {{ badgeConfig[t.type]?.emoji }} {{ t.type.toUpperCase() }}
              </span>
              <span class="font-semibold truncate">{{ t.name }}</span>
              <span class="text-xs text-muted font-mono">ID: {{ t.threadId }}</span>
            </div>

            <!-- Metadata row -->
            <div class="flex flex-wrap items-center gap-4 text-xs text-textSecondary">
              <span title="Created">Created {{ relativeTime(t.createdAt) }}</span>
              <span title="Archived">Archived {{ relativeTime(t.archivedAt ?? t.lastActiveAt) }}</span>
              <span v-if="t.client" class="text-muted">{{ t.client }}</span>
            </div>

            <!-- Summary -->
            <div v-if="summaries[t.threadId]" class="text-sm text-textSecondary mt-1 leading-relaxed">
              {{ summaries[t.threadId] }}
            </div>
            <div v-else-if="generatingIds[t.threadId]" class="text-sm text-muted mt-1 italic animate-pulse">
              Generating summary…
            </div>
          </div>

          <!-- Right: actions -->
          <div class="flex items-center gap-2 shrink-0">
            <button
              @click="unarchive(t)"
              :disabled="unarchivingId === t.threadId"
              class="px-2 py-1 rounded-lg text-xs bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition"
            >
              {{ unarchivingId === t.threadId ? 'Restoring…' : '↩ Unarchive' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
