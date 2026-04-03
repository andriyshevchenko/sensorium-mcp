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
import { registerThread, getThreadByName } from "../data/memory/thread-registry.js";
import { initMemoryDb } from "../data/memory/schema.js";
import { forkMemory } from "../data/memory/synthesis.js";
import {
  findAliveThread,
  isThreadRunning,
  ensureDirs,
  PENDING_TASKS_DIR,
  resolveMcpConfigPath,
  resolveClaudePath,
  resolveCopilotPath,
  resolveCodexPath,
  spawnAgentProcess,
  spawnCopilotProcess,
  spawnCodexProcess,
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

  // 3. Thread registry (fallback — has threadId from previous sessions)
  try {
    const db = initMemoryDb();
    const registryEntry = getThreadByName(db, name);
    if (registryEntry) {
      // Sync back to topic registry and session store
      registerTopic(chatId, name, registryEntry.threadId);
      persistSession(chatId, name, registryEntry.threadId);
      return registryEntry.threadId;
    }
  } catch { /* registry lookup is best-effort */ }

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

  // ── Parse args ──────────────────────────────────────────────────────
  const mode = typeof args.mode === "string" ? args.mode : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const workingDirectory = typeof args.workingDirectory === "string"
    ? args.workingDirectory.trim()
    : process.cwd();

  const parseNumArg = (v: unknown): number | undefined =>
    typeof v === "number" ? v
    : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v)
    : undefined;

  const explicitThreadId = parseNumArg(args.targetThreadId);
  const parentThreadId = parseNumArg(args.parentThreadId);
  const rootThreadId = parseNumArg(args.rootThreadId);

  const rawAgentType = typeof args.agentType === "string" ? args.agentType.trim() : "claude";
  const agentType: AgentType =
    rawAgentType === "copilot" || rawAgentType === "copilot_claude" || rawAgentType === "copilot_codex"
    || rawAgentType === "claude" || rawAgentType === "cursor"
    || rawAgentType === "codex" || rawAgentType === "openai_codex"
      ? rawAgentType
      : "claude";

  // ── Mode-specific validation & memory resolution ────────────────────
  let memorySourceThreadId: number | undefined;
  let memoryTargetThreadId: number | undefined;
  let threadRegistryType: "daily" | "worker" | "branch" = "worker";
  let runtimeThreadType: "worker" | "branch" | undefined = "worker";

  switch (mode) {
    case "worker":
      if (!parentThreadId) return errorResult("Error: 'parentThreadId' is required for worker mode.");
      if (!name) return errorResult("Error: 'name' is required for worker mode.");
      memorySourceThreadId = parentThreadId;
      threadRegistryType = "worker";
      break;

    case "daily":
      if (!rootThreadId) return errorResult("Error: 'rootThreadId' is required for daily mode.");
      if (!name) return errorResult("Error: 'name' is required for daily mode.");
      memorySourceThreadId = rootThreadId;
      memoryTargetThreadId = rootThreadId;
      threadRegistryType = "daily";
      runtimeThreadType = "branch";
      break;

    case "branch":
      if (!rootThreadId) return errorResult("Error: 'rootThreadId' is required for branch mode.");
      if (!name) return errorResult("Error: 'name' is required for branch mode.");
      // Memory is forked AFTER thread creation (needs threadId first)
      threadRegistryType = "branch";
      runtimeThreadType = "branch";
      break;

    case "resume":
      if (!explicitThreadId) return errorResult("Error: 'targetThreadId' is required for resume mode.");
      // Resume uses existing memory config — no source/target overrides
      runtimeThreadType = undefined;
      break;

    default:
      // Backward-compatible: no mode = infer from args
      if (explicitThreadId && !name) {
        // Looks like resume
        break;
      }
      if (!name && !explicitThreadId) {
        return errorResult("Error: 'name' is required for start_thread (unless using resume mode with targetThreadId).");
      }
      // Legacy: parentThreadId acts as memorySourceThreadId
      if (parentThreadId) memorySourceThreadId = parentThreadId;
      if (rootThreadId) {
        memorySourceThreadId = rootThreadId;
        memoryTargetThreadId = rootThreadId;
        runtimeThreadType = "branch";
      }
      break;
  }

  // ── Verify CLI availability ─────────────────────────────────────────
  let cliPath: string;
  let mcpConfigPath: string | undefined;

  if (agentType === "copilot" || agentType === "copilot_claude" || agentType === "copilot_codex") {
    const copilotPath = resolveCopilotPath();
    if (!copilotPath) {
      return errorResult(
        "Error: 'copilot' CLI is not installed or not on PATH. " +
        "Set COPILOT_CLI_CMD env var or ensure 'copilot' is on PATH.",
      );
    }
    cliPath = copilotPath;
  } else if (agentType === "codex" || agentType === "openai_codex") {
    const codexPath = resolveCodexPath();
    if (!codexPath) {
      return errorResult(
        "Error: 'codex' CLI is not installed or not on PATH. " +
        "Set CODEX_CLI_CMD env var or ensure 'codex' is on PATH.",
      );
    }
    cliPath = codexPath;
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

  // ── 1. Resolve or create Telegram forum topic ───────────────────────
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

  // ── 4. Pre-queue task & spawn ───────────────────────────────────────
  ensureDirs();

  // Pre-queue task message if provided (written before agent starts polling)
  if (task) {
    const taskFilePath = join(PENDING_TASKS_DIR, `${threadId}.txt`);
    try {
      appendFileSync(taskFilePath, task + "\n", "utf-8");
      log.info(`[start_thread] Pre-queued task for thread ${threadId}: ${task.slice(0, 120)}`);
    } catch (err) {
      log.warn(`[start_thread] Failed to pre-queue task: ${errorMessage(err)}`);
    }
  }

  const result = agentType === "copilot" || agentType === "copilot_claude" || agentType === "copilot_codex"
    ? spawnCopilotProcess(cliPath, name, threadId, workingDirectory, memorySourceThreadId, agentType, runtimeThreadType)
    : agentType === "codex" || agentType === "openai_codex"
    ? spawnCodexProcess(cliPath, name, threadId, workingDirectory, memorySourceThreadId, runtimeThreadType)
    : spawnAgentProcess(cliPath, mcpConfigPath!, name, threadId, workingDirectory, memorySourceThreadId, memoryTargetThreadId, runtimeThreadType);
  if ("error" in result) return errorResult(`Error: ${result.error}`);

  // ── 5. Branch mode: fork memory ─────────────────────────────────────
  if (mode === "branch" && rootThreadId) {
    try {
      const db = initMemoryDb();
      const forkResult = forkMemory(db, rootThreadId, threadId);
      log.info(`[start_thread] Forked memory from ${rootThreadId} → ${threadId}: ${forkResult.notesCopied} notes, ${forkResult.narrativesCopied} narratives`);
    } catch (err) {
      log.warn(`[start_thread] Memory fork failed (non-fatal): ${errorMessage(err)}`);
    }
  }

  // ── 6. Register in memory thread registry ───────────────────────────
  try {
    const db = initMemoryDb();
    registerThread(db, {
      threadId,
      name,
      type: threadRegistryType,
      rootThreadId: memorySourceThreadId ?? rootThreadId ?? parentThreadId ?? undefined,
      badge: mode || threadRegistryType,
      client: agentType,
    });
  } catch { /* registration is best-effort */ }

  const status = topicExisted ? "restarted" : "created";

  try {
    await telegram.sendMessage(
      telegramChatId,
      `🧵 Thread ${status}.\nAgent: ${agentType} (PID ${result.pid})` + (mode ? `\nMode: ${mode}` : ""),
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
        mode: mode || "default",
        ...(memorySourceThreadId !== undefined ? { memorySourceThreadId } : {}),
        ...(memoryTargetThreadId !== undefined ? { memoryTargetThreadId } : {}),
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
  // Prefer targetThreadId (cross-thread callers pass threadId as session context)
  const rawTarget = args.targetThreadId ?? args.threadId;
  const threadId = typeof rawTarget === "number"
    ? rawTarget
    : typeof rawTarget === "string" ? Number(rawTarget) : undefined;
  const message = typeof args.message === "string" ? args.message.trim() : "";
  const rawMode = typeof args.mode === "string" ? args.mode : "";
  const mode: "one-shot" | "manager-worker" | "reply" | "peer" =
    rawMode === "manager-worker" ? "manager-worker"
    : rawMode === "reply" ? "reply"
    : rawMode === "peer" ? "peer"
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
  } else if (mode === "peer") {
    // P2P communication — raw message with sender attribution, no task boilerplate
    structuredMessage =
      `Thread "${senderLabel}"` +
      (senderThreadId !== undefined && Number.isFinite(senderThreadId)
        ? ` (thread ${senderThreadId})`
        : "") +
      ` says:\n` +
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
