/**
 * Thread management tools: start_thread and send_message_to_thread.
 *
 * Refactored from the original delegate_to_thread — the delegation workflow
 * is now: start_thread(name) → send_message_to_thread(threadId, task).
 *
 * start_thread: ensures an agent session is running on a named thread.
 * send_message_to_thread: queues a message for the target thread's agent.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setThreadAgentType, getClaudeMcpConfigPath, type AgentType } from "../config.js";
import { lookupSession, persistSession, lookupTopicRegistry, registerTopic } from "../sessions.js";
import type { TelegramClient } from "../telegram.js";
import type { ToolResult } from "../types.js";
import { log } from "../logger.js";
import { errorMessage, errorResult } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegateToolContext {
  telegram: TelegramClient;
  telegramChatId: string;
}

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

/** Return a snapshot of all spawned thread processes. */
export function getSpawnedThreads(): readonly SpawnedThread[] {
  return spawnedThreads;
}

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
function findAliveThread(threadId: number): SpawnedThread | undefined {
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
// Helpers
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const PENDING_TASKS_DIR = join(BASE_DIR, "pending-tasks");
const LOGS_DIR = join(BASE_DIR, "logs");
const PIDS_DIR = join(BASE_DIR, "pids");

function ensureDirs(): void {
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
function resolveMcpConfigPath(): string | null {
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
function resolveClaudePath(): string | null {
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
// Spawn agent process (extracted helper)
// ---------------------------------------------------------------------------

function spawnAgentProcess(
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
function cleanupStalePidFiles(): void {
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

// ---------------------------------------------------------------------------
// Topic resolution helper
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve an existing Telegram forum topic by name.
 *
 * Resolution order:
 *   1. Session store (threads previously used by this MCP server)
 *   2. Topic registry (~/.remote-copilot-mcp/topic-registry.json) —
 *      operator-managed mapping for manually-created threads
 *
 * Any match is validated via `editForumTopic` (no-op edit) to confirm the
 * topic still exists in the Telegram group.  If found in the registry but
 * not yet in the session store, the mapping is persisted there too for
 * faster future lookups.
 *
 * Returns the thread ID if found and valid, or undefined.
 */
async function resolveExistingTopic(
  telegram: TelegramClient,
  chatId: string,
  name: string,
): Promise<number | undefined> {
  // 1. Session store
  const sessionId = lookupSession(chatId, name);
  if (sessionId !== undefined) {
    const valid = await telegram.validateForumTopic(chatId, sessionId);
    if (valid) return sessionId;
    log.info(`[start_thread] Session-stored topic "${name}" (thread ${sessionId}) is stale`);
  }

  // 2. Topic registry (operator-managed)
  const registryId = lookupTopicRegistry(chatId, name);
  if (registryId !== undefined && registryId !== sessionId) {
    const valid = await telegram.validateForumTopic(chatId, registryId);
    if (valid) {
      // Promote to session store for future fast lookups
      persistSession(chatId, name, registryId);
      return registryId;
    }
    log.info(`[start_thread] Registry topic "${name}" (thread ${registryId}) is stale`);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// start_thread handler
// ---------------------------------------------------------------------------

export async function handleStartThread(
  args: Record<string, unknown>,
  ctx: DelegateToolContext,
): Promise<ToolResult> {
  const { telegram, telegramChatId } = ctx;

  // ── Validate args ─────────────────────────────────────────────────────
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const rawAgentType = typeof args.agentType === "string" ? args.agentType.trim() : "claude";

  if (!name) return errorResult("Error: 'name' parameter is required for start_thread.");

  const agentType: AgentType =
    rawAgentType === "copilot" || rawAgentType === "claude" || rawAgentType === "cursor"
      ? rawAgentType
      : "claude";

  if (agentType && agentType !== 'claude') {
    return errorResult(`Agent type "${agentType}" is not yet supported for thread spawning. Only "claude" is currently available.`);
  }

  // ── Verify CLI availability ───────────────────────────────────────────
  const claudePath = resolveClaudePath();
  if (!claudePath) {
    return errorResult(
      "Error: 'claude' CLI is not installed or not on PATH. " +
      "Install it with: npm install -g @anthropic-ai/claude-code",
    );
  }

  // ── Resolve MCP config ────────────────────────────────────────────────
  const mcpConfigPath = resolveMcpConfigPath();
  if (!mcpConfigPath) {
    return errorResult(
      "Error: Could not find MCP config for Claude. " +
      "Set CLAUDE_MCP_CONFIG env var or place config at ~/.claude/mcp_config.json",
    );
  }

  // ── 1. Resolve or create Telegram forum topic ─────────────────────────
  // Resolution order:
  //   1. Session store (threads previously used by this server)
  //   2. Topic registry (operator-managed mapping for manually-created threads)
  //   3. Create new topic via Telegram API
  let threadId: number;
  let topicExisted = false;

  const resolvedId = await resolveExistingTopic(telegram, telegramChatId, name);
  if (resolvedId !== undefined) {
    threadId = resolvedId;
    topicExisted = true;
    log.info(`[start_thread] Resolved existing forum topic "${name}" → thread ${threadId}`);
  } else {
    try {
      const topic = await telegram.createForumTopic(telegramChatId, name);
      threadId = topic.message_thread_id;
      persistSession(telegramChatId, name, threadId);
      registerTopic(telegramChatId, name, threadId);
      log.info(`[start_thread] Created forum topic "${name}" → thread ${threadId}`);
    } catch (err) {
      return errorResult(
        `Error: Could not create forum topic "${name}": ${errorMessage(err)}. ` +
        "Ensure the Telegram chat is a forum supergroup with the bot as admin.",
      );
    }
  }

  // ── 2. Set per-thread agent type ──────────────────────────────────────
  setThreadAgentType(threadId, agentType);

  // ── 3. Clean stale PID files & check if already running ──────────────
  cleanupStalePidFiles();
  const alive = findAliveThread(threadId);
  if (alive) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ threadId, status: "already_running", name, pid: alive.pid }),
      }],
    };
  }

  // ── 4. Dormant (topic existed, process dead) → restart ────────────────
  ensureDirs();
  const result = spawnAgentProcess(claudePath, mcpConfigPath, name, threadId);
  if ("error" in result) return errorResult(`Error: ${result.error}`);

  const status = topicExisted ? "restarted" : "created";

  try {
    await telegram.sendMessage(
      telegramChatId,
      `🧵 Thread ${status}.\nAgent: ${agentType} (PID ${result.pid})`,
      undefined,
      threadId,
    );
  } catch {
    // Non-fatal — the thread was created, process is running.
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        threadId,
        status,
        name,
        pid: result.pid,
        logFile: result.logFile,
      }),
    }],
  };
}

