import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { archiveNotesForThread } from "../data/memory/semantic.js";
import { getExplicitTelegramTopicId } from "../data/memory/thread-registry.js";
import { synthesizeGhostMemory } from "../memory.js";
import { errorMessage } from "../utils.js";
import { spawnedThreads, type SpawnedThread, readPidFiles, PROCESS_PIDS_DIR } from "./process.service.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.service.js";
import { log } from "../logger.js";

function killProcessTree(pid: number, threadId: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 10000 });
    } else {
      process.kill(pid, "SIGTERM");
    }
    log.info(`[worker-cleanup] Killed process tree for thread ${threadId} PID=${pid}`);
  } catch (err) {
    // Process may already be dead — ignore
    log.debug(`[worker-cleanup] Kill process ${pid} (thread ${threadId}): ${errorMessage(err)}`);
  }
  const pidFile = join(PROCESS_PIDS_DIR, `${threadId}.pid`);
  try { unlinkSync(pidFile); } catch {}
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
    for (const row of staleRows) {
      if (spawnedThreads.some((t) => t.threadId === row.thread_id)) continue;
      try {
        const pidEntry = readPidFiles().find((e) => e.threadId === row.thread_id);
        if (pidEntry) killProcessTree(pidEntry.pid, row.thread_id);
        try {
          // For workers, thread_id IS the Telegram topic ID (created via createManagedTopic).
          // Use explicit telegram_topic_id if set, otherwise fall back to thread_id.
          const topicId = row.telegram_topic_id ?? row.thread_id;
          await telegram.deleteForumTopic(chatId, topicId);
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
  if (thread.memorySourceThreadId !== undefined) {
    try { await synthesizeGhostMemory(db, thread.threadId, thread.memorySourceThreadId, thread.name); } catch {}
  }
  killProcessTree(thread.pid, thread.threadId);
  try {
    const topicId = getExplicitTelegramTopicId(db, thread.threadId) ?? thread.threadId;
    await telegram.deleteForumTopic(chatId, topicId);
  } catch {}
  try { threadLifecycle.archiveThread(db, thread.threadId); } catch {}
  try { archiveNotesForThread(db, thread.threadId); } catch {}
  const idx = spawnedThreads.indexOf(thread);
  if (idx !== -1) spawnedThreads.splice(idx, 1);
}
