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

interface ReactionContext {
  telegram: TelegramClient;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  effectiveThreadId: number | undefined;
  sessionStartedAt: number;
}

/** Data returned by the shared `consumeReaction` helper. */
interface ConsumedReaction {
  emoji: string;
  messageId: number;
  date: number;
  snippet: string | undefined;
  reactionNote: string;
}

// ---------------------------------------------------------------------------
// Shared helper — consumes the pending reaction and builds episode data
// ---------------------------------------------------------------------------

/**
 * Read and consume the pending reaction for the given context.
 * Returns the parsed reaction data, or `null` if nothing was pending.
 *
 * Side-effects: clears `ctx.telegram.lastReaction` and persists an
 * `operator_reaction` episode when a thread is active.
 */
function consumeReaction(ctx: ReactionContext): ConsumedReaction | null {
  // Only fall back to the global in-memory lastReaction when there is no
  // thread context. With a thread ID, readPendingReaction already checks
  // per-thread and guarded-global files — falling back to the unscoped
  // lastReaction would let the wrong thread consume someone else's reaction.
  const pending = ctx.effectiveThreadId !== undefined
    ? readPendingReaction(ctx.effectiveThreadId)
    : (readPendingReaction() ?? ctx.telegram.lastReaction);
  if (!pending) return null;

  const emoji = "emoji" in pending ? pending.emoji : "";
  const messageId = "messageId" in pending ? pending.messageId : 0;
  const date = "date" in pending ? pending.date : 0;

  if (!emoji) return null;

  // Clear in-memory reaction after consumption
  ctx.telegram.lastReaction = null;

  const snippet = ctx.telegram.lookupSentMessage(messageId);
  const reactionNote = snippet
    ? `(The operator reacted with ${emoji} to your message: '${snippet}')`
    : `(The operator reacted with ${emoji} to message #${messageId})`;

  // Persist episode
  try {
    const db = ctx.getMemoryDb();
    const sessionId = `session_${ctx.sessionStartedAt}`;
    if (ctx.effectiveThreadId !== undefined) {
      saveEpisode(db, {
        sessionId,
        threadId: ctx.effectiveThreadId,
        type: "operator_reaction",
        modality: "reaction",
        content: { emoji, messageId, date },
        importance: 0.3,
      });
    }
  } catch (err) {
    log.warn(`[reaction-handler] Failed to save reaction episode: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { emoji, messageId, date, snippet: snippet ?? undefined, reactionNote };
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
  const reaction = consumeReaction(ctx);
  if (!reaction) return;

  const { reactionNote } = reaction;

  // Inline the reaction with the last text block if messages exist,
  // otherwise add it as a standalone block.
  const lastTextIdx = contentBlocks.map(b => b.type).lastIndexOf("text");
  if (lastTextIdx >= 0) {
    const prev = contentBlocks[lastTextIdx] as TextBlock;
    prev.text = `${prev.text}\n${reactionNote}`;
  } else {
    contentBlocks.push({ type: "text", text: reactionNote });
  }
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
  const reaction = consumeReaction(ctx);
  if (!reaction) return null;

  const { emoji, messageId, reactionNote } = reaction;

  log.info(`[wait] Reaction-only wake-up: ${emoji} on message ${messageId}`);

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
