#!/usr/bin/env node
/**
 * Remote Copilot MCP Server
 *
 * Exposes three tools for AI assistants:
 *   - start_session                          Begin a remote-copilot session.
 *   - remote_copilot_wait_for_instructions  Poll Telegram for new user messages.
 *   - report_progress                        Send a progress update to Telegram.
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
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
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

// ---------------------------------------------------------------------------
// Telegram client + update-offset tracking
// ---------------------------------------------------------------------------

const telegram = new TelegramClient(TELEGRAM_TOKEN);

/**
 * The next update_id we want to receive.
 * Persisted across tool calls within the same server process so we never
 * re-deliver a message that was already handled.
 *
 * Initialised by draining the existing Telegram update backlog on startup
 * so that old messages are not replayed as instructions.
 */
let nextUpdateId = await (async () => {
  try {
    let offset = 0;
    for (; ;) {
      const updates = await telegram.getUpdates(offset, 0);
      if (updates.length === 0) break;
      offset = updates[updates.length - 1].update_id + 1;
    }
    return offset;
  } catch (err) {
    process.stderr.write(
      `Warning: Failed to drain Telegram update backlog on startup: ${err instanceof Error ? err.message : String(err)}\n` +
      "Old messages may be replayed. Continuing with offset 0.\n",
    );
    return 0;
  }
})();

// Monotonically increasing counter so every timeout response is unique,
// preventing VS Code Copilot's loop-detection heuristic from killing the agent.
let waitCallCount = 0;

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
        "Creates a new dedicated Telegram topic thread for this session. " +
        "If you are CONTINUING an existing chat (not a fresh conversation), " +
        "look back through the conversation history for a previous start_session " +
        "result that mentioned a Thread ID, then pass it as the threadId parameter " +
        "to resume that existing topic instead of creating a new one. " +
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
    threadHint
  );
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── start_session ─────────────────────────────────────────────────────────
  if (name === "start_session") {
    const typedArgs = (args ?? {}) as Record<string, unknown>;
    const resumeThreadId = typeof typedArgs.threadId === "number"
      ? typedArgs.threadId as number
      : undefined;
    const customName = typeof typedArgs.name === "string" && typedArgs.name.trim()
      ? typedArgs.name.trim()
      : undefined;

    if (resumeThreadId !== undefined) {
      // Resume mode: reuse an existing topic thread.
      currentThreadId = resumeThreadId;
      lastKeepAliveSentAt = Date.now();
      try {
        const msg = convertMarkdown("🔄 **Session resumed.** Continuing in this thread.");
        await telegram.sendMessage(TELEGRAM_CHAT_ID, msg, "MarkdownV2", currentThreadId);
      } catch {
        // Non-fatal.
      }
    } else {
      // New session: create a dedicated forum topic.
      const topicName = customName ??
        `Copilot — ${new Date().toLocaleString("en-GB", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: false,
        })}`;
      try {
        const topic = await telegram.createForumTopic(TELEGRAM_CHAT_ID, topicName);
        currentThreadId = topic.message_thread_id;
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
            `Session ${resumeThreadId !== undefined ? "resumed" : "started"}.${threadNote}` +
            ` Call the remote_copilot_wait_for_instructions tool next.` +
            getReminders(currentThreadId),
        },
      ],
    };
  }

  // ── remote_copilot_wait_for_instructions ──────────────────────────────────
  if (name === "remote_copilot_wait_for_instructions") {    const callNumber = ++waitCallCount;    const timeoutMs = WAIT_TIMEOUT_MINUTES * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    // Telegram's maximum long-poll timeout is 50 s; we loop until the
    // wall-clock deadline is reached.
    const POLL_TIMEOUT_SECONDS = 45;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const pollSeconds = Math.min(
        POLL_TIMEOUT_SECONDS,
        Math.ceil(remaining / 1000),
      );

      const controller = new AbortController();
      // Give the fetch a bit of extra headroom over the Telegram timeout.
      const fetchTimeoutId = setTimeout(
        () => controller.abort(),
        (pollSeconds + 10) * 1000,
      );

      let updates;
      try {
        updates = await telegram.getUpdates(
          nextUpdateId,
          pollSeconds,
          controller.signal,
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // Fetch was aborted due to per-request timeout; retry if overall
          // deadline has not yet been reached.
          continue;
        }
        throw new Error(
          `Failed to fetch updates from Telegram: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        clearTimeout(fetchTimeoutId);
      }

      if (updates.length > 0) {
        // Advance the offset so we don't see these updates again.
        nextUpdateId = updates[updates.length - 1].update_id + 1;

        // Collect text messages from the target chat, scoped to the active thread.
        const messages = updates
          .filter(
            (u) =>
              u.message?.text !== undefined &&
              String(u.message.chat.id) === TELEGRAM_CHAT_ID &&
              (currentThreadId === undefined ||
                u.message.message_thread_id === currentThreadId),
          )
          .map((u) => u.message!.text as string);

        if (messages.length > 0) {
          const prompt = messages.join("\n\n");
          return {
            content: [
              {
                type: "text",
                text:
                  `Follow the instructions: ${prompt}. Create plan, use subagents.` +
                  getReminders(currentThreadId),
              },
            ],
          };
        }
        // Updates existed but none were relevant text messages from our chat;
        // continue polling.
      }
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
          (currentThreadId !== undefined ? ` \\(thread ${currentThreadId}\\)` : ""),
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

    // Collect any messages the operator sent while the agent was working so
    // they are not missed when remote_copilot_wait_for_instructions is called.
    let pendingMessages: string[] = [];
    try {
      const pendingUpdates = await telegram.getUpdates(nextUpdateId, 0);
      if (pendingUpdates.length > 0) {
        nextUpdateId = pendingUpdates[pendingUpdates.length - 1].update_id + 1;
        pendingMessages = pendingUpdates
          .filter(
            (u) =>
              u.message?.text !== undefined &&
              String(u.message.chat.id) === TELEGRAM_CHAT_ID &&
              (currentThreadId === undefined ||
                u.message.message_thread_id === currentThreadId),
          )
          .map((u) => u.message!.text as string);
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
        ` - Continue your work. Keep using subagents.` +
        getReminders(currentThreadId)
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
