<script setup lang="ts">
import type { Thread } from '../types'

defineProps<{
  threads: Thread[]
  activeThreadId: number | null
  isMobile: boolean
}>()

defineEmits<{
  select: [id: number]
}>()

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase()
}

function getAvatarColor(id: number): string {
  const colors = [
    '#7b68ee', '#e06c75', '#e5c07b', '#56b6c2',
    '#c678dd', '#98c379', '#d19a66', '#61afef',
  ]
  return colors[id % colors.length]
}
</script>

<template>
  <aside class="sidebar" :class="{ mobile: isMobile }">
    <div class="sidebar-header">
      <button class="menu-btn">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18M3 6h18M3 18h18" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="search-box">
        <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" stroke-linecap="round"/>
        </svg>
        <input type="text" placeholder="Search" />
      </div>
    </div>

    <div class="thread-list">
      <div
        v-for="thread in threads"
        :key="thread.id"
        class="thread-item"
        :class="{ active: thread.id === activeThreadId }"
        @click="$emit('select', thread.id)"
      >
        <div class="thread-avatar" :style="{ background: getAvatarColor(thread.id) }">
          <span>{{ getInitial(thread.name) }}</span>
          <div v-if="thread.isOnline" class="online-dot"></div>
        </div>
        <div class="thread-info">
          <div class="thread-top">
            <span class="thread-name">{{ thread.name }}</span>
            <span class="thread-time" :class="{ unread: thread.unread > 0 }">{{ thread.lastMessageTime }}</span>
          </div>
          <div class="thread-bottom">
            <span class="thread-preview">{{ thread.lastMessage }}</span>
            <span v-if="thread.unread > 0" class="unread-badge">{{ thread.unread }}</span>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 320px;
  min-width: 320px;
  background: #17212b;
  border-right: 1px solid #101921;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sidebar.mobile {
  width: 100%;
  min-width: 100%;
  border-right: none;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 4px;
  min-height: 56px;
}

.menu-btn {
  background: none;
  border: none;
  color: #8b9baa;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  flex-shrink: 0;
}

.menu-btn:hover {
  background: #232e3c;
}

.menu-btn:active {
  background: #2b3845;
}

.search-box {
  flex: 1;
  position: relative;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: #6b7c8e;
  pointer-events: none;
}

.search-box input {
  width: 100%;
  padding: 10px 12px 10px 38px;
  background: #242f3d;
  border: 2px solid transparent;
  border-radius: 22px;
  color: #e1e3e6;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s, background 0.2s;
}

.search-box input::placeholder {
  color: #6b7c8e;
}

.search-box input:focus {
  background: #1c2733;
  border-color: #6ab3f3;
}

.thread-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.thread-list::-webkit-scrollbar {
  width: 5px;
}

.thread-list::-webkit-scrollbar-thumb {
  background: #2b3845;
  border-radius: 3px;
}

.thread-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}

.thread-item:hover {
  background: #202b38;
}

.thread-item:active {
  background: #253341;
}

.thread-item.active {
  background: #2b5278;
}

.thread-avatar {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
}

.thread-avatar span {
  font-size: 20px;
  font-weight: 600;
  color: white;
}

.online-dot {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #4dcd5e;
  border: 2px solid #17212b;
}

.thread-item.active .online-dot {
  border-color: #2b5278;
}

.thread-info {
  flex: 1;
  min-width: 0;
  padding: 2px 0;
}

.thread-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}

.thread-name {
  font-size: 15px;
  font-weight: 500;
  color: #e1e3e6;
}

.thread-time {
  font-size: 12px;
  color: #6b7c8e;
  flex-shrink: 0;
  margin-left: 8px;
}

.thread-time.unread {
  color: #4dcd5e;
}

.thread-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.thread-preview {
  font-size: 14px;
  color: #6b7c8e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  line-height: 1.3;
}

.unread-badge {
  background: #4dcd5e;
  color: white;
  font-size: 12px;
  font-weight: 600;
  min-width: 22px;
  height: 22px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  flex-shrink: 0;
}
</style>
