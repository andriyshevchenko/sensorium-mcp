<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, getToken } from '../api'
import type { McpServerConfig } from '../types'

const BUILTIN_NAME = 'sensorium-mcp'

const servers = ref<Record<string, McpServerConfig>>({})
const loading = ref(true)
const loadError = ref('')
const statusMsg = ref('')
const statusOk = ref(true)
const saving = ref(false)
const deleting = ref<string | null>(null)

// Form state
const showForm = ref(false)
const editingName = ref<string | null>(null)
const formName = ref('')
const formType = ref<'stdio' | 'http'>('stdio')
const formCommand = ref('')
const formArgs = ref('')
const formUrl = ref('')
const formEnv = ref<{ k: string; v: string }[]>([])
const formHeaders = ref<{ k: string; v: string }[]>([])
const formError = ref('')

// Exclude built-in from the editable list to avoid hidden DOM buttons
const userServers = computed(() =>
  Object.entries(servers.value).filter(([name]) => name !== BUILTIN_NAME)
)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await api<{ servers: Record<string, McpServerConfig> }>('/api/mcp-servers')
    servers.value = data.servers || {}
  } catch (e: unknown) {
    loadError.value = 'Failed to load MCP servers: ' + (e as Error).message
  } finally {
    loading.value = false
  }
}

function typeBadgeStyle(type: 'stdio' | 'http') {
  return type === 'stdio'
    ? 'background:rgba(99,102,241,0.15);color:#818cf8'
    : 'background:rgba(34,197,94,0.15);color:#4ade80'
}

function openAdd() {
  editingName.value = null
  formName.value = ''
  formType.value = 'stdio'
  formCommand.value = ''
  formArgs.value = ''
  formUrl.value = ''
  formEnv.value = []
  formHeaders.value = []
  formError.value = ''
  showForm.value = true
}

function openEdit(name: string, cfg: McpServerConfig) {
  editingName.value = name
  formName.value = name
  formType.value = cfg.type
  formCommand.value = cfg.command || ''
  formArgs.value = (cfg.args || []).join(' ')
  formUrl.value = cfg.url || ''
  formEnv.value = Object.entries(cfg.env || {}).map(([k, v]) => ({ k, v }))
  formHeaders.value = Object.entries(cfg.headers || {}).map(([k, v]) => ({ k, v }))
  formError.value = ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingName.value = null
}

function validate(): boolean {
  formError.value = ''
  if (!formName.value.trim()) { formError.value = 'Name is required'; return false }
  if (formType.value === 'stdio' && !formCommand.value.trim()) { formError.value = 'Command is required for stdio type'; return false }
  if (formType.value === 'http') {
    const url = formUrl.value.trim()
    if (!url) { formError.value = 'URL is required for http type'; return false }
    if (!/^https?:\/\/.+/.test(url)) { formError.value = 'URL must start with http:// or https://'; return false }
  }
  return true
}

async function saveServer() {
  if (!validate() || saving.value) return
  saving.value = true
  const name = formName.value.trim()
  const config: McpServerConfig = { type: formType.value }
  if (formType.value === 'stdio') {
    config.command = formCommand.value.trim()
    const argsStr = formArgs.value.trim()
    if (argsStr) config.args = argsStr.split(/\s+/)
    const env = Object.fromEntries(formEnv.value.filter(e => e.k.trim()).map(e => [e.k.trim(), e.v]))
    if (Object.keys(env).length) config.env = env
  } else {
    config.url = formUrl.value.trim()
    const headers = Object.fromEntries(formHeaders.value.filter(h => h.k.trim()).map(h => [h.k.trim(), h.v]))
    if (Object.keys(headers).length) config.headers = headers
  }
  try {
    const r = await fetch('/api/mcp-servers', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config }),
    })
    if (!r.ok) throw new Error(r.statusText)
    statusMsg.value = 'Saved ✓'
    statusOk.value = true
    setTimeout(() => { statusMsg.value = '' }, 3000)
    closeForm()
    await load()
  } catch (e: unknown) {
    formError.value = 'Error: ' + (e as Error).message
  } finally {
    saving.value = false
  }
}

