import { archiveNotesForThread } from "../data/memory/semantic.js";
import { getExplicitTelegramTopicId } from "../data/memory/thread-registry.js";
import { synthesizeGhostMemory } from "../memory.js";
import { errorMessage } from "../utils.js";
import { spawnedThreads, type SpawnedThread, readPidFiles, killProcessTree } from "./process.service.js";
import { ThreadState, type ThreadLifecycleService } from "./thread-lifecycle.service.js";
import { log } from "../logger.js";

export async function decommissionWorker(
  thread: { threadId: number; pid?: number; memorySourceThreadId?: number; name: string },
  deps: {
    db: ReturnType<typeof import("../memory.js").initMemoryDb>;
    telegram: { deleteForumTopic(chatId: string, threadId: number): Promise<void> };
    chatId: string;
    threadLifecycle: ThreadLifecycleService;
  },
): Promise<void> {
  // 0. Mark thread as Exiting so the state machine reflects teardown-in-progress
  try { deps.threadLifecycle.transitionThread(deps.db, thread.threadId, ThreadState.Exiting); } catch {}
  // 1. Memory synthesis (if ghost/worker with memory source)
  if (thread.memorySourceThreadId !== undefined) {
    try { await synthesizeGhostMemory(deps.db, thread.threadId, thread.memorySourceThreadId, thread.name); } catch (err) { log.warn(`[decommission] synthesizeGhostMemory failed for thread ${thread.threadId}: ${errorMessage(err)}`); }
  }
  // 2. Kill process (no-op if already dead)
  if (thread.pid !== undefined) {
    killProcessTree(thread.pid, thread.threadId);
  }
  // 3. Delete Telegram topic
  try {
    const topicId = getExplicitTelegramTopicId(deps.db, thread.threadId) ?? thread.threadId;
    await deps.telegram.deleteForumTopic(deps.chatId, topicId);
  } catch {}
  // 4. Archive notes
  try { archiveNotesForThread(deps.db, thread.threadId); } catch {}
  // 5. Archive thread in DB
  try { deps.threadLifecycle.archiveThread(deps.db, thread.threadId); } catch (err) { log.warn(`[decommission] archiveThread failed for thread ${thread.threadId}: ${errorMessage(err)}`); }
  // 6. Remove from spawnedThreads array
  const idx = spawnedThreads.findIndex((t) => t.threadId === thread.threadId);
  if (idx !== -1) spawnedThreads.splice(idx, 1);
}

const DEFAULT_WORKER_TTL_MS = 60 * 60 * 1000;
let orphanSweepDone = false;

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
      `SELECT thread_id, telegram_topic_id FROM thread_registry
       WHERE type = 'worker' AND status IN ('active', 'exited') AND COALESCE(last_active_at, created_at) < ?`,
    ).all(cutoff) as { thread_id: number; telegram_topic_id: number | null }[];
    const pidEntries = readPidFiles();
    for (const row of staleRows) {
      // Skip only if this thread is already tracked as a worker in spawnedThreads
      // (the in-memory loop above already handled it). Don't skip re-registered
      // entries that are missing threadType — those are the zombie workers we need to catch.
      if (spawnedThreads.some((t) => t.threadId === row.thread_id && t.threadType === "worker")) continue;
      try {
        const pidEntry = pidEntries.find((e) => e.threadId === row.thread_id);
        const inMemEntry = spawnedThreads.find((t) => t.threadId === row.thread_id);
        const killPid = pidEntry?.pid ?? inMemEntry?.pid;
        if (killPid) killProcessTree(killPid, row.thread_id);
        try {
          // For workers, thread_id IS the Telegram topic ID (created via createManagedTopic).
          // Use explicit telegram_topic_id if set, otherwise fall back to thread_id.
          const topicId = row.telegram_topic_id ?? row.thread_id;
          await telegram.deleteForumTopic(chatId, topicId);
        } catch {}
        threadLifecycle.archiveThread(db, row.thread_id);
        try { archiveNotesForThread(db, row.thread_id); } catch {}
        // Remove from in-memory registry if present (zombie re-registered at startup)
        const idx = spawnedThreads.findIndex((t) => t.threadId === row.thread_id);
        if (idx !== -1) spawnedThreads.splice(idx, 1);
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
  // One-time sweep: delete orphan Telegram topics for already-archived workers
  // (legacy bug: telegram_topic_id was not set at registration time).
  if (!orphanSweepDone) try {
    orphanSweepDone = true;
    const orphanRows = db.prepare(
      `SELECT thread_id, telegram_topic_id FROM thread_registry
       WHERE type = 'worker' AND status = 'archived'`,
    ).all() as { thread_id: number; telegram_topic_id: number | null }[];
    for (const row of orphanRows) {
      const topicId = row.telegram_topic_id ?? row.thread_id;
      try {
        await telegram.deleteForumTopic(chatId, topicId);
        result.cleaned++;
        log.info(`[worker-cleanup] Deleted orphan topic ${topicId} for archived worker ${row.thread_id}`);
      } catch {
        // Topic already deleted or invalid — ignore
      }
    }
  } catch (err) {
    log.warn(`[worker-cleanup] Failed to sweep orphan topics: ${errorMessage(err)}`);
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
  await decommissionWorker(thread, { db, telegram, chatId, threadLifecycle });
}
