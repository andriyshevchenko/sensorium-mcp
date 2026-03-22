/**
 * remote_copilot_wait_for_instructions tool handler extracted from index.ts.
 *
 * This is the core long-polling loop that:
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

import { basename } from "node:path";
import { checkMaintenanceFlag, saveFileToDisk } from "../config.js";
import { peekThreadMessages, readThreadMessages } from "../dispatcher.js";
import {
  assembleCompactRefresh,
  saveEpisode,
  searchByEmbedding,
  searchSemanticNotesRanked,
  type initMemoryDb,
} from "../memory.js";
import {
  chatCompletion,
  generateEmbedding,
} from "../openai.js";
import { listSchedules } from "../scheduler.js";
import type { TelegramClient } from "../telegram.js";
import type { AppConfig } from "../types.js";
import { errorMessage, IMAGE_EXTENSIONS } from "../utils.js";
import { log } from "../logger.js";
import { extractSearchKeywords, getReminders, getMediumReminder, getShortReminder } from "../response-builders.js";
import { classifyIntent } from "../intent.js";

import { processVoice, processAnimation, processVideoNote, type MediaContext } from "./wait/media-processor.js";
import { handleReactionWithMessages, handleReactionOnly } from "./wait/reaction-handler.js";
import { checkForDueTasks } from "./wait/task-handler.js";
import { runAutoConsolidation, checkDriveActivation } from "./wait/drive-handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContentBlock = { type: string; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Array<ContentBlock>; isError?: boolean };

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
  errorResult: (msg: string) => { content: Array<{ type: string; text: string }>; isError: true };
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

  // Agent is actively polling — this is the primary health signal
  state.deadSessionAlerted = false;
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

      return {
        content: [{
          type: "text",
          text: `⚠️ **Server update pending** (${maintenanceInfo}). ` +
            `The MCP server will restart shortly. Use Desktop Commander to run: ` +
            `Start-Sleep -Seconds 600 — then call start_session with threadId=${effectiveThreadId} to reconnect.` +
            getShortReminder(effectiveThreadId, state.sessionStartedAt),
        }],
      };
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
      for (const msg of stored) {
        void telegram.setMessageReaction(
          telegramChatId,
          msg.message.message_id,
        ).catch(() => {});
      }

      type TextBlock = { type: "text"; text: string };
      type ImageBlock = { type: "image"; data: string; mimeType: string };
      const contentBlocks: Array<TextBlock | ImageBlock> = [];
      let hasVoiceMessages = false;
      // Track which messages already had episodes saved (voice/video handlers)
      const savedEpisodeUpdateIds = new Set<number>();

      for (const msg of stored) {
        // Photos: download the largest size, persist to disk, and embed as base64.
        if (msg.message.photo && msg.message.photo.length > 0) {
          const largest = msg.message.photo[msg.message.photo.length - 1];
          try {
            const { buffer, filePath: telegramPath } = await telegram.downloadFileAsBuffer(
              largest.file_id,
            );
            const ext = telegramPath.split(".").pop()?.toLowerCase() ?? "jpg";
            const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
            const base64 = buffer.toString("base64");
            const diskPath = saveFileToDisk(buffer, `photo.${ext}`);
            contentBlocks.push({ type: "image", data: base64, mimeType });
            contentBlocks.push({
              type: "text",
              text: `[Photo saved to: ${diskPath}]` +
                (msg.message.caption ? ` Caption: ${msg.message.caption}` : ""),
            });
          } catch (err) {
            contentBlocks.push({
              type: "text",
              text: `[Photo received but could not be downloaded: ${errorMessage(err)}]`,
            });
          }
        }
        // Documents: download, persist to disk, and embed as base64.
        if (msg.message.document) {
          const doc = msg.message.document;
          try {
            const { buffer, filePath: telegramPath } = await telegram.downloadFileAsBuffer(
              doc.file_id,
            );
            const filename = doc.file_name ?? basename(telegramPath);
            const ext = filename.split(".").pop()?.toLowerCase() ?? "";
            const mimeType = doc.mime_type ?? (IMAGE_EXTENSIONS.has(ext) ? `image/${ext === "jpg" ? "jpeg" : ext}` : "application/octet-stream");
            const base64 = buffer.toString("base64");
            const diskPath = saveFileToDisk(buffer, filename);
            const isImage = mimeType.startsWith("image/");
            if (isImage) {
              contentBlocks.push({ type: "image", data: base64, mimeType });
              contentBlocks.push({
                type: "text",
                text: `[File saved to: ${diskPath}]` +
                  (msg.message.caption ? ` Caption: ${msg.message.caption}` : ""),
              });
            } else {
              // Non-image documents: provide the disk path instead of
              // dumping potentially huge base64 into the LLM context.
              contentBlocks.push({
                type: "text",
                text: `[Document: ${filename} (${mimeType}) — saved to: ${diskPath}]` +
                  (msg.message.caption ? ` Caption: ${msg.message.caption}` : ""),
              });
            }
          } catch (err) {
            contentBlocks.push({
              type: "text",
              text: `[Document "${doc.file_name ?? "file"}" received but could not be downloaded: ${errorMessage(err)}]`,
            });
          }
        }
        // Text messages.
        if (msg.message.text) {
          contentBlocks.push({ type: "text", text: msg.message.text });
        }
        // Voice messages: transcribe using OpenAI Whisper.
        if (msg.message.voice) {
          hasVoiceMessages = true;
          const mediaCtx: MediaContext = { telegram, openaiApiKey: OPENAI_API_KEY, voiceAnalysisUrl: VOICE_ANALYSIS_URL, effectiveThreadId: effectiveThreadId!, sessionStartedAt: state.sessionStartedAt, getMemoryDb };
          const result = await processVoice(msg, mediaCtx);
          contentBlocks.push(...result.blocks);
          if (result.episodeSaved) savedEpisodeUpdateIds.add(msg.update_id);
        }
        // Stickers: deliver as text with emoji, set name, and file_id (so agent can re-use it).
        if (msg.message.sticker) {
          const emoji = msg.message.sticker.emoji || "🏷️";
          const setName = msg.message.sticker.set_name || "unknown";
          const fileId = msg.message.sticker.file_id;
          contentBlocks.push({
            type: "text",
            text: `(The operator sent a sticker: ${emoji} from pack "${setName}", file_id: "${fileId}")`,
          });
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
      if (contentBlocks.length === 0) {
        const msgKeys = stored.map(m => Object.keys(m.message).filter(k => (m.message as Record<string, unknown>)[k] != null).join(",")).join(" | ");
        log.warn(`[wait] No content blocks from ${stored.length} messages. Fields: ${msgKeys}`);
        contentBlocks.push({
          type: "text",
          text: "[Unsupported message type received — the operator sent a message type that cannot be processed (e.g., sticker, location, contact). Please ask them to resend as text, photo, document, or voice.]",
        });
      }
      log.info(`[wait] ${contentBlocks.length} content blocks built. Saving episodes...`);

      // Auto-ingest episodes for messages not already saved by voice/video handlers
      try {
        const db = getMemoryDb();
        const sessionId = `session_${state.sessionStartedAt}`;
        if (effectiveThreadId !== undefined) {
          // Collect text from messages that didn't already get an episode
          const unsavedMsgs = stored.filter(m => !savedEpisodeUpdateIds.has(m.update_id));
          if (unsavedMsgs.length > 0) {
            const textContent = unsavedMsgs
              .map(m => m.message.text ?? m.message.caption ?? "")
              .filter(Boolean)
              .join("\n")
              .slice(0, 2000);
            if (textContent) {
              saveEpisode(db, {
                sessionId,
                threadId: effectiveThreadId,
                type: "operator_message",
                modality: "text",
                content: { text: textContent },
                importance: 0.5,
              });
            }
          }
        }
      } catch (_) { /* memory write failures should never break the main flow */ }

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

      // ── Smart context injection (GPT-4o-mini preprocessor) ──────────
      // Retrieves candidate notes via embedding search, then uses GPT-4o-mini
      // to select ONLY the notes truly relevant to the operator's message.
      // This prevents context contamination from near-miss semantic matches.
      let autoMemoryContext = "";
      try {
        const db = getMemoryDb();
        const apiKey = process.env.OPENAI_API_KEY;

        if (operatorText.length > 10 && apiKey) {
          // Phase 1: Broad retrieval — get 10 candidates via embedding search
          let candidates: { type: string; content: string; confidence: number; similarity?: number }[] = [];
          try {
            const queryEmb = await generateEmbedding(operatorText, apiKey);
            const embResults = searchByEmbedding(db, queryEmb, { maxResults: 10, minSimilarity: 0.25, skipAccessTracking: true, threadId: effectiveThreadId });
            candidates = embResults.map(n => ({ type: n.type, content: n.content.slice(0, 200), confidence: n.confidence, similarity: n.similarity }));
          } catch {
            // Fallback to keyword search
            const searchQuery = extractSearchKeywords(operatorText);
            if (searchQuery.trim().length > 0) {
              const kwResults = searchSemanticNotesRanked(db, searchQuery, { maxResults: 10, skipAccessTracking: true, threadId: effectiveThreadId });
              candidates = kwResults.map(n => ({ type: n.type, content: n.content.slice(0, 200), confidence: n.confidence }));
            }
          }

          if (candidates.length > 0) {
            // Phase 2: GPT-4o-mini filters and compresses
            try {
              const noteList = candidates.map((c, i) => `[${i}] [${c.type}] ${c.content}`).join("\n");
              const filterResponse = await chatCompletion([
                {
                  role: "system",
                  content:
                    "You are a context filter for an AI assistant. Given an operator's message and candidate memory notes, " +
                    "select ONLY the notes that are directly relevant to the operator's current instruction or question. " +
                    "Discard notes that are tangentially related, duplicates, or noise. " +
                    "Return a JSON array of objects: [{\"i\": <index>, \"s\": \"<compressed one-liner>\"}] " +
                    "where 'i' is the note index and 's' is a compressed summary (max 80 chars). " +
                    "Return [] if no notes are relevant. Return at most 3 notes. Be aggressive about filtering.",
                },
                {
                  role: "user",
                  content: `Operator message: "${operatorText.slice(0, 300)}"\n\nCandidate notes:\n${noteList}`,
                },
              ], apiKey, { maxTokens: 200, temperature: 0 });

              // Parse the response — expect JSON array
              const jsonMatch = filterResponse.match(/\[.*\]/s);
              if (jsonMatch) {
                const filtered = JSON.parse(jsonMatch[0]) as { i: number; s: string }[];
                if (filtered.length > 0) {
                  const lines = filtered
                    .filter(f => f.i >= 0 && f.i < candidates.length)
                    .slice(0, 3)
                    .map(f => {
                      const c = candidates[f.i];
                      return `- **[${c.type}]** ${f.s} _(conf: ${c.confidence})_`;
                    });
                  if (lines.length > 0) {
                    autoMemoryContext = `\n\n## Relevant Memory (auto-injected)\n${lines.join("\n")}`;
                  }
                }
              }
              log.verbose("memory", `Smart filter: ${candidates.length} candidates → ${(jsonMatch ? JSON.parse(jsonMatch[0]) : []).length} selected`);
            } catch (filterErr) {
              // GPT-4o-mini filter failed — fall back to top-3 raw notes
              log.warn(`[memory] Smart filter failed, using raw top-3: ${filterErr instanceof Error ? filterErr.message : String(filterErr)}`);
              const lines = candidates.slice(0, 3).map(c =>
                `- **[${c.type}]** ${c.content} _(conf: ${c.confidence})_`
              );
              autoMemoryContext = `\n\n## Relevant Memory (auto-injected)\n${lines.join("\n")}`;
            }
          }
        } else if (operatorText.length > 10) {
          // No API key — keyword search, raw top-3
          const searchQuery = extractSearchKeywords(operatorText);
          if (searchQuery.trim().length > 0) {
            const kwResults = searchSemanticNotesRanked(db, searchQuery, { maxResults: 3, skipAccessTracking: true, threadId: effectiveThreadId });
            if (kwResults.length > 0) {
              const lines = kwResults.map(n =>
                `- **[${n.type}]** ${n.content.slice(0, 200)} _(conf: ${n.confidence})_`
              );
              autoMemoryContext = `\n\n## Relevant Memory (auto-injected)\n${lines.join("\n")}`;
            }
          }
        }
      } catch (_) { /* memory search failures should never break message delivery */ }

      log.info(`[wait] Returning response with ${contentBlocks.length} blocks to agent.`);

      const intent = classifyIntent(operatorText);
      log.verbose("intent", `Classified "${operatorText.substring(0, 50)}" as ${intent}`);
      const reminder = intent === "conversational"
        ? getMediumReminder(effectiveThreadId, state.sessionStartedAt, AUTONOMOUS_MODE)
        : getReminders(effectiveThreadId, state.sessionStartedAt, AUTONOMOUS_MODE);

      return {
        content: [
          {
            type: "text",
            text: "Follow the operator's instructions below.",
          },
          { type: "text", text: "<<< OPERATOR MESSAGE >>>" },
          ...contentBlocks,
          ...(hasVoiceMessages
            ? [{
              type: "text" as const,
              text: "(Operator sent voice — respond with `send_voice`.)",
            }]
            : []),
          { type: "text", text: reminder },
          { type: "text", text: "<<< END OPERATOR MESSAGE >>>" },
          ...(autoMemoryContext
            ? [{ type: "text" as const, text: autoMemoryContext }]
            : []),
        ],
      };
    }

    // ── Reaction-only wake-up ───────────────────────────────────────
    {
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
  const now = new Date().toISOString();

  // Check for scheduled wake-up tasks.
  if (effectiveThreadId !== undefined) {
    const taskResult = checkForDueTasks(ctx, effectiveThreadId);
    if (taskResult) return taskResult;
  }

  const idleMinutes = Math.round((Date.now() - state.lastOperatorMessageAt) / 60000);

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
