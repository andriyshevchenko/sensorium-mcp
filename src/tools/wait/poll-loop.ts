/**
 * Core poll-loop orchestrator for remote_copilot_wait_for_instructions.
 *
 * This is the main long-polling loop that:
 *   - Polls the dispatcher for new operator messages every 2s
 *   - Processes all media types: text, photo, document, voice, video_note
 *   - Runs voice analysis (transcription + emotion via VANPY)
 *   - Auto-saves episodes to memory
 *   - Injects relevant memory context via GPT-4o-mini smart filter
 *   - Checks scheduled tasks during idle polling
 *   - Triggers auto-consolidation (idle, episode-count, time-based)
 *   - Sends SSE keepalive pings every 30s
 *   - Detects maintenance flags and instructs agent to wait externally
 *   - Activates the Dispatcher drive after extended operator silence
 */

import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { checkMaintenanceFlag, writeActivityHeartbeat, writeThreadHeartbeat } from "../../data/file-storage.js";
import { onMaintenanceSignal } from "../../services/maintenance-signal.js";
import { getEffectiveAgentType, getEffectiveAutonomousMode } from "../../config.js";
import { peekThreadMessages } from "../../dispatcher.js";
import type { initMemoryDb } from "../../memory.js";
import type { TelegramClient } from "../../telegram.js";
import type { AppConfig, ToolResult } from "../../types.js";
import { log } from "../../logger.js";
import { getShortReminder, buildMaintenanceResponse } from "../../response-builders.js";
import type { ThreadLifecycleService } from "../../services/thread-lifecycle.service.js";

import { PENDING_TASKS_DIR } from "../../services/process.service.js";
import { handleReactionOnly } from "./reaction-handler.js";
import { checkForDueTasks } from "./task-handler.js";
import { processIncomingMessages, handlePollTimeout } from "./message-processing.js";
import { checkDriveActivation, runAutoConsolidation } from "./drive-handler.js";

// ---------------------------------------------------------------------------
// Maintenance Telegram de-duplication
// ---------------------------------------------------------------------------

/**
 * Tracks which thread IDs have already received a Telegram maintenance
 * notification for the CURRENT update cycle.  Prevents duplicate alerts when
 * an agent (incorrectly) calls wait_for_instructions again during maintenance.
 * Automatically cleared when the maintenance flag disappears (update done).
 */
const maintenanceTgSent = new Set<number>();

// Periodically clear the set once maintenance is over so future updates
// can send fresh notifications.
setInterval(() => {
  if (maintenanceTgSent.size > 0 && checkMaintenanceFlag() === null) {
    maintenanceTgSent.clear();
  }
}, 30_000).unref();

// ---------------------------------------------------------------------------
// Pending-task file helper
// ---------------------------------------------------------------------------

/**
 * Check for a pending task file written by send_message_to_thread.
 * If one exists, atomically consume it and return a ToolResult.
 * The file now contains pre-formatted structured messages (one-shot or
 * manager-worker), so we pass the content through as-is.
 * Returns null when no pending task is available.
 */
