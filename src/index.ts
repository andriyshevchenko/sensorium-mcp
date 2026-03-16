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
import { createServer, IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { basename, join } from "path";
import { peekThreadMessages, readThreadMessages, startDispatcher } from "./dispatcher.js";
import {
  assembleBootstrap,
  assembleCompactRefresh,
  forgetMemory,
  getMemoryStatus,
  getRecentEpisodes,
  getTopicIndex,
  getTopSemanticNotes,
  initMemoryDb,
  runIntelligentConsolidation,
  saveEpisode,
  saveProcedure,
  saveSemanticNote,
  saveVoiceSignature,
  searchProcedures,
  searchSemanticNotes,
  supersedeNote,
  updateProcedure,
  updateSemanticNote,
} from "./memory.js";
import type { SemanticNote } from "./memory.js";
import { analyzeVideoFrames, analyzeVoiceEmotion, extractVideoFrames, textToSpeech, transcribeAudio, TTS_VOICES, type TTSVoice, type VoiceAnalysisResult } from "./openai.js";
import { addSchedule, checkDueTasks, generateTaskId, listSchedules, purgeSchedules, removeSchedule, type ScheduledTask } from "./scheduler.js";
import { TelegramClient } from "./telegram.js";
import { describeADV, errorMessage, errorResult, IMAGE_EXTENSIONS, OPENAI_TTS_MAX_CHARS } from "./utils.js";

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

const esmRequire = createRequire(import.meta.url);
const { version: PKG_VERSION } = esmRequire("../package.json") as {
  version: string;
};
const telegramifyMarkdown = esmRequire("telegramify-markdown") as (
  markdown: string,
  unsupportedTagsStrategy?: "escape" | "remove",
) => string;

/**
 * Convert standard Markdown to Telegram MarkdownV2.
 *
 * Works around several telegramify-markdown limitations:
 *   1. Fenced code blocks are emitted as single-backtick inline code instead
 *      of triple-backtick blocks → pre-extract, re-insert after conversion.
 *   2. Markdown tables contain `|` which is a MarkdownV2 reserved character;
 *      telegramify-markdown does not handle tables → pre-extract and wrap in
 *      a plain code block so the table layout is preserved.
 *   3. Blockquotes with 'escape' strategy produce double-escaped characters
 *      (e.g. `\\.` instead of `\.`) → pre-convert `> text` to `▎ text`
 *      (a common Telegram convention) so the library never sees blockquotes.
 */
function convertMarkdown(markdown: string): string {
  const blocks: Array<{ lang: string; code: string }> = [];
  const placeholder = (i: number) => `CODEBLOCKPLACEHOLDER${i}END`;

  // 1. Extract fenced code blocks (``` ... ```).
  let preprocessed = markdown.replace(
    /^```(\w*)\n([\s\S]*?)\n?```\s*$/gm,
    (_match, lang: string, code: string) => {
      blocks.push({ lang, code });
      return placeholder(blocks.length - 1);
    },
  );

  // 2. Extract Markdown tables (consecutive lines starting with `|`) into
  //    placeholders so telegramify-markdown never sees the pipe characters.
  //    They are re-inserted post-conversion with pipes escaped for MarkdownV2.
  const tables: string[] = [];
  const tablePlaceholder = (i: number) => `TABLEPLACEHOLDER${i}END`;
  preprocessed = preprocessed.replace(
    /^(\|.+)\n((?:\|.*\n?)*)/gm,
    (_match, firstRow: string, rest: string) => {
      tables.push((firstRow + "\n" + rest).trimEnd());
      return tablePlaceholder(tables.length - 1) + "\n";
    },
  );

  // 3. Convert Markdown blockquotes (> text) to ▎ prefix lines so
  //    telegramify-markdown never attempts to escape them.
  preprocessed = preprocessed.replace(/^>\s?(.*)$/gm, "▎ $1");

  // 4. Convert the rest with telegramify-markdown.
  let converted = telegramifyMarkdown(preprocessed, "escape");

  // 5. Re-insert code blocks in MarkdownV2 format.
  //    Inside pre/code blocks only `\` and `` ` `` need escaping.
  converted = converted.replace(
    /CODEBLOCKPLACEHOLDER(\d+)END/g,
    (_m, idx: string) => {
      const { lang, code } = blocks[parseInt(idx, 10)];
      const escaped = code.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
      return `\`\`\`${lang}\n${escaped}\n\`\`\``;
    },
  );

  // 6. Re-insert tables with pipes escaped for MarkdownV2.
  //    Escape MarkdownV2 special chars in table content, then escape pipes.
  converted = converted.replace(
    /TABLEPLACEHOLDER(\d+)END/g,
    (_m, idx: string) => {
      const table = tables[parseInt(idx, 10)];
      return table
        .replace(/([_*\[\]()~`>#+=\-{}.!|\\])/g, "\\$1");
    },
  );

  return converted;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const VOICE_ANALYSIS_URL = process.env.VOICE_ANALYSIS_URL ?? "";
const rawWaitTimeoutMinutes = parseInt(
  process.env.WAIT_TIMEOUT_MINUTES ?? "",
  10,
);
const WAIT_TIMEOUT_MINUTES = Math.max(
  1,
  Number.isFinite(rawWaitTimeoutMinutes) ? rawWaitTimeoutMinutes : 120,
);

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  process.stderr.write(
    "Error: TELEGRAM_TOKEN and TELEGRAM_CHAT_ID environment variables are required.\n",
  );
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  process.stderr.write(
    "Warning: OPENAI_API_KEY not set — voice messages will not be transcribed.\n",
  );
}
if (VOICE_ANALYSIS_URL) {
  process.stderr.write(
    `Voice analysis service configured: ${VOICE_ANALYSIS_URL}\n`,
  );
}
// ---------------------------------------------------------------------------
// Telegram client + dispatcher
// ---------------------------------------------------------------------------

const telegram = new TelegramClient(TELEGRAM_TOKEN);

// ---------------------------------------------------------------------------
// Start the shared dispatcher — one process polls Telegram, all instances
// read from per-thread files. This eliminates 409 Conflict errors and
// ensures no updates are lost between concurrent sessions.
// ---------------------------------------------------------------------------

await startDispatcher(telegram, TELEGRAM_CHAT_ID);

// Directory for persisting downloaded images and documents to disk.
const FILES_DIR = join(homedir(), ".remote-copilot-mcp", "files");
mkdirSync(FILES_DIR, { recursive: true });

/**
 * Save a buffer to disk under FILES_DIR with a unique timestamped name.
 * Returns the absolute file path. Caps directory at 500 files by deleting oldest.
 */
function saveFileToDisk(buffer: Buffer, filename: string): string {
  const ts = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const diskName = `${ts}-${safeName}`;
  const filePath = join(FILES_DIR, diskName);
  writeFileSync(filePath, buffer);

  // Cleanup: cap at 500 files
  try {
    const files = readdirSync(FILES_DIR)
      .map(f => ({ name: f, mtime: statSync(join(FILES_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    if (files.length > 500) {
      const toDelete = files.slice(0, files.length - 500);
      for (const f of toDelete) {
        try { unlinkSync(join(FILES_DIR, f.name)); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* non-fatal */ }

  return filePath;
}

// ---------------------------------------------------------------------------
// Session store — persists topic name → thread ID mappings to disk so the
// agent can resume a named session even after a VS Code restart.
// Format: { "<chatId>": { "<lowercased name>": threadId } }
// ---------------------------------------------------------------------------

const SESSION_STORE_PATH = join(homedir(), ".remote-copilot-mcp-sessions.json");

type SessionMap = Record<string, Record<string, number>>;

function loadSessionMap(): SessionMap {
  try {
    const raw = readFileSync(SESSION_STORE_PATH, "utf8");
    return JSON.parse(raw) as SessionMap;
  } catch {
    return {};
  }
}

function saveSessionMap(map: SessionMap): void {
  try {
    const tmp = SESSION_STORE_PATH + `.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
    renameSync(tmp, SESSION_STORE_PATH); // atomic replace
  } catch (err) {
    process.stderr.write(
      `Warning: Could not save session map to ${SESSION_STORE_PATH}: ${errorMessage(err)
      }\n`,
    );
  }
}

function lookupSession(chatId: string, name: string): number | undefined {
  const map = loadSessionMap();
  return map[chatId]?.[name.toLowerCase()];
}

function persistSession(chatId: string, name: string, threadId: number): void {
  const map = loadSessionMap();
  if (!map[chatId]) map[chatId] = {};
  map[chatId][name.toLowerCase()] = threadId;
  saveSessionMap(map);
}

function removeSession(chatId: string, name: string): void {
  const map = loadSessionMap();
  if (map[chatId]) {
    delete map[chatId][name.toLowerCase()];
    saveSessionMap(map);
  }
}

// Memory database — initialized lazily on first use
let memoryDb: ReturnType<typeof initMemoryDb> | null = null;
function getMemoryDb() {
  if (!memoryDb) memoryDb = initMemoryDb();
  return memoryDb;
}

// Dead session detection constant
const DEAD_SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes (2× wait_for_instructions timeout)

// Subagent compliance constant
const SUBAGENT_NUDGE_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Session registry — tracks which MCP sessions are using which thread.
// When start_session is called with a threadId, we close stale sessions
// for that thread so VS Code doesn't show duplicate connections.
// ---------------------------------------------------------------------------
interface SessionRegistryEntry {
  mcpSessionId: string;
  closeTransport: () => void;
}
const threadSessionRegistry = new Map<number, SessionRegistryEntry[]>();

function registerMcpSession(threadId: number, mcpSessionId: string, closeTransport: () => void): void {
  const entries = threadSessionRegistry.get(threadId) ?? [];
  entries.push({ mcpSessionId, closeTransport });
  threadSessionRegistry.set(threadId, entries);
}

/**
 * Close all MCP sessions for a thread EXCEPT the current one.
 * This purges orphaned sessions from before a server restart.
 */
function purgeOtherSessions(threadId: number, keepMcpSessionId?: string): number {
  const entries = threadSessionRegistry.get(threadId) ?? [];
  let purged = 0;
  const kept: SessionRegistryEntry[] = [];
  for (const entry of entries) {
    if (entry.mcpSessionId === keepMcpSessionId) {
      kept.push(entry);
    } else {
      try { entry.closeTransport(); } catch (_) { /* best-effort */ }
      purged++;
    }
  }
  threadSessionRegistry.set(threadId, kept);
  return purged;
}

// ---------------------------------------------------------------------------
// Autonomous Goal Generation — curiosity-driven idle-time behavior
// ---------------------------------------------------------------------------

interface AutonomousGoal {
  /** Short label for the goal */
  title: string;
  /** Why this goal was generated (context for the agent) */
  rationale: string;
  /** Weight for random selection — higher = more likely to be chosen */
  curiosityWeight: number;
  /** Category for diversity in selection */
  category: "code" | "memory" | "research" | "creative" | "maintenance";
}

/**
 * Generate autonomous goals by examining the environment.
 * Returns a list of goals weighted by curiosity, shuffled for indeterminism.
 */
function generateAutonomousGoals(threadId: number | undefined): AutonomousGoal[] {
  const goals: AutonomousGoal[] = [];

  // ── Memory-derived goals ────────────────────────────────────────────────
  try {
    const db = getMemoryDb();

    // Look for recent notes that mention unresolved items, TODOs, or questions
    const recentNotes = getTopSemanticNotes(db, { limit: 15, sortBy: "created_at" });

    // Find notes with low confidence — opportunities to verify/strengthen
    const lowConfidenceNotes = recentNotes.filter((n: SemanticNote) => n.confidence < 0.7);
    if (lowConfidenceNotes.length > 0) {
      const note = lowConfidenceNotes[Math.floor(Math.random() * lowConfidenceNotes.length)];
      goals.push({
        title: "Verify uncertain knowledge",
        rationale: `Memory note "${note.content.slice(0, 80)}..." has confidence ${note.confidence}. Research to confirm or update it.`,
        curiosityWeight: 0.7,
        category: "memory",
      });
    }

    // Find patterns — these are interesting to analyze further
    const patterns = recentNotes.filter((n: SemanticNote) => n.type === "pattern");
    if (patterns.length > 0) {
      goals.push({
        title: "Explore observed pattern",
        rationale: `You've noticed a pattern: "${patterns[0].content.slice(0, 100)}...". Investigate whether it still holds or has exceptions.`,
        curiosityWeight: 0.8,
        category: "research",
      });
    }

    // Count total notes for memory health awareness
    const totalNotes = db.prepare("SELECT COUNT(*) as c FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL").get() as { c: number };
    if (totalNotes.c > 50) {
      goals.push({
        title: "Curate memory garden",
        rationale: `${totalNotes.c} active notes. Review and prune stale knowledge, merge duplicates, or strengthen connections.`,
        curiosityWeight: 0.5,
        category: "maintenance",
      });
    }

    // Check for unconsolidated episodes
    const unconsolidated = db.prepare("SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0").get() as { c: number };
    if (unconsolidated.c > 5) {
      goals.push({
        title: "Consolidate recent experiences",
        rationale: `${unconsolidated.c} unconsolidated episodes. Run memory consolidation to extract lasting knowledge.`,
        curiosityWeight: 0.6,
        category: "maintenance",
      });
    }

    // preferences — find ones that could be explored deeper
    const preferences = recentNotes.filter((n: SemanticNote) => n.type === "preference");
    if (preferences.length > 0) {
      const pref = preferences[Math.floor(Math.random() * preferences.length)];
      goals.push({
        title: "Reflect on operator preferences",
        rationale: `Preference: "${pref.content.slice(0, 100)}...". Think about how this could improve the system or workflow.`,
        curiosityWeight: 0.6,
        category: "creative",
      });
    }
  } catch (_) { /* memory read failures shouldn't prevent goal generation */ }

  // ── Code-derived goals (always available since we're in a git repo) ─────
  goals.push({
    title: "Explore recent git changes",
    rationale: "Check git log for recent commits. Are there patterns? Half-finished features? Regressions?",
    curiosityWeight: 0.7,
    category: "code",
  });

  goals.push({
    title: "Hunt for TODOs and FIXMEs",
    rationale: "Search the codebase for TODO/FIXME/HACK comments. Pick one and fix it.",
    curiosityWeight: 0.6,
    category: "code",
  });

  goals.push({
    title: "Read unfamiliar code",
    rationale: "Pick a source file you haven't examined recently and read it for understanding. Understanding breeds ideas.",
    curiosityWeight: 0.9,
    category: "code",
  });

  goals.push({
    title: "Write or improve tests",
    rationale: "Good test coverage prevents regressions and gives confidence to refactor. Check what's untested.",
    curiosityWeight: 0.5,
    category: "code",
  });

  // ── Research goals ──────────────────────────────────────────────────────
  goals.push({
    title: "Research ecosystem developments",
    rationale: "Check npm, GitHub, or web for developments in the project's dependency ecosystem. What's new?",
    curiosityWeight: 0.8,
    category: "research",
  });

  goals.push({
    title: "Study a related open-source project",
    rationale: "Find a similar project and learn from its architecture or features. Steal ideas shamelessly.",
    curiosityWeight: 0.7,
    category: "research",
  });

  // ── Creative goals ──────────────────────────────────────────────────────
  goals.push({
    title: "Prototype a new feature",
    rationale: "Think of something the operator hasn't asked for but would appreciate. Build a prototype.",
    curiosityWeight: 0.9,
    category: "creative",
  });

  goals.push({
    title: "Write documentation",
    rationale: "Good docs are a gift to future collaborators (including future you). Improve the README or add inline docs.",
    curiosityWeight: 0.4,
    category: "creative",
  });

  // ── Weighted shuffle (Fisher-Yates with weight bias) ────────────────────
  // Multiply each weight by a random factor to create indeterministic ordering
  const weighted = goals.map(g => ({
    ...g,
    sortKey: g.curiosityWeight * (0.5 + Math.random()),
  }));
  weighted.sort((a, b) => b.sortKey - a.sortKey);

  return weighted;
}

/**
 * Format autonomous goals as a text block for the idle timeout response.
 * Shows top 3-4 goals from the weighted shuffle.
 */
function formatAutonomousGoals(threadId: number | undefined): string {
  const goals = generateAutonomousGoals(threadId);
  if (goals.length === 0) return "";

  // Take top 4 from the weighted shuffle
  const selected = goals.slice(0, 4);

  const lines: string[] = [];
  lines.push("\n\n## Autonomous Goals (curiosity-weighted, pick any)");
  lines.push("No instructions. The session is yours. Here are some ideas that emerged from examining your environment:\n");

  for (let i = 0; i < selected.length; i++) {
    const g = selected[i];
    const icon = { code: "🔧", memory: "🧠", research: "🔍", creative: "✨", maintenance: "🔄" }[g.category];
    lines.push(`${i + 1}. ${icon} **${g.title}** — ${g.rationale}`);
  }

  lines.push("\nPick one, or ignore them all and follow your own curiosity. Report what you discover.");
  return lines.join("\n");
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

  function getSubagentNudge(): string {
    if (toolCallsSinceLastDelivery >= SUBAGENT_NUDGE_THRESHOLD) {
      toolCallsSinceLastDelivery = 0;
      return "\n\n💡 Reminder: You've made many direct tool calls. Consider using subagents (runSubagent) " +
        "for substantial work — they can run code edits, research, and terminal commands in parallel.";
    }
    return "";
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
  tools: [
    {
      name: "start_session",
      description:
        "Start or resume a remote-copilot session. " +
        "When called with a name that was used before, the server looks up the " +
        "existing Telegram topic for that name and resumes it instead of creating a new one. " +
        "If you are CONTINUING an existing chat (not a fresh conversation), " +
        "look back through the conversation history for a previous start_session " +
        "result that mentioned a Thread ID, then pass it as the threadId parameter " +
        "to resume that existing topic. " +
        "Requires the Telegram chat to be a forum supergroup with the bot as admin. " +
        "Call this tool once, then call remote_copilot_wait_for_instructions.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Optional. A human-readable label for this session's Telegram topic (e.g. 'Fix auth bug'). " +
              "If omitted, a timestamp-based name is used.",
          },
          threadId: {
            type: "number",
            description:
              "Optional. The Telegram message_thread_id of an existing topic to resume. " +
              "When provided, no new topic is created — the session continues in the existing thread.",
          },
        },
        required: [],
      },
    },
    {
      name: "remote_copilot_wait_for_instructions",
      description:
        "Wait for a new instruction message from the operator via Telegram. " +
        "The call blocks (long-polls) until a message arrives or the configured " +
        "timeout elapses. If the timeout elapses with no message the tool output " +
        "explicitly instructs the agent to call this tool again.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "number",
            description:
              "The Telegram thread ID of the active session. " +
              "ALWAYS pass this if you received it from start_session.",
          },
        },
        required: [],
      },
    },
    {
      name: "report_progress",
      description:
        "Send a progress update or result message to the operator via Telegram. " +
        "Use standard Markdown for formatting (headings, bold, italic, lists, code blocks, etc.). " +
        "It will be automatically converted to Telegram-compatible formatting.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "The progress update or result to report. Use standard Markdown for formatting.",
          },
          threadId: {
            type: "number",
            description:
              "The Telegram thread ID of the active session. " +
              "ALWAYS pass this if you received it from start_session.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "send_file",
      description:
        "Send a file (image or document) to the operator via Telegram. " +
        "PREFERRED: provide filePath to send a file directly from disk (fast, no size limit). " +
        "Alternative: provide base64-encoded content. " +
        "Images (JPEG, PNG, GIF, WebP) are sent as photos; other files as documents.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute path to the file on disk. PREFERRED over base64 — the server reads " +
              "and sends the file directly without passing data through the LLM context.",
          },
          base64: {
            type: "string",
            description: "The file content encoded as a base64 string. Use filePath instead when possible.",
          },
          filename: {
            type: "string",
            description:
              "The filename including extension (e.g. 'report.pdf', 'screenshot.png'). " +
              "Required when using base64. When using filePath, defaults to the file's basename.",
          },
          caption: {
            type: "string",
            description: "Optional caption to display with the file.",
          },
          threadId: {
            type: "number",
            description:
              "The Telegram thread ID of the active session. " +
              "ALWAYS pass this if you received it from start_session.",
          },
        },
        required: [],
      },
    },
    {
      name: "send_voice",
      description:
        "Send a voice message to the operator via Telegram. " +
        "The text is converted to speech using OpenAI TTS and sent as a Telegram voice message. " +
        "Requires OPENAI_API_KEY to be set.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              `The text to speak. Maximum ${OPENAI_TTS_MAX_CHARS} characters (OpenAI TTS limit).`,
          },
          voice: {
            type: "string",
            description:
              "The TTS voice to use. Each has a different personality: " +
              "alloy (neutral), echo (warm male), fable (storytelling), " +
              "onyx (deep authoritative), nova (friendly female), shimmer (gentle). " +
              "Choose based on the tone you want to convey.",
            enum: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
          },
          threadId: {
            type: "number",
            description:
              "The Telegram thread ID of the active session. " +
              "ALWAYS pass this if you received it from start_session.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "schedule_wake_up",
      description:
        "Schedule a wake-up task that will inject a prompt into your session at a specific time or after operator inactivity. " +
        "Use this to become proactive — run tests, check CI, review code — without waiting for the operator. " +
        "Three modes: (1) 'runAt' for a one-shot at a specific ISO 8601 time, " +
        "(2) 'cron' for recurring tasks (5-field cron: minute hour day month weekday), " +
        "(3) 'afterIdleMinutes' to fire after N minutes of operator silence. " +
        "Use 'action: list' to see all scheduled tasks, or 'action: remove' with a taskId to cancel one.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Action to perform: 'add' (default), 'list', or 'remove'.",
            enum: ["add", "list", "remove"],
          },
          threadId: {
            type: "number",
            description: "Thread ID for the session (optional if already set).",
          },
          label: {
            type: "string",
            description: "Short human-readable label for the task (e.g. 'morning CI check').",
          },
          prompt: {
            type: "string",
            description: "The prompt to inject when the task fires. Be specific about what to do.",
          },
          runAt: {
            type: "string",
            description: "ISO 8601 timestamp for one-shot execution (e.g. '2026-03-15T09:00:00Z').",
          },
          cron: {
            type: "string",
            description: "5-field cron expression for recurring tasks (e.g. '0 9 * * *' = every day at 9am).",
          },
          afterIdleMinutes: {
            type: "number",
            description: "Fire after this many minutes of operator silence (e.g. 60).",
          },
          taskId: {
            type: "string",
            description: "Task ID to remove (for action: 'remove').",
          },
        },
      },
    },
    // ── Memory Tools ──────────────────────────────────────────────────
    {
      name: "memory_bootstrap",
      description:
        "Load memory briefing for session start. Call this ONCE after start_session. " +
        "Returns operator profile, recent context, active procedures, and memory health. " +
        "~2,500 tokens. Essential for crash recovery — restores knowledge from previous sessions.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
      },
    },
    {
      name: "memory_search",
      description:
        "Search across all memory layers for relevant information. " +
        "Use BEFORE starting any task to recall facts, preferences, past events, or procedures. " +
        "Returns ranked results with source layer. Do NOT use for info already in your bootstrap briefing.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query.",
          },
          layers: {
            type: "array",
            items: { type: "string" },
            description: 'Filter layers: ["episodic", "semantic", "procedural"]. Default: all.',
          },
          types: {
            type: "array",
            items: { type: "string" },
            description: 'Filter by type: ["fact", "preference", "pattern", "workflow", ...].',
          },
          maxTokens: {
            type: "number",
            description: "Token budget for results. Default: 1500.",
          },
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_save",
      description:
        "Save a piece of knowledge to semantic memory (Layer 3). " +
        "Use when you learn something important that should persist across sessions: " +
        "operator preferences, corrections, facts, patterns. " +
        "Do NOT use for routine conversation — episodic memory captures that automatically.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact/preference/pattern in one clear sentence.",
          },
          type: {
            type: "string",
            description: '"fact" | "preference" | "pattern" | "entity" | "relationship".',
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "3-7 keywords for retrieval.",
          },
          confidence: {
            type: "number",
            description: "0.0-1.0. Default: 0.8.",
          },
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
        required: ["content", "type", "keywords"],
      },
    },
    {
      name: "memory_save_procedure",
      description:
        "Save or update a learned workflow/procedure to procedural memory (Layer 4). " +
        "Use after completing a multi-step task the 2nd+ time, or when the operator teaches a process.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short name for the procedure.",
          },
          type: {
            type: "string",
            description: '"workflow" | "habit" | "tool_pattern" | "template".',
          },
          description: {
            type: "string",
            description: "What this procedure accomplishes.",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered steps (for workflows).",
          },
          triggerConditions: {
            type: "array",
            items: { type: "string" },
            description: "When to use this procedure.",
          },
          procedureId: {
            type: "string",
            description: "Existing ID to update (omit to create new).",
          },
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
        required: ["name", "type", "description"],
      },
    },
    {
      name: "memory_update",
      description:
        "Update or supersede an existing semantic note or procedure. " +
        "Use when operator corrects stored information or when facts have changed.",
      inputSchema: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "note_id or procedure_id to update.",
          },
          action: {
            type: "string",
            description: '"update" (modify in place) | "supersede" (expire old, create new).',
          },
          newContent: {
            type: "string",
            description: "New content (required for supersede, optional for update).",
          },
          newConfidence: {
            type: "number",
            description: "Updated confidence score.",
          },
          reason: {
            type: "string",
            description: "Why this is being updated.",
          },
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
        required: ["memoryId", "action", "reason"],
      },
    },
    {
      name: "memory_consolidate",
      description:
        "Run memory consolidation cycle (sleep process). Normally triggered automatically during idle. " +
        "Manually call if memory_status shows many unconsolidated episodes.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
          phases: {
            type: "array",
            items: { type: "string" },
            description: 'Run specific phases: ["promote", "decay", "meta"]. Default: all.',
          },
        },
      },
    },
    {
      name: "memory_status",
      description:
        "Get memory system health and statistics. Lightweight (~300 tokens). " +
        "Use when unsure if you have relevant memories, to check if consolidation is needed, " +
        "or to report memory state to operator.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
      },
    },
    {
      name: "memory_forget",
      description:
        "Mark a memory as expired/forgotten. Use sparingly — most forgetting happens via decay. " +
        "Use when operator explicitly asks to forget something or info is confirmed wrong.",
      inputSchema: {
        type: "object",
        properties: {
          memoryId: {
            type: "string",
            description: "note_id, procedure_id, or episode_id to forget.",
          },
          reason: {
            type: "string",
            description: "Why this is being forgotten.",
          },
          threadId: {
            type: "number",
            description: "Active thread ID.",
          },
        },
        required: ["memoryId", "reason"],
      },
    },
  ],
}));

