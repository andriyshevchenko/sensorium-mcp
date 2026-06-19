/**
 * Session management — persists Telegram topic → thread ID mappings
 * and tracks active MCP transport sessions per thread.
 */

import type { Database } from "better-sqlite3";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ISessionRepository } from "./data/interfaces.js";
import { log } from "./logger.js";
import { errorMessage } from "./utils.js";

// ─── Session store (disk-backed name → threadId mapping) ────────────────────

const SESSION_STORE_PATH = join(homedir(), ".remote-copilot-mcp-sessions.json");

type SessionMap = Record<string, Record<string, number>>;

export class SessionRepository implements ISessionRepository {
  getSession(chatId: string, name: string): number | undefined {
    return lookupSession(chatId, name);
  }

  setSession(chatId: string, name: string, threadId: number): void {
    persistSession(chatId, name, threadId);
  }

  deleteSession(chatId: string, name: string): void {
    removeSession(chatId, name);
  }

  lookupTopicRegistry(chatId: string, name: string): number | undefined {
    return lookupTopicRegistry(chatId, name);
  }

  registerTopicRegistry(chatId: string, name: string, threadId: number): void {
    registerTopicRegistry(chatId, name, threadId);
  }
}

export const sessionRepository = new SessionRepository();

function loadSessionMap(): SessionMap {
  try {
    const raw = readFileSync(SESSION_STORE_PATH, "utf8");
    return JSON.parse(raw) as SessionMap;
  } catch (err: any) {
    if (err?.code !== "ENOENT") log.warn(`[sessions] Failed to load session map: ${err}`);
    return {};
  }
}

function saveSessionMap(map: SessionMap): void {
  try {
    const tmp = SESSION_STORE_PATH + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
    renameSync(tmp, SESSION_STORE_PATH);
  } catch (err) {
    log.warn(
      `Warning: Could not save session map to ${SESSION_STORE_PATH}: ${errorMessage(err)}`,
    );
  }
}

export function lookupSession(chatId: string, name: string): number | undefined {
  const map = loadSessionMap();
  return map[chatId]?.[name.toLowerCase()];
}

export function persistSession(chatId: string, name: string, threadId: number): void {
  const map = loadSessionMap();
  if (!map[chatId]) map[chatId] = {};
  map[chatId][name.toLowerCase()] = threadId;
  saveSessionMap(map);
}

export function removeSession(chatId: string, name: string): void {
  const map = loadSessionMap();
  if (map[chatId]) {
    delete map[chatId][name.toLowerCase()];
    saveSessionMap(map);
  }
}

// ─── MCP session registry (in-memory tracking of active transports) ─────────

interface SessionRegistryEntry {
  mcpSessionId: string;
  closeTransport: () => void;
}

/** Thread → active MCP transport sessions */
const threadSessionRegistry = new Map<number, SessionRegistryEntry[]>();
const sessionThreadRegistry = new Map<string, number>();
const expectedSessionCloses = new Set<string>();

/**
 * Sessions that have been superseded by a newer session for the same thread.
 * Any poll loop running under a superseded session should exit immediately
 * rather than consuming messages meant for the replacement session.
 * Entries are added on start_session ownership transfer (setThreadOwnerSession /
 * purgeOtherSessions) and on legacy reconnect-adoption. Cleared only on process
 * restart; with SSE reconnects this can reach the low hundreds/day across all
 * actively-polling threads — a few hundred small strings, negligible memory.
 *
 * NOTE: entries are "owner keys" (see ownerKey()), not raw transport session
 * ids — so superseding one identity covers all of its transport reconnects.
 */
const supersededSessions = new Set<string>();

/** The authoritative owner key for each thread (set during start_session). */
const threadOwnerSession = new Map<number, string>();

/**
 * Transport session id → per-process spawn token. The token is sent by the
 * agent on every request (including reconnects), giving a STABLE process
 * identity: a reconnect reuses the same token under a new session id, while a
 * genuine second process carries a different token.
 */
const sessionSpawnToken = new Map<string, string>();

