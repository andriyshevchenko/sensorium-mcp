/**
 * Drive activation and auto-consolidation logic extracted from wait-tool.ts.
 *
 * Contains:
 *   - runAutoConsolidation(): 3 strategies (idle, episode-count, time-based)
 *   - checkDriveActivation(): 3-phase autonomous drive (phase 1/2/3)
 */

import { formatDrivePrompt, PHASE3_APPROVAL_PROMPT } from "../../drive.js";
import { log } from "../../logger.js";
import { runIntelligentConsolidation, runReflection, type initMemoryDb } from "../../memory.js";
import { getReminders } from "../../response-builders.js";
import { backfillEmbeddings } from "../memory-tools.js";
import type { ToolResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DriveContext {
  state: {
    lastOperatorMessageAt: number;
    lastConsolidationAt: number;
    lastDriveAttemptAt: number;
    drivePhase2Fired: boolean;
    sessionStartedAt: number;
  };
  effectiveThreadId: number | undefined;
  getMemoryDb: () => ReturnType<typeof initMemoryDb>;
  /** OpenAI API key from config (used for embedding backfill). */
  apiKey: string | undefined;
  config: {
    DMN_ACTIVATION_HOURS: number;
    AUTONOMOUS_MODE: boolean;
  };
  /** Pre-computed memory refresh text (may be empty). */
  memoryRefresh: string;
  /** Pre-computed schedule hint text (may be empty). */
  scheduleHint: string;
}

const EPISODE_COUNT_CONSOLIDATION_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// Auto-consolidation (3 strategies)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget helper: runs intelligent consolidation + embedding backfill.
 * Logs results under the given `label` (e.g. "Idle-based", "Episode-count").
 */
function fireConsolidation(
  db: ReturnType<typeof initMemoryDb>,
  threadId: number,
  label: string,
  apiKey?: string,
): void {
  void runIntelligentConsolidation(db, threadId)
    .then(async (report) => {
      if (report.episodesProcessed > 0) {
        log.info(
          `[memory] ${label} consolidation: ${report.episodesProcessed} episodes \u2192 ${report.notesCreated} notes`,
        );
      }
      await backfillEmbeddings(db, apiKey);

      // Run reflection after consolidation if enough episodes exist
      if (report.episodesProcessed > 0) {
        try {
          const reflectionResult = await runReflection(db, threadId);
          if (reflectionResult.insights.length > 0) {
            log.info(
              `[memory] ${label} reflection: ${reflectionResult.processedEpisodeCount} episodes → ${reflectionResult.insights.length} insights`,
            );
          }
        } catch (reflErr) {
          log.warn(
            `[memory] Reflection failed (non-fatal): ${reflErr instanceof Error ? reflErr.message : String(reflErr)}`,
          );
        }
      }
    })
    .catch((err) => {
      log.error(
        `[memory] ${label} consolidation error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/**
 * Checks three consolidation strategies and fires runIntelligentConsolidation
 * + backfillEmbeddings as fire-and-forget when conditions are met.
 *
 * Strategies:
 *   1. Idle-based  — 15 min idle, 30 min cooldown
 *   2. Episode-count — ≥15 unconsolidated episodes, 30 min cooldown
 *   3. Time-based  — every 4 hours regardless
 */
export function runAutoConsolidation(ctx: DriveContext): void {
  const { state, effectiveThreadId, getMemoryDb, apiKey } = ctx;

  // Strategy 1: Idle-based consolidation
  try {
    const idleMs = Date.now() - state.lastOperatorMessageAt;
    if (idleMs > 15 * 60 * 1000 && effectiveThreadId !== undefined && Date.now() - state.lastConsolidationAt > 30 * 60 * 1000) {
      state.lastConsolidationAt = Date.now();
      fireConsolidation(getMemoryDb(), effectiveThreadId, "Idle-based", apiKey);
    }
  } catch (err) { log.debug(`[memory] Consolidation check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`); }

  // Strategy 2: Episode-count consolidation — don't wait for idle.
  // If many episodes accumulated during active use, consolidate now.
  // This prevents stale/contradictory knowledge from persisting.
  try {
    if (effectiveThreadId !== undefined && Date.now() - state.lastConsolidationAt > 30 * 60 * 1000) {
      const db = getMemoryDb();
      const uncons = db.prepare("SELECT COUNT(*) as c FROM episodes WHERE consolidated = 0 AND thread_id = ?").get(effectiveThreadId) as { c: number };
      if (uncons.c >= EPISODE_COUNT_CONSOLIDATION_THRESHOLD) {
        state.lastConsolidationAt = Date.now();
        fireConsolidation(db, effectiveThreadId, "Episode-count", apiKey);
      }
    }
  } catch (err) { log.debug(`[memory] Consolidation check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`); }

  // Strategy 3: Time-based consolidation — every 4 hours regardless.
  // Ensures stale knowledge gets cleaned up even during low-activity periods.
  try {
    const TIME_CONSOLIDATION_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
    if (effectiveThreadId !== undefined && Date.now() - state.lastConsolidationAt > TIME_CONSOLIDATION_INTERVAL) {
      state.lastConsolidationAt = Date.now();
      const db = getMemoryDb();
      log.info(`[memory] Time-based consolidation triggered (4h since last)`);
      fireConsolidation(db, effectiveThreadId, "Time-based", apiKey);
    }
  } catch (err) { log.debug(`[memory] Consolidation check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`); }
}

// ---------------------------------------------------------------------------
// 3-Phase Autonomous Drive
// ---------------------------------------------------------------------------

const DRIVE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between probability rolls

/**
 * Checks and handles the 3-phase autonomous drive logic.
 *
 * - Phase 3: If `drivePhase2Fired` → return PHASE3_APPROVAL_PROMPT
 * - Phase 1+2: If idle > threshold and cooldown elapsed → formatDrivePrompt()
 *              → if activated, set drivePhase2Fired=true, return drive prompt
 *
 * Returns a ToolResult if drive activated, or null if nothing to do.
 */
export function checkDriveActivation(ctx: DriveContext): ToolResult | null {
  const { state, effectiveThreadId, config, memoryRefresh, scheduleHint } = ctx;
  const DRIVE_ACTIVATION_MS = config.DMN_ACTIVATION_HOURS * 60 * 60 * 1000;
  const idleMs = Date.now() - state.lastOperatorMessageAt;

  // Phase 3: If Phase 2 just fired and the agent came back without engaging
  if (state.drivePhase2Fired) {
    state.drivePhase2Fired = false; // Reset — only approve once
    return {
      content: [
        {
          type: "text",
          text: PHASE3_APPROVAL_PROMPT +
            memoryRefresh +
            scheduleHint +
            getReminders(effectiveThreadId, state.sessionStartedAt, config.AUTONOMOUS_MODE),
        },
      ],
    };
  }

  // Phase 1: Probability gate (only if past threshold and cooldown elapsed)
  if (idleMs >= DRIVE_ACTIVATION_MS && Date.now() - state.lastDriveAttemptAt >= DRIVE_COOLDOWN_MS) {
    state.lastDriveAttemptAt = Date.now();
    const driveResult = formatDrivePrompt(idleMs, config.DMN_ACTIVATION_HOURS);

    if (driveResult.activated && driveResult.prompt) {
      // Phase 2: Intention Elicitation — give the agent full autonomy
      state.drivePhase2Fired = true;
      return {
        content: [
          {
            type: "text",
            text: driveResult.prompt,
          },
          ...(memoryRefresh ? [{ type: "text" as const, text: memoryRefresh.replace(/^\n\n/, "") }] : []),
          { type: "text", text: scheduleHint + getReminders(effectiveThreadId, state.sessionStartedAt, config.AUTONOMOUS_MODE) },
        ],
      };
    }
  }

  return null;
}
