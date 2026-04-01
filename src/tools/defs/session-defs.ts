/**
 * Session tool definitions — start_session, schedule_wake_up,
 * send_voice, send_file, send_sticker, start_thread, send_message_to_thread.
 */

import type { ToolDefinition } from "../definitions.js";
import { OPENAI_TTS_MAX_CHARS } from "../../utils.js";

export const sessionToolDefs: ToolDefinition[] = [
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
      "IMPORTANT: When creating a new session (no threadId), the 'name' parameter is REQUIRED \u2014 " +
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
            "When provided, no new topic is created \u2014 the session continues in the existing thread.",
        },        agentType: {
          type: "string",
          description:
            'Which agent type is connecting: "copilot" | "copilot_claude" | "copilot_codex" | "claude" | "cursor" | "codex" | "openai_codex". ' +
            "Determines agent-specific reminders and routing. Defaults to the dashboard setting.",
          enum: ["copilot", "copilot_claude", "copilot_codex", "claude", "cursor", "codex", "openai_codex"],
        },},
      required: [],
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
            "Absolute path to the file on disk. PREFERRED over base64 \u2014 the server reads " +
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
      "Use this to become proactive \u2014 run tests, check CI, review code \u2014 without waiting for the operator. " +
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
    name: "send_sticker",
    description:
      "Send a sticker to the operator in Telegram. Use sticker file_ids from previously received sticker messages. " +
      "When the operator sends a sticker, the file_id is included in the delivered message \u2014 you can reuse it to send the same sticker back or mirror their reaction.",
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
          description: "Thread name",
        },
        threadId: {
          type: "number",
          description: "Explicit Telegram thread ID (optional — auto-created if not provided)",
        },
        targetThreadId: {
          type: "number",
          description: "Alias for threadId — preferred when session context already uses threadId.",
        },
        threadType: {
          type: "string",
          enum: ["worker", "branch"],
          description:
            "Thread type. 'worker': temporary thread with read-only memory, auto-cleaned after 1 hour. " +
            "'branch': long-lived thread that reads AND writes to the memory bank.",
        },
        memoryBankId: {
          type: "number",
          description: "Memory bank thread ID. Workers read from it. Branches read from AND write to it.",
        },
        agentType: {
          type: "string",
          enum: ["copilot", "copilot_claude", "copilot_codex", "claude", "cursor", "codex", "openai_codex"],
        },
        workingDirectory: {
          type: "string",
          description: "Absolute path for cwd",
        },
        memorySourceThreadId: {
          type: "number",
          description: "Advanced: explicit source memory thread (use memoryBankId + threadType instead)",
        },
        targetMemoryThreadId: {
          type: "number",
          description: "Advanced: explicit target memory thread (use memoryBankId + threadType instead)",
        },
      },
      required: ["workingDirectory"],
    },
  },
  {
    name: "get_threads_health",
    description:
      "Get health status of all known threads — shows running, dormant, and dead threads with PIDs, last activity, and session status. Use this to discover what threads exist and their current state.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_message_to_thread",
    description:
      "Send a task or message to another thread's agent. " +
      "The agent receives it on their next poll. " +
      "Use mode='reply' when sending results BACK to a parent/orchestrator thread (no task wrapper added). " +
      "If the thread is dormant, the message is queued but not processed until start_thread is called. " +
      "Use 'mode' to control how the receiving thread should behave: " +
      "'one-shot' (default) for fire-and-forget tasks, 'manager-worker' for collaborative back-and-forth.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "number",
          description: "The Telegram thread ID to send the message to.",
        },
        targetThreadId: {
          type: "number",
          description: "Alias for threadId — preferred when session context already uses threadId.",
        },
        message: {
          type: "string",
          description: "The task or message content to send.",
        },
        mode: {
          type: "string",
          description:
            "Delegation mode: 'one-shot' (default) \u2014 receiver reports to operator only, does not message sender back. " +
            "'manager-worker' \u2014 receiver reports back to sender thread when complete. " +
            "'reply' — sending results/status BACK to a parent or orchestrator thread (no task boilerplate added). " +
            "'peer' — raw P2P message with sender attribution, no task instructions or skill loading. For equal-status thread conversations.",
          enum: ["one-shot", "manager-worker", "reply", "peer"],
        },
        senderName: {
          type: "string",
          description: "Name of the sending thread (so the receiver knows who delegated the task).",
        },
        senderThreadId: {
          type: "number",
          description: "Thread ID of the sender (used in manager-worker mode for reply routing).",
        },
      },
      required: ["threadId", "message"],
    },
  },
];
