/**
 * Extracted helpers from poll-loop.ts to reduce main file complexity.
 *
 * Contains:
 *   - processIncomingMessages(): orchestrates reading, classification,
 *     media processing, episode ingestion, and response assembly for
 *     incoming operator messages.
 *   - handlePollTimeout(): runs post-timeout logic including scheduled-task
 *     checks, auto-consolidation, memory refresh, and drive activation.
 */

import { readThreadMessages } from "../../dispatcher.js";
import { assembleCompactRefresh } from "../../memory.js";
import { log } from "../../logger.js";
import { getReminders } from "../../response-builders.js";
import { listSchedules } from "../../scheduler.js";

import { processVoice, processAnimation, processVideoNote, type MediaContext } from "./media-processor.js";
import { handleReactionWithMessages } from "./reaction-handler.js";
import { checkForDueTasks } from "./task-handler.js";
import { runAutoConsolidation, checkDriveActivation } from "./drive-handler.js";
import {
  processSimpleMessage,
  handleEmptyContent,
  autoIngestEpisodes,
  buildSmartContext,
  assembleOperatorResponse,
} from "./message-delivery.js";
import { classifyIntent } from "../../intent.js";
import type { ToolResult, TextBlock, ImageBlock } from "../../types.js";
import type { WaitToolContext, WaitToolExtra } from "./poll-loop.js";

// ---------------------------------------------------------------------------
// processIncomingMessages
// ---------------------------------------------------------------------------

/**
 * Consumes queued Telegram messages for a thread, processes all media types,
 * saves episodes, injects memory context, and returns the assembled ToolResult.
 *
 * Called from the poll loop when peekThreadMessages() finds pending messages.
 *
 * @param effectiveThreadId - The thread to read messages from.
 * @param peekedCount - Number of messages found by peek (for logging).
 * @param ctx - Shared wait-tool context (state, services, config).
 * @param extra - SSE extras (signal, sendNotification).
 */
export async function processIncomingMessages(
  effectiveThreadId: number,
  peekedCount: number,
  ctx: WaitToolContext,
  extra: WaitToolExtra,
): Promise<ToolResult> {
  const { state, telegram, telegramChatId, config, getMemoryDb } = ctx;
  const { OPENAI_API_KEY, VOICE_ANALYSIS_URL, AUTONOMOUS_MODE } = config;

  // Verify SSE connection is alive BEFORE consuming messages.
  // This prevents the destructive readThreadMessages from eating
  // messages that can never be delivered to a dead connection.
  if (extra.signal.aborted) {
    log.warn(`[wait] SSE connection aborted before consuming ${peekedCount} messages — leaving in queue.`);
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

  // Smart context injection (skills are now loaded on-demand via MCP tools)
  const autoMemoryContext = await buildSmartContext(operatorText, { getMemoryDb, effectiveThreadId });
  const intent = classifyIntent(operatorText);

  log.info(`[wait] Returning response with ${contentBlocks.length} blocks to agent.`);

  return assembleOperatorResponse(
    contentBlocks,
    operatorText,
    hasVoiceMessages,
    autoMemoryContext,
    { effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt, autonomousMode: AUTONOMOUS_MODE },
    intent,
  );
}

// ---------------------------------------------------------------------------
// handlePollTimeout
// ---------------------------------------------------------------------------

/**
 * Runs after the poll loop times out with no actionable messages.
 * Checks for due scheduled tasks, builds schedule hints, runs
 * auto-consolidation, refreshes memory context, and checks the
 * autonomous drive activation.
 */
export function handlePollTimeout(
  effectiveThreadId: number | undefined,
  callNumber: number,
  ctx: WaitToolContext,
): ToolResult {
  const { state, config, getMemoryDb } = ctx;
  const { OPENAI_API_KEY, AUTONOMOUS_MODE } = config;

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
  runAutoConsolidation({ state, effectiveThreadId, getMemoryDb, apiKey: OPENAI_API_KEY || undefined, config, memoryRefresh: "", scheduleHint: "" });

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
  const driveActivationResult = checkDriveActivation({ state, effectiveThreadId, getMemoryDb, apiKey: OPENAI_API_KEY || undefined, config, memoryRefresh, scheduleHint });
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
