<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, getToken } from '../api'
import type { Skill } from '../types'

const skills = ref<Skill[]>([])
const loading = ref(true)
const selectedSkill = ref<Skill | null>(null)
const editContent = ref('')
const editTriggers = ref('')
const editReplacesOrch = ref(false)
const saveStatus = ref('')
const deleteStatus = ref('')
const showNewForm = ref(false)
const newSkillName = ref('')
const newSkillTriggers = ref('')
const newSkillReplaces = ref(false)
const newSkillStatus = ref('')

async function load() {
  loading.value = true
  try {
    const data = await api<{ skills?: Skill[] }>('/api/skills')
    skills.value = data.skills || []
  } finally {
    loading.value = false
  }
}

function skillSourceType(source: string): string {
  if (!source) return 'unknown'
  if (source.includes('.remote-copilot-mcp') && source.includes('skills')) return 'user'
  if (source.endsWith('.default.md')) return 'default'
  if (source.endsWith('.skill.md')) return 'project'
  return 'unknown'
}

function sourceTypeBadgeStyle(type: string): string {
  const styles: Record<string, string> = {
    user: 'background:rgba(99,102,241,0.15);color:#818cf8',
    default: 'background:rgba(107,114,128,0.15);color:#9ca3af',
    project: 'background:rgba(34,197,94,0.15);color:#4ade80',
    unknown: 'background:rgba(107,114,128,0.15);color:#9ca3af',
  }
  return styles[type] || styles.unknown
}

function openEditor(skill: Skill) {
  selectedSkill.value = skill
  editContent.value = skill.content
  editTriggers.value = (skill.triggers || []).join(', ')
  editReplacesOrch.value = !!skill.replacesOrchestrator
  showNewForm.value = false
}

function closeEditor() {
  selectedSkill.value = null
  deleteStatus.value = ''
}

function buildSkillMarkdown(name: string, triggers: string[], replacesOrchestrator: boolean, body: string): string {
  let fm = `---\nname: ${name}\ntriggers:\n`
  triggers.forEach(t => { fm += `  - ${t.trim()}\n` })
  if (replacesOrchestrator) fm += 'replaces_orchestrator: true\n'
  fm += '---\n\n'
  return fm + body
}

async function saveSkill() {
  if (!selectedSkill.value) return
  const name = selectedSkill.value.name
  try {
    const triggers = editTriggers.value.split(',').map(t => t.trim()).filter(Boolean)
    const rawContent = editContent.value
    let content: string
    if (rawContent.trimStart().startsWith('---')) {
      content = rawContent
    } else {
      content = buildSkillMarkdown(name, triggers, editReplacesOrch.value, rawContent)
    }
    const r = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!r.ok) throw new Error(r.statusText)
    saveStatus.value = 'Saved ✓'
    setTimeout(() => { saveStatus.value = '' }, 3000)
    await load()
  } catch (e: unknown) {
    saveStatus.value = 'Error: ' + (e as Error).message
  }
}

async function deleteSkillOverride() {
  if (!selectedSkill.value) return
  const name = selectedSkill.value.name
  try {
    const r = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    closeEditor()
    await load()
  } catch (e: unknown) {
    deleteStatus.value = 'Error: ' + (e as Error).message
  }
}

