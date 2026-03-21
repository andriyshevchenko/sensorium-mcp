/**
 * Session tool handlers extracted from index.ts.
 *
 * Handles: report_progress, hibernate
 */

import { convertMarkdown, splitMessage } from "../markdown.js";
import type { TelegramClient } from "../telegram.js";
import type { peekThreadMessages } from "../dispatcher.js";
import type { checkMaintenanceFlag } from "../config.js";
import type { checkDueTasks } from "../scheduler.js";
import { errorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closure-bound helpers passed by the caller (index.ts createMcpServer). */
export interface SessionToolContext {
  resolveThreadId: (args: Record<string, unknown>) => number | undefined;
  getReminders: (threadId: number | undefined, driveActive: boolean) => string;
  getShortReminder: (threadId: number | undefined) => string;
  errorResult: (msg: string) => { content: Array<{ type: string; text: string }>; isError: true };
  telegram: TelegramClient;
  telegramChatId: string;
  peekThreadMessages: typeof peekThreadMessages;
  checkMaintenanceFlag: typeof checkMaintenanceFlag;
  checkDueTasks: typeof checkDueTasks;
  generateDmnReflection: (threadId: number) => string;
  lastOperatorMessageAt: number;
  previewedUpdateIds: Set<number>;
  addPreviewedId: (id: number) => void;
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

interface Extra {
  sendNotification?: Function;
  signal: AbortSignal;
  requestId?: string | number;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleSessionTool(
  name: string,
  args: Record<string, unknown>,
  ctx: SessionToolContext,
  extra: Extra,
): Promise<ToolResult> {
  switch (name) {
    case "report_progress":
      return handleReportProgress(args, ctx);
    case "hibernate":
      return handleHibernate(args, ctx, extra);
    default:
      return ctx.errorResult(`Unknown session tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// report_progress
// ---------------------------------------------------------------------------

async function handleReportProgress(
  args: Record<string, unknown>,
  ctx: SessionToolContext,
): Promise<ToolResult> {
  const {
    resolveThreadId, getShortReminder, errorResult, telegram, telegramChatId,
    peekThreadMessages, previewedUpdateIds, addPreviewedId,
  } = ctx;

  const effectiveThreadId = resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return errorResult("Error: No active session. Call start_session first, then pass the returned threadId.");
  }
  const rawMessage =
    typeof args?.message === "string"
      ? (args.message as string)
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
      await telegram.sendMessage(telegramChatId, chunk, "MarkdownV2", effectiveThreadId);
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
          await telegram.sendMessage(telegramChatId, chunk, undefined, effectiveThreadId);
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

// ---------------------------------------------------------------------------
// hibernate
// ---------------------------------------------------------------------------

async function handleHibernate(
  args: Record<string, unknown>,
  ctx: SessionToolContext,
  extra: Extra,
): Promise<ToolResult> {
  const {
    resolveThreadId, getShortReminder, errorResult,
    peekThreadMessages, checkMaintenanceFlag, checkDueTasks,
    generateDmnReflection, lastOperatorMessageAt,
  } = ctx;

  const effectiveThreadId = resolveThreadId(args);
  if (effectiveThreadId === undefined) {
    return errorResult("Error: No active session. Call start_session first.");
  }

  const wakeAt = typeof args.wakeAt === "string" ? new Date(args.wakeAt).getTime() : undefined;
  if (wakeAt !== undefined && isNaN(wakeAt)) {
    return errorResult("Error: Invalid wakeAt timestamp. Use ISO 8601 format.");
  }

  // Max hibernation time: 8 hours
  const MAX_HIBERNATE_MS = 8 * 60 * 60 * 1000;
  const HIBERNATE_POLL_MS = 30_000; // 30s
  const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
  const deadline = Date.now() + MAX_HIBERNATE_MS;
  let lastKeepalive = Date.now();

  process.stderr.write(`[hibernate] Entering hibernation. threadId=${effectiveThreadId}, wakeAt=${wakeAt ? new Date(wakeAt).toISOString() : "indefinite"}\n`);

  while (Date.now() < deadline) {
    // Check for operator messages (non-destructive peek)
    const peeked = peekThreadMessages(effectiveThreadId);
    if (peeked.length > 0) {
      process.stderr.write(`[hibernate] Waking up — ${peeked.length} operator message(s) received.\n`);
      // Don't consume messages — let the next wait_for_instructions call handle them
      return {
        content: [{
          type: "text",
          text: `Woke up: operator sent a message. Call wait_for_instructions now to read it.` +
            getShortReminder(effectiveThreadId),
        }],
      };
    }

    // Maintenance flag: stay hibernating (don't wake) — the watcher will restart us
    // This is distinct from wait_for_instructions which tells the agent to hibernate.
    // Here we're already hibernating, so we just keep hibernating through the update.
    const maintenanceInfo = checkMaintenanceFlag();
    if (maintenanceInfo) {
      process.stderr.write(`[hibernate] Maintenance flag detected — staying hibernated through update: ${maintenanceInfo}\n`);
      // Skip all other checks, just keep hibernating
      await new Promise<void>((resolve) => setTimeout(resolve, HIBERNATE_POLL_MS));
      continue;
    }

    // Check for scheduled tasks
    const dueTask = checkDueTasks(effectiveThreadId, lastOperatorMessageAt, false);
    if (dueTask) {
      process.stderr.write(`[hibernate] Waking up — scheduled task fired: ${dueTask.task.label}\n`);
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
      process.stderr.write(`[hibernate] Waking up — alarm reached.\n`);
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
        process.stderr.write(`[hibernate] SSE keepalive failed — connection lost.\n`);
        return {
          content: [{
            type: "text",
            text: "Hibernation interrupted: connection lost. Call hibernate again to resume." +
              getShortReminder(effectiveThreadId),
          }],
        };
      }
    }

    // Check abort signal
    if (extra.signal.aborted) {
      process.stderr.write(`[hibernate] SSE connection aborted during hibernation.\n`);
      return {
        content: [{
          type: "text",
          text: "Hibernation interrupted: connection closed." +
            getShortReminder(effectiveThreadId),
        }],
      };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, HIBERNATE_POLL_MS));
  }

  // Max hibernation duration reached
  process.stderr.write(`[hibernate] Max hibernation duration reached (8h).\n`);
  return {
    content: [{
      type: "text",
      text: "Woke up: maximum hibernation duration reached (8 hours)." +
        getShortReminder(effectiveThreadId),
    }],
  };
}