// ── Tool implementations ────────────────────────────────────────────────────

/**
 * Appended to every tool response so the agent is reminded of its
 * obligations on every single tool call, not just at the start of a session.
 * Includes the active thread ID so the agent can resume the session after a
 * VS Code restart by passing it to start_session.
 */
function getReminders(threadId?: number): string {
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
  return (
    "\n\n## MANDATORY WORKFLOW" +
    "\n1. **Plan**: Use the todo list tool to break work into discrete items BEFORE starting. Non-negotiable." +
    "\n2. **Subagents**: Use subagents heavily — spin them up for code edits, searches, research, reviews, and terminal commands. Subagents have full access to ALL MCP tools including terminal, file system, and web search. Run them in parallel when tasks are independent. You plan and verify; subagents execute." +
    "\n3. **Reporting**: Call `report_progress` after completing EACH todo item. The operator is remote and CANNOT see your work unless you explicitly report it. Silence = failure." +
    "\n4. **Never stop**: When all work is done, call `remote_copilot_wait_for_instructions` immediately. Never summarize or stop." +
    "\n5. **Memory**: (a) Call `memory_save` whenever you learn operator preferences, facts, or corrections. (b) Call `memory_search` before starting any task to recall relevant context. (c) Call `memory_status` when reporting progress to include memory health. These tools persist knowledge across sessions." +
    threadHint +
    `\n- Current time: ${timeStr} | Session uptime: ${uptimeMin}m`
  );
}

