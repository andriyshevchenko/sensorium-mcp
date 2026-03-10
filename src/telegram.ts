/**
 * Telegram Bot API client using native fetch.
 * No third-party HTTP client required.
 */

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

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

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

    // Retry loop: Telegram returns 409 when another getUpdates poller is active
    // (e.g. two VS Code windows with the same bot token). Back off and retry
    // until the other instance releases the lock or the request is aborted.
    const MAX_409_RETRIES = 12;
    const RETRY_DELAY_MS = 5000;

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url.toString(), signal ? { signal } : {});
      let data: GetUpdatesResult | undefined;
      try {
        data = (await response.json()) as GetUpdatesResult;
      } catch (parseErr) {
        process.stderr.write(
          `Failed to parse Telegram getUpdates response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n`,
        );
        data = undefined;
      }

      // 409 Conflict: another poller is running. Wait and retry.
      if (response.status === 409 && attempt < MAX_409_RETRIES) {
        process.stderr.write(
          `Telegram getUpdates 409 Conflict (attempt ${attempt + 1}/${MAX_409_RETRIES}) — ` +
          `another bot instance is polling. Retrying in ${RETRY_DELAY_MS / 1000}s...\n`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
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
   * @returns The created ForumTopic (contains message_thread_id).
   */
  async createForumTopic(chatId: string, name: string): Promise<ForumTopic> {
    const url = `${this.baseUrl}/createForumTopic`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, name }),
    });
    let data: CreateForumTopicResult | undefined;
    try {
      data = (await response.json()) as CreateForumTopicResult;
    } catch {
      data = undefined;
    }
    if (!response.ok || !data?.ok || !data.result) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram createForumTopic failed: ${description}`);
    }
    return data.result;
  }

  /**
   * Send a text message to a chat, optionally scoped to a forum topic thread.
   * @param parseMode  Optional parse mode. Telegram accepts "MarkdownV2", "Markdown", or "HTML".
   * @param threadId   Optional message_thread_id for forum supergroups.
   */
  async sendMessage(
    chatId: string,
    text: string,
    parseMode?: "MarkdownV2" | "Markdown" | "HTML",
    threadId?: number,
  ): Promise<void> {
    const url = `${this.baseUrl}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) {
      body.parse_mode = parseMode;
    }
    if (threadId !== undefined) {
      body.message_thread_id = threadId;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: SendMessageResult | undefined;
    let parseError: unknown;
    try {
      data = (await response.json()) as SendMessageResult;
    } catch (err) {
      parseError = err;
      data = undefined;
    }
    if (!response.ok) {
      const description = data?.description ?? response.statusText;
      throw new Error(
        `Telegram sendMessage failed: ${response.status} ${description}`,
      );
    }
    if (data === undefined) {
      throw new Error(
        `Telegram sendMessage failed: response body could not be parsed as JSON${parseError instanceof Error ? `: ${parseError.message}` : ""
        }`,
      );
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
    let data: GetFileResult | undefined;
    try {
      data = (await response.json()) as GetFileResult;
    } catch {
      data = undefined;
    }
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
   * Telegram Bot API supports files up to 20 MB.
   */
  async downloadFileAsBase64(
    fileId: string,
  ): Promise<{ base64: string; mimeType: string }> {
    const { buffer, filePath } = await this.downloadFileAsBuffer(fileId);
    const base64 = buffer.toString("base64");
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
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
    // Prefer Content-Type from the download response via the stored buffer path.
    const mimeType = mimeMap[ext] ?? "application/octet-stream";
    return { base64, mimeType };
  }

  /**
   * Send a document (file) to a chat via multipart/form-data.
   * @param fileBuffer  The file content as a Buffer.
   * @param filename    The filename to display in Telegram.
   * @param caption     Optional caption (plain text).
   * @param threadId    Optional message_thread_id for forum supergroups.
   */
  async sendDocument(
    chatId: string,
    fileBuffer: Buffer,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    const url = `${this.baseUrl}/sendDocument`;
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("document", new Blob([new Uint8Array(fileBuffer)]), filename);
    if (caption) formData.append("caption", caption);
    if (threadId !== undefined) formData.append("message_thread_id", String(threadId));

    const response = await fetch(url, { method: "POST", body: formData });
    let data: SendMessageResult | undefined;
    try {
      data = (await response.json()) as SendMessageResult;
    } catch {
      data = undefined;
    }
    if (!response.ok || data?.ok !== true) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram sendDocument failed: ${response.status} ${description}`);
    }
  }

  /**
   * Send a photo to a chat via multipart/form-data.
   * @param imageBuffer The image content as a Buffer.
   * @param filename    The filename (e.g. "screenshot.png").
   * @param caption     Optional caption.
   * @param threadId    Optional message_thread_id for forum supergroups.
   */
  async sendPhoto(
    chatId: string,
    imageBuffer: Buffer,
    filename: string,
    caption?: string,
    threadId?: number,
  ): Promise<void> {
    const url = `${this.baseUrl}/sendPhoto`;
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("photo", new Blob([new Uint8Array(imageBuffer)]), filename);
    if (caption) formData.append("caption", caption);
    if (threadId !== undefined) formData.append("message_thread_id", String(threadId));

    const response = await fetch(url, { method: "POST", body: formData });
    let data: SendMessageResult | undefined;
    try {
      data = (await response.json()) as SendMessageResult;
    } catch {
      data = undefined;
    }
    if (!response.ok || data?.ok !== true) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram sendPhoto failed: ${response.status} ${description}`);
    }
  }

  /**
   * Send a voice message (OGG Opus) to a chat.
   * @param audioBuffer  OGG Opus audio content.
   * @param threadId     Optional message_thread_id for forum supergroups.
   */
  async sendVoice(
    chatId: string,
    audioBuffer: Buffer,
    threadId?: number,
  ): Promise<void> {
    const url = `${this.baseUrl}/sendVoice`;
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("voice", new Blob([new Uint8Array(audioBuffer)]), "voice.ogg");
    if (threadId !== undefined) formData.append("message_thread_id", String(threadId));

    const response = await fetch(url, { method: "POST", body: formData });
    let data: SendMessageResult | undefined;
    try {
      data = (await response.json()) as SendMessageResult;
    } catch {
      data = undefined;
    }
    if (!response.ok || data?.ok !== true) {
      const description = data?.description ?? response.statusText;
      throw new Error(`Telegram sendVoice failed: ${response.status} ${description}`);
    }
  }

  /**
   * Convert text to speech using OpenAI TTS API.
   * Returns OGG Opus audio suitable for Telegram's sendVoice.
   */
  static async textToSpeech(
    text: string,
    apiKey: string,
    voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "nova",
  ): Promise<Buffer> {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: "opus",
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(
        `OpenAI TTS failed: ${response.status} ${errText}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Transcribe a voice message using OpenAI Whisper API.
   * @param fileId   Telegram file_id of the voice message.
   * @param apiKey   OpenAI API key.
   * @returns The transcribed text.
   */
  async transcribeVoice(fileId: string, apiKey: string): Promise<string> {
    const { buffer } = await this.downloadFileAsBuffer(fileId);
    // Telegram stores voice as .oga (OGG Opus). Whisper accepts .ogg but
    // not .oga, so we hardcode the extension.
    const filename = "voice.ogg";

    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(buffer)]), filename);
    formData.append("model", "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(
        `OpenAI Whisper transcription failed: ${response.status} ${errText}`,
      );
    }

    const result = (await response.json()) as { text?: string };
    return result.text ?? "";
  }
}