/** Associate a transport session id with its per-process spawn token. */
export function associateSessionToken(mcpSessionId: string, spawnToken: string): void {
  // Write-once: a given transport session id must keep a stable identity. If a
  // later request presents a DIFFERENT token for the same session id (buggy or
  // hostile client), ignore it — flipping the key mid-session would falsely
  // supersede the live owner.
  const existing = sessionSpawnToken.get(mcpSessionId);
  if (existing !== undefined) {
    if (existing !== spawnToken) {
      log.warn(`[session] Ignoring conflicting spawn token for session ${mcpSessionId.slice(0, 8)}… (keeping first).`);
    }
    return;
  }
  sessionSpawnToken.set(mcpSessionId, spawnToken);
}

/**
 * Resolve the stable ownership key for a transport session id.
 * Prefers the per-process spawn token (survives reconnects); falls back to the
 * raw session id when no token is known (e.g. STDIO or pre-token agents), which
 * preserves the previous session-id-based behavior for those.
 */
function ownerKey(mcpSessionId: string): string {
  const token = sessionSpawnToken.get(mcpSessionId);
  return token ? `tok:${token}` : `sid:${mcpSessionId}`;
}

/** Check if a session has been superseded by a newer session for its thread. */
export function isSessionSuperseded(mcpSessionId: string | undefined, threadId?: number): boolean {
  if (mcpSessionId === undefined) return false;
  const key = ownerKey(mcpSessionId);
  if (supersededSessions.has(key)) {
    log.debug(`[session] superseded-check: ${key.slice(0, 12)}… is in the superseded set (thread ${threadId ?? "?"}).`);
    return true;
  }
  // A different identity owns this thread now. With token-based keys a reconnect
  // resolves to the SAME key as the owner, so this only fires for a genuinely
  // different process (or a legacy session-id whose transport changed) — the
  // poll loop running under the stale identity must stop.
  const resolvedThreadId = threadId ?? sessionThreadRegistry.get(mcpSessionId);
  if (resolvedThreadId !== undefined) {
    const owner = threadOwnerSession.get(resolvedThreadId);
    if (owner !== undefined && owner !== key) {
      log.debug(`[session] superseded-check: thread ${resolvedThreadId} owned by ${owner.slice(0, 12)}…, caller ${key.slice(0, 12)}… — superseded.`);
      return true;
    }
  }
  return false;
}

/**
 * Reconcile thread ownership for an incoming tool call and report whether the
 * caller may proceed.
 *
 * Returns true if the caller is superseded (a newer session owns the thread and
 * this one must stop). Returns false if the caller is the active owner —
 * claiming ownership when the thread is currently unowned.
 *
 * Identity is the per-process spawn token (ownerKey), which is STABLE across
 * transport reconnects. Therefore:
 *   - A reconnect of the owning process resolves to the SAME key → allowed,
 *     with no ownership change (fixes false-supersede-on-reconnect).
 *   - A genuinely different process (distinct spawn token) is REJECTED while a
 *     token-bearing owner holds the thread — ownership only transfers via
 *     start_session (setThreadOwnerSession), which supersedes the prior owner.
 *     This makes zombie / duplicate processes reliably detectable.
 *   - When token info is missing on either side (legacy/STDIO), fall back to the
 *     previous adoption behavior so those paths keep working.
 *
 * A caller that already owns a DIFFERENT thread may never adopt this one
 * (guards against a forged `threadId` argument hijacking another thread).
 */
