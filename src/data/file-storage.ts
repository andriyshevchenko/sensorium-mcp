/**
 * File storage utilities — saving binary files to disk,
 * directory cleanup, and maintenance flag management.
 *
 * Extracted from config.ts during modular decomposition (phase 1).
 */

import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// ─── Maintenance flag ───────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), ".remote-copilot-mcp");
const MAINTENANCE_FLAG_PATH = join(DATA_DIR, "maintenance.flag");

/**
 * Check if a maintenance/update is pending.
 * The update watcher writes this file before restarting the server.
 * Returns the flag file content (version info) or null if no maintenance pending.
 */
export function checkMaintenanceFlag(): string | null {
  try {
    if (existsSync(MAINTENANCE_FLAG_PATH)) {
      return readFileSync(MAINTENANCE_FLAG_PATH, "utf-8").trim();
    }
  } catch { /* ignore read errors */ }
  return null;
}
