<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { api, getToken } from '../api'

const loading = ref(true)
const saving = ref(false)
const saveStatus = ref('')

const bootstrapMessageCount = ref(50)
const savedCount = ref(50)
const waitTimeoutMinutes = ref(1440)
const savedTimeout = ref(1440)
const defaultThreadModel = ref('claude-opus-4-6')
const savedThreadModel = ref('claude-opus-4-6')
const defaultWorkerModel = ref('claude-sonnet-4-5')
const savedWorkerModel = ref('claude-sonnet-4-5')

const isDirty = computed(() =>
  bootstrapMessageCount.value !== savedCount.value ||
  waitTimeoutMinutes.value !== savedTimeout.value ||
  defaultThreadModel.value !== savedThreadModel.value ||
  defaultWorkerModel.value !== savedWorkerModel.value
)

async function load() {
  loading.value = true
  try {
    const [msgData, timeoutData, threadModelData, workerModelData] = await Promise.all([
      api<{ count: number }>('/api/settings/bootstrap-message-count'),
      api<{ minutes: number }>('/api/settings/wait-timeout'),
      api<{ defaultThreadModel: string }>('/api/settings/default-thread-model'),
      api<{ defaultWorkerModel: string }>('/api/settings/default-worker-model'),
    ])
    bootstrapMessageCount.value = msgData.count
    savedCount.value = msgData.count
    waitTimeoutMinutes.value = timeoutData.minutes
    savedTimeout.value = timeoutData.minutes
    defaultThreadModel.value = threadModelData.defaultThreadModel
    savedThreadModel.value = threadModelData.defaultThreadModel
    defaultWorkerModel.value = workerModelData.defaultWorkerModel
    savedWorkerModel.value = workerModelData.defaultWorkerModel
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  saveStatus.value = ''
  try {
    const headers = { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' }
    const [r1, r2, r3, r4] = await Promise.all([
      fetch('/api/settings/bootstrap-message-count', { method: 'POST', headers, body: JSON.stringify({ count: bootstrapMessageCount.value }) }),
      fetch('/api/settings/wait-timeout', { method: 'POST', headers, body: JSON.stringify({ minutes: waitTimeoutMinutes.value }) }),
      fetch('/api/settings/default-thread-model', { method: 'POST', headers, body: JSON.stringify({ model: defaultThreadModel.value }) }),
      fetch('/api/settings/default-worker-model', { method: 'POST', headers, body: JSON.stringify({ model: defaultWorkerModel.value }) }),
    ])
    for (const r of [r1, r2, r3, r4]) {
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
        throw new Error(err.error ?? r.statusText)
      }
    }
    const d1 = await r1.json() as { count: number }
    const d2 = await r2.json() as { minutes: number }
    const d3 = await r3.json() as { defaultThreadModel: string }
    const d4 = await r4.json() as { defaultWorkerModel: string }
    savedCount.value = d1.count
    bootstrapMessageCount.value = d1.count
    savedTimeout.value = d2.minutes
    waitTimeoutMinutes.value = d2.minutes
    savedThreadModel.value = d3.defaultThreadModel
    defaultThreadModel.value = d3.defaultThreadModel
    savedWorkerModel.value = d4.defaultWorkerModel
    defaultWorkerModel.value = d4.defaultWorkerModel
    saveStatus.value = 'Saved ✓'
    setTimeout(() => { saveStatus.value = '' }, 3000)
  } catch (e: unknown) {
    saveStatus.value = 'Error: ' + (e as Error).message
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <div class="glass rounded-xl p-6 mb-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h3 class="text-lg font-semibold">Settings</h3>
          <p class="text-sm text-textSecondary mt-1">Configure agent behavior and context injection</p>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saveStatus" :class="saveStatus.startsWith('Error') ? 'text-danger' : 'text-success'" class="text-sm">{{ saveStatus }}</span>
          <button
            @click="save"
            :disabled="saving || loading || !isDirty"
            class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-sm font-medium transition"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-center py-8 text-textSecondary text-sm">Loading…</div>

      <div v-else class="space-y-6">
        <!-- Bootstrap Message Count -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Recent Conversation Buffer</label>
          <p class="text-xs text-textSecondary mb-3">
            Number of recent messages injected into the agent's bootstrap context.
            Set to <span class="font-mono text-accentLight">0</span> to disable
            (useful when using VS Code, which maintains its own conversation history).
          </p>
          <div class="flex items-center gap-4">
            <input
              v-model.number="bootstrapMessageCount"
              type="range"
              min="0"
              max="100"
              step="5"
              class="flex-1 accent-accent"
            />
            <input
              v-model.number="bootstrapMessageCount"
              type="number"
              min="0"
              max="200"
              class="w-20 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono text-center focus:outline-none focus:border-accent transition"
            />
          </div>
          <div class="flex justify-between text-xs text-muted mt-2">
            <span>Off</span>
            <span class="font-mono">{{ bootstrapMessageCount }} messages</span>
            <span>Max</span>
          </div>
          <div v-if="bootstrapMessageCount === 0" class="mt-3 px-3 py-2 rounded-lg bg-warn/10 border border-warn/20 text-xs text-warn">
            Message buffer injection is <strong>disabled</strong>. The agent will not see recent conversation history in its bootstrap context. Use this when VS Code (or another IDE) already provides conversation history.
          </div>
        </div>

        <!-- Wait Timeout -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Poll Timeout (wait_for_instructions)</label>
          <p class="text-xs text-textSecondary mb-3">
            Maximum time (in minutes) a single <span class="font-mono text-accentLight">wait_for_instructions</span> call
            will poll before timing out. Claude Code agents use the full value; Copilot agents are capped at 10 min.
          </p>
          <div class="flex items-center gap-4">
            <input
              v-model.number="waitTimeoutMinutes"
              type="range"
              min="1"
              max="1440"
              step="10"
              class="flex-1 accent-accent"
            />
            <input
              v-model.number="waitTimeoutMinutes"
              type="number"
              min="1"
              max="10080"
              class="w-24 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono text-center focus:outline-none focus:border-accent transition"
            />
          </div>
          <div class="flex justify-between text-xs text-muted mt-2">
            <span>1 min</span>
            <span class="font-mono">{{ waitTimeoutMinutes >= 60 ? Math.floor(waitTimeoutMinutes / 60) + 'h ' + (waitTimeoutMinutes % 60) + 'm' : waitTimeoutMinutes + ' min' }}</span>
            <span>24h</span>
          </div>
        </div>

        <!-- Default Thread Model -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Default Thread Model</label>
          <p class="text-xs text-textSecondary mb-3">
            Model used when spawning a normal (orchestrator) Claude thread. Overridden by the
            <span class="font-mono text-accentLight">CLAUDE_MODEL</span> env var if set.
          </p>
          <input
            v-model="defaultThreadModel"
            type="text"
            placeholder="claude-opus-4-6"
            class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
          />
        </div>

        <!-- Default Worker Model -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Default Worker Model</label>
          <p class="text-xs text-textSecondary mb-3">
            Model used when spawning a worker Claude thread. Overridden by the
            <span class="font-mono text-accentLight">CLAUDE_WORKER_MODEL</span> env var if set.
          </p>
          <input
            v-model="defaultWorkerModel"
            type="text"
            placeholder="claude-sonnet-4-5"
            class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
          />
        </div>

        <!-- Current State -->
        <div class="glass rounded-xl p-4 border border-gray-700/30 bg-surface/30">
          <div class="text-xs font-medium text-textSecondary uppercase tracking-wider mb-3">Current State</div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <div class="text-xs text-muted mb-1">Message Buffer</div>
              <span :class="['text-sm font-medium', savedCount > 0 ? 'text-success' : 'text-textSecondary']">
                {{ savedCount > 0 ? `${savedCount} messages` : 'Disabled' }}
              </span>
            </div>
            <div>
              <div class="text-xs text-muted mb-1">Poll Timeout</div>
              <span class="text-sm font-medium text-textSecondary">
                {{ savedTimeout >= 60 ? Math.floor(savedTimeout / 60) + 'h ' + (savedTimeout % 60) + 'm' : savedTimeout + ' min' }}
              </span>
            </div>
            <div>
              <div class="text-xs text-muted mb-1">Thread Model</div>
              <span class="text-sm font-medium font-mono text-textSecondary">{{ savedThreadModel }}</span>
            </div>
            <div>
              <div class="text-xs text-muted mb-1">Worker Model</div>
              <span class="text-sm font-medium font-mono text-textSecondary">{{ savedWorkerModel }}</span>
            </div>
          </div>
          <div class="mt-3">
            <span :class="['text-sm font-medium', isDirty ? 'text-warn' : 'text-textSecondary']">
              {{ isDirty ? 'Unsaved changes' : 'Saved' }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