export function reconcileThreadOwnership(
  mcpSessionId: string | undefined,
  threadId: number,
): boolean {
  if (mcpSessionId === undefined) return false;
  const key = ownerKey(mcpSessionId);
  if (supersededSessions.has(key)) {
    log.warn(`[session] Rejecting ${key.slice(0, 12)}… on thread ${threadId} — already superseded (zombie/evicted).`);
    return true;
  }
  const owner = threadOwnerSession.get(threadId);
  if (owner === key) return false;
  // Refuse cross-thread adoption: this identity already owns another thread.
  for (const [otherThreadId, otherOwner] of threadOwnerSession) {
    if (otherOwner === key && otherThreadId !== threadId) {
      log.warn(
        `[session] ${key.slice(0, 12)}… tried to act on thread ${threadId} but owns ${otherThreadId} — refused.`,
      );
      return true;
    }
  }
  if (owner !== undefined) {
    const bothTokens = key.startsWith("tok:") && owner.startsWith("tok:");
    if (bothTokens) {
      // Two distinct processes claim this thread. The owner was set by the most
      // recent start_session; this caller is a stale/zombie process. Reject —
      // do NOT steal ownership.
      log.warn(
        `[session] Thread ${threadId} owned by ${owner.slice(0, 12)}…; rejecting different process ${key.slice(0, 12)}… (zombie/duplicate).`,
      );
      return true;
    }
    // Legacy path (token missing on one side): cannot distinguish a reconnect
    // from a competing process — adopt as before, evicting the prior owner.
    supersededSessions.add(owner);
    log.warn(
      `[session] Thread ${threadId} ownership adopted by ${key.slice(0, 12)}… (was ${owner.slice(0, 12)}…) — legacy/no-token reconnect`,
    );
  } else {
    // First claim for a currently-unowned thread (fresh start or after restart).
    log.info(`[session] Thread ${threadId} ownership established by ${key.slice(0, 12)}….`);
  }
  threadOwnerSession.set(threadId, key);
  return false;
}

/** Mark a session as the sole owner for a thread. Old owners are superseded. */
export function setThreadOwnerSession(threadId: number, mcpSessionId: string): void {
  const key = ownerKey(mcpSessionId);
  const previous = threadOwnerSession.get(threadId);
  if (previous !== undefined && previous !== key) {
    // start_session is the explicit ownership-transfer signal (e.g. the keeper
    // spawned a replacement). Supersede the prior owner so its stale wait-loop
    // and any late writes — including reconnects under the old token — stop.
    supersededSessions.add(previous);
    log.info(`[session] Thread ${threadId} ownership transferred to ${key.slice(0, 12)}… (superseded ${previous.slice(0, 12)}…) via start_session.`);
  } else if (previous === undefined) {
    log.info(`[session] Thread ${threadId} owner set to ${key.slice(0, 12)}… via start_session.`);
  }
  // The new owner must not remain flagged from a prior life.
  supersededSessions.delete(key);
  threadOwnerSession.set(threadId, key);
}

export function registerMcpSession(
  threadId: number,
  mcpSessionId: string,
  closeTransport: () => void,
): void {
  const entries = threadSessionRegistry.get(threadId) ?? [];
  entries.push({ mcpSessionId, closeTransport });
  threadSessionRegistry.set(threadId, entries);
  sessionThreadRegistry.set(mcpSessionId, threadId);
  expectedSessionCloses.delete(mcpSessionId);
  log.debug(`[session] Registered transport ${mcpSessionId.slice(0, 8)}… for thread ${threadId} (${ownerKey(mcpSessionId).slice(0, 12)}…).`);
}

export function getThreadIdForMcpSession(mcpSessionId: string): number | undefined {
  return sessionThreadRegistry.get(mcpSessionId);
}

export function expectMcpSessionClose(mcpSessionId: string): void {
  expectedSessionCloses.add(mcpSessionId);
}

export function consumeExpectedMcpSessionClose(mcpSessionId: string): boolean {
  const expected = expectedSessionCloses.has(mcpSessionId);
  expectedSessionCloses.delete(mcpSessionId);
  return expected;
}

export function unregisterMcpSession(mcpSessionId: string): void {
  const threadId = sessionThreadRegistry.get(mcpSessionId);
  if (threadId !== undefined) {
    const entries = threadSessionRegistry.get(threadId) ?? [];
    const kept = entries.filter((entry) => entry.mcpSessionId !== mcpSessionId);
    if (kept.length > 0) {
      threadSessionRegistry.set(threadId, kept);
    } else {
      threadSessionRegistry.delete(threadId);
    }
  }
  sessionThreadRegistry.delete(mcpSessionId);
  expectedSessionCloses.delete(mcpSessionId);
  sessionSpawnToken.delete(mcpSessionId);
  log.debug(`[session] Unregistered transport ${mcpSessionId.slice(0, 8)}… (thread ${threadId ?? "?"}).`);
}

