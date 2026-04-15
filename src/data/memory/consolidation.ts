import type { Database } from "./schema.js";
import { cleanupOldSentMessages } from "./schema.js";
import { archiveNotesForThread, getThreadIdsWithActiveNotes } from "./semantic.js";
import { log } from "../../logger.js";
import { nowISO } from "./utils.js";
import { getAllThreads } from "./thread-registry.js";

export interface ConsolidationReport {
  episodesProcessed: number;
  notesCreated: number;
  durationMs: number;
  details: string[];
}

export interface ConsolidationLog {
  episodesProcessed: number;
  notesCreated: number;
  durationMs: number;
}

export interface PruningReport {
  notesScanned: number;
  notesExpired: number;
  notesMerged: number;
  durationMs: number;
  details: string[];
}

export interface RawNoteRow {
  note_id: string;
  type: string;
  content: string;
  keywords: string;
  confidence: number;
  priority: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  valid_to: string | null;
  superseded_by: string | null;
  is_guardrail: number;
  pinned: number;
  thread_id: number | null;
}

const TERMINAL_THREAD_STATUSES = new Set(["archived", "expired", "exited"]);

export function getUnconsolidatedThreadIds(db: Database): number[] {
  const rows = db
    .prepare(`SELECT DISTINCT thread_id FROM episodes WHERE consolidated = 0`)
    .all() as { thread_id: number }[];
  return rows.map((row) => row.thread_id);
}

export function logConsolidation(db: Database, entry: ConsolidationLog): void {
  db.prepare(
    `INSERT INTO meta_consolidation_log
       (run_at, episodes_processed, notes_created, duration_ms)
     VALUES (?, ?, ?, ?)`,
  ).run(
    nowISO(),
    entry.episodesProcessed,
    entry.notesCreated,
    entry.durationMs,
  );
}

export function cleanupConsolidationHousekeeping(db: Database): void {
  cleanupOldSentMessages(db);
}

export function getCandidateNotesForPruning(db: Database, maxNotes: number): RawNoteRow[] {
  return db.prepare(`
    SELECT * FROM semantic_notes
    WHERE valid_to IS NULL
      AND superseded_by IS NULL
      AND is_guardrail = 0
      AND pinned = 0
    ORDER BY access_count ASC, created_at ASC
    LIMIT ?
  `).all(maxNotes) as RawNoteRow[];
}

export function hasActiveNote(db: Database, noteId: string): boolean {
  const row = db.prepare(
    `SELECT note_id FROM semantic_notes WHERE note_id = ? AND valid_to IS NULL AND superseded_by IS NULL`,
  ).get(noteId) as { note_id: string } | undefined;
  return Boolean(row);
}

export function getActiveNoteContent(
  db: Database,
  noteId: string,
): { noteId: string; content: string } | null {
  const row = db.prepare(
    `SELECT note_id, content FROM semantic_notes WHERE note_id = ? AND valid_to IS NULL AND superseded_by IS NULL`,
  ).get(noteId) as { note_id: string; content: string } | undefined;
  if (!row) return null;
  return { noteId: row.note_id, content: row.content };
}

export function expireNote(db: Database, noteId: string, now: string): void {
  db.prepare(
    `UPDATE semantic_notes SET valid_to = ?, updated_at = ? WHERE note_id = ?`,
  ).run(now, now, noteId);
}

export function mergeDuplicateNote(
  db: Database,
  keepId: string,
  expireId: string,
  now: string,
  mergedContent?: string,
): void {
  if (mergedContent) {
    db.prepare(
      `UPDATE semantic_notes SET content = ?, updated_at = ? WHERE note_id = ?`,
    ).run(mergedContent, now, keepId);
  }

  db.prepare(
    `UPDATE semantic_notes SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE note_id = ?`,
  ).run(now, keepId, now, expireId);
}

export function sweepOrphanedNotes(db: Database): number {
  const threadIdsWithNotes = getThreadIdsWithActiveNotes(db);
  if (threadIdsWithNotes.length === 0) return 0;

  const allThreads = getAllThreads(db);
  const threadStatusMap = new Map(allThreads.map((thread) => [thread.threadId, thread.status]));

  let totalArchived = 0;
  for (const threadId of threadIdsWithNotes) {
    const status = threadStatusMap.get(threadId);
    if (!status || TERMINAL_THREAD_STATUSES.has(status)) {
      totalArchived += archiveNotesForThread(db, threadId);
    }
  }

  if (totalArchived > 0) {
    log.info(`[memory] Orphan sweep: archived ${totalArchived} notes from dead threads`);
  }
  return totalArchived;
}
