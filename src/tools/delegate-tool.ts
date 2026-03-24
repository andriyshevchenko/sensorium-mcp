/**
 * delegate_to_thread tool handler.
 *
 * Spawns a background Claude Code process connected to sensorium via MCP,
 * isolated in its own Telegram forum topic.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setThreadAgentType, type AgentType } from "../config.js";
import { persistSession } from "../sessions.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_DIR = join(homedir(), ".remote-copilot-mcp");
const PENDING_TASKS_DIR = join(BASE_DIR, "pending-tasks");
const LOGS_DIR = join(BASE_DIR, "logs");

function ensureDirs(): void {
  mkdirSync(PENDING_TASKS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Resolve the MCP config path for the spawned Claude process.
 * Priority:
 *   1. CLAUDE_MCP_CONFIG env var
 *   2. ~/.claude/mcp_config.json
 *   3. ~/.claude/.mcp.json
 */
function resolveMcpConfigPath(): string | null {
  const envPath = process.env.CLAUDE_MCP_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = [
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
// Handler
// ---------------------------------------------------------------------------

export async function handleDelegateToThread(
  args: Record<string, unknown>,
  ctx: DelegateToolContext,
): Promise<ToolResult> {
  const { telegram, telegramChatId } = ctx;

  // ── Validate args ─────────────────────────────────────────────────────
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const rawAgentType = typeof args.agentType === "string" ? args.agentType.trim() : "claude";

  if (!name) return errorResult("Error: 'name' parameter is required for delegate_to_thread.");
  if (!task) return errorResult("Error: 'task' parameter is required for delegate_to_thread.");

  const agentType: AgentType =
    rawAgentType === "copilot" || rawAgentType === "claude" || rawAgentType === "cursor"
      ? rawAgentType
      : "claude";

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

  // ── 1. Create Telegram forum topic ────────────────────────────────────
  let threadId: number;
  try {
    const topic = await telegram.createForumTopic(telegramChatId, name);
    threadId = topic.message_thread_id;
    persistSession(telegramChatId, name, threadId);
    log.info(`[delegate] Created forum topic "${name}" → thread ${threadId}`);
  } catch (err) {
    return errorResult(
      `Error: Could not create forum topic "${name}": ${errorMessage(err)}. ` +
      "Ensure the Telegram chat is a forum supergroup with the bot as admin.",
    );
  }

  // ── 2. Set per-thread agent type ──────────────────────────────────────
  setThreadAgentType(threadId, agentType);

  // ── 3. Store pending task ─────────────────────────────────────────────
  ensureDirs();
  const taskFilePath = join(PENDING_TASKS_DIR, `${threadId}.txt`);
  writeFileSync(taskFilePath, task, "utf-8");
  log.info(`[delegate] Wrote pending task for thread ${threadId}: ${task.slice(0, 120)}`);

  // ── 4. Spawn background Claude process ────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFileName = `${safeName}_${dateStr}.json`;
  const logFilePath = join(LOGS_DIR, logFileName);

  const logFd = openSync(logFilePath, "a");

  const prompt = `Start remote session with sensorium. Thread name = '${safeName}'`;

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

  let child;
  try {
    child = spawn(claudePath, cliArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      shell: needsShell,
      windowsHide: true,
    });
  } catch (err) {
    closeSync(logFd);
    return errorResult(`Error: Failed to spawn Claude process: ${errorMessage(err)}`);
  }

  // Release the parent's copy of the log file descriptor
  closeSync(logFd);

  const pid = child.pid;
  if (pid === undefined) {
    return errorResult("Error: Claude process spawned but PID is undefined — spawn may have failed.");
  }

  // ── 5. Track spawned process ──────────────────────────────────────────
  const entry: SpawnedThread = {
    pid,
    threadId,
    name,
    startedAt: Date.now(),
    logFile: logFilePath,
  };
  spawnedThreads.push(entry);

  // Monitor process exit — clean up stale entries and log health info
  child.on("exit", (code) => {
    const idx = spawnedThreads.indexOf(entry);
    if (idx !== -1) spawnedThreads.splice(idx, 1);
    log.info(`[delegate] Claude process PID=${pid} for thread ${threadId} exited with code ${code}`);
  });

  // Unref so the parent process can exit without waiting for this child.
  child.unref();

  log.info(`[delegate] Spawned Claude process PID=${pid} for thread ${threadId} ("${name}")`);

  // ── 6. Notify operator in the new thread ──────────────────────────────
  try {
    await telegram.sendMessage(
      telegramChatId,
      `🧵 Delegated thread started.\nTask: ${task.slice(0, 200)}\nAgent: ${agentType} (PID ${pid})`,
      undefined,
      threadId,
    );
  } catch {
    // Non-fatal — the thread was created, process is running.
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Delegated thread created successfully.\n` +
          `Thread ID: ${threadId}\n` +
          `Thread name: ${name}\n` +
          `Agent type: ${agentType}\n` +
          `PID: ${pid}\n` +
          `Log file: ${logFilePath}\n` +
          `Pending task stored at: ${taskFilePath}`,
      },
    ],
  };
}
