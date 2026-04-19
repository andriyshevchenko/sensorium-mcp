/**
 * Telegram getUpdates polling loop.
 *
 * One MCP instance is elected as the poller via the file lock. It calls
 * getUpdates and distributes incoming messages to per-thread JSONL files
 * through the broker. All other instances are consumers only.
 */

import { existsSync } from "node:fs";
import { log } from "../../logger.js";
import type { TelegramClient } from "../../telegram.js";
import { errorMessage } from "../../utils.js";
import {
    appendToThread,
    ensureDirs,
    OFFSET_FILE,
    readOffset,
    resolveThreadForTopic,
    writeOffset,
    writeReactionFile,
} from "./broker.js";

// ── Slash command expansion ────────────────────────────────────────────
const SLASH_COMMANDS: Array<{ pattern: RegExp; expand: (m: RegExpMatchArray) => string }> = [
  {
    // /skill "Plan mode" or /skill Plan mode
    pattern: /^\/skill\s+["']?(.+?)["']?\s*$/i,
    expand: (m) => `Load the "${m[1]}" skill via get_skill and follow it.`,
  },
  {
    // /recall Wednesday 2:15-2:43pm → time-range memory search
    pattern: /^\/recall\s+(.+)$/i,
    expand: (m) => `Search memory for what we discussed during: ${m[1]}. Use memory_search with appropriate startTime and endTime parameters to find episodes from that period. Summarize what was discussed.`,
  },
  {
    // /health → check thread health
    pattern: /^\/health\s*$/i,
    expand: () => `Check the health of all threads using get_threads_health and report any issues.`,
  },
  {
    // /status → brief status of current work
    pattern: /^\/status\s*$/i,
    expand: () => `Give a brief status of what you're currently working on and any pending tasks.`,
  },
];

// ── /mode command: handled specially (side-effect + expansion) ──────────
import { setThreadConversationMode, type ConversationMode } from "../../config.js";
const MODE_PATTERN = /^\/mode\s+(concise|voice)\s*$/i;

/** Expand /slash commands in message text. Expands matching lines, preserves the rest. */
function expandSlashCommands(text: string | undefined): string | undefined {
  if (!text) return text;
  const lines = text.split("\n");
  let expanded = false;
  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return line;
    for (const cmd of SLASH_COMMANDS) {
      const m = trimmed.match(cmd.pattern);
      if (m) { expanded = true; return cmd.expand(m); }
    }
    return line;
  });
  return expanded ? result.join("\n") : text;
}
import type { StoredMessage, StoredReaction } from "./broker.js";
import {
    readLock,
    refreshLock,
    removeLock,
    tryAcquireLock,
    tryAcquireLockWithRetry,
} from "./lock.js";
import { registerTopic } from "../../sessions.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_REFRESH_INTERVAL_MS = 15_000;
const ERROR_BACKOFF_MS = 5_000;
const INTER_POLL_DELAY_MS = 500;
const DRAIN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Poller state
// ---------------------------------------------------------------------------

let pollerRunning = false;
let pollAbortController: AbortController | undefined;

// ---------------------------------------------------------------------------
// Single poll cycle
// ---------------------------------------------------------------------------

