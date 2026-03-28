<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, getToken } from '../api'
import type { KeepAliveSettings } from '../types'

const settings = ref<KeepAliveSettings | null>(null)
const loading = ref(true)
const saving = ref(false)
const saveStatus = ref('')

const form = ref<KeepAliveSettings>({
  keepAliveEnabled: false,
  keepAliveThreadId: 0,
  keepAliveMaxRetries: 5,
  keepAliveCooldownMs: 300000,
})

async function load() {
  loading.value = true
  try {
    settings.value = await api<KeepAliveSettings>('/api/settings/keep-alive')
    form.value = { ...settings.value }
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  saveStatus.value = ''
  try {
    const r = await fetch('/api/settings/keep-alive', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(form.value),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText })) as { error?: string }
      throw new Error(err.error ?? r.statusText)
    }
    settings.value = { ...form.value }
    saveStatus.value = 'Saved ✓'
    setTimeout(() => { saveStatus.value = '' }, 3000)
  } catch (e: unknown) {
    saveStatus.value = 'Error: ' + (e as Error).message
  } finally {
    saving.value = false
  }
}

function formatCooldown(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <div class="glass rounded-xl p-6 mb-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h3 class="text-lg font-semibold">Keep-Alive Settings</h3>
          <p class="text-sm text-textSecondary mt-1">Configure the headless agent auto-restart and monitoring behavior</p>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saveStatus" :class="saveStatus.startsWith('Error') ? 'text-danger' : 'text-success'" class="text-sm">{{ saveStatus }}</span>
          <button
            @click="save"
            :disabled="saving || loading"
            class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-sm font-medium transition"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-center py-8 text-textSecondary text-sm">Loading…</div>

      <div v-else class="space-y-6">
        <!-- Enable toggle -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium">Enable Keep-Alive</div>
              <div class="text-xs text-textSecondary mt-0.5">Automatically restart the agent when it goes offline</div>
            </div>
            <button
              @click="form.keepAliveEnabled = !form.keepAliveEnabled"
              :class="['relative inline-flex h-6 w-11 items-center rounded-full transition-colors', form.keepAliveEnabled ? 'bg-accent' : 'bg-gray-700']"
            >
              <span
                :class="['inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', form.keepAliveEnabled ? 'translate-x-6' : 'translate-x-1']"
              />
            </button>
          </div>
        </div>

        <!-- Thread ID -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Thread ID</label>
          <p class="text-xs text-textSecondary mb-3">The Telegram thread to monitor and keep alive</p>
          <input
            v-model.number="form.keepAliveThreadId"
            type="number"
            min="0"
            class="w-full sm:w-48 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
          />
          <p class="text-xs text-muted mt-2">0 = disabled</p>
        </div>

        <!-- Max Retries -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Max Retries</label>
          <p class="text-xs text-textSecondary mb-3">Number of restart attempts before entering cooldown mode</p>
          <input
            v-model.number="form.keepAliveMaxRetries"
            type="number"
            min="1"
            max="20"
            class="w-full sm:w-32 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
          />
        </div>

        <!-- Cooldown -->
        <div class="glass rounded-xl p-4 border border-gray-700/50">
          <label class="block text-sm font-medium mb-1">Cooldown Duration</label>
          <p class="text-xs text-textSecondary mb-3">
            Wait time after max retries exceeded before resuming restarts
            <span v-if="form.keepAliveCooldownMs" class="ml-1 text-accentLight font-mono">({{ formatCooldown(form.keepAliveCooldownMs) }})</span>
          </p>
          <div class="flex items-center gap-2">
            <input
              v-model.number="form.keepAliveCooldownMs"
              type="number"
              min="1000"
              step="60000"
              class="w-full sm:w-40 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
            <span class="text-xs text-textSecondary">ms</span>
          </div>
        </div>

        <!-- Status summary -->
        <div v-if="settings" class="glass rounded-xl p-4 border border-gray-700/30 bg-surface/30">
          <div class="text-xs font-medium text-textSecondary uppercase tracking-wider mb-3">Current State</div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div class="text-xs text-muted mb-1">Status</div>
              <span :class="['text-sm font-medium', settings.keepAliveEnabled ? 'text-success' : 'text-textSecondary']">
                {{ settings.keepAliveEnabled ? 'Enabled' : 'Disabled' }}
              </span>
            </div>
            <div>
              <div class="text-xs text-muted mb-1">Thread</div>
              <span class="text-sm font-mono">{{ settings.keepAliveThreadId || '—' }}</span>
            </div>
            <div>
              <div class="text-xs text-muted mb-1">Max Retries</div>
              <span class="text-sm font-mono">{{ settings.keepAliveMaxRetries }}</span>
            </div>
            <div>
              <div class="text-xs text-muted mb-1">Cooldown</div>
              <span class="text-sm font-mono">{{ formatCooldown(settings.keepAliveCooldownMs) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
