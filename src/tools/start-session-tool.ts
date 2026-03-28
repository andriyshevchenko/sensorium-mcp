/**
 * start_session tool handler extracted from index.ts.
 *
 * Creates or resumes a Telegram forum topic for the current MCP session,
 * bootstraps memory, auto-schedules DMN reflection, and returns the
 * session greeting with reminders.
 */

import { getMemorySourceThreadId } from "../config.js";
import { convertMarkdown } from "../markdown.js";
import { assembleBootstrap, runIntelligentConsolidation, type initMemoryDb } from "../memory.js";
import { addSchedule, generateTaskId, listSchedules, purgeSchedules } from "../scheduler.js";
import {
  lookupSession,
  persistSession,
  purgeOtherSessions,
  registerMcpSession,
  removeSession,
  lookupTopicRegistry,
  registerTopic,
} from "../sessions.js";
import type { TelegramClient } from "../telegram.js";
import type { AppConfig, ToolResult } from "../types.js";
import { log } from "../logger.js";
import { errorMessage, errorResult } from "../utils.js";
import { readThreadMessages } from "../dispatcher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartSessionContext {
  /** Mutable per-session state — the handler writes directly into this. */
  session: {
    currentThreadId: number | undefined;
    sessionStartedAt: number;
    waitCallCount: number;
    lastToolCallAt: number;
    toolCallsSinceLastDelivery: number;
    previewedUpdateIds: Set<number>;
    lastOperatorMessageAt: number;
    lastOperatorMessageText: string;
    lastConsolidationAt: number;
  };

  telegram: TelegramClient;
  telegramChatId: string;
  config: AppConfig;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  getReminders: (
    threadId: number | undefined,
    sessionStartedAt: number,
    autonomousMode: boolean,
  ) => string;

  /** MCP session ID for this connection (from transport). */
  getMcpSessionId?: () => string | undefined;
  /** Close the transport — used for session registration. */
  closeTransport?: () => void;
}

