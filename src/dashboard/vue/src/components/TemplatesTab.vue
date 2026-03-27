<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api, getToken } from '../api'
import type { DrivePreset } from '../types'

function highlightVars(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{\{([A-Z_]+)\}\}/g, '<span class="text-accentLight" style="background:rgba(99,102,241,0.1);padding:0 2px;border-radius:3px">{{$1}}</span>')
}

// Agent type
const agentType = ref('copilot')
const agentTypeStatus = ref('')

// Claude MCP config
const claudeConfigPath = ref('')
const claudeConfigStatus = ref('')

// Bootstrap message count
const bootstrapMsgCount = ref(50)
const bootstrapMsgStatus = ref('')

// Reminders template
const remindersContent = ref('')
const remindersIsDefault = ref(true)
const remindersStatus = ref('')
const tplPreviewOpen = ref(false)

// Drive template
const driveContent = ref('')
const driveIsDefault = ref(true)
const driveStatus = ref('')
const driveTplPreviewOpen = ref(false)
const drivePresets = ref<DrivePreset[]>([])
const dmnHours = ref<string>('')

async function loadAll() {
  await Promise.all([
    loadAgentType(),
    loadClaudeMcpConfig(),
    loadBootstrapMsgCount(),
    loadTemplates(),
    loadDriveTemplate(),
  ])
}

async function loadAgentType() {
  try {
    const r = await api<{ agentType: string }>('/api/settings/agent-type')
    agentType.value = r.agentType || 'copilot'
  } catch {}
}

async function loadClaudeMcpConfig() {
  try {
    const r = await api<{ path: string }>('/api/settings/claude-mcp-config')
    claudeConfigPath.value = r.path || ''
  } catch {}
}

async function loadBootstrapMsgCount() {
  try {
    const r = await api<{ count: number }>('/api/settings/bootstrap-message-count')
    bootstrapMsgCount.value = r.count ?? 50
  } catch {}
}

async function loadTemplates() {
  try {
    const data = await api<{ templates?: Array<{ content: string; isDefault: boolean }> }>('/api/templates')
    if (data.templates && data.templates.length > 0) {
      const tpl = data.templates[0]
      remindersContent.value = tpl.content || ''
      remindersIsDefault.value = tpl.isDefault ?? true
    }
  } catch {}
}

async function loadDriveTemplate() {
  try {
    const [driveData, presetsData, settingsData] = await Promise.all([
      api<{ custom?: string; default?: string }>('/api/templates/drive'),
      api<{ presets?: DrivePreset[] }>('/api/templates/drive-presets'),
      api<{ value?: string | number }>('/api/settings/dmn-activation-hours'),
    ])
    drivePresets.value = presetsData.presets || []
    dmnHours.value = String(settingsData.value ?? 'not set')
    if (driveData.custom) {
      driveContent.value = driveData.custom
      driveIsDefault.value = false
    } else {
      driveContent.value = driveData.default || ''
      driveIsDefault.value = true
    }
  } catch {}
}

async function changeAgentType() {
  try {
    await api('/api/settings/agent-type', {
      method: 'POST',
      body: JSON.stringify({ agentType: agentType.value }),
    })
    // Reset custom template so the new agent-type default loads
    await api('/api/templates/reminders', { method: 'DELETE' })
    agentTypeStatus.value = 'Saved ✓'
    setTimeout(() => { agentTypeStatus.value = '' }, 3000)
    await loadTemplates()
  } catch (e: unknown) {
    agentTypeStatus.value = 'Error: ' + (e as Error).message
  }
}

async function saveBootstrapMsgCount() {
  try {
    await api('/api/settings/bootstrap-message-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: bootstrapMsgCount.value }),
    })
    bootstrapMsgStatus.value = 'Saved ✓'
    setTimeout(() => { bootstrapMsgStatus.value = '' }, 3000)
  } catch (e) {
    bootstrapMsgStatus.value = 'Error: ' + (e as Error).message
  }
}

async function saveClaudeConfig() {
  const val = claudeConfigPath.value.trim()
  if (!val) { claudeConfigStatus.value = 'Path is empty'; setTimeout(() => { claudeConfigStatus.value = '' }, 3000); return }
  try {
    await api('/api/settings/claude-mcp-config', {
      method: 'POST',
      body: JSON.stringify({ path: val }),
    })
    claudeConfigStatus.value = 'Saved ✓'
    setTimeout(() => { claudeConfigStatus.value = '' }, 3000)
  } catch (e: unknown) {
    claudeConfigStatus.value = 'Error: ' + (e as Error).message
  }
}

async function saveReminders() {
  try {
    const r = await fetch('/api/templates/reminders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: remindersContent.value }),
    })
    if (!r.ok) throw new Error(r.statusText)
    remindersIsDefault.value = false
    remindersStatus.value = 'Saved ✓'
    setTimeout(() => { remindersStatus.value = '' }, 3000)
  } catch (e: unknown) {
    remindersStatus.value = 'Error: ' + (e as Error).message
  }
}

