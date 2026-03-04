/**
 * Telegram Bot API client using native fetch.
 * No third-party HTTP client required.
 */

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  date: number;
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
   * Send a text message to a chat.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const url = `${this.baseUrl}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
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
