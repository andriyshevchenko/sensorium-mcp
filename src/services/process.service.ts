import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { errorMessage } from "../utils.js";
import type { Database } from "../data/memory/schema.js";
import { getAllThreads } from "../data/memory/thread-registry.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.service.js";

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const LOGS_DIR = join(BASE_DIR, "logs");
const PIDS_DIR = join(BASE_DIR, "pids");

export const PENDING_TASKS_DIR = join(BASE_DIR, "pending-tasks");
export const PROCESS_BASE_DIR = BASE_DIR;
export const PROCESS_LOGS_DIR = LOGS_DIR;
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
}

export const spawnedThreads: SpawnedThread[] = [];

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
        try {
          ({ pid, name } = JSON.parse(raw) as { pid: number; name?: string });
        } catch {
          pid = Number(raw);
        }
        if (Number.isFinite(threadId) && Number.isFinite(pid)) entries.push({ threadId, pid, filePath, name });
      } catch {}
    }
  } catch {}
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
  if (process.platform === "win32") {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pidEntry.pid}" /NH`, { encoding: "utf-8", timeout: 5000 });
      if (!out.includes(String(pidEntry.pid))) {
        try { unlinkSync(pidEntry.filePath); } catch {}
        return undefined;
      }
    } catch {}
  }
  const restored = { pid: pidEntry.pid, threadId, name: pidEntry.name ?? `Thread ${threadId}`, startedAt: Date.now(), createdAt: Date.now(), logFile: "" };
  spawnedThreads.push(restored);
  log.info(`[findAliveThread] Restored thread ${threadId} PID=${pidEntry.pid} from PID file`);
  return restored;
}

export const isThreadRunning = (threadId: number): boolean => findAliveThread(threadId) !== undefined;

export function ensureDirs(): void {
  mkdirSync(PENDING_TASKS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(PIDS_DIR, { recursive: true });
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
          startedAt: Date.now(),
          createdAt: Date.now(),
          logFile: "",
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

export function killProcessTree(pid: number, threadId: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 10000 });
    } else {
      process.kill(pid, "SIGTERM");
    }
    log.info(`[process] Killed process tree for thread ${threadId} PID=${pid}`);
  } catch (err) {
    log.debug(`[process] Kill process ${pid} (thread ${threadId}): ${errorMessage(err)}`);
  }
  const pidFile = join(PROCESS_PIDS_DIR, `${threadId}.pid`);
  try { unlinkSync(pidFile); } catch {}
}
