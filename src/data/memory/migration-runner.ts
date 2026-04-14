import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../logger.js";
import { errorMessage } from "../../utils.js";
import { nowISO } from "./utils.js";
import type { Database } from "./schema.js";

export const SCHEMA_VERSION = 20;

function isDuplicateColumnError(err: unknown, columnName: string): boolean {
  const message = errorMessage(err).toLowerCase();
  return message.includes(`duplicate column name: ${columnName}`.toLowerCase());
}

function getCurrentSchemaVersion(db: Database): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number | null } | undefined;
    return row?.v ?? 1;
  } catch {
    return 0;
  }
}

export function rebuildThreadRegistryWithExitedStatus(
  db: Database,
  existingColumns: string[],
): void {
  const selectSessionResetAt = existingColumns.includes("session_reset_at")
    ? "session_reset_at"
    : "NULL";
  const selectDailyRotation = existingColumns.includes("daily_rotation")
    ? "daily_rotation"
    : "0";
  const selectAutonomousMode = existingColumns.includes("autonomous_mode")
    ? "autonomous_mode"
    : "0";
  const selectTelegramTopicId = existingColumns.includes("telegram_topic_id")
    ? "telegram_topic_id"
    : "NULL";
  const selectIdentityPrompt = existingColumns.includes("identity_prompt")
    ? "identity_prompt"
    : "NULL";
  const selectWorkingDirectory = existingColumns.includes("working_directory")
    ? "working_directory"
    : "NULL";

  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_registry_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id         INTEGER NOT NULL UNIQUE,
      name              TEXT NOT NULL,
      type              TEXT NOT NULL CHECK(type IN ('root','daily','branch','worker')),
      root_thread_id    INTEGER,
      badge             TEXT NOT NULL DEFAULT 'root',
      client            TEXT DEFAULT 'claude',
      max_retries       INTEGER DEFAULT 5,
      cooldown_ms       INTEGER DEFAULT 300000,
      keep_alive        INTEGER DEFAULT 0,
      created_at        TEXT NOT NULL,
      last_active_at    TEXT,
      session_reset_at  TEXT,
      status            TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','expired','exited')),
      daily_rotation    INTEGER NOT NULL DEFAULT 0,
      autonomous_mode   INTEGER NOT NULL DEFAULT 0,
      telegram_topic_id INTEGER,
      identity_prompt   TEXT,
      working_directory TEXT
    );
    INSERT OR IGNORE INTO thread_registry_new (
      id, thread_id, name, type, root_thread_id, badge, client, max_retries,
      cooldown_ms, keep_alive, created_at, last_active_at, session_reset_at,
      status, daily_rotation, autonomous_mode, telegram_topic_id, identity_prompt, working_directory
    )
    SELECT
      id, thread_id, name, type, root_thread_id, badge, client, max_retries,
      cooldown_ms, keep_alive, created_at, last_active_at, ${selectSessionResetAt},
      status, ${selectDailyRotation}, ${selectAutonomousMode}, ${selectTelegramTopicId}, ${selectIdentityPrompt}, ${selectWorkingDirectory}
    FROM thread_registry;
    DROP TABLE thread_registry;
    ALTER TABLE thread_registry_new RENAME TO thread_registry;
    CREATE INDEX IF NOT EXISTS idx_thread_reg_type ON thread_registry(type);
    CREATE INDEX IF NOT EXISTS idx_thread_reg_root ON thread_registry(root_thread_id);
    CREATE INDEX IF NOT EXISTS idx_thread_reg_status ON thread_registry(status);
  `);
}

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
    try {
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      if (!isDuplicateColumnError(err, "priority")) throw err;
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL`);
  },
  4: (db) => {
    try {
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN thread_id INTEGER`);
    } catch (err) {
      if (!isDuplicateColumnError(err, "thread_id")) throw err;
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL`);

    const notes = db.prepare(
      `SELECT note_id, source_episodes FROM semantic_notes WHERE thread_id IS NULL`
    ).all() as { note_id: string; source_episodes: string | null }[];
    const update = db.prepare(`UPDATE semantic_notes SET thread_id = ? WHERE note_id = ?`);
    let backfilled = 0;
    for (const note of notes) {
      let episodeIds: string[] = [];
      try { episodeIds = JSON.parse(note.source_episodes ?? "[]"); } catch {}
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
    try {
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN is_guardrail INTEGER NOT NULL DEFAULT 0`);
    } catch {}
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_guardrail ON semantic_notes(is_guardrail) WHERE is_guardrail = 1 AND valid_to IS NULL`);
  },
  9: (db) => {
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
    try {
      db.exec("ALTER TABLE semantic_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    } catch {}
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_pinned ON semantic_notes(pinned) WHERE pinned = 1 AND valid_to IS NULL",
    );
    log.info("[migration-10] Added pinned column to semantic_notes");
  },
  11: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_narratives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        resolution TEXT NOT NULL CHECK(resolution IN ('day', 'week', 'month', 'quarter', 'half_year')),
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
  13: (db) => {
    const cols = db.prepare("PRAGMA table_info(thread_registry)").all() as Record<string, unknown>[];
    const hasCol = cols.some(c => (c.name as string) === "session_reset_at");
    if (!hasCol) {
      db.exec("ALTER TABLE thread_registry ADD COLUMN session_reset_at TEXT");
    }
    log.info("[migration-13] Added session_reset_at column to thread_registry");
  },
  14: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_narratives_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        resolution TEXT NOT NULL CHECK(resolution IN ('day', 'week', 'month', 'quarter', 'half_year')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        narrative TEXT NOT NULL,
        source_episode_count INTEGER NOT NULL DEFAULT 0,
        source_note_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(thread_id, resolution, period_start)
      );
      INSERT OR IGNORE INTO temporal_narratives_new SELECT * FROM temporal_narratives;
      DROP TABLE temporal_narratives;
      ALTER TABLE temporal_narratives_new RENAME TO temporal_narratives;
      CREATE INDEX IF NOT EXISTS idx_narrative_thread_res ON temporal_narratives(thread_id, resolution, created_at DESC);
    `);
    log.info("[migration-14] Widened temporal_narratives resolution CHECK to include quarter and half_year");
  },
  15: (db) => {
    const existingColumns = db
      .prepare("PRAGMA table_info(thread_registry)")
      .all()
      .map((r: any) => r.name as string);
    rebuildThreadRegistryWithExitedStatus(db, existingColumns);
    log.info("[migration-15] Widened thread_registry status CHECK to include 'exited'");
  },
  16: (db) => {
    try {
      db.exec(`ALTER TABLE thread_registry ADD COLUMN daily_rotation INTEGER NOT NULL DEFAULT 0`);
    } catch {}
    log.info("[migration-16] Added daily_rotation column to thread_registry (default OFF)");
  },
  17: (db) => {
    try {
      db.exec(`ALTER TABLE thread_registry ADD COLUMN autonomous_mode INTEGER NOT NULL DEFAULT 0`);
    } catch {}
    log.info("[migration-17] Added autonomous_mode column to thread_registry (default OFF)");
  },
  18: (db) => {
    try {
      const settingsPath = join(homedir(), ".remote-copilot-mcp", "settings.json");
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}

      const agentTypes = (settings.threadAgentTypes ?? {}) as Record<string, string>;
      const keepAliveThreadId = settings.keepAliveThreadId as number | undefined;
      const keepAliveClient = (settings.keepAliveClient ?? "claude") as string;
      const keepAliveEnabled = !!settings.keepAliveEnabled;

      const upsert = db.prepare(
        `INSERT INTO thread_registry (thread_id, name, type, client, keep_alive, created_at, last_active_at, status)
         VALUES (?, ?, 'root', ?, ?, ?, ?, 'active')
         ON CONFLICT(thread_id) DO UPDATE SET
           client = CASE WHEN excluded.client != 'claude' THEN excluded.client ELSE thread_registry.client END,
           keep_alive = CASE WHEN excluded.keep_alive = 1 THEN 1 ELSE thread_registry.keep_alive END,
           status = CASE WHEN thread_registry.status = 'archived' AND excluded.keep_alive = 1 THEN 'active' ELSE thread_registry.status END`
      );

      let backfilled = 0;
      const now = nowISO();
      for (const [threadIdStr, client] of Object.entries(agentTypes)) {
        const tid = Number(threadIdStr);
        if (!Number.isFinite(tid)) continue;
        const isKeepAlive = keepAliveEnabled && keepAliveThreadId === tid ? 1 : 0;
        const effectiveClient = isKeepAlive ? keepAliveClient : client;
        upsert.run(tid, `Thread ${tid}`, effectiveClient, isKeepAlive, now, now);
        backfilled++;
      }

      if (keepAliveEnabled && keepAliveThreadId) {
        db.prepare(
          `UPDATE thread_registry SET keep_alive = 1, status = 'active', client = ? WHERE thread_id = ?`
        ).run(keepAliveClient, keepAliveThreadId);
      }

      log.info(`[migration-18] Backfilled ${backfilled} threads from settings.json threadAgentTypes`);
    } catch (err) {
      log.warn(`[migration-18] Backfill from settings.json failed: ${errorMessage(err)}`);
    }
  },
  19: (db) => {
    try {
      db.exec(`ALTER TABLE thread_registry ADD COLUMN telegram_topic_id INTEGER`);
    } catch {}
    log.info("[migration-19] Added telegram_topic_id column to thread_registry");
  },
  20: (db) => {
    try {
      db.exec(`ALTER TABLE thread_registry ADD COLUMN identity_prompt TEXT`);
    } catch {}
    log.info("[migration-20] Added identity_prompt column to thread_registry");
  },
  21: (db) => {
    try {
      db.exec(`ALTER TABLE thread_registry ADD COLUMN working_directory TEXT`);
    } catch {}
    log.info("[migration-21] Added working_directory column to thread_registry");
  },
};

export function runMigrations(db: Database): void {
  const currentVersion = getCurrentSchemaVersion(db);
  log.info(`[memory] Current schema version: ${currentVersion}, target: ${SCHEMA_VERSION}`);
  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) continue;
    try {
      migration(db);
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(v, nowISO());
      log.info(`[memory] Migrated schema to version ${v}`);
    } catch (err) {
      log.error(`[memory] Migration ${v} failed: ${errorMessage(err)}. Will attempt self-heal.`);
    }
  }
}
