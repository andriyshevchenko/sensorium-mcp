/**
 * Centralized configuration — reads environment variables at startup
 * and exports validated values used throughout the codebase.
 */

import { createRequire } from "node:module";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./types.js";

const esmRequire = createRequire(import.meta.url);
const { version: PKG_VERSION } = esmRequire("../package.json") as { version: string };

// ─── Environment variables ──────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const VOICE_ANALYSIS_URL = process.env.VOICE_ANALYSIS_URL ?? "";

const rawWaitTimeoutMinutes = parseInt(process.env.WAIT_TIMEOUT_MINUTES ?? "", 10);
const WAIT_TIMEOUT_MINUTES = Math.max(1, Number.isFinite(rawWaitTimeoutMinutes) ? rawWaitTimeoutMinutes : 120);

// ─── Validation ─────────────────────────────────────────────────────────────

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  process.stderr.write("Error: TELEGRAM_TOKEN and TELEGRAM_CHAT_ID environment variables are required.\n");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  process.stderr.write("Warning: OPENAI_API_KEY not set — voice messages will not be transcribed.\n");
}
if (VOICE_ANALYSIS_URL) {
  process.stderr.write(`Voice analysis service configured: ${VOICE_ANALYSIS_URL}\n`);
}

// ─── File storage ───────────────────────────────────────────────────────────

const FILES_DIR = join(homedir(), ".remote-copilot-mcp", "files");
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

// ─── Exported config object ─────────────────────────────────────────────────

export const config: AppConfig = {
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  OPENAI_API_KEY,
  VOICE_ANALYSIS_URL,
  WAIT_TIMEOUT_MINUTES,
  FILES_DIR,
  PKG_VERSION,
};
