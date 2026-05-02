/**
 * Thread Memory — fork memory from source to branch threads.
 */

import { randomBytes } from "node:crypto";
import type { Database } from "./schema.js";

/**
 * Fork memory from a source thread to a new branch thread.
 * Copies active (non-superseded, non-expired) semantic_notes with new IDs,
 * remaps linked_notes references, copies note_embeddings, and copies
 * temporal_narratives. Wrapped in a single transaction for atomicity.
 * Returns the number of items copied.
 */
export function forkMemory(
  db: Database,
  sourceThreadId: number,
  targetThreadId: number,
): { notesCopied: number; narrativesCopied: number } {
  return db.transaction(() => {
    const now = new Date().toISOString();

    // 1. Select only active notes (no superseded, no expired)
    const sourceNotes = db.prepare(
      `SELECT note_id, type, content, keywords, confidence, source_episodes, linked_notes, link_reasons,
              valid_from, priority, is_guardrail, pinned, quality_score
       FROM semantic_notes
       WHERE thread_id = ? AND superseded_by IS NULL AND valid_to IS NULL`
    ).all(sourceThreadId) as Array<{
      note_id: string;
      type: string;
      content: string;
      keywords: string | null;
      confidence: number;
      source_episodes: string | null;
      linked_notes: string | null;
      link_reasons: string | null;
      valid_from: string;
      priority: number;
      is_guardrail: number;
      pinned: number;
      quality_score: number | null;
    }>;

    // 2. Build old -> new ID mapping
    const idMap = new Map<string, string>();
    for (const note of sourceNotes) {
      idMap.set(note.note_id, "sn_" + randomBytes(6).toString("hex"));
    }

    // 3. Remap linked_notes array and link_reasons keys to use new IDs
    function remapLinkedNotes(linkedNotes: string | null): string | null {
      if (!linkedNotes) return linkedNotes;
      try {
        const ids: string[] = JSON.parse(linkedNotes);
        return JSON.stringify(ids.map((id) => idMap.get(id) ?? id));
      } catch {
        return linkedNotes;
      }
    }

    function remapLinkReasons(linkReasons: string | null): string | null {
      if (!linkReasons) return linkReasons;
      try {
        const reasons: Record<string, string> = JSON.parse(linkReasons);
        const remapped: Record<string, string> = {};
        for (const [oldId, reason] of Object.entries(reasons)) {
          remapped[idMap.get(oldId) ?? oldId] = reason;
        }
        return JSON.stringify(remapped);
      } catch {
        return linkReasons;
      }
    }

    // 4. Insert notes with new IDs
    const insertNote = db.prepare(
      `INSERT INTO semantic_notes (
         note_id, type, content, keywords, confidence, source_episodes, linked_notes, link_reasons,
         valid_from, valid_to, superseded_by, access_count, last_accessed, priority, thread_id,
         is_guardrail, pinned, quality_score, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const note of sourceNotes) {
      insertNote.run(
        idMap.get(note.note_id),
        note.type,
        note.content,
        note.keywords,
        note.confidence,
        note.source_episodes,
        remapLinkedNotes(note.linked_notes),
        remapLinkReasons(note.link_reasons),
        note.valid_from,
        note.priority,
        targetThreadId,
        note.is_guardrail,
        note.pinned,
        note.quality_score,
        now,
        now,
      );
    }

    // 5. Copy embeddings using ID mapping
    if (sourceNotes.length > 0) {
      const oldIds = sourceNotes.map((n) => n.note_id);
      const placeholders = oldIds.map(() => "?").join(",");
      const embedRows = db.prepare(
        `SELECT note_id, embedding, model, created_at FROM note_embeddings WHERE note_id IN (${placeholders})`
      ).all(...oldIds) as Array<{ note_id: string; embedding: Buffer; model: string; created_at: string }>;

      const insertEmb = db.prepare(
        `INSERT OR REPLACE INTO note_embeddings (note_id, embedding, model, created_at) VALUES (?, ?, ?, ?)`
      );
      for (const row of embedRows) {
        insertEmb.run(idMap.get(row.note_id), row.embedding, row.model, row.created_at);
      }
    }

    // 6. Copy temporal narratives
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
      notesCopied: sourceNotes.length,
      narrativesCopied: narratives.changes,
    };
  })();
}
