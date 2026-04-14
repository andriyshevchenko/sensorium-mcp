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
import type { TelegramClient } from "../telegram.js";
import type { ToolResult } from "../types.js";
import { log } from "../logger.js";
import { errorMessage, errorResult } from "../utils.js";
import { getThread, getThreadByName } from "../data/memory/thread-registry.js";
import { initMemoryDb } from "../data/memory/schema.js";
import { forkMemory } from "../data/memory/synthesis.js";
import type { ThreadLifecycleService } from "../services/thread-lifecycle.service.js";
import {
  findAliveThread,
  isThreadRunning,
  isProcessAlive,
  readPidFiles,
  ensureDirs,
  PENDING_TASKS_DIR,
  resolveMcpConfigPath,
  resolveClaudePath,
  resolveCopilotPath,
  resolveCodexPath,
  spawnAgentProcess,
  spawnCopilotProcess,
  spawnCodexProcess,
} from "./thread-lifecycle.js";
import { createManagedTopic, probeOrRemapTopic } from "../services/topic.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegateToolContext {
  telegram: TelegramClient;
  telegramChatId: string;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  threadLifecycle: ThreadLifecycleService;
}

// ---------------------------------------------------------------------------
// Topic resolution helper
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve an existing Telegram forum topic by name.
 *
 * Returns the thread ID if found, or undefined.
 */
