/**
 * Telegram Bot API client using native fetch.
 * No third-party HTTP client required.
 */

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  date: number;
  message_thread_id?: number;
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
        `Telegram sendMessage failed: response body could not be parsed as JSON${
          parseError instanceof Error ? `: ${parseError.message}` : ""
        }`,
      );
    }
    if (data.ok !== true) {
      const description = data.description ?? "Unknown Telegram API error";
      throw new Error(`Telegram API error in sendMessage: ${description}`);
    }
  }
}
