/**
 * Utility tool definitions — report_progress, get_version.
 */

import type { ToolDefinition } from "../definitions.js";

export const utilityToolDefs: ToolDefinition[] = [
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
    name: "get_version",
    description:
      "Get the current server version. Also reports if an update is pending.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