async function pollOnce(
    telegram: TelegramClient,
    chatId: string,
): Promise<void> {
    if (!refreshLock()) {
        // We lost lock ownership — another process took over. Step down.
        pollerRunning = false;
        return;
    }

    const POLL_TIMEOUT_SECONDS = 10;
    let offset = readOffset();

    // Refresh the lock periodically during long polls / 409 retries
    // to prevent it from going stale (STALE_LOCK_MS = 90 s).
    const lockRefresher = setInterval(() => {
        if (!refreshLock()) {
            pollerRunning = false;
            pollAbortController?.abort();
        }
    }, LOCK_REFRESH_INTERVAL_MS);

    try {
        pollAbortController = new AbortController();
        const updates = await telegram.getUpdates(
            offset, POLL_TIMEOUT_SECONDS, pollAbortController.signal,
        );

        // Refresh again after the (potentially 10-second) long poll returns.
        if (!refreshLock()) {
            pollerRunning = false;
            return;
        }

        if (updates.length === 0) return;

        // Track the highest offset for which ALL messages were successfully written.
        let committedOffset = offset;
        let allSucceeded = true;

        for (const u of updates) {
            // ── Reaction updates ──────────────────────────────────────
            if (u.message_reaction) {
                const emoji = u.message_reaction.new_reaction.find(
                    (r) => r.type === "emoji",
                )?.emoji;
                if (emoji) {
                    const reaction: StoredReaction = {
                        emoji,
                        messageId: u.message_reaction.message_id,
                        chatId: u.message_reaction.chat.id,
                        date: u.message_reaction.date,
                    };
                    telegram.lastReaction = {
                        emoji,
                        messageId: u.message_reaction.message_id,
                        date: u.message_reaction.date,
                    };
                    writeReactionFile(reaction);
                    log.info(
                        `[dispatcher] Reaction ${emoji} on message ${u.message_reaction.message_id}`,
                    );
                }
                committedOffset = u.update_id + 1;
                continue;
            }

            if (!u.message) {
                // Non-message update — skip but still advance past it.
                committedOffset = u.update_id + 1;
                continue;
            }
            if (String(u.message.chat.id) !== chatId) {
                committedOffset = u.update_id + 1;
                continue;
            }

            const m = u.message;

            // Auto-register topics from forum_topic_created service messages
            if (m.forum_topic_created && m.message_thread_id) {
                try {
                    registerTopic(chatId, m.forum_topic_created.name, m.message_thread_id);
                    log.info(`[dispatcher] Auto-registered topic "${m.forum_topic_created.name}" → ${m.message_thread_id}`);
                } catch (e) { log.debug(`[dispatcher] registerTopic failed: ${errorMessage(e)}`); }
            }

            // Handle renamed topics — update topic_registry so messages route correctly
            if (m.forum_topic_edited && m.message_thread_id && m.forum_topic_edited.name) {
                try {
                    registerTopic(chatId, m.forum_topic_edited.name, m.message_thread_id);
                    log.info(`[dispatcher] Topic renamed → "${m.forum_topic_edited.name}" (thread ${m.message_thread_id})`);
                } catch (e) { log.debug(`[dispatcher] topic rename failed: ${errorMessage(e)}`); }
            }

            // Skip Telegram service messages (pinned_message, new_chat_members,
            // etc.) — they have no user content and would be delivered as
            // "unsupported message type" to the agent.
            const hasContent = m.text || m.caption || m.photo || m.document || m.voice || m.video_note || m.sticker || m.animation;
            if (!hasContent) {
                committedOffset = u.update_id + 1;
                continue;
            }

            const rawTopicId = u.message.message_thread_id;
            const threadId: number | "general" =
                rawTopicId != null ? resolveThreadForTopic(rawTopicId) : "general";

            const stored: StoredMessage = {
                update_id: u.update_id,
                message: {
                    message_id: u.message.message_id,
                    chat_id: u.message.chat.id,
                    text: u.message.text,
                    caption: u.message.caption,
                    message_thread_id: u.message.message_thread_id,
                    photo: u.message.photo?.map((p) => ({
                        file_id: p.file_id,
                        width: p.width,
                        height: p.height,
                    })),
                    document: u.message.document ? {
                        file_id: u.message.document.file_id,
                        file_name: u.message.document.file_name,
                        mime_type: u.message.document.mime_type,
                    } : undefined,
                    voice: u.message.voice ? {
                        file_id: u.message.voice.file_id,
                        duration: u.message.voice.duration,
                        mime_type: u.message.voice.mime_type,
                    } : undefined,
                    video_note: u.message.video_note ? {
                        file_id: u.message.video_note.file_id,
                        length: u.message.video_note.length,
                        duration: u.message.video_note.duration,
                    } : undefined,
                    sticker: u.message.sticker ? {
                        file_id: u.message.sticker.file_id,
                        emoji: u.message.sticker.emoji,
                        set_name: u.message.sticker.set_name,
                    } : undefined,
                    animation: u.message.animation ? {
                        file_id: u.message.animation.file_id,
                        duration: u.message.animation.duration,
                        thumbnail: (u.message.animation.thumbnail ?? u.message.animation.thumb)
                            ? { file_id: (u.message.animation.thumbnail ?? u.message.animation.thumb)!.file_id }
                            : undefined,
                    } : undefined,
                    date: u.message.date,
                },
            };

            try {
                // Handle /mode command (side-effect: persists mode to settings)
                if (stored.message.text) {
                  const modeMatch = stored.message.text.trim().match(MODE_PATTERN);
                  if (modeMatch && typeof threadId === "number") {
                    const mode = modeMatch[1].toLowerCase() as ConversationMode;
                    setThreadConversationMode(threadId, mode);
                    stored.message.text = `Conversation mode switched to "${mode}".`;
                  }
                }
                // Expand /slash commands before storing
                stored.message.text = expandSlashCommands(stored.message.text);
                appendToThread(threadId, stored);
                committedOffset = u.update_id + 1;
            } catch (writeErr) {
                log.error(
                    `[dispatcher] Failed to write message ${u.update_id} to thread ${threadId}: ${errorMessage(writeErr)}`,
                );
                allSucceeded = false;
                break; // Stop processing — don't skip messages.
            }
        }

        // Only advance offset to the last successfully written message.
        if (committedOffset > offset) {
            writeOffset(committedOffset);
        }
        if (!allSucceeded) {
            log.warn(
                "[dispatcher] Partial batch write. Will retry remaining messages on next poll.",
            );
        }
    } catch (err) {
        // Ignore abort errors during shutdown.
        if (err instanceof DOMException && err.name === "AbortError") return;
        log.error(
            `[dispatcher] Poll error: ${errorMessage(err)}`,
        );
        throw err;
    } finally {
        pollAbortController = undefined;
        clearInterval(lockRefresher);
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Start the shared dispatcher.
 * - Ensures directories exist.
 * - Attempts to acquire the poller lock.
 * - If acquired, starts a polling loop that writes to per-thread files.
 * - If not acquired, this instance is a consumer only (reads from thread files).
 *
 * Returns: whether this instance became the poller.
 */
export async function startDispatcher(
    telegram: TelegramClient,
    chatId: string,
): Promise<boolean> {
    ensureDirs();
    const isPoller = await tryAcquireLockWithRetry();
    const CONSUMER_RETRY_MS = 10_000;

    // Shared cleanup + loop helpers.
    let cleanupRegistered = false;
    const registerCleanup = () => {
        if (cleanupRegistered) return;
        cleanupRegistered = true;
        const cleanup = () => {
            pollerRunning = false;
            pollAbortController?.abort();
            removeLock();
        };
        process.on("exit", cleanup);
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
    };

    const installConsumerRetry = () => {
        const timer = setInterval(() => {
            if (tryAcquireLock()) {
                clearInterval(timer);
                log.info(
                    "[dispatcher] Promoted to poller (previous poller seems inactive).",
                );
                pollerRunning = true;
                startLoop();
                registerCleanup();
            }
        }, CONSUMER_RETRY_MS);
        timer.unref();
    };

    const startLoop = () => {
        const loop = async () => {
            while (pollerRunning) {
                const currentLock = readLock();
                if (currentLock && currentLock.pid !== process.pid) {
                    log.info(
                        `[dispatcher] Lock taken by PID ${currentLock.pid}. Stepping down to consumer.`,
                    );
                    pollerRunning = false;
                    installConsumerRetry();
                    break;
                }
                try {
                    await pollOnce(telegram, chatId);
                } catch (err) {
                    log.error(
                        `[dispatcher] Unexpected poll error: ${errorMessage(err)}`,
                    );
                    await new Promise<void>((r) => setTimeout(r, ERROR_BACKOFF_MS));
                }
                await new Promise<void>((r) => setTimeout(r, INTER_POLL_DELAY_MS));
            }
        };
        void loop().catch((err) => log.error(`[dispatcher] Poll loop crashed: ${errorMessage(err)}`));
    };

    if (isPoller) {
        log.info("[dispatcher] This instance is the poller.");

        // On first run with no offset file, skip all old updates in one call
        // by fetching the latest update_id and setting the offset past it.
        // Awaited so the poll loop never sees offset=0.
        if (!existsSync(OFFSET_FILE)) {
            log.info(
                "[dispatcher] No offset file. Skipping old updates...\n",
            );
            let drainTimeout: ReturnType<typeof setTimeout> | undefined;
            try {
                // Use a short timeout to prevent blocking startup if another
                // poller is active (409 retry loop could stall for 60+ seconds).
                const drainAbort = new AbortController();
                drainTimeout = setTimeout(() => drainAbort.abort(), DRAIN_TIMEOUT_MS);
                const latest = await telegram.getUpdates(-1, 0, drainAbort.signal);
                if (latest.length > 0) {
                    const skipTo = latest[latest.length - 1].update_id + 1;
                    writeOffset(skipTo);
                    log.info(
                        `[dispatcher] Skipped to offset ${skipTo}.`,
                    );
                } else {
                    writeOffset(0);
                }
            } catch (err) {
                // Don't write offset=0 — leave it at whatever the current value is.
                // If the file still doesn't exist, readOffset() returns 0 which is
                // acceptable because the drain simply failed to optimise.
                log.warn(
                    `[dispatcher] Warning: drain failed: ${errorMessage(err)}. Poll loop will start from offset 0.`,
                );
            } finally {
                if (drainTimeout) clearTimeout(drainTimeout);
            }
        }

        pollerRunning = true;
        startLoop();
        registerCleanup();
    } else {
        log.info(
            "[dispatcher] Another instance is the poller. This instance is a consumer only.",
        );

        // Periodically try to become the poller in case the current one dies
        // but its PID remains alive (zombie process, stuck socket, etc.).
        installConsumerRetry();
    }

    return isPoller;
}
