/**
 * Thread registry CRUD operations for the memory system.
 *
 * Manages the thread_registry SQLite table — tracks all threads
 * (root, daily, branch, worker) with their configuration and status.
 */

import type { Database } from "./schema.js";
import type { IThreadRepository } from "../interfaces.js";
import { nowISO } from "./utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ThreadRegistryEntry {
  id: number;
  threadId: number;
  name: string;
  type: 'root' | 'daily' | 'branch' | 'worker';
  rootThreadId: number | null;
  badge: string;
  client: string;
  maxRetries: number;
  cooldownMs: number;
  keepAlive: boolean;
  dailyRotation: boolean;
  autonomousMode: boolean;
  telegramTopicId: number | null;
  identityPrompt: string | null;
  workingDirectory: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  sessionResetAt: string | null;
  status: 'active' | 'archived' | 'expired' | 'exited';
  archivedAt: string | null;
  summary: string | null;
}

type RegisterThreadEntry = {
  threadId: number;
  name: string;
  type: ThreadRegistryEntry["type"];
  rootThreadId?: number;
  badge?: string;
  client?: string;
  maxRetries?: number;
  cooldownMs?: number;
  keepAlive?: boolean;
  dailyRotation?: boolean;
  workingDirectory?: string;
};

type UpdateThreadPatch = Partial<
  Pick<
    ThreadRegistryEntry,
    | "name"
    | "status"
    | "lastActiveAt"
    | "keepAlive"
    | "dailyRotation"
    | "autonomousMode"
    | "client"
    | "maxRetries"
    | "cooldownMs"
    | "badge"
    | "telegramTopicId"
    | "identityPrompt"
    | "workingDirectory"
  >
>;

export class ThreadRepository implements IThreadRepository {
  registerThread(db: Database, entry: RegisterThreadEntry): ThreadRegistryEntry {
    return registerThread(db, entry);
  }

  updateThread(db: Database, threadId: number, updates: UpdateThreadPatch): boolean {
    return updateThread(db, threadId, updates);
  }

  archiveThread(db: Database, threadId: number): boolean {
    return archiveThread(db, threadId);
  }

  getThread(db: Database, threadId: number): ThreadRegistryEntry | null {
    return getThread(db, threadId);
  }

  getAllThreads(db: Database): ThreadRegistryEntry[] {
    return getAllThreads(db);
  }

  getRootThreads(db: Database): ThreadRegistryEntry[] {
    return getRootThreads(db);
  }
}

export const threadRepository = new ThreadRepository();



