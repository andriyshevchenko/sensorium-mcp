/**
 * Daily Session Rotation
 *
 * Manages automatic daily rotation of agent sessions for root threads.
 * The rotation: consolidate → reset session timestamp → restart keeper.
 * The Telegram topic stays the same — only the LLM context refreshes.
 *
 * The `session_reset_at` column on thread_registry tracks the boundary.
 * Bootstrap uses it to filter the message buffer to today's messages only.
 */

import { log } from "./logger.js";
import {
  getRootThreads,
  getThread,
  resetDailySession,
} from "./data/memory/thread-registry.js";
import { runIntelligentConsolidation } from "./data/memory/consolidation.js";
import { runNarrativeGeneration } from "./data/memory/narrative.js";
import { runReflection } from "./data/memory/reflection.js";
import { initMemoryDb } from "./data/memory/schema.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DailyRotationResult {
  rootThreadId: number;
  previousSessionResetAt: string | null;
  newSessionResetAt: string;
  consolidated: boolean;
  error?: string;
}

// ─── Single-thread rotation ──────────────────────────────────────────────────

/**
 * Rotate a single root thread's daily session.
 * 1. Run consolidation (distill episodes into knowledge)
 * 2. Run reflection + narrative generation (best-effort)
 * 3. Update session_reset_at on the thread_registry row
 */
export async function rotateDailySession(
  rootThreadId: number,
): Promise<DailyRotationResult> {
  const db = initMemoryDb();
  const now = new Date().toISOString();
  const result: DailyRotationResult = {
    rootThreadId,
    previousSessionResetAt: null,
    newSessionResetAt: now,
    consolidated: false,
  };

  try {
    // Capture current session_reset_at before overwriting
    const thread = getThread(db, rootThreadId);
    if (!thread) {
      result.error = `Thread ${rootThreadId} not found`;
      log.error(result.error);
      return result;
    }
    result.previousSessionResetAt = thread.sessionResetAt;

    // 1. Run consolidation on the root thread (distill episodes into knowledge)
    try {
      await runIntelligentConsolidation(db, rootThreadId);
      result.consolidated = true;
      log.info(`Consolidation completed for root ${rootThreadId}`);
    } catch (err) {
      log.error(`Consolidation failed during daily rotation: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Run reflection and narrative generation (best-effort, non-blocking)
    try {
      await runReflection(db, rootThreadId);
    } catch (err) {
      log.warn(`Reflection failed during daily rotation for root ${rootThreadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await runNarrativeGeneration(db, rootThreadId);
    } catch (err) {
      log.warn(`Narrative generation failed during daily rotation for root ${rootThreadId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Reset the daily session timestamp (only if consolidation succeeded)
    if (result.consolidated) {
      resetDailySession(db, rootThreadId);
      result.newSessionResetAt = new Date().toISOString();
      log.info(`Daily session reset for root ${rootThreadId} at ${result.newSessionResetAt}`);
    }

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.error(`Daily rotation failed for root ${rootThreadId}: ${result.error}`);
  }

  return result;
}

// ─── Rotate all ──────────────────────────────────────────────────────────────

let _rotating = false;
let _lastRotationDate: string | null = null;

/**
 * Check and rotate all root threads that have keepAlive enabled.
 * Called from the watcher service on a schedule (e.g., 4 AM daily).
 */
export async function rotateAllDailySessions(): Promise<DailyRotationResult[]> {
  const todayDate = new Date().toISOString().slice(0, 10);

  // Prevent running twice in the same day
  if (_lastRotationDate === todayDate) {
    log.info(`Daily rotation already completed for ${todayDate}, skipping`);
    return [];
  }

  // Concurrency guard — prevent overlapping executions
  if (_rotating) {
    log.warn("rotateAllDailySessions already in progress, skipping");
    return [];
  }
  _rotating = true;

  try {
  const db = initMemoryDb();
  const roots = getRootThreads(db);
  const results: DailyRotationResult[] = [];

  for (const root of roots) {
    if (!root.keepAlive) continue;

    // Skip if already rotated today
    if (root.sessionResetAt) {
      const resetDate = root.sessionResetAt.slice(0, 10);
      const todayDate = new Date().toISOString().slice(0, 10);
      if (resetDate === todayDate) {
        log.info(`Root ${root.threadId} already rotated today, skipping`);
        continue;
      }
    }

    const result = await rotateDailySession(root.threadId);
    results.push(result);
  }

  _lastRotationDate = todayDate;
  return results;
  } finally {
    _rotating = false;
  }
}


