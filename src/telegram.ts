/**
 * Telegram Bot API client using native fetch.
 * No third-party HTTP client required.
 */

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

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

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface GetUpdatesResult {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

interface SendMessageResult {
  ok: boolean;
  result?: TelegramMessage;
  description?: string;
}

export interface ForumTopic {
  message_thread_id: number;
  name: string;
}

interface CreateForumTopicResult {
  ok: boolean;
  result?: ForumTopic;
  description?: string;
}

interface TelegramFile {
  file_id: string;
  file_path: string;
}

interface GetFileResult {
  ok: boolean;
  result?: TelegramFile;
  description?: string;
}

// ---------------------------------------------------------------------------
// Extension → MIME type mapping (used by downloadFileAsBase64)
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  zip: "application/zip",
  svg: "image/svg+xml",
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

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
  ): Promise<void> {
    const url = `${this.baseUrl}/${method}`;
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append(fieldName, blob, filename);
    if (options?.caption) formData.append("caption", options.caption);
    if (options?.threadId !== undefined) {
      formData.append("message_thread_id", String(options.threadId));
    }

    const response = await fetch(url, { method: "POST", body: formData });
    const data = await this.tryParseJson<SendMessageResult>(response);
    if (!response.ok || data?.ok !== true) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram ${method} failed: ${response.status} ${description}`);
    }
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
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const MAX_409_RETRIES = 12;
    const RETRY_DELAY_MS = 5000;

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url.toString(), signal ? { signal } : {});
      const data = await this.tryParseJson<GetUpdatesResult>(response);

      if (data === undefined) {
        process.stderr.write(
          "Failed to parse Telegram getUpdates response.\n",
        );
      }

      // 409 Conflict: another poller is running. Wait and retry.
      if (response.status === 409 && attempt < MAX_409_RETRIES) {
        process.stderr.write(
          `Telegram getUpdates 409 Conflict (attempt ${attempt + 1}/${MAX_409_RETRIES}) — ` +
          `another bot instance is polling. Retrying in ${RETRY_DELAY_MS / 1000}s...\n`,
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
      if (!data || !data.ok) {
        throw new Error(
          `Telegram API error in getUpdates${data?.description ? `: ${data.description}` : ""}`,
        );
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
    const response = await fetch(url, {
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
    if (threadId !== undefined) body.message_thread_id = threadId;

    const response = await fetch(url, {
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
  }

  /**
   * Get metadata for a file stored on Telegram servers.
   */
  async getFile(fileId: string): Promise<TelegramFile> {
    const url = `${this.baseUrl}/getFile`;
    const response = await fetch(url, {
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
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download Telegram file: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, filePath: file.file_path };
  }

  /**
   * Download a file from Telegram by file_id and return it as base64 with MIME type.
   */
  async downloadFileAsBase64(
    fileId: string,
  ): Promise<{ base64: string; mimeType: string }> {
    const { buffer, filePath } = await this.downloadFileAsBuffer(fileId);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    return {
      base64: buffer.toString("base64"),
      mimeType: MIME_MAP[ext] ?? "application/octet-stream",
    };
  }

  /** Send a document (file) to a chat. */
  async sendDocument(
    chatId: string,
    fileBuffer: Buffer,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    await this.sendMedia("sendDocument", chatId, "document",
      new Blob([new Uint8Array(fileBuffer)]), filename, { caption, threadId });
  }

  /** Send a photo to a chat. */
  async sendPhoto(
    chatId: string,
    imageBuffer: Buffer,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    await this.sendMedia("sendPhoto", chatId, "photo",
      new Blob([new Uint8Array(imageBuffer)]), filename, { caption, threadId });
  }

  /** Send a voice message (OGG Opus) to a chat. */
  async sendVoice(
    chatId: string,
    audioBuffer: Buffer,
    threadId?: number,
  ): Promise<void> {
    await this.sendMedia("sendVoice", chatId, "voice",
      new Blob([new Uint8Array(audioBuffer)]), "voice.ogg", { threadId });
  }

  /**
   * Set an emoji reaction on a message ("seen" indicator).
   * Non-throwing: silently ignores errors since reactions are non-critical UX.
   * Logs only the first failure to avoid flooding stderr in busy sessions.
   */
  private reactionWarned = false;

  async setMessageReaction(
    chatId: string,
    messageId: number,
    emoji: string = "\uD83D\uDC40",
  ): Promise<void> {
    try {
      const url = `${this.baseUrl}/setMessageReaction`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji }],
        }),
      });
      if (!response.ok && !this.reactionWarned) {
        this.reactionWarned = true;
        const data = await this.tryParseJson<{ description?: string }>(response);
        process.stderr.write(
          `[telegram] setMessageReaction failed: ${response.status} ${data?.description ?? response.statusText} (further failures suppressed)\n`,
        );
      }
    } catch (err) {
      if (!this.reactionWarned) {
        this.reactionWarned = true;
        process.stderr.write(
          `[telegram] setMessageReaction error: ${err instanceof Error ? err.message : String(err)} (further errors suppressed)\n`,
        );
      }
    }
  }
}
