<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { Thread, Message } from './types'
import { mockThreads, mockMessages } from './mock-data'
import Sidebar from './components/Sidebar.vue'
import ChatArea from './components/ChatArea.vue'

const threads = ref<Thread[]>(mockThreads)
const messages = ref<Record<number, Message[]>>(mockMessages)
const activeThreadId = ref<number | null>(null)
const isMobile = ref(window.innerWidth < 768)
const typing = ref(false)

const mockReplies = [
  'Got it. Working on that now.',
  'Done. Anything else?',
  'Session is active, all threads healthy.',
  'Understood. I\'ll look into it.',
  'Processed your request. Check the results.',
  'Roger that.',
]

const activeThread = computed(() =>
  threads.value.find(t => t.id === activeThreadId.value) ?? null
)

const activeMessages = computed(() =>
  activeThreadId.value ? (messages.value[activeThreadId.value] ?? []) : []
)

const showSidebar = computed(() => isMobile.value ? !activeThreadId.value : true)
const showChat = computed(() => isMobile.value ? !!activeThreadId.value : !!activeThreadId.value)

function selectThread(id: number) {
  activeThreadId.value = id
  const thread = threads.value.find(t => t.id === id)
  if (thread) thread.unread = 0
}

function goBack() {
  activeThreadId.value = null
}

function sendMessage(text: string) {
  if (!activeThreadId.value) return
  const msg: Message = {
    id: `m_${Date.now()}`,
    threadId: activeThreadId.value,
    text,
    timestamp: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
    sender: 'operator',
    type: 'text',
  }
  if (!messages.value[activeThreadId.value]) {
    messages.value[activeThreadId.value] = []
  }
  messages.value[activeThreadId.value].push(msg)

  const thread = threads.value.find(t => t.id === activeThreadId.value)
  if (thread) {
    thread.lastMessage = text
    thread.lastMessageTime = msg.timestamp
  }

  simulateRead(msg)
  simulateReply()
}

function simulateRead(msg: Message) {
  setTimeout(() => {
    msg.read = true
    if (!msg.reactions) msg.reactions = []
    if (!msg.reactions.find(r => r.emoji === '👀')) {
      msg.reactions.push({ emoji: '👀', count: 1, byMe: false })
    }
  }, 600 + Math.random() * 400)
}

function simulateReply() {
  const tid = activeThreadId.value
  if (!tid) return
  typing.value = true
  setTimeout(() => {
    typing.value = false
    const reply: Message = {
      id: `r_${Date.now()}`,
      threadId: tid,
      text: mockReplies[Math.floor(Math.random() * mockReplies.length)],
      timestamp: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
      sender: 'agent',
      type: 'text',
    }
    if (!messages.value[tid]) messages.value[tid] = []
    messages.value[tid].push(reply)
    const thread = threads.value.find(t => t.id === tid)
    if (thread) {
      thread.lastMessage = reply.text
      thread.lastMessageTime = reply.timestamp
    }
  }, 1200 + Math.random() * 800)
}

function sendVoice(duration: number) {
  if (!activeThreadId.value) return
  const msg: Message = {
    id: `v_${Date.now()}`,
    threadId: activeThreadId.value,
    text: '',
    timestamp: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
    sender: 'operator',
    type: 'voice',
    voiceDuration: duration,
  }
  if (!messages.value[activeThreadId.value]) {
    messages.value[activeThreadId.value] = []
  }
  messages.value[activeThreadId.value].push(msg)

  const thread = threads.value.find(t => t.id === activeThreadId.value)
  if (thread) {
    thread.lastMessage = 'Voice message'
    thread.lastMessageTime = msg.timestamp
  }

  simulateRead(msg)
  simulateReply()
}

function sendPhoto(url: string, _caption: string) {
  if (!activeThreadId.value) return
  const msg: Message = {
    id: `p_${Date.now()}`,
    threadId: activeThreadId.value,
    text: _caption,
    timestamp: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
    sender: 'operator',
    type: 'photo',
    photoUrl: url,
  }
  if (!messages.value[activeThreadId.value]) {
    messages.value[activeThreadId.value] = []
  }
  messages.value[activeThreadId.value].push(msg)

  const thread = threads.value.find(t => t.id === activeThreadId.value)
  if (thread) {
    thread.lastMessage = 'Photo'
    thread.lastMessageTime = msg.timestamp
  }

  simulateRead(msg)
  simulateReply()
}

