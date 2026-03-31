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
import { nowISO } from "./utils.js";

// Re-export the Database type so consumers don't need better-sqlite3 directly
export type Database = BetterSqlite3.Database;

// ─── Database Initialization ─────────────────────────────────────────────────

const SCHEMA_VERSION = 12;

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
  7: (db) => {
    // Topic registry table
    db.exec(`
      CREATE TABLE IF NOT EXISTS topic_registry (
        chat_id       TEXT NOT NULL,
        name          TEXT NOT NULL COLLATE NOCASE,
        thread_id     INTEGER NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chat_id, name)
      );
    `);
  },
  8: (db) => {
    // Add is_guardrail flag to semantic_notes for explicit guardrail tagging
    try {
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN is_guardrail INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — safe to ignore
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_guardrail ON semantic_notes(is_guardrail) WHERE is_guardrail = 1 AND valid_to IS NULL`);
  },
  9: (db) => {
    // Backfill orphan NULL thread_id notes: assign to the earliest (most-used) thread.
    // These notes were created before thread_id tracking and have no source_episodes to infer from.
    const oldest = db.prepare(
      `SELECT thread_id FROM semantic_notes WHERE thread_id IS NOT NULL GROUP BY thread_id ORDER BY MIN(created_at) ASC LIMIT 1`
    ).get() as { thread_id: number } | undefined;
    if (!oldest) return;
    const result = db.prepare(
      `UPDATE semantic_notes SET thread_id = ? WHERE thread_id IS NULL`
    ).run(oldest.thread_id);
    if (result.changes > 0) {
      log.info(`[migration-9] Assigned ${result.changes} orphan notes to thread ${oldest.thread_id}`);
    }
  },
  10: (db) => {
    // Add "pinned" column: pinned notes always appear in bootstrap briefing.
    try {
      db.exec("ALTER TABLE semantic_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    } catch { /* already exists in fresh DBs */ }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_pinned ON semantic_notes(pinned) WHERE pinned = 1 AND valid_to IS NULL",
    );
    log.info("[migration-10] Added pinned column to semantic_notes");
  },
  11: (db) => {
    // Temporal narratives: pre-generated summaries at day/week/month resolution
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_narratives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        resolution TEXT NOT NULL CHECK(resolution IN ('day', 'week', 'month')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        narrative TEXT NOT NULL,
        source_episode_count INTEGER NOT NULL DEFAULT 0,
        source_note_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(thread_id, resolution, period_start)
      );
      CREATE INDEX IF NOT EXISTS idx_narrative_thread_res ON temporal_narratives(thread_id, resolution, created_at DESC);
    `);
    log.info("[migration-11] Created temporal_narratives table");
  },
  12: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_registry (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id       INTEGER NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('root','daily','branch','worker')),
        root_thread_id  INTEGER,
        badge           TEXT NOT NULL DEFAULT 'root',
        client          TEXT DEFAULT 'claude',
        max_retries     INTEGER DEFAULT 5,
        cooldown_ms     INTEGER DEFAULT 300000,
        keep_alive      INTEGER DEFAULT 0,
        created_at      TEXT NOT NULL,
        last_active_at  TEXT,
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','expired'))
      );
      CREATE INDEX IF NOT EXISTS idx_thread_reg_type ON thread_registry(type);
      CREATE INDEX IF NOT EXISTS idx_thread_reg_root ON thread_registry(root_thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_reg_status ON thread_registry(status);
    `);
    log.info("[migration-12] Created thread_registry table");
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
        log.error(`[memory] Migration ${v} failed: ${err instanceof Error ? err.message : String(err)}. Will attempt self-heal.`);
        // Don't throw — allow ensureSchemaIntegrity to fix what it can
      }
    }
  }
}

/**
 * Self-healing: verify that critical columns exist after migrations.
 * If any are missing (e.g. a migration was skipped or failed), add them
 * idempotently so downstream queries never crash on a missing column.
 *
 * After each successful self-heal, we record the corresponding migration
 * version so the migration loop won't retry it on next startup.
 */
function ensureSchemaIntegrity(db: Database): void {
  const stampVersion = (v: number) => {
    try {
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(v, nowISO());
    } catch { /* non-critical */ }
  };

  const semanticNoteCols = db
    .prepare("PRAGMA table_info(semantic_notes)")
    .all()
    .map((r: any) => r.name as string);

  if (!semanticNoteCols.includes("is_guardrail")) {
    log.info("[memory] Self-heal: adding missing is_guardrail column");
    db.exec(
      "ALTER TABLE semantic_notes ADD COLUMN is_guardrail INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_guardrail ON semantic_notes(is_guardrail) WHERE is_guardrail = 1 AND valid_to IS NULL",
    );
    stampVersion(7); // migration 7 added is_guardrail
  }

  if (!semanticNoteCols.includes("pinned")) {
    log.info("[memory] Self-heal: adding missing pinned column");
    db.exec(
      "ALTER TABLE semantic_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_pinned ON semantic_notes(pinned) WHERE pinned = 1 AND valid_to IS NULL",
    );
    stampVersion(10); // migration 10 added pinned
  }

  if (!semanticNoteCols.includes("thread_id")) {
    log.info("[memory] Self-heal: adding missing thread_id column to semantic_notes");
    db.exec("ALTER TABLE semantic_notes ADD COLUMN thread_id INTEGER");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL",
    );
    stampVersion(3); // migration 3 added thread_id
  }

  if (!semanticNoteCols.includes("priority")) {
    log.info("[memory] Self-heal: adding missing priority column to semantic_notes");
    db.exec(
      "ALTER TABLE semantic_notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL",
    );
    stampVersion(6); // migration 6 added priority
  }

  // Also check episodes table for thread_id
  const episodeCols = db
    .prepare("PRAGMA table_info(episodes)")
    .all()
    .map((r: any) => r.name as string);

  if (!episodeCols.includes("thread_id")) {
    log.info("[memory] Self-heal: adding missing thread_id column to episodes");
    db.exec("ALTER TABLE episodes ADD COLUMN thread_id INTEGER");
    stampVersion(2); // migration 2 added thread_id to episodes
  }

  // Self-heal: ensure temporal_narratives table exists (migration 11)
  const hasTemporalNarratives = db
    .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='temporal_narratives'")
    .get() as { cnt: number };
  if (hasTemporalNarratives.cnt === 0) {
    log.info("[memory] Self-heal: creating missing temporal_narratives table");
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_narratives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        resolution TEXT NOT NULL CHECK(resolution IN ('day', 'week', 'month')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        narrative TEXT NOT NULL,
        source_episode_count INTEGER NOT NULL DEFAULT 0,
        source_note_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(thread_id, resolution, period_start)
      );
      CREATE INDEX IF NOT EXISTS idx_narrative_thread_res ON temporal_narratives(thread_id, resolution, created_at DESC);
    `);
    stampVersion(11);
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
  is_guardrail    INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sem_type ON semantic_notes(type);
