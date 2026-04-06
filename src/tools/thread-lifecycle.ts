/**
 * Thread lifecycle management: process spawning, PID tracking, and cleanup.
 *
 * Extracted from delegate-tool.ts to separate process-lifecycle concerns
 * from MCP tool-handler logic.
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeMcpConfigPath } from "../config.js";
import { log } from "../logger.js";
import { getAllRegisteredTopics, getDashboardSessions, WAIT_LIVENESS_MS } from "../sessions.js";
import { synthesizeGhostMemory } from "../memory.js";
import { archiveThread, getAllThreads, getThread, resolveTelegramTopicId, updateThread, type ThreadRegistryEntry } from "../data/memory/thread-registry.js";
import { initMemoryDb } from "../data/memory/schema.js";
import { errorMessage } from "../utils.js";
import {
  COPILOT_HOME_DIR,
  DEFAULT_COPILOT_MODEL,
  writeCopilotHomeFiles,
} from "./shared-agent-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnedThread {
  pid: number;
  threadId: number;
  name: string;
  startedAt: number;
  createdAt: number;
  logFile: string;
  memorySourceThreadId?: number;
  memoryTargetThreadId?: number;
  threadType?: 'worker' | 'branch';
}

// ---------------------------------------------------------------------------
// In-memory registry of spawned processes
// ---------------------------------------------------------------------------

const spawnedThreads: SpawnedThread[] = [];

function parseTasklistPids(output: string): Set<number> {
  const alive = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^INFO:/i.test(trimmed)) continue;
    const match = trimmed.match(/\s+(\d+)\s+/);
    if (match) alive.add(Number(match[1]));
  }
  return alive;
}

/**
 * Check if a process with the given PID is still running.
 * Uses process.kill(pid, 0) which is non-blocking (microseconds).
 * On Windows, PID reuse is a theoretical risk but far less harmful than
 * the 1-5 second event-loop blocking that tasklist causes. The batch
 * getAlivePids() function still uses tasklist for startup restore where
 * accuracy matters more than latency.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
    if (t.threadId === threadId) {
      if (isProcessAlive(t.pid)) return t;
      log.warn(`[findAliveThread] Thread ${threadId} PID ${t.pid} in spawnedThreads but NOT alive — removing stale entry`);
      spawnedThreads.splice(i, 1);
    }
  }
  const pidEntry = readPidFiles().find((entry) => entry.threadId === threadId && isProcessAlive(entry.pid));
  if (!pidEntry) {
    log.debug(`[findAliveThread] Thread ${threadId}: not in spawnedThreads (${spawnedThreads.length} entries), not in PID files`);
    return undefined;
  }
  const restored: SpawnedThread = {
    pid: pidEntry.pid,
    threadId,
    name: pidEntry.name ?? `Thread ${threadId}`,
    startedAt: Date.now(),
    createdAt: Date.now(),
    logFile: "",
  };
  spawnedThreads.push(restored);
  return restored;
}

/**
 * Check if any tracked process is running for this threadId.
 */
export function isThreadRunning(threadId: number): boolean {
  return findAliveThread(threadId) !== undefined;
}

/**
 * Return a shallow copy of all in-memory spawned thread entries.
 */
function getAllSpawnedThreads(): SpawnedThread[] {
  return [...spawnedThreads];
}

// ---------------------------------------------------------------------------
// Directory constants & helpers
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
export const PENDING_TASKS_DIR = join(BASE_DIR, "pending-tasks");
const LOGS_DIR = join(BASE_DIR, "logs");
const PIDS_DIR = join(BASE_DIR, "pids");
const WATCHER_PORT = Number.parseInt(process.env.WATCHER_PORT || "3848", 10);

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
/**
 * Generate a per-thread MCP config that includes the sensorium-watcher server.
 * This allows ghost threads to call `await_server_ready` during server updates
 * instead of falling back to a blind 600s sleep.
 * Returns the path to the generated config, or the original path on failure.
 */
function generateThreadMcpConfig(baseConfigPath: string, threadId: number): string {
  const outPath = join(PIDS_DIR, `${threadId}-mcp-config.json`);
  try {
    const raw = readFileSync(baseConfigPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (!servers["sensorium-watcher"]) {
      servers["sensorium-watcher"] = {
        type: "http",
        url: `http://127.0.0.1:${WATCHER_PORT}/mcp`,
      };
      config.mcpServers = servers;
      mkdirSync(PIDS_DIR, { recursive: true });
      writeFileSync(outPath, JSON.stringify(config, null, 2), "utf-8");
      return outPath;
    }
    return baseConfigPath; // watcher already in config
  } catch (err) {
    log.warn(`[start_thread] Failed to generate merged MCP config for thread ${threadId}: ${errorMessage(err)}`);
    return baseConfigPath;
  }
}

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

/**
 * Resolve the absolute path to the `copilot` CLI executable.
 * Checks COPILOT_CLI_CMD env var first, then PATH. Returns null if not found.
 */
export function resolveCopilotPath(): string | null {
  const envCmd = process.env.COPILOT_CLI_CMD;
  if (envCmd) return envCmd;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["copilot"], { timeout: 5000, encoding: "utf-8" });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0];
    }
  } catch { /* not found */ }
  return null;
}

