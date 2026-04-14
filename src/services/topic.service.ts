import { persistSession, lookupSession, lookupTopicRegistry, registerTopic } from "../sessions.js";
import { updateThread } from "../data/memory/thread-registry.js";
import type { Database } from "../data/memory/schema.js";
import { errorMessage } from "../utils.js";
import { log } from "../logger.js";

type TopicTelegram = {
  createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number }>;
  sendMessage(chatId: string, text: string, parseMode?: string, threadId?: number): Promise<unknown>;
};

export async function createManagedTopic(
  telegram: TopicTelegram,
  chatId: string,
  topicName: string,
  aliases: string[] = [],
): Promise<number> {
  const topic = await telegram.createForumTopic(chatId, topicName);
  persistSession(chatId, topicName, topic.message_thread_id);
  registerTopic(chatId, topicName, topic.message_thread_id);
  for (const alias of aliases) {
    if (alias && alias !== topicName) persistSession(chatId, alias, topic.message_thread_id);
  }
  return topic.message_thread_id;
}

export function resolveExistingTopic(chatId: string, names: string[]): number | undefined {
  for (const name of names) {
    if (!name) continue;
    const registryId = lookupTopicRegistry(chatId, name);
    if (registryId !== undefined) {
      persistSession(chatId, name, registryId);
      return registryId;
    }
    const sessionId = lookupSession(chatId, name);
    if (sessionId !== undefined) return sessionId;
  }
  return undefined;
}

export async function probeOrRemapTopic(opts: {
  telegram: TopicTelegram;
  chatId: string;
  logicalThreadId: number;
  topicName: string;
  db: Database;
  aliases?: string[];
  probeText: string;
}): Promise<{ remapped: boolean }> {
  const { telegram, chatId, logicalThreadId, topicName, db, aliases = [], probeText } = opts;
  try {
    await telegram.sendMessage(chatId, probeText, undefined, logicalThreadId);
    return { remapped: false };
  } catch (err) {
    const msg = errorMessage(err);
    if (!/thread not found|topic.*(closed|deleted|not found)/i.test(msg)) return { remapped: false };
    log.warn(`[topic] Thread ${logicalThreadId} topic is dead (${msg}) - creating replacement.`);
    const newTopicId = await createManagedTopic(telegram, chatId, topicName, aliases);
    updateThread(db, logicalThreadId, { telegramTopicId: newTopicId });
    registerTopic(chatId, topicName, logicalThreadId);
    log.info(`[topic] Remapped thread ${logicalThreadId} -> topic ${newTopicId}`);
    return { remapped: true };
  }
}

export async function deleteTelegramTopicByBotApi(
  token: string,
  chatId: string,
  topicId: number,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: topicId }),
    signal: AbortSignal.timeout(10_000),
  });
}
