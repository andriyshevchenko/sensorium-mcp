/**
 * Message delivery logic extracted from wait-tool.ts (Phase 4).
 *
 * Handles:
 *   - Simple message processing (photo, document, text, sticker)
 *   - Auto-ingesting episodes for messages not saved by media handlers
 *   - Smart context injection (embedding search + GPT-4o-mini filter)
 *   - Intent classification and final operator response assembly
 */

import { basename } from "node:path";
import { saveFileToDisk } from "../../data/file-storage.js";
import type { StoredMessage } from "../../dispatcher.js";
import { classifyIntent, type MessageIntent } from "../../intent.js";
import { log } from "../../logger.js";
import {
  saveEpisode,
  searchByEmbedding,
  searchSemanticNotesRanked,
  getPinnedNotes,
  type initMemoryDb,
} from "../../memory.js";
import {
  generateEmbedding,
} from "../../openai.js";
import { extractSearchKeywords, getReminders, getMediumReminder } from "../../response-builders.js";
import type { TelegramClient } from "../../telegram.js";
import { errorMessage, IMAGE_EXTENSIONS } from "../../utils.js";
import { resolveKnowledgeThreadId } from "../../config.js";

import type { ContentBlock, ToolResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CONTEXT_TEXT_LENGTH = 10;
const MAX_EPISODE_CONTENT_LENGTH = 2000;
const SMART_CONTEXT_MAX_RESULTS = 15;
const MIN_SIMILARITY = 0.25;
const MAX_INJECTED_NOTES = 7;
const NOTE_CONTENT_MAX_CHARS = 400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageDeliveryContext {
  telegram: TelegramClient;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  effectiveThreadId: number;
  sessionStartedAt: number;
  autonomousMode: boolean;
}

// ---------------------------------------------------------------------------
// processSimpleMessage
// ---------------------------------------------------------------------------

/**
 * Process non-media message types for a single StoredMessage.
 * Handles: photo, document, text, sticker.
 * Returns content blocks for the processed parts.
 */
export async function processSimpleMessage(
  msg: StoredMessage,
  telegram: TelegramClient,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  // Photos: download the largest size, persist to disk, and embed as base64.
  if (msg.message.photo && msg.message.photo.length > 0) {
    const largest = msg.message.photo[msg.message.photo.length - 1];
    try {
      const { buffer, filePath: telegramPath } = await telegram.downloadFileAsBuffer(
        largest.file_id,
      );
      const ext = telegramPath.split(".").pop()?.toLowerCase() ?? "jpg";
      const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const base64 = buffer.toString("base64");
      const diskPath = saveFileToDisk(buffer, `photo.${ext}`);
      blocks.push({ type: "image", data: base64, mimeType });
      blocks.push({
        type: "text",
        text: `[Photo saved to: ${diskPath}]` +
          (msg.message.caption ? ` Caption: ${msg.message.caption}` : ""),
      });
    } catch (err) {
      blocks.push({
        type: "text",
        text: `[Photo received but could not be downloaded: ${errorMessage(err)}]`,
      });
    }
  }

  // Documents: download, persist to disk, and embed as base64.
  if (msg.message.document) {
    const doc = msg.message.document;
    try {
      const { buffer, filePath: telegramPath } = await telegram.downloadFileAsBuffer(
        doc.file_id,
      );
      const filename = doc.file_name ?? basename(telegramPath);
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = doc.mime_type ?? (IMAGE_EXTENSIONS.has(ext) ? `image/${ext === "jpg" ? "jpeg" : ext}` : "application/octet-stream");
      const base64 = buffer.toString("base64");
      const diskPath = saveFileToDisk(buffer, filename);
      const isImage = mimeType.startsWith("image/");
      if (isImage) {
        blocks.push({ type: "image", data: base64, mimeType });
        blocks.push({
          type: "text",
          text: `[File saved to: ${diskPath}]` +
            (msg.message.caption ? ` Caption: ${msg.message.caption}` : ""),
        });
      } else {
        // Non-image documents: provide the disk path instead of
        // dumping potentially huge base64 into the LLM context.
        blocks.push({
          type: "text",
          text: `[Document: ${filename} (${mimeType}) — saved to: ${diskPath}]` +
            (msg.message.caption ? ` Caption: ${msg.message.caption}` : ""),
        });
      }
    } catch (err) {
      blocks.push({
        type: "text",
        text: `[Document "${doc.file_name ?? "file"}" received but could not be downloaded: ${errorMessage(err)}]`,
      });
    }
  }

  // Text messages.
  if (msg.message.text) {
    blocks.push({ type: "text", text: msg.message.text });
  }

  // Stickers: deliver as text with emoji, set name, and file_id (so agent can re-use it).
  if (msg.message.sticker) {
    const emoji = msg.message.sticker.emoji || "🏷️";
    const setName = msg.message.sticker.set_name || "unknown";
    const fileId = msg.message.sticker.file_id;
    blocks.push({
      type: "text",
      text: `(The operator sent a sticker: ${emoji} from pack "${setName}", file_id: "${fileId}")`,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// handleEmptyContent
// ---------------------------------------------------------------------------

/**
 * If contentBlocks is empty after processing all messages, push an
 * unsupported-type placeholder and log the message fields for debugging.
 */
export function handleEmptyContent(
  contentBlocks: ContentBlock[],
  stored: StoredMessage[],
): void {
  if (contentBlocks.length === 0) {
    const msgKeys = stored.map(m =>
      Object.keys(m.message).filter(k => (m.message as Record<string, unknown>)[k] != null).join(","),
    ).join(" | ");
    log.warn(`[wait] No content blocks from ${stored.length} messages. Fields: ${msgKeys}`);
    contentBlocks.push({
      type: "text",
      text: "[Unsupported message type received — the operator sent a message type that cannot be processed (e.g., sticker, location, contact). Please ask them to resend as text, photo, document, or voice.]",
    });
  }
}

// ---------------------------------------------------------------------------
// autoIngestEpisodes
// ---------------------------------------------------------------------------

/**
 * Auto-ingest episodes for messages that were not already saved by
 * voice/video handlers (identified by savedEpisodeUpdateIds).
 */
export function autoIngestEpisodes(
  stored: StoredMessage[],
  savedEpisodeUpdateIds: Set<number>,
  ctx: Pick<MessageDeliveryContext, "getMemoryDb" | "effectiveThreadId" | "sessionStartedAt">,
): void {
  try {
    const db = ctx.getMemoryDb();
    const sessionId = `session_${ctx.sessionStartedAt}`;
    if (ctx.effectiveThreadId !== undefined) {
      // Collect text from messages that didn't already get an episode
      const unsavedMsgs = stored.filter(m => !savedEpisodeUpdateIds.has(m.update_id));
      if (unsavedMsgs.length > 0) {
        // No content filter needed: autoIngestEpisodes only processes
        // Telegram messages (from readThreadMessages). Server-generated
        // maintenance messages are returned as tool responses and never
        // enter the dispatcher queue, so they cannot reach this path.
        const textContent = unsavedMsgs
          .map(m => m.message.text ?? m.message.caption ?? "")
          .filter(Boolean)
          .join("\n")
          .slice(0, MAX_EPISODE_CONTENT_LENGTH);
        if (textContent) {
          saveEpisode(db, {
            sessionId,
            threadId: ctx.effectiveThreadId,
            type: "operator_message",
            modality: "text",
            content: { text: textContent },
            importance: 0.5,
          });
        }
      }
    }
  } catch (err) { log.warn(`Episode save failed during delivery: ${err instanceof Error ? err.message : String(err)}`); }
}

// ---------------------------------------------------------------------------
// buildSmartContext
// ---------------------------------------------------------------------------

/**
 * Smart context injection: retrieves candidate memory notes via embedding
 * search, then uses GPT-4o-mini to select ONLY the notes truly relevant
 * to the operator's message. Falls back to keyword search if embedding
 * fails, and to raw top-3 if the LLM filter fails.
 */
export async function buildSmartContext(
  operatorText: string,
  ctx: Pick<MessageDeliveryContext, "getMemoryDb" | "effectiveThreadId">,
): Promise<string> {
  let autoMemoryContext = "";
  try {
    const db = ctx.getMemoryDb();
    const apiKey = process.env.OPENAI_API_KEY;

    if (operatorText.length > MIN_CONTEXT_TEXT_LENGTH && apiKey) {
      // Phase 1: Broad retrieval — get 10 candidates via embedding search
      let candidates: { type: string; content: string; confidence: number; similarity?: number }[] = [];
      try {
        const queryEmb = await generateEmbedding(operatorText, apiKey);
        const embResults = searchByEmbedding(db, queryEmb, { maxResults: SMART_CONTEXT_MAX_RESULTS, minSimilarity: MIN_SIMILARITY, skipAccessTracking: true, threadId: resolveKnowledgeThreadId(ctx.effectiveThreadId) });
        candidates = embResults.map(n => ({ type: n.type, content: n.content.slice(0, NOTE_CONTENT_MAX_CHARS), confidence: n.confidence, similarity: n.similarity }));
      } catch (err) {
        // Fallback to keyword search
        log.warn(`Embedding generation failed, falling back to keyword search: ${err instanceof Error ? err.message : String(err)}`);
        const searchQuery = extractSearchKeywords(operatorText);
        if (searchQuery.trim().length > 0) {
          const kwResults = searchSemanticNotesRanked(db, searchQuery, { maxResults: SMART_CONTEXT_MAX_RESULTS, skipAccessTracking: true, threadId: resolveKnowledgeThreadId(ctx.effectiveThreadId) });
          candidates = kwResults.map(n => ({ type: n.type, content: n.content.slice(0, NOTE_CONTENT_MAX_CHARS), confidence: n.confidence }));
        }
      }

      if (candidates.length > 0) {
        // Take top candidates by similarity — no LLM filter needed.
        // Cosine similarity already provides strong relevance signal.
        const topCandidates = candidates.slice(0, MAX_INJECTED_NOTES);
        const lines = topCandidates.map(c => {
          const simLabel = c.similarity !== undefined ? `, sim: ${c.similarity.toFixed(2)}` : "";
          return `- **[${c.type}]** ${c.content} _(conf: ${c.confidence}${simLabel})_`;
        });
        if (lines.length > 0) {
          autoMemoryContext = `\n\n## Relevant Memory (auto-injected)\n${lines.join("\n")}`;
        }
        log.verbose("memory", `Smart context: ${candidates.length} candidates → ${topCandidates.length} injected`);
      }
    } else if (operatorText.length > MIN_CONTEXT_TEXT_LENGTH) {
      // No API key — keyword search, raw top-3
      const searchQuery = extractSearchKeywords(operatorText);
      if (searchQuery.trim().length > 0) {
        const kwResults = searchSemanticNotesRanked(db, searchQuery, { maxResults: 3, skipAccessTracking: true, threadId: resolveKnowledgeThreadId(ctx.effectiveThreadId) });
        if (kwResults.length > 0) {
          const lines = kwResults.map(n =>
            `- **[${n.type}]** ${n.content.slice(0, NOTE_CONTENT_MAX_CHARS)} _(conf: ${n.confidence})_`
          );
          autoMemoryContext = `\n\n## Relevant Memory (auto-injected)\n${lines.join("\n")}`;
        }
      }
    }
  } catch (err) {
    const msg = `Smart context injection failed: ${err instanceof Error ? err.message : String(err)}`;
    if (process.env.OPENAI_API_KEY) log.warn(msg); else log.debug(msg);
  }

  // ── Persistent context: pinned notes ─────────────────────────────────
  // Pinned notes represent long-term invariants the agent should always
  // have in view. Guardrails/decisions are already in bootstrap and will
  // surface via similarity search when relevant — no need to repeat them.
  try {
    const db = ctx.getMemoryDb();
    const pinned = getPinnedNotes(db, resolveKnowledgeThreadId(ctx.effectiveThreadId ?? 0));
    if (pinned.length > 0) {
      const pinnedLines = pinned.map(p =>
        `- **[pinned/${p.type}]** ${p.content.slice(0, NOTE_CONTENT_MAX_CHARS)} _(conf: ${p.confidence.toFixed(2)})_`
      );
      autoMemoryContext += `\n\n## Persistent Context (always active)\n${pinnedLines.join("\n")}`;
    }
  } catch { /* non-critical */ }

  return autoMemoryContext;
}

// ---------------------------------------------------------------------------
// assembleOperatorResponse
// ---------------------------------------------------------------------------

/**
 * Build the final operator message response: intent classification,
 * reminder selection, and the `<<< OPERATOR MESSAGE >>>` envelope.
 */
export function assembleOperatorResponse(
  contentBlocks: ContentBlock[],
  operatorText: string,
  hasVoiceMessages: boolean,
  autoMemoryContext: string,
  ctx: Pick<MessageDeliveryContext, "effectiveThreadId" | "sessionStartedAt" | "autonomousMode">,
  intent?: MessageIntent,
): ToolResult {
  const resolvedIntent = intent ?? classifyIntent(operatorText);
  log.verbose("intent", `Classified "${operatorText.substring(0, 50)}" as ${resolvedIntent}`);

  const reminder = resolvedIntent === "conversational"
    ? getMediumReminder(ctx.effectiveThreadId, ctx.sessionStartedAt, ctx.autonomousMode)
    : getReminders(ctx.effectiveThreadId, ctx.sessionStartedAt, ctx.autonomousMode);

  const directive = "Follow the operator's instructions below."
    + "\nIMPORTANT: The operator cannot see your stdout. To reply, use `report_progress`, `send_voice`, or `send_message_to_thread` — never print a response directly.";

  return {
    content: [
      {
        type: "text",
        text: directive,
      },
      { type: "text", text: "<<< OPERATOR MESSAGE >>>" },
      ...contentBlocks,
      ...(hasVoiceMessages
        ? [{
          type: "text" as const,
          text: "(Operator sent voice — respond with `send_voice`.)",
        }]
        : []),
      { type: "text", text: reminder },
      { type: "text", text: "<<< END OPERATOR MESSAGE >>>" },
      ...(autoMemoryContext
        ? [{ type: "text" as const, text: autoMemoryContext }]
        : []),
    ],
  };
}
