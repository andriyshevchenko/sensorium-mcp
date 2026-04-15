/**
 * Telegram Bot API client using native fetch.
 * No third-party HTTP client required.
 */

import { log } from "./logger.js";
import type { SentMessageRepository } from "./data/sent-message.repository.js";
import type {
  TelegramUpdate,
  TelegramFile,
  ForumTopic,
  GetUpdatesResult,
  SendMessageResult,
  CreateForumTopicResult,
  GetFileResult,
} from "./integrations/telegram/types.js";
import { errorMessage } from "./utils.js";

// Re-export all types so existing consumers of ./telegram.js are unaffected
export * from "./integrations/telegram/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length of content snippets stored for sent-message lookup. */
const SNIPPET_MAX_LENGTH = 80;

/** Duration (ms) after which the reaction-failure warning is re-emitted. */
const REACTION_WARN_SUPPRESS_MS = 60_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TelegramClient {
  private readonly baseUrl: string;

  /** Latest operator reaction received via getUpdates. */
  lastReaction: { emoji: string; messageId: number; date: number } | null = null;

  // Ring buffer for sent messages (tracks message_id → content snippet)
  private readonly sentMessages: Array<{ messageId: number; snippet: string; timestamp: number }> = [];
  private static readonly MAX_SENT_MESSAGES = 50;

  /** Optional repository for persisting message_id → thread_id mappings. */
  private sentMessageRepository: SentMessageRepository | null = null;

  /** Optional resolver for logical threadId → actual Telegram topic ID. */
  private topicResolver: ((threadId: number) => number) | null = null;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /** Set a resolver that maps logical thread IDs to actual Telegram topic IDs. */
  setTopicResolver(resolver: (threadId: number) => number): void {
    this.topicResolver = resolver;
  }

  /** Resolve a logical threadId to the actual Telegram topic ID. */
  private resolveTopicId(threadId: number | undefined): number | undefined {
    if (threadId === undefined) return undefined;
    if (!this.topicResolver) return threadId;
    try {
      return this.topicResolver(threadId);
    } catch {
      return threadId;
    }
  }

  /**
   * Wire up persistence for sent message_id → thread_id mappings.
   */
  setSentMessageRepository(repository: SentMessageRepository): void {
    this.sentMessageRepository = repository;
  }

  /** Record a sent message for later lookup (e.g. when a reaction arrives). */
  private recordSentMessage(messageId: number, snippet: string, threadId?: number): void {
    this.sentMessages.push({ messageId, snippet, timestamp: Date.now() });
    if (this.sentMessages.length > TelegramClient.MAX_SENT_MESSAGES) {
      this.sentMessages.splice(0, this.sentMessages.length - TelegramClient.MAX_SENT_MESSAGES);
    }
    // Persist message_id → thread_id mapping for per-thread reaction routing
    if (threadId !== undefined && this.sentMessageRepository) {
      this.sentMessageRepository.saveThreadMessage(messageId, threadId);
    }
  }

  /** Look up the content snippet for a previously sent message. Returns null if not found. */
  lookupSentMessage(messageId: number): string | null {
    const entry = this.sentMessages.find(m => m.messageId === messageId);
    return entry?.snippet ?? null;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Strip the bot token from an error message so it is never leaked in logs
   * or propagated to callers.
   */
  private redactError(err: unknown): Error {
    if (err instanceof Error) {
      const redacted = new Error(err.message.replaceAll(this.token, "***REDACTED***"));
      redacted.stack = err.stack?.replaceAll(this.token, "***REDACTED***");
      return redacted;
    }
    return new Error(String(err).replaceAll(this.token, "***REDACTED***"));
  }

  /**
   * Wrapper around global `fetch` that redacts the bot token from any
   * network-level error (e.g. DNS failure, connection refused) before
   * re-throwing.
   */
  private async safeFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const timeoutMs = 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!init?.signal) {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      init = { ...init, signal: controller.signal };
    }
    try {
      return await fetch(input, init);
    } catch (err) {
      throw this.redactError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Safely parse a JSON response, returning undefined on failure. */
  private async tryParseJson<T>(response: Response): Promise<T | undefined> {
    try {
      return (await response.json()) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Send a media file via multipart/form-data.
   * Shared implementation for sendDocument, sendPhoto, and sendVoice.
   */
  private async sendMedia(
    method: string,
    chatId: string,
    fieldName: string,
    blob: Blob,
    filename: string,
    options?: { caption?: string; threadId?: number },
  ): Promise<number | undefined> {
    const url = `${this.baseUrl}/${method}`;
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append(fieldName, blob, filename);
    if (options?.caption) formData.append("caption", options.caption);
    if (options?.threadId !== undefined) {
      formData.append("message_thread_id", String(this.resolveTopicId(options.threadId)));
    }

    const response = await this.safeFetch(url, { method: "POST", body: formData });
    const data = await this.tryParseJson<SendMessageResult>(response);
    if (!response.ok || data?.ok !== true) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram ${method} failed: ${response.status} ${description}`);
    }
    return data?.result?.message_id;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Long-poll for updates.
   * @param offset  Only return updates with update_id >= offset.
   * @param timeout Long-poll server-side timeout in seconds (max 50 recommended).
   */
  async getUpdates(
    offset: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("timeout", String(timeout));
    url.searchParams.set("allowed_updates", JSON.stringify(["message", "message_reaction"]));

    const MAX_409_RETRIES = 12;
    const RETRY_DELAY_MS = 5000;

    for (let attempt = 0; ; attempt++) {
      const response = await this.safeFetch(url.toString(), signal ? { signal } : {});
      const data = await this.tryParseJson<GetUpdatesResult>(response);

      if (data === undefined) {
        log.warn(
          "Failed to parse Telegram getUpdates response.",
        );
      }

      // 409 Conflict: another poller is running. Wait and retry.
      if (response.status === 409 && attempt < MAX_409_RETRIES) {
        log.warn(
          `Telegram getUpdates 409 Conflict (attempt ${attempt + 1}/${MAX_409_RETRIES}) — ` +
          `another bot instance is polling. Retrying in ${RETRY_DELAY_MS / 1000}s...`,
        );
        // Abort-aware delay: if an abort signal fires during the retry
        // delay, throw immediately instead of sleeping the full 5s.
        await new Promise<void>((resolve, reject) => {
          let onAbort: (() => void) | undefined;
          const timer = setTimeout(() => {
            if (signal && onAbort) signal.removeEventListener("abort", onAbort);
            resolve();
          }, RETRY_DELAY_MS);
          if (signal) {
            if (signal.aborted) { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
            onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        continue;
      }

      if (!response.ok) {
        const description = data?.description ?? response.statusText;
        throw new Error(
          `Telegram getUpdates failed: ${response.status} ${description}`,
        );
      }
      if (!data?.ok) {
        const desc = data?.description ? `: ${data.description}` : "";
        throw new Error(`Telegram API error in getUpdates${desc}`);
      }
      return data.result;
    }
  }

  /**
   * Create a topic in a forum supergroup.
   * The bot must be an admin with can_manage_topics right.
   */
  async createForumTopic(chatId: string, name: string): Promise<ForumTopic> {
    const url = `${this.baseUrl}/createForumTopic`;
    const response = await this.safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, name }),
    });
    const data = await this.tryParseJson<CreateForumTopicResult>(response);
    if (!response.ok || !data?.ok || !data.result) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram createForumTopic failed: ${description}`);
    }
    return data.result;
  }

  /**
   * Delete a forum topic (and all its messages) from a supergroup.
   * The bot must be an admin with can_manage_topics right.
   */
  async deleteForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    const url = `${this.baseUrl}/deleteForumTopic`;
    const response = await this.safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: this.resolveTopicId(messageThreadId) ?? messageThreadId,
      }),
    });
    const data = await this.tryParseJson<{ ok: boolean; description?: string }>(response);
    if (!response.ok || !data?.ok) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram deleteForumTopic failed: ${description}`);
    }
  }

  /**
   * Send a text message to a chat, optionally scoped to a forum topic thread.
   */
  async sendMessage(
    chatId: string,
    text: string,
    parseMode?: "MarkdownV2" | "Markdown" | "HTML",
    threadId?: number,
  ): Promise<void> {
    const url = `${this.baseUrl}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    if (threadId !== undefined) body.message_thread_id = this.resolveTopicId(threadId);

    const response = await this.safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await this.tryParseJson<SendMessageResult>(response);

    if (!response.ok) {
      const description = data?.description ?? response.statusText;
      throw new Error(
        `Telegram sendMessage failed: ${response.status} ${description}`,
      );
    }
    if (data === undefined) {
      throw new Error("Telegram sendMessage failed: response body could not be parsed as JSON");
    }
    if (data.ok !== true) {
      const description = data.description ?? "Unknown Telegram API error";
      throw new Error(`Telegram API error in sendMessage: ${description}`);
    }
    if (data.result?.message_id) {
      this.recordSentMessage(data.result.message_id, text.slice(0, SNIPPET_MAX_LENGTH), threadId);
    }
  }

  /**
   * Get metadata for a file stored on Telegram servers.
   */
  async getFile(fileId: string): Promise<TelegramFile> {
    const url = `${this.baseUrl}/getFile`;
    const response = await this.safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    const data = await this.tryParseJson<GetFileResult>(response);
    if (!response.ok || !data?.ok || !data.result) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram getFile failed: ${description}`);
    }
    return data.result;
  }

  /**
   * Download a file from Telegram by file_id and return it as a Buffer.
   */
  async downloadFileAsBuffer(
    fileId: string,
  ): Promise<{ buffer: Buffer; filePath: string }> {
    const file = await this.getFile(fileId);
    const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const response = await this.safeFetch(downloadUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download Telegram file: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, filePath: file.file_path };
  }

  /** Send a document (file) to a chat. */
  async sendDocument(
    chatId: string,
    fileBuffer: Buffer,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    const msgId = await this.sendMedia("sendDocument", chatId, "document",
      new Blob([new Uint8Array(fileBuffer)]), filename, { caption, threadId });
    if (msgId) {
      this.recordSentMessage(msgId, caption?.slice(0, SNIPPET_MAX_LENGTH) ?? `[document: ${filename}]`, threadId);
    }
  }

  /** Send a photo to a chat. */
  async sendPhoto(
    chatId: string,
    imageBuffer: Buffer,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    const msgId = await this.sendMedia("sendPhoto", chatId, "photo",
      new Blob([new Uint8Array(imageBuffer)]), filename, { caption, threadId });
    if (msgId) {
      this.recordSentMessage(msgId, caption?.slice(0, SNIPPET_MAX_LENGTH) ?? "[photo]", threadId);
    }
  }

  /** Send a voice message (OGG Opus) to a chat. */
  async sendVoice(
    chatId: string,
    audioBuffer: Buffer,
    threadId?: number,
    textSnippet?: string,
  ): Promise<void> {
    const msgId = await this.sendMedia("sendVoice", chatId, "voice",
      new Blob([new Uint8Array(audioBuffer)]), "voice.ogg", { threadId });
    if (msgId) {
      const snippet = textSnippet ? textSnippet.slice(0, SNIPPET_MAX_LENGTH) : "[voice message]";
      this.recordSentMessage(msgId, snippet, threadId);
    }
  }

  /** Send a sticker to a chat by file_id. */
  async sendSticker(
    chatId: string,
    stickerId: string,
    threadId?: number,
  ): Promise<void> {
    const url = `${this.baseUrl}/sendSticker`;
    const body: Record<string, unknown> = { chat_id: chatId, sticker: stickerId };
    if (threadId !== undefined) body.message_thread_id = this.resolveTopicId(threadId);

    const response = await this.safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await this.tryParseJson<SendMessageResult>(response);
    if (!response.ok || data?.ok !== true) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram sendSticker failed: ${response.status} ${description}`);
    }
    if (data?.result?.message_id) {
      this.recordSentMessage(data.result.message_id, `[sticker: ${stickerId.slice(0, 20)}...]`, threadId);
    }
  }

  /**
   * Log a reaction-related warning at most once per suppression window.
   */
  private reactionWarned = false;
  private reactionWarnedAt = 0;

  private warnReactionOnce(message: string): void {
    if (this.reactionWarned) return;
    this.reactionWarned = true;
    this.reactionWarnedAt = Date.now();
    log.warn(`[telegram] ${message} (further failures suppressed for 60s)`);
  }

  /**
   * Set an emoji reaction on a message ("seen" indicator).
   * Retries on 429 rate-limit responses. Logs the first failure per
   * 60-second window to avoid flooding stderr in busy sessions.
   */
  async setMessageReaction(
    chatId: string,
    messageId: number,
    emoji: string = "\uD83D\uDC40",
  ): Promise<void> {
    // Reset warning suppression after 60 s so new failures are visible.
    if (this.reactionWarned && Date.now() - this.reactionWarnedAt > REACTION_WARN_SUPPRESS_MS) {
      this.reactionWarned = false;
    }

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `${this.baseUrl}/setMessageReaction`;
        const response = await this.safeFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            reaction: [{ type: "emoji", emoji }],
          }),
        });
        if (response.ok) return;

        // Retry on 429 Too Many Requests.
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const data = await this.tryParseJson<{ parameters?: { retry_after?: number } }>(response);
          const retryAfter = data?.parameters?.retry_after ?? 1;
          log.info(`[telegram] setMessageReaction 429 on msg ${messageId} — retrying in ${retryAfter}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise<void>(r => setTimeout(r, retryAfter * 1000));
          continue;
        }

        const data = await this.tryParseJson<{ description?: string }>(response);
        this.warnReactionOnce(`setMessageReaction failed: ${response.status} ${data?.description ?? response.statusText}`);
        return;
      } catch (err) {
        this.warnReactionOnce(`setMessageReaction error: ${errorMessage(err)}`);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (no TelegramClient instance required)
// ---------------------------------------------------------------------------

/**
 * Send a text message via the Telegram Bot API without a TelegramClient instance.
 * Suitable for fire-and-forget notification helpers that only have the token and chat ID.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  options?: { parseMode?: string; threadId?: number },
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options?.parseMode) body.parse_mode = options.parseMode;
  if (options?.threadId != null) body.message_thread_id = options.threadId;
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Redact the bot token from any network-level error message before re-throwing.
    const msg = String(err instanceof Error ? err.message : err).replaceAll(token, "***REDACTED***");
    throw new Error(`Telegram sendMessage failed (network): ${msg}`);
  }
  if (!response.ok) {
    let description: string | undefined;
    try { description = ((await response.json()) as { description?: string }).description; } catch { /* ignore */ }
    throw new Error(`Telegram sendMessage failed: ${response.status} ${description ?? response.statusText}`);
  }
}