// ---------------------------------------------------------------------------
// Copilot home helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Codex home helpers
// ---------------------------------------------------------------------------

const CODEX_HOME_DIR = join(BASE_DIR, "codex-home");
// No hardcoded default — let the codex CLI pick its own default.
// Override via CODEX_MODEL env var if needed.
const DEFAULT_CODEX_MODEL = "";

/**
 * Resolve the absolute path to the `codex` CLI executable.
 * Checks CODEX_CLI_CMD env var first, then PATH. Returns null if not found.
 */
export function resolveCodexPath(): string | null {
  const envCmd = process.env.CODEX_CLI_CMD;
  if (envCmd) return envCmd;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["codex"], { timeout: 5000, encoding: "utf-8" });
    if (result.status === 0 && result.stdout) {
      const candidates = result.stdout.trim().split(/\r?\n/);
      // On Windows, prefer codex.cmd over the bare bash shim so that needsShell
      // is correctly set and stdio fd inheritance works (same pattern as claude.cmd).
      if (process.platform === "win32") {
        const cmdVariant = candidates.find(p => /\.cmd$/i.test(p));
        if (cmdVariant) return cmdVariant;
      }
      return candidates[0];
    }
  } catch { /* not found */ }
  return null;
}

/**
 * On Windows, Volta wraps codex in cmd→volta→cmd→node, breaking file descriptor
 * inheritance. Resolve node.exe + codex.js directly so we can spawn without any
 * Volta wrapper process in the chain.
 * Returns null if the paths cannot be found (fallback to codex.cmd).
 */
