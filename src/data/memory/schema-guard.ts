import { log } from "../../logger.js";
import { rebuildThreadRegistryWithExitedStatus } from "./migration-runner.js";
import { nowISO } from "./utils.js";
import type { Database } from "./schema.js";

export function ensureSchemaIntegrity(db: Database): void {
  const stampVersion = (v: number) => {
    try {
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(v, nowISO());
    } catch {}
  };

  const getTableSql = (tableName: string): string => {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName) as { sql: string | null } | undefined;
    return row?.sql ?? "";
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
    stampVersion(8);
  }

  if (!semanticNoteCols.includes("pinned")) {
    log.info("[memory] Self-heal: adding missing pinned column");
    db.exec(
      "ALTER TABLE semantic_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_pinned ON semantic_notes(pinned) WHERE pinned = 1 AND valid_to IS NULL",
    );
    stampVersion(10);
  }

  if (!semanticNoteCols.includes("thread_id")) {
    log.info("[memory] Self-heal: adding missing thread_id column to semantic_notes");
    db.exec("ALTER TABLE semantic_notes ADD COLUMN thread_id INTEGER");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL",
    );
    stampVersion(4);
  }

  if (!semanticNoteCols.includes("priority")) {
    log.info("[memory] Self-heal: adding missing priority column to semantic_notes");
    db.exec(
      "ALTER TABLE semantic_notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL",
    );
    stampVersion(3);
  }

  const episodeCols = db
    .prepare("PRAGMA table_info(episodes)")
    .all()
    .map((r: any) => r.name as string);

  if (!episodeCols.includes("thread_id")) {
    log.info("[memory] Self-heal: adding missing thread_id column to episodes");
    db.exec("ALTER TABLE episodes ADD COLUMN thread_id INTEGER");
  }

  const hasTemporalNarratives = db
    .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='temporal_narratives'")
    .get() as { cnt: number };
  if (hasTemporalNarratives.cnt === 0) {
    log.info("[memory] Self-heal: creating missing temporal_narratives table");
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
    stampVersion(11);
  } else {
    const temporalNarrativesSql = getTableSql("temporal_narratives");
    const hasExpandedNarrativeResolution =
      temporalNarrativesSql.includes("'quarter'") &&
      temporalNarrativesSql.includes("'half_year'");
    if (!hasExpandedNarrativeResolution) {
      log.info("[memory] Self-heal: widening temporal_narratives resolution CHECK");
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
      stampVersion(14);
    }
  }

  const hasThreadRegistry = db
    .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='thread_registry'")
    .get() as { cnt: number };
  if (hasThreadRegistry.cnt === 0) {
    log.info("[memory] Self-heal: creating missing thread_registry table");
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
        session_reset_at TEXT,
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','expired','exited')),
        daily_rotation  INTEGER NOT NULL DEFAULT 0,
        autonomous_mode INTEGER NOT NULL DEFAULT 0,
        telegram_topic_id INTEGER,
        identity_prompt TEXT,
        working_directory TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_thread_reg_type ON thread_registry(type);
      CREATE INDEX IF NOT EXISTS idx_thread_reg_root ON thread_registry(root_thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_reg_status ON thread_registry(status);
    `);
    stampVersion(12);
    stampVersion(13);
    stampVersion(15);
    stampVersion(16);
    stampVersion(17);
    stampVersion(19);
    stampVersion(20);
    stampVersion(21);
    return;
  }

  const threadRegistryCols = db
    .prepare("PRAGMA table_info(thread_registry)")
    .all()
    .map((r: any) => r.name as string);

  if (!threadRegistryCols.includes("session_reset_at")) {
    log.info("[memory] Self-heal: adding missing session_reset_at column to thread_registry");
    db.exec("ALTER TABLE thread_registry ADD COLUMN session_reset_at TEXT");
    stampVersion(13);
  }

  const threadRegistrySql = getTableSql("thread_registry");
  if (!threadRegistrySql.includes("'exited'")) {
    log.info("[memory] Self-heal: widening thread_registry status CHECK");
    rebuildThreadRegistryWithExitedStatus(db, threadRegistryCols);
    stampVersion(15);
  }

  if (!threadRegistryCols.includes("daily_rotation")) {
    log.info("[memory] Self-heal: adding missing daily_rotation column to thread_registry");
    db.exec("ALTER TABLE thread_registry ADD COLUMN daily_rotation INTEGER NOT NULL DEFAULT 0");
    stampVersion(16);
  }

  if (!threadRegistryCols.includes("autonomous_mode")) {
    log.info("[memory] Self-heal: adding missing autonomous_mode column to thread_registry");
    db.exec("ALTER TABLE thread_registry ADD COLUMN autonomous_mode INTEGER NOT NULL DEFAULT 0");
    stampVersion(17);
  }

  if (!threadRegistryCols.includes("telegram_topic_id")) {
    log.info("[memory] Self-heal: adding missing telegram_topic_id column to thread_registry");
    db.exec("ALTER TABLE thread_registry ADD COLUMN telegram_topic_id INTEGER");
    stampVersion(19);
  }

  if (!threadRegistryCols.includes("identity_prompt")) {
    log.info("[memory] Self-heal: adding missing identity_prompt column to thread_registry");
    db.exec("ALTER TABLE thread_registry ADD COLUMN identity_prompt TEXT");
    stampVersion(20);
  }

  if (!threadRegistryCols.includes("working_directory")) {
    log.info("[memory] Self-heal: adding missing working_directory column to thread_registry");
    db.exec("ALTER TABLE thread_registry ADD COLUMN working_directory TEXT");
    stampVersion(21);
  }
}