/**
 * Close all MCP sessions for a thread EXCEPT the current one.
 * Purges orphaned sessions from before a server restart.
 * Returns the number of sessions purged.
 */
export function purgeOtherSessions(threadId: number, keepMcpSessionId?: string): number {
  const entries = threadSessionRegistry.get(threadId) ?? [];
  const keepKey = keepMcpSessionId ? ownerKey(keepMcpSessionId) : undefined;
  let purged = 0;
  const kept: SessionRegistryEntry[] = [];
  for (const entry of entries) {
    if (entry.mcpSessionId === keepMcpSessionId) {
      kept.push(entry);
      continue;
    }
    // Resolve the identity BEFORE unregister clears its token mapping.
    const entryKey = ownerKey(entry.mcpSessionId);
    // Supersede only DIFFERENT processes. A stale transport of the SAME process
    // (a prior reconnect — same key as the keeper) is closed but never
    // superseded, otherwise we would evict the live owner.
    if (entryKey !== keepKey) {
      supersededSessions.add(entryKey);
      log.info(`[session] Purging session ${entry.mcpSessionId.slice(0, 8)}… (${entryKey.slice(0, 12)}…) from thread ${threadId} — superseded by start_session.`);
    } else {
      log.debug(`[session] Closing stale reconnect transport ${entry.mcpSessionId.slice(0, 8)}… of current owner on thread ${threadId}.`);
    }
    expectMcpSessionClose(entry.mcpSessionId);
    try {
      entry.closeTransport();
    } catch (err) {
      log.warn(`[session] closeTransport failed for ${entry.mcpSessionId.slice(0, 8)}… on thread ${threadId}: ${errorMessage(err)}`);
    }
    unregisterMcpSession(entry.mcpSessionId);
    purged++;
  }
  threadSessionRegistry.set(threadId, kept);
  if (keepMcpSessionId) sessionThreadRegistry.set(keepMcpSessionId, threadId);
  if (kept.length === 0) threadSessionRegistry.delete(threadId);
  return purged;
}

// ─── Global dashboard session registry ──────────────────────────────────────
// Tracks ALL sessions (HTTP + STDIO) for dashboard visibility and GC.

interface DashboardSessionInfo {
  mcpSessionId: string;
  threadId: number | null;
  transportType: "http" | "stdio";
  status: "active" | "disconnected";
  lastActivity: number;
  lastWaitCallAt: number | null;
  disconnectedAt: number | null;
}

const dashboardSessions = new Map<string, DashboardSessionInfo>();

/** Register a new session for dashboard tracking. */
export function registerDashboardSession(
  mcpSessionId: string,
  transportType: "http" | "stdio",
  threadId: number | null = null,
): void {
  dashboardSessions.set(mcpSessionId, {
    mcpSessionId,
    threadId,
    transportType,
    status: "active",
    lastActivity: Date.now(),
    lastWaitCallAt: null,
    disconnectedAt: null,
  });
}

/** Update the last activity timestamp for a session. */
export function updateDashboardActivity(mcpSessionId: string): void {
  const entry = dashboardSessions.get(mcpSessionId);
  if (entry) {
    entry.lastActivity = Date.now();
    entry.status = "active";
    entry.disconnectedAt = null;
  }
}

/** Update the threadId for a session (called after start_session resolves). */
export function updateDashboardThreadId(mcpSessionId: string, threadId: number | null): void {
  const entry = dashboardSessions.get(mcpSessionId);
  if (entry) {
    entry.threadId = threadId;
  }
}

/** Record a wait_for_instructions heartbeat. */
export function updateLastWaitCall(mcpSessionId: string): void {
  const entry = dashboardSessions.get(mcpSessionId);
  if (entry) {
    entry.lastWaitCallAt = Date.now();
    entry.lastActivity = Date.now();
    entry.status = "active";
    entry.disconnectedAt = null;
  }
}

