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
 *   TELEGRAM_CHAT_ID  – Target chat / user ID.
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
        "Start a remote-copilot session. Call this tool to begin listening for operator instructions.",
      inputSchema: {
        type: "object",
        properties: {},
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── start_session ─────────────────────────────────────────────────────────
  if (name === "start_session") {
    return {
      content: [
        {
          type: "text",
          text: "Call report_progress. Greet the user and tell that remote Copilot session started. Call the remote_copilot_wait_for_instructions tool next.",
        },
      ],
    };
  }

  // ── remote_copilot_wait_for_instructions ──────────────────────────────────
  if (name === "remote_copilot_wait_for_instructions") {
    const timeoutMs = WAIT_TIMEOUT_MINUTES * 60 * 1000;
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

        // Collect text messages from the target chat.
        const messages = updates
          .filter(
            (u) =>
              u.message?.text !== undefined &&
              String(u.message.chat.id) === TELEGRAM_CHAT_ID,
          )
          .map((u) => u.message!.text as string);

        if (messages.length > 0) {
          const prompt = messages.join("\n\n");
          return {
            content: [
              {
                type: "text",
                text:
                  `Follow the instructions: ${prompt}. ` +
                  `Create plan, use subagents. ` +
                  `Use web search for framework/pattern related concerns. ` +
                  `Use report_progress tool to proactively report progress to the user. ` +
                  `After you're done (don't skip this step), call remote_copilot_wait_for_instructions again to keep the feedback loop alive`,
              },
            ],
          };
        }
        // Updates existed but none were relevant text messages from our chat;
        // continue polling.
      }
    }

    // Timeout elapsed with no actionable message.
    return {
      content: [
        {
          type: "text",
          text:
            `No new instructions received within ${WAIT_TIMEOUT_MINUTES} minute(s). ` +
            `Call remote_copilot_wait_for_instructions again to keep listening for instructions.`,
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
    const message = telegramifyMarkdown(rawMessage, "escape");

    let sentAsPlainText = false;
    try {
      await telegram.sendMessage(TELEGRAM_CHAT_ID, message, "MarkdownV2");
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      // If Telegram rejected the message due to a MarkdownV2 parse error,
      // retry without parse_mode so the operator still receives the update.
      const isParseError = errorMsg.includes("can't parse entities");
      if (isParseError) {
        try {
          await telegram.sendMessage(TELEGRAM_CHAT_ID, message);
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
              String(u.message.chat.id) === TELEGRAM_CHAT_ID,
          )
          .map((u) => u.message!.text as string);
      }
    } catch {
      // Non-fatal: pending messages will still be picked up by the next
      // remote_copilot_wait_for_instructions call.
    }

    const baseStatus = sentAsPlainText
      ? "Progress reported successfully (as plain text — formatting could not be applied)."
      : "Progress reported successfully.";

    const responseText =
      pendingMessages.length > 0
        ? `${baseStatus}\n\n` +
        `While you were working, the operator sent additional message(s). ` +
        `Use those messages to steer an active session: ${pendingMessages.join("\n\n")}. ` +
        `You should:\n` +
        ` - Read and incorporate the operator's new messages.\n` +
        ` - Update or refine your plan as needed.\n` +
        ` - Continue your work. Keep using subagents. Keep using web search for framework/pattern related concerns.\n ` +
        `Use report_progress tool to proactively report progress to the user. ` +
        `After you're done (don't skip this step), call remote_copilot_wait_for_instructions again to keep the feedback loop alive`
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
