import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { errorMessage } from "../utils.js";
import type { Database } from "../data/memory/schema.js";
import { getAllThreads } from "../data/memory/thread-registry.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.service.js";
import { getDashboardSessions } from "../sessions.js";

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const LOGS_DIR = join(BASE_DIR, "logs");
const PIDS_DIR = join(BASE_DIR, "pids");

export const PENDING_TASKS_DIR = join(BASE_DIR, "pending-tasks");
export const PROCESS_BASE_DIR = BASE_DIR;
export const PROCESS_LOGS_DIR = LOGS_DIR;
export const THREAD_LOGS_DIR = join(LOGS_DIR, "threads");
export const PROCESS_PIDS_DIR = PIDS_DIR;

export interface SpawnedThread {
  pid: number;
  threadId: number;
  name: string;
  startedAt: number;
  createdAt: number;
  logFile: string;
  memorySourceThreadId?: number;
  memoryTargetThreadId?: number;
  threadType?: "worker" | "branch";
}

interface PidFileEntry {
  threadId: number;
  pid: number;
  filePath: string;
  name?: string;
  threadType?: "worker" | "branch";
  startedAt?: number;
}

export const spawnedThreads: SpawnedThread[] = [];

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: unknown) {
    // EPERM = the process exists but we lack permission to signal it (still
    // alive). Anything else (ESRCH) = no such process.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  // process.kill(pid, 0) succeeded. On Windows this ALSO returns true for a
  // process that has already TERMINATED but whose PID is still held open by a
  // lingering handle — a kernel "zombie" (e.g. a CLI child wedged in unread-pipe
  // I/O that taskkill marked for death but the kernel hasn't reaped). That made
  // the keeper treat an unkillable zombie as alive forever and never restart the
  // thread. Confirm against the authoritative process table, which excludes
  // terminated processes even while their PID lingers.
  if (process.platform === "win32") return isPidInWindowsTable(pid);
  return true;
}

const WIN_PID_SNAPSHOT_TTL_MS = 2000;

/** Authoritative Windows liveness check via the process table, which — unlike
 *  OpenProcess/process.kill(0) — does NOT list a terminated process whose PID is
 *  still held by a lingering handle. A single `tasklist` snapshot of ALL pids is
 *  taken at most once per TTL window and reused for every pid, so a sweep over
 *  many threads costs one spawn, not N, and never blocks the loop repeatedly. */
let winPidSnapshot: { pids: Set<number>; ts: number } | null = null;

