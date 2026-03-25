/**
 * Thread lifecycle management: process spawning, PID tracking, and cleanup.
 *
 * Extracted from delegate-tool.ts to separate process-lifecycle concerns
 * from MCP tool-handler logic.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getClaudeMcpConfigPath } from "../config.js";
import { log } from "../logger.js";
import { errorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedThread {
  pid: number;
  threadId: number;
  name: string;
  startedAt: number;
  logFile: string;
}

// ---------------------------------------------------------------------------
// In-memory registry of spawned processes
// ---------------------------------------------------------------------------

const spawnedThreads: SpawnedThread[] = [];

/**
 * Check if a process with the given PID is still running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a spawned thread entry by threadId whose process is still alive.
 * Searches from the end of the array to find the most recently spawned entry.
 */
export function findAliveThread(threadId: number): SpawnedThread | undefined {
  for (let i = spawnedThreads.length - 1; i >= 0; i--) {
    const t = spawnedThreads[i];
    if (t.threadId === threadId && isProcessAlive(t.pid)) return t;
  }
  return undefined;
}

/**
 * Check if any tracked process is running for this threadId.
 */
export function isThreadRunning(threadId: number): boolean {
  return findAliveThread(threadId) !== undefined;
}

// ---------------------------------------------------------------------------
// Directory constants & helpers
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
export const PENDING_TASKS_DIR = join(BASE_DIR, "pending-tasks");
const LOGS_DIR = join(BASE_DIR, "logs");
const PIDS_DIR = join(BASE_DIR, "pids");

export function ensureDirs(): void {
  mkdirSync(PENDING_TASKS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(PIDS_DIR, { recursive: true });
}

/**
 * Resolve the MCP config path for the spawned Claude process.
 * Priority:
 *   1. CLAUDE_MCP_CONFIG env var
 *   2. Dashboard setting (claudeMcpConfigPath in settings.json)
 *   3. ~/.claude/settings.json
 *   4. ~/.claude/mcp_config.json
 *   5. ~/.claude/.mcp.json
 */
export function resolveMcpConfigPath(): string | null {
  const envPath = process.env.CLAUDE_MCP_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;

  const dashboardPath = getClaudeMcpConfigPath();
  if (dashboardPath && existsSync(dashboardPath)) return dashboardPath;

  const candidates = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "mcp_config.json"),
    join(homedir(), ".claude", ".mcp.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve the absolute path to the `claude` CLI executable.
 * Returns null if not found.  Uses where/which instead of execSync (L3).
 */
export function resolveClaudePath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["claude"], { timeout: 5000, encoding: "utf-8" });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0];
    }
  } catch { /* not found */ }
  return null;
}

// ---------------------------------------------------------------------------
// Spawn agent process
// ---------------------------------------------------------------------------

export function spawnAgentProcess(
  claudePath: string,
  mcpConfigPath: string,
  name: string,
  threadId: number,
): { pid: number; logFile: string } | { error: string } {
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFileName = `${safeName}_${threadId}_${dateStr}.json`;
  const logFilePath = join(LOGS_DIR, logFileName);

  const logFd = openSync(logFilePath, "a");

  // Use the original name (not safeName) in the prompt so the spawned agent
  // calls start_session with the exact name stored in the session registry.
  // safeName is only for filesystem-safe log filenames.
  const prompt = `Start remote session with sensorium. Thread name = '${name}'`;

  const cliArgs = [
    "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config", mcpConfigPath,
    "-p", prompt,
    "--output-format", "stream-json",
    "--include-partial-messages",
  ];

  // Use shell only when the resolved path is a Windows batch script (.cmd/.bat)
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);

  // On Windows, ensure CLAUDE_CODE_GIT_BASH_PATH is set for the child process.
  const spawnEnv = { ...process.env };
  if (process.platform === "win32" && !spawnEnv.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBashCandidates = [
      join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    for (const candidate of gitBashCandidates) {
      if (existsSync(candidate)) {
        spawnEnv.CLAUDE_CODE_GIT_BASH_PATH = candidate;
        log.info(`[start_thread] Auto-detected git-bash at ${candidate}`);
        break;
      }
    }
  }

  let child;
  try {
    child = spawn(claudePath, cliArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      shell: needsShell,
      windowsHide: true,
      env: spawnEnv,
    });
  } catch (err) {
    closeSync(logFd);
    return { error: `Failed to spawn Claude process: ${errorMessage(err)}` };
  }

  // Release the parent's copy of the log file descriptor
  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    return { error: "Claude process spawned but PID is undefined — spawn may have failed." };
  }

  // Write PID file for external process tracking
  const pidFilePath = join(PIDS_DIR, `${threadId}.pid`);
  try {
    writeFileSync(pidFilePath, String(pid), "utf-8");
  } catch (err) { log.debug(`[start_thread] Failed to write PID file: ${errorMessage(err)}`); }

  // Track spawned process
  const entry: SpawnedThread = {
    pid,
    threadId,
    name,
    startedAt: Date.now(),
    logFile: logFilePath,
  };
  spawnedThreads.push(entry);

  // Monitor process exit — clean up stale entries, PID file, and log health info
  child.on("exit", (code) => {
    const idx = spawnedThreads.indexOf(entry);
    if (idx !== -1) spawnedThreads.splice(idx, 1);
    try { unlinkSync(pidFilePath); } catch { /* already removed */ }
    log.info(`[start_thread] Claude process PID=${pid} for thread ${threadId} exited with code ${code}`);
  });

  // Unref so the parent process can exit without waiting for this child.
  child.unref();

  log.info(`[start_thread] Spawned Claude process PID=${pid} for thread ${threadId} ("${name}")`);

  return { pid, logFile: logFilePath };
}

// ---------------------------------------------------------------------------
// Stale PID cleanup
// ---------------------------------------------------------------------------

/**
 * Remove PID files for processes that are no longer running.
 * Called on server startup / before spawning new threads.
 */
export function cleanupStalePidFiles(): void {
  try {
    const files = readdirSync(PIDS_DIR);
    for (const file of files) {
      if (!file.endsWith(".pid")) continue;
      const filePath = join(PIDS_DIR, file);
      try {
        const pid = Number(readFileSync(filePath, "utf-8").trim());
        if (!isProcessAlive(pid)) {
          unlinkSync(filePath);
          log.info(`[cleanup] Removed stale PID file ${file} (pid ${pid})`);
        }
      } catch {
        // Corrupt or unreadable — remove it
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch { /* PIDS_DIR may not exist yet */ }
}