srv.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Dead session detection — update timestamp on any tool call.
  // Only reset the alert flag when wait_for_instructions is called,
  // as that's the primary health signal (agent is actively polling).
  lastToolCallAt = Date.now();

  // Track tool calls for subagent compliance nudging
  toolCallsSinceLastDelivery++;

  // ── start_session ─────────────────────────────────────────────────────────
  if (name === "start_session") {
    sessionStartedAt = Date.now();
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const explicitThreadId = typeof typedArgs.threadId === "number"
      ? typedArgs.threadId as number
      : undefined;
    const customName = typeof typedArgs.name === "string" && typedArgs.name.trim()
      ? typedArgs.name.trim()
      : undefined;

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
        const msg = convertMarkdown("🔄 **Session resumed.** Continuing in this thread.");
        await telegram.sendMessage(TELEGRAM_CHAT_ID, msg, "MarkdownV2", currentThreadId);
      } catch (err) {
        const errMsg = errorMessage(err);
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
    let lastScheduleCheck = 0;

    while (Date.now() < deadline) {
      const stored = readThreadMessages(effectiveThreadId);

      if (stored.length > 0) {
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
                      content: { raw: transcript ?? "", duration: msg.message.voice.duration },
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
                      content: { raw: transcript ?? "", scene: sceneDescription ?? "", duration: vn.duration },
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
          contentBlocks.push({
            type: "text",
            text: "[Unsupported message type received — the operator sent a message type that cannot be processed (e.g., sticker, location, contact). Please ask them to resend as text, photo, document, or voice.]",
          });
        }

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
                  content: { raw: textContent },
                  importance: 0.5,
                });
              }
            }
          }
        } catch (_) { /* memory write failures should never break the main flow */ }

        // Inject subagent/delegation hint right after the operator's message
        // so the agent treats it as part of the operator's instructions.
        const delegationHint: { type: "text"; text: string } = {
          type: "text",
          text:
            "\n Read and incorporate the operator's new messages." +
            "\n - Update or refine your plan as needed." +
            "\n - Continue your work." +
            "\n\n⚠️ HINT from operator: Use subagents (runSubagent) for ALL substantial work — code edits, research, reviews, searches, and terminal commands. " +
            "Subagents have full access to ALL MCP tools including terminal, file system, and web search. " +
            "Run them in parallel when tasks are independent. You plan and verify; subagents execute.",
        };

        // ── Auto-inject relevant memory context ───────────────────────────
        // Architecture-enforced: the agent should NOT need to manually call
        // memory_search. The server automatically searches memory for notes
        // relevant to the operator's message and injects them.
        let autoMemoryContext = "";
        try {
          const db = getMemoryDb();
          // Extract the operator's text to use as a memory search query
          const operatorText = stored
            .map(m => m.message.text ?? m.message.caption ?? "")
            .filter(Boolean)
            .join(" ")
            .slice(0, 500);
          if (operatorText.length > 10) { // only search for substantial messages
            const MAX_AUTO_NOTES = 5;
            const MAX_AUTO_CHARS = 2000; // token budget for auto-injected memory
            const relevant = searchSemanticNotes(db, operatorText, { maxResults: MAX_AUTO_NOTES, skipAccessTracking: true });
            if (relevant.length > 0) {
              let budget = MAX_AUTO_CHARS;
              const lines: string[] = [];
              for (const n of relevant) {
                const line = `- **[${n.type}]** ${n.content.slice(0, 300)} _(conf: ${n.confidence})_`;
                if (budget - line.length < 0) break;
                budget -= line.length;
                lines.push(line);
              }
              if (lines.length > 0) {
                autoMemoryContext = `\n\n## Relevant Memory (auto-injected)\n${lines.join("\n")}`;
              }
            }
          }
        } catch (_) { /* memory search failures should never break message delivery */ }

        return {
          content: [
            {
              type: "text",
              text: "Follow the operator's instructions below.\n\n" +
                "BEFORE doing anything: (1) Break the work into todo items. (2) Share your plan via report_progress. " +
                "(3) For each todo: mark in-progress → do the work → call report_progress → mark completed. " +
                "Use subagents heavily for all substantial work — code edits, research, reviews, searches. Spin up parallel subagents when possible. " +
                "The operator is REMOTE — they cannot see your screen. If you don't call report_progress, they see nothing.",
            },
            ...contentBlocks,
            delegationHint,
            ...(hasVoiceMessages
              ? [{
                type: "text" as const,
                text: "\n**Note:** The operator sent voice message(s). They prefer voice interaction — use `send_voice` for progress updates and responses when possible.",
              }]
              : []),
            ...(autoMemoryContext
              ? [{ type: "text" as const, text: autoMemoryContext }]
              : []),
            { type: "text", text: getReminders(effectiveThreadId) },
          ],
        };
      }

      // Check scheduled tasks every ~60s during idle polling.
      if (effectiveThreadId !== undefined && Date.now() - lastScheduleCheck >= 60_000) {
        lastScheduleCheck = Date.now();
        const dueTask = checkDueTasks(effectiveThreadId, lastOperatorMessageAt, false);
        if (dueTask) {
          return {
            content: [
              {
                type: "text",
                text: `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
                  `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
                  `Task prompt: ${dueTask.prompt}` +
                  getReminders(effectiveThreadId),
              },
            ],
          };
        }
      }

      // No messages yet — sleep briefly and check again.
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Timeout elapsed with no actionable message.
    const now = new Date().toISOString();

    // Check for scheduled wake-up tasks.
    if (effectiveThreadId !== undefined) {
      const dueTask = checkDueTasks(effectiveThreadId, lastOperatorMessageAt, false);
      if (dueTask) {
        return {
          content: [
            {
              type: "text",
              text: `⏰ **Scheduled task fired: "${dueTask.task.label}"**\n\n` +
                `This task was scheduled by you. Execute it now using subagents, then report progress and continue waiting.\n\n` +
                `Task prompt: ${dueTask.prompt}` +
                getReminders(effectiveThreadId),
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
      if (idleMs > 30 * 60 * 1000 && effectiveThreadId !== undefined && Date.now() - lastConsolidationAt > 2 * 60 * 60 * 1000) {
        lastConsolidationAt = Date.now();
        const db = getMemoryDb();
        void runIntelligentConsolidation(db, effectiveThreadId).then(report => {
          if (report.episodesProcessed > 0) {
            process.stderr.write(`[memory] Consolidation: ${report.episodesProcessed} episodes → ${report.notesCreated} notes\n`);
          }
        }).catch(err => {
          process.stderr.write(`[memory] Consolidation error: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    } catch (_) { /* consolidation failure is non-fatal */ }

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

    // Generate autonomous goals only after extended silence (4+ hours)
    // Before that, the agent should just keep polling quietly
    const GOAL_GENERATION_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
    const idleMs = Date.now() - lastOperatorMessageAt;
    const autonomousGoals = idleMs >= GOAL_GENERATION_THRESHOLD_MS
      ? formatAutonomousGoals(effectiveThreadId)
      : "";

    return {
      content: [
        {
          type: "text",
          text:
            `[Poll #${callNumber} — timeout at ${now} — elapsed ${WAIT_TIMEOUT_MINUTES}m — session uptime ${Math.round((Date.now() - sessionStartedAt) / 60000)}m — operator idle ${idleMinutes}m]` +
            ` No new instructions received. ` +
            `YOU MUST call remote_copilot_wait_for_instructions again RIGHT NOW to continue listening. ` +
            `Do NOT summarize, stop, or say the session is idle. ` +
            `Just call the tool again immediately.` +
            autonomousGoals +
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

    // Convert standard Markdown to Telegram MarkdownV2.
    let message: string;
    try {
      message = convertMarkdown(rawMessage);
    } catch {
      // Fall back to raw text if Markdown conversion throws.
      message = rawMessage;
    }

    let sentAsPlainText = false;
    try {
      await telegram.sendMessage(TELEGRAM_CHAT_ID, message, "MarkdownV2", effectiveThreadId);
    } catch (error) {
      const errMsg = errorMessage(error);
      // If Telegram rejected the message due to a MarkdownV2 parse error,
      // retry as plain text using the original un-converted message.
      const isParseError = errMsg.includes("can't parse entities");
      if (isParseError) {
        try {
          await telegram.sendMessage(TELEGRAM_CHAT_ID, rawMessage, undefined, effectiveThreadId);
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
        : "Progress reported successfully.") + getReminders(effectiveThreadId);

    const responseText =
      pendingMessages.length > 0
        ? `${baseStatus}\n\n` +
        `While you were working, the operator sent additional message(s). ` +
        `Use those messages to steer your active session: ${pendingMessages.join("\n\n")}` +
        `\n\n⚠️ HINT from operator: Use subagents (runSubagent) for ALL substantial work. ` +
        `Subagents have full access to ALL MCP tools. You plan and verify; subagents execute.`
        : baseStatus + getSubagentNudge();

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
        buffer = readFileSync(filePath);
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
            text: `File "${filename}" sent to Telegram successfully.` + getReminders(effectiveThreadId),
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
            text: `Voice message sent to Telegram successfully.` + getReminders(effectiveThreadId),
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
            text: "No scheduled tasks for this thread." + getReminders(effectiveThreadId),
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
          text: `**Scheduled tasks (${tasks.length}):**\n\n${lines.join("\n\n")}` + getReminders(effectiveThreadId),
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
            ? `Task ${taskId} removed.` + getReminders(effectiveThreadId)
            : `Task ${taskId} not found.` + getReminders(effectiveThreadId),
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
          getReminders(effectiveThreadId),
      }],
    };
  }

  // ── memory_bootstrap ────────────────────────────────────────────────────
  if (name === "memory_bootstrap") {
    const threadId = resolveThreadId(args as Record<string, unknown>);
    if (threadId === undefined) {
      return { content: [{ type: "text", text: "Error: No active thread. Call start_session first." + getReminders() }] };
    }
    try {
      const db = getMemoryDb();
      const briefing = assembleBootstrap(db, threadId);
      return {
        content: [{ type: "text", text: `## Memory Briefing\n\n${briefing}` + getReminders(threadId) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Memory bootstrap error: ${errorMessage(err)}` + getReminders(threadId) }] };
    }
  }

  // ── memory_search ───────────────────────────────────────────────────────
  if (name === "memory_search") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    const query = String(typedArgs.query ?? "");
    if (!query) {
      return { content: [{ type: "text", text: "Error: query is required." + getReminders(threadId) }] };
    }
    try {
      const db = getMemoryDb();
      const layers = (typedArgs.layers as string[] | undefined) ?? ["episodic", "semantic", "procedural"];
      const types = typedArgs.types as string[] | undefined;
      const results: string[] = [];

      if (layers.includes("semantic")) {
        const notes = searchSemanticNotes(db, query, { types, maxResults: 10 });
        if (notes.length > 0) {
          results.push("### Semantic Memory");
          for (const n of notes) {
            results.push(`- **[${n.type}]** ${n.content} _(conf: ${n.confidence}, id: ${n.noteId})_`);
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
      return { content: [{ type: "text", text: text + getReminders(threadId) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Memory search error: ${errorMessage(err)}` + getReminders(threadId) }] };
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
        keywords: (typedArgs.keywords as string[]) ?? [],
        confidence: typeof typedArgs.confidence === "number" ? typedArgs.confidence : 0.8,
      });
      return {
        content: [{ type: "text", text: `Saved semantic note: ${noteId}` + getReminders(threadId) + getSubagentNudge() }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Memory save error: ${errorMessage(err)}` + getReminders(threadId) }] };
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
          steps: typedArgs.steps as string[] | undefined,
          triggerConditions: typedArgs.triggerConditions as string[] | undefined,
        });
        return {
          content: [{ type: "text", text: `Updated procedure: ${existingId}` + getReminders(threadId) }],
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
        steps: typedArgs.steps as string[] | undefined,
        triggerConditions: typedArgs.triggerConditions as string[] | undefined,
      });
      return {
        content: [{ type: "text", text: `Saved procedure: ${procId}` + getReminders(threadId) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Procedure save error: ${errorMessage(err)}` + getReminders(threadId) }] };
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
        const newId = supersedeNote(db, memId, {
          type: origRow.type as "fact" | "preference" | "pattern" | "entity" | "relationship",
          content: String(typedArgs.newContent ?? ""),
          keywords: origRow.keywords ? JSON.parse(origRow.keywords) : [],
          confidence: typeof typedArgs.newConfidence === "number" ? typedArgs.newConfidence : 0.8,
        });
        return {
          content: [{ type: "text", text: `Superseded ${memId} → ${newId} (reason: ${reason})` + getReminders(threadId) }],
        };
      }

      if (memId.startsWith("sn_")) {
        const updates: Record<string, unknown> = {};
        if (typedArgs.newContent) updates.content = String(typedArgs.newContent);
        if (typeof typedArgs.newConfidence === "number") updates.confidence = typedArgs.newConfidence;
        updateSemanticNote(db, memId, updates as Parameters<typeof updateSemanticNote>[2]);
        return {
          content: [{ type: "text", text: `Updated note ${memId} (reason: ${reason})` + getReminders(threadId) }],
        };
      }

      if (memId.startsWith("pr_")) {
        const updates: Record<string, unknown> = {};
        if (typedArgs.newContent) updates.description = String(typedArgs.newContent);
        if (typeof typedArgs.newConfidence === "number") updates.confidence = typedArgs.newConfidence;
        updateProcedure(db, memId, updates as Parameters<typeof updateProcedure>[2]);
        return {
          content: [{ type: "text", text: `Updated procedure ${memId} (reason: ${reason})` + getReminders(threadId) }],
        };
      }

      return { content: [{ type: "text", text: `Unknown memory ID format: ${memId}` + getReminders(threadId) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Memory update error: ${errorMessage(err)}` + getReminders(threadId) }] };
    }
  }

  // ── memory_consolidate ──────────────────────────────────────────────────
  if (name === "memory_consolidate") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    if (threadId === undefined) {
      return { content: [{ type: "text", text: "Error: No active thread." + getReminders() }] };
    }
    try {
      const db = getMemoryDb();
      const report = await runIntelligentConsolidation(db, threadId);

      if (report.episodesProcessed === 0) {
        return {
          content: [{ type: "text", text: "No unconsolidated episodes. Memory is up to date." + getReminders(threadId) }],
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

      return { content: [{ type: "text", text: reportLines.join("\n") + getReminders(threadId) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Consolidation error: ${errorMessage(err)}` + getReminders(threadId) }] };
    }
  }

  // ── memory_status ───────────────────────────────────────────────────────
  if (name === "memory_status") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const threadId = resolveThreadId(typedArgs);
    if (threadId === undefined) {
      return { content: [{ type: "text", text: "Error: No active thread." + getReminders() }] };
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

      return { content: [{ type: "text", text: lines.join("\n") + getReminders(threadId) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Memory status error: ${errorMessage(err)}` + getReminders(threadId) }] };
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
          content: [{ type: "text", text: `Memory ${memId} not found (layer: ${result.layer}). Nothing was deleted.` + getReminders(threadId) }],
        };
      }
      return {
        content: [{ type: "text", text: `Forgot ${result.layer} memory ${memId} (reason: ${reason})` + getReminders(threadId) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Memory forget error: ${errorMessage(err)}` + getReminders(threadId) }] };
    }
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

if (httpPort) {
  // ── HTTP/SSE transport ──────────────────────────────────────────────────
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const MCP_HTTP_SECRET = process.env.MCP_HTTP_SECRET;
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

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
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
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
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or missing session ID");
        return;
      }
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

  httpServer.listen(httpPort, () => {
    process.stderr.write(`Remote Copilot MCP server running on http://localhost:${httpPort}/mcp\n`);
  });

  // Simple shutdown — close transports, DB, and exit.
  let memoryDbClosed = false;
  const shutdown = () => {
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