function resolveKnownTopic(getMemoryDb: () => ReturnType<typeof initMemoryDb>, name: string): number | undefined {
  try {
    const db = getMemoryDb();
    const registryEntry = getThreadByName(db, name);
    if (registryEntry) return registryEntry.threadId;
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// start_thread handler
// ---------------------------------------------------------------------------

export async function handleStartThread(
  args: Record<string, unknown>,
  ctx: DelegateToolContext,
): Promise<ToolResult> {
  const { telegram, telegramChatId, getMemoryDb, threadLifecycle } = ctx;

  // ── Parse args ──────────────────────────────────────────────────────
  const mode = typeof args.mode === "string" ? args.mode : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const task = typeof args.task === "string" ? args.task.trim() : "";
  let workingDirectory = typeof args.workingDirectory === "string"
    ? args.workingDirectory.trim()
    : "";
  const workingDirectoryExplicit = workingDirectory !== "";

  const parseNumArg = (v: unknown): number | undefined => {
    const parsed = typeof v === "number" ? v
      : typeof v === "string" ? Number(v)
      : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };

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
        threadRegistryType = "branch";
        runtimeThreadType = "branch";
      }
      break;
  }

  // ── Verify CLI availability ─────────────────────────────────────────
  let cliPath: string;
  let mcpConfigPath: string | undefined;

  // Resolve workingDirectory: prefer explicit arg → stored in DB → process.cwd()
  if (!workingDirectory && explicitThreadId) {
    try {
      const db = initMemoryDb();
      const stored = getThread(db, explicitThreadId);
      if (stored?.workingDirectory) {
        workingDirectory = stored.workingDirectory;
        log.info(`[start_thread] Using stored workingDirectory for thread ${explicitThreadId}: ${workingDirectory}`);
      }
    } catch { /* best-effort DB lookup */ }
  }
  if (!workingDirectory) workingDirectory = process.cwd();

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

  // Worker topics get a [Worker] prefix in Telegram for visual distinction
  const topicName = (threadRegistryType === "worker" && name && !name.startsWith("[Worker]"))
    ? `[Worker] ${name}`
    : name;

  let threadId: number;
  let topicExisted = false;

  if (explicitThreadId !== undefined) {
    threadId = explicitThreadId;
    topicExisted = true;
    log.info(`[start_thread] Using explicit threadId ${threadId}` + (name ? ` ("${name}")` : ""));
  } else {
    const resolvedId = resolveKnownTopic(getMemoryDb, topicName)
                    ?? resolveKnownTopic(getMemoryDb, name);
    if (resolvedId !== undefined) {
      threadId = resolvedId;
      topicExisted = true;
      log.info(`[start_thread] Resolved existing forum topic "${name}" → thread ${threadId}`);
    } else {
      try {
        threadId = await createManagedTopic(telegram, telegramChatId, topicName, topicName !== name && name ? [name] : []);
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
  const resolvedThreadName = name || (() => {
    try {
      const db = initMemoryDb();
      const thread = getThread(db, threadId);
      return thread?.name ?? `Thread ${threadId}`;
    } catch {
      return `Thread ${threadId}`;
    }
  })();

  setThreadAgentType(threadId, agentType);

  // ── 3. Check if already running ──────────────────────────────────
  // Note: cleanupStalePidFiles() was removed from this hot path because it
  // races with concurrent start_thread calls — it can delete PID files for
  // processes that JUST spawned (isProcessAlive returns false briefly).
  // Stale PID files are cleaned up by findAliveThread and at server startup.
  const alive = findAliveThread(threadId);
  if (alive) {
    // Topic health check: verify the Telegram topic still exists.
    // Agents that survived a server restart may be sending to a deleted topic.
    try {
      const db = getMemoryDb();
      await probeOrRemapTopic({
        telegram,
        chatId: telegramChatId,
        logicalThreadId: threadId,
        topicName: resolvedThreadName,
        db,
        threadLifecycle,
        aliases: [resolvedThreadName],
        probeText: "\u{1F504} Thread still running. Verifying topic.",
      });
    } catch (probeErr) {
      log.warn(`[start_thread] Topic remap failed: ${errorMessage(probeErr)}`);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ threadId, status: "already_running", name: resolvedThreadName, pid: alive.pid }),
      }],
    };
  }

  // Defensive: kill any leftover process from the PID file that findAliveThread
  // missed (e.g. spawnedThreads entry was lost after a server restart).
  // This prevents zombie duplicate processes.
  try {
    const pidEntries = readPidFiles().filter(e => e.threadId === threadId);
    for (const pe of pidEntries) {
      if (isProcessAlive(pe.pid)) {
        log.warn(`[start_thread] Killing orphan PID ${pe.pid} for thread ${threadId} before spawning new process`);
        try { process.kill(pe.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }
  } catch { /* best-effort orphan cleanup */ }

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

  if (mode === "branch" && rootThreadId) {
    try {
      const db = initMemoryDb();
      const forkResult = forkMemory(db, rootThreadId, threadId);
      log.info(`[start_thread] Forked memory from ${rootThreadId} → ${threadId}: ${forkResult.notesCopied} notes, ${forkResult.narrativesCopied} narratives`);
    } catch (err) {
      log.warn(`[start_thread] Memory fork failed (non-fatal): ${errorMessage(err)}`);
    }
  }

  const result = agentType === "copilot" || agentType === "copilot_claude" || agentType === "copilot_codex"
    ? spawnCopilotProcess(cliPath, resolvedThreadName, threadId, threadLifecycle, workingDirectory, memorySourceThreadId, agentType, runtimeThreadType)
    : agentType === "codex" || agentType === "openai_codex"
    ? spawnCodexProcess(cliPath, resolvedThreadName, threadId, threadLifecycle, workingDirectory, memorySourceThreadId, runtimeThreadType)
    : spawnAgentProcess(cliPath, mcpConfigPath!, resolvedThreadName, threadId, threadLifecycle, workingDirectory, memorySourceThreadId, memoryTargetThreadId, runtimeThreadType);
  if ("error" in result) return errorResult(`Error: ${result.error}`);

  // ── 6. Register in memory thread registry ───────────────────────────
  try {
    const db = getMemoryDb();
    const existing = getThread(db, threadId);
    if (existing && (mode === "resume" || (explicitThreadId !== undefined && !mode))) {
      // Resume: update client + lastActiveAt, preserve type/keepAlive.
      // Only persist workingDirectory if explicitly provided in args — don't overwrite a null
      // DB value with a process.cwd() fallback (that would ignore the user's intent to clear it).
      threadLifecycle.activateThread(db, threadId, {
        client: agentType,
        ...(workingDirectoryExplicit ? { workingDirectory } : {}),
      });
    } else {
      threadLifecycle.registerThread(db, {
        threadId,
        name: resolvedThreadName,
        type: threadRegistryType,
        rootThreadId: memorySourceThreadId ?? rootThreadId ?? parentThreadId ?? undefined,
        badge: mode || threadRegistryType,
        client: agentType,
        workingDirectory,
        chatId: telegramChatId,
      });
    }
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
        name: resolvedThreadName,
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
