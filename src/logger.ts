/**
 * File-based verbose logging utility.
 *
 * Writes to BOTH ~/.remote-copilot-mcp/server.log AND process.stderr
 * so existing stdio transport behaviour is preserved.
 *
 * Log rotation:
 *   - Daily: on startup, if server.log is from a previous day it is renamed to
 *     server.YYYY-MM-DD.log (using the file's mtime). Only the 7 most-recent
 *     daily archives are kept; older ones are deleted automatically.
 *   - Size: when the active server.log exceeds 5 MB it is renamed to
 *     server.YYYY-MM-DD.log (using today's date, with a counter suffix if that
 *     name already exists) and the same 7-file retention limit is applied.
 */

import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".remote-copilot-mcp", "logs", "mcp");
const LOG_FILE = join(LOG_DIR, "server.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_DAILY_ARCHIVES = 7;

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Format a Date as YYYY-MM-DD in local time. */
function dateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Return today's date stamp in local time. */
function todayStamp(): string {
  return dateStamp(new Date());
}

/**
 * Derive an archive path for a daily log.
 * If `server.YYYY-MM-DD.log` already exists a numeric suffix is appended
 * (server.YYYY-MM-DD.1.log, .2.log, …) to avoid clobbering an existing file.
 */
function archivePath(stamp: string): string {
  const base = join(LOG_DIR, `server.${stamp}.log`);
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = join(LOG_DIR, `server.${stamp}.${i}.log`);
    if (!existsSync(candidate)) return candidate;
  }
  // Fallback — extremely unlikely but avoids an infinite loop.
  return base;
}

/**
 * Delete all but the MAX_DAILY_ARCHIVES most-recent daily archive files
 * (files matching server.YYYY-MM-DD*.log in LOG_DIR).
 */
function pruneOldArchives(): void {
  try {
    const archives = readdirSync(LOG_DIR)
      .filter(f => /^server\.\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith(".log"))
      .map(f => ({ name: f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    const toDelete = archives.slice(0, Math.max(0, archives.length - MAX_DAILY_ARCHIVES));
    for (const f of toDelete) {
      try { unlinkSync(join(LOG_DIR, f.name)); } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

/**
 * Rotate server.log to a dated archive.
 * Resets trackedFileSize to 0 on success.
 */
function rotateTo(stamp: string): void {
  try {
    if (logStream) {
      const fd = (logStream as unknown as { fd?: number }).fd;
      logStream.destroy();
      logStream = null;
      // Synchronously release the FD so renameSync succeeds on Windows.
      if (typeof fd === "number") { try { closeSync(fd); } catch { /* already closed */ } }
    }
    renameSync(LOG_FILE, archivePath(stamp));
    trackedFileSize = 0;
    openLogStream();
    pruneOldArchives();
  } catch {
    // Non-fatal — keep appending if rotation fails.
    if (!logStream) openLogStream();
  }
}

/** Track current log file size in memory to avoid stat calls on every write. */
let trackedFileSize = 0;
let logDirEnsured = false;
let logStream: WriteStream | null = null;

function openLogStream(): void {
  logStream = createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });
  logStream.on("error", () => { /* non-fatal — stderr still works */ });
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  mkdirSync(LOG_DIR, { recursive: true });

  try {
    if (existsSync(LOG_FILE)) {
      const st = statSync(LOG_FILE);
      const fileDateStamp = dateStamp(new Date(st.mtimeMs));

      if (fileDateStamp !== todayStamp()) {
        // File is from a previous day — archive it before this session starts.
        rotateTo(fileDateStamp);
      } else {
        trackedFileSize = st.size;
      }
    }
  } catch { /* non-fatal */ }

  if (!logStream) openLogStream();
  logDirEnsured = true;
}

// Ensure log directory exists and perform startup daily rotation.
ensureLogDir();

// Best-effort flush on clean exit so tail-of-session lines aren't lost.
process.on("exit", () => {
  if (logStream) { try { logStream.end(); } catch { /* ignore */ } }
  if (telemetryStream) { try { telemetryStream.end(); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------
// Telemetry — lightweight append-only file for memory/perf diagnostics
// ---------------------------------------------------------------------------

const TELEMETRY_FILE = join(LOG_DIR, "telemetry.log");
let telemetryStream: WriteStream | null = null;

function openTelemetryStream(): void {
  telemetryStream = createWriteStream(TELEMETRY_FILE, { flags: "a", encoding: "utf8" });
  telemetryStream.on("error", () => { /* non-fatal */ });
}

openTelemetryStream();

/** Rotate log file if it exceeds MAX_LOG_SIZE. */
function rotateIfNeeded(): void {
  try {
    if (trackedFileSize >= MAX_LOG_SIZE) {
      rotateTo(todayStamp());
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
  // Gate DEBUG on stderr behind the DEBUG env var; all other levels always
  // appear on stderr. All levels are always written to the log file so that
  // post-mortem debugging has full context.
  if (level !== "DEBUG" || process.env.DEBUG) {
    process.stderr.write(line);
  }
  // Always write to log file (non-blocking via write stream).
  try {
    rotateIfNeeded();
    if (logStream) {
      logStream.write(line);
      trackedFileSize += Buffer.byteLength(line, "utf8");
    }
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
  /** Write to telemetry.log only (no stderr, no server.log). */
  telemetry(msg: string): void {
    if (telemetryStream) {
      telemetryStream.write(`[${new Date().toISOString()}] ${msg}\n`);
    }
  },
};
