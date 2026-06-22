<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from 'vue'
import type { Thread, Message } from '../types'
import MessageBubble from './MessageBubble.vue'
import ChatInput from './ChatInput.vue'

const props = defineProps<{
  thread: Thread
  messages: Message[]
  isMobile: boolean
  typing: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  'send-voice': [duration: number]
  'send-photo': [url: string, caption: string]
  'send-file': [file: { name: string; size: number; type: string }]
  react: [messageId: string, emoji: string]
  reply: [message: Message]
  pin: [messageId: string]
  delete: [messageId: string]
  back: []
}>()

const replyingTo = ref<Message | null>(null)

function setReply(message: Message) {
  replyingTo.value = message
  emit('reply', message)
}

function cancelReply() {
  replyingTo.value = null
}

const messagesContainer = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

watch(() => props.messages.length, scrollToBottom)
watch(() => props.thread.id, scrollToBottom)
onMounted(scrollToBottom)

function getAvatarColor(id: number): string {
  const colors = [
    '#7b68ee', '#e06c75', '#e5c07b', '#56b6c2',
    '#c678dd', '#98c379', '#d19a66', '#61afef',
  ]
  return colors[id % colors.length]
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}
</script>

<template>
  <main class="chat-area">
    <header class="chat-header">
      <button v-if="isMobile" class="back-btn" @click="$emit('back')">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>

      <div class="header-avatar" :style="{ background: getAvatarColor(thread.id) }">
        {{ thread.name.charAt(0).toUpperCase() }}
      </div>
      <div class="header-info">
        <h2 class="header-name">{{ thread.name }}</h2>
        <span class="header-status" :class="{ online: thread.isOnline, typing: typing }">
          <template v-if="typing">typing...</template>
          <template v-else>{{ thread.isOnline ? 'online' : 'last seen recently' }}</template>
        </span>
      </div>

      <div class="header-actions">
        <button class="header-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="header-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </header>

    <div class="messages" ref="messagesContainer">
      <div class="messages-inner">
        <div class="date-separator">
          <span>{{ formatDate() }}</span>
        </div>
        <div v-if="messages.length === 0" class="no-messages">
          <p>No messages yet</p>
        </div>
        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          @react="(id: string, emoji: string) => $emit('react', id, emoji)"
          @reply="setReply"
          @pin="(id: string) => $emit('pin', id)"
          @delete="(id: string) => $emit('delete', id)"
        />
        <div v-if="typing" class="typing-indicator">
          <div class="typing-bubble">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Reply bar -->
    <div v-if="replyingTo" class="reply-bar">
      <div class="reply-bar-content">
        <span class="reply-bar-sender">{{ replyingTo.sender === 'operator' ? 'You' : thread.name }}</span>
        <span class="reply-bar-text">{{ replyingTo.text || (replyingTo.type === 'voice' ? 'Voice message' : replyingTo.type) }}</span>
      </div>
      <button class="reply-bar-close" @click="cancelReply">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <ChatInput
      @send="$emit('send', $event); cancelReply()"
      @send-voice="$emit('send-voice', $event); cancelReply()"
      @send-photo="(url: string, caption: string) => { $emit('send-photo', url, caption); cancelReply() }"
      @send-file="(f: any) => { $emit('send-file', f); cancelReply() }"
    />
  </main>
</template>

<style scoped>
.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #0e1621;
  height: 100%;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  background: #17212b;
  border-bottom: 1px solid #101921;
  min-height: 56px;
  flex-shrink: 0;
}

.back-btn {
  background: none;
  border: none;
  color: #6ab3f3;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-left: -4px;
}

.back-btn:active {
  background: #232e3c;
}

.header-avatar {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 600;
  color: white;
  flex-shrink: 0;
}

.header-info {
  flex: 1;
  min-width: 0;
}

.header-name {
  font-size: 15px;
  font-weight: 600;
  color: #e1e3e6;
  margin: 0;
  line-height: 1.2;
}

.header-status {
  font-size: 13px;
  color: #6b7c8e;
  line-height: 1.2;
}

.header-status.online {
  color: #6ab3f3;
}

.header-status.typing {
  color: #6ab3f3;
}

.header-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.header-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: none;
  color: #8b9baa;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.header-btn:hover {
  background: #232e3c;
}

.header-btn:active {
  background: #2b3845;
}

.messages {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background-image:
    radial-gradient(circle at 20% 50%, rgba(43, 82, 120, 0.06) 0%, transparent 50%),
    radial-gradient(circle at 80% 20%, rgba(75, 109, 136, 0.04) 0%, transparent 50%),
    radial-gradient(circle at 50% 80%, rgba(43, 82, 120, 0.03) 0%, transparent 50%);
}

.messages::-webkit-scrollbar {
  width: 5px;
}

.messages::-webkit-scrollbar-thumb {
  background: #2b3845;
  border-radius: 3px;
}

.messages-inner {
  max-width: 720px;
  margin: 0 auto;
  padding: 4px 0 8px;
}

.date-separator {
  display: flex;
  justify-content: center;
  padding: 8px 0 4px;
}

.date-separator span {
  background: #182533;
  color: #8b9baa;
  font-size: 13px;
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 12px;
}

.no-messages {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  color: #6b7c8e;
  font-size: 14px;
}

/* Reply bar */
.reply-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #17212b;
  border-top: 1px solid #101921;
  border-left: 3px solid #6ab3f3;
  margin: 0 8px;
  border-radius: 0 8px 8px 0;
}

.reply-bar-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.reply-bar-sender {
  font-size: 12px;
  font-weight: 600;
  color: #6ab3f3;
}

.reply-bar-text {
  font-size: 13px;
  color: #8b9baa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reply-bar-close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: none;
  color: #6b7c8e;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.reply-bar-close:hover {
  color: #8b9baa;
  background: #232e3c;
}

.typing-indicator {
  display: flex;
  padding: 1px 8px;
}

.typing-bubble {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #182533;
  padding: 10px 14px;
  border-radius: 12px;
  border-top-left-radius: 4px;
}

.typing-bubble .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4a6d88;
  animation: typingDot 1.4s ease-in-out infinite;
}

.typing-bubble .dot:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-bubble .dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typingDot {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}
</style>
