import type { Database } from "./schema.js";
import { errorMessage } from "../../utils.js";
import { log } from "../../logger.js";

export const SCHEMA_SQL = `
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
  identity_prompt TEXT
);
CREATE INDEX IF NOT EXISTS idx_thread_reg_type ON thread_registry(type);
CREATE INDEX IF NOT EXISTS idx_thread_reg_root ON thread_registry(root_thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_reg_status ON thread_registry(status);

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
`;

export function cleanupOldSentMessages(db: Database): void {
  try {
    const result = db.prepare(
      `DELETE FROM sent_messages WHERE created_at < datetime('now', '-7 days')`
    ).run();
    if (result.changes > 0) {
      log.info(`[memory] Cleaned up ${result.changes} old sent_messages entries.`);
    }
  } catch (err) {
    log.warn(`[memory] sent_messages cleanup failed: ${errorMessage(err)}`);
  }
}
