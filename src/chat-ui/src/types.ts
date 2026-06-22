export interface Thread {
  id: number
  name: string
  lastMessage: string
  lastMessageTime: string
  unread: number
  avatar?: string
  isOnline?: boolean
}

export interface Reaction {
  emoji: string
  count: number
  byMe: boolean
}

export interface FileAttachment {
  name: string
  size: number
  type: string
  url?: string
}

export interface ReplyTo {
  id: string
  sender: 'operator' | 'agent'
  text: string
}

export interface Message {
  id: string
  threadId: number
  text: string
  timestamp: string
  sender: 'operator' | 'agent'
  type: 'text' | 'voice' | 'photo' | 'file' | 'sticker' | 'video_note' | 'animation'
  voiceDuration?: number
  reactions?: Reaction[]
  read?: boolean
  photoUrl?: string
  file?: FileAttachment
  stickerEmoji?: string
  stickerUrl?: string
  videoNoteUrl?: string
  videoNoteDuration?: number
  animationUrl?: string
  replyTo?: ReplyTo
  pinned?: boolean
  edited?: boolean
}
