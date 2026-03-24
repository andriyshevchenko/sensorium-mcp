/**
 * MCP tool definitions — JSON schemas for all 14 tools.
 * Separated from index.ts for readability.
 */

import { OPENAI_TTS_MAX_CHARS } from "../utils.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
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
        "IMPORTANT: When creating a new session (no threadId), the 'name' parameter is REQUIRED — " +
        "provide a short, descriptive name for the session (e.g. 'Fix auth bug'). " +
        "When resuming an existing session (threadId provided), name is optional. " +
        "Requires the Telegram chat to be a forum supergroup with the bot as admin. " +
        "Call this tool once, then call remote_copilot_wait_for_instructions.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "A human-readable label for this session's Telegram topic (e.g. 'Fix auth bug'). " +
              "REQUIRED when creating a new session (no threadId). Optional when resuming an existing session (threadId provided).",
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
        "Note: cron expressions are evaluated against server-local time (not UTC). " +
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
            description: "5-field cron expression for recurring tasks (e.g. '0 9 * * *' = every day at 9am). Cron expressions are evaluated against server-local time (not UTC).",
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
    {
      name: "hibernate",
      description:
        "Enter hibernation — the agent suspends until a specific time, a scheduled task fires, or the operator sends a message. " +
        "Only call this when the operator explicitly asks you to hibernate/sleep/stop. Self-hibernation is not allowed. " +
        "Specify 'wakeAt' (ISO 8601 timestamp) for a timed alarm, or omit it to hibernate indefinitely until operator message or scheduled task wakes you. " +
        "Hibernation uses a low-frequency poll (30s intervals) to minimize resource usage. " +
        "On wake, returns the reason: 'operator_message', 'scheduled_task', 'alarm', or 'connection_lost'.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "number",
            description: "Thread ID for the session (optional if already set).",
          },
          wakeAt: {
            type: "string",
            description: "ISO 8601 timestamp to wake up at (e.g. '2026-03-20T14:00:00+02:00'). If omitted, hibernates until operator message or scheduled task.",
          },
        },
      },
    },
    // ── Memory Tools ──────────────────────────────────────────────────
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
          priority: {
            type: "number",
            description: "0=normal, 1=notable, 2=high importance. Infer from operator's emotional investment: 'important'/'I really need' → 2, 'would be nice'/'should' → 1, else 0.",
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
          newPriority: {
            type: "number",
            description: "Updated priority: 0=normal, 1=notable, 2=high importance.",
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
    // ── Sticker Tool ──────────────────────────────────────────────────
    {
      name: "send_sticker",
      description:
        "Send a sticker to the operator in Telegram. Use sticker file_ids from previously received sticker messages. " +
        "When the operator sends a sticker, the file_id is included in the delivered message — you can reuse it to send the same sticker back or mirror their reaction.",
      inputSchema: {
        type: "object",
        properties: {
          stickerId: {
            type: "string",
            description:
              "The Telegram file_id of the sticker to send. Obtain this from sticker messages received from the operator.",
          },
          threadId: {
            type: "number",
            description:
              "The Telegram thread ID of the active session. " +
              "ALWAYS pass this if you received it from start_session.",
          },
        },
        required: ["stickerId"],
      },
    },
    // ── Thread Management ────────────────────────────────────────────
    {
      name: "start_thread",
      description:
        "Ensure an agent session is running on a named thread. " +
        "Creates the thread if it doesn't exist. Restarts if dormant. No-op if already active. " +
        "Use this before send_message_to_thread.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Thread name for the session (e.g. 'Azure-WorkItems'). " +
              "Resolved case-insensitively against persisted sessions.",
          },
          agentType: {
            type: "string",
            description:
              'Which agent type to use: "copilot" | "claude" | "cursor". Defaults to "claude".',
            enum: ["copilot", "claude", "cursor"],
          },
        },
        required: ["name"],
      },
    },
    {
      name: "send_message_to_thread",
      description:
        "Send a task or message to another thread's agent. " +
        "The agent receives it on their next poll. " +
        "If the thread is dormant, the message is queued but not processed until start_thread is called.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "number",
            description: "The Telegram thread ID to send the message to.",
          },
          message: {
            type: "string",
            description: "The task or message content to send.",
          },
        },
        required: ["threadId", "message"],
      },
    },
    // ── Server Info Tools ─────────────────────────────────────────────
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
}