// ─── Row Mapper ──────────────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): ThreadRegistryEntry {
  return {
    id: row.id as number,
    threadId: row.thread_id as number,
    name: row.name as string,
    type: row.type as ThreadRegistryEntry['type'],
    rootThreadId: (row.root_thread_id as number | null) ?? null,
    badge: row.badge as string,
    client: row.client as string,
    maxRetries: row.max_retries as number,
    cooldownMs: row.cooldown_ms as number,
    keepAlive: !!(row.keep_alive as number),
    dailyRotation: !!(row.daily_rotation as number),
    autonomousMode: !!(row.autonomous_mode as number),
    telegramTopicId: (row.telegram_topic_id as number | null) ?? null,
    identityPrompt: (row.identity_prompt as string | null) ?? null,
    workingDirectory: (row.working_directory as string | null) ?? null,
    createdAt: row.created_at as string,
    lastActiveAt: (row.last_active_at as string | null) ?? null,
    sessionResetAt: (row.session_reset_at as string | null) ?? null,
    status: row.status as ThreadRegistryEntry['status'],
    archivedAt: (row.archived_at as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function registerThread(
  db: Database,
  entry: RegisterThreadEntry,
): ThreadRegistryEntry {
  const now = nowISO();
  const dailyRotation = entry.dailyRotation ?? (entry.type === "root");
  db.prepare(
    `INSERT INTO thread_registry
       (thread_id, name, type, root_thread_id, badge, client, max_retries, cooldown_ms, keep_alive, daily_rotation, working_directory, created_at, last_active_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(thread_id) DO UPDATE SET
       name = excluded.name,
       type = CASE WHEN thread_registry.keep_alive = 1 THEN thread_registry.type ELSE excluded.type END,
       root_thread_id = excluded.root_thread_id,
       badge = excluded.badge,
       client = CASE WHEN thread_registry.keep_alive = 1 THEN thread_registry.client ELSE excluded.client END,
       max_retries = excluded.max_retries,
       cooldown_ms = excluded.cooldown_ms,
       keep_alive = CASE WHEN thread_registry.keep_alive = 1 THEN 1 ELSE excluded.keep_alive END,
       daily_rotation = CASE WHEN thread_registry.keep_alive = 1 THEN thread_registry.daily_rotation ELSE excluded.daily_rotation END,
       working_directory = COALESCE(excluded.working_directory, thread_registry.working_directory),
       last_active_at = excluded.last_active_at,
       status = 'active'`,
  ).run(
    entry.threadId,
    entry.name,
    entry.type,
    entry.rootThreadId ?? null,
    entry.badge ?? 'root',
    entry.client ?? 'claude',
    entry.maxRetries ?? 5,
    entry.cooldownMs ?? 300000,
    entry.keepAlive ? 1 : 0,
    dailyRotation ? 1 : 0,
    entry.workingDirectory ?? null,
    now,
    now,
  );

  const result = getThread(db, entry.threadId);
  if (!result) {
    throw new Error(`registerThread: failed to retrieve thread after insert (threadId=${entry.threadId})`);
  }
  return result;
}

export function getThread(db: Database, threadId: number): ThreadRegistryEntry | null {
  const row = db.prepare(
    `SELECT * FROM thread_registry WHERE thread_id = ?`,
  ).get(threadId) as Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}

export function getThreadByName(db: Database, name: string): ThreadRegistryEntry | null {
  const row = db.prepare(
    `SELECT * FROM thread_registry WHERE name = ? AND status = 'active' ORDER BY last_active_at DESC LIMIT 1`,
  ).get(name) as Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}

export function getThreadsByRoot(db: Database, rootThreadId: number): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry WHERE root_thread_id = ? ORDER BY created_at DESC`,
  ).all(rootThreadId) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getRootThreads(db: Database): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry WHERE type = 'root' AND status != 'archived' ORDER BY created_at DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getKeepAliveThreads(db: Database): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry WHERE keep_alive = 1 AND type != 'worker' AND status != 'archived' ORDER BY created_at DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getAllThreads(db: Database): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry ORDER BY last_active_at DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getActiveThreads(db: Database): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry WHERE status = 'active' ORDER BY last_active_at DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/** All non-archived threads — for dashboard display. */
export function getDashboardThreads(db: Database): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry WHERE status != 'archived' ORDER BY last_active_at DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function updateThread(
  db: Database,
  threadId: number,
  updates: UpdateThreadPatch,
): boolean {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
  if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
  if (updates.lastActiveAt !== undefined) { setClauses.push('last_active_at = ?'); params.push(updates.lastActiveAt); }
  if (updates.keepAlive !== undefined) { setClauses.push('keep_alive = ?'); params.push(updates.keepAlive ? 1 : 0); }
  if (updates.dailyRotation !== undefined) { setClauses.push('daily_rotation = ?'); params.push(updates.dailyRotation ? 1 : 0); }
  if (updates.autonomousMode !== undefined) { setClauses.push('autonomous_mode = ?'); params.push(updates.autonomousMode ? 1 : 0); }
  if (updates.client !== undefined) { setClauses.push('client = ?'); params.push(updates.client); }
  if (updates.maxRetries !== undefined) { setClauses.push('max_retries = ?'); params.push(updates.maxRetries); }
  if (updates.cooldownMs !== undefined) { setClauses.push('cooldown_ms = ?'); params.push(updates.cooldownMs); }
  if (updates.badge !== undefined) { setClauses.push('badge = ?'); params.push(updates.badge); }
  if (updates.telegramTopicId !== undefined) { setClauses.push('telegram_topic_id = ?'); params.push(updates.telegramTopicId); }
  if (updates.identityPrompt !== undefined) { setClauses.push('identity_prompt = ?'); params.push(updates.identityPrompt); }
  if (updates.workingDirectory !== undefined) { setClauses.push('working_directory = ?'); params.push(updates.workingDirectory); }

  if (setClauses.length === 0) return false;

  params.push(threadId);
  const result = db.prepare(
    `UPDATE thread_registry SET ${setClauses.join(', ')} WHERE thread_id = ?`,
  ).run(...params);
  return result.changes > 0;
}

export function archiveThread(db: Database, threadId: number): boolean {
  const result = db.prepare(
    `UPDATE thread_registry SET status = 'archived', keep_alive = 0, archived_at = ? WHERE thread_id = ?`,
  ).run(nowISO(), threadId);
  return result.changes > 0;
}

export function unarchiveThread(db: Database, threadId: number): boolean {
  const result = db.prepare(
    `UPDATE thread_registry SET status = 'active', archived_at = NULL WHERE thread_id = ? AND status = 'archived'`,
  ).run(threadId);
  return result.changes > 0;
}

export function getArchivedThreads(db: Database): ThreadRegistryEntry[] {
  const rows = db.prepare(
    `SELECT * FROM thread_registry WHERE status = 'archived' AND type != 'worker' ORDER BY archived_at DESC, last_active_at DESC`,
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function deleteThread(db: Database, threadId: number): boolean {
  const result = db.prepare(
    `DELETE FROM thread_registry WHERE thread_id = ?`,
  ).run(threadId);
  return result.changes > 0;
}

/**
 * Purge archived threads older than `maxAgeMs` (default 180 days).
 * Deletes the thread's associated data and registry entry.
 * Returns the number of threads purged.
 */
export function purgeOldArchivedThreads(db: Database, maxAgeMs = 180 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = db.prepare(
    `SELECT thread_id FROM thread_registry
     WHERE status = 'archived' AND last_active_at < ?`,
  ).all(cutoff) as { thread_id: number }[];

  if (rows.length === 0) return 0;

  const deleteEmbeddings = db.prepare(`DELETE FROM note_embeddings WHERE note_id IN (SELECT note_id FROM semantic_notes WHERE thread_id = ?)`);
  const deleteNarratives = db.prepare(`DELETE FROM temporal_narratives WHERE thread_id = ?`);
  const deleteVoiceSignatures = db.prepare(`DELETE FROM voice_signatures WHERE episode_id IN (SELECT episode_id FROM episodes WHERE thread_id = ?)`);
  const deleteNotes = db.prepare(`DELETE FROM semantic_notes WHERE thread_id = ?`);
  const deleteEpisodes = db.prepare(`DELETE FROM episodes WHERE thread_id = ?`);
  const deleteSentMessages = db.prepare(`DELETE FROM sent_messages WHERE thread_id = ?`);
  const deleteTopicRegistry = db.prepare(`DELETE FROM topic_registry WHERE thread_id = ?`);
  const deleteRegistry = db.prepare(`DELETE FROM thread_registry WHERE thread_id = ?`);

  db.transaction(() => {
    for (const { thread_id } of rows) {
      deleteEmbeddings.run(thread_id);
      deleteNarratives.run(thread_id);
      deleteVoiceSignatures.run(thread_id);
      deleteNotes.run(thread_id);
      deleteEpisodes.run(thread_id);
      deleteSentMessages.run(thread_id);
      deleteTopicRegistry.run(thread_id);
      deleteRegistry.run(thread_id);
    }
  })();

  return rows.length;
}

/**
 * Reset the daily session timestamp for a thread.
 * Sets session_reset_at = now, used by bootstrap to filter the message buffer.
 */
export function resetDailySession(db: Database, threadId: number): boolean {
  const result = db.prepare(
    `UPDATE thread_registry SET session_reset_at = ? WHERE thread_id = ?`,
  ).run(nowISO(), threadId);
  return result.changes > 0;
}

/**
 * Resolve the Telegram topic ID for a logical thread.
 * Returns telegram_topic_id if set, otherwise falls back to thread_id itself.
 */
export function resolveTelegramTopicId(db: Database, threadId: number): number {
  const row = db.prepare(
    `SELECT telegram_topic_id FROM thread_registry WHERE thread_id = ?`,
  ).get(threadId) as { telegram_topic_id: number | null } | undefined;
  return row?.telegram_topic_id ?? threadId;
}

/**
 * Returns the explicit telegram_topic_id for a thread, or null if not set.
 * Unlike resolveTelegramTopicId, does NOT fall back to threadId.
 * Use this for destructive operations (topic deletion) to avoid accidentally
 * deleting a root thread's topic when a worker's telegram_topic_id is NULL.
 */
export function getExplicitTelegramTopicId(db: Database, threadId: number): number | null {
  const row = db.prepare(
    `SELECT telegram_topic_id FROM thread_registry WHERE thread_id = ?`,
  ).get(threadId) as { telegram_topic_id: number | null } | undefined;
  return row?.telegram_topic_id ?? null;
}

/**
 * Backfill thread names from topic_registry for threads with empty/missing names.
 * Returns the number of threads updated.
 */
export function backfillMissingNames(db: Database): number {
  const result = db.prepare(
    `UPDATE thread_registry
     SET name = (
       SELECT tr.name FROM topic_registry tr
       WHERE tr.thread_id = thread_registry.thread_id
       LIMIT 1
     )
     WHERE (thread_registry.name IS NULL OR thread_registry.name = '')
       AND EXISTS (
         SELECT 1 FROM topic_registry tr
         WHERE tr.thread_id = thread_registry.thread_id AND tr.name IS NOT NULL AND tr.name != ''
       )`
  ).run();
  return result.changes;
}


