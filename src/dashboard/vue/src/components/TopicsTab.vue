<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../api'
import type { Topic } from '../types'

const topics = ref<Topic[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    topics.value = await api<Topic[]>('/api/topics')
  } finally {
    loading.value = false
  }
}

function topicCount(t: Topic): number {
  return (t.semanticCount || 0) + (t.proceduralCount || 0)
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

const sortedTopics = () => {
  return topics.value.slice().sort((a, b) => topicCount(b) - topicCount(a))
}

const maxCount = () => {
  const counts = topics.value.map(t => topicCount(t))
  return Math.max(...counts, 1)
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <div v-if="loading" class="text-center py-12 text-textSecondary">Loading topics...</div>

    <div v-else-if="topics.length === 0" class="text-center py-12 text-textSecondary">No topics yet</div>

    <div v-else class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      <div
        v-for="t in sortedTopics()"
        :key="t.topic"
        class="glass rounded-xl p-4 animate-slide-up"
        :style="{ borderLeft: `3px solid rgba(99,102,241,${Math.max(0.15, topicCount(t) / maxCount())})` }"
      >
        <div class="font-medium text-sm">{{ t.topic || 'Unknown' }}</div>
        <div class="flex items-center justify-between mt-2">
          <span class="text-lg font-bold font-mono text-accent">{{ topicCount(t) }}</span>
          <span class="text-xs text-muted">{{ timeAgo(t.lastUpdated) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
