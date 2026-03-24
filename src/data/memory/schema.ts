/**
 * Memory database schema initialization and migrations.
 *
 * Owns the SQLite `db` handle creation via `initMemoryDb()`.
 * Other memory modules import `Database` (the type) and call
 * `initMemoryDb()` to obtain the singleton handle.
 */

import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "../../logger.js";

// Re-export the Database type so consumers don't need better-sqlite3 directly
export type Database = BetterSqlite3.Database;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Database Initialization ─────────────────────────────────────────────────

const SCHEMA_VERSION = 6;

// ─── Migrations ──────────────────────────────────────────────────────────────

/**
 * Migration functions keyed by target schema version.
 * Each migration upgrades from version (key - 1) to version (key).
 * Add new migrations here when SCHEMA_VERSION is bumped.
 */
const MIGRATIONS: Record<number, (db: Database) => void> = {
  2: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_embeddings (
        note_id    TEXT PRIMARY KEY,
        embedding  BLOB NOT NULL,
        model      TEXT NOT NULL DEFAULT 'text-embedding-3-small',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emb_note ON note_embeddings(note_id);
    `);
  },
  3: (db) => {
    // Add priority column: 0=normal, 1=notable, 2=high importance
    // Use try/catch because new databases already have the column in SCHEMA_SQL
    try {
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — safe to ignore
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL`);
  },
  4: (db) => {
    // Add thread_id column: NULL = global, number = thread-scoped
    try {
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN thread_id INTEGER`);
    } catch {
      // Column already exists — safe to ignore
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL`);

    // Backfill thread_id from source episodes
    const notes = db.prepare(
      `SELECT note_id, source_episodes FROM semantic_notes WHERE thread_id IS NULL`
    ).all() as { note_id: string; source_episodes: string | null }[];
    const update = db.prepare(`UPDATE semantic_notes SET thread_id = ? WHERE note_id = ?`);
    let backfilled = 0;
    for (const note of notes) {
      let episodeIds: string[] = [];
      try { episodeIds = JSON.parse(note.source_episodes ?? "[]"); } catch { /* ignore */ }
      if (episodeIds.length === 0) continue;
      const placeholders = episodeIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT thread_id, COUNT(*) as cnt FROM episodes WHERE episode_id IN (${placeholders}) GROUP BY thread_id ORDER BY cnt DESC LIMIT 1`
      ).all(...episodeIds) as { thread_id: number; cnt: number }[];
      if (rows.length > 0 && rows[0].thread_id != null) {
        update.run(rows[0].thread_id, note.note_id);
        backfilled++;
      }
    }
    if (backfilled > 0) {
      log.info(`[migration-4] Backfilled thread_id on ${backfilled}/${notes.length} existing notes.`);
    }
  },
  5: (db) => {
    // Widen CHECK constraints on episodes table to include 'operator_reaction'
    // type and 'reaction' modality. SQLite does not support ALTER COLUMN, so we
    // must recreate the table.
    db.exec(`
      CREATE TABLE IF NOT EXISTS episodes_new (
        episode_id     TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        thread_id      INTEGER NOT NULL,
        timestamp      TEXT NOT NULL,
        type           TEXT NOT NULL CHECK(type IN ('operator_message','agent_action','system_event','operator_reaction')),
        modality       TEXT NOT NULL CHECK(modality IN ('text','voice','photo','video_note','document','mixed','reaction')),
        content        TEXT NOT NULL,
        topic_tags     TEXT,
        importance     REAL NOT NULL DEFAULT 0.5,
        consolidated   INTEGER DEFAULT 0,
        accessed_count INTEGER DEFAULT 0,
        last_accessed  TEXT,
        created_at     TEXT NOT NULL
      );
      INSERT INTO episodes_new SELECT * FROM episodes;
      DROP TABLE episodes;
      ALTER TABLE episodes_new RENAME TO episodes;
      CREATE INDEX IF NOT EXISTS idx_ep_thread_time ON episodes(thread_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_ep_importance ON episodes(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_ep_uncons ON episodes(consolidated) WHERE consolidated = 0;
    `);
  },
  6: (db) => {
    // Per-thread reaction routing: track which message_id belongs to which thread_id
    db.exec(`
      CREATE TABLE IF NOT EXISTS sent_messages (
        message_id INTEGER PRIMARY KEY,
        thread_id  INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sent_messages_thread ON sent_messages(thread_id);
    `);
  },
};

/**
 * Read the current schema version from the database.
 * Returns 1 if no version is recorded (initial schema).
 */
function getCurrentSchemaVersion(db: Database): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number | null } | undefined;
    return row?.v ?? 1;
  } catch {
    // Table may not exist yet on first run
    return 0;
  }
}

/**
 * Run any pending migrations sequentially from the current stored version
 * up to SCHEMA_VERSION.  Each migration runs inside a transaction.
 */
function runMigrations(db: Database): void {
  const currentVersion = getCurrentSchemaVersion(db);
  log.info(`[memory] Current schema version: ${currentVersion}, target: ${SCHEMA_VERSION}`);
  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      try {
        // Run DDL migrations outside transactions — SQLite DDL + transactions
        // can have subtle issues in WAL mode with better-sqlite3.
        migration(db);
        db.prepare(
          "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)"
        ).run(v, nowISO());
        log.info(`[memory] Migrated schema to version ${v}`);
      } catch (err) {
        log.error(`[memory] Migration ${v} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  episode_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  thread_id      INTEGER NOT NULL,
  timestamp      TEXT NOT NULL,
  type           TEXT NOT NULL CHECK(type IN ('operator_message','agent_action','system_event','operator_reaction')),
  modality       TEXT NOT NULL CHECK(modality IN ('text','voice','photo','video_note','document','mixed','reaction')),
  content        TEXT NOT NULL,
  topic_tags     TEXT,
  importance     REAL NOT NULL DEFAULT 0.5,
  consolidated   INTEGER DEFAULT 0,
  accessed_count INTEGER DEFAULT 0,
  last_accessed  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ep_thread_time ON episodes(thread_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ep_importance ON episodes(importance DESC);
CREATE INDEX IF NOT EXISTS idx_ep_uncons ON episodes(consolidated) WHERE consolidated = 0;

CREATE TABLE IF NOT EXISTS semantic_notes (
  note_id         TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK(type IN ('fact','preference','pattern','entity','relationship')),
  content         TEXT NOT NULL,
  keywords        TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.5,
  source_episodes TEXT,
  linked_notes    TEXT,
  link_reasons    TEXT,
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,
  superseded_by   TEXT,
  access_count    INTEGER DEFAULT 0,
  last_accessed   TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  thread_id       INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sem_type ON semantic_notes(type);
CREATE INDEX IF NOT EXISTS idx_sem_conf ON semantic_notes(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_sem_valid ON semantic_notes(valid_to) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS procedures (
  procedure_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL CHECK(type IN ('workflow','habit','tool_pattern','template')),
  description        TEXT NOT NULL,
  steps              TEXT,
  trigger_conditions TEXT,
  success_rate       REAL DEFAULT 0.5,
  times_executed     INTEGER DEFAULT 0,
  last_executed_at   TEXT,
  learned_from       TEXT,
  corrections        TEXT,
  related_procedures TEXT,
  confidence         REAL DEFAULT 0.5,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proc_name ON procedures(name);
CREATE INDEX IF NOT EXISTS idx_proc_type ON procedures(type);

CREATE TABLE IF NOT EXISTS meta_topic_index (
  topic            TEXT PRIMARY KEY,
  semantic_count   INTEGER DEFAULT 0,
  procedural_count INTEGER DEFAULT 0,
  last_updated     TEXT,
  avg_confidence   REAL DEFAULT 0.5,
  total_accesses   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta_consolidation_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at              TEXT NOT NULL,
  episodes_processed  INTEGER,
  notes_created       INTEGER,
  duration_ms         INTEGER
);

CREATE TABLE IF NOT EXISTS voice_signatures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id     TEXT NOT NULL,
  emotion        TEXT,
  arousal        REAL,
  dominance      REAL,
  valence        REAL,
  speech_rate    REAL,
  mean_pitch_hz  REAL,
  pitch_std_hz   REAL,
  jitter         REAL,
  shimmer        REAL,
  hnr_db         REAL,
  audio_events   TEXT,
  duration_sec   REAL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_ep ON voice_signatures(episode_id);
CREATE INDEX IF NOT EXISTS idx_voice_time ON voice_signatures(created_at DESC);

CREATE TABLE IF NOT EXISTS note_embeddings (
  note_id    TEXT PRIMARY KEY,
  embedding  BLOB NOT NULL,
  model      TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emb_note ON note_embeddings(note_id);

CREATE TABLE IF NOT EXISTS sent_messages (
  message_id INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_thread ON sent_messages(thread_id);

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
`;

export function initMemoryDb(): Database {
  const dbDir = join(homedir(), ".remote-copilot-mcp");
  mkdirSync(dbDir, { recursive: true });

  const dbPath = join(dbDir, "memory.db");
  const db = new BetterSqlite3(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create all tables
  db.exec(SCHEMA_SQL);

  // Record base schema version for brand-new databases only
  const versionCount = (db.prepare("SELECT COUNT(*) as cnt FROM schema_version").get() as { cnt: number }).cnt;
  if (versionCount === 0) {
    // New database — record version 1 as the base, then run all migrations up to SCHEMA_VERSION
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?)").run(nowISO());
  } else {
    // Repair: older code may have recorded SCHEMA_VERSION prematurely without running migrations.
    // Detect by checking if version 3 was recorded but the priority column is missing.
    const hasV3 = db.prepare("SELECT version FROM schema_version WHERE version = 3").get();
    if (hasV3) {
      const cols = db.prepare("PRAGMA table_info(semantic_notes)").all() as Array<{ name: string }>;
      const hasPriority = cols.some(c => c.name === "priority");
      if (!hasPriority) {
        // Version 3 was recorded but migration never ran — reset to version 2
        db.prepare("DELETE FROM schema_version WHERE version >= 3").run();
        log.warn("[memory] Repaired: schema_version was ahead of actual migrations, reset to v2");
      }
    }
    const hasV4 = db.prepare("SELECT version FROM schema_version WHERE version = 4").get();
    if (hasV4) {
      const cols = db.prepare("PRAGMA table_info(semantic_notes)").all() as Array<{ name: string }>;
      const hasThreadId = cols.some(c => c.name === "thread_id");
      if (!hasThreadId) {
        db.prepare("DELETE FROM schema_version WHERE version >= 4").run();
        log.warn("[memory] Repaired: schema_version was ahead of actual migrations, reset to v3");
      }
    }
  }

  // Run any pending migrations (will upgrade from stored version to SCHEMA_VERSION)
  runMigrations(db);

  // Direct repair: ensure priority column exists regardless of migration state.
  // This handles edge cases where migrations fail silently or the migration system
  // recorded a version without actually applying the schema change.
  {
    const cols = db.prepare("PRAGMA table_info(semantic_notes)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "priority")) {
      log.info("[memory] Direct repair: adding missing priority column");
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL`);
    }
    if (!cols.some(c => c.name === "thread_id")) {
      log.info("[memory] Direct repair: adding missing thread_id column");
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN thread_id INTEGER`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL`);
    }
  }

  return db;
}

/**
 * Delete sent_messages entries older than 7 days.
 * Safe to call periodically (e.g. during consolidation).
 */
export function cleanupOldSentMessages(db: Database): void {
  try {
    const result = db.prepare(
      `DELETE FROM sent_messages WHERE created_at < datetime('now', '-7 days')`
    ).run();
    if (result.changes > 0) {
      log.info(`[memory] Cleaned up ${result.changes} old sent_messages entries.`);
    }
  } catch (err) {
    log.warn(`[memory] sent_messages cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