function resolveCodexNodeExe(): { nodeExe: string; codexJs: string } | null {
  if (process.platform !== "win32") return null;
  try {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const voltaImage = join(localAppData, "Volta", "tools", "image");

    // Find the codex.js script (stable path relative to Volta's image dir)
    const codexJs = join(voltaImage, "packages", "@openai", "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(codexJs)) return null;

    // Ask Volta for the node.exe path it would use (synchronous, fast)
    const voltaCmd = join(localAppData, "Volta", "bin", "volta.exe");
    const nodePathResult = spawnSync(voltaCmd, ["run", "node", "-e", "process.stdout.write(process.execPath)"], { encoding: "utf-8", timeout: 5000 });
    if (nodePathResult.status === 0 && nodePathResult.stdout?.trim()) {
      return { nodeExe: nodePathResult.stdout.trim(), codexJs };
    }

    // Fallback: pick the highest-version node from Volta's image dir
    const nodeDir = join(voltaImage, "node");
    if (existsSync(nodeDir)) {
      const versions = readdirSync(nodeDir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => {
        const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i]; }
        return 0;
      });
      for (const ver of versions) {
        const nodeExe = join(nodeDir, ver, "node.exe");
        if (existsSync(nodeExe)) return { nodeExe, codexJs };
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Resolve the native codex.exe binary installed by Volta.
 * Bypasses the codex.js Node.js wrapper and the entire Volta shim chain.
 * Returns null if the binary cannot be found.
 */
function resolveCodexExe(): string | null {
  if (process.platform !== "win32") return null;
  // Allow operator override via env var
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  try {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const nativeExe = join(
      localAppData, "Volta", "tools", "image", "packages", "@openai", "codex",
      "node_modules", "@openai", "codex",
      "node_modules", "@openai", "codex-win32-x64",
      "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe",
    );
    if (existsSync(nativeExe)) return nativeExe;
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Shared exit handler for all spawned processes
// ---------------------------------------------------------------------------

async function handleProcessExit(
  code: number | null,
  threadId: number,
  pid: number,
  pidFilePath: string,
  entry: SpawnedThread,
  processLabel: string,
): Promise<void> {
  const idx = spawnedThreads.indexOf(entry);
  if (idx !== -1) spawnedThreads.splice(idx, 1);
  try { unlinkSync(pidFilePath); } catch { /* already removed */ }

  // Update thread registry DB status
  try {
    const db = initMemoryDb();
    // Root, branch, and keepAlive threads stay 'active' so they remain visible on the dashboard
    // and the keeper can restart them. Only workers auto-exit.
    const existing = getThread(db, threadId);
    const newStatus = (existing?.keepAlive || existing?.type === 'root' || existing?.type === 'branch') ? 'active' : 'exited';
    updateThread(db, threadId, { status: newStatus, lastActiveAt: new Date().toISOString() });

    // Synthesize ghost thread outcomes back to parent
    if (entry.memorySourceThreadId !== undefined) {
      try {
        const result = await synthesizeGhostMemory(db, threadId, entry.memorySourceThreadId, entry.name);
        if (result.synthesizedNotes > 0 || result.synthesizedEpisode) {
          log.info(`[synthesis] Ghost ${threadId} → parent ${entry.memorySourceThreadId}: ${result.synthesizedNotes} notes, episode: ${result.synthesizedEpisode}`);
        }
      } catch (err) {
        log.warn(`[synthesis] Failed for ghost ${threadId}: ${errorMessage(err)}`);
      }
    }

    // Delete Telegram topic for completed worker threads (immediate cleanup)
    if (entry.threadType === 'worker') {
      try {
        const token = process.env.TELEGRAM_TOKEN || "";
        const chatId = process.env.TELEGRAM_CHAT_ID || "";
        if (token && chatId) {
          const topicId = resolveTelegramTopicId(db, threadId);
          await fetch(`https://api.telegram.org/bot${token}/deleteForumTopic`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_thread_id: topicId }),
            signal: AbortSignal.timeout(10_000),
          });
          log.info(`[cleanup] Deleted Telegram topic for worker ${threadId}`);
        }
      } catch { /* topic deletion is best-effort */ }
      // Archive the worker in the registry
      try { archiveThread(db, threadId); } catch { /* best-effort */ }
    }
  } catch (err) {
    log.warn(`[start_thread] Failed to update DB on exit for thread ${threadId}: ${errorMessage(err)}`);
  }

  log.info(`[start_thread] ${processLabel} process PID=${pid} for thread ${threadId} exited with code ${code}`);
}

// ---------------------------------------------------------------------------
// Spawn agent process
// ---------------------------------------------------------------------------

export function spawnAgentProcess(
  claudePath: string,
  mcpConfigPath: string,
  name: string,
  threadId: number,
  workingDirectory?: string,
  memorySourceThreadId?: number,
  memoryTargetThreadId?: number,
  threadType?: 'worker' | 'branch',
): { pid: number; logFile: string } | { error: string } {
  if (workingDirectory && !existsSync(workingDirectory)) {
    const fallback = tmpdir();
    log.warn(`workingDirectory "${workingDirectory}" does not exist, falling back to "${fallback}"`);
    workingDirectory = fallback;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFileName = `${safeName}_${threadId}_${dateStr}.json`;
  const logFilePath = join(LOGS_DIR, logFileName);

  const logFd = openSync(logFilePath, "a");

  // Generate a per-thread MCP config that includes sensorium-watcher for
  // graceful server-update reconnection (Issue A1 fix).
  const effectiveConfigPath = generateThreadMcpConfig(mcpConfigPath, threadId);

  // Use the original name (not safeName) in the prompt so the spawned agent
  // calls start_session with the exact name stored in the session registry.
  // safeName is only for filesystem-safe log filenames.
  const prompt = `Start remote session with sensorium. Thread name = '${name}'`;

  const cliArgs = [
    "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config", effectiveConfigPath,
    "-p", prompt,
    "--output-format", "stream-json",
    "--include-partial-messages",
  ];

  // Use shell only when the resolved path is a Windows batch script (.cmd/.bat)
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);

  // On Windows, ensure CLAUDE_CODE_GIT_BASH_PATH is set for the child process.
  const spawnEnv = { ...process.env };
  if (memorySourceThreadId !== undefined) {
    spawnEnv.MEMORY_SOURCE_THREAD_ID = String(memorySourceThreadId);
  }
  if (memoryTargetThreadId !== undefined) {
    spawnEnv.MEMORY_TARGET_THREAD_ID = String(memoryTargetThreadId);
  }
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
      cwd: workingDirectory || undefined,
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

  // Write PID file with metadata for tracking and re-spawn after updates
  const pidFilePath = join(PIDS_DIR, `${threadId}.pid`);
  try {
    const pidMeta = { pid, name, configPath: effectiveConfigPath, startedAt: Date.now() };
    writeFileSync(pidFilePath, JSON.stringify(pidMeta), "utf-8");
  } catch (err) { log.debug(`[start_thread] Failed to write PID file: ${errorMessage(err)}`); }

  // Track spawned process
  const entry: SpawnedThread = {
    pid,
    threadId,
    name,
    startedAt: Date.now(),
    createdAt: Date.now(),
    logFile: logFilePath,
    ...(memorySourceThreadId !== undefined ? { memorySourceThreadId } : {}),
    ...(memoryTargetThreadId !== undefined ? { memoryTargetThreadId } : {}),
    ...(threadType ? { threadType } : {}),
  };
  spawnedThreads.push(entry);

  // Monitor process exit — clean up stale entries, PID file, update DB, and log health info
  child.on("exit", (code) => handleProcessExit(code, threadId, pid, pidFilePath, entry, "Claude"));

  // Unref so the parent process can exit without waiting for this child.
  child.unref();

  log.info(`[start_thread] Spawned Claude process PID=${pid} for thread ${threadId} ("${name}")`);

  return { pid, logFile: logFilePath };
}

/**
 * Spawn a GitHub Copilot agent process for the given thread.
 * Writes Copilot home files (MCP config + system prompt) before spawning.
 * Requires MCP_HTTP_PORT env var to be set.
 */
export function spawnCopilotProcess(
  copilotPath: string,
  name: string,
  threadId: number,
  workingDirectory?: string,
  memorySourceThreadId?: number,
  agentType?: string,
  threadType?: 'worker' | 'branch',
): { pid: number; logFile: string } | { error: string } {
  const httpPort = parseInt(process.env.MCP_HTTP_PORT || "0", 10);
  if (!httpPort) {
    return { error: "MCP_HTTP_PORT env var is not set or invalid. Copilot threads require HTTP transport." };
  }
  const httpSecret = process.env.MCP_HTTP_SECRET || null;

  // Validate workingDirectory — a non-existent cwd causes ENOENT on spawn
  if (workingDirectory && !existsSync(workingDirectory)) {
    const fallback = tmpdir();
    log.warn(`workingDirectory "${workingDirectory}" does not exist, falling back to "${fallback}"`);
    workingDirectory = fallback;
  }

  const copilotHomeDir = join(BASE_DIR, COPILOT_HOME_DIR);
  writeCopilotHomeFiles(copilotHomeDir, httpPort, httpSecret);

  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFileName = `${safeName}_${threadId}_${dateStr}.json`;
  const logFilePath = join(LOGS_DIR, logFileName);

  const logFd = openSync(logFilePath, "a");

  const prompt = `Start remote session with sensorium. Thread name = '${name}'`;
  const copilotModel = agentType === "copilot_codex"
    ? "gpt-5.3-codex"
    : (process.env.COPILOT_MODEL || DEFAULT_COPILOT_MODEL);

  const cliArgs = [
    "-p", prompt,
    "--allow-all-tools",
    "--model", copilotModel,
    "--autopilot",
  ];

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: copilotHomeDir };
  if (memorySourceThreadId !== undefined) {
    spawnEnv.MEMORY_SOURCE_THREAD_ID = String(memorySourceThreadId);
  }

  // Use shell only when the resolved path is a Windows batch script (.cmd/.bat).
  // copilot.exe is a direct executable and does not need shell wrapping — shell
  // wrapping on Windows breaks stdio fd inheritance causing empty log files.
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(copilotPath);

  let child;
  try {
    child = spawn(copilotPath, cliArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      shell: needsShell,
      windowsHide: true,
      env: spawnEnv,
      cwd: workingDirectory || undefined,
    });
  } catch (err) {
    closeSync(logFd);
    return { error: `Failed to spawn Copilot process: ${errorMessage(err)}` };
  }

  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    return { error: "Copilot process spawned but PID is undefined — spawn may have failed." };
  }

  const pidFilePath = join(PIDS_DIR, `${threadId}.pid`);
  try {
    const pidMeta = { pid, name, configPath: copilotHomeDir, startedAt: Date.now() };
    writeFileSync(pidFilePath, JSON.stringify(pidMeta), "utf-8");
  } catch (err) { log.debug(`[start_thread] Failed to write PID file: ${errorMessage(err)}`); }

  const entry: SpawnedThread = {
    pid,
    threadId,
    name,
    startedAt: Date.now(),
    createdAt: Date.now(),
    logFile: logFilePath,
    ...(memorySourceThreadId !== undefined ? { memorySourceThreadId } : {}),
    ...(threadType ? { threadType } : {}),
  };
  spawnedThreads.push(entry);

  child.on("exit", (code) => handleProcessExit(code, threadId, pid, pidFilePath, entry, "Copilot"));

  child.unref();

  log.info(`[start_thread] Spawned Copilot process PID=${pid} for thread ${threadId} ("${name}")`);

  return { pid, logFile: logFilePath };
}

