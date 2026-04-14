import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";

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
      const out = require("node:child_process").execSync(`tasklist /FI "PID eq ${pidEntry.pid}" /NH`, { encoding: "utf-8", timeout: 5000 });
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

export function cleanupStalePidFiles(): void {
  const entries = readPidFiles();
  if (entries.length === 0) return;
  const alive = new Set(entries.map((e) => e.pid).filter((pid) => isProcessAlive(pid)));
  for (const { pid, filePath } of entries) if (!alive.has(pid)) try { unlinkSync(filePath); } catch {}
}

export const pidDirExists = (): boolean => existsSync(PIDS_DIR);
