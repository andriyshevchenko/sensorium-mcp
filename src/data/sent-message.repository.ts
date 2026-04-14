import type { Database } from "./memory/schema.js";
import { errorMessage } from "../utils.js";
import { log } from "../logger.js";

export interface SentMessageRepository {
  saveThreadMessage(messageId: number, threadId: number): void;
  findThreadIdByMessageId(messageId: number): number | undefined;
}

export class SqliteSentMessageRepository implements SentMessageRepository {
  constructor(private readonly getDb: () => Database) {}

  saveThreadMessage(messageId: number, threadId: number): void {
    try {
      this.getDb()
        .prepare(`INSERT OR REPLACE INTO sent_messages (message_id, thread_id) VALUES (?, ?)`)
        .run(messageId, threadId);
    } catch (err) {
      log.debug(`[telegram] sent_messages write failed: ${errorMessage(err)}`);
    }
  }

  findThreadIdByMessageId(messageId: number): number | undefined {
    try {
      const row = this.getDb()
        .prepare(`SELECT thread_id FROM sent_messages WHERE message_id = ?`)
        .get(messageId) as { thread_id: number } | undefined;
      return row?.thread_id;
    } catch (err) {
      log.debug(`[telegram] sent_messages read failed: ${errorMessage(err)}`);
      return undefined;
    }
  }
}
