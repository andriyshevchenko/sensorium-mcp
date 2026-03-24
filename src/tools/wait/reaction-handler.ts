/**
 * Reaction handling logic extracted from wait-tool.ts.
 *
 * Two scenarios:
 *   1. Reaction arrives alongside operator messages → inline into content blocks
 *   2. Reaction arrives with no messages → return standalone reaction envelope
 */

import { readPendingReaction } from "../../dispatcher.js";
import { saveEpisode, type initMemoryDb } from "../../memory.js";
import type { TelegramClient } from "../../telegram.js";
import { log } from "../../logger.js";
import { getMediumReminder } from "../../response-builders.js";
import type { TextBlock, ImageBlock, ToolResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactionContext {
  telegram: TelegramClient;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  effectiveThreadId: number | undefined;
  sessionStartedAt: number;
}

// ---------------------------------------------------------------------------
// handleReactionWithMessages
// ---------------------------------------------------------------------------

/**
 * If a pending operator reaction exists, inline it into the last text block
 * of `contentBlocks` (or append a standalone block) and persist an
 * `operator_reaction` episode. Clears the reaction after delivery.
 *
 * Mutates `contentBlocks` in place.
 */
export async function handleReactionWithMessages(
  contentBlocks: Array<TextBlock | ImageBlock>,
  ctx: ReactionContext,
): Promise<void> {
  const pendingReaction = readPendingReaction() ?? ctx.telegram.lastReaction;
  if (!pendingReaction) return;

  const emoji = "emoji" in pendingReaction ? pendingReaction.emoji : "";
  const messageId = "messageId" in pendingReaction ? pendingReaction.messageId : 0;
  const reactionDate = "date" in pendingReaction ? pendingReaction.date : 0;

  if (emoji) {
    const snippet = ctx.telegram.lookupSentMessage(messageId);
    const reactionNote = snippet
      ? `(The operator reacted with ${emoji} to your message: '${snippet}')`
      : `(The operator reacted with ${emoji} to message #${messageId})`;

    // Inline the reaction with the last text block if messages exist,
    // otherwise add it as a standalone block.
    const lastTextIdx = contentBlocks.map(b => b.type).lastIndexOf("text");
    if (lastTextIdx >= 0) {
      const prev = contentBlocks[lastTextIdx] as TextBlock;
      prev.text = `${prev.text}\n${reactionNote}`;
    } else {
      contentBlocks.push({ type: "text", text: reactionNote });
    }

    // Save reaction as episodic memory
    try {
      const db = ctx.getMemoryDb();
      const sessionId = `session_${ctx.sessionStartedAt}`;
      if (ctx.effectiveThreadId !== undefined) {
        saveEpisode(db, {
          sessionId,
          threadId: ctx.effectiveThreadId,
          type: "operator_reaction",
          modality: "reaction",
          content: { emoji, messageId, date: reactionDate },
          importance: 0.3,
        });
      }
    } catch (_) { /* non-fatal */ }
  }

  // Clear the reaction after delivery
  ctx.telegram.lastReaction = null;
}

// ---------------------------------------------------------------------------
// handleReactionOnly
// ---------------------------------------------------------------------------

/**
 * If no text messages arrived but a pending reaction exists, build a
 * standalone `<<< OPERATOR REACTION >>>` envelope and save the episode.
 *
 * Returns a `ToolResult` when a reaction was consumed, or `null` if none
 * was pending.
 */
export async function handleReactionOnly(
  ctx: ReactionContext & { autonomousMode: boolean },
): Promise<ToolResult | null> {
  const pendingReactionOnly = readPendingReaction() ?? ctx.telegram.lastReaction;
  if (!pendingReactionOnly) return null;

  const rEmoji = "emoji" in pendingReactionOnly ? pendingReactionOnly.emoji : "";
  const rMsgId = "messageId" in pendingReactionOnly ? pendingReactionOnly.messageId : 0;
  const rDate = "date" in pendingReactionOnly ? pendingReactionOnly.date : 0;

  if (!rEmoji) return null;

  // Clear in-memory reaction after consumption
  ctx.telegram.lastReaction = null;

  const snippet = ctx.telegram.lookupSentMessage(rMsgId);
  const reactionNote = snippet
    ? `(The operator reacted with ${rEmoji} to your message: '${snippet}')`
    : `(The operator reacted with ${rEmoji} to message #${rMsgId})`;

  // Save reaction as episodic memory
  try {
    const db = ctx.getMemoryDb();
    const sessionId = `session_${ctx.sessionStartedAt}`;
    if (ctx.effectiveThreadId !== undefined) {
      saveEpisode(db, {
        sessionId,
        threadId: ctx.effectiveThreadId,
        type: "operator_reaction",
        modality: "reaction",
        content: { emoji: rEmoji, messageId: rMsgId, date: rDate },
        importance: 0.3,
      });
    }
  } catch (_) { /* non-fatal */ }

  log.info(`[wait] Reaction-only wake-up: ${rEmoji} on message ${rMsgId}`);

  return {
    content: [
      { type: "text", text: "<<< OPERATOR REACTION >>>" },
      { type: "text", text: reactionNote },
      {
        type: "text",
        text:
          "The operator reacted to your message without sending a text reply. " +
          "This may be a confirmation, approval, or acknowledgment. " +
          "Reflect on what your last message said and whether this reaction is a call to action " +
          "(e.g., proceed with a plan, continue what you were doing, etc.). " +
          "If no action is needed, call `remote_copilot_wait_for_instructions` to resume waiting.",
      },
      { type: "text", text: "<<< END OPERATOR REACTION >>>" },
      {
        type: "text",
        text: getMediumReminder(ctx.effectiveThreadId, ctx.sessionStartedAt, ctx.autonomousMode),
      },
    ],
  };
}
