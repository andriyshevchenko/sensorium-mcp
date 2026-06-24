/**
 * File storage utilities — saving binary files to disk,
 * directory cleanup, and maintenance flag management.
 *
 * Extracted from config.ts during modular decomposition (phase 1).
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

// ─── File storage ───────────────────────────────────────────────────────────

export const FILES_DIR = join(homedir(), ".remote-copilot-mcp", "files");
mkdirSync(FILES_DIR, { recursive: true });

/**
 * Save a buffer to disk under FILES_DIR with a unique timestamped name.
 * Returns the absolute file path. Caps directory at 500 files by deleting oldest.
 */
export function saveFileToDisk(buffer: Buffer, filename: string): string {
  const ts = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const diskName = `${ts}-${safeName}`;
  const filePath = join(FILES_DIR, diskName);
  writeFileSync(filePath, buffer);

  // Cleanup: cap at 500 files
  try {
    const files = readdirSync(FILES_DIR)
      .map(f => ({ name: f, mtime: statSync(join(FILES_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    if (files.length > 500) {
      const toDelete = files.slice(0, files.length - 500);
      for (const f of toDelete) {
        try { unlinkSync(join(FILES_DIR, f.name)); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* non-fatal */ }

  return filePath;
}

// ─── Activity heartbeat ─────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const HEARTBEAT_PATH = join(DATA_DIR, "last-activity.txt");

/**
 * Write the current epoch timestamp to a heartbeat file.
 * The update watcher checks this before force-killing the server —
 * if a tool call happened recently, the kill is deferred.
 */
export function writeActivityHeartbeat(): void {
  writeFile(HEARTBEAT_PATH, String(Date.now()), "utf-8").catch(() => { /* non-fatal */ });
}

// ── Per-thread heartbeat ────────────────────────────────────────────────

const HEARTBEATS_DIR = join(DATA_DIR, "heartbeats");
mkdirSync(HEARTBEATS_DIR, { recursive: true });
// Clean up orphaned tmp files from previous crashes
try { for (const f of readdirSync(HEARTBEATS_DIR)) if (f.includes(".tmp.")) try { unlinkSync(join(HEARTBEATS_DIR, f)); } catch {} } catch {}
let hbSeq = 0;

// On Windows a concurrent reader (the keeper reading the heartbeat) or an AV
// scanner can hold the target file open WITHOUT share-delete for a few micro-
// seconds, making rename-over-existing fail with EPERM/EACCES/EBUSY. At the
// heartbeat write frequency (every tool call + poll loop ~2s) these transient
// collisions are inevitable. The lock clears in milliseconds, so retry briefly.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Synchronous sleep without busy-spinning the CPU (rare error-path only). */
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable — skip */ }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Write epoch timestamp for a specific thread. Called on every MCP tool call.
 *  Uses atomic write (tmp + rename) to prevent keeper from reading a truncated
 *  file, with retry + direct-write fallback so a transient Windows lock can't
 *  silently drop the heartbeat (a dropped heartbeat risks a false "stuck"). */
export function writeThreadHeartbeat(threadId: number): void {
  const target = join(HEARTBEATS_DIR, `${threadId}`);
  const tmp = target + `.tmp.${process.pid}.${++hbSeq}`;
  void commitHeartbeatAsync(threadId, tmp, target, String(Date.now()));
}

async function commitHeartbeatAsync(threadId: number, tmp: string, target: string, data: string): Promise<void> {
  try {
    await writeFile(tmp, data, "utf-8");
    for (let attempt = 1; ; attempt++) {
      try { await rename(tmp, target); return; }
      catch (err: any) {
        if (RENAME_RETRY_CODES.has(err?.code)) {
          if (attempt < 5) { await delay(4 * attempt); continue; }
          // Transient lock didn't clear in ~40ms. Do NOT truncate the live
          // target (that would risk a torn read → false "stuck"). The previous
          // heartbeat is only seconds old and still valid; the next beat (~2s)
          // retries once the lock clears.
          log.debug(`[heartbeat] Rename contended for thread ${threadId} (${attempt} attempts) — keeping prior heartbeat`);
        } else {
          log.debug(`[heartbeat] Async write failed for thread ${threadId}: ${err instanceof Error ? err.message : err}`);
        }
        try { await unlink(tmp); } catch {}
        return;
      }
    }
  } catch (err) {
    log.debug(`[heartbeat] Async write failed for thread ${threadId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Synchronous heartbeat write — guarantees the file is flushed before returning.
 *  Used at spawn time and in the poll loop to prevent false zombie detection. */
export function writeThreadHeartbeatSync(threadId: number): void {
  const target = join(HEARTBEATS_DIR, `${threadId}`);
  const tmp = target + `.tmp.${process.pid}.${++hbSeq}`;
  const data = String(Date.now());
  try {
    writeFileSync(tmp, data, "utf-8");
    for (let attempt = 1; ; attempt++) {
      try { renameSync(tmp, target); return; }
      catch (err: any) {
        if (RENAME_RETRY_CODES.has(err?.code)) {
          if (attempt < 5) { sleepSync(4 * attempt); continue; }
          // Transient lock persisted — keep the prior (seconds-old, valid)
          // heartbeat rather than truncating the live target; the next beat
          // retries. Never risks a torn read that could trip a false "stuck".
          log.debug(`[heartbeat] Rename contended for thread ${threadId} (${attempt} attempts) — keeping prior heartbeat`);
        } else {
          log.warn(`[heartbeat] Write failed for thread ${threadId}: ${err instanceof Error ? err.message : err}`);
        }
        try { unlinkSync(tmp); } catch {}
        return;
      }
    }
  } catch (err) {
    log.warn(`[heartbeat] Write failed for thread ${threadId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Read the last heartbeat epoch for a thread. Returns null if no heartbeat. */
export function readThreadHeartbeat(threadId: number): number | null {
  try {
    const raw = readFileSync(join(HEARTBEATS_DIR, `${threadId}`), "utf-8").trim();
    const ts = parseInt(raw, 10);
    return Number.isFinite(ts) ? ts : null;
  } catch (err: any) { if (err?.code !== "ENOENT") log.debug(`[heartbeat] Read failed for thread ${threadId}: ${err}`); return null; }
}

/** Delete a thread's heartbeat file. Called when a tracked process exits so a
 *  stale (spawn-time or last-activity) heartbeat can't make a dead thread look
 *  alive — which would otherwise block the keeper's restart. A live worker that
 *  is still serving the thread simply rewrites the heartbeat within ~2s. */
export function clearThreadHeartbeat(threadId: number): void {
  try {
    unlinkSync(join(HEARTBEATS_DIR, `${threadId}`));
  } catch (err: any) {
    if (err?.code !== "ENOENT") log.debug(`[heartbeat] Clear failed for thread ${threadId}: ${err}`);
  }
}

// ─── Maintenance flag ───────────────────────────────────────────────────────

const MAINTENANCE_FLAG_PATH = join(DATA_DIR, "maintenance.flag");

/** Maximum age of a maintenance flag before it is considered stale (5 minutes). */
const MAINTENANCE_FLAG_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Check if a maintenance/update is pending.
 * The update watcher writes this file before restarting the server.
 * Returns the flag file content (version info) or null if no maintenance pending.
 *
 * If the flag is older than 5 minutes it is assumed stale (the update watcher
 * failed to clean it up) and is automatically deleted.
 */
export function checkMaintenanceFlag(): string | null {
  try {
    if (existsSync(MAINTENANCE_FLAG_PATH)) {
      const raw = readFileSync(MAINTENANCE_FLAG_PATH, "utf-8").trim();

      // The flag file is JSON with { version, timestamp (ISO-8601) }.
      // Auto-clear if it has been sitting for too long.
      try {
        const parsed = JSON.parse(raw) as { timestamp?: string };
        if (parsed.timestamp) {
          const age = Date.now() - new Date(parsed.timestamp).getTime();
          if (age > MAINTENANCE_FLAG_MAX_AGE_MS) {
            log.warn(`Auto-clearing stale maintenance flag (age ${Math.round(age / 1000)}s): ${raw}`);
            try { unlinkSync(MAINTENANCE_FLAG_PATH); } catch { /* ignore */ }
            return null;
          }
        }
      } catch { /* Not valid JSON — fall through and return raw content */ }

      return raw;
    }
  } catch { /* ignore read errors */ }
  return null;
}
