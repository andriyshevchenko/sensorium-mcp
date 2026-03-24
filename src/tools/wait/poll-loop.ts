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

import { readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkMaintenanceFlag } from "../../config.js";
import { peekThreadMessages, readThreadMessages } from "../../dispatcher.js";
import {
  assembleCompactRefresh,
  type initMemoryDb,
} from "../../memory.js";
import { listSchedules } from "../../scheduler.js";
import type { TelegramClient } from "../../telegram.js";
import type { AppConfig } from "../../types.js";
import { log } from "../../logger.js";
import { getReminders, getShortReminder, buildMaintenanceResponse } from "../../response-builders.js";

import { processVoice, processAnimation, processVideoNote, type MediaContext } from "./media-processor.js";
import { handleReactionWithMessages, handleReactionOnly } from "./reaction-handler.js";
import { checkForDueTasks } from "./task-handler.js";
import { runAutoConsolidation, checkDriveActivation } from "./drive-handler.js";
import { processSimpleMessage, handleEmptyContent, autoIngestEpisodes, buildSmartContext, assembleOperatorResponse } from "./message-delivery.js";
import { drainInbox } from "../../thread-mailbox.js";
import type { ToolResult, TextBlock, ImageBlock } from "../../types.js";

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
    deadSessionAlerted: boolean;
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
  const { OPENAI_API_KEY, VOICE_ANALYSIS_URL, WAIT_TIMEOUT_MINUTES, AUTONOMOUS_MODE } = config;

  // Agent is actively polling — this is the primary health signal.
  // Do NOT reset deadSessionAlerted here — the cooldown in factory.ts
  // handles repeat-prevention. Resetting it caused alert spam because
  // each wait call re-armed the detector.
  state.toolCallsSinceLastDelivery = 0;

  const effectiveThreadId = ctx.resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return ctx.errorResult(
      "Error: No active session. Call start_session first, then pass the returned threadId to this tool.",
    );
  }
  const callNumber = ++state.waitCallCount;
  const timeoutMs = WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  // ── One-shot pending task injection ──────────────────────────────────
  // If delegate_to_thread wrote a task file for this thread, deliver it
  // immediately on the first wait_for_instructions call and delete the
  // file so it only fires once.
  const PENDING_TASKS_DIR = join(homedir(), ".remote-copilot-mcp", "pending-tasks");
  const pendingTaskPath = join(PENDING_TASKS_DIR, `${effectiveThreadId}.txt`);
  try {
    const taskContent = readFileSync(pendingTaskPath, "utf-8");
    try { unlinkSync(pendingTaskPath); } catch { /* ignore cleanup errors */ }
    log.info(`[wait] Injecting pending task for thread ${effectiveThreadId} (${taskContent.length} chars)`);
    return {
      content: [
        {
          type: "text",
          text:
            `<<< OPERATOR MESSAGE >>>\n` +
            `DELEGATED TASK: ${taskContent}\n\n` +
            `Execute this task using subagents. Report progress via send_voice or report_progress. ` +
            `When complete, use hibernate or simply finish.\n` +
            `<<< END OPERATOR MESSAGE >>>`,
        },
      ],
    };
  } catch {
    // File doesn't exist or read error — fall through to normal polling
  }

  // Poll the dispatcher's per-thread file instead of calling getUpdates
  // directly. This avoids 409 conflicts between concurrent instances.
  const POLL_INTERVAL_MS = 2000;
  const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
  let lastScheduleCheck = 0;
  let lastKeepalive = Date.now();
  let maintenanceNotified = false;

  while (Date.now() < deadline) {
    // Check for pending update — tell agent to wait externally via Desktop Commander
    // CRITICAL: Do NOT tell agents to call hibernate or any MCP tool here — the server
    // is about to die. Agents must use an external sleep (PowerShell Start-Sleep) instead.
    const maintenanceInfo = checkMaintenanceFlag();
    if (maintenanceInfo) {
      log.info(`[wait] Maintenance flag detected: ${maintenanceInfo}`);

      // Notify operator via Telegram once
      if (!maintenanceNotified) {
        maintenanceNotified = true;
        let version = "unknown";
        try { version = (JSON.parse(maintenanceInfo) as { version?: string }).version ?? version; } catch { /* not JSON or missing field */ }
        telegram.sendMessage(
          telegramChatId,
          `\u26A0\uFE0F Server update: v${version} deploying. Agent sessions will reconnect after update.`,
          undefined,
          effectiveThreadId,
        ).catch(() => {});
      }

      return buildMaintenanceResponse(effectiveThreadId!, getShortReminder(effectiveThreadId, state.sessionStartedAt));
    }

    // Peek first (non-destructive) to avoid consuming messages when the
    // SSE connection may be dead.
    const peeked = peekThreadMessages(effectiveThreadId);

    if (peeked.length > 0) {
      // Verify SSE connection is alive BEFORE consuming messages.
      // This prevents the destructive readThreadMessages from eating
      // messages that can never be delivered to a dead connection.
      if (extra.signal.aborted) {
        log.warn(`[wait] SSE connection aborted before consuming ${peeked.length} messages — leaving in queue.`);
        return {
          content: [{
            type: "text",
            text: "The connection was interrupted. Messages are preserved for the next call.",
          }],
        };
      }

      // Connection alive — now consume messages for real.
      const stored = readThreadMessages(effectiveThreadId);
      log.info(`[wait] Read ${stored.length} messages from thread ${effectiveThreadId}. Processing...`);
      // Update the operator activity timestamp and last message text.
      state.lastOperatorMessageAt = Date.now();
      state.lastOperatorMessageText = stored
        .map(m => m.message.text ?? m.message.caption ?? "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000) || "";

      // Clear only the consumed IDs from the previewed set (scoped clear).
      // This is safe because Node.js is single-threaded — no report_progress
      // call can interleave between readThreadMessages and this cleanup.
      for (const msg of stored) {
        state.previewedUpdateIds.delete(msg.update_id);
      }

      // React with 👀 on each consumed message to signal "seen" to the operator.
      // Stagger calls to avoid Telegram 429 rate-limits on large batches.
      void (async () => {
        for (const msg of stored) {
          try { await telegram.setMessageReaction(telegramChatId, msg.message.message_id); } catch { /* non-critical */ }
          if (stored.length > 1) await new Promise<void>(r => setTimeout(r, 100));
        }
      })();

      const contentBlocks: Array<TextBlock | ImageBlock> = [];
      let hasVoiceMessages = false;
      // Track which messages already had episodes saved (voice/video handlers)
      const savedEpisodeUpdateIds = new Set<number>();

      for (const msg of stored) {
        // Photos, documents, text, stickers — handled by message-delivery.
        const simpleBlocks = await processSimpleMessage(msg, telegram);
        contentBlocks.push(...simpleBlocks);

        // Voice messages: transcribe using OpenAI Whisper.
        if (msg.message.voice) {
          hasVoiceMessages = true;
          const mediaCtx: MediaContext = { telegram, openaiApiKey: OPENAI_API_KEY, voiceAnalysisUrl: VOICE_ANALYSIS_URL, effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt, getMemoryDb };
          const result = await processVoice(msg, mediaCtx);
          contentBlocks.push(...result.blocks);
          if (result.episodeSaved) savedEpisodeUpdateIds.add(msg.update_id);
        }
        // Animations / GIFs: download full file, extract frames, run multi-frame vision analysis
        // (same pipeline as video_notes — uses extractVideoFrames + analyzeVideoFrames).
        if (msg.message.animation) {
          const mediaCtx: MediaContext = { telegram, openaiApiKey: OPENAI_API_KEY, voiceAnalysisUrl: VOICE_ANALYSIS_URL, effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt, getMemoryDb };
          const animBlocks = await processAnimation(msg, mediaCtx);
          contentBlocks.push(...animBlocks);
        }
        // Video notes (circle videos): extract frames, analyze with GPT-4.1 vision,
        // optionally transcribe the audio track.
        if (msg.message.video_note) {
          hasVoiceMessages = true; // Video notes often contain speech
          const mediaCtx: MediaContext = { telegram, openaiApiKey: OPENAI_API_KEY, voiceAnalysisUrl: VOICE_ANALYSIS_URL, effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt, getMemoryDb };
          const result = await processVideoNote(msg, mediaCtx);
          contentBlocks.push(...result.blocks);
          if (result.episodeSaved) savedEpisodeUpdateIds.add(msg.update_id);
        }
      }
      handleEmptyContent(contentBlocks, stored);
      log.info(`[wait] ${contentBlocks.length} content blocks built. Saving episodes...`);

      // Auto-ingest episodes for messages not already saved by voice/video handlers
      autoIngestEpisodes(stored, savedEpisodeUpdateIds, { getMemoryDb, effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt });

      // ── Check for pending operator reactions ─────────────────────────
      await handleReactionWithMessages(contentBlocks, {
        telegram,
        getMemoryDb,
        effectiveThreadId,
        sessionStartedAt: state.sessionStartedAt,
      });

      log.info(`[wait] Episodes saved. Building auto-memory context...`);

      // Extract operator text for memory search and intent classification.
      const operatorText = stored
        .map(m => m.message.text ?? m.message.caption ?? "")
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);

      // Smart context injection (GPT-4o-mini preprocessor)
      const autoMemoryContext = await buildSmartContext(operatorText, { getMemoryDb, effectiveThreadId });

      // ── Inter-thread mailbox messages ─────────────────────────────
      const mailboxMessages = drainInbox(effectiveThreadId!);
      for (const m of mailboxMessages) {
        contentBlocks.push({
          type: "text",
          text: `📨 **Inter-thread message from thread ${m.fromThreadId}:**\n${m.message}`,
        });
      }

      log.info(`[wait] Returning response with ${contentBlocks.length} blocks to agent.`);

      return assembleOperatorResponse(
        contentBlocks,
        operatorText,
        hasVoiceMessages,
        autoMemoryContext,
        { effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt, autonomousMode: AUTONOMOUS_MODE },
      );
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
        autonomousMode: AUTONOMOUS_MODE,
      });
      if (reactionResult) return reactionResult;
    }

    // Check scheduled tasks every ~60s during idle polling.
    if (effectiveThreadId !== undefined && Date.now() - lastScheduleCheck >= 60_000) {
      lastScheduleCheck = Date.now();
      const taskResult = checkForDueTasks(ctx, effectiveThreadId);
      if (taskResult) return taskResult;
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
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Timeout elapsed with no actionable message.

  // Check for scheduled wake-up tasks.
  if (effectiveThreadId !== undefined) {
    const taskResult = checkForDueTasks(ctx, effectiveThreadId);
    if (taskResult) return taskResult;
  }

  // Show pending scheduled tasks if any exist.
  let scheduleHint = "";
  if (effectiveThreadId !== undefined) {
    const pending = listSchedules(effectiveThreadId);
    if (pending.length > 0) {
      const taskList = pending.map(t => {
        let trigger = "";
        if (t.runAt) {
          trigger = `at ${new Date(t.runAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
        } else if (t.cron) {
          trigger = `cron: ${t.cron}`;
        } else if (t.afterIdleMinutes) {
          trigger = `after ${t.afterIdleMinutes}min idle`;
        }
        return `  • "${t.label}" (${trigger})`;
      }).join("\n");
      scheduleHint = `\n\n📋 **Pending scheduled tasks:**\n${taskList}`;
    }
  }

  // ── Auto-consolidation during idle (fire-and-forget) ────────────────────
  runAutoConsolidation({ state, effectiveThreadId, getMemoryDb, config, memoryRefresh: "", scheduleHint: "" });

  // Periodic memory refresh — re-ground the agent every 10 polls (~5h)
  // (reduced from 5 since auto-inject now handles per-message context)
  let memoryRefresh = "";
  if (callNumber % 10 === 0 && effectiveThreadId !== undefined) {
    try {
      const db = getMemoryDb();
      const refresh = assembleCompactRefresh(db, effectiveThreadId);
      if (refresh) memoryRefresh = `\n\n${refresh}`;
    } catch (_) { /* non-fatal */ }
  }

  // ── 3-Phase Probabilistic Autonomous Drive ──────────────────────────────
  const driveActivationResult = checkDriveActivation({ state, effectiveThreadId, getMemoryDb, config, memoryRefresh, scheduleHint });
  if (driveActivationResult) return driveActivationResult;

  return {
    content: [
      {
        type: "text",
        text:
          `No new instructions. Call \`remote_copilot_wait_for_instructions\` again to keep listening.` +
          memoryRefresh +
          scheduleHint +
          getReminders(effectiveThreadId, state.sessionStartedAt, AUTONOMOUS_MODE),
      },
    ],
  };
}