/**
 * Spawn an OpenAI Codex CLI agent process for the given thread.
 * Writes Codex home files (TOML config + AGENTS.md) before spawning.
 * Uses `codex exec` for non-interactive execution.
 * Requires MCP_HTTP_PORT env var to be set.
 */
export function spawnCodexProcess(
  codexPath: string,
  name: string,
  threadId: number,
  workingDirectory?: string,
  memorySourceThreadId?: number,
  threadType?: 'worker' | 'branch',
): { pid: number; logFile: string } | { error: string } {
  const httpPort = parseInt(process.env.MCP_HTTP_PORT || "0", 10);
  if (!httpPort) {
    return { error: "MCP_HTTP_PORT env var is not set or invalid. Codex threads require HTTP transport." };
  }
  const httpSecret = process.env.MCP_HTTP_SECRET || null;
  const httpMcpUrl = `http://127.0.0.1:${httpPort}/mcp`;

  // Validate workingDirectory — a non-existent cwd causes ENOENT on spawn
  // (error message misleadingly shows the binary path, not the bad cwd).
  if (workingDirectory && !existsSync(workingDirectory)) {
    const fallback = tmpdir();
    log.warn(`workingDirectory "${workingDirectory}" does not exist, falling back to "${fallback}"`);
    workingDirectory = fallback;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFileName = `${safeName}_${threadId}_${dateStr}.jsonl`;
  const logFilePath = join(LOGS_DIR, logFileName);

  const prompt =
    `You are an AUTONOMOUS AGENT running an INFINITE polling loop. You MUST NEVER STOP.\n\n` +
    `Step 1: Call start_session(name='${name}', agentType='codex'). Note the threadId from the result.\n` +
    `Step 2: Call remote_copilot_wait_for_instructions(threadId=<from step 1>).\n` +
    `Step 3: Read the response:\n` +
    `  - If it says "MANDATORY ACTION" or "No new instructions" — call remote_copilot_wait_for_instructions AGAIN immediately.\n` +
    `  - If you receive a task — complete it using your tools, then call remote_copilot_wait_for_instructions again.\n` +
    `Step 4: GOTO Step 2. This loop NEVER ends. You are NEVER done.\n\n` +
    `CRITICAL: "No new instructions" is NOT a signal to stop. It means "keep waiting". Always call the tool again.`;

  const codexModel = process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL;

  // Inject MCP server config via -c flags (avoids CODEX_HOME override which breaks auth).
  // Codex uses ~/.codex for auth — we must not redirect CODEX_HOME away from it.
  const mcpConfigArgs: string[] = [
    "-c", `mcp_servers.sensorium-mcp.url="${httpMcpUrl}"`,
    ...(httpSecret ? ["-c", `mcp_servers.sensorium-mcp.bearer_token_env_var="SENSORIUM_MCP_SECRET"`] : []),
  ];

  // Pass prompt via stdin ("-") to avoid shell quoting issues with multi-word prompts.
  const cliArgs = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    ...(codexModel ? ["-m", codexModel] : []),
    "--json",
    ...mcpConfigArgs,
    "-",
  ];

  if (workingDirectory) {
    cliArgs.splice(1, 0, "-C", workingDirectory);
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  if (memorySourceThreadId !== undefined) {
    spawnEnv.MEMORY_SOURCE_THREAD_ID = String(memorySourceThreadId);
  }
  // Forward MCP secret so codex's bearer_token_env_var can reference it
  if (httpSecret) {
    spawnEnv.SENSORIUM_MCP_SECRET = httpSecret;
  }

  const logFd = openSync(logFilePath, "a");
  let child;
  try {
    // Preferred: spawn the native codex.exe binary directly (no Volta wrapper chain).
    // Fallback: node.exe + codex.js (also bypasses Volta for fd inheritance).
    // Last resort: spawn codexPath directly (works on Mac/Linux).
    const nativeExe = resolveCodexExe();
    const nodeExeResult = !nativeExe && process.platform === "win32" && /\.(cmd|bat)$/i.test(codexPath)
      ? resolveCodexNodeExe()
      : null;

    if (nativeExe) {
      child = spawn(nativeExe, cliArgs, {
        detached: true,
        stdio: ["pipe", logFd, logFd],
        shell: false,
        windowsHide: true,
        env: spawnEnv,
        cwd: workingDirectory || undefined,
      });
    } else if (nodeExeResult) {
      const { nodeExe, codexJs } = nodeExeResult;
      const nodeArgs = [codexJs, ...cliArgs];
      child = spawn(nodeExe, nodeArgs, {
        detached: true,
        stdio: ["pipe", logFd, logFd],
        shell: false,
        windowsHide: true,
        env: spawnEnv,
        cwd: workingDirectory || undefined,
      });
    } else {
      child = spawn(codexPath, cliArgs, {
        detached: true,
        stdio: ["pipe", logFd, logFd],
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(codexPath),
        windowsHide: true,
        env: spawnEnv,
        cwd: workingDirectory || undefined,
      });
    }
  } catch (err) {
    closeSync(logFd);
    return { error: `Failed to spawn Codex process: ${errorMessage(err)}` };
  }

  closeSync(logFd);

  // Write prompt to stdin (codex reads it via the "-" arg) and close to signal EOF
  try {
    child.stdin?.write(prompt + "\n");
    child.stdin?.end();
  } catch { /* process may have already exited */ }

  const pid = child.pid;
  if (pid === undefined) {
    return { error: "Codex process spawned but PID is undefined — spawn may have failed." };
  }

  const pidFilePath = join(PIDS_DIR, `${threadId}.pid`);
  try {
    const pidMeta = { pid, name, configPath: CODEX_HOME_DIR, startedAt: Date.now() };
    writeFileSync(pidFilePath, JSON.stringify(pidMeta), "utf-8");
  } catch (err) { log.debug(`[start_thread] Failed to write PID file: ${errorMessage(err)}`); }

  const entry: SpawnedThread = {
    pid,
    threadId,
    name,
    startedAt: Date.now(),
    createdAt: Date.now(),
    logFile: logFilePath,
    ...(memorySourceThreadId !== undefined ? { memorySourceThreadId } : {}),
    ...(threadType ? { threadType } : {}),
  };
  spawnedThreads.push(entry);

  child.on("exit", (code) => handleProcessExit(code, threadId, pid, pidFilePath, entry, "Codex"));

  child.unref();

  log.info(`[start_thread] Spawned Codex process PID=${pid} for thread ${threadId} ("${name}")`);

  return { pid, logFile: logFilePath };
}

// ---------------------------------------------------------------------------
// Shared PID-file reader (used by cleanup + health report)
// ---------------------------------------------------------------------------

interface PidFileEntry {
  threadId: number;
  pid: number;
  filePath: string;
  /** Thread name from PID metadata (may be absent in legacy PID files). */
  name?: string;
}

/**
 * Read all PID files from the pids directory.
 * Supports both legacy (plain PID number) and new (JSON metadata) formats.
 */
export function readPidFiles(): PidFileEntry[] {
  const entries: PidFileEntry[] = [];
  try {
    const files = readdirSync(PIDS_DIR);
    for (const file of files) {
      if (!file.endsWith(".pid")) continue;
      try {
        const threadId = Number(file.replace(".pid", ""));
        const filePath = join(PIDS_DIR, file);
        const raw = readFileSync(filePath, "utf-8").trim();
        let pid: number;
        let name: string | undefined;
        try {
          const meta = JSON.parse(raw) as { pid: number; name?: string };
          pid = meta.pid;
          name = meta.name;
        } catch {
          // Legacy format: plain PID number
          pid = Number(raw);
        }
        if (Number.isFinite(threadId) && Number.isFinite(pid)) {
          entries.push({ threadId, pid, filePath, name });
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* PIDS_DIR may not exist */ }
  return entries;
}

// ---------------------------------------------------------------------------
// Stale PID cleanup
// ---------------------------------------------------------------------------

/**
 * Remove PID files for processes that are no longer running.
 * Called on server startup / before spawning new threads.
 * Uses a single batch check instead of N sequential calls to avoid
 * WMI/tasklist hangs multiplying across all tracked PIDs.
 */
export function cleanupStalePidFiles(): void {
  const entries = readPidFiles();
  if (entries.length === 0) return;
  const alivePids = getAlivePids(entries.map(e => e.pid));
  for (const { pid, filePath } of entries) {
    if (!alivePids.has(pid)) {
      try {
        unlinkSync(filePath);
        log.info(`[cleanup] Removed stale PID file ${filePath} (pid ${pid})`);
      } catch { /* already removed */ }
    }
  }
}

/**
 * Restore spawnedThreads from PID files for processes still alive.
 * Call after cleanupStalePidFiles() on server startup so that
 * isThreadRunning() returns true for processes that survived a restart.
 */
export function restoreSpawnedThreadsFromPids(): number {
  const pidEntries = readPidFiles();
  if (pidEntries.length === 0) return 0;

  // Batch-check all PIDs at once to avoid N sequential tasklist calls
  const alivePids = getAlivePids(pidEntries.map(e => e.pid));
  let restored = 0;

  for (const { threadId, pid, name } of pidEntries) {
    if (!alivePids.has(pid)) continue;
    if (spawnedThreads.some(t => t.threadId === threadId)) continue;
    spawnedThreads.push({
      pid,
      threadId,
      name: name ?? `Thread ${threadId}`,
      startedAt: Date.now(),
      createdAt: Date.now(),
      logFile: "",
    });
    restored++;
    log.info(`[restore] Recovered live process PID=${pid} for thread ${threadId} ("${name ?? "unknown"}")`);
  }
  return restored;
}

/**
 * Batch-check which PIDs are alive using process.kill(pid, 0).
 * This is non-blocking and works cross-platform — no PowerShell or tasklist.
 */
function getAlivePids(pids: number[]): Set<number> {
  const alive = new Set<number>();
  for (const pid of pids) {
    try { process.kill(pid, 0); alive.add(pid); } catch { /* dead */ }
  }
  return alive;
}

const DEFAULT_WORKER_TTL_MS = 60 * 60 * 1000; // 60 minutes — one-shot threads auto-cleanup

/**
 * Clean up expired worker threads.
 * Workers are temporary threads (have memorySourceThreadId but no memoryTargetThreadId).
 * After TTL expires: synthesize outcomes, kill process, delete PID, delete Telegram topic.
 */
export async function cleanupExpiredWorkers(
  db: ReturnType<typeof import("../memory.js").initMemoryDb>,
  telegram: { deleteForumTopic(chatId: string, threadId: number): Promise<void> },
  chatId: string,
  ttlMs: number = DEFAULT_WORKER_TTL_MS,
): Promise<{ cleaned: number; errors: string[] }> {
  const result = { cleaned: 0, errors: [] as string[] };
  const now = Date.now();

  const isExpiredWorker = (t: SpawnedThread): boolean =>
    t.threadType === 'worker' && now - t.createdAt > ttlMs;

  for (const thread of spawnedThreads.filter(isExpiredWorker)) {
    try {
      await cleanupSingleWorker(thread, db, telegram, chatId);
      result.cleaned++;
    } catch (err) {
      result.errors.push(`Thread ${thread.threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Also clean stale workers from thread_registry (survives server restarts)
  try {
    const cutoff = new Date(now - ttlMs).toISOString();
    const staleRows = db.prepare(
      `SELECT thread_id FROM thread_registry 
       WHERE type = 'worker' AND status IN ('active', 'exited') AND created_at < ?`
    ).all(cutoff) as { thread_id: number }[];
    for (const row of staleRows) {
      // Skip if still alive in-memory (already handled above)
      if (spawnedThreads.some(t => t.threadId === row.thread_id)) continue;
      try {
        // Delete Telegram topic for stale worker
        try { await telegram.deleteForumTopic(chatId, row.thread_id); } catch { /* topic might not exist */ }
        archiveThread(db, row.thread_id);
        result.cleaned++;
      } catch { /* best-effort */ }
    }
  } catch { /* registry cleanup is best-effort */ }

  return result;
}

/** Perform cleanup steps for a single expired worker thread. */
async function cleanupSingleWorker(
  thread: SpawnedThread,
  db: ReturnType<typeof import("../memory.js").initMemoryDb>,
  telegram: { deleteForumTopic(chatId: string, threadId: number): Promise<void> },
  chatId: string,
): Promise<void> {
  // 1. Synthesize before cleanup (best-effort)
  if (thread.memorySourceThreadId !== undefined) {
    try { await synthesizeGhostMemory(db, thread.threadId, thread.memorySourceThreadId, thread.name); }
    catch { /* synthesis is best-effort */ }
  }

  // 2. Kill process
  try { process.kill(thread.pid, "SIGTERM"); } catch { /* already dead */ }

  // 3. Delete Telegram topic
  try { await telegram.deleteForumTopic(chatId, thread.threadId); } catch { /* topic might not exist */ }

  // 4. Archive in thread registry (best-effort)
  try {
    const db = initMemoryDb();
    archiveThread(db, thread.threadId);
  } catch { /* registry archival is best-effort */ }

  // 5. Remove from tracking (PID file cleanup happens in the exit handler)
  const idx = spawnedThreads.indexOf(thread);
  if (idx !== -1) spawnedThreads.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Thread health monitoring
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number): string {
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatUptime(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// ---------------------------------------------------------------------------
// Data collection & status classification (H1 decomposition)
// ---------------------------------------------------------------------------

type ThreadStatus = "running" | "dormant" | "dead" | "unknown";

interface CollectedThread {
  threadId: number;
  name: string;
  pid: number | undefined;
  alive: boolean;
  hasActiveSession: boolean;
  hasRecentWait: boolean;
  sessionCount: number;
  lastActivity: number | undefined;
  spawnedStartedAt: number | undefined;
  /** From thread_registry: persistent status across restarts. */
  registryStatus: string | undefined;
  /** From thread_registry: whether this thread should be kept alive. */
  keepAlive: boolean;
  /** From thread_registry: last known activity timestamp from DB. */
  registryLastActive: number | undefined;
}

/**
 * Gather thread data from all 4 sources (topic registry, dashboard sessions,
 * in-memory spawned processes, PID files on disk) and return merged rows.
 */
function collectThreadData(): CollectedThread[] {
  const topicsByChat = getAllRegisteredTopics();
  const sessions = getDashboardSessions();
  const spawned = getAllSpawnedThreads();
  const pidFiles = readPidFiles();
  const now = Date.now();

  // 5th source: persistent thread_registry DB
  let registryByThread = new Map<number, ThreadRegistryEntry>();
  try {
    const db = initMemoryDb();
    const allRegistered = getAllThreads(db);
    for (const entry of allRegistered) registryByThread.set(entry.threadId, entry);
  } catch { /* DB unavailable — degrade gracefully */ }

  // Build Maps for O(1) lookups
  const spawnedByThread = new Map<number, SpawnedThread>();
  for (const s of spawned) spawnedByThread.set(s.threadId, s);

  const pidByThread = new Map<number, number>();
  for (const p of pidFiles) pidByThread.set(p.threadId, p.pid);

  // Build thread name map + collect threadIds from topic registry
  const threadNames = new Map<number, string>();
  const allThreadIds = new Set<number>();
  for (const chatTopics of Object.values(topicsByChat)) {
    for (const [name, threadId] of Object.entries(chatTopics)) {
      threadNames.set(threadId, name);
      allThreadIds.add(threadId);
    }
  }

  // Add threadIds from other sources
  for (const s of sessions) {
    if (s.threadId != null) allThreadIds.add(s.threadId);
  }
  for (const s of spawned) allThreadIds.add(s.threadId);
  for (const p of pidFiles) allThreadIds.add(p.threadId);
  for (const id of registryByThread.keys()) {
    allThreadIds.add(id);
    if (!threadNames.has(id)) {
      const entry = registryByThread.get(id);
      if (entry?.name) threadNames.set(id, entry.name);
    }
  }

  // Group sessions by threadId for O(1) lookup
  const sessionsByThread = new Map<number, typeof sessions>();
  for (const s of sessions) {
    if (s.threadId == null) continue;
    const arr = sessionsByThread.get(s.threadId) ?? [];
    arr.push(s);
    sessionsByThread.set(s.threadId, arr);
  }

  const result: CollectedThread[] = [];
  for (const threadId of allThreadIds) {
    const spawnedEntry = spawnedByThread.get(threadId);
    const pid = spawnedEntry?.pid ?? pidByThread.get(threadId);
    const alive = pid !== undefined && isProcessAlive(pid);

    const threadSessions = sessionsByThread.get(threadId) ?? [];
    const activeSession = threadSessions.find(s => s.status === "active");
    const anySession = activeSession ?? threadSessions[0];

    const hasRecentWait = anySession?.lastWaitCallAt != null
      && (now - anySession.lastWaitCallAt) < WAIT_LIVENESS_MS;

    const regEntry = registryByThread.get(threadId);
    const regLastActive = regEntry?.lastActiveAt
      ? new Date(regEntry.lastActiveAt).getTime()
      : undefined;

    result.push({
      threadId,
      name: threadNames.get(threadId) ?? regEntry?.name ?? "unnamed",
      pid,
      alive,
      hasActiveSession: !!activeSession,
      hasRecentWait,
      sessionCount: threadSessions.length,
      lastActivity: anySession?.lastActivity ?? regLastActive,
      spawnedStartedAt: spawnedEntry?.startedAt,
      registryStatus: regEntry?.status,
      keepAlive: regEntry?.keepAlive ?? false,
      registryLastActive: regLastActive,
    });
  }

  return result;
}

/**
 * Classify a thread as running / dormant / dead / unknown based on its
 * process liveness and dashboard-session state.
 *
 * Session activity is checked independently of PID — the main server thread
 * (e.g. sensorium) is the host process itself and won't appear in
 * spawnedThreads, yet it has an active dashboard session with recent
 * wait-call activity.
 */
function classifyThreadStatus(t: CollectedThread): ThreadStatus {
  if (t.alive && t.hasActiveSession && t.hasRecentWait) return "running";
  // Session-only liveness: no PID tracked but dashboard session is active
  if (t.hasActiveSession && t.hasRecentWait) return "running";
  if (t.hasActiveSession) return "dormant";
  if (t.alive) return "dormant";
  if (t.pid !== undefined && !t.alive) return "dead";
  // Use persistent registry status when ephemeral sources have no data
  if (t.registryStatus === "archived" || t.registryStatus === "expired") return "dead";
  if (t.registryStatus === "exited") return "dead";
  if (t.registryStatus === "active" && t.keepAlive) return "dormant";
  if (t.registryStatus === "active") return "dormant";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get comprehensive health status of all known threads.
 * Merges data from topic registry, dashboard sessions, spawned processes,
 * and PID files on disk. Returns a formatted markdown table.
 */
export function getThreadsHealth(): string {
  const threads = collectThreadData();

  if (threads.length === 0) {
    return "No threads found. No topics registered, no active sessions, no PID files.";
  }

  const now = Date.now();

  interface ThreadRow {
    threadId: number;
    name: string;
    status: ThreadStatus;
    pid: string;
    lastActivity: string;
    session: string;
    uptime: string;
  }

  const rows: ThreadRow[] = threads.map(t => {
    const status = classifyThreadStatus(t);
    const safeName = t.name.replace(/\|/g, "\\|");

    let sessionStr = "-";
    if (t.hasActiveSession) sessionStr = "active";
    else if (t.sessionCount > 0) sessionStr = "disconnected";

    let lastActivityStr = "-";
    if (t.lastActivity) lastActivityStr = formatRelativeTime(now - t.lastActivity);

    let uptimeStr = "-";
    if (t.spawnedStartedAt && t.alive) uptimeStr = formatUptime(t.spawnedStartedAt);

    return {
      threadId: t.threadId,
      name: safeName,
      status,
      pid: t.pid !== undefined ? String(t.pid) : "-",
      lastActivity: lastActivityStr,
      session: sessionStr,
      uptime: uptimeStr,
    };
  });

  // Sort: running first, then dormant, dead, unknown
  const statusOrder: Record<string, number> = { running: 0, dormant: 1, dead: 2, unknown: 3 };
  rows.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  // Format markdown table
  const lines: string[] = [];
  lines.push("## Thread Health Report");
  lines.push("");
  lines.push("| Thread ID | Name | Status | PID | Last Activity | Session | Uptime |");
  lines.push("|-----------|------|--------|-----|---------------|---------|--------|");
  for (const r of rows) {
    lines.push(`| ${r.threadId} | ${r.name} | ${r.status} | ${r.pid} | ${r.lastActivity} | ${r.session} | ${r.uptime} |`);
  }

  // Summary
  const running = rows.filter(r => r.status === "running").length;
  const dormant = rows.filter(r => r.status === "dormant").length;
  const dead = rows.filter(r => r.status === "dead").length;
  const unknown = rows.filter(r => r.status === "unknown").length;
  lines.push("");
  lines.push(`**Summary:** ${rows.length} threads -- ${running} running, ${dormant} dormant, ${dead} dead, ${unknown} unknown`);

  return lines.join("\n");
}
