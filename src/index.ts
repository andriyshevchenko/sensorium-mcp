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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage } from "node:http";
import { basename } from "node:path";
import { checkMaintenanceFlag, config, saveFileToDisk } from "./config.js";
import { handleDashboardRequest, type DashboardContext } from "./dashboard.js";
import { peekThreadMessages, readThreadMessages, startDispatcher } from "./dispatcher.js";
import { formatDrivePrompt } from "./drive.js";
import { convertMarkdown, splitMessage } from "./markdown.js";
import {
  assembleBootstrap,
  assembleCompactRefresh,
  forgetMemory,
  getMemoryStatus,
  getNotesWithoutEmbeddings,
  getRecentEpisodes,
  getTopicIndex,
  initMemoryDb,
  runIntelligentConsolidation,
  saveEpisode,
  saveNoteEmbedding,
  saveProcedure,
  saveSemanticNote,
  saveVoiceSignature,
  searchByEmbedding,
  searchProcedures,
  searchSemanticNotes,
  searchSemanticNotesRanked,
  supersedeNote,
  updateProcedure,
  updateSemanticNote,
} from "./memory.js";
import { analyzeVideoFrames, analyzeVoiceEmotion, chatCompletion, extractVideoFrames, generateEmbedding, textToSpeech, transcribeAudio, TTS_VOICES, type TTSVoice, type VoiceAnalysisResult } from "./openai.js";
import { addSchedule, checkDueTasks, generateTaskId, listSchedules, purgeSchedules, removeSchedule, type ScheduledTask } from "./scheduler.js";
import {
  DEAD_SESSION_TIMEOUT_MS,
  lookupSession,
  persistSession,
  purgeOtherSessions,
  registerMcpSession,
  removeSession,
  threadSessionRegistry,
} from "./sessions.js";
import { TelegramClient } from "./telegram.js";
import { getToolDefinitions } from "./tool-definitions.js";
import { rateLimiter } from "./rate-limiter.js";
import { describeADV, errorMessage, errorResult, IMAGE_EXTENSIONS, OPENAI_TTS_MAX_CHARS } from "./utils.js";

// ── Stop-word list for auto-memory keyword extraction ─────────────────
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "ought",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "him",
  "his", "she", "her", "it", "its", "they", "them", "their", "this",
  "that", "these", "those", "what", "which", "who", "whom", "when",
  "where", "why", "how", "not", "no", "nor", "so", "too", "very",
  "just", "also", "than", "then", "now", "here", "there", "all",
  "any", "each", "every", "both", "few", "more", "most", "some",
  "such", "only", "own", "same", "but", "and", "or", "if", "at",
  "by", "for", "from", "in", "into", "of", "on", "to", "up", "with",
  "as", "about", "like", "hey", "hi", "hello", "ok", "okay", "please",
  "thanks", "thank", "yes", "yeah", "no", "nah", "right", "got",
  "get", "let", "go", "going", "gonna", "want", "know", "think",
  "see", "look", "make", "take", "give", "tell", "say", "said",
]);

/** Tokenize text and strip stop words, returning up to 10 meaningful keywords. */
function extractSearchKeywords(text: string): string {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return words.slice(0, 10).join(" ");
}

/**
 * Build human-readable analysis tags from a VoiceAnalysisResult.
 * Fields that are null / undefined / empty are silently skipped.
 */