function consumePendingTask(threadId: number): ToolResult | null {
  const pendingTaskPath = join(PENDING_TASKS_DIR, `${threadId}.txt`);
  // Fast pre-check to avoid unnecessary rename attempts every 2s
  if (!existsSync(pendingTaskPath)) return null;
  try {
    const tmpPath = pendingTaskPath + '.processing';
    renameSync(pendingTaskPath, tmpPath);
    const taskContent = readFileSync(tmpPath, "utf-8").trim();
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
    log.info(`[wait] Injecting pending task for thread ${threadId} (${taskContent.length} chars)`);
    return {
      content: [
        {
          type: "text",
          text:
            `<<< CROSS-THREAD MESSAGE >>>\n` +
            `${taskContent}\n` +
            `<<< END CROSS-THREAD MESSAGE >>>`,
        },
      ],
    };
  } catch {
    return null; // File doesn't exist or read error
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaitToolContext {
  /** Mutable per-session state — the handler reads and writes directly. */
  state: {
    currentThreadId: number | undefined;
    sessionStartedAt: number;
    waitCallCount: number;
    lastToolCallAt: number;
    toolCallsSinceLastDelivery: number;
    lastOperatorMessageAt: number;
    lastOperatorMessageText: string;
    lastConsolidationAt: number;
    previewedUpdateIds: Set<number>;
    lastDriveAttemptAt: number;
    drivePhase2Fired: boolean;
  };
  addPreviewedId: (id: number) => void;
  generateDmnReflection: (threadId: number) => string;
  resolveThreadId: (args: Record<string, unknown> | undefined) => number | undefined;

  // External services
  telegram: TelegramClient;
  telegramChatId: string;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  config: AppConfig;
  threadLifecycle: ThreadLifecycleService;

  // Response builders
  errorResult: (msg: string) => ToolResult & { isError: true };
}

export interface WaitToolExtra {
  sendNotification: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
  signal: AbortSignal;
  requestId?: string | number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleWaitForInstructions(
  args: Record<string, unknown>,
  ctx: WaitToolContext,
  extra: WaitToolExtra,
): Promise<ToolResult> {
  const { state, telegram, telegramChatId, config, getMemoryDb } = ctx;
  const { WAIT_TIMEOUT_MINUTES } = config;

  state.toolCallsSinceLastDelivery = 0;

  const effectiveThreadId = ctx.resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return ctx.errorResult(
      "Error: No active session. Call start_session first, then pass the returned threadId to this tool.",
    );
  }

  const callNumber = ++state.waitCallCount;
  const timeoutMs = WAIT_TIMEOUT_MINUTES * 60 * 1000;
  // Codex CLI enforces a hard ~120s tool-call timeout and does not handle
  // SSE keepalive progress notifications. Cap the loop to 90s so we always
  // return a valid response before the Codex client gives up.
  // Copilot CLI has a hard ~12-minute MCP tool call timeout — cap to 10 min
  // to return cleanly before the SSE stream is forcibly terminated.
  const agentType = getEffectiveAgentType(effectiveThreadId);
  const isShortTimeoutClient = agentType === "codex" || agentType === "openai_codex";
  const isCopilotClient = agentType === "copilot" || agentType === "copilot_claude" || agentType === "copilot_codex";
  const effectiveTimeoutMs = isShortTimeoutClient ? 90_000
    : isCopilotClient ? Math.min(timeoutMs, 10 * 60_000)
    : timeoutMs;
  const deadline = Date.now() + effectiveTimeoutMs;

  // ── Pending task injection (pre-loop check) ────────────────────────────
  // If start_thread or send_message_to_thread wrote a task file for this
  // thread, deliver it immediately.
  const preLoopTask = consumePendingTask(effectiveThreadId);
  if (preLoopTask) return preLoopTask;

  // Poll the dispatcher's per-thread file instead of calling getUpdates
  // directly. This avoids 409 conflicts between concurrent instances.
  const POLL_INTERVAL_MS = 2000;
  const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
  const DRIVE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  let lastScheduleCheck = 0;
  let lastKeepalive = Date.now();
  let lastDriveCheck = 0;
  let lastRegistryUpdate = 0;

  while (Date.now() < deadline) {
    try {
    // Bail out immediately if the MCP transport signalled abort (client disconnected).
    if (extra.signal.aborted) {
      log.info(`[wait] Signal aborted — client disconnected, exiting poll loop.`);
      state.lastToolCallAt = Date.now();
      return {
        content: [{ type: "text", text: "Client disconnected. Call wait_for_instructions again to resume." }],
      };
    }

    // Check for pending update — tell agent to use the watcher MCP server
    // CRITICAL: Do NOT tell agents to call any MCP tool on sensorium-mcp
    // here — the server is about to die. Agents must call await_server_ready on
    // sensorium-watcher (or fall back to an external sleep) instead.
    const maintenanceInfo = checkMaintenanceFlag();
    if (maintenanceInfo) {
      log.info(`[wait] Maintenance flag detected: ${maintenanceInfo}`);

      // Notify operator via Telegram once **per thread across all
      // wait_for_instructions calls**.  Uses a module-level Set so an agent
      // that (incorrectly) re-calls wait_for_instructions during maintenance
      // does not fire a duplicate Telegram notification.
      const tgKey = effectiveThreadId ?? 0;
      if (!maintenanceTgSent.has(tgKey)) {
        maintenanceTgSent.add(tgKey);
        let version = "unknown";
        try { version = (JSON.parse(maintenanceInfo) as { version?: string }).version ?? version; } catch { /* not JSON or missing field */ }
        telegram.sendMessage(
          telegramChatId,
          `\u26A0\uFE0F Server update: v${version} deploying. Agent sessions will reconnect after update.`,
          undefined,
          effectiveThreadId,
        ).catch(() => {});
      }

      return buildMaintenanceResponse(effectiveThreadId, getShortReminder(effectiveThreadId, state.sessionStartedAt));
    }

    // Peek first (non-destructive) to avoid consuming messages when the
    // SSE connection may be dead.
    const peeked = peekThreadMessages(effectiveThreadId);

    if (peeked.length > 0) {
      return processIncomingMessages(effectiveThreadId, peeked.length, ctx, extra);
    }

    // ── Reaction-only wake-up ───────────────────────────────────────
    // Guard: don't consume the reaction file if the SSE connection is
    // already dead — readPendingReaction() is destructive (read + delete).
    // Without this check the reaction is eaten but never delivered.
    if (!extra.signal.aborted) {
      const reactionResult = await handleReactionOnly({
        telegram,
        getMemoryDb,
        effectiveThreadId,
        sessionStartedAt: state.sessionStartedAt,
        autonomousMode: getEffectiveAutonomousMode(effectiveThreadId),
      });
      if (reactionResult) return reactionResult;
    }

    // ── Pending task injection (in-loop) ───────────────────────────────
    // Check for tasks sent via send_message_to_thread while we're already
    // polling.  Without this, messages arrive only on the NEXT
    // wait_for_instructions call, causing a "no instructions" gap.
    if (!extra.signal.aborted) {
      const inLoopTask = consumePendingTask(effectiveThreadId);
      if (inLoopTask) return inLoopTask;
    }

    // Check scheduled tasks every ~60s during idle polling.
    if (effectiveThreadId !== undefined && getEffectiveAutonomousMode(effectiveThreadId) && Date.now() - lastScheduleCheck >= 60_000) {
      lastScheduleCheck = Date.now();
      const taskResult = checkForDueTasks(ctx, effectiveThreadId);
      if (taskResult) return taskResult;
    }

    // ── In-loop drive activation check (every 30 min) ──────────────────
    // Without this, the drive only fires on poll TIMEOUT (every 2h default).
    // Checking inside the loop ensures consistent activation during long polls.
    if (effectiveThreadId !== undefined && getEffectiveAutonomousMode(effectiveThreadId) && Date.now() - lastDriveCheck >= DRIVE_CHECK_INTERVAL_MS) {
      lastDriveCheck = Date.now();
      runAutoConsolidation({ state, effectiveThreadId, getMemoryDb, apiKey: config.OPENAI_API_KEY || undefined, config, memoryRefresh: "", scheduleHint: "" });
      const driveResult = checkDriveActivation({ state, effectiveThreadId, getMemoryDb, apiKey: config.OPENAI_API_KEY || undefined, config, memoryRefresh: "", scheduleHint: "" });
      if (driveResult) return driveResult;
    }

    // No messages yet — sleep briefly and check again.
    // Send SSE keepalive to prevent silent connection death during long polls.
    if (Date.now() - lastKeepalive >= SSE_KEEPALIVE_INTERVAL_MS) {
      lastKeepalive = Date.now();
      state.lastToolCallAt = Date.now();
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: extra.requestId,
            progress: 0,
            total: 0,
          },
        });
      } catch {
        // If notification fails, the SSE stream is already dead.
        // Return immediately so the agent can reconnect.
        log.warn(`[wait] SSE keepalive failed — connection dead. Returning early.`);
        state.lastToolCallAt = Date.now();
        return {
          content: [{
            type: "text",
            text: "The connection was interrupted. Please call wait_for_instructions again immediately to resume polling.",
          }],
        };
      }
    }
    await new Promise<void>((resolve) => {
      let resolved = false;
      let unsubMaintenance: (() => void) | null = null;
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          unsubMaintenance?.();
          resolve();
        }
      };
      const timer = setTimeout(done, POLL_INTERVAL_MS);
      // Wake up immediately if the maintenance flag is written — don't wait
      // for the next 2s tick, which could be too late if killServer() follows
      // immediately after the flag is written.
      unsubMaintenance = onMaintenanceSignal(done);
      if (!extra.signal.aborted) {
        extra.signal.addEventListener("abort", done, { once: true });
      } else {
        done();
      }
    });
    writeActivityHeartbeat();
    if (effectiveThreadId !== undefined) {
      writeThreadHeartbeat(effectiveThreadId);
      // Update thread_registry.lastActiveAt periodically (not on every poll
      // iteration — every 60s is enough for reconnect detection).
      if (Date.now() - lastRegistryUpdate > 60_000) {
        lastRegistryUpdate = Date.now();
        try {
          ctx.threadLifecycle.touchThread(getMemoryDb(), effectiveThreadId, { lastActiveAt: new Date().toISOString() });
        } catch { /* non-critical */ }
      }
    }
    } catch (loopErr) {
      log.error(`Poll loop error: ${loopErr instanceof Error ? loopErr.message : String(loopErr)}`);
      continue;
    }
  }

  // Timeout elapsed with no actionable message.
  return handlePollTimeout(effectiveThreadId, callNumber, ctx);
}