async function deleteServer(name: string) {
  if (!confirm(`Delete MCP server "${name}"?`)) return
  if (deleting.value) return
  deleting.value = name
  try {
    const r = await fetch(`/api/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    statusMsg.value = 'Deleted ✓'
    statusOk.value = true
    setTimeout(() => { statusMsg.value = '' }, 3000)
    await load()
  } catch (e: unknown) {
    statusMsg.value = 'Error: ' + (e as Error).message
    statusOk.value = false
  } finally {
    deleting.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <!-- Server List -->
    <div class="glass rounded-xl p-6 mb-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="text-lg font-semibold">MCP Servers</h3>
          <p class="text-sm text-textSecondary mt-1">Manage external MCP server connections (stdio and HTTP)</p>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="statusMsg" :class="['text-sm', statusOk ? 'text-success' : 'text-danger']">{{ statusMsg }}</span>
          <button
            @click="openAdd"
            class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition"
          >
            + Add Server
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-center py-8 text-textSecondary text-sm">Loading...</div>
      <div v-else-if="loadError" class="text-center py-8 text-danger text-sm">{{ loadError }}</div>
      <div v-else-if="Object.keys(servers).length === 0" class="text-center text-textSecondary py-12">No MCP servers configured</div>
      <div v-else class="space-y-2">
        <!-- Built-in sensorium-mcp entry -->
        <div v-if="servers[BUILTIN_NAME]" class="glass rounded-xl p-4 border border-gray-700/50 opacity-75">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-medium text-sm font-mono">{{ BUILTIN_NAME }}</span>
              <span class="type-badge" :style="typeBadgeStyle(servers[BUILTIN_NAME].type)">{{ servers[BUILTIN_NAME].type }}</span>
              <span class="type-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24">built-in</span>
            </div>
            <span class="text-xs text-muted italic">read-only</span>
          </div>
        </div>

        <!-- User-configured servers -->
        <div
          v-for="([name, cfg]) in userServers"
          :key="name"
          class="glass rounded-xl p-4 border border-transparent hover:border-gray-700 transition"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="font-medium text-sm font-mono">{{ name }}</span>
                <span class="type-badge" :style="typeBadgeStyle(cfg.type)">{{ cfg.type }}</span>
              </div>
              <div class="text-xs text-muted font-mono truncate">
                <template v-if="cfg.type === 'stdio'">{{ cfg.command }}{{ cfg.args?.length ? ' ' + cfg.args.join(' ') : '' }}</template>
                <template v-else>{{ cfg.url }}</template>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                @click="openEdit(name, cfg)"
                class="px-3 py-1.5 rounded-lg bg-card hover:bg-cardHover border border-gray-700 text-xs text-textSecondary hover:text-textPrimary transition"
              >Edit</button>
              <button
                @click="deleteServer(name)"
                :disabled="deleting === name"
                class="px-3 py-1.5 rounded-lg bg-card hover:bg-red-900/40 border border-gray-700 hover:border-red-700 text-xs text-textSecondary hover:text-red-400 transition disabled:opacity-50"
              >{{ deleting === name ? '…' : 'Delete' }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Add / Edit Form -->
    <div v-if="showForm" class="glass rounded-xl p-6 border border-accent/30">
      <h3 class="text-lg font-semibold mb-4">{{ editingName ? `Edit: ${editingName}` : 'Add MCP Server' }}</h3>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <!-- Name -->
        <div>
          <label class="text-xs text-textSecondary block mb-1">Name <span class="text-danger">*</span></label>
          <input
            v-model="formName"
            type="text"
            :readonly="!!editingName"
            placeholder="my-server"
            :class="['w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition', editingName ? 'opacity-60 cursor-not-allowed' : '']"
          />
        </div>
        <!-- Type -->
        <div>
          <label class="text-xs text-textSecondary block mb-1">Type <span class="text-danger">*</span></label>
          <select
            v-model="formType"
            class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary focus:outline-none focus:border-accent transition"
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </div>
      </div>

      <!-- stdio fields -->
      <template v-if="formType === 'stdio'">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label class="text-xs text-textSecondary block mb-1">Command <span class="text-danger">*</span></label>
            <input
              v-model="formCommand"
              type="text"
              placeholder="node"
              class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
          </div>
          <div>
            <label class="text-xs text-textSecondary block mb-1">Args (space-separated)</label>
            <input
              v-model="formArgs"
              type="text"
              placeholder="./server.js --port 3000"
              class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
          </div>
        </div>
        <!-- Env vars -->
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs text-textSecondary">Environment Variables</label>
            <button @click="formEnv.push({ k: '', v: '' })" class="text-xs text-accent hover:text-accentLight transition">+ Add</button>
          </div>
          <div v-for="(entry, i) in formEnv" :key="i" class="flex items-center gap-2 mb-2">
            <input
              v-model="entry.k"
              type="text"
              placeholder="KEY"
              class="flex-1 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
            <span class="text-muted text-xs">=</span>
            <input
              v-model="entry.v"
              type="text"
              placeholder="value"
              class="flex-1 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
            <button @click="formEnv.splice(i, 1)" class="text-muted hover:text-danger transition text-xs px-2">✕</button>
          </div>
          <div v-if="formEnv.length === 0" class="text-xs text-muted italic">No env vars</div>
        </div>
      </template>

      <!-- http fields -->
      <template v-else>
        <div class="mb-4">
          <label class="text-xs text-textSecondary block mb-1">URL <span class="text-danger">*</span></label>
          <input
            v-model="formUrl"
            type="text"
            placeholder="http://localhost:3000/mcp"
            class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
          />
        </div>
        <!-- Headers -->
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs text-textSecondary">Headers</label>
            <button @click="formHeaders.push({ k: '', v: '' })" class="text-xs text-accent hover:text-accentLight transition">+ Add</button>
          </div>
          <div v-for="(entry, i) in formHeaders" :key="i" class="flex items-center gap-2 mb-2">
            <input
              v-model="entry.k"
              type="text"
              placeholder="Header-Name"
              class="flex-1 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
            <span class="text-muted text-xs">:</span>
            <input
              v-model="entry.v"
              type="text"
              placeholder="value"
              class="flex-1 px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
            <button @click="formHeaders.splice(i, 1)" class="text-muted hover:text-danger transition text-xs px-2">✕</button>
          </div>
          <div v-if="formHeaders.length === 0" class="text-xs text-muted italic">No headers</div>
        </div>
      </template>

      <!-- Error + Actions -->
      <div class="flex items-center gap-3 flex-wrap">
        <button
          @click="saveServer"
          :disabled="saving"
          class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight disabled:opacity-50 text-white text-sm font-medium transition"
        >
          {{ saving ? 'Saving…' : editingName ? 'Save Changes' : 'Add Server' }}
        </button>
        <button @click="closeForm" class="px-4 py-2 rounded-xl bg-card hover:bg-cardHover border border-gray-700 text-sm text-textSecondary hover:text-textPrimary transition">
          Cancel
        </button>
        <span v-if="formError" class="text-sm text-danger">{{ formError }}</span>
      </div>
    </div>
  </div>
</template>
