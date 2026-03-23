/**
 * Session management — persists Telegram topic → thread ID mappings
 * and tracks active MCP transport sessions per thread.
 */

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

export interface SessionRegistryEntry {
  mcpSessionId: string;
  closeTransport: () => void;
}

/** Thread → active MCP transport sessions */
export const threadSessionRegistry = new Map<number, SessionRegistryEntry[]>();

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

/** Dead session detection threshold — alert if no tool calls in this period. */
export const DEAD_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

// ─── Global dashboard session registry ──────────────────────────────────────
// Tracks ALL sessions (HTTP + STDIO) for dashboard visibility and GC.

export interface DashboardSessionInfo {
  mcpSessionId: string;
  threadId: number;
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
  threadId = 0,
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
export function updateDashboardThreadId(mcpSessionId: string, threadId: number): void {
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
