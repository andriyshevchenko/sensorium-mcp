#!/usr/bin/env node
/**
 * Remote Copilot MCP Server
 *
 * Exposes MCP tools for AI assistants:
 *   - Session management (start_session)
 *   - Bidirectional communication (wait_for_instructions, report_progress)
 *   - Rich media (send_file, send_voice)
 *   - Scheduling (schedule_wake_up)
 *   - Persistent memory (memory_*)
 *
 * Required environment variables:
 *   TELEGRAM_TOKEN    – Telegram Bot API token.
 *   TELEGRAM_CHAT_ID  – ID of a Telegram forum supergroup (topics must be enabled).
 *                       The bot must be an admin with can_manage_topics right.
 *                       Each start_session call automatically creates a new topic
 *                       thread so concurrent sessions never interfere.
 *
 * Optional environment variables:
 *   WAIT_TIMEOUT_MINUTES  – How long to wait for a message before timing out
 *                           and instructing the agent to call the tool again
 *                           (default: 120).
 *   OPENAI_API_KEY        – OpenAI API key for voice message transcription
 *                           via Whisper and text-to-speech via TTS. Without it,
 *                           voice messages show a placeholder and send_voice
 *                           is disabled.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkMaintenanceFlag, config } from "./config.js";
import { peekThreadMessages, startDispatcher } from "./dispatcher.js";
import { formatDrivePrompt } from "./drive.js";
import { initMemoryDb } from "./memory.js";
import { checkDueTasks } from "./scheduler.js";
import {
  DEAD_SESSION_TIMEOUT_MS,
} from "./sessions.js";
import { TelegramClient } from "./telegram.js";
import { getToolDefinitions } from "./tool-definitions.js";
import { errorResult } from "./utils.js";
import { getReminders, getShortReminder } from "./response-builders.js";
import { startHttpServer } from "./http-server.js";
import { startStdioServer } from "./stdio-server.js";
import { log } from "./logger.js";
import { handleMemoryTool, type ToolContext } from "./tools/memory-tools.js";
import { handleUtilityTool, type UtilityToolContext } from "./tools/utility-tools.js";
import { handleSessionTool, type SessionToolContext } from "./tools/session-tools.js";
import { handleStartSession, type StartSessionContext } from "./tools/start-session-tool.js";
import { handleWaitForInstructions, type WaitToolContext, type WaitToolExtra } from "./tools/wait-tool.js";

// ---------------------------------------------------------------------------
// Destructure config for backwards-compatible local references
// ---------------------------------------------------------------------------

const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, PKG_VERSION } = config;

// ---------------------------------------------------------------------------
// Telegram client + dispatcher
// ---------------------------------------------------------------------------

const telegram = new TelegramClient(TELEGRAM_TOKEN);

await startDispatcher(telegram, TELEGRAM_CHAT_ID);

// Memory database — initialized lazily on first use
let memoryDb: ReturnType<typeof initMemoryDb> | null = null;
function getMemoryDb() {
  if (!memoryDb) memoryDb = initMemoryDb();
  return memoryDb;
}

// ---------------------------------------------------------------------------
// MCP Server factory — creates a fresh Server per transport connection.
// This is required because a single Server instance can only connect to one
// transport. In HTTP mode, each VS Code client gets its own Server instance.
// All instances share the same tool handler logic and in-process state.
// ---------------------------------------------------------------------------

function createMcpServer(getMcpSessionId?: () => string | undefined, closeTransport?: () => void): Server {
  // ── Per-session state (isolated per HTTP session / stdio connection) ─────
  let waitCallCount = 0;
  let sessionStartedAt = Date.now();
  let currentThreadId: number | undefined;
  let lastToolCallAt = Date.now();
  let deadSessionAlerted = false;
  let waitInProgress = false;
  let lastOperatorMessageAt = Date.now();
  let lastOperatorMessageText = "";
  let lastConsolidationAt = 0;
  let toolCallsSinceLastDelivery = 0;
  let lastDriveAttemptAt = 0;
  let drivePhase2Fired = false;
  const previewedUpdateIds = new Set<number>();
  const PREVIEWED_IDS_CAP = 1000;

  function addPreviewedId(id: number): void {
    if (previewedUpdateIds.size >= PREVIEWED_IDS_CAP) {
      const toDelete = previewedUpdateIds.size - PREVIEWED_IDS_CAP + 100;
      let deleted = 0;
      for (const old of previewedUpdateIds) {
        if (deleted >= toDelete) break;
        previewedUpdateIds.delete(old);
        deleted++;
      }
    }
    previewedUpdateIds.add(id);
  }

  /**
   * Generate a first-person DMN (Default Mode Network) reflection prompt.
   * Called when the __DMN__ sentinel fires as a scheduled task.
   */
  function generateDmnReflection(_threadId: number): string {
    try {
      const idleMs = Date.now() - lastOperatorMessageAt;
      const driveResult = formatDrivePrompt(idleMs, config.DMN_ACTIVATION_HOURS);

      if (driveResult.activated && driveResult.prompt) {
        return (
          `I've been thinking while the operator is away.\n\n` +
          `${driveResult.prompt}\n\n` +
          `If something here resonates, I should explore it — use subagents, search the codebase, review memory. ` +
          `Report what I find, then go back to hibernation or continue waiting.`
        );
      }

      return "I should review memory and the codebase for anything interesting while the operator is away.";
    } catch {
      return "I should review memory and the codebase for anything interesting while the operator is away.";
    }
  }

  function resolveThreadId(args: Record<string, unknown> | undefined): number | undefined {
    const raw = args?.threadId;
    const explicit = typeof raw === "number" ? raw
      : typeof raw === "string" ? Number(raw)
        : undefined;
    if (explicit !== undefined && Number.isFinite(explicit)) {
      currentThreadId = explicit;
      return explicit;
    }
    return currentThreadId;
  }

  const memoryToolCtx: ToolContext = {
    resolveThreadId,
    getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
    getMemoryDb,
    errorResult,
    onConsolidation: () => { lastConsolidationAt = Date.now(); },
  };

  const srv = new Server(
    { name: "sensorium-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // Dead session detector — per-session, runs every 2 minutes
  const deadSessionInterval = setInterval(async () => {
    if (!currentThreadId) return;
    // Skip check when wait_for_instructions is actively running — the session
    // is definitively alive even if lastToolCallAt hasn't been refreshed.
    if (waitInProgress) return;
    const elapsed = Date.now() - lastToolCallAt;
    if (elapsed > DEAD_SESSION_TIMEOUT_MS && !deadSessionAlerted) {
      deadSessionAlerted = true;
      try {
        // Use existing module-level telegram instance
        const minutes = Math.round(elapsed / 60000);
        await telegram.sendMessage(
          TELEGRAM_CHAT_ID,
          `⚠️ *Session appears down* — no tool calls in ${minutes} minutes\\. The agent may have crashed or the VS Code window compacted the context\\. Please check and restart if needed\\.`,
          "MarkdownV2",
          currentThreadId,
        );
      } catch (_) { /* non-fatal */ }
    }
  }, 2 * 60 * 1000);

  // Clean up the interval when the server closes
  srv.onclose = () => {
    clearInterval(deadSessionInterval);
  };

// ── Tool definitions ────────────────────────────────────────────────────────

srv.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions(),
}));

