import { archiveNotesForThread } from "../data/memory/semantic.js";
import { getExplicitTelegramTopicId } from "../data/memory/thread-registry.js";
import { synthesizeGhostMemory } from "../memory.js";
import { errorMessage } from "../utils.js";
import { spawnedThreads, type SpawnedThread } from "./process.service.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.service.js";
import { log } from "../logger.js";

const DEFAULT_WORKER_TTL_MS = 60 * 60 * 1000;

export async function cleanupExpiredWorkers(
  db: ReturnType<typeof import("../memory.js").initMemoryDb>,
  telegram: { deleteForumTopic(chatId: string, threadId: number): Promise<void> },
  chatId: string,
  threadLifecycle: ThreadLifecycleService,
  ttlMs: number = DEFAULT_WORKER_TTL_MS,
): Promise<{ cleaned: number; errors: string[] }> {
  const result = { cleaned: 0, errors: [] as string[] };
  const now = Date.now();
  for (const thread of spawnedThreads.filter((t) => t.threadType === "worker" && now - t.createdAt > ttlMs)) {
    try {
      await cleanupSingleWorker(thread, db, telegram, chatId, threadLifecycle);
      result.cleaned++;
    } catch (err) {
      result.errors.push(`Thread ${thread.threadId}: ${errorMessage(err)}`);
    }
  }
  try {
    const cutoff = new Date(now - ttlMs).toISOString();
    const staleRows = db.prepare(
      `SELECT thread_id FROM thread_registry
       WHERE type = 'worker' AND status IN ('active', 'exited') AND COALESCE(last_active_at, created_at) < ?`,
    ).all(cutoff) as { thread_id: number }[];
    for (const row of staleRows) {
      if (spawnedThreads.some((t) => t.threadId === row.thread_id)) continue;
      try {
        try {
          const topicId = getExplicitTelegramTopicId(db, row.thread_id);
          if (topicId != null) await telegram.deleteForumTopic(chatId, topicId);
        } catch {}
        threadLifecycle.archiveThread(db, row.thread_id);
        try { archiveNotesForThread(db, row.thread_id); } catch {}
        result.cleaned++;
      } catch (err) {
        const msg = `Thread ${row.thread_id}: ${errorMessage(err)}`;
        result.errors.push(msg);
        log.warn(`[worker-cleanup] Failed to archive stale DB worker: ${msg}`);
      }
    }
  } catch (err) {
    log.warn(`[worker-cleanup] Failed to query stale DB workers: ${errorMessage(err)}`);
  }
  return result;
}

async function cleanupSingleWorker(
  thread: SpawnedThread,
  db: ReturnType<typeof import("../memory.js").initMemoryDb>,
  telegram: { deleteForumTopic(chatId: string, threadId: number): Promise<void> },
  chatId: string,
  threadLifecycle: ThreadLifecycleService,
): Promise<void> {
  if (thread.memorySourceThreadId !== undefined) {
    try { await synthesizeGhostMemory(db, thread.threadId, thread.memorySourceThreadId, thread.name); } catch {}
  }
  try { process.kill(thread.pid, "SIGTERM"); } catch {}
  try {
    const topicId = getExplicitTelegramTopicId(db, thread.threadId);
    if (topicId != null) await telegram.deleteForumTopic(chatId, topicId);
  } catch {}
  try { threadLifecycle.archiveThread(db, thread.threadId); } catch {}
  try { archiveNotesForThread(db, thread.threadId); } catch {}
  const idx = spawnedThreads.indexOf(thread);
  if (idx !== -1) spawnedThreads.splice(idx, 1);
}
