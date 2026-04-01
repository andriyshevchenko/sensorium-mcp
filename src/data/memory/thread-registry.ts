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
  },
): ThreadRegistryEntry {
  const now = nowISO();
  db.prepare(
    `INSERT INTO thread_registry
       (thread_id, name, type, root_thread_id, badge, client, max_retries, cooldown_ms, keep_alive, created_at, last_active_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(thread_id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       root_thread_id = excluded.root_thread_id,
       badge = excluded.badge,
       client = excluded.client,
       max_retries = excluded.max_retries,
       cooldown_ms = excluded.cooldown_ms,
       keep_alive = excluded.keep_alive,
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
  updates: Partial<Pick<ThreadRegistryEntry, 'name' | 'status' | 'lastActiveAt' | 'keepAlive' | 'client' | 'maxRetries' | 'cooldownMs' | 'badge'>>,
): boolean {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
  if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
  if (updates.lastActiveAt !== undefined) { setClauses.push('last_active_at = ?'); params.push(updates.lastActiveAt); }
  if (updates.keepAlive !== undefined) { setClauses.push('keep_alive = ?'); params.push(updates.keepAlive ? 1 : 0); }
  if (updates.client !== undefined) { setClauses.push('client = ?'); params.push(updates.client); }
  if (updates.maxRetries !== undefined) { setClauses.push('max_retries = ?'); params.push(updates.maxRetries); }
  if (updates.cooldownMs !== undefined) { setClauses.push('cooldown_ms = ?'); params.push(updates.cooldownMs); }
  if (updates.badge !== undefined) { setClauses.push('badge = ?'); params.push(updates.badge); }

  if (setClauses.length === 0) return false;

  params.push(threadId);
  const result = db.prepare(
    `UPDATE thread_registry SET ${setClauses.join(', ')} WHERE thread_id = ?`,
  ).run(...params);
  return result.changes > 0;
}

export function archiveThread(db: Database, threadId: number): boolean {
  const result = db.prepare(
    `UPDATE thread_registry SET status = 'archived' WHERE thread_id = ?`,
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


