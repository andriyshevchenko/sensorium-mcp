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
import { writeActivityHeartbeat } from "../data/file-storage.js";
import { config } from "../config.js";
import { peekThreadMessages, readThreadMessages, appendToThread } from "../dispatcher.js";
import { formatDrivePrompt } from "../drive.js";
import {
  updateDashboardActivity,
  updateDashboardThreadId,
  updateLastWaitCall,
} from "../sessions.js";
import type { TelegramClient } from "../telegram.js";
import { ALL_TOOL_DEFINITIONS } from "../tool-definitions.js";
import { errorMessage, errorResult } from "../utils.js";
import { getReminders, getShortReminder } from "../response-builders.js";
import { log } from "../logger.js";
import { handleMemoryTool, type ToolContext } from "../tools/memory-tools.js";
import { handleUtilityTool, type UtilityToolContext } from "../tools/utility-tools.js";
import { handleSessionTool, type SessionToolContext } from "../tools/session-tools.js";
import { handleStartSession, type StartSessionContext } from "../tools/start-session-tool.js";
import { handleWaitForInstructions, type WaitToolContext, type WaitToolExtra } from "../tools/wait/index.js";
import { handleStartThread, handleSendMessageToThread as handleSendMessageToThreadFile, type DelegateToolContext } from "../tools/delegate-tool.js";
import { getThreadsHealth } from "../tools/thread-lifecycle.js";
import { handleSearchSkills, handleGetSkill } from "../tools/skill-tools.js";
import type { CreateMcpServerFn, ToolResult } from "../types.js";

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
  let sessionFullyInitialized = false;
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
    apiKey: config.OPENAI_API_KEY || undefined,
    onConsolidation: () => { lastConsolidationAt = Date.now(); },
  };

  // ── Context builder helpers (capture current mutable state per-call) ────

  function buildUtilityCtx(): UtilityToolContext {
    return {
      resolveThreadId,
      getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
      errorResult,
      telegram,
      config,
      sessionStartedAt,
      getMemoryDb,
    };
  }

  function buildSessionToolCtx(): SessionToolContext {
    return {
      resolveThreadId,
      getShortReminder: (threadId) => getShortReminder(threadId, sessionStartedAt),
      errorResult,
      telegram,
      telegramChatId,
      peekThreadMessages,
      readThreadMessages,
      appendToThread,
      previewedUpdateIds,
      addPreviewedId,
      getMemoryDb,
      sessionStartedAt,
    };
  }

  // ── Dispatch table ────────────────────────────────────────────────────
  // Maps tool names to handler functions. Each receives typed args and the
  // SDK `extra` object, returning a ToolResult (or Promise thereof).

  const delegateCtx: DelegateToolContext = { telegram, telegramChatId };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolHandlers: Record<string, (typedArgs: Record<string, unknown>, extra: any) => Promise<ToolResult> | ToolResult> = {
    start_session: (typedArgs) => {
      const ctx: StartSessionContext = {
        session: {
          get currentThreadId() { return currentThreadId; },
          set currentThreadId(v) { currentThreadId = v; },
          get sessionStartedAt() { return sessionStartedAt; },
          set sessionStartedAt(v) { sessionStartedAt = v; },
          get sessionFullyInitialized() { return sessionFullyInitialized; },
          set sessionFullyInitialized(v) { sessionFullyInitialized = v; },
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
      return handleStartSession(typedArgs, ctx).then(result => {
        const sid = getMcpSessionId?.();
        if (sid && currentThreadId !== undefined) {
          updateDashboardThreadId(sid, currentThreadId);
          updateDashboardActivity(sid);
        }
        return result;
      });
    },

    remote_copilot_wait_for_instructions: (typedArgs, extra) => {
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
      return handleWaitForInstructions(typedArgs, waitCtx, extra as unknown as WaitToolExtra);
    },

    report_progress: (typedArgs, extra) => {
      const scopeErr = enforceThreadScope(typedArgs);
      if (scopeErr) return errorResult(scopeErr);
      return handleSessionTool("report_progress", typedArgs, buildSessionToolCtx(), extra);
    },

    send_file: (typedArgs) => {
      const scopeErr = enforceThreadScope(typedArgs);
      if (scopeErr) return errorResult(scopeErr);
      return handleUtilityTool("send_file", typedArgs, buildUtilityCtx());
    },

    send_voice: (typedArgs) => {
      const scopeErr = enforceThreadScope(typedArgs);
      if (scopeErr) return errorResult(scopeErr);
      return handleUtilityTool("send_voice", typedArgs, buildUtilityCtx());
    },

    send_sticker: (typedArgs) => {
      const scopeErr = enforceThreadScope(typedArgs);
      if (scopeErr) return errorResult(scopeErr);
      return handleUtilityTool("send_sticker", typedArgs, buildUtilityCtx());
    },

    schedule_wake_up: (typedArgs) =>
      handleUtilityTool("schedule_wake_up", typedArgs, buildUtilityCtx()),

    start_thread: (typedArgs) =>
      handleStartThread(typedArgs, delegateCtx),

    send_message_to_thread: (typedArgs) =>
      handleSendMessageToThreadFile({ ...typedArgs, _callerThreadId: currentThreadId }),

    get_threads_health: () => {
      try {
        const markdown = getThreadsHealth();
        return { content: [{ type: "text", text: markdown }] };
      } catch (err) {
        return errorResult(`Failed to get thread health: ${errorMessage(err)}`);
      }
    },

    get_version: (typedArgs) =>
      handleUtilityTool("get_version", typedArgs, buildUtilityCtx()),

    search_skills: (args) => handleSearchSkills(args),
    get_skill: (args) => handleGetSkill(args),
  };

  const srv = new Server(
    { name: "sensorium-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // ── Tool definitions ──────────────────────────────────────────────────────

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOL_DEFINITIONS,
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
    writeActivityHeartbeat();

    // Track tool calls for activity monitoring
    toolCallsSinceLastDelivery++;

    // ── Dispatch ─────────────────────────────────────────────────────────
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const handler = toolHandlers[name];
    if (handler) return handler(typedArgs, extra);
    if (name.startsWith("memory_")) return handleMemoryTool(name, typedArgs, memoryToolCtx);
    return errorResult(`Unknown tool: ${name}`);
  });

  return srv;
}
