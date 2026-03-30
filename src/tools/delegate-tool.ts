/**
 * Thread management tools: start_thread and send_message_to_thread.
 *
 * Refactored from the original delegate_to_thread — the delegation workflow
 * is now: start_thread(name) → send_message_to_thread(threadId, task).
 *
 * start_thread: ensures an agent session is running on a named thread.
 * send_message_to_thread: queues a message for the target thread's agent.
 *
 * Process lifecycle code (spawning, PID tracking, cleanup) lives in
 * thread-lifecycle.ts.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setThreadAgentType, type AgentType } from "../config.js";
import { lookupSession, persistSession, lookupTopicRegistry, registerTopic } from "../sessions.js";
import type { TelegramClient } from "../telegram.js";
import type { ToolResult } from "../types.js";
import { log } from "../logger.js";
import { errorMessage, errorResult } from "../utils.js";
import {
  findAliveThread,
  isThreadRunning,
  ensureDirs,
  PENDING_TASKS_DIR,
  resolveMcpConfigPath,
  resolveClaudePath,
  resolveCopilotPath,
  spawnAgentProcess,
  spawnCopilotProcess,
  cleanupStalePidFiles,
} from "./thread-lifecycle.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegateToolContext {
  telegram: TelegramClient;
  telegramChatId: string;
}

// ---------------------------------------------------------------------------
// Topic resolution helper
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve an existing Telegram forum topic by name.
 *
 * Resolution order:
 *   1. Topic registry (SQLite topic_registry table — source of truth)
 *   2. Session store (fallback for topics not in the registry)
 *
 * If a match is found in the registry, the session store is synced
 * so future lookups stay consistent.
 *
 * Returns the thread ID if found, or undefined.
 */
