#!/usr/bin/env node
/**
 * Remote Copilot MCP Server
 *
 * Exposes five tools for AI assistants:
 *   - start_session                          Begin a remote-copilot session.
 *   - remote_copilot_wait_for_instructions  Poll Telegram for new user messages.
 *   - report_progress                        Send a progress update to Telegram.
 *   - send_file                              Send a file/image to the operator.
 *   - send_voice                             Send a voice message to the operator.
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
 *                           (default: 30).
 *   OPENAI_API_KEY        – OpenAI API key for voice message transcription
 *                           via Whisper and text-to-speech via TTS. Without it,
 *                           voice messages show a placeholder and send_voice
 *                           is disabled.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, renameSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { basename, join } from "path";
import { peekThreadMessages, readThreadMessages, startDispatcher } from "./dispatcher.js";
import { analyzeVoiceEmotion, textToSpeech, transcribeAudio, TTS_VOICES, type TTSVoice } from "./openai.js";
import { TelegramClient } from "./telegram.js";
import { describeADV, errorMessage, errorResult, IMAGE_EXTENSIONS, OPENAI_TTS_MAX_CHARS } from "./utils.js";

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

  // 2. Extract Markdown tables (consecutive lines starting with `|`) and
  //    wrap them in a plain code block so `|` never reaches the MarkdownV2
  //    escape layer.
  preprocessed = preprocessed.replace(
    /^(\|.+)\n((?:\|.*\n?)*)/gm,
    (_match, firstRow: string, rest: string) => {
      const tableText = (firstRow + "\n" + rest).trimEnd();
      blocks.push({ lang: "", code: tableText });
      return placeholder(blocks.length - 1) + "\n";
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

// Monotonically increasing counter so every timeout response is unique,
// preventing VS Code Copilot's loop-detection heuristic from killing the agent.
let waitCallCount = 0;
let sessionStartedAt = Date.now();

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

// Thread ID of the active session's forum topic. Set by start_session.
// All sends and receives are scoped to this thread so concurrent sessions
// in different topics never interfere with each other.
let currentThreadId: number | undefined;

/**
 * Resolve the effective thread ID for a tool call.
 * Prefers an explicit threadId passed in the tool arguments (enabling
 * multiple concurrent sessions in the same MCP process), then falls
 * back to the module-level currentThreadId.
 *
 * Returns undefined only if no thread has ever been established.
 */
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