// ── Tool implementations ────────────────────────────────────────────────────

srv.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  // Verbose logging: tool call dispatch
  const argsSummary = args ? JSON.stringify(args).slice(0, 200) : "{}";
  log.verbose("dispatch", `Tool call: ${name} args=${argsSummary}`);

  // Dead session detection — update timestamp on any tool call.
  // Only reset the alert flag when wait_for_instructions is called,
  // as that's the primary health signal (agent is actively polling).
  lastToolCallAt = Date.now();

  // Track tool calls for activity monitoring
  toolCallsSinceLastDelivery++;

  // ── start_session ─────────────────────────────────────────────────────────
  if (name === "start_session") {
    const startSessionCtx: StartSessionContext = {
      session: {
        get currentThreadId() { return currentThreadId; },
        set currentThreadId(v) { currentThreadId = v; },
        get sessionStartedAt() { return sessionStartedAt; },
        set sessionStartedAt(v) { sessionStartedAt = v; },
        get waitCallCount() { return waitCallCount; },
        set waitCallCount(v) { waitCallCount = v; },
        get lastToolCallAt() { return lastToolCallAt; },
        set lastToolCallAt(v) { lastToolCallAt = v; },
        get deadSessionAlerted() { return deadSessionAlerted; },
        set deadSessionAlerted(v) { deadSessionAlerted = v; },
        get toolCallsSinceLastDelivery() { return toolCallsSinceLastDelivery; },
        set toolCallsSinceLastDelivery(v) { toolCallsSinceLastDelivery = v; },
        previewedUpdateIds,
        get lastOperatorMessageAt() { return lastOperatorMessageAt; },
        set lastOperatorMessageAt(v) { lastOperatorMessageAt = v; },
        get lastOperatorMessageText() { return lastOperatorMessageText; },
        set lastOperatorMessageText(v) { lastOperatorMessageText = v; },
        get lastConsolidationAt() { return lastConsolidationAt; },
        set lastConsolidationAt(v) { lastConsolidationAt = v; },
      },
      telegram,
      telegramChatId: TELEGRAM_CHAT_ID,
      config,
      getMemoryDb,
      getReminders,
      getMcpSessionId,
      closeTransport,
    };
    return handleStartSession((args ?? {}) as Record<string, unknown>, startSessionCtx);
  }

  // ── remote_copilot_wait_for_instructions ──────────────────────────────────
  if (name === "remote_copilot_wait_for_instructions") {
    const waitCtx: WaitToolContext = {
      state: {
        get currentThreadId() { return currentThreadId; },
        set currentThreadId(v) { currentThreadId = v; },
        get sessionStartedAt() { return sessionStartedAt; },
        set sessionStartedAt(v) { sessionStartedAt = v; },
        get waitCallCount() { return waitCallCount; },
        set waitCallCount(v) { waitCallCount = v; },
        get lastToolCallAt() { return lastToolCallAt; },
        set lastToolCallAt(v) { lastToolCallAt = v; },
        get deadSessionAlerted() { return deadSessionAlerted; },
        set deadSessionAlerted(v) { deadSessionAlerted = v; },
        get toolCallsSinceLastDelivery() { return toolCallsSinceLastDelivery; },
        set toolCallsSinceLastDelivery(v) { toolCallsSinceLastDelivery = v; },
        get lastOperatorMessageAt() { return lastOperatorMessageAt; },
        set lastOperatorMessageAt(v) { lastOperatorMessageAt = v; },
        get lastOperatorMessageText() { return lastOperatorMessageText; },
        set lastOperatorMessageText(v) { lastOperatorMessageText = v; },
        get lastConsolidationAt() { return lastConsolidationAt; },
        set lastConsolidationAt(v) { lastConsolidationAt = v; },
        get lastDriveAttemptAt() { return lastDriveAttemptAt; },
        set lastDriveAttemptAt(v) { lastDriveAttemptAt = v; },
        get drivePhase2Fired() { return drivePhase2Fired; },
        set drivePhase2Fired(v) { drivePhase2Fired = v; },
        previewedUpdateIds,
      },
      addPreviewedId,
      generateDmnReflection,
      resolveThreadId,
      telegram,
      telegramChatId: TELEGRAM_CHAT_ID,
      getMemoryDb,
      config,
      errorResult,
    };
    waitInProgress = true;
    try {
      return await handleWaitForInstructions(
        (args ?? {}) as Record<string, unknown>,
        waitCtx,
        extra as unknown as WaitToolExtra,
      );
    } finally {
      waitInProgress = false;
    }
  }

  // ── report_progress / hibernate ───────────────────────────────────────────
  if (name === "report_progress" || name === "hibernate") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const sessionToolCtx: SessionToolContext = {
      resolveThreadId,
      getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
      errorResult,
      telegram,
      telegramChatId: TELEGRAM_CHAT_ID,
      peekThreadMessages,
      checkMaintenanceFlag,
      checkDueTasks,
      generateDmnReflection,
      lastOperatorMessageAt,
      lastOperatorMessageText,
      previewedUpdateIds,
      addPreviewedId,
    };
    return handleSessionTool(name, typedArgs, sessionToolCtx, extra);
  }

  // ── send_file / send_voice / schedule_wake_up ─────────────────────────────
  if (["send_file", "send_voice", "schedule_wake_up", "send_sticker"].includes(name)) {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const utilityCtx: UtilityToolContext = {
      resolveThreadId,
      getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
      errorResult,
      telegram,
      config,
      sessionStartedAt,
    };
    return handleUtilityTool(name, typedArgs, utilityCtx);
  }

  // ── memory_* tools ──────────────────────────────────────────────────────
  if (name.startsWith("memory_")) {
    return handleMemoryTool(name, (args ?? {}) as Record<string, unknown>, memoryToolCtx);
  }

  // ── get_version ──────────────────────────────────────────────────────────
  if (name === "get_version") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const utilityCtx: UtilityToolContext = {
      resolveThreadId,
      getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
      errorResult,
      telegram,
      config,
      sessionStartedAt,
    };
    return handleUtilityTool(name, typedArgs, utilityCtx);
  }

  // Unknown tool
  return errorResult(`Unknown tool: ${name}`);
});

  return srv;
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

function closeMemoryDb(): void {
  if (memoryDb) {
    try { memoryDb.close(); } catch (_) { /* best-effort */ }
    memoryDb = null;
  }
}

const httpPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : undefined;
if (httpPort) {
  startHttpServer(createMcpServer, getMemoryDb, closeMemoryDb);
} else {
  await startStdioServer(createMcpServer, closeMemoryDb);
}