function resolveExistingTopic(
  chatId: string,
  name: string,
): number | undefined {
  // 1. Topic registry (SQLite – source of truth)
  const registryId = lookupTopicRegistry(chatId, name);
  if (registryId !== undefined) {
    // Sync session store so it never holds a stale mapping
    persistSession(chatId, name, registryId);
    return registryId;
  }

  // 2. Session store (fallback for topics not yet in the registry)
  const sessionId = lookupSession(chatId, name);
  if (sessionId !== undefined) return sessionId;

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
  const rawThreadId = args.threadId;
  const explicitThreadId = typeof rawThreadId === "number" ? rawThreadId
    : typeof rawThreadId === "string" ? (Number.isFinite(Number(rawThreadId)) ? Number(rawThreadId) : undefined)
    : undefined;
  const rawAgentType = typeof args.agentType === "string" ? args.agentType.trim() : "claude";
  const workingDirectory = typeof args.workingDirectory === "string" ? args.workingDirectory.trim() : undefined;
  // NOTE: No access control — any thread can read any thread's memory via memorySourceThreadId.
  // Acceptable in single-user architecture. Review if multi-tenant support is added.
  const memorySourceThreadId = typeof args.memorySourceThreadId === "number" ? args.memorySourceThreadId
    : typeof args.memorySourceThreadId === "string" ? (Number.isFinite(Number(args.memorySourceThreadId)) ? Number(args.memorySourceThreadId) : undefined)
    : undefined;

  // name is required unless an explicit threadId is provided
  if (!name && explicitThreadId === undefined) {
    return errorResult("Error: 'name' parameter is required for start_thread (unless threadId is provided).");
  }

  const agentType: AgentType =
    rawAgentType === "copilot" || rawAgentType === "claude" || rawAgentType === "cursor"
      ? rawAgentType
      : "claude";

  // ── Verify CLI availability ───────────────────────────────────────────
  let cliPath: string;
  let mcpConfigPath: string | undefined;

  if (agentType === "copilot") {
    const copilotPath = resolveCopilotPath();
    if (!copilotPath) {
      return errorResult(
        "Error: 'copilot' CLI is not installed or not on PATH. " +
        "Set COPILOT_CLI_CMD env var or ensure 'copilot' is on PATH.",
      );
    }
    cliPath = copilotPath;
  } else {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      return errorResult(
        "Error: 'claude' CLI is not installed or not on PATH. " +
        "Install it with: npm install -g @anthropic-ai/claude-code",
      );
    }
    const resolvedConfig = resolveMcpConfigPath();
    if (!resolvedConfig) {
      return errorResult(
        "Error: Could not find MCP config for Claude. " +
        "Set CLAUDE_MCP_CONFIG env var or place config at ~/.claude/mcp_config.json",
      );
    }
    cliPath = claudePath;
    mcpConfigPath = resolvedConfig;
  }

  // ── 1. Resolve or create Telegram forum topic ─────────────────────────
  // Resolution order:
  //   0. Explicit threadId parameter (beats everything)
  //   1. Topic registry (SQLite – source of truth)
  //   2. Session store (fallback for topics not in the registry)
  //   3. Create new topic via Telegram API (only if no match above)
  let threadId: number;
  let topicExisted = false;

  if (explicitThreadId !== undefined) {
    threadId = explicitThreadId;
    topicExisted = true;
    if (name) {
      persistSession(telegramChatId, name, threadId);
    }
    log.info(`[start_thread] Using explicit threadId ${threadId}` + (name ? ` ("${name}")` : ""));
  } else {
    const resolvedId = resolveExistingTopic(telegramChatId, name);
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
  const result = agentType === "copilot"
    ? spawnCopilotProcess(cliPath, name, threadId, workingDirectory, memorySourceThreadId)
    : spawnAgentProcess(cliPath, mcpConfigPath!, name, threadId, workingDirectory, memorySourceThreadId);
  if ("error" in result) return errorResult(`Error: ${result.error}`);

  const status = topicExisted ? "restarted" : "created";

  try {
    await telegram.sendMessage(
      telegramChatId,
      `🧵 Thread ${status}.\nAgent: ${agentType} (PID ${result.pid})`,
      undefined,
      threadId,
    );
  } catch (err) {
    log.warn(`[start_thread] Notification to thread ${threadId} failed: ${errorMessage(err)}`);
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
        ...(memorySourceThreadId !== undefined ? { memorySourceThreadId } : {}),
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
  const rawMode = typeof args.mode === "string" ? args.mode : "";
  const mode: "one-shot" | "manager-worker" | "reply" =
    rawMode === "manager-worker" ? "manager-worker"
    : rawMode === "reply" ? "reply"
    : "one-shot";
  const senderName = typeof args.senderName === "string" ? args.senderName.trim() : "";
  const senderThreadId = typeof args.senderThreadId === "number"
    ? args.senderThreadId
    : typeof args.senderThreadId === "string" ? Number(args.senderThreadId) : undefined;

  if (threadId === undefined || !Number.isFinite(threadId)) {
    return errorResult("Error: 'threadId' is required and must be a number.");
  }
  if (!Number.isInteger(threadId) || threadId <= 0) {
    return errorResult('threadId must be a positive integer');
  }

  // Prevent sending to own thread
  const callerThread = typeof args._callerThreadId === "number" ? args._callerThreadId : undefined;
  if (callerThread !== undefined && callerThread === threadId) {
    return errorResult(`Cannot send a message to your own thread (${threadId}). Use report_progress to communicate with the operator, or start_thread to delegate work.`);
  }

  if (!message) {
    return errorResult("Error: 'message' is required.");
  }

  // Build structured message based on delegation mode
  const senderLabel = senderName || "another thread";
  let structuredMessage: string;

  if (mode === "reply") {
    // Clean reply — no task boilerplate
    structuredMessage =
      `Thread "${senderLabel}"` +
      (senderThreadId !== undefined && Number.isFinite(senderThreadId)
        ? ` (thread ${senderThreadId})`
        : "") +
      ` reports back:\n` +
      `---\n` +
      `${message}\n` +
      `---`;
  } else if (mode === "manager-worker") {
    structuredMessage =
      `Load the 'Worker — Delegate' skill via get_skill for reporting instructions.\n` +
      `Thread "${senderLabel}" sent you a message:\n` +
      `---\n` +
      `${message}\n` +
      `---\n` +
      `Report progress and message "${senderLabel}"` +
      (senderThreadId !== undefined && Number.isFinite(senderThreadId)
        ? ` (thread ${senderThreadId})`
        : "") +
      ` when complete.`;
  } else {
    structuredMessage =
      `Load the 'Worker — Autonomous' skill via get_skill for reporting instructions.\n` +
      `Thread "${senderLabel}" sent you a task:\n` +
      `---\n` +
      `${message}\n` +
      `---\n` +
      `This is a one-shot task. Report progress to the operator via report_progress or send_voice. Do NOT message the sender back.`;
  }

  ensureDirs();
  const taskFilePath = join(PENDING_TASKS_DIR, `${threadId}.txt`);

  // Append (with newline separator) instead of overwriting
  try {
    appendFileSync(taskFilePath, structuredMessage + "\n", "utf-8");
  } catch (err) {
    return errorResult(`Error: Failed to write message to pending tasks: ${errorMessage(err)}`);
  }

  log.info(`[send_message_to_thread] → thread ${threadId} (${mode}): ${message.slice(0, 120)}`);

  const alive = isThreadRunning(threadId);
  const warning = alive
    ? undefined
    : `Thread ${threadId} is dormant. Message queued but won't be processed until the thread is started via start_thread.`;

  const responseObj: Record<string, unknown> = { delivered: alive, threadId, mode };
  if (warning) responseObj.warning = warning;

  return {
    content: [{
      type: "text",
      text: JSON.stringify(responseObj),
    }],
  };
}
