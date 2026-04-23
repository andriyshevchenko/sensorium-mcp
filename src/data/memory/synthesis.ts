/**
 * Thread Memory — fork memory from source to branch threads.
 */

import type { Database } from "./schema.js";

/**
 * Fork memory from a source thread to a new branch thread.
 * Copies semantic_notes and temporal_narratives (not episodes — those are session-specific).
 * Returns the number of items copied.
 */
export function forkMemory(
  db: Database,
  sourceThreadId: number,
  targetThreadId: number,
): { notesCopied: number; narrativesCopied: number } {
  const now = new Date().toISOString();

  // Copy semantic notes (generate new IDs)
  const notes = db.prepare(
    `INSERT INTO semantic_notes (
       note_id, type, content, keywords, confidence, source_episodes, linked_notes, link_reasons,
       valid_from, valid_to, superseded_by, access_count, last_accessed, priority, thread_id,
       is_guardrail, pinned, created_at, updated_at
     )
     SELECT
       'sn_' || lower(hex(randomblob(6))), type, content, keywords, confidence, source_episodes, linked_notes, link_reasons,
       valid_from, valid_to, superseded_by, 0, NULL, priority, ?,
       is_guardrail, pinned, ?, ?
     FROM semantic_notes WHERE thread_id = ?`
  ).run(targetThreadId, now, now, sourceThreadId);

  // Copy temporal narratives
  const narratives = db.prepare(
    `INSERT OR IGNORE INTO temporal_narratives (
       thread_id, resolution, period_start, period_end, narrative,
       source_episode_count, source_note_count, model, created_at
     )
     SELECT ?, resolution, period_start, period_end, narrative,
            source_episode_count, source_note_count, model, ?
     FROM temporal_narratives WHERE thread_id = ?`
  ).run(targetThreadId, now, sourceThreadId);

  return {
    notesCopied: notes.changes,
    narrativesCopied: narratives.changes,
  };
}
