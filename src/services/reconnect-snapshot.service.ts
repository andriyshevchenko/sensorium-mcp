/**
 * Reconnect snapshot — persists active session thread IDs to disk before
 * server shutdown so the next server instance can skip the full memory
 * briefing for threads that were mid-session when the restart occurred.
 *
 * The snapshot is valid for 10 minutes.  After that it is either deleted
 * by the auto-cleanup timer or ignored (too old) by isReconnectCandidate.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const SNAPSHOT_PATH = join(DATA_DIR, "active-sessions.json");
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** Write via temp file + rename to prevent partial reads from concurrent access. */
function atomicWriteSnapshot(data: string): void {
  const tmp = `${SNAPSHOT_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, SNAPSHOT_PATH);
}

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
    atomicWriteSnapshot(JSON.stringify(snapshot, null, 2));
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
 *
 * Consume-on-use: the thread ID is removed from the snapshot after a
 * successful match so that each thread can only lightweight-reconnect
 * **once** per MCP restart.  This prevents a fresh agent process (crash,
 * keeper restart, compaction) from falsely matching within the 10-min window.
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
    if (!Array.isArray(snapshot.threadIds) || !snapshot.threadIds.includes(threadId)) {
      return false;
    }
    // Consume: remove this threadId so it can't match again
    snapshot.threadIds = snapshot.threadIds.filter(id => id !== threadId);
    try {
      if (snapshot.threadIds.length === 0) {
        unlinkSync(SNAPSHOT_PATH);
      } else {
        atomicWriteSnapshot(JSON.stringify(snapshot, null, 2));
      }
    } catch (writeErr) {
      log.warn(`[reconnect-snapshot] Matched thread ${threadId} but failed to persist consume: ${writeErr}`);
      // Still return true — the match was valid, and the 10-min TTL bounds the risk
    }
    log.info(`[reconnect-snapshot] Consumed reconnect slot for thread ${threadId}.`);
    return true;
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
