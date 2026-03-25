/**
 * File-based verbose logging utility.
 *
 * Writes to BOTH ~/.remote-copilot-mcp/server.log AND process.stderr
 * so existing stdio transport behaviour is preserved.
 *
 * Log rotation: when the file exceeds 5 MB it is renamed to server.log.1
 * (overwriting any previous backup) and a fresh file is started.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".remote-copilot-mcp");
const LOG_FILE = join(LOG_DIR, "server.log");
const LOG_FILE_BACKUP = join(LOG_DIR, "server.log.1");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Track current log file size in memory to avoid stat calls on every write. */
let trackedFileSize = 0;
let logDirEnsured = false;

function ensureLogDir(): void {
  if (logDirEnsured) return;
  mkdirSync(LOG_DIR, { recursive: true });
  // Seed trackedFileSize from disk if the file already exists.
  try {
    if (existsSync(LOG_FILE)) {
      trackedFileSize = statSync(LOG_FILE).size;
    }
  } catch { /* non-fatal */ }
  logDirEnsured = true;
}

// Ensure log directory exists once at module init.
ensureLogDir();

/** Rotate log file if it exceeds MAX_LOG_SIZE. */
function rotateIfNeeded(): void {
  try {
    if (trackedFileSize >= MAX_LOG_SIZE) {
      renameSync(LOG_FILE, LOG_FILE_BACKUP);
      trackedFileSize = 0;
    }
  } catch {
    // Non-fatal — if rotation fails we keep appending.
  }
}

function formatLine(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}\n`;
}

function write(level: LogLevel, message: string): void {
  const line = formatLine(level, message);
  // Always write to stderr (preserves existing stdio behaviour).
  process.stderr.write(line);
  // Write to log file.
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line, "utf8");
    trackedFileSize += Buffer.byteLength(line, "utf8");
  } catch {
    // If file write fails we still wrote to stderr — don't crash.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const log = {
  debug(msg: string): void {
    write("DEBUG", msg);
  },
  info(msg: string): void {
    write("INFO", msg);
  },
  warn(msg: string): void {
    write("WARN", msg);
  },
  error(msg: string): void {
    write("ERROR", msg);
  },
  /**
   * Verbose tool-level logging.
   * @param category Short tag, e.g. "dispatcher", "memory", "voice".
   * @param msg Descriptive message.
   */
  verbose(category: string, msg: string): void {
    write("DEBUG", `[${category}] ${msg}`);
  },
};