/** Mark a session as disconnected. */
export function markDashboardSessionDisconnected(mcpSessionId: string): void {
  const entry = dashboardSessions.get(mcpSessionId);
  if (entry) {
    entry.status = "disconnected";
    entry.disconnectedAt = Date.now();
  }
}

/** Remove a session from dashboard tracking entirely. */
export function removeDashboardSession(mcpSessionId: string): void {
  dashboardSessions.delete(mcpSessionId);
}

/** Get all dashboard-tracked sessions. */
export function getDashboardSessions(): DashboardSessionInfo[] {
  return Array.from(dashboardSessions.values());
}

/** Grace period: a session is "truly alive" if lastWaitCallAt is within this. */
export const WAIT_LIVENESS_MS = 5 * 60 * 1000;

// ─── Topic registry (operator-managed name → threadId mapping) ──────────────
// Backed by the shared SQLite memory database (topic_registry table).
// Call setTopicRegistryDb() once at startup to wire up the DB accessor.

let topicDbGetter: (() => Database) | null = null;

/** Wire up a lazy database accessor for the topic registry. */
export function setTopicRegistryDb(getter: () => Database): void {
  topicDbGetter = getter;
}

function getTopicDb(): Database {
  if (!topicDbGetter) throw new Error("Topic registry DB not initialized — call setTopicRegistryDb() first");
  return topicDbGetter();
}

/** Look up a thread ID from the operator-managed topic registry. */
export function lookupTopicRegistry(chatId: string, name: string): number | undefined {
  try {
    const db = getTopicDb();
    const row = db.prepare(
      `SELECT thread_id FROM topic_registry WHERE chat_id = ? AND name = ?`
    ).get(chatId, name.toLowerCase()) as { thread_id: number } | undefined;
    return row?.thread_id;
  } catch (err) {
    log.debug(`[topic-registry] lookupTopicRegistry failed: ${errorMessage(err)}`);
    return undefined;
  }
}

/** Register a topic name → threadId mapping in the registry. */
export function registerTopic(chatId: string, name: string, threadId: number): void {
  registerTopicRegistry(chatId, name, threadId);
}

export function registerTopicRegistry(chatId: string, name: string, threadId: number): void {
  try {
    const db = getTopicDb();
    db.prepare(
      `INSERT OR REPLACE INTO topic_registry (chat_id, name, thread_id, registered_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(chatId, name.toLowerCase(), threadId);
  } catch (err) {
    log.warn(`[topic-registry] Failed to register topic: ${errorMessage(err)}`);
  }
}

/** Remove a topic from the registry. */
export function unregisterTopic(chatId: string, name: string): void {
  try {
    const db = getTopicDb();
    db.prepare(
      `DELETE FROM topic_registry WHERE chat_id = ? AND name = ?`
    ).run(chatId, name.toLowerCase());
  } catch (err) {
    log.warn(`[topic-registry] Failed to unregister topic: ${errorMessage(err)}`);
  }
}

/** Get all registered topics for a chat (or all chats if chatId is omitted). */
export function getAllRegisteredTopics(chatId?: string): Record<string, Record<string, number>> {
  try {
    const db = getTopicDb();
    const rows = chatId
      ? db.prepare(`SELECT chat_id, name, thread_id FROM topic_registry WHERE chat_id = ?`).all(chatId) as Array<{ chat_id: string; name: string; thread_id: number }>
      : db.prepare(`SELECT chat_id, name, thread_id FROM topic_registry`).all() as Array<{ chat_id: string; name: string; thread_id: number }>;

    const result: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      if (!result[row.chat_id]) result[row.chat_id] = {};
      result[row.chat_id][row.name] = row.thread_id;
    }
    return result;
  } catch (err) {
    log.debug(`[topic-registry] getAllRegisteredTopics failed: ${errorMessage(err)}`);
    return {};
  }
}
