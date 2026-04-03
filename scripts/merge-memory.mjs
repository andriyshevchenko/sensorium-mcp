import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SOURCE_THREAD = 7526;
const TARGET_THREAD = 1327;

const dbPath = join(homedir(), ".remote-copilot-mcp", "memory.db");
const db = new BetterSqlite3(dbPath);
db.pragma("journal_mode = WAL");

// Count before
const sourceNotes = db.prepare("SELECT COUNT(*) as cnt FROM semantic_notes WHERE thread_id = ?").get(SOURCE_THREAD);
const sourceEpisodes = db.prepare("SELECT COUNT(*) as cnt FROM episodes WHERE thread_id = ?").get(SOURCE_THREAD);
const sourceNarratives = db.prepare("SELECT COUNT(*) as cnt FROM temporal_narratives WHERE thread_id = ?").get(SOURCE_THREAD);
const targetNotes = db.prepare("SELECT COUNT(*) as cnt FROM semantic_notes WHERE thread_id = ?").get(TARGET_THREAD);

console.log(`Source thread ${SOURCE_THREAD}: ${sourceNotes.cnt} notes, ${sourceEpisodes.cnt} episodes, ${sourceNarratives.cnt} narratives`);
console.log(`Target thread ${TARGET_THREAD}: ${targetNotes.cnt} notes before merge`);

// Copy semantic notes (generate new IDs)
const notesCopied = db.prepare(
  `INSERT INTO semantic_notes (note_id, thread_id, type, content, keywords, confidence, source_episodes, linked_notes, link_reasons, valid_from, valid_to, superseded_by, access_count, last_accessed, created_at, updated_at, priority, is_guardrail, pinned)
   SELECT 'sn_' || lower(hex(randomblob(6))), ?, type, content, keywords, confidence, source_episodes, linked_notes, link_reasons, valid_from, valid_to, superseded_by, 0, NULL, created_at, created_at, priority, is_guardrail, pinned
   FROM semantic_notes WHERE thread_id = ?`
).run(TARGET_THREAD, SOURCE_THREAD);

console.log(`Copied ${notesCopied.changes} semantic notes from ${SOURCE_THREAD} -> ${TARGET_THREAD}`);

// Copy temporal narratives (skip duplicates)
const narrativesCopied = db.prepare(
  `INSERT OR IGNORE INTO temporal_narratives (thread_id, resolution, period_start, period_end, narrative, source_episode_count, source_note_count, model, created_at)
   SELECT ?, resolution, period_start, period_end, narrative, source_episode_count, source_note_count, model, datetime('now')
   FROM temporal_narratives WHERE thread_id = ?`
).run(TARGET_THREAD, SOURCE_THREAD);

console.log(`Copied ${narrativesCopied.changes} narratives from ${SOURCE_THREAD} -> ${TARGET_THREAD}`);

// Create synthesis episode in target
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO episodes (session_id, thread_id, timestamp, type, modality, content, topic_tags, importance, consolidated, created_at)
   VALUES (?, ?, ?, 'system_event', 'text', ?, '["memory-merge","thread-synthesis"]', 8, 0, ?)`
).run(
  `merge-${SOURCE_THREAD}-${TARGET_THREAD}`,
  TARGET_THREAD,
  now,
  `Memory merged from thread ${SOURCE_THREAD} into ${TARGET_THREAD}. Copied ${notesCopied.changes} semantic notes and ${narrativesCopied.changes} temporal narratives. Thread ${SOURCE_THREAD} was a VSCode Copilot session ("Sensorium V2 VSCode") that worked on: Telegram topic ID remapping (preserving logical thread identity when forum topics die), keeper bug fixes (isThreadRunning status check, missing Accept header causing 406), await_server_ready resilience (non-blocking polling), thread_registry registration for new sessions. Thread ${SOURCE_THREAD} was a temporary thread used while 1327 was broken.`,
  now,
);

console.log(`Created synthesis episode in thread ${TARGET_THREAD}`);

// Archive source thread
const archived = db.prepare(
  "UPDATE thread_registry SET status = 'archived' WHERE thread_id = ?"
).run(SOURCE_THREAD);

console.log(`Archived thread ${SOURCE_THREAD}: ${archived.changes} rows updated`);

// Verify
const targetNotesAfter = db.prepare("SELECT COUNT(*) as cnt FROM semantic_notes WHERE thread_id = ?").get(TARGET_THREAD);
console.log(`\nTarget thread ${TARGET_THREAD} after merge: ${targetNotesAfter.cnt} notes`);
console.log("Done!");

db.close();
