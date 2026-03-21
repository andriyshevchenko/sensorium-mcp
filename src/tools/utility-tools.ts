/**
 * Utility tool handlers extracted from index.ts.
 *
 * Handles: send_file, send_voice, schedule_wake_up, get_version, get_usage_stats
 */

import { readFile } from "fs/promises";
import { basename } from "node:path";
import { checkMaintenanceFlag } from "../config.js";
import { textToSpeech, TTS_VOICES, type TTSVoice } from "../openai.js";
import { rateLimiter } from "../rate-limiter.js";
import { addSchedule, generateTaskId, listSchedules, removeSchedule, type ScheduledTask } from "../scheduler.js";
import type { TelegramClient } from "../telegram.js";
import type { AppConfig } from "../types.js";
import { log } from "../logger.js";
import { errorMessage, IMAGE_EXTENSIONS, OPENAI_TTS_MAX_CHARS } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closure-bound helpers passed by the caller (index.ts createMcpServer). */
export interface UtilityToolContext {
  resolveThreadId: (args: Record<string, unknown>) => number | undefined;
  getShortReminder: (threadId: number | undefined) => string;
  errorResult: (msg: string) => { content: Array<{ type: string; text: string }>; isError: true };
  telegram: TelegramClient;
  config: AppConfig;
  sessionStartedAt: number;
  waitCallCount: number;
  toolCallsSinceLastDelivery: number;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleUtilityTool(
  name: string,
  args: Record<string, unknown>,
  ctx: UtilityToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "send_file":
      return handleSendFile(args, ctx);
    case "send_voice":
      return handleSendVoice(args, ctx);
    case "schedule_wake_up":
      return handleScheduleWakeUp(args, ctx);
    case "get_version":
      return handleGetVersion(ctx);
    case "get_usage_stats":
      return handleGetUsageStats(args, ctx);
    default:
      return ctx.errorResult(`Unknown utility tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// send_file
// ---------------------------------------------------------------------------

async function handleSendFile(
  args: Record<string, unknown>,
  ctx: UtilityToolContext,
): Promise<ToolResult> {
  const { resolveThreadId, getShortReminder, errorResult, telegram, config } = ctx;
  const effectiveThreadId = resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return errorResult("Error: No active session. Call start_session first, then pass the returned threadId.");
  }
  const filePath = typeof args.filePath === "string" ? args.filePath.trim() : "";
  const base64Data = typeof args.base64 === "string" ? args.base64 : "";
  const caption = typeof args.caption === "string" ? args.caption : undefined;

  if (!filePath && !base64Data) {
    return errorResult("Error: either 'filePath' or 'base64' argument is required for send_file.");
  }

  try {
    let buffer: Buffer;
    let filename: string;

    if (filePath) {
      // Read directly from disk — fast, no LLM context overhead.
      buffer = await readFile(filePath);
      filename = typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : basename(filePath);
    } else {
      buffer = Buffer.from(base64Data, "base64");
      filename = typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : "file";
    }

    const ext = filename.split(".").pop()?.toLowerCase() ?? "";

    if (IMAGE_EXTENSIONS.has(ext)) {
      await telegram.sendPhoto(config.TELEGRAM_CHAT_ID, buffer, filename, caption, effectiveThreadId);
    } else {
      await telegram.sendDocument(config.TELEGRAM_CHAT_ID, buffer, filename, caption, effectiveThreadId);
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
    log.error(`Failed to send file via Telegram: ${errorMessage(err)}`);
    return errorResult(`Error: Failed to send file to Telegram: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// send_voice
// ---------------------------------------------------------------------------

async function handleSendVoice(
  args: Record<string, unknown>,
  ctx: UtilityToolContext,
): Promise<ToolResult> {
  const { resolveThreadId, getShortReminder, errorResult, telegram, config } = ctx;
  const effectiveThreadId = resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return errorResult("Error: No active session. Call start_session first, then pass the returned threadId.");
  }
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const validVoices = TTS_VOICES;
  const voice: TTSVoice = typeof args.voice === "string" && (validVoices as readonly string[]).includes(args.voice)
    ? args.voice as TTSVoice
    : "nova";

  if (!text) {
    return errorResult("Error: 'text' argument is required for send_voice.");
  }

  if (!config.OPENAI_API_KEY) {
    return errorResult("Error: OPENAI_API_KEY is not set. Cannot generate voice.");
  }

  if (text.length > OPENAI_TTS_MAX_CHARS) {
    return errorResult(`Error: text is ${text.length} characters — exceeds OpenAI TTS limit of ${OPENAI_TTS_MAX_CHARS}.`);
  }

  try {
    const audioBuffer = await textToSpeech(text, config.OPENAI_API_KEY, voice);
    await telegram.sendVoice(config.TELEGRAM_CHAT_ID, audioBuffer, effectiveThreadId);
    return {
      content: [
        {
          type: "text",
          text: `Voice message sent to Telegram successfully.` + getShortReminder(effectiveThreadId),
        },
      ],
    };
  } catch (err) {
    log.error(`Failed to send voice via Telegram: ${errorMessage(err)}`);
    return errorResult(`Error: Failed to send voice message: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// schedule_wake_up
// ---------------------------------------------------------------------------

async function handleScheduleWakeUp(
  args: Record<string, unknown>,
  ctx: UtilityToolContext,
): Promise<ToolResult> {
  const { resolveThreadId, getShortReminder, errorResult } = ctx;
  const effectiveThreadId = resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return errorResult("Error: No active session. Call start_session first.");
  }

  const action = typeof args.action === "string" ? args.action : "add";

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
    const taskId = typeof args.taskId === "string" ? args.taskId : "";
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
  const label = typeof args.label === "string" ? args.label : "unnamed task";
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (!prompt) {
    return errorResult("Error: 'prompt' is required — this is the text that will be injected when the task fires.");
  }

  const runAt = typeof args.runAt === "string" ? args.runAt : undefined;
  const cron = typeof args.cron === "string" ? args.cron : undefined;
  const afterIdleMinutes = typeof args.afterIdleMinutes === "number" ? args.afterIdleMinutes : undefined;

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

// ---------------------------------------------------------------------------
// get_version
// ---------------------------------------------------------------------------

function handleGetVersion(ctx: UtilityToolContext): ToolResult {
  const maintenance = checkMaintenanceFlag();
  return {
    content: [{
      type: "text",
      text: `Server version: ${ctx.config.PKG_VERSION}` +
        (maintenance ? `\n⚠️ Update pending: ${maintenance}` : ""),
    }],
  };
}

// ---------------------------------------------------------------------------
// get_usage_stats
// ---------------------------------------------------------------------------

function handleGetUsageStats(
  args: Record<string, unknown>,
  ctx: UtilityToolContext,
): ToolResult {
  const threadId = ctx.resolveThreadId(args);
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
    content: [{ type: "text", text: lines.join("\n") + ctx.getShortReminder(threadId) }],
  };
}