CREATE INDEX IF NOT EXISTS idx_sem_conf ON semantic_notes(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_sem_valid ON semantic_notes(valid_to) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_sem_guardrail ON semantic_notes(is_guardrail) WHERE is_guardrail = 1 AND valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_sem_pinned ON semantic_notes(pinned) WHERE pinned = 1 AND valid_to IS NULL;

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

CREATE TABLE IF NOT EXISTS topic_registry (
  chat_id       TEXT NOT NULL,
  name          TEXT NOT NULL COLLATE NOCASE,
  thread_id     INTEGER NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, name)
);

CREATE TABLE IF NOT EXISTS temporal_narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  resolution TEXT NOT NULL CHECK(resolution IN ('day', 'week', 'month')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  narrative TEXT NOT NULL,
  source_episode_count INTEGER NOT NULL DEFAULT 0,
  source_note_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(thread_id, resolution, period_start)
);
CREATE INDEX IF NOT EXISTS idx_narrative_thread_res ON temporal_narratives(thread_id, resolution, created_at DESC);

CREATE TABLE IF NOT EXISTS thread_registry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id       INTEGER NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK(type IN ('root','daily','branch','worker')),
  root_thread_id  INTEGER,
  badge           TEXT NOT NULL DEFAULT 'root',
  client          TEXT DEFAULT 'claude',
  max_retries     INTEGER DEFAULT 5,
  cooldown_ms     INTEGER DEFAULT 300000,
  keep_alive      INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_active_at  TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','expired'))
);
CREATE INDEX IF NOT EXISTS idx_thread_reg_type ON thread_registry(type);
CREATE INDEX IF NOT EXISTS idx_thread_reg_root ON thread_registry(root_thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_reg_status ON thread_registry(status);

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
`;

/**
 * Backward-compatibility migration: if thread_registry is empty but we have
 * episodes for known threads, register them as root threads so existing
 * deployments don't lose visibility after the thread_registry feature lands.
 */
function migrateExistingRootThreads(db: Database): void {
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM thread_registry").get() as Record<string, unknown>).cnt as number;
  if (count > 0) return;

  const rows = db.prepare("SELECT DISTINCT thread_id FROM episodes ORDER BY thread_id").all() as Record<string, unknown>[];
  if (rows.length === 0) return;

  const now = nowISO();
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO thread_registry (thread_id, name, type, badge, client, keep_alive, created_at, status) VALUES (?, ?, 'root', 'root', 'claude', 0, ?, 'active')"
  );
  const txn = db.transaction(() => {
    for (const row of rows) {
      const threadId = row.thread_id as number;
      stmt.run(threadId, `Thread ${threadId}`, now);
    }
  });
  txn();
  log.info(`Migrated ${rows.length} existing threads as roots`);
}

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
  }

  // Run any pending migrations (will upgrade from stored version to SCHEMA_VERSION)
  runMigrations(db);

  // Self-heal: ensure all critical columns exist even if a migration failed.
  // After each successful column addition, record the corresponding migration
  // version so it isn't retried but also isn't force-stamped over failures.
  ensureSchemaIntegrity(db);

  // Auto-migrate existing threads as roots (backward compatibility)
  migrateExistingRootThreads(db);

  // NOTE: We deliberately do NOT force-stamp schema_version to SCHEMA_VERSION
  // here. If a migration failed, its version is not recorded, so it will be
  // retried on the next startup. This prevents permanently skipping failed
  // migrations (which was the root cause of the "pinned column missing" bug).

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
