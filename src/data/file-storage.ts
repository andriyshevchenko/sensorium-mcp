/**
 * File storage utilities — saving binary files to disk,
 * directory cleanup, and maintenance flag management.
 *
 * Extracted from config.ts during modular decomposition (phase 1).
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  try {
    writeFileSync(HEARTBEAT_PATH, String(Date.now()), "utf-8");
  } catch { /* non-fatal — watcher just won't see activity */ }
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
