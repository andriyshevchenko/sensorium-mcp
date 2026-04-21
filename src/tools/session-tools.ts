/**
 * Session tool handlers extracted from index.ts.
 *
 * Handles: report_progress
 */

import { convertMarkdown, splitMessage } from "../markdown.js";
import type { TelegramClient } from "../telegram.js";
import type { peekThreadMessages, readThreadMessages, appendToThread } from "../dispatcher.js";
import { log } from "../logger.js";
import { saveAgentEpisodeSafe, type Database } from "../memory.js";
import type { ToolResult } from "../types.js";
import { errorMessage } from "../utils.js";
import { getThread } from "../data/memory/thread-registry.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PENDING_TASKS_DIR } from "../services/process.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a Telegram message object contains any media attachment. */
function hasMediaContent(msg: Record<string, unknown>): boolean {
  return !!(msg.photo || msg.document || msg.voice || msg.video_note || msg.animation || msg.sticker);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closure-bound helpers passed by the caller (index.ts createMcpServer). */
export interface SessionToolContext {
  resolveThreadId: (args: Record<string, unknown>) => number | undefined;
  getShortReminder: (threadId: number | undefined) => string;
  errorResult: (msg: string) => ToolResult & { isError: true };
  telegram: TelegramClient;
  telegramChatId: string;
  peekThreadMessages: typeof peekThreadMessages;
  readThreadMessages: typeof readThreadMessages;
  appendToThread: typeof appendToThread;
  previewedUpdateIds: Set<number>;
  addPreviewedId: (id: number) => void;
  getMemoryDb: () => Database;
  sessionStartedAt: number;
}

interface Extra {
  sendNotification?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
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
  _extra: Extra,
): Promise<ToolResult> {
  switch (name) {
    case "report_progress":
      return handleReportProgress(args, ctx);
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
    peekThreadMessages, readThreadMessages, appendToThread,
    previewedUpdateIds, addPreviewedId,
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
        log.error(
          `Failed to send progress message via Telegram (plain fallback): ${errorMessage(retryError)}`,
        );
        return errorResult(
          "Error: Failed to send progress update to Telegram even without formatting. " +
          "Please check the Telegram configuration and try again.",
        );
      }
    } else {
      log.error(
        `Failed to send progress message via Telegram: ${errMsg}`,
      );
      return errorResult(
        "Error: Failed to send progress update to Telegram. " +
        "Check the Telegram configuration and try again.",
      );
    }
  }

  // Peek at any messages the operator sent while the agent was working.
  // Tracks previewed update_ids to prevent duplicate previews across calls.
  // After building the steering preview, we consume messages to prevent
  // re-delivery after a server restart. Messages with media are re-queued
  // so wait_for_instructions can still fully process them.
  let pendingMessages: string[] = [];
  let hasNewPreviews = false;
  try {
    const pendingStored = peekThreadMessages(effectiveThreadId);
    for (const msg of pendingStored) {
      if (previewedUpdateIds.has(msg.update_id)) continue;
      hasNewPreviews = true;
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

    // Advance the offset: consume all pending messages so they aren't
    // re-delivered if the server restarts before wait_for_instructions
    // runs.  Messages with media (photo, voice, document, video_note,
    // animation, sticker) are re-queued so wait_for_instructions can
    // still download / transcribe / vision-analyze them.
    if (hasNewPreviews && effectiveThreadId !== undefined) {
      const consumed = readThreadMessages(effectiveThreadId);
      for (const msg of consumed) {
        const hasMedia = hasMediaContent(msg.message as Record<string, unknown>);
        if (hasMedia) {
          appendToThread(effectiveThreadId, msg);
        }
      }
      log.info(`[report_progress] Consumed ${consumed.length} messages (re-queued ${consumed.filter(m => hasMediaContent(m.message as Record<string, unknown>)).length} with media)`);
    }
  } catch (err) {
    // Non-fatal: pending messages will still be picked up by the next
    // remote_copilot_wait_for_instructions call.
    log.debug(`[report_progress] Failed to peek/consume pending messages: ${err instanceof Error ? (err as Error).message : String(err)}`);
  }

  const baseStatus =
    (sentAsPlainText
      ? "Progress reported successfully (as plain text — formatting could not be applied)."
      : "Progress reported successfully.") + getShortReminder(effectiveThreadId);

  // Save agent progress report as episode for warm context
  saveAgentEpisodeSafe(ctx.getMemoryDb, {
    sessionStartedAt: ctx.sessionStartedAt,
    threadId: effectiveThreadId,
    modality: "text",
    text: rawMessage,
  });

  // Auto-forward to parent thread for worker threads.
  // Codex workers often call report_progress but forget send_message_to_thread.
  // This ensures the parent orchestrator always receives the worker's output.
  try {
    const db = ctx.getMemoryDb();
    const entry = getThread(db, effectiveThreadId);
    if (entry && entry.type === "worker" && entry.rootThreadId) {
      const parentId = entry.rootThreadId;
      mkdirSync(PENDING_TASKS_DIR, { recursive: true });
      const taskFile = join(PENDING_TASKS_DIR, `${parentId}.txt`);
      const replyMsg =
        `Thread "${entry.name}" (worker ${effectiveThreadId}) reports back:\n---\n${rawMessage}\n---\n`;
      appendFileSync(taskFile, replyMsg + "\n", "utf-8");
      log.info(`[report_progress] Auto-forwarded to parent thread ${parentId}`);
    }
  } catch (err) {
    log.debug(`[report_progress] Auto-forward failed: ${errorMessage(err)}`);
  }

  const loopReminder =
    "\n\nWhen your current work is complete, call `remote_copilot_wait_for_instructions` to continue listening.";

  const responseText =
    pendingMessages.length > 0
      ? `${baseStatus}\n\n` +
      `While you were working, the operator sent additional message(s). ` +
      `Use those messages to steer your active session: ${pendingMessages.join("\n\n")}` +
      loopReminder
      : baseStatus + loopReminder;

  return {
    content: [
      {
        type: "text",
        text: responseText,
      },
    ],
  };
}
