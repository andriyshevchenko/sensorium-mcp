/**
 * Thread registry CRUD operations for the memory system.
 *
 * Manages the thread_registry SQLite table — tracks all threads
 * (root, daily, branch, worker) with their configuration and status.
 */

import type { Database } from "./schema.js";
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
}



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
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function registerThread(
  db: Database,
  entry: {
    threadId: number;
    name: string;
    type: ThreadRegistryEntry['type'];
    rootThreadId?: number;
    badge?: string;
    client?: string;
    maxRetries?: number;
    cooldownMs?: number;
    keepAlive?: boolean;
    workingDirectory?: string;
  },
): ThreadRegistryEntry {
  const now = nowISO();
  db.prepare(
    `INSERT INTO thread_registry
       (thread_id, name, type, root_thread_id, badge, client, max_retries, cooldown_ms, keep_alive, working_directory, created_at, last_active_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(thread_id) DO UPDATE SET
       name = excluded.name,
       type = CASE WHEN thread_registry.keep_alive = 1 THEN thread_registry.type ELSE excluded.type END,
       root_thread_id = excluded.root_thread_id,
       badge = excluded.badge,
       client = CASE WHEN thread_registry.keep_alive = 1 THEN thread_registry.client ELSE excluded.client END,
       max_retries = excluded.max_retries,
       cooldown_ms = excluded.cooldown_ms,
       keep_alive = CASE WHEN thread_registry.keep_alive = 1 THEN 1 ELSE excluded.keep_alive END,
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
    `SELECT * FROM thread_registry WHERE type = 'root' ORDER BY created_at DESC`,
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

export function updateThread(
  db: Database,
  threadId: number,
  updates: Partial<Pick<ThreadRegistryEntry, 'name' | 'status' | 'lastActiveAt' | 'keepAlive' | 'dailyRotation' | 'autonomousMode' | 'client' | 'maxRetries' | 'cooldownMs' | 'badge' | 'telegramTopicId' | 'identityPrompt' | 'workingDirectory'>>,
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
    `UPDATE thread_registry SET status = 'archived', keep_alive = 0 WHERE thread_id = ?`,
  ).run(threadId);
  return result.changes > 0;
}

export function deleteThread(db: Database, threadId: number): boolean {
  const result = db.prepare(
    `DELETE FROM thread_registry WHERE thread_id = ?`,
  ).run(threadId);
  return result.changes > 0;
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


