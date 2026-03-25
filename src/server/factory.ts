/**
 * MCP Server factory — creates a fresh Server per transport connection.
 *
 * This is required because a single Server instance can only connect to one
 * transport. In HTTP mode, each VS Code client gets its own Server instance.
 * All instances share the same tool handler logic and in-process state.
 */

import type { Database } from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkMaintenanceFlag, config } from "../config.js";
import { peekThreadMessages, readThreadMessages, appendToThread } from "../dispatcher.js";
import { formatDrivePrompt } from "../drive.js";
import { checkDueTasks } from "../scheduler.js";
import {
  updateDashboardActivity,
  updateDashboardThreadId,
  updateLastWaitCall,
} from "../sessions.js";
import type { TelegramClient } from "../telegram.js";
import { getToolDefinitions } from "../tool-definitions.js";
import { errorResult } from "../utils.js";
import { getReminders, getShortReminder } from "../response-builders.js";
import { log } from "../logger.js";
import { handleMemoryTool, type ToolContext } from "../tools/memory-tools.js";
import { handleUtilityTool, type UtilityToolContext } from "../tools/utility-tools.js";
import { handleSessionTool, type SessionToolContext } from "../tools/session-tools.js";
import { handleStartSession, type StartSessionContext } from "../tools/start-session-tool.js";
import { handleWaitForInstructions, type WaitToolContext, type WaitToolExtra } from "../tools/wait/index.js";
import { handleStartThread, handleSendMessageToThread as handleSendMessageToThreadFile, type DelegateToolContext } from "../tools/delegate-tool.js";
import type { CreateMcpServerFn } from "../types.js";

// ---------------------------------------------------------------------------
// Public factory builder
// ---------------------------------------------------------------------------

/**
 * Builds a `CreateMcpServerFn` that closes over the shared runtime singletons
 * (Telegram client, memory database accessor).  The returned function is the
 * factory that `startHttpServer` / `startStdioServer` call per-connection.
 */
export function buildMcpServerFactory(
  telegram: TelegramClient,
  telegramChatId: string,
  getMemoryDb: () => Database,
): CreateMcpServerFn {
  return (getMcpSessionId, closeTransport) =>
    createMcpServer(telegram, telegramChatId, getMemoryDb, getMcpSessionId, closeTransport);
}

// ---------------------------------------------------------------------------
// Internal — per-connection server creation
// ---------------------------------------------------------------------------

