/**
 * Session management — persists Telegram topic → thread ID mappings
 * and tracks active MCP transport sessions per thread.
 */

import type { Database } from "better-sqlite3";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import { errorMessage } from "./utils.js";

// ─── Session store (disk-backed name → threadId mapping) ────────────────────

const SESSION_STORE_PATH = join(homedir(), ".remote-copilot-mcp-sessions.json");

type SessionMap = Record<string, Record<string, number>>;

function loadSessionMap(): SessionMap {
  try {
    const raw = readFileSync(SESSION_STORE_PATH, "utf8");
    return JSON.parse(raw) as SessionMap;
  } catch {
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

export function registerMcpSession(
  threadId: number,
  mcpSessionId: string,
  closeTransport: () => void,
): void {
  const entries = threadSessionRegistry.get(threadId) ?? [];
  entries.push({ mcpSessionId, closeTransport });
  threadSessionRegistry.set(threadId, entries);
}

/**
 * Close all MCP sessions for a thread EXCEPT the current one.
 * Purges orphaned sessions from before a server restart.
 * Returns the number of sessions purged.
 */
export function purgeOtherSessions(threadId: number, keepMcpSessionId?: string): number {
  const entries = threadSessionRegistry.get(threadId) ?? [];
  let purged = 0;
  const kept: SessionRegistryEntry[] = [];
  for (const entry of entries) {
    if (entry.mcpSessionId === keepMcpSessionId) {
      kept.push(entry);
    } else {
      try { entry.closeTransport(); } catch (_) { /* best-effort */ }
      purged++;
    }
  }
  threadSessionRegistry.set(threadId, kept);
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
    log.debug(`[topic-registry] lookupTopicRegistry failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Register a topic name → threadId mapping in the registry. */
export function registerTopic(chatId: string, name: string, threadId: number): void {
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
    log.debug(`[topic-registry] getAllRegisteredTopics failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