async function resetReminders() {
  if (!confirm('Reset to default template? Your customizations will be lost.')) return
  try {
    const r = await fetch('/api/templates/reminders', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    await loadTemplates()
    remindersStatus.value = 'Reset to default ✓'
    setTimeout(() => { remindersStatus.value = '' }, 3000)
  } catch (e: unknown) {
    remindersStatus.value = 'Error: ' + (e as Error).message
  }
}

async function saveDrive() {
  const content = driveContent.value
  if (!content.trim()) {
    driveStatus.value = 'Template is empty — load a preset first'
    setTimeout(() => { driveStatus.value = '' }, 3000)
    return
  }
  try {
    const r = await fetch('/api/templates/drive', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!r.ok) throw new Error(r.statusText)
    driveIsDefault.value = false
    driveStatus.value = 'Saved ✓'
    setTimeout(() => { driveStatus.value = '' }, 3000)
  } catch (e: unknown) {
    driveStatus.value = 'Error: ' + (e as Error).message
  }
}

async function resetDrive() {
  if (!confirm('Reset drive template? The custom template will be removed.')) return
  try {
    const r = await fetch('/api/templates/drive', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    await loadDriveTemplate()
    driveStatus.value = 'Reset to default ✓'
    setTimeout(() => { driveStatus.value = '' }, 3000)
  } catch (e: unknown) {
    driveStatus.value = 'Error: ' + (e as Error).message
  }
}

function applyPreset(preset: DrivePreset) {
  driveContent.value = preset.content
  driveIsDefault.value = false
}

const remindersPreviewHtml = computed(() => highlightVars(remindersContent.value))
const drivePreviewHtml = computed(() => driveContent.value ? highlightVars(driveContent.value) : '<span style="color:#6b7280">(no template loaded)</span>')

onMounted(loadAll)
</script>

<template>
  <div class="animate-fade-in space-y-6">
    <!-- Settings -->
    <div class="glass rounded-xl p-4">
      <div class="flex flex-wrap items-center gap-4 mb-4">
        <label class="text-sm font-medium text-textSecondary">Agent Type</label>
        <select
          v-model="agentType"
          @change="changeAgentType"
          class="px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary focus:outline-none focus:border-accent transition"
        >
          <option value="copilot">Copilot</option>
          <option value="claude">Claude</option>
          <option value="cursor">Cursor</option>
        </select>
        <span v-if="agentTypeStatus" class="text-sm text-success">{{ agentTypeStatus }}</span>
        <span class="text-xs text-muted">Changes which default reminders template is used</span>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <label class="text-sm font-medium text-textSecondary">Claude MCP Config Path</label>
        <input
          v-model="claudeConfigPath"
          type="text"
          placeholder="~/.claude/settings.json"
          class="flex-1 min-w-[260px] px-3 py-2 rounded-xl bg-card border border-gray-700 text-sm text-textPrimary placeholder-muted font-mono focus:outline-none focus:border-accent transition"
        />
        <button @click="saveClaudeConfig" class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition">Save</button>
        <span v-if="claudeConfigStatus" class="text-sm text-success">{{ claudeConfigStatus }}</span>
      </div>
      <!-- Bootstrap Message Count -->
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <label class="text-sm font-medium text-textSecondary">Bootstrap Messages</label>
        <input v-model.number="bootstrapMsgCount" type="number" min="0" max="500"
          class="w-24 px-3 py-2 rounded-xl bg-card border border-gray-700 text-text text-sm focus:border-accent focus:outline-none"/>
        <button @click="saveBootstrapMsgCount" class="px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent/80 transition-colors">Save</button>
        <span v-if="bootstrapMsgStatus" class="text-sm text-success">{{ bootstrapMsgStatus }}</span>
        <span class="text-xs text-muted">Number of recent messages injected as warm context (0 = off)</span>
      </div>
    </div>

    <!-- Reminders Template -->
    <div class="glass rounded-xl p-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="text-lg font-semibold">Reminders Template</h3>
          <p class="text-sm text-textSecondary mt-1">Edit the system prompt template sent with every reminder</p>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="remindersStatus" class="text-sm text-success">{{ remindersStatus }}</span>
          <button @click="resetReminders" class="px-4 py-2 rounded-xl bg-card hover:bg-cardHover border border-gray-700 text-sm text-textSecondary hover:text-textPrimary transition">Reset to Default</button>
          <button @click="saveReminders" class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition">Save</button>
        </div>
      </div>
      <div v-if="remindersIsDefault" class="mb-3">
        <span class="type-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24">USING DEFAULT — edit and save to customize</span>
      </div>
      <textarea
        v-model="remindersContent"
        rows="20"
        spellcheck="false"
        class="w-full px-4 py-3 rounded-xl bg-surface border border-gray-700 text-textPrimary font-mono text-sm leading-relaxed focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition resize-y"
        placeholder="Loading..."
      ></textarea>
      <div class="mt-4">
        <div
          class="flex items-center gap-2 mb-2 cursor-pointer select-none"
          @click="tplPreviewOpen = !tplPreviewOpen"
        >
          <svg :class="['w-4 h-4 text-textSecondary transition-transform', tplPreviewOpen ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
          <span class="text-sm font-medium text-textSecondary">Preview with highlighted variables</span>
        </div>
        <div
          v-if="tplPreviewOpen"
          class="glass rounded-xl p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words"
          v-html="remindersPreviewHtml"
        ></div>
      </div>
      <details class="mt-4">
        <summary class="text-sm font-medium text-textSecondary cursor-pointer hover:text-textPrimary transition">Available Variables</summary>
        <div class="mt-2 glass rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm" v-pre>
          <div><code class="text-accentLight">{{OPERATOR_MESSAGE}}</code> <span class="text-textSecondary">— latest operator message</span></div>
          <div><code class="text-accentLight">{{THREAD_ID}}</code> <span class="text-textSecondary">— Telegram thread ID</span></div>
          <div><code class="text-accentLight">{{TIME}}</code> <span class="text-textSecondary">— formatted timestamp</span></div>
          <div><code class="text-accentLight">{{UPTIME}}</code> <span class="text-textSecondary">— session uptime</span></div>
          <div><code class="text-accentLight">{{VERSION}}</code> <span class="text-textSecondary">— package version</span></div>
          <div><code class="text-accentLight">{{MODE}}</code> <span class="text-textSecondary">— "autonomous" or "standard"</span></div>
        </div>
      </details>
    </div>

    <!-- Drive Framing Template -->
    <div class="glass rounded-xl p-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="text-lg font-semibold">Drive Framing Template</h3>
          <p class="text-sm text-textSecondary mt-1">Customize the autonomous drive prompt sent when the operator is away</p>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="driveStatus" class="text-sm text-success">{{ driveStatus }}</span>
          <button @click="resetDrive" class="px-4 py-2 rounded-xl bg-card hover:bg-cardHover border border-gray-700 text-sm text-textSecondary hover:text-textPrimary transition">Reset to Default</button>
          <button @click="saveDrive" class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition">Save</button>
        </div>
      </div>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <label class="text-sm text-textSecondary">Drive Activation Period:</label>
        <div class="flex items-center gap-2">
          <span class="font-mono text-sm text-textPrimary">{{ dmnHours }}</span>
          <span class="text-sm text-textSecondary">hours</span>
        </div>
        <span class="text-xs text-muted">(informational — set via DMN_ACTIVATION_HOURS env var)</span>
      </div>
      <div v-if="driveIsDefault" class="mb-3">
        <span class="type-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24">(Default — edit to override)</span>
      </div>
      <div class="flex flex-wrap gap-2 mb-3">
        <span class="text-sm text-textSecondary self-center">Presets:</span>
        <button
          v-for="preset in drivePresets"
          :key="preset.key"
          @click="applyPreset(preset)"
          class="px-3 py-1.5 rounded-lg bg-card hover:bg-cardHover border border-gray-700 text-xs text-textSecondary hover:text-textPrimary transition"
        >{{ preset.label }}</button>
      </div>
      <textarea
        v-model="driveContent"
        rows="15"
        spellcheck="false"
        class="w-full px-4 py-3 rounded-xl bg-surface border border-gray-700 text-textPrimary font-mono text-sm leading-relaxed focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition resize-y"
        placeholder="Load a preset or type a custom drive template..."
      ></textarea>
      <div class="mt-4">
        <div
          class="flex items-center gap-2 mb-2 cursor-pointer select-none"
          @click="driveTplPreviewOpen = !driveTplPreviewOpen"
        >
          <svg :class="['w-4 h-4 text-textSecondary transition-transform', driveTplPreviewOpen ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
          <span class="text-sm font-medium text-textSecondary">Preview with sample values</span>
        </div>
        <div
          v-if="driveTplPreviewOpen"
          class="glass rounded-xl p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words"
          v-html="drivePreviewHtml"
        ></div>
      </div>
      <details class="mt-4">
        <summary class="text-sm font-medium text-textSecondary cursor-pointer hover:text-textPrimary transition">Available Variables</summary>
        <div class="mt-2 glass rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm" v-pre>
          <div><code class="text-accentLight">{{IDLE_HOURS}}</code> <span class="text-textSecondary">— hours since last operator interaction</span></div>
          <div><code class="text-accentLight">{{TIME}}</code> <span class="text-textSecondary">— ISO timestamp</span></div>
          <div><code class="text-accentLight">{{PROBABILITY}}</code> <span class="text-textSecondary">— drive activation probability (0.2–1.0)</span></div>
        </div>
      </details>
    </div>
  </div>
</template>
