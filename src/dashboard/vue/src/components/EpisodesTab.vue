<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api'
import type { Episode } from '../types'

const episodes = ref<Episode[]>([])
const loading = ref(false)
const threadFilter = ref('')
const loaded = ref(false)

const modalityIcons: Record<string, string> = {
  text: '💬', voice: '🎤', image: '🖼️', file: '📎', system: '⚙️'
}

async function load() {
  loading.value = true
  try {
    let url = '/api/episodes?limit=30'
    if (threadFilter.value) url += `&threadId=${threadFilter.value}`
    episodes.value = await api<Episode[]>(url)
    loaded.value = true
  } finally {
    loading.value = false
  }
}

function timeAgo(iso: string): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatContent(content: string): string {
  if (!content) return '(no content)'
  if (typeof content === 'object') return JSON.stringify(content).slice(0, 300)
  return String(content).slice(0, 300)
}
</script>

<template>
  <div class="animate-fade-in">
    <div class="flex items-center gap-3 mb-4">
      <input
        v-model="threadFilter"
        type="number"
        placeholder="Thread ID (optional)"
        class="w-48 px-4 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
      />
      <button
        @click="load"
        :disabled="loading"
        class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-sm font-medium transition"
      >
        {{ loading ? 'Loading...' : 'Load' }}
      </button>
    </div>

    <div v-if="!loaded" class="text-center py-12 text-textSecondary text-sm">Click "Load" to fetch episodes</div>
    <div v-else-if="episodes.length === 0" class="text-center py-12 text-textSecondary">No episodes</div>

    <div v-else class="space-y-2">
      <div
        v-for="ep in episodes"
        :key="ep.episodeId"
        class="glass rounded-xl p-4 animate-fade-in"
      >
        <div class="flex items-start gap-3">
          <span class="text-lg">{{ modalityIcons[ep.modality] || '📝' }}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="type-badge type-fact">{{ ep.type || 'unknown' }}</span>
              <span class="text-xs text-textSecondary font-mono">{{ ep.episodeId || '-' }}</span>
              <span class="text-xs text-muted">{{ timeAgo(ep.createdAt) }}</span>
            </div>
            <p class="text-sm text-textSecondary leading-relaxed break-words">{{ formatContent(ep.content) }}</p>
          </div>
          <div class="text-xs text-muted shrink-0">imp: {{ ((Number(ep.importance) || 0) * 100).toFixed(0) }}%</div>
        </div>
      </div>
    </div>
  </div>
</template>
