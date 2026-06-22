<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Message } from '../types'
import { renderMarkdown } from '../markdown'

const props = defineProps<{
  message: Message
}>()

const emit = defineEmits<{
  react: [messageId: string, emoji: string]
  reply: [message: Message]
  pin: [messageId: string]
  edit: [messageId: string]
  delete: [messageId: string]
}>()

const showReactionPicker = ref(false)
const showContextMenu = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })
const reactionEmojis = ['👍', '❤️', '🔥', '👀', '😂', '🎉', '🤔', '👎']

const renderedText = computed(() => renderMarkdown(props.message.text))

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function getWaveHeights(id: string): number[] {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i)
    hash |= 0
  }
  const heights: number[] = []
  for (let i = 0; i < 28; i++) {
    hash = ((hash << 5) - hash) + i
    hash |= 0
    heights.push(4 + Math.abs(hash % 20))
  }
  return heights
}

function toggleReactionPicker() {
  showReactionPicker.value = !showReactionPicker.value
  showContextMenu.value = false
}

function addReaction(emoji: string) {
  showReactionPicker.value = false
  emit('react', props.message.id, emoji)
}

function getFileIcon(type: string): string {
  if (type.startsWith('image/')) return 'img'
  if (type.includes('pdf')) return 'pdf'
  if (type.includes('zip') || type.includes('rar') || type.includes('tar')) return 'zip'
  if (type.includes('text') || type.includes('json') || type.includes('xml')) return 'txt'
  return 'file'
}

function onContextMenu(e: MouseEvent | TouchEvent) {
  e.preventDefault()
  showContextMenu.value = true
  showReactionPicker.value = false
  if ('touches' in e) {
    const touch = e.touches[0]
    contextMenuPos.value = { x: touch.clientX, y: touch.clientY }
  } else {
    contextMenuPos.value = { x: e.clientX, y: e.clientY }
  }
}

function closeContextMenu() {
  showContextMenu.value = false
}

function contextAction(action: string) {
  showContextMenu.value = false
  switch (action) {
    case 'reply': emit('reply', props.message); break
    case 'pin': emit('pin', props.message.id); break
    case 'edit': emit('edit', props.message.id); break
    case 'delete': emit('delete', props.message.id); break
    case 'react': toggleReactionPicker(); break
  }
}

let longPressTimer: ReturnType<typeof setTimeout> | null = null

function onTouchStart(e: TouchEvent) {
  longPressTimer = setTimeout(() => {
    onContextMenu(e)
  }, 500)
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}
</script>

