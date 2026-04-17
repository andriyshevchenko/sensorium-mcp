/**
 * Reconnect snapshot — persists active session thread IDs to disk before
 * server shutdown so the next server instance can skip the full memory
 * briefing for threads that were mid-session when the restart occurred.
 *
 * The snapshot is valid for 10 minutes.  After that it is either deleted
 * by the auto-cleanup timer or ignored (too old) by isReconnectCandidate.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const SNAPSHOT_PATH = join(DATA_DIR, "active-sessions.json");
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

interface ReconnectSnapshot {
  threadIds: number[];
  timestamp: string;
}

/**
 * Write the set of active thread IDs to the reconnect snapshot file.
 * Called just before the server process exits.
 */
export function writeReconnectSnapshot(threadIds: number[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const snapshot: ReconnectSnapshot = {
      threadIds,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
    log.info(
      `[reconnect-snapshot] Wrote snapshot with ${threadIds.length} thread(s): ${threadIds.join(", ")}`,
    );
  } catch (err) {
    log.warn(`[reconnect-snapshot] Failed to write snapshot: ${err}`);
  }
}

/**
 * Returns true if the given thread ID was active in the previous server
 * instance AND the snapshot is less than 10 minutes old.
 */
export function isReconnectCandidate(threadId: number): boolean {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return false;
    const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
    const snapshot = JSON.parse(raw) as ReconnectSnapshot;
    const age = Date.now() - new Date(snapshot.timestamp).getTime();
    if (age > SNAPSHOT_MAX_AGE_MS) {
      log.info(
        `[reconnect-snapshot] Snapshot too old (${Math.round(age / 1000)}s) — ignoring.`,
      );
      return false;
    }
    return Array.isArray(snapshot.threadIds) && snapshot.threadIds.includes(threadId);
  } catch {
    return false;
  }
}

/**
 * Delete the reconnect snapshot file.
 * Called 10 minutes after server start so stale snapshots don't persist
 * across multiple restarts.
 */
export function clearReconnectSnapshot(): void {
  try {
    if (existsSync(SNAPSHOT_PATH)) {
      unlinkSync(SNAPSHOT_PATH);
      log.info("[reconnect-snapshot] Snapshot cleared.");
    }
  } catch (err) {
    log.warn(`[reconnect-snapshot] Failed to clear snapshot: ${err}`);
  }
}