// Timestamp of the last keep-alive ping sent to Telegram.
// Used to send periodic "session still alive" messages so the operator knows
// the agent hasn't silently died.
let lastKeepAliveSentAt = Date.now();
const KEEP_ALIVE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "remote-copilot-mcp", version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
  const threadHint = threadId !== undefined
    ? `\n- Active Telegram thread ID: **${threadId}** — if this session is restarted, call start_session with threadId=${threadId} to resume this topic.`
    : "";
  return (
    "\n\n## MANDATORY WORKFLOW — YOU MUST FOLLOW ALL STEPS" +
    "\n1. **Plan first**: Use the todo list tool to break work into discrete items BEFORE starting. Non-negotiable." +
    "\n2. **Report every step**: Call `report_progress` after completing EACH todo item. The operator is remote and CANNOT see your work unless you explicitly report it. Silence = failure." +
    "\n3. **Subagents for mechanical tasks only**: Use subagents for specific edits, searches, code reviews, and test generation. YOU must own the plan, make all decisions, and call report_progress yourself. NEVER pass the operator's full instructions to a subagent." +
    "\n4. **Never stop**: When all work is done, call `remote_copilot_wait_for_instructions` immediately. Never summarize and stop." +
    threadHint
  );
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
      // Resume mode: verify the thread is still alive by sending a message.
      // If the topic was deleted, drop the cached mapping and fall through to
      // create a new topic.
      lastKeepAliveSentAt = Date.now();
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
          // Drop the stale mapping.
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
      lastKeepAliveSentAt = Date.now();
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
    return {
      content: [
        {
          type: "text",
          text:
            `Session ${resolvedPreexisting ? "resumed" : "started"}.${threadNote}` +
            ` Call the remote_copilot_wait_for_instructions tool next.` +
            getReminders(currentThreadId),
        },
      ],
    };
  }

  // ── remote_copilot_wait_for_instructions ──────────────────────────────────
  if (name === "remote_copilot_wait_for_instructions") {
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

    while (Date.now() < deadline) {
      const stored = readThreadMessages(effectiveThreadId);

      if (stored.length > 0) {
        // React with 👀 on each consumed message to signal "seen" to the operator.
        for (const msg of stored) {
          void telegram.setMessageReaction(
            TELEGRAM_CHAT_ID,
            msg.message.message_id,
          );
        }

        type TextBlock = { type: "text"; text: string };
        type ImageBlock = { type: "image"; data: string; mimeType: string };
        const contentBlocks: Array<TextBlock | ImageBlock> = [];
        let hasVoiceMessages = false;

        for (const msg of stored) {
          // Photos: download the largest size and embed as base64.
          if (msg.message.photo && msg.message.photo.length > 0) {
            const largest = msg.message.photo[msg.message.photo.length - 1];
            try {
              const { base64, mimeType } = await telegram.downloadFileAsBase64(
                largest.file_id,
              );
              contentBlocks.push({ type: "image", data: base64, mimeType });
              if (msg.message.caption) {
                contentBlocks.push({
                  type: "text",
                  text: `[Image caption]: ${msg.message.caption}`,
                });
              }
            } catch (err) {
              contentBlocks.push({
                type: "text",
                text: `[Photo received but could not be downloaded: ${errorMessage(err)}]`,
              });
            }
          }
          // Documents: download and embed as base64.
          if (msg.message.document) {
            const doc = msg.message.document;
            try {
              const { base64, mimeType } = await telegram.downloadFileAsBase64(
                doc.file_id,
              );
              const isImage = mimeType.startsWith("image/");
              if (isImage) {
                contentBlocks.push({ type: "image", data: base64, mimeType });
              } else {
                // Non-image documents: include as text with base64 data.
                contentBlocks.push({
                  type: "text",
                  text: `[Document: ${doc.file_name ?? "file"} (${doc.mime_type ?? mimeType})]\nBase64 content: ${base64}`,
                });
              }
              if (msg.message.caption) {
                contentBlocks.push({
                  type: "text",
                  text: `[Document caption]: ${msg.message.caption}`,
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
                const tags: string[] = [];
                if (analysis?.emotion) {
                  let emotionStr = analysis.emotion;
                  if (analysis.arousal != null && analysis.dominance != null && analysis.valence != null) {
                    emotionStr += ` (${describeADV(analysis.arousal, analysis.dominance, analysis.valence)})`;
                  }
                  tags.push(`tone: ${emotionStr}`);
                }
                if (analysis?.gender) tags.push(`gender: ${analysis.gender}`);
                if (analysis?.age_estimate != null) tags.push(`age: ~${Math.round(analysis.age_estimate)}`);
                if (analysis?.height_estimate_cm != null) tags.push(`height: ~${Math.round(analysis.height_estimate_cm)}cm`);
                const analysisTag = tags.length > 0 ? ` | ${tags.join(", ")}` : "";

                contentBlocks.push({
                  type: "text",
                  text: transcript
                    ? `[Voice message — ${msg.message.voice.duration}s${analysisTag}, transcribed]: ${transcript}`
                    : `[Voice message — ${msg.message.voice.duration}s${analysisTag}, transcribed]: (empty — no speech detected)`,
                });
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
        }
        if (contentBlocks.length === 0) {
          // All messages were unsupported types (stickers, etc.);
          // continue polling instead of returning empty instructions.
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }
        return {
          content: [
            {
              type: "text",
              text: "Follow the operator's instructions below.\n\n" +
                "BEFORE doing anything: (1) Break the work into todo items. (2) Share your plan via report_progress. " +
                "(3) For each todo: mark in-progress → do the work → call report_progress → mark completed. " +
                "YOU own the plan and all decisions. Subagents are for mechanical tasks only (edits, searches, reviews) — never delegate the full prompt. " +
                "The operator is REMOTE — they cannot see your screen. If you don't call report_progress, they see nothing.",
            },
            ...contentBlocks,
            ...(hasVoiceMessages
              ? [{
                type: "text" as const,
                text: "\n**Note:** The operator sent voice message(s). They prefer voice interaction — use `send_voice` for progress updates and responses when possible.",
              }]
              : []),
            { type: "text", text: getReminders(effectiveThreadId) },
          ],
        };
      }

      // No messages yet — sleep briefly and check again.
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Timeout elapsed with no actionable message.
    const now = new Date().toISOString();

    // Keep-alive ping: send a periodic heartbeat to Telegram so the operator
    // knows the session is still alive even with no activity.
    let keepAliveSent = false;
    if (Date.now() - lastKeepAliveSentAt >= KEEP_ALIVE_INTERVAL_MS) {
      lastKeepAliveSentAt = Date.now();
      try {
        const ping = convertMarkdown(
          `🟢 **Session alive** — ${new Date().toLocaleString("en-GB", {
            day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
          })}` +
          ` (thread ${effectiveThreadId})`,
        );
        await telegram.sendMessage(TELEGRAM_CHAT_ID, ping, "MarkdownV2", effectiveThreadId);
        keepAliveSent = true;
      } catch {
        // Non-fatal.
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            `[Poll #${callNumber} — timeout at ${now} — elapsed ${WAIT_TIMEOUT_MINUTES}m — session uptime ${Math.round((Date.now() - sessionStartedAt) / 60000)}m]` +
            (keepAliveSent ? ` Keep-alive ping sent.` : "") +
            ` No new instructions received. ` +
            `YOU MUST call remote_copilot_wait_for_instructions again RIGHT NOW to continue listening. ` +
            `Do NOT summarize, stop, or say the session is idle. ` +
            `Just call the tool again immediately.` +
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
    // Uses non-destructive peek so photos/documents are preserved for
    // full delivery via remote_copilot_wait_for_instructions.
    let pendingMessages: string[] = [];
    try {
      const pendingStored = peekThreadMessages(effectiveThreadId);
      if (pendingStored.length > 0) {
        for (const msg of pendingStored) {
          if (msg.message.photo && msg.message.photo.length > 0) {
            pendingMessages.push(
              msg.message.caption
                ? `[Photo received] ${msg.message.caption}`
                : "[Photo received from operator]",
            );
          } else if (msg.message.document) {
            pendingMessages.push(
              msg.message.caption
                ? `[Document: ${msg.message.document.file_name ?? "file"}] ${msg.message.caption}`
                : `[Document received: ${msg.message.document.file_name ?? "file"}]`,
            );
          } else if (msg.message.voice) {
            pendingMessages.push(
              `[Voice message — ${msg.message.voice.duration}s — will be transcribed on next wait]`,
            );
          } else if (msg.message.text) {
            pendingMessages.push(msg.message.text);
          }
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
        `Use those messages to steer an active session: ${pendingMessages.join("\n\n")}. ` +
        `You should:\n` +
        ` - Read and incorporate the operator's new messages.\n` +
        ` - Update or refine your plan as needed.\n` +
        ` - Continue your work.`
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

  // Unknown tool
  return errorResult(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("Remote Copilot MCP server running on stdio.\n");
