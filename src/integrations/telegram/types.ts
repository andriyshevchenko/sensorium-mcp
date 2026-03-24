/**
 * Telegram Bot API type definitions.
 * Extracted from telegram.ts for modularity.
 */

// ---------------------------------------------------------------------------
// Public type definitions
// ---------------------------------------------------------------------------

export interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  emoji?: string;
  set_name?: string;
}

export interface TelegramAnimation {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
  thumbnail?: PhotoSize;
  thumb?: PhotoSize; // legacy alias
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  date: number;
  message_thread_id?: number;
  photo?: PhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  video_note?: TelegramVideoNote;
  sticker?: TelegramSticker;
  animation?: TelegramAnimation;
  forum_topic_created?: { name: string };
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;       // width = height (square circle video)
  duration: number;     // seconds, max 60
  thumbnail?: PhotoSize;
  file_size?: number;
}

export interface TelegramMessageReaction {
  chat: { id: number };
  message_id: number;
  date: number;
  new_reaction: Array<{ type: string; emoji?: string }>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  message_reaction?: TelegramMessageReaction;
}

// ---------------------------------------------------------------------------
// Internal result types (used by TelegramClient)
// ---------------------------------------------------------------------------

export interface GetUpdatesResult {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

export interface SendMessageResult {
  ok: boolean;
  result?: TelegramMessage;
  description?: string;
}

export interface ForumTopic {
  message_thread_id: number;
  name: string;
}

export interface CreateForumTopicResult {
  ok: boolean;
  result?: ForumTopic;
  description?: string;
}

export interface TelegramFile {
  file_id: string;
  file_path: string;
}

export interface GetFileResult {
  ok: boolean;
  result?: TelegramFile;
  description?: string;
}