/** Consolidation fires at session start when unconsolidated episodes exceed this. */
const STARTUP_CONSOLIDATION_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleStartSession(
  args: Record<string, unknown>,
  ctx: StartSessionContext,
): Promise<ToolResult> {
  const { session, telegram, telegramChatId: TELEGRAM_CHAT_ID, config, getMemoryDb } = ctx;

  session.sessionStartedAt = Date.now();
  const typedArgs = args;
  const rawThreadId = typedArgs.threadId;
  const explicitThreadId = typeof rawThreadId === "number" ? rawThreadId
    : typeof rawThreadId === "string" ? (Number.isFinite(Number(rawThreadId)) ? Number(rawThreadId) : undefined)
    : undefined;
  const customName = typeof typedArgs.name === "string" && typedArgs.name.trim()
    ? typedArgs.name.trim()
    : undefined;

  // When creating a new session (no threadId), name is mandatory.
  if (explicitThreadId === undefined && !customName) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: sessionName is required when creating a new session. Provide a descriptive name for the session.",
        },
      ],
      isError: true,
    };
  }

  // Determine the thread to use:
  // 1. Explicit threadId beats everything.
  // 2. A known name looks up the persisted mapping — resume if found.
  // 3. Otherwise create a new topic.
  let resolvedPreexisting = false;
  let startupNotificationSent = false;

  if (explicitThreadId !== undefined) {
    session.currentThreadId = explicitThreadId;
    // If a name was also supplied, keep the mapping up to date.
    if (customName) persistSession(TELEGRAM_CHAT_ID, customName, explicitThreadId);
    resolvedPreexisting = true;
  } else if (customName !== undefined) {
    const stored = lookupSession(TELEGRAM_CHAT_ID, customName);
    if (stored !== undefined) {
      session.currentThreadId = stored;
      resolvedPreexisting = true;
    } else {
      // Fallback: check the operator-managed topic registry
      const registryId = lookupTopicRegistry(TELEGRAM_CHAT_ID, customName);
      if (registryId !== undefined) {
        session.currentThreadId = registryId;
        // Promote to session store for future fast lookups
        persistSession(TELEGRAM_CHAT_ID, customName, registryId);
        resolvedPreexisting = true;
      }
    }
  }

  if (resolvedPreexisting) {
    // Drain any stale messages from the thread file so they aren't
    // re-delivered in the next wait_for_instructions call.
    const stale = readThreadMessages(session.currentThreadId);
    if (stale.length > 0) {
      log.info(
        `[start_session] Drained ${stale.length} stale message(s) from thread ${session.currentThreadId}.`,
      );
      // Notify the operator that stale messages were discarded.
      try {
        const notice = convertMarkdown(
          `\u26A0\uFE0F **${stale.length} message(s) from before the session resumed were discarded.** ` +
          `If you sent instructions while the agent was offline, please resend them.`,
        );
        await telegram.sendMessage(TELEGRAM_CHAT_ID, notice, "MarkdownV2", session.currentThreadId);
      } catch { /* non-fatal */ }
    }

    // Resume mode: verify the thread is still alive by sending a message.
    // If the topic was deleted, drop the cached mapping and fall through to
    // create a new topic.
    try {
      // Use plain text for probe — avoids MarkdownV2 parsing failures being mistaken for dead threads
      await telegram.sendMessage(TELEGRAM_CHAT_ID, "\u{1F504} Session resumed. Continuing in this thread.", undefined, session.currentThreadId);
      startupNotificationSent = true;
    } catch (err) {
      const errMsg = errorMessage(err);
      log.warn(
        `[start_session] Probe failed for thread ${session.currentThreadId} in chat ${TELEGRAM_CHAT_ID}: ${errMsg}`,
      );
      // Telegram returns "Bad Request: message thread not found" or
      // "Bad Request: the topic was closed" for deleted/closed topics.
      const isThreadGone = /thread not found|topic.*(closed|deleted|not found)/i.test(errMsg);
      if (isThreadGone) {
        log.info(
          `[start_session] Cached thread ${session.currentThreadId} is gone (${errMsg}). Creating new topic.`,
        );
        // Drop the stale mapping and purge any scheduled tasks.
        if (session.currentThreadId !== undefined) purgeSchedules(session.currentThreadId);
        if (customName) removeSession(TELEGRAM_CHAT_ID, customName);
        resolvedPreexisting = false;
        session.currentThreadId = undefined;
      }
      // Other errors (network, etc.) are non-fatal — proceed anyway.
    }
  }

  if (!resolvedPreexisting) {
    // New session: create a dedicated forum topic.
    const topicName = customName ??
      `Copilot — ${new Date().toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
      })}`;
    try {
      const topic = await telegram.createForumTopic(TELEGRAM_CHAT_ID, topicName);
      session.currentThreadId = topic.message_thread_id;
      // Persist so the same name resumes this thread next time.
      persistSession(TELEGRAM_CHAT_ID, topicName, session.currentThreadId);
      registerTopic(TELEGRAM_CHAT_ID, topicName, session.currentThreadId);
    } catch (err) {
      // Forum topics not available (e.g. plain group or DM) — cannot proceed
      // without thread isolation. Return an error so the agent knows.
      return errorResult(
        `Error: Could not create forum topic: ${errorMessage(err)}. ` +
        "Ensure the Telegram chat is a forum supergroup with the bot as admin with can_manage_topics right.",
      );
    }
    try {
      const greeting = convertMarkdown(
        "# 🤖 Remote Copilot Ready\n\n" +
        "Your AI assistant is online and listening.\n\n" +
        "**Send your instructions** and I'll get to work — " +
        "I'll keep you posted on progress as I go.",
      );
      await telegram.sendMessage(TELEGRAM_CHAT_ID, greeting, "MarkdownV2", session.currentThreadId);
      startupNotificationSent = true;
    } catch {
      // Non-fatal.
    }
  }

  // Fallback: if no notification was successfully sent to Telegram (e.g. network
  // error during probe or greeting), send a lightweight "alive" message so the
  // operator has visibility that the session is running.
  if (!startupNotificationSent && session.currentThreadId !== undefined) {
    try {
      await telegram.sendMessage(
        TELEGRAM_CHAT_ID,
        "\u2705 Session active.",
        undefined,
        session.currentThreadId,
      );
    } catch { /* best-effort */ }
  }

  const threadNote = session.currentThreadId !== undefined
    ? ` Thread ID: ${session.currentThreadId} (pass this to start_session as threadId to resume this topic later).`
    : "";

  // Auto-bootstrap memory
  // Ghost threads: use the parent's thread ID for the initial memory briefing
  const memorySourceThreadId = getMemorySourceThreadId();
  let memoryBriefing = "";
  try {
    const db = getMemoryDb();
    if (session.currentThreadId !== undefined) {
      memoryBriefing = "\n\n" + assembleBootstrap(db, session.currentThreadId, memorySourceThreadId);
    }
  } catch (e) {
    log.warn(`[start_session] Memory bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
    memoryBriefing = "\n\n_Memory system unavailable._";
  }

  // ── Startup consolidation: catch up if episodes piled up between sessions ──
  try {
    if (session.currentThreadId !== undefined) {
      const db = getMemoryDb();
      const effectiveThreadId = memorySourceThreadId ?? session.currentThreadId;
      const uncons = db.prepare(
        "SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0 AND thread_id = ?",
      ).get(effectiveThreadId) as { c: number };
      if (uncons.c > STARTUP_CONSOLIDATION_THRESHOLD) {
        log.info(`[start_session] Startup consolidation triggered: ${uncons.c} unconsolidated episodes`);
        session.lastConsolidationAt = Date.now();
        void runIntelligentConsolidation(db, effectiveThreadId)
          .then((report) => {
            if (report.episodesProcessed > 0) {
              log.info(
                `[memory] Startup consolidation: ${report.episodesProcessed} episodes \u2192 ${report.notesCreated} notes`,
              );
            }
          })
          .catch((err) => {
            log.error(
              `[memory] Startup consolidation error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }
  } catch (err) {
    log.debug(`[memory] Startup consolidation check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Purge stale MCP sessions for this thread (from before a server restart)
  // and register the current session.
  if (session.currentThreadId !== undefined) {
    const sid = ctx.getMcpSessionId?.();
    const purged = purgeOtherSessions(session.currentThreadId, sid);
    if (purged > 0) {
      log.info(`[start_session] Purged ${purged} stale MCP session(s) for thread ${session.currentThreadId}.`);
    }
    if (sid && ctx.closeTransport) {
      registerMcpSession(session.currentThreadId, sid, ctx.closeTransport);
    }
  }

  // Auto-schedule DMN reflection task if not already present.
  // This fires after 4 hours of operator silence, delivering a
  // first-person introspection prompt sourced from memory.
  // Only create on active thread — purge stale DMN tasks from other threads
  // to avoid every thread accumulating reflection tasks.
  if (config.AUTONOMOUS_MODE && session.currentThreadId !== undefined) {
    const existingTasks = listSchedules(session.currentThreadId);
    const hasDmn = existingTasks.some(t => t.label === "dmn-reflection");
    if (!hasDmn) {
      addSchedule({
        id: generateTaskId(),
        threadId: session.currentThreadId,
        prompt: "__DMN__", // Sentinel — handler generates dynamic content
        label: "dmn-reflection",
        afterIdleMinutes: 240, // 4 hours
        oneShot: false,
        createdAt: new Date().toISOString(),
      });
      log.info(`[start_session] Auto-scheduled DMN reflection task for thread ${session.currentThreadId}.`);
    }
  }

  const resumeNote = resolvedPreexisting
    ? " Do NOT send a voice greeting or 'back online' message — the text notification in Telegram is sufficient."
    : "";

  const threadId = session.currentThreadId;
  const reminders = ctx.getReminders(threadId, session.sessionStartedAt, config.AUTONOMOUS_MODE);
  const endDirective =
    `\n\n**⚠️ ACTION REQUIRED: Call the \`remote_copilot_wait_for_instructions\` tool NOW with threadId=${threadId}. Do NOT stop or end your turn.**`;

  return {
    content: [
      {
        type: "text",
        text:
          `Session ${resolvedPreexisting ? "resumed" : "started"}.${threadNote}` +
          ` Call the remote_copilot_wait_for_instructions tool next.${resumeNote}` +
          memoryBriefing +
          reminders +
          endDirective,
      },
    ],
  };
}