// ---------------------------------------------------------------------------
// send_message_to_thread handler
// ---------------------------------------------------------------------------

export function handleSendMessageToThread(
  args: Record<string, unknown>,
): ToolResult {
  const threadId = typeof args.threadId === "number"
    ? args.threadId
    : typeof args.threadId === "string" ? Number(args.threadId) : undefined;
  const message = typeof args.message === "string" ? args.message.trim() : "";

  if (threadId === undefined || !Number.isFinite(threadId)) {
    return errorResult("Error: 'threadId' is required and must be a number.");
  }
  if (!Number.isInteger(threadId) || threadId <= 0) {
    return errorResult('threadId must be a positive integer');
  }
  if (!message) {
    return errorResult("Error: 'message' is required.");
  }

  ensureDirs();
  const taskFilePath = join(PENDING_TASKS_DIR, `${threadId}.txt`);

  // Append (with newline separator) instead of overwriting
  try {
    appendFileSync(taskFilePath, message + "\n", "utf-8");
  } catch (err) {
    return errorResult(`Error: Failed to write message to pending tasks: ${errorMessage(err)}`);
  }

  log.info(`[send_message_to_thread] → thread ${threadId}: ${message.slice(0, 120)}`);

  const alive = isThreadRunning(threadId);
  const warning = alive
    ? undefined
    : `Thread ${threadId} is dormant. Message queued but won't be processed until the thread is started via start_thread.`;

  const responseObj: Record<string, unknown> = { delivered: alive, threadId };
  if (warning) responseObj.warning = warning;

  return {
    content: [{
      type: "text",
      text: JSON.stringify(responseObj),
    }],
  };
}
