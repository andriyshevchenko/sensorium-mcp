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
import { formatDrivePrompt } from "../drive.js";
import {
  assembleCompactRefresh,
  runIntelligentConsolidation,
  saveEpisode,
  saveVoiceSignature,
  searchByEmbedding,
  searchSemanticNotesRanked,
  type initMemoryDb,
} from "../memory.js";
import {
  analyzeVideoFrames,
  analyzeVoiceEmotion,
  chatCompletion,
  extractVideoFrames,
  generateEmbedding,
  transcribeAudio,
} from "../openai.js";
import { checkDueTasks, listSchedules } from "../scheduler.js";
import type { TelegramClient } from "../telegram.js";
import type { AppConfig } from "../types.js";
import { errorMessage, IMAGE_EXTENSIONS } from "../utils.js";
import { extractSearchKeywords, buildAnalysisTags, getReminders, getShortReminder } from "../response-builders.js";
import { backfillEmbeddings } from "./memory-tools.js";

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
    lastConsolidationAt: number;
    previewedUpdateIds: Set<number>;
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

  while (Date.now() < deadline) {
    // Check for pending update — tell agent to wait externally via Desktop Commander
    // CRITICAL: Do NOT tell agents to call hibernate or any MCP tool here — the server
    // is about to die. Agents must use an external sleep (PowerShell Start-Sleep) instead.
    const maintenanceInfo = checkMaintenanceFlag();
    if (maintenanceInfo) {
      process.stderr.write(`[wait] Maintenance flag detected: ${maintenanceInfo}\n`);
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
        process.stderr.write(`[wait] SSE connection aborted before consuming ${peeked.length} messages — leaving in queue.\n`);
        return {
          content: [{
            type: "text",
            text: "The connection was interrupted. Messages are preserved for the next call.",
          }],
        };
      }

      // Connection alive — now consume messages for real.
      const stored = readThreadMessages(effectiveThreadId);
      process.stderr.write(`[wait] Read ${stored.length} messages from thread ${effectiveThreadId}. Processing...\n`);
      // Update the operator activity timestamp for idle detection.
      state.lastOperatorMessageAt = Date.now();

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
          if (OPENAI_API_KEY) {
            try {
              process.stderr.write(`[voice] Downloading voice file ${msg.message.voice.file_id}...\n`);
              const { buffer } = await telegram.downloadFileAsBuffer(
                msg.message.voice.file_id,
              );
              process.stderr.write(`[voice] Downloaded ${buffer.length} bytes. Starting transcription + analysis...\n`);

              // Run transcription and voice analysis in parallel.
              const [transcript, analysis] = await Promise.all([
                transcribeAudio(buffer, OPENAI_API_KEY),
                VOICE_ANALYSIS_URL
                  ? analyzeVoiceEmotion(buffer, VOICE_ANALYSIS_URL)
                  : Promise.resolve(null),
              ]);

              // Build rich voice analysis tag from VANPY results.
              const tags = buildAnalysisTags(analysis);
              const analysisTag = tags.length > 0 ? ` | ${tags.join(", ")}` : "";

              contentBlocks.push({
                type: "text",
                text: transcript
                  ? `[Voice message — ${msg.message.voice.duration}s${analysisTag}, transcribed]: ${transcript}`
                  : `[Voice message — ${msg.message.voice.duration}s${analysisTag}, transcribed]: (empty — no speech detected)`,
              });

              // Auto-save voice signature
              if (analysis && effectiveThreadId !== undefined) {
                try {
                  const db = getMemoryDb();
                  const sessionId = `session_${state.sessionStartedAt}`;
                  const epId = saveEpisode(db, {
                    sessionId,
                    threadId: effectiveThreadId,
                    type: "operator_message",
                    modality: "voice",
                    content: { text: transcript ?? "", duration: msg.message.voice.duration },
                    importance: 0.6,
                  });
                  saveVoiceSignature(db, {
                    episodeId: epId,
                    emotion: analysis.emotion ?? undefined,
                    arousal: analysis.arousal ?? undefined,
                    dominance: analysis.dominance ?? undefined,
                    valence: analysis.valence ?? undefined,
                    speechRate: analysis.paralinguistics?.speech_rate ?? undefined,
                    meanPitchHz: analysis.paralinguistics?.mean_pitch_hz ?? undefined,
                    pitchStdHz: analysis.paralinguistics?.pitch_std_hz ?? undefined,
                    jitter: analysis.paralinguistics?.jitter ?? undefined,
                    shimmer: analysis.paralinguistics?.shimmer ?? undefined,
                    hnrDb: analysis.paralinguistics?.hnr_db ?? undefined,
                    audioEvents: analysis.audio_events?.map(e => ({ label: e.label, confidence: e.score })),
                    durationSec: msg.message.voice.duration,
                  });
                  savedEpisodeUpdateIds.add(msg.update_id);
                } catch (_) { /* non-fatal */ }
              }
            } catch (err) {
              contentBlocks.push({
                type: "text",
                text: `[Voice message — ${msg.message.voice.duration}s — transcription failed: ${errorMessage(err)}]`,
              });
            }
          } else {
            contentBlocks.push({
              type: "text",
              text: `[Voice message received — ${msg.message.voice.duration}s — cannot transcribe: OPENAI_API_KEY not set]`,
            });
          }
        }
        // Video notes (circle videos): extract frames, analyze with GPT-4.1 vision,
        // optionally transcribe the audio track.
        if (msg.message.video_note) {
          hasVoiceMessages = true; // Video notes often contain speech
          const vn = msg.message.video_note;
          if (OPENAI_API_KEY) {
            try {
              process.stderr.write(`[video-note] Downloading circle video ${vn.file_id} (${vn.duration}s)...\n`);
              const { buffer } = await telegram.downloadFileAsBuffer(vn.file_id);
              process.stderr.write(`[video-note] Downloaded ${buffer.length} bytes. Extracting frames + transcribing...\n`);

              // Run frame extraction, audio transcription, and voice analysis in parallel.
              const [frames, transcript, analysis] = await Promise.all([
                extractVideoFrames(buffer, vn.duration).catch((err) => {
                  process.stderr.write(`[video-note] Frame extraction failed: ${errorMessage(err)}\n`);
                  return [] as Buffer[];
                }),
                transcribeAudio(buffer, OPENAI_API_KEY, "video.mp4").catch(() => ""),
                VOICE_ANALYSIS_URL
                  ? analyzeVoiceEmotion(buffer, VOICE_ANALYSIS_URL, {
                      mimeType: "video/mp4",
                      filename: "video.mp4",
                    }).catch(() => null)
                  : Promise.resolve(null),
              ]);

              // Analyze frames with GPT-4o-mini vision.
              let sceneDescription: string | null = "";
              if (frames.length > 0) {
                try {
                  process.stderr.write(`[video-note] Analyzing ${frames.length} frames with GPT-4o-mini vision...\n`);
                  sceneDescription = await analyzeVideoFrames(frames, vn.duration, OPENAI_API_KEY);
                  process.stderr.write(`[video-note] Vision analysis complete.\n`);
                } catch (visionErr) {
                  process.stderr.write(`[video-note] Vision analysis failed: ${visionErr}\n`);
                  sceneDescription = null;
                }
              }

              // Build analysis tags (same as voice messages).
              const tags = buildAnalysisTags(analysis);
              const analysisTag = tags.length > 0 ? ` | ${tags.join(", ")}` : "";

              const parts: string[] = [];
              parts.push(`[Video note — ${vn.duration}s${analysisTag}]`);
              if (sceneDescription) parts.push(`Scene: ${sceneDescription}`);
              if (transcript) parts.push(`Audio: "${transcript}"`);
              if (!sceneDescription && !transcript) parts.push("(no visual or audio content could be extracted)");

              contentBlocks.push({ type: "text", text: parts.join("\n") });

              // Auto-save voice signature for video notes
              if (analysis && effectiveThreadId !== undefined) {
                try {
                  const db = getMemoryDb();
                  const sessionId = `session_${state.sessionStartedAt}`;
                  const epId = saveEpisode(db, {
                    sessionId,
                    threadId: effectiveThreadId,
                    type: "operator_message",
                    modality: "video_note",
                    content: { text: transcript ?? "", scene: sceneDescription ?? "", duration: vn.duration },
                    importance: 0.6,
                  });
                  saveVoiceSignature(db, {
                    episodeId: epId,
                    emotion: analysis.emotion ?? undefined,
                    arousal: analysis.arousal ?? undefined,
                    dominance: analysis.dominance ?? undefined,
                    valence: analysis.valence ?? undefined,
                    speechRate: analysis.paralinguistics?.speech_rate ?? undefined,
                    meanPitchHz: analysis.paralinguistics?.mean_pitch_hz ?? undefined,
                    pitchStdHz: analysis.paralinguistics?.pitch_std_hz ?? undefined,
                    jitter: analysis.paralinguistics?.jitter ?? undefined,
                    shimmer: analysis.paralinguistics?.shimmer ?? undefined,
                    hnrDb: analysis.paralinguistics?.hnr_db ?? undefined,
                    audioEvents: analysis.audio_events?.map(e => ({ label: e.label, confidence: e.score })),
                    durationSec: vn.duration,
                  });
                  savedEpisodeUpdateIds.add(msg.update_id);
                } catch (_) { /* non-fatal */ }
              }
            } catch (err) {
              contentBlocks.push({
                type: "text",
                text: `[Video note — ${vn.duration}s — analysis failed: ${errorMessage(err)}]`,
              });
            }
          } else {
            contentBlocks.push({
              type: "text",
              text: `[Video note received — ${vn.duration}s — cannot analyze: OPENAI_API_KEY not set]`,
            });
          }
        }
      }
      if (contentBlocks.length === 0) {
        const msgKeys = stored.map(m => Object.keys(m.message).filter(k => (m.message as Record<string, unknown>)[k] != null).join(",")).join(" | ");
        process.stderr.write(`[wait] No content blocks from ${stored.length} messages. Fields: ${msgKeys}\n`);
        contentBlocks.push({
          type: "text",
          text: "[Unsupported message type received — the operator sent a message type that cannot be processed (e.g., sticker, location, contact). Please ask them to resend as text, photo, document, or voice.]",
        });
      }
      process.stderr.write(`[wait] ${contentBlocks.length} content blocks built. Saving episodes...\n`);

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

      process.stderr.write(`[wait] Episodes saved. Building auto-memory context...\n`);

      // ── Smart context injection (GPT-4o-mini preprocessor) ──────────
      // Retrieves candidate notes via embedding search, then uses GPT-4o-mini
      // to select ONLY the notes truly relevant to the operator's message.
      // This prevents context contamination from near-miss semantic matches.
      let autoMemoryContext = "";
      try {
        const db = getMemoryDb();
        const apiKey = process.env.OPENAI_API_KEY;
        const operatorText = stored
          .map(m => m.message.text ?? m.message.caption ?? "")
          .filter(Boolean)
          .join(" ")
          .slice(0, 500);

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
              process.stderr.write(`[memory] Smart filter: ${candidates.length} candidates → ${(jsonMatch ? JSON.parse(jsonMatch[0]) : []).length} selected\n`);
            } catch (filterErr) {
              // GPT-4o-mini filter failed — fall back to top-3 raw notes
              process.stderr.write(`[memory] Smart filter failed, using raw top-3: ${filterErr instanceof Error ? filterErr.message : String(filterErr)}\n`);
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

      process.stderr.write(`[wait] Returning response with ${contentBlocks.length} blocks to agent.\n`);

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
          { type: "text", text: getReminders(effectiveThreadId, false, state.sessionStartedAt, AUTONOMOUS_MODE) },
          { type: "text", text: "<<< END OPERATOR MESSAGE >>>" },
          ...(autoMemoryContext
            ? [{ type: "text" as const, text: autoMemoryContext }]
            : []),
        ],
      };
    }

    // Check scheduled tasks every ~60s during idle polling.
    if (effectiveThreadId !== undefined && Date.now() - lastScheduleCheck >= 60_000) {
      lastScheduleCheck = Date.now();
      const dueTask = checkDueTasks(effectiveThreadId, state.lastOperatorMessageAt, false);
      if (dueTask) {
        // DMN sentinel: generate dynamic first-person reflection
        const taskPrompt = dueTask.prompt === "__DMN__"
          ? ctx.generateDmnReflection(effectiveThreadId)
          : `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
            `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
            `Task prompt: ${dueTask.prompt}`;
        return {
          content: [
            {
              type: "text",
              text: taskPrompt + getReminders(effectiveThreadId, false, state.sessionStartedAt, AUTONOMOUS_MODE),
            },
          ],
        };
      }
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
        process.stderr.write(`[wait] SSE keepalive failed — connection dead. Returning early.\n`);
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
    const dueTask = checkDueTasks(effectiveThreadId, state.lastOperatorMessageAt, false);
    if (dueTask) {
      // DMN sentinel: generate dynamic first-person reflection
      const taskPrompt = dueTask.prompt === "__DMN__"
        ? ctx.generateDmnReflection(effectiveThreadId)
        : `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
          `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
          `Task prompt: ${dueTask.prompt}`;
      return {
        content: [
          {
            type: "text",
            text: taskPrompt + getReminders(effectiveThreadId, false, state.sessionStartedAt, AUTONOMOUS_MODE),
          },
        ],
      };
    }
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
  // Don't await — consolidation can take 10-30s (OpenAI call) and would
  // stall the agent's poll loop, silently delaying the timeout response.
  try {
    const idleMs = Date.now() - state.lastOperatorMessageAt;
    if (idleMs > 15 * 60 * 1000 && effectiveThreadId !== undefined && Date.now() - state.lastConsolidationAt > 30 * 60 * 1000) {
      state.lastConsolidationAt = Date.now();
      const db = getMemoryDb();
      void runIntelligentConsolidation(db, effectiveThreadId).then(async report => {
        if (report.episodesProcessed > 0) {
          process.stderr.write(`[memory] Consolidation: ${report.episodesProcessed} episodes → ${report.notesCreated} notes\n`);
        }
        await backfillEmbeddings(db);
      }).catch(err => {
        process.stderr.write(`[memory] Consolidation error: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  } catch (_) { /* consolidation failure is non-fatal */ }

  // ── Episode-count consolidation — don't wait for idle ──────────────────
  // If many episodes accumulated during active use, consolidate now.
  // This prevents stale/contradictory knowledge from persisting.
  try {
    if (effectiveThreadId !== undefined && Date.now() - state.lastConsolidationAt > 30 * 60 * 1000) {
      const db = getMemoryDb();
      const uncons = db.prepare("SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0 AND thread_id = ?").get(effectiveThreadId) as { c: number };
      if (uncons.c >= 15) {
        state.lastConsolidationAt = Date.now();
        void runIntelligentConsolidation(db, effectiveThreadId).then(async report => {
          if (report.episodesProcessed > 0) {
            process.stderr.write(`[memory] Episode-count consolidation: ${report.episodesProcessed} episodes → ${report.notesCreated} notes\n`);
          }
          await backfillEmbeddings(db);
        }).catch(err => {
          process.stderr.write(`[memory] Episode-count consolidation error: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Time-based consolidation — every 4 hours regardless ────────────────
  // Ensures stale knowledge gets cleaned up even during low-activity periods.
  try {
    const TIME_CONSOLIDATION_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
    if (effectiveThreadId !== undefined && Date.now() - state.lastConsolidationAt > TIME_CONSOLIDATION_INTERVAL) {
      state.lastConsolidationAt = Date.now();
      const db = getMemoryDb();
      process.stderr.write(`[memory] Time-based consolidation triggered (4h since last)\n`);
      void runIntelligentConsolidation(db, effectiveThreadId).then(async report => {
        if (report.episodesProcessed > 0) {
          process.stderr.write(`[memory] Time-based consolidation: ${report.episodesProcessed} episodes → ${report.notesCreated} notes\n`);
        }
        await backfillEmbeddings(db);
      }).catch(err => {
        process.stderr.write(`[memory] Time-based consolidation error: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  } catch (_) { /* non-fatal */ }

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

  // Generate autonomous goals only after extended silence (4+ hours).
  // Full drive (DMN + assignments) every 3rd poll to avoid context saturation.
  // Light Dispatcher presence on other polls for continuity.
  const DRIVE_ACTIVATION_MS = 4 * 60 * 60 * 1000; // 4 hours — Dispatcher appears
  const idleMs = Date.now() - state.lastOperatorMessageAt;
  const dispatcherActive = idleMs >= DRIVE_ACTIVATION_MS;
  const fullDrivePoll = dispatcherActive && callNumber % 3 === 0;

  if (fullDrivePoll) {
    // Full Dispatcher with DMN recall and assignments
    const autonomousHint = formatDrivePrompt(idleMs, getMemoryDb(), effectiveThreadId);
    return {
      content: [
        {
          type: "text",
          text: "[Dispatcher] I'm the Dispatcher — I coordinate agents while the operator is away. " +
            "I've reviewed your memory and the environment. Here are your assignments. " +
            "The operator will NOT respond — don't ask for clarification. " +
            "Complete the work, report progress, then call `remote_copilot_wait_for_instructions` for more.",
        },
        {
          type: "text",
          text: autonomousHint.replace(/^\n\n/, ""),
        },
        ...(memoryRefresh ? [{ type: "text" as const, text: memoryRefresh.replace(/^\n\n/, "") }] : []),
        { type: "text", text: scheduleHint + getReminders(effectiveThreadId, true, state.sessionStartedAt, AUTONOMOUS_MODE) },
      ],
    };
  }

  if (dispatcherActive) {
    // Light Dispatcher presence — calm, varied, first-person
    const lightMessages = [
      "Nothing urgent from me. The session is yours — follow your curiosity.",
      "I don't have new tasks yet. If something in memory interests you, go for it.",
      "No new assignments. If you've been working on something, keep at it. Or explore.",
      "Still waiting on operator. You're free to continue whatever caught your attention.",
      "I'll have more for you soon. In the meantime — what's been on your mind?",
    ];
    const lightMsg = lightMessages[callNumber % lightMessages.length];
    return {
      content: [
        {
          type: "text",
          text: `[Dispatcher] ${lightMsg}` +
            memoryRefresh +
            scheduleHint +
            getReminders(effectiveThreadId, true, state.sessionStartedAt, AUTONOMOUS_MODE),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text:
          `No new instructions. Call \`remote_copilot_wait_for_instructions\` again to keep listening.` +
          memoryRefresh +
          scheduleHint +
          getReminders(effectiveThreadId, false, state.sessionStartedAt, AUTONOMOUS_MODE),
      },
    ],
  };
}