async function createNewSkill() {
  const name = newSkillName.value.trim()
  const triggersRaw = newSkillTriggers.value
  if (!name) { newSkillStatus.value = 'Name is required'; return }
  const triggers = triggersRaw.split(',').map(t => t.trim()).filter(Boolean)
  if (!triggers.length) { newSkillStatus.value = 'At least one trigger is required'; return }
  const content = buildSkillMarkdown(name, triggers, newSkillReplaces.value, '<!-- Write your skill instructions here -->\n')
  try {
    const r = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!r.ok) throw new Error(r.statusText)
    newSkillStatus.value = 'Created ✓'
    showNewForm.value = false
    await load()
    const created = skills.value.find(s => s.name === name)
    if (created) openEditor(created)
  } catch (e: unknown) {
    newSkillStatus.value = 'Error: ' + (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="animate-fade-in">
    <div class="glass rounded-xl p-6 mb-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="text-lg font-semibold">Skill Library</h3>
          <p class="text-sm text-textSecondary mt-1">Manage intent-routing skills — user overrides, defaults, and project skills</p>
        </div>
        <button
          @click="showNewForm = !showNewForm; selectedSkill = null"
          class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition"
        >
          + New Skill
        </button>
      </div>

      <!-- New skill form -->
      <div v-if="showNewForm" class="glass rounded-xl p-4 mb-4 border border-accent/30">
        <h4 class="text-sm font-semibold mb-3">Create New Skill</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div>
            <label class="text-xs text-textSecondary block mb-1">Name</label>
            <input
              v-model="newSkillName"
              type="text"
              placeholder="my-skill"
              class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono focus:outline-none focus:border-accent transition"
            />
          </div>
          <div>
            <label class="text-xs text-textSecondary block mb-1">Triggers (comma-separated)</label>
            <input
              v-model="newSkillTriggers"
              type="text"
              placeholder="trigger1, trigger2"
              class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary focus:outline-none focus:border-accent transition"
            />
          </div>
        </div>
        <div class="flex items-center gap-4 mb-3">
          <label class="flex items-center gap-2 text-sm text-textSecondary cursor-pointer">
            <input v-model="newSkillReplaces" type="checkbox" class="rounded" />
            <span>Replaces orchestrator</span>
          </label>
        </div>
        <div class="flex items-center gap-2">
          <button @click="createNewSkill" class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition">Create</button>
          <button @click="showNewForm = false" class="px-4 py-2 rounded-xl bg-card hover:bg-cardHover border border-gray-700 text-sm text-textSecondary hover:text-textPrimary transition">Cancel</button>
          <span v-if="newSkillStatus" class="text-sm text-warn">{{ newSkillStatus }}</span>
        </div>
      </div>

      <!-- Skills list -->
      <div v-if="loading" class="text-center py-8 text-textSecondary text-sm">Loading...</div>
      <div v-else-if="skills.length === 0" class="text-center text-textSecondary py-12">No skills loaded</div>
      <div v-else class="space-y-2">
        <div
          v-for="skill in skills"
          :key="skill.name"
          @click="openEditor(skill)"
          :class="['glass rounded-xl p-4 cursor-pointer hover:bg-cardHover transition border', selectedSkill?.name === skill.name ? 'border-accent' : 'border-transparent']"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="font-medium text-sm">{{ skill.name }}</span>
                <span class="type-badge" :style="sourceTypeBadgeStyle(skillSourceType(skill.source))">{{ skillSourceType(skill.source) }}</span>
                <span v-if="skill.replacesOrchestrator" class="type-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24">REPLACES ORCH</span>
              </div>
              <div class="flex flex-wrap gap-1.5 mt-1">
                <span
                  v-for="t in (skill.triggers || [])"
                  :key="t"
                  class="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accentLight"
                >{{ t }}</span>
              </div>
            </div>
            <div class="text-xs text-muted font-mono shrink-0 max-w-[200px] truncate" :title="skill.source || ''">
              {{ (skill.source || '').split(/[\\/]/).pop() || '' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Skill editor -->
    <div v-if="selectedSkill" class="glass rounded-xl p-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="text-lg font-semibold">Edit: {{ selectedSkill.name }}</h3>
          <p class="text-sm text-textSecondary mt-1">{{ selectedSkill.source || '(unknown source)' }}</p>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="saveStatus" class="text-sm text-success">{{ saveStatus }}</span>
          <span v-if="deleteStatus" class="text-sm text-warn">{{ deleteStatus }}</span>
          <button
            v-if="skillSourceType(selectedSkill.source) === 'user'"
            @click="deleteSkillOverride"
            class="px-4 py-2 rounded-xl bg-card hover:bg-red-900/40 border border-gray-700 hover:border-red-700 text-sm text-textSecondary hover:text-red-400 transition"
            title="Remove user override (reverts to default)"
          >Remove override</button>
          <button @click="closeEditor" class="px-4 py-2 rounded-xl bg-card hover:bg-cardHover border border-gray-700 text-sm text-textSecondary hover:text-textPrimary transition">Close</button>
          <button @click="saveSkill" class="px-4 py-2 rounded-xl bg-accent hover:bg-accentLight text-white text-sm font-medium transition">Save</button>
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div>
          <label class="text-xs text-textSecondary block mb-1">Name</label>
          <input
            :value="selectedSkill.name"
            type="text"
            readonly
            class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary font-mono opacity-60 cursor-not-allowed"
          />
        </div>
        <div>
          <label class="text-xs text-textSecondary block mb-1">Triggers (comma-separated)</label>
          <input
            v-model="editTriggers"
            type="text"
            class="w-full px-3 py-2 rounded-lg bg-surface border border-gray-700 text-sm text-textPrimary focus:outline-none focus:border-accent transition"
          />
        </div>
        <div class="flex items-end">
          <label class="flex items-center gap-2 text-sm text-textSecondary cursor-pointer pb-2">
            <input v-model="editReplacesOrch" type="checkbox" class="rounded" />
            <span>Replaces orchestrator</span>
          </label>
        </div>
      </div>
      <textarea
        v-model="editContent"
        rows="20"
        spellcheck="false"
        class="w-full px-4 py-3 rounded-xl bg-surface border border-gray-700 text-textPrimary font-mono text-sm leading-relaxed focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition resize-y"
        placeholder="Skill body (markdown)..."
      ></textarea>
    </div>
  </div>
</template>