function sendFile(file: { name: string; size: number; type: string }) {
  if (!activeThreadId.value) return
  const msg: Message = {
    id: `f_${Date.now()}`,
    threadId: activeThreadId.value,
    text: '',
    timestamp: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
    sender: 'operator',
    type: 'file',
    file,
  }
  if (!messages.value[activeThreadId.value]) {
    messages.value[activeThreadId.value] = []
  }
  messages.value[activeThreadId.value].push(msg)

  const thread = threads.value.find(t => t.id === activeThreadId.value)
  if (thread) {
    thread.lastMessage = file.name
    thread.lastMessageTime = msg.timestamp
  }

  simulateRead(msg)
  simulateReply()
}

function handleReaction(messageId: string, emoji: string) {
  if (!activeThreadId.value) return
  const msgs = messages.value[activeThreadId.value]
  if (!msgs) return
  const msg = msgs.find(m => m.id === messageId)
  if (!msg) return
  if (!msg.reactions) msg.reactions = []
  const existing = msg.reactions.find(r => r.emoji === emoji)
  if (existing) {
    if (existing.byMe) {
      msg.reactions = msg.reactions.filter(r => r.emoji !== emoji)
    } else {
      existing.byMe = true
      existing.count++
    }
  } else {
    msg.reactions.push({ emoji, count: 1, byMe: true })
  }
}

function handlePin(messageId: string) {
  if (!activeThreadId.value) return
  const msgs = messages.value[activeThreadId.value]
  if (!msgs) return
  const msg = msgs.find(m => m.id === messageId)
  if (msg) msg.pinned = !msg.pinned
}

function handleDelete(messageId: string) {
  if (!activeThreadId.value) return
  const msgs = messages.value[activeThreadId.value]
  if (!msgs) return
  const idx = msgs.findIndex(m => m.id === messageId)
  if (idx >= 0) msgs.splice(idx, 1)
}

function onResize() {
  isMobile.value = window.innerWidth < 768
}

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <div class="app-container">
    <Sidebar
      v-show="showSidebar"
      :threads="threads"
      :active-thread-id="activeThreadId"
      :is-mobile="isMobile"
      @select="selectThread"
    />
    <ChatArea
      v-if="showChat && activeThread"
      :thread="activeThread"
      :messages="activeMessages"
      :is-mobile="isMobile"
      :typing="typing"
      @send="sendMessage"
      @send-voice="sendVoice"
      @send-photo="sendPhoto"
      @send-file="sendFile"
      @react="handleReaction"
      @pin="handlePin"
      @delete="handleDelete"
      @back="goBack"
    />
    <div v-if="!isMobile && !activeThread" class="empty-state">
      <div class="empty-state-content">
        <div class="empty-state-icon">
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
            <circle cx="60" cy="60" r="56" stroke="#2b3845" stroke-width="2"/>
            <path d="M40 52c0-11.046 8.954-20 20-20s20 8.954 20 20v4c0 11.046-8.954 20-20 20s-20-8.954-20-20v-4z" fill="#1e2c3a"/>
            <path d="M44 78l-8 14h48l-8-14" fill="#1e2c3a"/>
            <circle cx="52" cy="54" r="3" fill="#3a4f63"/>
            <circle cx="68" cy="54" r="3" fill="#3a4f63"/>
          </svg>
        </div>
        <h2>Sensorium Chat</h2>
        <p>Select a thread to start messaging</p>
      </div>
    </div>
  </div>
</template>

<style>
* {
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
}

.app-container {
  display: flex;
  height: 100vh;
  height: 100dvh;
  background: #0e1621;
  overflow: hidden;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0e1621;
}

.empty-state-content {
  text-align: center;
  color: #6b7c8e;
}

.empty-state-icon {
  margin-bottom: 24px;
  opacity: 0.5;
}

.empty-state h2 {
  font-size: 20px;
  font-weight: 500;
  margin-bottom: 8px;
  color: #8b9baa;
}

.empty-state p {
  font-size: 14px;
}
</style>