function buildAnalysisTags(analysis: VoiceAnalysisResult | null): string[] {
  const tags: string[] = [];
  if (!analysis) return tags;
  if (analysis.emotion) {
    let emotionStr = analysis.emotion;
    if (analysis.arousal != null && analysis.dominance != null && analysis.valence != null) {
      emotionStr += ` (${describeADV(analysis.arousal, analysis.dominance, analysis.valence)})`;
    }
    tags.push(`tone: ${emotionStr}`);
  }
  if (analysis.gender) tags.push(`gender: ${analysis.gender}`);
  if (analysis.audio_events && analysis.audio_events.length > 0) {
    const eventLabels = analysis.audio_events
      .map(e => `${e.label} (${Math.round(e.score * 100)}%)`)
      .join(", ");
    tags.push(`sounds: ${eventLabels}`);
  }
  if (analysis.paralinguistics) {
    const p = analysis.paralinguistics;
    const paraItems: string[] = [];
    if (p.speech_rate != null) paraItems.push(`${p.speech_rate} syl/s`);
    if (p.mean_pitch_hz != null) paraItems.push(`pitch ${p.mean_pitch_hz}Hz`);
    if (paraItems.length > 0) tags.push(`speech: ${paraItems.join(", ")}`);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Destructure config for backwards-compatible local references
// ---------------------------------------------------------------------------

const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, OPENAI_API_KEY, VOICE_ANALYSIS_URL,
  WAIT_TIMEOUT_MINUTES, FILES_DIR, PKG_VERSION } = config;

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
  let lastOperatorMessageAt = Date.now();
  let lastConsolidationAt = 0;
  let toolCallsSinceLastDelivery = 0;
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
  function generateDmnReflection(threadId: number): string {
    try {
      const db = getMemoryDb();
      const idleMs = Date.now() - lastOperatorMessageAt;
      const driveContent = formatDrivePrompt(idleMs, db, threadId);

      // Reframe in first person
      return (
        `I've been thinking while the operator is away.\n\n` +
        `${driveContent}\n\n` +
        `If something here resonates, I should explore it — use subagents, search the codebase, review memory. ` +
        `Report what I find, then go back to sleep or continue waiting.`
      );
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

  const srv = new Server(
    { name: "sensorium-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // Dead session detector — per-session, runs every 2 minutes
  const deadSessionInterval = setInterval(async () => {
    if (!currentThreadId) return;
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

/**
 * Backfill embeddings for any semantic notes that don't have them yet.
 * Used after consolidation to ensure all notes are searchable by embedding.
 */
async function backfillEmbeddings(db: ReturnType<typeof getMemoryDb>): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  const missing = getNotesWithoutEmbeddings(db);
  for (const { noteId, content } of missing) {
    try {
      const emb = await generateEmbedding(content, apiKey);
      saveNoteEmbedding(db, noteId, emb);
      process.stderr.write(`[memory] Embedded ${noteId}\n`);
    } catch (err) {
      process.stderr.write(`[memory] Embedding failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

/**
 * Full reminders — only used for wait_for_instructions and start_session
 * responses where the agent needs the complete context for decision-making.
 */
function getReminders(threadId?: number, driveActive = false): string {
  const now = new Date();
  const uptimeMin = Math.round((Date.now() - sessionStartedAt) / 60000);
  const timeStr = now.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });

  if (driveActive) {
    return (
      "\nComplete the dispatcher's tasks. Report progress via `send_voice`. Then call `remote_copilot_wait_for_instructions`." +
      ` threadId=${threadId ?? "?"} | ${timeStr} | uptime: ${uptimeMin}m`
    );
  }

  return (
    "\nUse subagents. Non-negotiable. Report progress via `send_voice`." +
    ` threadId=${threadId ?? "?"} | ${timeStr} | uptime: ${uptimeMin}m`
  );
}

/**
 * Minimal context — appended to regular tool responses to avoid bloating
 * the conversation context. Only includes thread ID and timestamp.
 */
function getShortReminder(threadId?: number): string {
  const now = new Date();
  const uptimeMin = Math.round((Date.now() - sessionStartedAt) / 60000);
  const timeStr = now.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZoneName: "short",
  });
  const threadHint = threadId !== undefined
    ? `\n- Active Telegram thread ID: **${threadId}** — if this session is restarted, call start_session with threadId=${threadId} to resume this topic.`
    : "";
  return threadHint + `\n- Current time: ${timeStr} | Session uptime: ${uptimeMin}m`;
}

srv.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  // Dead session detection — update timestamp on any tool call.
  // Only reset the alert flag when wait_for_instructions is called,
  // as that's the primary health signal (agent is actively polling).
  lastToolCallAt = Date.now();

  // Track tool calls for activity monitoring
  toolCallsSinceLastDelivery++;

  // ── Rate limiter: track API usage per tool ────────────────────────────────
  const sessionId = getMcpSessionId?.() ?? "stdio";
  const TOOL_SERVICE_MAP: Record<string, string> = {
    report_progress: "telegram",
    send_file: "telegram",
    send_voice: "telegram",
    start_session: "telegram",
    wait_for_instructions: "telegram",
    memory_search: "openai",   // embedding generation
    memory_save: "openai",     // embedding generation
    memory_save_procedure: "openai",
  };
  const trackedService = TOOL_SERVICE_MAP[name];
  if (trackedService) {
    rateLimiter.record(trackedService, sessionId, currentThreadId);
  }

  // ── start_session ─────────────────────────────────────────────────────────
  if (name === "start_session") {
    sessionStartedAt = Date.now();
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const rawThreadId = typedArgs.threadId;
    const explicitThreadId = typeof rawThreadId === "number" ? rawThreadId
      : typeof rawThreadId === "string" ? (Number.isFinite(Number(rawThreadId)) ? Number(rawThreadId) : undefined)
      : undefined;
    const customName = typeof typedArgs.name === "string" && typedArgs.name.trim()
      ? typedArgs.name.trim()
      : undefined;

    // When creating a new session (no threadId), name is mandatory.
    if (explicitThreadId === undefined && !customName) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: sessionName is required when creating a new session. Provide a descriptive name for the session.",
          },
        ],
        isError: true,
      };
    }

    // Determine the thread to use:
    // 1. Explicit threadId beats everything.
    // 2. A known name looks up the persisted mapping — resume if found.
    // 3. Otherwise create a new topic.
    let resolvedPreexisting = false;

    if (explicitThreadId !== undefined) {
      currentThreadId = explicitThreadId;
      // If a name was also supplied, keep the mapping up to date.
      if (customName) persistSession(TELEGRAM_CHAT_ID, customName, explicitThreadId);
      resolvedPreexisting = true;
    } else if (customName !== undefined) {
      const stored = lookupSession(TELEGRAM_CHAT_ID, customName);
      if (stored !== undefined) {
        currentThreadId = stored;
        resolvedPreexisting = true;
      }
    }

    if (resolvedPreexisting) {
      // Drain any stale messages from the thread file so they aren't
      // re-delivered in the next wait_for_instructions call.
      const stale = readThreadMessages(currentThreadId);
      if (stale.length > 0) {
        process.stderr.write(
          `[start_session] Drained ${stale.length} stale message(s) from thread ${currentThreadId}.\n`,
        );
        // Notify the operator that stale messages were discarded.
        try {
          const notice = convertMarkdown(
            `\u26A0\uFE0F **${stale.length} message(s) from before the session resumed were discarded.** ` +
            `If you sent instructions while the agent was offline, please resend them.`,
          );
          await telegram.sendMessage(TELEGRAM_CHAT_ID, notice, "MarkdownV2", currentThreadId);
        } catch { /* non-fatal */ }
      }

      // Resume mode: verify the thread is still alive by sending a message.
      // If the topic was deleted, drop the cached mapping and fall through to
      // create a new topic.
      try {
        // Use plain text for probe — avoids MarkdownV2 parsing failures being mistaken for dead threads
        await telegram.sendMessage(TELEGRAM_CHAT_ID, "\u{1F504} Session resumed. Continuing in this thread.", undefined, currentThreadId);
      } catch (err) {
        const errMsg = errorMessage(err);
        process.stderr.write(
          `[start_session] Probe failed for thread ${currentThreadId} in chat ${TELEGRAM_CHAT_ID}: ${errMsg}\n`,
        );
        // Telegram returns "Bad Request: message thread not found" or
        // "Bad Request: the topic was closed" for deleted/closed topics.
        const isThreadGone = /thread not found|topic.*(closed|deleted|not found)/i.test(errMsg);
        if (isThreadGone) {
          process.stderr.write(
            `[start_session] Cached thread ${currentThreadId} is gone (${errMsg}). Creating new topic.\n`,
          );
          // Drop the stale mapping and purge any scheduled tasks.
          if (currentThreadId !== undefined) purgeSchedules(currentThreadId);
          if (customName) removeSession(TELEGRAM_CHAT_ID, customName);
          resolvedPreexisting = false;
          currentThreadId = undefined;
        }
        // Other errors (network, etc.) are non-fatal — proceed anyway.
      }
    }

    if (!resolvedPreexisting) {
      // New session: create a dedicated forum topic.
      const topicName = customName ??
        `Copilot — ${new Date().toLocaleString("en-GB", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: false,
        })}`;
      try {
        const topic = await telegram.createForumTopic(TELEGRAM_CHAT_ID, topicName);
        currentThreadId = topic.message_thread_id;
        // Persist so the same name resumes this thread next time.
        persistSession(TELEGRAM_CHAT_ID, topicName, currentThreadId);
      } catch (err) {
        // Forum topics not available (e.g. plain group or DM) — cannot proceed
        // without thread isolation. Return an error so the agent knows.
        return errorResult(
          `Error: Could not create forum topic: ${errorMessage(err)}. ` +
          "Ensure the Telegram chat is a forum supergroup with the bot as admin with can_manage_topics right.",
        );
      }
      try {
        const greeting = convertMarkdown(
          "# 🤖 Remote Copilot Ready\n\n" +
          "Your AI assistant is online and listening.\n\n" +
          "**Send your instructions** and I'll get to work — " +
          "I'll keep you posted on progress as I go.",
        );
        await telegram.sendMessage(TELEGRAM_CHAT_ID, greeting, "MarkdownV2", currentThreadId);
      } catch {
        // Non-fatal.
      }
    }

    const threadNote = currentThreadId !== undefined
      ? ` Thread ID: ${currentThreadId} (pass this to start_session as threadId to resume this topic later).`
      : "";

    // Auto-bootstrap memory
    let memoryBriefing = "";
    try {
      const db = getMemoryDb();
      if (currentThreadId !== undefined) {
        memoryBriefing = "\n\n" + assembleBootstrap(db, currentThreadId);
      }
    } catch (e) {
      memoryBriefing = "\n\n_Memory system unavailable._";
    }

    // Purge stale MCP sessions for this thread (from before a server restart)
    // and register the current session.
    if (currentThreadId !== undefined) {
      const sid = getMcpSessionId?.();
      const purged = purgeOtherSessions(currentThreadId, sid);
      if (purged > 0) {
        process.stderr.write(`[start_session] Purged ${purged} stale MCP session(s) for thread ${currentThreadId}.\n`);
      }
      if (sid && closeTransport) {
        registerMcpSession(currentThreadId, sid, closeTransport);
      }
    }

    // Auto-schedule DMN reflection task if not already present.
    // This fires after 4 hours of operator silence, delivering a
    // first-person introspection prompt sourced from memory.
    // Only create on active thread — purge stale DMN tasks from other threads
    // to avoid every thread accumulating reflection tasks.
    if (currentThreadId !== undefined) {
      const existingTasks = listSchedules(currentThreadId);
      const hasDmn = existingTasks.some(t => t.label === "dmn-reflection");
      if (!hasDmn) {
        addSchedule({
          id: generateTaskId(),
          threadId: currentThreadId,
          prompt: "__DMN__", // Sentinel — handler generates dynamic content
          label: "dmn-reflection",
          afterIdleMinutes: 240, // 4 hours
          oneShot: false,
          createdAt: new Date().toISOString(),
        });
        process.stderr.write(`[start_session] Auto-scheduled DMN reflection task for thread ${currentThreadId}.\n`);
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Session ${resolvedPreexisting ? "resumed" : "started"}.${threadNote}` +
            ` Call the remote_copilot_wait_for_instructions tool next.` +
            memoryBriefing +
            getReminders(currentThreadId),
        },
      ],
    };
  }

  // ── remote_copilot_wait_for_instructions ──────────────────────────────────
  if (name === "remote_copilot_wait_for_instructions") {
    // Agent is actively polling — this is the primary health signal
    deadSessionAlerted = false;
    toolCallsSinceLastDelivery = 0; // reset on polling
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const effectiveThreadId = resolveThreadId(typedArgs);
    if (effectiveThreadId === undefined) {
      return errorResult(
        "Error: No active session. Call start_session first, then pass the returned threadId to this tool.",
      );
    }
    const callNumber = ++waitCallCount;
    const timeoutMs = WAIT_TIMEOUT_MINUTES * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    // Poll the dispatcher's per-thread file instead of calling getUpdates
    // directly. This avoids 409 conflicts between concurrent instances.
    const POLL_INTERVAL_MS = 2000;
    const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
    let lastScheduleCheck = 0;
    let lastKeepalive = Date.now();

    while (Date.now() < deadline) {
      // Check for pending update — tell agent to call sleep
      const maintenanceInfo = checkMaintenanceFlag();
      if (maintenanceInfo) {
        process.stderr.write(`[wait] Maintenance flag detected: ${maintenanceInfo}\n`);
        return {
          content: [{
            type: "text",
            text: `⚠️ **Server update pending** (${maintenanceInfo}). ` +
              `Call \`sleep\` now to allow a safe restart. Your session will resume after the update.` +
              getShortReminder(effectiveThreadId),
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
        lastOperatorMessageAt = Date.now();

        // Clear only the consumed IDs from the previewed set (scoped clear).
        // This is safe because Node.js is single-threaded — no report_progress
        // call can interleave between readThreadMessages and this cleanup.
        for (const msg of stored) {
          previewedUpdateIds.delete(msg.update_id);
        }

        // React with 👀 on each consumed message to signal "seen" to the operator.
        for (const msg of stored) {
          void telegram.setMessageReaction(
            TELEGRAM_CHAT_ID,
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
                    const sessionId = `session_${sessionStartedAt}`;
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

                // Analyze frames with GPT-4.1 vision.
                let sceneDescription = "";
                if (frames.length > 0) {
                  process.stderr.write(`[video-note] Analyzing ${frames.length} frames with GPT-4.1 vision...\n`);
                  sceneDescription = await analyzeVideoFrames(frames, vn.duration, OPENAI_API_KEY);
                  process.stderr.write(`[video-note] Vision analysis complete.\n`);
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
                    const sessionId = `session_${sessionStartedAt}`;
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
          const sessionId = `session_${sessionStartedAt}`;
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
            { type: "text", text: getReminders(effectiveThreadId) },
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
        const dueTask = checkDueTasks(effectiveThreadId, lastOperatorMessageAt, false);
        if (dueTask) {
          // DMN sentinel: generate dynamic first-person reflection
          const taskPrompt = dueTask.prompt === "__DMN__"
            ? generateDmnReflection(effectiveThreadId)
            : `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
              `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
              `Task prompt: ${dueTask.prompt}`;
          return {
            content: [
              {
                type: "text",
                text: taskPrompt + getReminders(effectiveThreadId),
              },
            ],
          };
        }
      }

      // No messages yet — sleep briefly and check again.
      // Send SSE keepalive to prevent silent connection death during long polls.
      if (Date.now() - lastKeepalive >= SSE_KEEPALIVE_INTERVAL_MS) {
        lastKeepalive = Date.now();
        lastToolCallAt = Date.now();
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
          lastToolCallAt = Date.now();
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
      const dueTask = checkDueTasks(effectiveThreadId, lastOperatorMessageAt, false);
      if (dueTask) {
        // DMN sentinel: generate dynamic first-person reflection
        const taskPrompt = dueTask.prompt === "__DMN__"
          ? generateDmnReflection(effectiveThreadId)
          : `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
            `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
            `Task prompt: ${dueTask.prompt}`;
        return {
          content: [
            {
              type: "text",
              text: taskPrompt + getReminders(effectiveThreadId),
            },
          ],
        };
      }
    }

    const idleMinutes = Math.round((Date.now() - lastOperatorMessageAt) / 60000);

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
      const idleMs = Date.now() - lastOperatorMessageAt;
      if (idleMs > 15 * 60 * 1000 && effectiveThreadId !== undefined && Date.now() - lastConsolidationAt > 30 * 60 * 1000) {
        lastConsolidationAt = Date.now();
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
      if (effectiveThreadId !== undefined && Date.now() - lastConsolidationAt > 30 * 60 * 1000) {
        const db = getMemoryDb();
        const uncons = db.prepare("SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0 AND thread_id = ?").get(effectiveThreadId) as { c: number };
        if (uncons.c >= 15) {
          lastConsolidationAt = Date.now();
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
      if (effectiveThreadId !== undefined && Date.now() - lastConsolidationAt > TIME_CONSOLIDATION_INTERVAL) {
        lastConsolidationAt = Date.now();
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
    const idleMs = Date.now() - lastOperatorMessageAt;
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
          { type: "text", text: scheduleHint + getReminders(effectiveThreadId, true) },
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
              getReminders(effectiveThreadId, true),
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
            getReminders(effectiveThreadId),
        },
      ],
    };
  }

  // ── report_progress ───────────────────────────────────────────────────────

  if (name === "report_progress") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const effectiveThreadId = resolveThreadId(typedArgs);
    if (effectiveThreadId === undefined) {
      return errorResult("Error: No active session. Call start_session first, then pass the returned threadId.");
    }
    const rawMessage =
      typeof typedArgs?.message === "string"
        ? (typedArgs.message as string)
        : "";

    if (!rawMessage) {
      return errorResult("Error: 'message' argument is required for report_progress.");
    }

    // Normalize literal \n sequences to actual newlines.
    // Some MCP clients pass escape sequences as literal text (e.g. "foo\\nbar"
    // instead of "foo\nbar"). Convert them so Telegram renders line breaks.
    const normalizedMessage = rawMessage.replace(/\\n/g, "\n");

    // Convert standard Markdown to Telegram MarkdownV2.
    let message: string;
    try {
      message = convertMarkdown(normalizedMessage);
    } catch {
      // Fall back to raw text if Markdown conversion throws.
      message = normalizedMessage;
    }

    let sentAsPlainText = false;
    const mdChunks = splitMessage(message);
    try {
      for (const chunk of mdChunks) {
        await telegram.sendMessage(TELEGRAM_CHAT_ID, chunk, "MarkdownV2", effectiveThreadId);
      }
    } catch (error) {
      const errMsg = errorMessage(error);
      // If Telegram rejected the message due to a MarkdownV2 parse error,
      // retry as plain text using the original un-converted message.
      const isParseError = errMsg.includes("can't parse entities");
      if (isParseError) {
        try {
          const plainChunks = splitMessage(rawMessage);
          for (const chunk of plainChunks) {
            await telegram.sendMessage(TELEGRAM_CHAT_ID, chunk, undefined, effectiveThreadId);
          }
          sentAsPlainText = true;
        } catch (retryError) {
          process.stderr.write(
            `Failed to send progress message via Telegram (plain fallback): ${errorMessage(retryError)}\n`,
          );
          return errorResult(
            "Error: Failed to send progress update to Telegram even without formatting. " +
            "Please check the Telegram configuration and try again.",
          );
        }
      } else {
        process.stderr.write(
          `Failed to send progress message via Telegram: ${errMsg}\n`,
        );
        return errorResult(
          "Error: Failed to send progress update to Telegram. " +
          "Check the Telegram configuration and try again.",
        );
      }
    }

    // Peek at any messages the operator sent while the agent was working.
    // Uses non-destructive peek so media is preserved for full delivery
    // via remote_copilot_wait_for_instructions. Tracks previewed update_ids
    // to prevent the same messages from appearing on repeated calls.
    let pendingMessages: string[] = [];
    try {
      const pendingStored = peekThreadMessages(effectiveThreadId);
      for (const msg of pendingStored) {
        if (previewedUpdateIds.has(msg.update_id)) continue;
        addPreviewedId(msg.update_id);

        if (msg.message.photo && msg.message.photo.length > 0) {
          pendingMessages.push(
            msg.message.caption
              ? `[Photo received — will be downloaded when you call wait_for_instructions] ${msg.message.caption}`
              : "[Photo received from operator — will be downloaded when you call wait_for_instructions]",
          );
        } else if (msg.message.document) {
          pendingMessages.push(
            msg.message.caption
              ? `[Document: ${msg.message.document.file_name ?? "file"} — will be downloaded when you call wait_for_instructions] ${msg.message.caption}`
              : `[Document received: ${msg.message.document.file_name ?? "file"} — will be downloaded when you call wait_for_instructions]`,
          );
        } else if (msg.message.voice) {
          pendingMessages.push(
            `[Voice message — ${msg.message.voice.duration}s — will be transcribed on next wait]`,
          );
        } else if (msg.message.video_note) {
          pendingMessages.push(
            `[Video note — ${msg.message.video_note.duration}s — will be analyzed on next wait]`,
          );
        } else if (msg.message.text) {
          pendingMessages.push(msg.message.text);
        } else {
          pendingMessages.push("[Unsupported message type — will be shown on next wait]");
        }
      }
    } catch {
      // Non-fatal: pending messages will still be picked up by the next
      // remote_copilot_wait_for_instructions call.
    }

    const baseStatus =
      (sentAsPlainText
        ? "Progress reported successfully (as plain text — formatting could not be applied)."
        : "Progress reported successfully.") + getShortReminder(effectiveThreadId);

    const responseText =
      pendingMessages.length > 0
        ? `${baseStatus}\n\n` +
        `While you were working, the operator sent additional message(s). ` +
        `Use those messages to steer your active session: ${pendingMessages.join("\n\n")}`
        : baseStatus;

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }

  // ── send_file ─────────────────────────────────────────────────────────────
  if (name === "send_file") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const effectiveThreadId = resolveThreadId(typedArgs);
    if (effectiveThreadId === undefined) {
      return errorResult("Error: No active session. Call start_session first, then pass the returned threadId.");
    }
    const filePath = typeof typedArgs.filePath === "string" ? typedArgs.filePath.trim() : "";
    const base64Data = typeof typedArgs.base64 === "string" ? typedArgs.base64 : "";
    const caption = typeof typedArgs.caption === "string" ? typedArgs.caption : undefined;

    if (!filePath && !base64Data) {
      return errorResult("Error: either 'filePath' or 'base64' argument is required for send_file.");
    }

    try {
      let buffer: Buffer;
      let filename: string;

      if (filePath) {
        // Read directly from disk — fast, no LLM context overhead.
        buffer = await readFile(filePath);
        filename = typeof typedArgs.filename === "string" && typedArgs.filename.trim()
          ? typedArgs.filename.trim()
          : basename(filePath);
      } else {
        buffer = Buffer.from(base64Data, "base64");
        filename = typeof typedArgs.filename === "string" && typedArgs.filename.trim()
          ? typedArgs.filename.trim()
          : "file";
      }

      const ext = filename.split(".").pop()?.toLowerCase() ?? "";

      if (IMAGE_EXTENSIONS.has(ext)) {
        await telegram.sendPhoto(TELEGRAM_CHAT_ID, buffer, filename, caption, effectiveThreadId);
      } else {
        await telegram.sendDocument(TELEGRAM_CHAT_ID, buffer, filename, caption, effectiveThreadId);
      }

      return {
        content: [
          {
            type: "text",
            text: `File "${filename}" sent to Telegram successfully.` + getShortReminder(effectiveThreadId),
          },
        ],
      };
    } catch (err) {
      process.stderr.write(`Failed to send file via Telegram: ${errorMessage(err)}\n`);
      return errorResult(`Error: Failed to send file to Telegram: ${errorMessage(err)}`);
    }
  }

  // ── send_voice ──────────────────────────────────────────────────────────
  if (name === "send_voice") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const effectiveThreadId = resolveThreadId(typedArgs);
    if (effectiveThreadId === undefined) {
      return errorResult("Error: No active session. Call start_session first, then pass the returned threadId.");
    }
    const text = typeof typedArgs.text === "string" ? typedArgs.text.trim() : "";
    const validVoices = TTS_VOICES;
    const voice: TTSVoice = typeof typedArgs.voice === "string" && (validVoices as readonly string[]).includes(typedArgs.voice)
      ? typedArgs.voice as TTSVoice
      : "nova";

    if (!text) {
      return errorResult("Error: 'text' argument is required for send_voice.");
    }

    if (!OPENAI_API_KEY) {
      return errorResult("Error: OPENAI_API_KEY is not set. Cannot generate voice.");
    }

    if (text.length > OPENAI_TTS_MAX_CHARS) {
      return errorResult(`Error: text is ${text.length} characters — exceeds OpenAI TTS limit of ${OPENAI_TTS_MAX_CHARS}.`);
    }

    try {
      const audioBuffer = await textToSpeech(text, OPENAI_API_KEY, voice);
      await telegram.sendVoice(TELEGRAM_CHAT_ID, audioBuffer, effectiveThreadId);
      return {
        content: [
          {
            type: "text",
            text: `Voice message sent to Telegram successfully.` + getShortReminder(effectiveThreadId),
          },
        ],
      };
    } catch (err) {
      process.stderr.write(`Failed to send voice via Telegram: ${errorMessage(err)}\n`);
      return errorResult(`Error: Failed to send voice message: ${errorMessage(err)}`);
    }
  }

  // ── schedule_wake_up ────────────────────────────────────────────────────
  if (name === "schedule_wake_up") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const effectiveThreadId = resolveThreadId(typedArgs);
    if (effectiveThreadId === undefined) {
      return errorResult("Error: No active session. Call start_session first.");
    }

    const action = typeof typedArgs.action === "string" ? typedArgs.action : "add";

    // --- List ---
    if (action === "list") {
      const tasks = listSchedules(effectiveThreadId);
      if (tasks.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No scheduled tasks for this thread." + getShortReminder(effectiveThreadId),
          }],
        };
      }
      const lines = tasks.map(t => {
        const trigger = t.cron ? `cron: ${t.cron}` : t.runAt ? `at: ${t.runAt}` : `idle: ${t.afterIdleMinutes}min`;
        const lastFired = t.lastFiredAt ? ` (last: ${t.lastFiredAt})` : "";
        return `- **${t.label}** [${t.id}] — ${trigger}${lastFired}\n  Prompt: ${t.prompt.slice(0, 100)}${t.prompt.length > 100 ? "…" : ""}`;
      });
      return {
        content: [{
          type: "text",
          text: `**Scheduled tasks (${tasks.length}):**\n\n${lines.join("\n\n")}` + getShortReminder(effectiveThreadId),
        }],
      };
    }

    // --- Remove ---
    if (action === "remove") {
      const taskId = typeof typedArgs.taskId === "string" ? typedArgs.taskId : "";
      if (!taskId) {
        return errorResult("Error: 'taskId' is required for remove action. Use action: 'list' to see task IDs.");
      }
      const removed = removeSchedule(effectiveThreadId, taskId);
      return {
        content: [{
          type: "text",
          text: removed
            ? `Task ${taskId} removed.` + getShortReminder(effectiveThreadId)
            : `Task ${taskId} not found.` + getShortReminder(effectiveThreadId),
        }],
      };
    }

    // --- Add ---
    const label = typeof typedArgs.label === "string" ? typedArgs.label : "unnamed task";
    const prompt = typeof typedArgs.prompt === "string" ? typedArgs.prompt : "";
    if (!prompt) {
      return errorResult("Error: 'prompt' is required — this is the text that will be injected when the task fires.");
    }

    const runAt = typeof typedArgs.runAt === "string" ? typedArgs.runAt : undefined;
    const cron = typeof typedArgs.cron === "string" ? typedArgs.cron : undefined;
    const afterIdleMinutes = typeof typedArgs.afterIdleMinutes === "number" ? typedArgs.afterIdleMinutes : undefined;

    if (cron && cron.trim().split(/\s+/).length !== 5) {
      return errorResult(
        "Error: Invalid cron expression. Must be exactly 5 space-separated fields: minute hour day-of-month month day-of-week. " +
        "Example: '0 9 * * *' (daily at 9am). Only *, numbers, and comma-separated lists are supported.",
      );
    }

    if (!runAt && !cron && afterIdleMinutes == null) {
      return errorResult(
        "Error: Specify at least one trigger: 'runAt' (ISO timestamp), 'cron' (5-field), or 'afterIdleMinutes' (number).",
      );
    }

    const task: ScheduledTask = {
      id: generateTaskId(),
      threadId: effectiveThreadId,
      prompt,
      label,
      runAt,
      cron,
      afterIdleMinutes,
      oneShot: runAt != null && !cron && afterIdleMinutes == null,
      createdAt: new Date().toISOString(),
    };

    addSchedule(task);

    const triggerDesc = cron
      ? `recurring (cron: ${cron})`
      : runAt
        ? `one-shot at ${runAt}`
        : `after ${afterIdleMinutes}min of operator silence`;

    return {
      content: [{
        type: "text",
        text: `✅ Scheduled: **${label}** [${task.id}]\nTrigger: ${triggerDesc}\nPrompt: ${prompt}` +
          getShortReminder(effectiveThreadId),
      }],
    };
  }

  // ── sleep ────────────────────────────────────────────────────────────────
  if (name === "sleep") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const effectiveThreadId = resolveThreadId(typedArgs);
    if (effectiveThreadId === undefined) {
      return errorResult("Error: No active session. Call start_session first.");
    }

    const wakeAt = typeof typedArgs.wakeAt === "string" ? new Date(typedArgs.wakeAt).getTime() : undefined;
    if (wakeAt !== undefined && isNaN(wakeAt)) {
      return errorResult("Error: Invalid wakeAt timestamp. Use ISO 8601 format.");
    }

    // Max sleep: 8 hours
    const MAX_SLEEP_MS = 8 * 60 * 60 * 1000;
    const SLEEP_POLL_INTERVAL_MS = 30_000; // 30s
    const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
    const deadline = Date.now() + MAX_SLEEP_MS;
    let lastKeepalive = Date.now();

    process.stderr.write(`[sleep] Entering sleep mode. threadId=${effectiveThreadId}, wakeAt=${wakeAt ? new Date(wakeAt).toISOString() : "indefinite"}\n`);

    while (Date.now() < deadline) {
      // Check for operator messages (non-destructive peek)
      const peeked = peekThreadMessages(effectiveThreadId);
      if (peeked.length > 0) {
        process.stderr.write(`[sleep] Waking up — ${peeked.length} operator message(s) received.\n`);
        // Don't consume messages — let the next wait_for_instructions call handle them
        return {
          content: [{
            type: "text",
            text: `Woke up: operator sent a message. Call wait_for_instructions now to read it.` +
              getShortReminder(effectiveThreadId),
          }],
        };
      }

      // Maintenance flag: stay asleep (don't wake) — the watcher will restart us
      // This is distinct from wait_for_instructions which tells the agent to sleep.
      // Here we're already sleeping, so we just keep sleeping through the update.
      const maintenanceInfo = checkMaintenanceFlag();
      if (maintenanceInfo) {
        process.stderr.write(`[sleep] Maintenance flag detected — staying asleep through update: ${maintenanceInfo}\n`);
        // Skip all other checks, just keep sleeping
        await new Promise<void>((resolve) => setTimeout(resolve, SLEEP_POLL_INTERVAL_MS));
        continue;
      }

      // Check for scheduled tasks
      const dueTask = checkDueTasks(effectiveThreadId, lastOperatorMessageAt, false);
      if (dueTask) {
        process.stderr.write(`[sleep] Waking up — scheduled task fired: ${dueTask.task.label}\n`);
        // DMN sentinel: generate dynamic first-person reflection
        const taskPrompt = dueTask.prompt === "__DMN__"
          ? generateDmnReflection(effectiveThreadId)
          : `⏰ Woke up: scheduled task **"${dueTask.task.label}"**\n\n${dueTask.prompt}`;
        return {
          content: [{
            type: "text",
            text: taskPrompt + getShortReminder(effectiveThreadId),
          }],
        };
      }

      // Check alarm
      if (wakeAt && Date.now() >= wakeAt) {
        process.stderr.write(`[sleep] Waking up — alarm reached.\n`);
        return {
          content: [{
            type: "text",
            text: `Woke up: alarm time reached (${new Date(wakeAt).toISOString()}).` +
              getShortReminder(effectiveThreadId),
          }],
        };
      }

      // SSE keepalive — use the same approach as wait_for_instructions
      const sinceKeepalive = Date.now() - lastKeepalive;
      if (sinceKeepalive >= SSE_KEEPALIVE_INTERVAL_MS && extra?.sendNotification) {
        lastKeepalive = Date.now();
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
          process.stderr.write(`[sleep] SSE keepalive failed — connection lost.\n`);
          return {
            content: [{
              type: "text",
              text: "Sleep interrupted: connection lost. Call sleep again to resume." +
                getShortReminder(effectiveThreadId),
            }],
          };
        }
      }

      // Check abort signal
      if (extra.signal.aborted) {
        process.stderr.write(`[sleep] SSE connection aborted during sleep.\n`);
        return {
          content: [{
            type: "text",
            text: "Sleep interrupted: connection closed." +
              getShortReminder(effectiveThreadId),
          }],
        };
      }

      await new Promise<void>((resolve) => setTimeout(resolve, SLEEP_POLL_INTERVAL_MS));
    }

    // Max sleep duration reached
    process.stderr.write(`[sleep] Max sleep duration reached (8h).\n`);
    return {
      content: [{
        type: "text",
        text: "Woke up: maximum sleep duration reached (8 hours)." +
          getShortReminder(effectiveThreadId),
      }],
    };
  }

  // ── memory_bootstrap ────────────────────────────────────────────────────
  if (name === "memory_bootstrap") {
    const threadId = resolveThreadId(args as Record<string, unknown>);
    if (threadId === undefined) {
      return errorResult("Error: No active thread. Call start_session first." + getShortReminder());
    }
    try {
      const db = getMemoryDb();
      const briefing = assembleBootstrap(db, threadId);
      return {
        content: [{ type: "text", text: `## Memory Briefing\n\n${briefing}` + getShortReminder(threadId) }],
      };
    } catch (err) {
      return errorResult(`Memory bootstrap error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_search ───────────────────────────────────────────────────────
  if (name === "memory_search") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    const query = String(typedArgs.query ?? "");
    if (!query) {
      return errorResult("Error: query is required." + getShortReminder(threadId));
    }
    try {
      const db = getMemoryDb();
      const layers = Array.isArray(typedArgs.layers) ? typedArgs.layers.map(String) : typeof typedArgs.layers === 'string' ? [typedArgs.layers] : ["episodic", "semantic", "procedural"];
      const types = Array.isArray(typedArgs.types) ? typedArgs.types.map(String) : typeof typedArgs.types === 'string' ? [typedArgs.types] : undefined;
      const results: string[] = [];

      if (layers.includes("semantic")) {
        // Try embedding-based search first, fall back to keyword search
        const apiKey = process.env.OPENAI_API_KEY;
        let embeddingSearchDone = false;
        if (apiKey) {
          try {
            const queryEmb = await generateEmbedding(query, apiKey);
            const embNotes = searchByEmbedding(db, queryEmb, { maxResults: 10, minSimilarity: 0.25 });
            if (embNotes.length > 0) {
              results.push("### Semantic Memory (embedding search)");
              for (const n of embNotes) {
                results.push(`- **[${n.type}]** ${n.content} _(conf: ${n.confidence}, sim: ${n.similarity.toFixed(2)}, id: ${n.noteId})_`);
              }
              embeddingSearchDone = true;
            }
          } catch (embErr) {
            process.stderr.write(`[memory] Embedding search failed in memory_search, falling back to keyword: ${embErr instanceof Error ? embErr.message : String(embErr)}\n`);
          }
        }
        if (!embeddingSearchDone) {
          const notes = searchSemanticNotes(db, query, { types, maxResults: 10 });
          if (notes.length > 0) {
            results.push("### Semantic Memory");
            for (const n of notes) {
              results.push(`- **[${n.type}]** ${n.content} _(conf: ${n.confidence}, id: ${n.noteId})_`);
            }
          }
        }
      }

      if (layers.includes("procedural")) {
        const procs = searchProcedures(db, query, 5);
        if (procs.length > 0) {
          results.push("### Procedural Memory");
          for (const p of procs) {
            results.push(`- **${p.name}** (${p.type}): ${p.description} _(success: ${Math.round(p.successRate * 100)}%, id: ${p.procedureId})_`);
          }
        }
      }

      if (layers.includes("episodic") && threadId !== undefined) {
        const episodes = getRecentEpisodes(db, threadId, 10);
        const filtered = episodes.filter(ep => {
          const content = JSON.stringify(ep.content).toLowerCase();
          return query.toLowerCase().split(/\s+/).some(word => content.includes(word));
        });
        if (filtered.length > 0) {
          results.push("### Episodic Memory");
          for (const ep of filtered.slice(0, 5)) {
            const summary = typeof ep.content === "object" && ep.content !== null
              ? (ep.content as Record<string, unknown>).text ?? JSON.stringify(ep.content).slice(0, 200)
              : String(ep.content).slice(0, 200);
            results.push(`- [${ep.modality}] ${summary} _(${ep.timestamp}, id: ${ep.episodeId})_`);
          }
        }
      }

      const text = results.length > 0
        ? results.join("\n")
        : `No memories found for "${query}".`;
      return { content: [{ type: "text", text: text + getShortReminder(threadId) }] };
    } catch (err) {
      return errorResult(`Memory search error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_save ─────────────────────────────────────────────────────────
  if (name === "memory_save") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    const VALID_TYPES = ["fact", "preference", "pattern", "entity", "relationship"] as const;
    const noteType = String(typedArgs.type ?? "fact");
    if (!VALID_TYPES.includes(noteType as typeof VALID_TYPES[number])) {
      return errorResult(`Invalid type "${noteType}". Must be one of: ${VALID_TYPES.join(", ")}`);
    }
    try {
      const db = getMemoryDb();
      const content = String(typedArgs.content ?? "").trim();
      if (!content) {
        return errorResult("Error: 'content' is required and cannot be empty.");
      }
      const noteId = saveSemanticNote(db, {
        type: noteType as typeof VALID_TYPES[number],
        content,
        keywords: Array.isArray(typedArgs.keywords) ? typedArgs.keywords.map(String) : typeof typedArgs.keywords === 'string' ? [typedArgs.keywords] : [],
        confidence: typeof typedArgs.confidence === "number" ? typedArgs.confidence : 0.8,
        priority: typeof typedArgs.priority === "number" ? typedArgs.priority : 0,
        threadId: threadId ?? null,
      });
      // Fire-and-forget embedding generation
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
          void generateEmbedding(content, apiKey).then(emb => {
              saveNoteEmbedding(getMemoryDb(), noteId, emb);
          }).catch(err => {
              process.stderr.write(`[memory] Embedding failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}\n`);
          });
      }
      return {
        content: [{ type: "text", text: `Saved semantic note: ${noteId}` + getShortReminder(threadId) }],
      };
    } catch (err) {
      return errorResult(`Memory save error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_save_procedure ───────────────────────────────────────────────
  if (name === "memory_save_procedure") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    try {
      const db = getMemoryDb();
      const existingId = typedArgs.procedureId as string | undefined;
      if (existingId) {
        updateProcedure(db, existingId, {
          description: typedArgs.description as string | undefined,
          steps: Array.isArray(typedArgs.steps) ? typedArgs.steps.map(String) : typeof typedArgs.steps === 'string' ? [typedArgs.steps] : undefined,
          triggerConditions: Array.isArray(typedArgs.triggerConditions) ? typedArgs.triggerConditions.map(String) : typeof typedArgs.triggerConditions === 'string' ? [typedArgs.triggerConditions] : undefined,
        });
        return {
          content: [{ type: "text", text: `Updated procedure: ${existingId}` + getShortReminder(threadId) }],
        };
      }
      const VALID_PROC_TYPES = ["workflow", "habit", "tool_pattern", "template"] as const;
      const procType = String(typedArgs.type ?? "workflow");
      if (!VALID_PROC_TYPES.includes(procType as typeof VALID_PROC_TYPES[number])) {
        return errorResult(`Invalid procedure type "${procType}". Must be one of: ${VALID_PROC_TYPES.join(", ")}`);
      }
      const procId = saveProcedure(db, {
        name: String(typedArgs.name ?? ""),
        type: procType as typeof VALID_PROC_TYPES[number],
        description: String(typedArgs.description ?? ""),
        steps: Array.isArray(typedArgs.steps) ? typedArgs.steps.map(String) : typeof typedArgs.steps === 'string' ? [typedArgs.steps] : undefined,
        triggerConditions: Array.isArray(typedArgs.triggerConditions) ? typedArgs.triggerConditions.map(String) : typeof typedArgs.triggerConditions === 'string' ? [typedArgs.triggerConditions] : undefined,
      });
      return {
        content: [{ type: "text", text: `Saved procedure: ${procId}` + getShortReminder(threadId) }],
      };
    } catch (err) {
      return errorResult(`Procedure save error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_update ───────────────────────────────────────────────────────
  if (name === "memory_update") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    try {
      const db = getMemoryDb();
      const memId = String(typedArgs.memoryId ?? "");
      const action = String(typedArgs.action ?? "update");
      const reason = String(typedArgs.reason ?? "");

      if (action === "supersede" && memId.startsWith("sn_")) {
        const origRow = db.prepare("SELECT type, keywords FROM semantic_notes WHERE note_id = ?").get(memId) as { type: string; keywords: string } | undefined;
        if (!origRow) {
          return errorResult(`Note ${memId} not found — cannot supersede a non-existent note.`);
        }
        const newContent = String(typedArgs.newContent ?? "");
        if (!newContent.trim()) return errorResult("Error: 'newContent' is required when superseding a note. The original note would be destroyed with no replacement.");
        const newId = supersedeNote(db, memId, {
          type: origRow.type as "fact" | "preference" | "pattern" | "entity" | "relationship",
          content: newContent,
          keywords: origRow.keywords ? JSON.parse(origRow.keywords) : [],
          confidence: typeof typedArgs.newConfidence === "number" ? typedArgs.newConfidence : 0.8,
          priority: typeof typedArgs.newPriority === "number" ? typedArgs.newPriority : undefined,
        });
        return {
          content: [{ type: "text", text: `Superseded ${memId} → ${newId} (reason: ${reason})` + getShortReminder(threadId) }],
        };
      }

      if (memId.startsWith("sn_")) {
        const updates: Record<string, unknown> = {};
        if (typedArgs.newContent) updates.content = String(typedArgs.newContent);
        if (typeof typedArgs.newConfidence === "number") updates.confidence = typedArgs.newConfidence;
        if (typeof typedArgs.newPriority === "number") updates.priority = typedArgs.newPriority;
        updateSemanticNote(db, memId, updates as Parameters<typeof updateSemanticNote>[2]);
        return {
          content: [{ type: "text", text: `Updated note ${memId} (reason: ${reason})` + getShortReminder(threadId) }],
        };
      }

      if (memId.startsWith("pr_")) {
        const updates: Record<string, unknown> = {};
        if (typedArgs.newContent) updates.description = String(typedArgs.newContent);
        if (typeof typedArgs.newConfidence === "number") updates.confidence = typedArgs.newConfidence;
        updateProcedure(db, memId, updates as Parameters<typeof updateProcedure>[2]);
        return {
          content: [{ type: "text", text: `Updated procedure ${memId} (reason: ${reason})` + getShortReminder(threadId) }],
        };
      }

      return errorResult(`Unknown memory ID format: ${memId}` + getShortReminder(threadId));
    } catch (err) {
      return errorResult(`Memory update error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_consolidate ──────────────────────────────────────────────────
  if (name === "memory_consolidate") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    if (threadId === undefined) {
      return errorResult("Error: No active thread." + getShortReminder());
    }
    try {
      const db = getMemoryDb();
      const report = await runIntelligentConsolidation(db, threadId);
      lastConsolidationAt = Date.now(); // Prevent redundant auto-consolidation
      if (report.episodesProcessed === 0) {
        return {
          content: [{ type: "text", text: "No unconsolidated episodes. Memory is up to date." + getShortReminder(threadId) }],
        };
      }

      const reportLines = [
        "## Consolidation Report",
        `- Episodes processed: ${report.episodesProcessed}`,
        `- Notes created: ${report.notesCreated}`,
        `- Duration: ${report.durationMs}ms`,
      ];
      if (report.details.length > 0) {
        reportLines.push("", "### Extracted Knowledge");
        for (const d of report.details) {
          reportLines.push(`- ${d}`);
        }
      }

      return { content: [{ type: "text", text: reportLines.join("\n") + getShortReminder(threadId) }] };
    } catch (err) {
      return errorResult(`Consolidation error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_status ───────────────────────────────────────────────────────
  if (name === "memory_status") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    if (threadId === undefined) {
      return errorResult("Error: No active thread." + getShortReminder());
    }
    try {
      const db = getMemoryDb();
      const status = getMemoryStatus(db, threadId);
      const topics = getTopicIndex(db);

      const lines = [
        "## Memory Status",
        `- Episodes: ${status.totalEpisodes} (${status.unconsolidatedEpisodes} unconsolidated)`,
        `- Semantic notes: ${status.totalSemanticNotes}`,
        `- Procedures: ${status.totalProcedures}`,
        `- Voice signatures: ${status.totalVoiceSignatures}`,
        `- Last consolidation: ${status.lastConsolidation ?? "never"}`,
        `- DB size: ${(status.dbSizeBytes / 1024).toFixed(1)} KB`,
      ];

      if (topics.length > 0) {
        lines.push("", "**Topics:**");
        for (const t of topics.slice(0, 15)) {
          lines.push(`- ${t.topic} (${t.semanticCount} notes, ${t.proceduralCount} procs, conf: ${t.avgConfidence.toFixed(2)})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") + getShortReminder(threadId) }] };
    } catch (err) {
      return errorResult(`Memory status error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── memory_forget ───────────────────────────────────────────────────────
  if (name === "memory_forget") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    try {
      const db = getMemoryDb();
      const memId = String(typedArgs.memoryId ?? "");
      const reason = String(typedArgs.reason ?? "");
      const result = forgetMemory(db, memId, reason);
      if (!result.deleted) {
        return {
          content: [{ type: "text", text: `Memory ${memId} not found (layer: ${result.layer}). Nothing was deleted.` + getShortReminder(threadId) }],
        };
      }
      return {
        content: [{ type: "text", text: `Forgot ${result.layer} memory ${memId} (reason: ${reason})` + getShortReminder(threadId) }],
      };
    } catch (err) {
      return errorResult(`Memory forget error: ${errorMessage(err)}` + getShortReminder(threadId));
    }
  }

  // ── get_version ─────────────────────────────────────────────────────────
  if (name === "get_version") {
    const maintenance = checkMaintenanceFlag();
    return {
      content: [{
        type: "text",
        text: `Server version: ${config.PKG_VERSION}` +
          (maintenance ? `\n⚠️ Update pending: ${maintenance}` : ""),
      }],
    };
  }

  // ── get_usage_stats ─────────────────────────────────────────────────────
  if (name === "get_usage_stats") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    const stats = rateLimiter.getStats();
    const lines: string[] = [
      `## API Usage Stats`,
      `Active sessions sharing resources: ${stats.activeSessions}`,
      `Total API calls (last hour): ${stats.totalCallsLastHour}`,
      ``,
    ];
    for (const svc of stats.services) {
      const bar = svc.usagePercent > 80 ? "🔴" : svc.usagePercent > 50 ? "🟡" : "🟢";
      lines.push(`### ${bar} ${svc.description} (${svc.service})`);
      lines.push(`- Window usage: ${svc.callsInWindow}/${svc.maxPerWindow} (${svc.usagePercent}%)`);
      lines.push(`- Burst tokens: ${svc.availableTokens}/${svc.burstCapacity}`);
      if (svc.sessionBreakdown.length > 0) {
        lines.push(`- Per-session:`);
        for (const s of svc.sessionBreakdown) {
          lines.push(`  - Thread ${s.threadId ?? "?"}: ${s.calls} calls`);
        }
      }
      lines.push(``);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") + getShortReminder(threadId) }],
    };
  }

  // Unknown tool
  return errorResult(`Unknown tool: ${name}`);
});

  return srv;
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

const httpPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : undefined;
const httpBind = process.env.MCP_HTTP_BIND ?? "127.0.0.1";

if (httpPort) {
  // ── HTTP/SSE transport ──────────────────────────────────────────────────
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** Tracks the last time each HTTP session received any request (epoch ms). */
  const sessionLastActivity = new Map<string, number>();

  const MCP_HTTP_SECRET = process.env.MCP_HTTP_SECRET;
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
  const serverStartTime = Date.now();

  async function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on("data", (c: Buffer) => {
        totalSize += c.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
      req.on("error", reject);
    });
  }

  const httpServer = createServer(async (req: IncomingMessage, res) => {
   try {
    // CORS for local dev (restrict to localhost)
    const origin = req.headers.origin ?? "";
    const allowedOrigin = origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ? origin : "";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Dashboard routes (served before MCP auth) ─────────────────────
    const dashCtx: DashboardContext = {
      getDb: getMemoryDb,
      getActiveSessions: () => {
        const sessions: Array<{ threadId: number; mcpSessionId: string; lastActivity: number; transportType: string }> = [];
        for (const [sid, _transport] of transports) {
          // Find which thread this session belongs to
          let threadId = 0;
          for (const [tid, entries] of threadSessionRegistry) {
            if (entries.some(e => e.mcpSessionId === sid)) { threadId = tid; break; }
          }
          sessions.push({
            threadId,
            mcpSessionId: sid,
            lastActivity: sessionLastActivity.get(sid) ?? 0,
            transportType: "http",
          });
        }
        return sessions;
      },
      serverStartTime,
    };
    // Dashboard HTML pages: no auth needed (SPA handles auth in browser)
    // Dashboard API routes: auth handled by handleDashboardRequest internally
    const dashUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const isDashboardPage = dashUrl.pathname === "/" || dashUrl.pathname === "/dashboard";
    const isDashboardApi = dashUrl.pathname.startsWith("/api/");
    if (isDashboardPage || isDashboardApi) {
      const handled = handleDashboardRequest(req, res, dashCtx, MCP_HTTP_SECRET);
      if (handled) return;
    }

    // Auth check — if MCP_HTTP_SECRET is set, require Bearer token.
    // Use constant-time comparison to prevent timing attacks.
    if (MCP_HTTP_SECRET) {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${MCP_HTTP_SECRET}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !timingSafeEqual(authBuf, expectedBuf)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Request body too large or malformed");
        return;
      }

      // Existing session
      if (sessionId && transports.has(sessionId)) {
        sessionLastActivity.set(sessionId, Date.now());
        await transports.get(sessionId)!.handleRequest(req, res, body);
        return;
      }

      // New session — must be initialize
      if (!sessionId && isInitializeRequest(body)) {
        let capturedSid: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            capturedSid = sid;
            transports.set(sid, transport);
            sessionLastActivity.set(sid, Date.now());
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) { transports.delete(sid); sessionLastActivity.delete(sid); rateLimiter.removeSession(sid); }
        };

        // Create a fresh Server per HTTP session — a single Server can only
        // connect to one transport, so concurrent clients each need their own.
        const sessionServer = createMcpServer(
          () => capturedSid,
          () => { try { transport.close(); } catch (_) { /* best-effort */ } },
        );
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID or not an initialize request" },
        id: null,
      }));
      return;
    }

    if (req.method === "GET") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      sessionLastActivity.set(sessionId, Date.now());
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
      sessionLastActivity.set(sessionId, Date.now());
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
   } catch (err) {
    process.stderr.write(`[http] Unhandled error: ${typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : String(err)}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
   }
  });

  httpServer.listen(httpPort, httpBind, () => {
    process.stderr.write(`Remote Copilot MCP server running on http://${httpBind}:${httpPort}/mcp\n`);
  });

  // ── Session reaper — close abandoned SSE sessions every 10 minutes ──────
  const STALE_SESSION_MS = 2 * WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const sessionReaperInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, transport] of transports) {
      const lastActive = sessionLastActivity.get(sid) ?? 0;
      if (now - lastActive > STALE_SESSION_MS) {
        process.stderr.write(`[session-reaper] Closing stale session ${sid} (idle ${Math.round((now - lastActive) / 60000)}m)\n`);
        try { transport.close(); } catch (_) { /* best-effort */ }
        transports.delete(sid);
        sessionLastActivity.delete(sid);
        rateLimiter.removeSession(sid);
      }
    }
  }, 10 * 60 * 1000);

  // Simple shutdown — close transports, DB, and exit.
  let memoryDbClosed = false;
  const shutdown = () => {
    clearInterval(sessionReaperInterval);
    for (const [sid, t] of transports) {
      try { t.close(); } catch (_) { /* best-effort */ }
      transports.delete(sid);
    }
    httpServer.close();
    if (memoryDb && !memoryDbClosed) {
      try { memoryDb.close(); memoryDbClosed = true; } catch (_) { /* best-effort */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform === "win32") {
    process.on("SIGBREAK", shutdown);
  }
  process.on("exit", () => {
    if (memoryDb && !memoryDbClosed) { try { memoryDb.close(); } catch (_) { /* best-effort */ } }
  });
} else {
  // ── stdio transport (default) ───────────────────────────────────────────
  const transport = new StdioServerTransport();
  const server = createMcpServer();
  await server.connect(transport);
  process.stderr.write("Remote Copilot MCP server running on stdio.\n");

  let stdioDbClosed = false;
  const stdioShutdown = () => {
    if (memoryDb && !stdioDbClosed) { try { memoryDb.close(); stdioDbClosed = true; } catch (_) { /* best-effort */ } }
    process.exit(0);
  };
  process.on("SIGINT", stdioShutdown);
  process.on("SIGTERM", stdioShutdown);
  if (process.platform === "win32") {
    process.on("SIGBREAK", stdioShutdown);
  }
  process.on("exit", () => {
    if (memoryDb && !stdioDbClosed) { try { memoryDb.close(); } catch (_) { /* best-effort */ } }
  });
}
