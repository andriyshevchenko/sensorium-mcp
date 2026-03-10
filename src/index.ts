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
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { join } from "path";
import { peekThreadMessages, readThreadMessages, startDispatcher } from "./dispatcher.js";
import { TelegramClient } from "./telegram.js";

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json") as {
  version: string;
};
const telegramifyMarkdown = _require("telegramify-markdown") as (
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
const rawWaitTimeoutMinutes = parseInt(
  process.env.WAIT_TIMEOUT_MINUTES ?? "",
  10,
);
const WAIT_TIMEOUT_MINUTES = Math.max(
  1,
  Number.isFinite(rawWaitTimeoutMinutes) ? rawWaitTimeoutMinutes : 30,
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
    writeFileSync(SESSION_STORE_PATH, JSON.stringify(map, null, 2), "utf8");
  } catch (err) {
    process.stderr.write(
      `Warning: Could not save session map to ${SESSION_STORE_PATH}: ${err instanceof Error ? err.message : String(err)
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

// Timestamp of the last keep-alive ping sent to Telegram.
// Used to send periodic "session still alive" messages so the operator knows
// the agent hasn't silently died.
let lastKeepAliveSentAt = Date.now();
const KEEP_ALIVE_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour

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
        properties: {},
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
              "The text to speak. Maximum 4096 characters (OpenAI TTS limit).",
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
    "\n\n## REMINDERS" +
    "\n- Call report_progress after every significant step — do not batch updates." +
    "\n- When all work is done, YOU MUST call remote_copilot_wait_for_instructions. Never stop or summarize — always end by calling that tool." +
    "\n- Prefer subagents for parts of your work which can be safely delegated" +
    threadHint
  );
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── start_session ─────────────────────────────────────────────────────────
  if (name === "start_session") {
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
        const errMsg = err instanceof Error ? err.message : String(err);
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
        // Forum topics not available (e.g. plain group or DM) — fall back to no thread.
        process.stderr.write(
          `Warning: Could not create forum topic: ${err instanceof Error ? err.message : String(err)}\n` +
          "Falling back to main chat (no thread isolation).\n",
        );
        currentThreadId = undefined;
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
    const callNumber = ++waitCallCount; const timeoutMs = WAIT_TIMEOUT_MINUTES * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    // Poll the dispatcher's per-thread file instead of calling getUpdates
    // directly. This avoids 409 conflicts between concurrent instances.
    const POLL_INTERVAL_MS = 2000;

    while (Date.now() < deadline) {
      const stored = readThreadMessages(currentThreadId);

      if (stored.length > 0) {
        type TextBlock = { type: "text"; text: string };
        type ImageBlock = { type: "image"; data: string; mimeType: string };
        const contentBlocks: Array<TextBlock | ImageBlock> = [];

        for (const s of stored) {
          // Photos: download the largest size and embed as base64.
          if (s.message.photo && s.message.photo.length > 0) {
            const largest = s.message.photo[s.message.photo.length - 1];
            try {
              const { base64, mimeType } = await telegram.downloadFileAsBase64(
                largest.file_id,
              );
              contentBlocks.push({ type: "image", data: base64, mimeType });
              if (s.message.caption) {
                contentBlocks.push({
                  type: "text",
                  text: `[Image caption]: ${s.message.caption}`,
                });
              }
            } catch (err) {
              contentBlocks.push({
                type: "text",
                text: `[Photo received but could not be downloaded: ${err instanceof Error ? err.message : String(err)
                  }]`,
              });
            }
          }
          // Documents: download and embed as base64.
          if (s.message.document) {
            const doc = s.message.document;
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
              if (s.message.caption) {
                contentBlocks.push({
                  type: "text",
                  text: `[Document caption]: ${s.message.caption}`,
                });
              }
            } catch (err) {
              contentBlocks.push({
                type: "text",
                text: `[Document "${doc.file_name ?? "file"}" received but could not be downloaded: ${err instanceof Error ? err.message : String(err)
                  }]`,
              });
            }
          }
          // Text messages.
          if (s.message.text) {
            contentBlocks.push({ type: "text", text: s.message.text });
          }
          // Voice messages: transcribe using OpenAI Whisper.
          if (s.message.voice) {
            if (OPENAI_API_KEY) {
              try {
                const transcript = await telegram.transcribeVoice(
                  s.message.voice.file_id,
                  OPENAI_API_KEY,
                );
                contentBlocks.push({
                  type: "text",
                  text: transcript
                    ? `[Voice message — ${s.message.voice.duration}s, transcribed]: ${transcript}`
                    : `[Voice message — ${s.message.voice.duration}s, transcribed]: (empty — no speech detected)`,
                });
              } catch (err) {
                contentBlocks.push({
                  type: "text",
                  text: `[Voice message — ${s.message.voice.duration}s — transcription failed: ${err instanceof Error ? err.message : String(err)
                    }]`,
                });
              }
            } else {
              contentBlocks.push({
                type: "text",
                text: `[Voice message received — ${s.message.voice.duration}s — cannot transcribe: OPENAI_API_KEY not set]`,
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
              text: "Follow the operator's instructions below. First create a plan, then execute it step by step:",
            },
            ...contentBlocks,
            { type: "text", text: getReminders(currentThreadId) },
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
          (currentThreadId !== undefined ? ` (thread ${currentThreadId})` : ""),
        );
        await telegram.sendMessage(TELEGRAM_CHAT_ID, ping, "MarkdownV2", currentThreadId);
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
            `[Poll #${callNumber} ended at ${now}]` +
            (keepAliveSent ? ` Keep-alive ping sent to Telegram at ${now}.` : "") +
            ` No new instructions received within ${WAIT_TIMEOUT_MINUTES} minute(s). ` +
            `YOU MUST call remote_copilot_wait_for_instructions again RIGHT NOW. ` +
            `Do NOT summarize. Do NOT say the session is idle. Do NOT stop. ` +
            `Just call the tool again immediately.` +
            getReminders(currentThreadId),
        },
      ],
    };
  }

  // ── report_progress ───────────────────────────────────────────────────────
  if (name === "report_progress") {
    const rawMessage =
      typeof (args as Record<string, unknown>)?.message === "string"
        ? ((args as Record<string, unknown>).message as string)
        : "";

    if (!rawMessage) {
      return {
        content: [
          {
            type: "text",
            text: "Error: 'message' argument is required for report_progress.",
          },
        ],
        isError: true,
      };
    }

    // Convert standard Markdown to Telegram MarkdownV2 (handles headings,
    // lists, bold/italic, code blocks, and special-character escaping).
    const message = convertMarkdown(rawMessage);

    let sentAsPlainText = false;
    try {
      await telegram.sendMessage(TELEGRAM_CHAT_ID, message, "MarkdownV2", currentThreadId);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      // If Telegram rejected the message due to a MarkdownV2 parse error,
      // retry as plain text using the original un-converted message.
      const isParseError = errorMsg.includes("can't parse entities");
      if (isParseError) {
        try {
          await telegram.sendMessage(TELEGRAM_CHAT_ID, rawMessage, undefined, currentThreadId);
          sentAsPlainText = true;
        } catch (retryError) {
          process.stderr.write(
            `Failed to send progress message via Telegram (plain fallback): ${retryError instanceof Error
              ? retryError.message
              : String(retryError)
            }\n`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  "Error: Failed to send progress update to Telegram even without formatting. " +
                  "Please check the Telegram configuration and try again.",
              },
            ],
            isError: true,
          };
        }
      } else {
        process.stderr.write(
          `Failed to send progress message via Telegram: ${errorMsg}\n`,
        );
        return {
          content: [
            {
              type: "text",
              text:
                "Error: Failed to send progress update to Telegram. " +
                "Check the Telegram configuration and try again.",
            },
          ],
          isError: true,
        };
      }
    }

    // Peek at any messages the operator sent while the agent was working.
    // Uses non-destructive peek so photos/documents are preserved for
    // full delivery via remote_copilot_wait_for_instructions.
    let pendingMessages: string[] = [];
    try {
      const pendingStored = peekThreadMessages(currentThreadId);
      if (pendingStored.length > 0) {
        for (const s of pendingStored) {
          if (s.message.photo && s.message.photo.length > 0) {
            pendingMessages.push(
              s.message.caption
                ? `[Photo received] ${s.message.caption}`
                : "[Photo received from operator]",
            );
          } else if (s.message.document) {
            pendingMessages.push(
              s.message.caption
                ? `[Document: ${s.message.document.file_name ?? "file"}] ${s.message.caption}`
                : `[Document received: ${s.message.document.file_name ?? "file"}]`,
            );
          } else if (s.message.voice) {
            pendingMessages.push(
              `[Voice message — ${s.message.voice.duration}s — will be transcribed on next wait]`,
            );
          } else if (s.message.text) {
            pendingMessages.push(s.message.text);
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
        : "Progress reported successfully.") + getReminders(currentThreadId);

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
    const filePath = typeof typedArgs.filePath === "string" ? typedArgs.filePath.trim() : "";
    const base64Data = typeof typedArgs.base64 === "string" ? typedArgs.base64 : "";
    const caption = typeof typedArgs.caption === "string" ? typedArgs.caption : undefined;

    if (!filePath && !base64Data) {
      return {
        content: [{ type: "text", text: "Error: either 'filePath' or 'base64' argument is required for send_file." }],
        isError: true,
      };
    }

    try {
      let buffer: Buffer;
      let filename: string;

      if (filePath) {
        // Read directly from disk — fast, no LLM context overhead.
        const { basename } = await import("path");
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
      const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

      if (imageExts.has(ext)) {
        await telegram.sendPhoto(TELEGRAM_CHAT_ID, buffer, filename, caption, currentThreadId);
      } else {
        await telegram.sendDocument(TELEGRAM_CHAT_ID, buffer, filename, caption, currentThreadId);
      }

      return {
        content: [
          {
            type: "text",
            text: `File "${filename}" sent to Telegram successfully.` + getReminders(currentThreadId),
          },
        ],
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to send file via Telegram: ${errorMsg}\n`);
      return {
        content: [
          {
            type: "text",
            text: `Error: Failed to send file to Telegram: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── send_voice ──────────────────────────────────────────────────────────
  if (name === "send_voice") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const text = typeof typedArgs.text === "string" ? typedArgs.text.trim() : "";
    const validVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
    type Voice = typeof validVoices[number];
    const voice: Voice = typeof typedArgs.voice === "string" && validVoices.includes(typedArgs.voice as Voice)
      ? typedArgs.voice as Voice
      : "nova";

    if (!text) {
      return {
        content: [{ type: "text", text: "Error: 'text' argument is required for send_voice." }],
        isError: true,
      };
    }

    if (!OPENAI_API_KEY) {
      return {
        content: [{ type: "text", text: "Error: OPENAI_API_KEY is not set. Cannot generate voice." }],
        isError: true,
      };
    }

    if (text.length > 4096) {
      return {
        content: [{ type: "text", text: `Error: text is ${text.length} characters — exceeds OpenAI TTS limit of 4096.` }],
        isError: true,
      };
    }

    try {
      const audioBuffer = await TelegramClient.textToSpeech(text, OPENAI_API_KEY, voice);
      await telegram.sendVoice(TELEGRAM_CHAT_ID, audioBuffer, currentThreadId);
      return {
        content: [
          {
            type: "text",
            text: `Voice message sent to Telegram successfully.` + getReminders(currentThreadId),
          },
        ],
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to send voice via Telegram: ${errorMsg}\n`);
      return {
        content: [
          {
            type: "text",
            text: `Error: Failed to send voice message: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Unknown tool
  return {
    content: [
      {
        type: "text",
        text: `Unknown tool: ${name}`,
      },
    ],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("Remote Copilot MCP server running on stdio.\n");
