<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../api'
import type { MemoryNote } from '../types'

const notes = ref<MemoryNote[]>([])
const loading = ref(false)
const typeFilter = ref('')
const sortBy = ref('created_at')
const searchQuery = ref('')
let searchDebounce: ReturnType<typeof setTimeout> | null = null

async function load() {
  loading.value = true
  try {
    const q = searchQuery.value.trim()
    let result: MemoryNote[]
    if (q) {
      result = await api<MemoryNote[]>(`/api/search?q=${encodeURIComponent(q)}&limit=50`)
    } else {
      const params = new URLSearchParams({ limit: '50', sort: sortBy.value })
      if (typeFilter.value) params.set('type', typeFilter.value)
      result = await api<MemoryNote[]>(`/api/notes?${params}`)
    }
    notes.value = result
  } finally {
    loading.value = false
  }
}

function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(load, 300)
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

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <div class="flex flex-wrap items-center gap-3 mb-4">
      <input
        v-model="searchQuery"
        @input="onSearchInput"
        type="text"
        placeholder="Search notes..."
        class="flex-1 min-w-[200px] px-4 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted focus:outline-none focus:border-accent transition"
      />
      <select
        v-model="typeFilter"
        @change="load"
        class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none"
      >
        <option value="">All types</option>
        <option value="fact">Facts</option>
        <option value="preference">Preferences</option>
        <option value="pattern">Patterns</option>
        <option value="entity">Entities</option>
        <option value="relationship">Relationships</option>
      </select>
      <select
        v-model="sortBy"
        @change="load"
        class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none"
      >
        <option value="created_at">Newest</option>
        <option value="confidence">Confidence</option>
        <option value="access_count">Most accessed</option>
      </select>
    </div>

    <div v-if="loading" class="text-center py-12 text-textSecondary">Loading notes...</div>

    <div v-else-if="notes.length === 0" class="text-center py-12 text-textSecondary">No notes found</div>

    <div v-else class="space-y-2">
      <div
        v-for="note in notes"
        :key="note.noteId"
        :class="['glass rounded-xl p-4 animate-fade-in', `priority-${note.priority || 0}`]"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span :class="['type-badge', `type-${note.type}`]">{{ note.type }}</span>
              <span v-if="note.priority >= 2" class="type-badge" style="background:rgba(239,68,68,0.15);color:#f87171">HIGH IMPORTANCE</span>
              <span v-else-if="note.priority === 1" class="type-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24">NOTABLE</span>
              <span class="text-xs text-textSecondary">{{ note.noteId }}</span>
            </div>
            <p class="text-sm text-textPrimary leading-relaxed">{{ note.content }}</p>
            <div class="flex flex-wrap gap-1.5 mt-2">
              <span
                v-for="kw in (note.keywords || [])"
                :key="kw"
                class="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accentLight"
              >{{ kw }}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-sm font-mono text-textSecondary">{{ ((Number(note.confidence) || 0) * 100).toFixed(0) }}%</div>
            <div class="text-xs text-muted">{{ timeAgo(note.createdAt) }}</div>
            <div class="text-xs text-muted">{{ note.accessCount ?? 0 }} hits</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
