<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const emit = defineEmits<{
  send: [text: string]
  'send-voice': [duration: number]
  'send-photo': [url: string, caption: string]
  'send-file': [file: { name: string; size: number; type: string }]
}>()

const text = ref('')
const recording = ref(false)
const recordTime = ref(0)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const photoInputRef = ref<HTMLInputElement | null>(null)
const showAttachMenu = ref(false)
let recordTimer: ReturnType<typeof setInterval> | null = null

function handleSend() {
  const t = text.value.trim()
  if (!t) return
  emit('send', t)
  text.value = ''
  nextTick(resizeTextarea)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function resizeTextarea() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

watch(text, () => nextTick(resizeTextarea))

function startRecording() {
  recording.value = true
  recordTime.value = 0
  recordTimer = setInterval(() => {
    recordTime.value++
  }, 1000)
}

function stopRecording() {
  if (!recording.value) return
  recording.value = false
  const duration = recordTime.value
  if (recordTimer) clearInterval(recordTimer)
  recordTimer = null
  if (duration > 0) {
    emit('send-voice', duration)
  }
}

function cancelRecording() {
  recording.value = false
  recordTime.value = 0
  if (recordTimer) clearInterval(recordTimer)
  recordTimer = null
}

function formatRecordTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function toggleAttachMenu() {
  showAttachMenu.value = !showAttachMenu.value
}

function triggerPhoto() {
  showAttachMenu.value = false
  photoInputRef.value?.click()
}

function triggerFile() {
  showAttachMenu.value = false
  fileInputRef.value?.click()
}

function onPhotoSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const url = URL.createObjectURL(file)
  emit('send-photo', url, '')
  input.value = ''
}

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  emit('send-file', { name: file.name, size: file.size, type: file.type })
  input.value = ''
}
</script>

<template>
  <div class="input-area">
    <!-- Hidden file inputs -->
    <input ref="photoInputRef" type="file" accept="image/*" hidden @change="onPhotoSelected" />
    <input ref="fileInputRef" type="file" hidden @change="onFileSelected" />

    <!-- Recording mode -->
    <div v-if="recording" class="recording-bar">
      <button class="cancel-btn" @click="cancelRecording">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="recording-indicator">
        <span class="rec-dot"></span>
        <span class="rec-time">{{ formatRecordTime(recordTime) }}</span>
        <span class="rec-label">Recording...</span>
      </div>
      <button class="send-btn active" @click="stopRecording">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      </button>
    </div>

    <!-- Normal input mode -->
    <div v-else class="input-row">
      <div class="attach-wrapper">
        <button class="icon-btn" @click="toggleAttachMenu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <!-- Attach menu -->
        <div v-if="showAttachMenu" class="attach-menu" @mouseleave="showAttachMenu = false">
          <button class="attach-option" @click="triggerPhoto">
            <div class="attach-icon photo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
              </svg>
            </div>
            <span>Photo</span>
          </button>
          <button class="attach-option" @click="triggerFile">
            <div class="attach-icon file">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
              </svg>
            </div>
            <span>File</span>
          </button>
        </div>
      </div>

      <div class="input-wrapper">
        <textarea
          ref="textareaRef"
          v-model="text"
          rows="1"
          placeholder="Message"
          @keydown="handleKeydown"
        ></textarea>
        <button class="emoji-btn">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2" stroke-linecap="round"/>
            <circle cx="9" cy="9.5" r="1.5" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="9.5" r="1.5" fill="currentColor" stroke="none"/>
          </svg>
        </button>
      </div>

      <button
        v-if="text.trim()"
        class="send-btn active"
        @click="handleSend"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      </button>
      <button
        v-else
        class="icon-btn mic-btn"
        @mousedown.prevent="startRecording"
        @mouseup.prevent="stopRecording"
        @touchstart.prevent="startRecording"
        @touchend.prevent="stopRecording"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="1" width="6" height="11" rx="3"/>
          <path d="M19 10v2a7 7 0 01-14 0v-2" stroke-linecap="round"/>
          <line x1="12" y1="19" x2="12" y2="23" stroke-linecap="round"/>
          <line x1="8" y1="23" x2="16" y2="23" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.input-area {
  background: #17212b;
  border-top: 1px solid #101921;
  padding: 5px 4px;
  padding-bottom: max(5px, env(safe-area-inset-bottom));
  flex-shrink: 0;
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 2px;
}

.icon-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: none;
  color: #6b7c8e;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.icon-btn:hover {
  color: #8b9baa;
}

.icon-btn:active {
  background: #232e3c;
  color: #8b9baa;
}

.mic-btn {
  color: #8b9baa;
}

.send-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: none;
  color: #6b7c8e;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.send-btn.active {
  color: #6ab3f3;
}

.send-btn.active:active {
  background: #232e3c;
}

.input-wrapper {
  flex: 1;
  display: flex;
  align-items: flex-end;
  background: #242f3d;
  border-radius: 20px;
  padding: 4px 6px 4px 16px;
  min-height: 44px;
}

.input-wrapper textarea {
  flex: 1;
  background: none;
  border: none;
  color: #e1e3e6;
  font-size: 15px;
  font-family: inherit;
  line-height: 1.35;
  resize: none;
  outline: none;
  padding: 8px 0;
  max-height: 120px;
  overflow-y: auto;
}

.input-wrapper textarea::placeholder {
  color: #6b7c8e;
}

.input-wrapper textarea::-webkit-scrollbar {
  width: 3px;
}

.input-wrapper textarea::-webkit-scrollbar-thumb {
  background: #3a4a5c;
  border-radius: 2px;
}

.emoji-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: none;
  color: #6b7c8e;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-bottom: 2px;
  transition: color 0.15s;
}

.emoji-btn:hover {
  color: #8b9baa;
}

/* Attach menu */
.attach-wrapper {
  position: relative;
}

.attach-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 8px;
  background: #232e3c;
  border-radius: 12px;
  padding: 6px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 160px;
  animation: fadeUp 0.15s ease-out;
  z-index: 20;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.attach-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: none;
  background: none;
  color: #e1e3e6;
  font-size: 14px;
  cursor: pointer;
  border-radius: 8px;
  transition: background 0.15s;
  width: 100%;
  text-align: left;
}

.attach-option:hover {
  background: #2b3845;
}

.attach-option:active {
  background: #344454;
}

.attach-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.attach-icon.photo {
  background: #7b68ee;
  color: white;
}

.attach-icon.file {
  background: #56b6c2;
  color: white;
}

/* Recording */
.recording-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
  height: 44px;
}

.cancel-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: none;
  color: #e06c75;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.cancel-btn:active {
  background: #2b2020;
}

.recording-indicator {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.rec-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e06c75;
  animation: blink 1s infinite;
  flex-shrink: 0;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

.rec-time {
  font-size: 15px;
  font-weight: 500;
  color: #e1e3e6;
  font-variant-numeric: tabular-nums;
}

.rec-label {
  font-size: 14px;
  color: #6b7c8e;
}
</style>
