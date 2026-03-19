/**
 * Session management — persists Telegram topic → thread ID mappings
 * and tracks active MCP transport sessions per thread.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    process.stderr.write(
      `Warning: Could not save session map to ${SESSION_STORE_PATH}: ${errorMessage(err)}\n`,
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