function createMcpServer(
  telegram: TelegramClient,
  telegramChatId: string,
  getMemoryDb: () => Database,
  getMcpSessionId?: () => string | undefined,
  closeTransport?: () => void,
): Server {
  const { PKG_VERSION } = config;

  // ── Per-session state (isolated per HTTP session / stdio connection) ─────
  let waitCallCount = 0;
  let sessionStartedAt = Date.now();
  let currentThreadId: number | undefined;
  let lastToolCallAt = Date.now();
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

  /**
   * Reject tool calls that try to target a thread other than the session's own.
   * Returns an error string if the scope is violated, or null if OK.
   */
  function enforceThreadScope(args: Record<string, unknown>): string | null {
    if (currentThreadId === undefined) return null;
    const raw = args?.threadId;
    const requested = typeof raw === "number" ? raw
      : typeof raw === "string" ? Number(raw)
        : undefined;
    if (requested !== undefined && Number.isFinite(requested) && requested !== currentThreadId) {
      return `Cannot send to thread ${requested} — you are on thread ${currentThreadId}. Use send_message_to_thread for cross-thread communication.`;
    }
    return null;
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

  // ── Tool definitions ──────────────────────────────────────────────────────

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions(),
  }));

  // ── Tool implementations ──────────────────────────────────────────────────

  // ToolResult intentionally omits `[key: string]: unknown` for internal type
  // safety; assert structural compatibility at the SDK boundary.
  // @ts-expect-error — ToolResult is structurally compatible but lacks index signature
  srv.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Verbose logging: tool call dispatch
    const argsSummary = args ? JSON.stringify(args).slice(0, 200) : "{}";
    log.verbose("dispatch", `Tool call: ${name} args=${argsSummary}`);

    lastToolCallAt = Date.now();

    // Track tool calls for activity monitoring
    toolCallsSinceLastDelivery++;

    // ── start_session ───────────────────────────────────────────────────────
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
        telegramChatId,
        config,
        getMemoryDb,
        getReminders,
        getMcpSessionId,
        closeTransport,
      };
      return handleStartSession((args ?? {}) as Record<string, unknown>, startSessionCtx).then(result => {
        // Update the dashboard registry with the resolved threadId
        const sid = getMcpSessionId?.();
        if (sid && currentThreadId !== undefined) {
          updateDashboardThreadId(sid, currentThreadId);
          updateDashboardActivity(sid);
        }
        return result;
      });
    }

    // ── remote_copilot_wait_for_instructions ────────────────────────────────
    if (name === "remote_copilot_wait_for_instructions") {
      // Update wait heartbeat for dashboard liveness tracking
      const waitSid = getMcpSessionId?.();
      if (waitSid) updateLastWaitCall(waitSid);

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
        telegramChatId,
        getMemoryDb,
        config,
        errorResult,
      };
      return handleWaitForInstructions(
        (args ?? {}) as Record<string, unknown>,
        waitCtx,
        extra as unknown as WaitToolExtra,
      );
    }

    // ── report_progress / hibernate ─────────────────────────────────────────
    if (name === "report_progress" || name === "hibernate") {
      const typedArgs = (args ?? {}) as Record<string, unknown>;
      if (name === "report_progress") {
        const scopeErr = enforceThreadScope(typedArgs);
        if (scopeErr) return errorResult(scopeErr);
      }
      const sessionToolCtx: SessionToolContext = {
        resolveThreadId,
        getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
        errorResult,
        telegram,
        telegramChatId,
        peekThreadMessages,
        readThreadMessages,
        appendToThread,
        checkMaintenanceFlag,
        checkDueTasks,
        generateDmnReflection,
        get lastOperatorMessageAt() { return lastOperatorMessageAt; },
        set lastOperatorMessageAt(v) { lastOperatorMessageAt = v; },
        get lastOperatorMessageText() { return lastOperatorMessageText; },
        set lastOperatorMessageText(v) { lastOperatorMessageText = v; },
        previewedUpdateIds,
        addPreviewedId,
      };
      return handleSessionTool(name, typedArgs, sessionToolCtx, extra);
    }

    // ── send_file / send_voice / schedule_wake_up ───────────────────────────
    if (["send_file", "send_voice", "schedule_wake_up", "send_sticker"].includes(name)) {
      const typedArgs = (args ?? {}) as Record<string, unknown>;
      if (name === "send_file" || name === "send_voice" || name === "send_sticker") {
        const scopeErr = enforceThreadScope(typedArgs);
        if (scopeErr) return errorResult(scopeErr);
      }
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

    // ── memory_* tools ────────────────────────────────────────────────────
    if (name.startsWith("memory_")) {
      return handleMemoryTool(name, (args ?? {}) as Record<string, unknown>, memoryToolCtx);
    }

    // ── start_thread ───────────────────────────────────────────────────────
    if (name === "start_thread") {
      const typedArgs = (args ?? {}) as Record<string, unknown>;
      const delegateCtx: DelegateToolContext = {
        telegram,
        telegramChatId,
      };
      return handleStartThread(typedArgs, delegateCtx);
    }

    // ── send_message_to_thread ─────────────────────────────────────────────
    if (name === "send_message_to_thread") {
      const typedArgs = (args ?? {}) as Record<string, unknown>;
      return handleSendMessageToThreadFile(typedArgs);
    }

    // ── get_version ────────────────────────────────────────────────────────
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
