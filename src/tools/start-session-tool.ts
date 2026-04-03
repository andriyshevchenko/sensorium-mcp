/**
 * start_session tool handler extracted from index.ts.
 *
 * Creates or resumes a Telegram forum topic for the current MCP session,
 * bootstraps memory, auto-schedules DMN reflection, and returns the
 * session greeting with reminders.
 */

import { getMemorySourceThreadId, setThreadAgentType, type AgentType } from "../config.js";
import { convertMarkdown } from "../markdown.js";
import { assembleBootstrap, runConsolidationAllThreads, type initMemoryDb } from "../memory.js";
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
import { updateThread } from "../data/memory/thread-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartSessionContext {
  /** Mutable per-session state — the handler writes directly into this. */
  session: {
    currentThreadId: number | undefined;
    sessionStartedAt: number;
    /** True once the full bootstrap (memory briefing, schedule setup, etc.) has run in THIS process. */
    sessionFullyInitialized: boolean;
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

  const typedArgs = args;
  const rawThreadId = typedArgs.threadId;
  const explicitThreadId = typeof rawThreadId === "number" ? rawThreadId
    : typeof rawThreadId === "string" ? (Number.isFinite(Number(rawThreadId)) ? Number(rawThreadId) : undefined)
    : undefined;
  const customName = typeof typedArgs.name === "string" && typedArgs.name.trim()
    ? typedArgs.name.trim()
    : undefined;
  const rawAgentType = typeof typedArgs.agentType === "string" ? typedArgs.agentType.trim() : "";
  const agentType: AgentType | undefined =
    rawAgentType === "copilot" || rawAgentType === "copilot_claude" || rawAgentType === "copilot_codex"
    || rawAgentType === "claude" || rawAgentType === "cursor"
    || rawAgentType === "codex" || rawAgentType === "openai_codex"
      ? rawAgentType
      : undefined;

  // ── Re-entry guard ────────────────────────────────────────────────────
  // If the requested thread is already the active session AND the full
  // bootstrap already ran in THIS process lifetime, return early without
  // reinitializing state — reinitialization disrupts the polling loop.
  // After a server restart, sessionFullyInitialized is false even though
  // currentThreadId may already match (restored from the session store),
  // so we always run the full bootstrap on a fresh process.
  if (
    session.sessionFullyInitialized &&
    explicitThreadId !== undefined &&
    explicitThreadId === session.currentThreadId
  ) {
    log.info(
      `[start_session] Thread ${explicitThreadId} is already the active session — skipping reinitialization.`,
    );
    // Include reminders + wait directive so the agent doesn't stall after
    // a duplicate start_session call (e.g. post-update context replay).
    const reminders = ctx.getReminders(explicitThreadId, session.sessionStartedAt, config.AUTONOMOUS_MODE);
    const endDirective =
      `\n\n**⚠️ ACTION REQUIRED: Call the \`remote_copilot_wait_for_instructions\` tool NOW with threadId=${explicitThreadId}. Do NOT stop or end your turn.**`;
    return {
      content: [
        {
          type: "text" as const,
          text: `Session already active on thread ${explicitThreadId}. No reinitialization needed.` +
            ` Call the remote_copilot_wait_for_instructions tool next.` +
            reminders +
            endDirective,
        },
      ],
    };
  }

  session.sessionStartedAt = Date.now();

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
          `[start_session] Cached thread ${session.currentThreadId} is gone (${errMsg}). Creating replacement topic.`,
        );
        // Create a replacement topic and remap — keeps the logical threadId intact
        // so memory, schedules, and keep-alive config are preserved.
        const topicName = customName ??
          `Copilot \u2014 ${new Date().toLocaleString("en-GB", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false,
          })}`;
        try {
          const newTopic = await telegram.createForumTopic(TELEGRAM_CHAT_ID, topicName);
          const newTopicId = newTopic.message_thread_id;
          log.info(
            `[start_session] Remapped thread ${session.currentThreadId} → Telegram topic ${newTopicId}`,
          );
          // Persist the mapping so future Telegram API calls resolve correctly
          try {
            updateThread(getMemoryDb(), session.currentThreadId!, { telegramTopicId: newTopicId });
          } catch (e) {
            log.warn(`[start_session] Failed to persist topic remap: ${e instanceof Error ? e.message : String(e)}`);
          }
          // Update session store so name-based lookups still find this thread
          if (customName) persistSession(TELEGRAM_CHAT_ID, topicName, session.currentThreadId!);
          registerTopic(TELEGRAM_CHAT_ID, topicName, session.currentThreadId!);
          startupNotificationSent = true;
        } catch (createErr) {
          log.warn(`[start_session] Remap failed, falling back to new session: ${errorMessage(createErr)}`);
          // Drop the stale mapping and purge any scheduled tasks.
          if (session.currentThreadId !== undefined) purgeSchedules(session.currentThreadId);
          if (customName) removeSession(TELEGRAM_CHAT_ID, customName);
          resolvedPreexisting = false;
          session.currentThreadId = undefined;
        }
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
  // Consolidates ALL threads (not just the active one) so stale episodes from
  // other threads don't accumulate indefinitely.
  try {
    if (session.currentThreadId !== undefined) {
      const db = getMemoryDb();
      const uncons = db.prepare(
        "SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0",
      ).get() as { c: number };
      if (uncons.c > STARTUP_CONSOLIDATION_THRESHOLD) {
        log.info(`[start_session] Startup consolidation triggered: ${uncons.c} unconsolidated episodes across all threads`);
        session.lastConsolidationAt = Date.now();
        void runConsolidationAllThreads(db)
          .then((report) => {
            if (report.episodesProcessed > 0) {
              log.info(
                `[memory] Startup consolidation: ${report.episodesProcessed} episodes \u2192 ${report.notesCreated} notes (${report.details.length} threads)`,
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
  // Set per-thread agent type if declared — determines agent-specific reminders
  if (threadId !== undefined && agentType) {
    setThreadAgentType(threadId, agentType);
    // Sync agent type to the thread_registry DB
    try { updateThread(getMemoryDb(), threadId, { client: agentType }); } catch { /* best-effort */ }
  }
  const reminders = ctx.getReminders(threadId, session.sessionStartedAt, config.AUTONOMOUS_MODE);
  // Mark session as fully initialized — subsequent start_session calls with
  // the same threadId will hit the re-entry guard instead of re-bootstrapping.
  session.sessionFullyInitialized = true;

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