<template>
  <div
    v-if="message.pinned"
    class="pin-indicator"
    :class="message.sender"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z"/></svg>
    <span>Pinned message</span>
  </div>

  <div
    class="message-row"
    :class="message.sender"
    @contextmenu="onContextMenu"
    @dblclick="toggleReactionPicker"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
    @touchmove.passive="onTouchEnd"
  >
    <div class="bubble" :class="[message.sender, message.type]">
      <!-- Reply quote -->
      <div v-if="message.replyTo" class="reply-quote" :class="message.replyTo.sender">
        <span class="reply-sender">{{ message.replyTo.sender === 'operator' ? 'You' : 'Sensorium' }}</span>
        <span class="reply-text">{{ message.replyTo.text }}</span>
      </div>

      <!-- Sticker -->
      <template v-if="message.type === 'sticker'">
        <div class="sticker-container">
          <img :src="message.stickerUrl" :alt="message.stickerEmoji" class="sticker-img" />
        </div>
      </template>

      <!-- Video note (circle) -->
      <template v-else-if="message.type === 'video_note'">
        <div class="video-note-container">
          <div class="video-note-circle">
            <img :src="message.videoNoteUrl" alt="Video note" class="video-note-img" />
            <button class="video-note-play">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            </button>
          </div>
          <span v-if="message.videoNoteDuration" class="video-note-duration">
            {{ formatDuration(message.videoNoteDuration) }}
          </span>
        </div>
      </template>

      <!-- Animation/GIF -->
      <template v-else-if="message.type === 'animation'">
        <div class="animation-container">
          <img :src="message.animationUrl" alt="GIF" class="animation-img" />
          <span class="gif-badge">GIF</span>
        </div>
      </template>

      <!-- Photo -->
      <template v-else-if="message.type === 'photo'">
        <div class="photo-container">
          <img :src="message.photoUrl" alt="Photo" class="photo-img" />
          <p v-if="message.text" class="photo-caption" v-html="renderedText"></p>
        </div>
      </template>

      <!-- File -->
      <template v-else-if="message.type === 'file' && message.file">
        <div class="file-msg">
          <div class="file-icon" :class="getFileIcon(message.file.type)">
            <svg v-if="getFileIcon(message.file.type) === 'pdf'" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h5v7h7v9H6z"/>
            </svg>
            <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>
            </svg>
          </div>
          <div class="file-info">
            <span class="file-name">{{ message.file.name }}</span>
            <span class="file-size">{{ formatFileSize(message.file.size) }}</span>
          </div>
          <button class="file-download">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <p v-if="message.text" class="file-caption" v-html="renderedText"></p>
      </template>

      <!-- Voice -->
      <template v-else-if="message.type === 'voice'">
        <div class="voice-msg">
          <button class="play-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <div class="voice-body">
            <div class="waveform">
              <div v-for="(h, i) in getWaveHeights(message.id)" :key="i" class="wave-bar" :class="message.sender" :style="{ height: h + 'px' }"></div>
            </div>
            <span class="voice-duration">{{ formatDuration(message.voiceDuration ?? 0) }}</span>
          </div>
        </div>
      </template>

      <!-- Text -->
      <template v-else>
        <div class="text" v-html="renderedText"></div>
      </template>

      <!-- Timestamp + status -->
      <span
        v-if="message.type !== 'sticker'"
        class="timestamp"
        :class="message.sender"
      >
        <span v-if="message.edited" class="edited-label">edited</span>
        {{ message.timestamp }}
        <template v-if="message.sender === 'operator'">
          <svg v-if="message.read" class="read-check" width="16" height="11" viewBox="0 0 16 11" fill="none">
            <path d="M11.5 0.5L5.5 6.5L3 4" stroke="#4dcd5e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14.5 0.5L8.5 6.5" stroke="#4dcd5e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg v-else class="read-check" width="16" height="11" viewBox="0 0 16 11" fill="none">
            <path d="M11.5 0.5L5.5 6.5L3 4" stroke="#6b8fb3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14.5 0.5L8.5 6.5" stroke="#6b8fb3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </template>
      </span>

      <!-- Reactions -->
      <div v-if="message.reactions && message.reactions.length > 0" class="reactions">
        <button v-for="r in message.reactions" :key="r.emoji" class="reaction-chip" :class="{ mine: r.byMe }" @click="addReaction(r.emoji)">
          <span class="reaction-emoji">{{ r.emoji }}</span>
          <span v-if="r.count > 1" class="reaction-count">{{ r.count }}</span>
        </button>
      </div>

      <!-- Reaction picker -->
      <div v-if="showReactionPicker" class="reaction-picker" @mouseleave="showReactionPicker = false">
        <button v-for="emoji in reactionEmojis" :key="emoji" class="picker-emoji" @click="addReaction(emoji)">{{ emoji }}</button>
      </div>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div v-if="showContextMenu" class="context-overlay" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu">
        <div class="context-menu" :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }">
          <button class="ctx-item" @click="contextAction('reply')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17H4V12L20 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12l5 5" stroke-linecap="round"/></svg>
            Reply
          </button>
          <button class="ctx-item" @click="contextAction('react')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2" stroke-linecap="round"/></svg>
            React
          </button>
          <button class="ctx-item" @click="contextAction('pin')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z"/></svg>
            {{ message.pinned ? 'Unpin' : 'Pin' }}
          </button>
          <button v-if="message.sender === 'operator'" class="ctx-item" @click="contextAction('edit')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="ctx-item danger" @click="contextAction('delete')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            Delete
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Pin indicator */
.pin-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 16px;
  font-size: 12px;
  color: #6b7c8e;
}