function getWindowsPidSet(): Set<number> | null {
  const now = Date.now();
  if (winPidSnapshot && now - winPidSnapshot.ts < WIN_PID_SNAPSHOT_TTL_MS) return winPidSnapshot.pids;
  try {
    // /NH = no header, /FO CSV = quoted columns; PID is column 2: "image","PID",...
    const out = execFileSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf-8", windowsHide: true, timeout: 5000 });
    const pids = new Set<number>();
    for (const m of out.matchAll(/^"[^"]*","(\d+)"/gm)) pids.add(Number(m[1]));
    winPidSnapshot = { pids, ts: now };
    return pids;
  } catch (err) {
    log.debug(`[process] tasklist snapshot failed: ${errorMessage(err)} — assuming pids alive`);
    return null; // conservative: caller treats null as "can't confirm dead" → alive
  }
}

function isPidInWindowsTable(pid: number): boolean {
  const pids = getWindowsPidSet();
  if (pids === null) return true; // tasklist unavailable — never declare a real process dead
  return pids.has(pid);
}

export function readPidFiles(): PidFileEntry[] {
  const entries: PidFileEntry[] = [];
  try {
    for (const file of readdirSync(PIDS_DIR)) {
      if (!file.endsWith(".pid")) continue;
      try {
        const threadId = Number(file.replace(".pid", ""));
        const filePath = join(PIDS_DIR, file);
        const raw = readFileSync(filePath, "utf-8").trim();
        let pid: number;
        let name: string | undefined;
        let threadType: "worker" | "branch" | undefined;
        let startedAt: number | undefined;
        try {
          ({ pid, name, threadType, startedAt } = JSON.parse(raw) as { pid: number; name?: string; threadType?: "worker" | "branch"; startedAt?: number });
        } catch {
          pid = Number(raw);
        }
        if (Number.isFinite(threadId) && Number.isFinite(pid)) entries.push({ threadId, pid, filePath, name, threadType, startedAt });
      } catch (err) { log.debug(`[readPidFiles] Failed to read entry ${file}: ${errorMessage(err)}`); }
    }
  } catch (err) { log.warn(`[readPidFiles] Failed to read PIDS_DIR: ${errorMessage(err)}`); }
  return entries;
}

export function findAliveThread(threadId: number): SpawnedThread | undefined {
  for (let i = spawnedThreads.length - 1; i >= 0; i--) {
    const thread = spawnedThreads[i];
    if (thread.threadId !== threadId) continue;
    if (isProcessAlive(thread.pid)) return thread;
    log.warn(`[findAliveThread] Thread ${threadId} PID ${thread.pid} stale in spawnedThreads - removing`);
    spawnedThreads.splice(i, 1);
  }
  const pidEntry = readPidFiles().find((entry) => entry.threadId === threadId && isProcessAlive(entry.pid));
  if (!pidEntry) return undefined;
  const restored: SpawnedThread = { pid: pidEntry.pid, threadId, name: pidEntry.name ?? `Thread ${threadId}`, startedAt: pidEntry.startedAt ?? Date.now(), createdAt: pidEntry.startedAt ?? Date.now(), logFile: "", ...(pidEntry.threadType ? { threadType: pidEntry.threadType } : {}) };
  spawnedThreads.push(restored);
  log.info(`[findAliveThread] Restored thread ${threadId} PID=${pidEntry.pid} from PID file`);
  return restored;
}

export const isThreadRunning = (threadId: number): boolean => findAliveThread(threadId) !== undefined;

export function getActiveThreadIds(): number[] {
  // Workers are disposable and not eligible for reconnect — exclude them.
  const spawned = spawnedThreads
    .filter(t => t.threadType !== "worker" && isProcessAlive(t.pid))
    .map(t => t.threadId);
  // Also include threads from active MCP sessions (root threads that aren't
  // in spawnedThreads because they connected externally, not spawned by us).
  const sessionThreadIds = getDashboardSessions()
    .filter(s => s.status === "active" && s.threadId != null)
    .map(s => s.threadId!);
  return [...new Set([...spawned, ...sessionThreadIds])];
}

export function ensureDirs(): void {
  mkdirSync(PENDING_TASKS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(THREAD_LOGS_DIR, { recursive: true });
  mkdirSync(PIDS_DIR, { recursive: true });
  pruneOldThreadLogs();
}

/** Thread transcripts (logs/threads/*.json) are append-only debug artifacts with
 *  one file per thread per day. Nothing consumes them at runtime except the
 *  segfault tail (which only ever reads the current day's file), so old ones can
 *  be deleted freely. Without this they grow unbounded — they were the single
 *  largest disk consumer (hundreds of MB across months). Bound retention to a
 *  configurable window (default 14 days). Called from ensureDirs() (server
 *  startup and each spawn); once retention is in effect the dir stays small so
 *  the readdir/stat sweep is cheap. */
export function pruneOldThreadLogs(): void {
  const parsed = Number(process.env.THREAD_LOG_RETENTION_DAYS);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  try {
    for (const file of readdirSync(THREAD_LOGS_DIR)) {
      const full = join(THREAD_LOGS_DIR, file);
      try {
        if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++; }
      } catch { /* file vanished or locked — skip */ }
    }
    if (removed > 0) log.info(`[process] Pruned ${removed} thread transcript(s) older than ${days}d`);
  } catch (err) { log.debug(`[process] pruneOldThreadLogs failed: ${errorMessage(err)}`); }
}

/**
 * Check liveness of a thread directly via its PID file, bypassing the
 * spawnedThreads[] in-memory cache.  Returns the live PID, or undefined
 * if no PID file exists or the process is dead (stale file is deleted).
 */
export function findAliveThreadViaPidFile(threadId: number): number | undefined {
  const entry = readPidFiles().find((e) => e.threadId === threadId);
  if (!entry) return undefined;
  if (!isProcessAlive(entry.pid)) {
    try { unlinkSync(entry.filePath); } catch {}
    return undefined;
  }
  return entry.pid;
}

/**
 * Reconcile in-memory state (spawnedThreads[]) with the two authoritative
 * sources of truth at startup:
 *   - SQLite thread_registry (intent / configuration)
 *   - PID files on disk (OS evidence of running processes)
 *
 * Replaces the old restoreFromPidFiles() + cleanupStalePidFiles() pair.
 */
export function reconcileState(db: Database, threadLifecycle: ThreadLifecycleService): void {
  const pidEntries = readPidFiles();
  const dbThreadMap = new Map(
    getAllThreads(db)
      .filter((t) => ["active", "exited", "exiting", "spawning", "stuck"].includes(t.status))
      .map((t) => [t.threadId, t]),
  );

  // 1. Process each PID file: alive → populate spawnedThreads[], dead → clean up
  for (const pidEntry of pidEntries) {
    const dbThread = dbThreadMap.get(pidEntry.threadId);
    if (!dbThread) {
      // PID file references a thread with no DB record (very old orphan) — remove it
      log.warn(`[reconcileState] PID file for thread ${pidEntry.threadId} has no DB record — removing`);
      try { unlinkSync(pidEntry.filePath); } catch {}
      continue;
    }

    if (isProcessAlive(pidEntry.pid)) {
      // Alive: populate spawnedThreads[] if not already present
      if (!spawnedThreads.some((t) => t.threadId === pidEntry.threadId)) {
        spawnedThreads.push({
          pid: pidEntry.pid,
          threadId: pidEntry.threadId,
          name: pidEntry.name ?? dbThread.name,
          startedAt: pidEntry.startedAt ?? Date.now(),
          createdAt: pidEntry.startedAt ?? Date.now(),
          logFile: "",
          ...(pidEntry.threadType ? { threadType: pidEntry.threadType } : {}),
        });
        log.info(`[reconcileState] Restored thread ${pidEntry.threadId} PID=${pidEntry.pid} from PID file`);
      }
    } else {
      // Dead: clean up stale PID file and mark thread exited in DB if active
      try { unlinkSync(pidEntry.filePath); } catch {}
      log.info(`[reconcileState] Cleaned stale PID file for thread ${pidEntry.threadId} (PID=${pidEntry.pid} dead)`);
      if (["active", "exiting", "spawning", "stuck"].includes(dbThread.status)) {
        try {
          threadLifecycle.markExited(db, pidEntry.threadId);
        } catch (err) {
          log.warn(`[reconcileState] markExited failed for thread ${pidEntry.threadId}: ${errorMessage(err)}`);
        }
      }
    }
  }

  // 2. Remove spawnedThreads[] entries that have no DB record
  for (let i = spawnedThreads.length - 1; i >= 0; i--) {
    const thread = spawnedThreads[i];
    if (!dbThreadMap.has(thread.threadId)) {
      log.warn(`[reconcileState] spawnedThreads has thread ${thread.threadId} with no DB record — removing`);
      spawnedThreads.splice(i, 1);
    }
  }
}

export function killProcessTree(pid: number, threadId: number): Promise<void> {
  return new Promise((resolve) => {
    const cleanupPidFile = () => {
      const pidFile = join(PROCESS_PIDS_DIR, `${threadId}.pid`);
      try { unlinkSync(pidFile); } catch {}
    };

    const verifyDead = (attempt: number) => {
      if (!isProcessAlive(pid)) {
        log.info(`[process] Killed process tree for thread ${threadId} PID=${pid}`);
        cleanupPidFile();
        resolve();
        return;
      }
      if (attempt >= 3) {
        log.warn(`[process] PID ${pid} (thread ${threadId}) still alive after ${attempt} kill attempts — NOT removing PID file`);
        resolve();
        return;
      }
      // Retry kill after a short delay
      log.warn(`[process] PID ${pid} (thread ${threadId}) still alive after kill attempt ${attempt} — retrying`);
      if (process.platform === "win32") {
        // Native TerminateProcess (via libuv) as well as taskkill — they take
        // different paths (taskkill is an external process with its own token;
        // process.kill issues the syscall directly from this process), so one
        // can succeed where the other fails on a stubborn process.
        try { process.kill(pid); } catch (err) { log.debug(`[process] native kill PID ${pid} failed: ${errorMessage(err)}`); }
        execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 10000, windowsHide: true }, () => {
          setTimeout(() => verifyDead(attempt + 1), 1000);
        });
      } else {
        try { process.kill(pid, "SIGKILL"); } catch {}
        setTimeout(() => verifyDead(attempt + 1), 1000);
      }
    };

    if (process.platform === "win32") {
      execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 10000, windowsHide: true }, (err) => {
        if (err) {
          log.warn(`[process] Kill process ${pid} (thread ${threadId}) failed: ${errorMessage(err)}`);
        }
        // Always verify — taskkill can report success but process lingers,
        // or report failure but process is actually dead.
        setTimeout(() => verifyDead(1), 500);
      });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        log.debug(`[process] Kill process ${pid} (thread ${threadId}): ${errorMessage(err)}`);
      }
      setTimeout(() => verifyDead(1), 500);
    }
  });
}