.pin-indicator.operator {
  justify-content: flex-end;
}

/* Message row */
.message-row {
  display: flex;
  padding: 1px 8px;
  position: relative;
  user-select: text;
  -webkit-user-select: text;
}

.message-row.operator { justify-content: flex-end; }
.message-row.agent { justify-content: flex-start; }

/* Bubble */
.bubble {
  max-width: min(85%, 480px);
  padding: 6px 9px 5px;
  border-radius: 12px;
  position: relative;
  word-wrap: break-word;
}

.bubble.operator { background: #2b5278; border-top-right-radius: 4px; }
.bubble.agent { background: #182533; border-top-left-radius: 4px; }
.bubble.sticker, .bubble.video_note { background: transparent; padding: 4px; }
.bubble.photo, .bubble.animation { padding: 3px; max-width: min(75%, 360px); }
.bubble.file { min-width: min(70%, 280px); }

/* Reply quote */
.reply-quote {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border-radius: 6px;
  border-left: 3px solid;
  background: rgba(0,0,0,0.15);
  cursor: pointer;
}

.reply-quote.operator { border-color: #6ab3f3; }
.reply-quote.agent { border-color: #98c379; }

.reply-sender {
  font-size: 12px;
  font-weight: 600;
}

.reply-quote.operator .reply-sender { color: #6ab3f3; }
.reply-quote.agent .reply-sender { color: #98c379; }

.reply-text {
  font-size: 13px;
  color: #8b9baa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

/* Sticker */
.sticker-container { width: 160px; height: 160px; }
.sticker-img { width: 100%; height: 100%; object-fit: contain; }

/* Video note (circle) */
.video-note-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.video-note-circle {
  width: 200px;
  height: 200px;
  border-radius: 50%;
  overflow: hidden;
  position: relative;
  border: 3px solid #2b5278;
}

.video-note-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.video-note-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.3);
  border: none;
  cursor: pointer;
  border-radius: 50%;
  transition: background 0.15s;
}

.video-note-play:hover { background: rgba(0,0,0,0.5); }

.video-note-duration {
  font-size: 12px;
  color: #6b8fb3;
}

/* Animation/GIF */
.animation-container {
  position: relative;
  overflow: hidden;
  border-radius: 9px;
}

.animation-img {
  width: 100%;
  display: block;
  border-radius: 9px;
  cursor: pointer;
}

.gif-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0,0,0,0.6);
  color: white;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.5px;
}

/* Photo */
.photo-container { overflow: hidden; border-radius: 9px; }
.photo-img { width: 100%; display: block; border-radius: 9px; cursor: pointer; }
.photo-caption { padding: 6px 6px 0; font-size: 14px; line-height: 1.35; color: #e1e3e6; }
.photo-caption :deep(a) { color: #6ab3f3; }

/* File */
.file-msg { display: flex; align-items: center; gap: 10px; padding: 2px 0; }

.file-icon {
  width: 44px; height: 44px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; background: #3a5f82; color: white;
}
.file-icon.pdf { background: #c04040; }
.file-icon.zip { background: #d19a66; }
.file-icon.img { background: #56b6c2; }
.file-icon.txt { background: #98c379; }

.file-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.file-name { font-size: 14px; font-weight: 500; color: #e1e3e6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-size { font-size: 12px; color: #6b8fb3; }

.file-download {
  width: 36px; height: 36px; border-radius: 50%; border: none; background: none;
  color: #6ab3f3; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.file-download:active { background: rgba(106, 179, 243, 0.1); }
.file-caption { margin-top: 4px; font-size: 14px; line-height: 1.35; color: #e1e3e6; }

/* Voice */
.voice-msg { display: flex; align-items: center; gap: 10px; min-width: 200px; }

.play-btn {
  width: 40px; height: 40px; border-radius: 50%; border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; background: #4dcd5e; color: white;
}
.play-btn:active { opacity: 0.8; }

.voice-body { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.waveform { display: flex; align-items: center; gap: 2px; height: 24px; }
.wave-bar { width: 3px; border-radius: 2px; }
.wave-bar.operator { background: #6eaddc; }
.wave-bar.agent { background: #4a6d88; }
.voice-duration { font-size: 12px; color: #6b8fb3; }

/* Text / Markdown */
.text { font-size: 15px; line-height: 1.4; color: #e1e3e6; word-break: break-word; }
.text :deep(strong) { font-weight: 600; }
.text :deep(em) { font-style: italic; }
.text :deep(del) { text-decoration: line-through; opacity: 0.7; }
.text :deep(a) { color: #6ab3f3; text-decoration: none; }
.text :deep(a:hover) { text-decoration: underline; }

.text :deep(.inline-code) {
  background: rgba(0,0,0,0.25); padding: 1px 5px; border-radius: 4px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; color: #e5c07b;
}

.text :deep(.code-block) {
  background: #0d1117; border-radius: 8px; margin: 6px 0; overflow: hidden;
}
.text :deep(.code-block .code-lang) {
  display: block; padding: 4px 12px; font-size: 11px; font-weight: 500;
  color: #6b7c8e; background: rgba(255,255,255,0.03);
  border-bottom: 1px solid rgba(255,255,255,0.05);
  text-transform: uppercase; letter-spacing: 0.5px;
}
.text :deep(.code-block pre) { margin: 0; padding: 10px 12px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.text :deep(.code-block code) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px;
  line-height: 1.5; color: #e1e3e6; white-space: pre;
}

/* Timestamp */
.timestamp {
  display: inline-flex; align-items: center; gap: 3px;
  float: right; margin-top: 2px; margin-left: 10px; font-size: 12px; line-height: 1;
}
.timestamp.operator { color: #6eaddc; }
.timestamp.agent { color: #546d7e; }
.read-check { flex-shrink: 0; }

.edited-label {
  font-style: italic;
  margin-right: 3px;
  opacity: 0.7;
}

/* Reactions */
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; clear: both; }

.reaction-chip {
  display: flex; align-items: center; gap: 3px; padding: 2px 7px;
  border-radius: 12px; border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.05); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.reaction-chip:hover { background: rgba(255,255,255,0.1); }
.reaction-chip.mine { border-color: #6ab3f3; background: rgba(106,179,243,0.12); }
.reaction-emoji { font-size: 16px; line-height: 1; }
.reaction-count { font-size: 12px; color: #8b9baa; font-weight: 500; }

/* Reaction picker */
.reaction-picker {
  position: absolute; bottom: 100%; left: 0; margin-bottom: 4px;
  display: flex; gap: 2px; background: #232e3c; border-radius: 20px;
  padding: 6px 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 10;
  animation: fadeScale 0.15s ease-out;
}
.message-row.operator .reaction-picker { left: auto; right: 0; }

@keyframes fadeScale {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

.picker-emoji {
  width: 36px; height: 36px; border: none; background: none; font-size: 22px;
  cursor: pointer; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  transition: transform 0.1s, background 0.1s;
}
.picker-emoji:hover { transform: scale(1.2); background: rgba(255,255,255,0.1); }
.picker-emoji:active { transform: scale(0.95); }

/* Context menu */
.context-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.3);
  animation: fadeIn 0.1s ease-out;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.context-menu {
  position: absolute;
  background: #232e3c;
  border-radius: 12px;
  padding: 6px;
  min-width: 180px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  animation: fadeScale 0.15s ease-out;
  transform: translate(-50%, -100%);
  margin-top: -8px;
}

.ctx-item {
  display: flex; align-items: center; gap: 12px;
  width: 100%; padding: 10px 12px; border: none; background: none;
  color: #e1e3e6; font-size: 14px; cursor: pointer; border-radius: 8px;
  transition: background 0.15s; text-align: left;
}
.ctx-item:hover { background: #2b3845; }
.ctx-item:active { background: #344454; }
.ctx-item.danger { color: #e06c75; }
.ctx-item.danger:hover { background: rgba(224,108,117,0.1); }
</style>
