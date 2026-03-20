import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "crypto";
import { mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { cosineSimilarity } from "./openai.js";

// Use the Database type from better-sqlite3
type Database = BetterSqlite3.Database;

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface Episode {
  episodeId: string;
  sessionId: string;
  threadId: number;
  timestamp: string;
  type: "operator_message" | "agent_action" | "system_event";
  modality: "text" | "voice" | "photo" | "video_note" | "document" | "mixed";
  content: Record<string, unknown>;
  topicTags: string[];
  importance: number;
  consolidated: boolean;
  accessedCount: number;
  lastAccessed: string | null;
  createdAt: string;
}

export interface SemanticNote {
  noteId: string;
  type: "fact" | "preference" | "pattern" | "entity" | "relationship";
  content: string;
  keywords: string[];
  confidence: number;
  priority: number; // 0=normal, 1=elevated, 2=critical
  threadId: number | null; // null = global, number = thread-scoped
  sourceEpisodes: string[];
  linkedNotes: string[];
  linkReasons: Record<string, string>;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
  accessCount: number;
  lastAccessed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Procedure {
  procedureId: string;
  name: string;
  type: "workflow" | "habit" | "tool_pattern" | "template";
  description: string;
  steps: string[];
  triggerConditions: string[];
  successRate: number;
  timesExecuted: number;
  lastExecutedAt: string | null;
  learnedFrom: string[];
  corrections: string[];
  relatedProcedures: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

interface TopicEntry {
  topic: string;
  semanticCount: number;
  proceduralCount: number;
  lastUpdated: string | null;
  avgConfidence: number;
  totalAccesses: number;
}

interface MemoryStatus {
  totalEpisodes: number;
  unconsolidatedEpisodes: number;
  totalSemanticNotes: number;
  totalProcedures: number;
  totalVoiceSignatures: number;
  lastConsolidation: string | null;
  topTopics: TopicEntry[];
  dbSizeBytes: number;
}

interface ConsolidationLog {
  episodesProcessed: number;
  notesCreated: number;
  durationMs: number;
}

export interface ConsolidationReport {
  episodesProcessed: number;
  notesCreated: number;
  durationMs: number;
  details: string[];
}

interface VoiceBaseline {
  avgArousal: number | null;
  avgDominance: number | null;
  avgValence: number | null;
  avgSpeechRate: number | null;
  avgMeanPitchHz: number | null;
  avgPitchStdHz: number | null;
  avgJitter: number | null;
  avgShimmer: number | null;
  avgHnrDb: number | null;
  sampleCount: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function jsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val);
}

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

function parseJsonObject(val: string | null | undefined): Record<string, unknown> {
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}

// ─── Database Initialization ─────────────────────────────────────────────────

const SCHEMA_VERSION = 4;

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
      process.stderr.write(`[migration-4] Backfilled thread_id on ${backfilled}/${notes.length} existing notes.\n`);
    }
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
  process.stderr.write(`[memory] Current schema version: ${currentVersion}, target: ${SCHEMA_VERSION}\n`);
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
        process.stderr.write(`[memory] Migrated schema to version ${v}\n`);
      } catch (err) {
        process.stderr.write(`[memory] Migration ${v} FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
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
  type           TEXT NOT NULL CHECK(type IN ('operator_message','agent_action','system_event')),
  modality       TEXT NOT NULL CHECK(modality IN ('text','voice','photo','video_note','document','mixed')),
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
        process.stderr.write("[memory] Repaired: schema_version was ahead of actual migrations, reset to v2\n");
      }
    }
    const hasV4 = db.prepare("SELECT version FROM schema_version WHERE version = 4").get();
    if (hasV4) {
      const cols = db.prepare("PRAGMA table_info(semantic_notes)").all() as Array<{ name: string }>;
      const hasThreadId = cols.some(c => c.name === "thread_id");
      if (!hasThreadId) {
        db.prepare("DELETE FROM schema_version WHERE version >= 4").run();
        process.stderr.write("[memory] Repaired: schema_version was ahead of actual migrations, reset to v3\n");
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
      process.stderr.write("[memory] Direct repair: adding missing priority column\n");
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_priority ON semantic_notes(priority DESC) WHERE valid_to IS NULL`);
    }
    if (!cols.some(c => c.name === "thread_id")) {
      process.stderr.write("[memory] Direct repair: adding missing thread_id column\n");
      db.exec(`ALTER TABLE semantic_notes ADD COLUMN thread_id INTEGER`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_notes(thread_id) WHERE valid_to IS NULL`);
    }
  }

  return db;
}

// ─── Row → Interface mappers ─────────────────────────────────────────────────

function rowToEpisode(row: Record<string, unknown>): Episode {
  return {
    episodeId: row.episode_id as string,
    sessionId: row.session_id as string,
    threadId: row.thread_id as number,
    timestamp: row.timestamp as string,
    type: row.type as Episode["type"],
    modality: row.modality as Episode["modality"],
    content: parseJsonObject(row.content as string | null) as Record<string, unknown>,
    topicTags: parseJsonArray(row.topic_tags as string | null),
    importance: row.importance as number,
    consolidated: (row.consolidated as number) === 1,
    accessedCount: row.accessed_count as number,
    lastAccessed: (row.last_accessed as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function rowToSemanticNote(row: Record<string, unknown>): SemanticNote {
  return {
    noteId: row.note_id as string,
    type: row.type as SemanticNote["type"],
    content: row.content as string,
    keywords: parseJsonArray(row.keywords as string | null),
    confidence: row.confidence as number,
    priority: (row.priority as number) ?? 0,
    threadId: (row.thread_id as number) ?? null,
    sourceEpisodes: parseJsonArray(row.source_episodes as string | null),
    linkedNotes: parseJsonArray(row.linked_notes as string | null),
    linkReasons: parseJsonObject(row.link_reasons as string | null) as Record<string, string>,
    validFrom: row.valid_from as string,
    validTo: (row.valid_to as string) ?? null,
    supersededBy: (row.superseded_by as string) ?? null,
    accessCount: row.access_count as number,
    lastAccessed: (row.last_accessed as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToProcedure(row: Record<string, unknown>): Procedure {
  return {
    procedureId: row.procedure_id as string,
    name: row.name as string,
    type: row.type as Procedure["type"],
    description: row.description as string,
    steps: parseJsonArray(row.steps as string | null),
    triggerConditions: parseJsonArray(row.trigger_conditions as string | null),
    successRate: row.success_rate as number,
    timesExecuted: row.times_executed as number,
    lastExecutedAt: (row.last_executed_at as string) ?? null,
    learnedFrom: parseJsonArray(row.learned_from as string | null),
    corrections: parseJsonArray(row.corrections as string | null),
    relatedProcedures: parseJsonArray(row.related_procedures as string | null),
    confidence: row.confidence as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToTopicEntry(row: Record<string, unknown>): TopicEntry {
  return {
    topic: row.topic as string,
    semanticCount: row.semantic_count as number,
    proceduralCount: row.procedural_count as number,
    lastUpdated: (row.last_updated as string) ?? null,
    avgConfidence: row.avg_confidence as number,
    totalAccesses: row.total_accesses as number,
  };
}

// ─── Episodic Memory ─────────────────────────────────────────────────────────

export function saveEpisode(
  db: Database,
  episode: {
    sessionId: string;
    threadId: number;
    type: "operator_message" | "agent_action" | "system_event";
    modality: "text" | "voice" | "photo" | "video_note" | "document" | "mixed";
    content: Record<string, unknown>;
    topicTags?: string[];
    importance?: number;
  }
): string {
  const id = generateId("ep");
  const now = nowISO();

  db.prepare(
    `INSERT INTO episodes
       (episode_id, session_id, thread_id, timestamp, type, modality, content, topic_tags, importance, consolidated, accessed_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(
    id,
    episode.sessionId,
    episode.threadId,
    now,
    episode.type,
    episode.modality,
    JSON.stringify(episode.content),
    jsonOrNull(episode.topicTags),
    episode.importance ?? 0.5,
    now
  );

  return id;
}

export function getRecentEpisodes(db: Database, threadId: number, limit = 20): Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM episodes WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?`
    )
    .all(threadId, limit) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

function getUnconsolidatedEpisodes(db: Database, threadId: number, limit = 50): Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM episodes WHERE thread_id = ? AND consolidated = 0 ORDER BY timestamp ASC LIMIT ?`
    )
    .all(threadId, limit) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}

function markConsolidated(db: Database, episodeIds: string[]): void {
  if (episodeIds.length === 0) return;
  const stmt = db.prepare(`UPDATE episodes SET consolidated = 1 WHERE episode_id = ?`);
  const txn = db.transaction(() => {
    for (const id of episodeIds) {
      stmt.run(id);
    }
  });
  txn();
}

// ─── Semantic Memory ─────────────────────────────────────────────────────────

export function saveSemanticNote(
  db: Database,
  note: {
    type: "fact" | "preference" | "pattern" | "entity" | "relationship";
    content: string;
    keywords: string[];
    confidence?: number;
    priority?: number;
    threadId?: number | null;
    sourceEpisodes?: string[];
  }
): string {
  const id = generateId("sn");
  const now = nowISO();

  db.prepare(
    `INSERT INTO semantic_notes
       (note_id, type, content, keywords, confidence, priority, thread_id, source_episodes, linked_notes, link_reasons, valid_from, access_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    note.type,
    note.content,
    JSON.stringify(note.keywords),
    Math.max(0, Math.min(1, note.confidence ?? 0.5)),
    Math.max(0, Math.min(2, note.priority ?? 0)),
    note.threadId ?? null,
    jsonOrNull(note.sourceEpisodes),
    null,
    null,
    now,
    now,
    now
  );

  // Update topic index for each keyword
  updateTopicIndexForKeywords(db, note.keywords, "semantic");

  return id;
}

export function searchSemanticNotes(
  db: Database,
  query: string,
  options?: { types?: string[]; maxResults?: number; skipAccessTracking?: boolean }
): SemanticNote[] {
  const maxResults = options?.maxResults ?? 10;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) return [];

  // Build LIKE conditions: each term must match content OR keywords
  // Escape SQL LIKE wildcards in search terms
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const term of terms) {
    const escaped = term.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(`(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(keywords) LIKE ? ESCAPE '\\')`);
    params.push(`%${escaped}%`, `%${escaped}%`);
  }

  let sql = `SELECT * FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL AND (${conditions.join(" AND ")})`;

  if (options?.types && options.types.length > 0) {
    const placeholders = options.types.map(() => "?").join(",");
    sql += ` AND type IN (${placeholders})`;
    params.push(...options.types);
  }

  sql += ` ORDER BY confidence DESC, access_count DESC LIMIT ?`;
  params.push(maxResults);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  // Update access counts
  if (!options?.skipAccessTracking) {
    const now = nowISO();
    const updateStmt = db.prepare(
      `UPDATE semantic_notes SET access_count = access_count + 1, last_accessed = ? WHERE note_id = ?`
    );
    const txn = db.transaction(() => {
      for (const row of rows) {
        updateStmt.run(now, row.note_id);
      }
    });
    txn();
  }

  return rows.map(rowToSemanticNote);
}

export function searchSemanticNotesRanked(
  db: Database,
  query: string,
  options?: { types?: string[]; maxResults?: number; skipAccessTracking?: boolean; minMatchRatio?: number; threadId?: number }
): SemanticNote[] {
  const maxResults = options?.maxResults ?? 10;
  const minMatchRatio = options?.minMatchRatio ?? 0.4; // require at least 40% of terms to match
  const terms = query.toLowerCase().split(/\\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  // Use OR to get broad recall
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const term of terms) {
    const escaped = term.replace(/%/g, "\\\\%").replace(/_/g, "\\\\_");
    conditions.push(`(LOWER(content) LIKE ? ESCAPE '\\\\' OR LOWER(keywords) LIKE ? ESCAPE '\\\\')`);
    params.push(`%${escaped}%`, `%${escaped}%`);
  }

  let sql = `SELECT * FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL AND (${conditions.join(" OR ")})`;

  // Thread filtering: show notes from this thread + global notes
  if (options?.threadId !== undefined) {
    sql += ` AND (thread_id IS NULL OR thread_id = ?)`;
    params.push(options.threadId);
  }

  if (options?.types && options.types.length > 0) {
    const placeholders = options.types.map(() => "?").join(",");
    sql += ` AND type IN (${placeholders})`;
    params.push(...options.types);
  }
  sql += ` ORDER BY confidence DESC, access_count DESC LIMIT ?`;
  params.push(maxResults * 3); // fetch more to allow scoring/filtering

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  let notes = rows.map(rowToSemanticNote);

  // Score by how many terms match
  const minMatches = Math.max(2, Math.ceil(terms.length * minMatchRatio));
  notes = notes.map(n => {
    const text = (n.content + " " + n.keywords.join(" ")).toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      if (text.includes(term)) matchCount++;
    }
    return { ...n, _matchCount: matchCount };
  })
  .filter(n => (n as any)._matchCount >= minMatches)
  .sort((a, b) => {
    const scoreA = (a as any)._matchCount;
    const scoreB = (b as any)._matchCount;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.confidence - a.confidence;
  })
  .slice(0, maxResults);

  // Update access counts
  if (!options?.skipAccessTracking) {
    const now = nowISO();
    const updateStmt = db.prepare(
      `UPDATE semantic_notes SET access_count = access_count + 1, last_accessed = ? WHERE note_id = ?`
    );
    db.transaction(() => {
      for (const note of notes) updateStmt.run(now, note.noteId);
    })();
  }

  return notes;
}

export function getTopSemanticNotes(
  db: Database,
  options?: { type?: string; limit?: number; sortBy?: "confidence" | "access_count" | "created_at" }
): SemanticNote[] {
  const limit = options?.limit ?? 10;
  const sortBy = options?.sortBy ?? "confidence";

  const validSortColumns: Record<string, string> = {
    confidence: "confidence DESC",
    access_count: "access_count DESC",
    created_at: "created_at DESC",
  };
  const orderClause = validSortColumns[sortBy] ?? "confidence DESC";

  let sql = `SELECT * FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL`;
  const params: unknown[] = [];

  if (options?.type) {
    sql += ` AND type = ?`;
    params.push(options.type);
  }

  sql += ` ORDER BY ${orderClause} LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSemanticNote);
}

export function updateSemanticNote(
  db: Database,
  noteId: string,
  updates: Partial<{
    content: string;
    confidence: number;
    priority: number;
    keywords: string[];
    linkedNotes: string[];
    linkReasons: Record<string, string>;
  }>
): void {
  const now = nowISO();
  const setClauses: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (updates.content !== undefined) {
    setClauses.push("content = ?");
    params.push(updates.content);
  }
  if (updates.confidence !== undefined) {
    setClauses.push("confidence = ?");
    params.push(updates.confidence);
  }
  if (updates.priority !== undefined) {
    setClauses.push("priority = ?");
    params.push(Math.max(0, Math.min(2, updates.priority)));
  }
  if (updates.keywords !== undefined) {
    setClauses.push("keywords = ?");
    params.push(JSON.stringify(updates.keywords));
  }
  if (updates.linkedNotes !== undefined) {
    setClauses.push("linked_notes = ?");
    params.push(JSON.stringify(updates.linkedNotes));
  }
  if (updates.linkReasons !== undefined) {
    setClauses.push("link_reasons = ?");
    params.push(JSON.stringify(updates.linkReasons));
  }

  params.push(noteId);
  db.prepare(`UPDATE semantic_notes SET ${setClauses.join(", ")} WHERE note_id = ?`).run(...params);
}

export function supersedeNote(
  db: Database,
  oldNoteId: string,
  newNote: {
    type: string;
    content: string;
    keywords: string[];
    confidence?: number;
    priority?: number;
    sourceEpisodes?: string[];
  }
): string {
  // Inherit thread_id from the old note being superseded
  const oldRow = db.prepare(`SELECT thread_id FROM semantic_notes WHERE note_id = ?`).get(oldNoteId) as { thread_id: number | null } | undefined;
  const newId = saveSemanticNote(db, {
    type: newNote.type as SemanticNote["type"],
    content: newNote.content,
    keywords: newNote.keywords,
    confidence: newNote.confidence,
    priority: newNote.priority,
    threadId: oldRow?.thread_id ?? null,
    sourceEpisodes: newNote.sourceEpisodes,
  });

  const now = nowISO();
  db.prepare(`UPDATE semantic_notes SET superseded_by = ?, valid_to = ?, updated_at = ? WHERE note_id = ?`).run(
    newId,
    now,
    now,
    oldNoteId
  );

  // Create bidirectional link: add old note to new note's linked_notes
  const newRow = db.prepare(`SELECT linked_notes, link_reasons FROM semantic_notes WHERE note_id = ?`).get(newId) as Record<string, unknown> | undefined;
  const currentLinked = parseJsonArray(newRow?.linked_notes as string | null);
  const currentReasons = parseJsonObject(newRow?.link_reasons as string | null) as Record<string, string>;
  if (!currentLinked.includes(oldNoteId)) {
    currentLinked.push(oldNoteId);
  }
  currentReasons[oldNoteId] = "supersedes";
  updateSemanticNote(db, newId, {
    linkedNotes: currentLinked,
    linkReasons: currentReasons,
  });

  return newId;
}

// ─── Procedural Memory ──────────────────────────────────────────────────────

export function saveProcedure(
  db: Database,
  proc: {
    name: string;
    type: "workflow" | "habit" | "tool_pattern" | "template";
    description: string;
    steps?: string[];
    triggerConditions?: string[];
  }
): string {
  const id = generateId("pr");
  const now = nowISO();

  db.prepare(
    `INSERT INTO procedures
       (procedure_id, name, type, description, steps, trigger_conditions, success_rate, times_executed, learned_from, corrections, related_procedures, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0, ?, ?, ?, 0.5, ?, ?)`
  ).run(
    id,
    proc.name,
    proc.type,
    proc.description,
    jsonOrNull(proc.steps),
    jsonOrNull(proc.triggerConditions),
    null, // learned_from
    null, // corrections
    null, // related_procedures
    now,
    now
  );

  // Update topic index based on procedure name words
  const keywords = proc.name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  updateTopicIndexForKeywords(db, keywords, "procedural");

  return id;
}

export function searchProcedures(db: Database, query: string, maxResults = 10): Procedure[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const term of terms) {
    const escaped = term.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(`(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\' OR LOWER(steps) LIKE ? ESCAPE '\\' OR LOWER(trigger_conditions) LIKE ? ESCAPE '\\')`);
    params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }

  const sql = `SELECT * FROM procedures WHERE ${conditions.join(" OR ")} ORDER BY confidence DESC, success_rate DESC LIMIT ?`;
  params.push(maxResults);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToProcedure);
}

export function updateProcedure(
  db: Database,
  procedureId: string,
  updates: Partial<{
    description: string;
    steps: string[];
    triggerConditions: string[];
    successRate: number;
    timesExecuted: number;
    corrections: string[];
    confidence: number;
  }>
): void {
  const now = nowISO();
  const setClauses: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (updates.description !== undefined) {
    setClauses.push("description = ?");
    params.push(updates.description);
  }
  if (updates.steps !== undefined) {
    setClauses.push("steps = ?");
    params.push(JSON.stringify(updates.steps));
  }
  if (updates.triggerConditions !== undefined) {
    setClauses.push("trigger_conditions = ?");
    params.push(JSON.stringify(updates.triggerConditions));
  }
  if (updates.successRate !== undefined) {
    setClauses.push("success_rate = ?");
    params.push(updates.successRate);
  }
  if (updates.timesExecuted !== undefined) {
    setClauses.push("times_executed = ?");
    params.push(updates.timesExecuted);
  }
  if (updates.corrections !== undefined) {
    setClauses.push("corrections = ?");
    params.push(JSON.stringify(updates.corrections));
  }
  if (updates.confidence !== undefined) {
    setClauses.push("confidence = ?");
    params.push(updates.confidence);
  }

  params.push(procedureId);
  db.prepare(`UPDATE procedures SET ${setClauses.join(", ")} WHERE procedure_id = ?`).run(...params);
}

// ─── Meta Memory ─────────────────────────────────────────────────────────────

function updateTopicIndexForKeywords(db: Database, keywords: string[], layer: "semantic" | "procedural"): void {
  const now = nowISO();
  const col = layer === "semantic" ? "semantic_count" : "procedural_count";

  const upsertStmt = db.prepare(
    `INSERT INTO meta_topic_index (topic, ${col}, last_updated)
     VALUES (?, 1, ?)
     ON CONFLICT(topic) DO UPDATE SET
       ${col} = ${col} + 1,
       last_updated = ?,
       total_accesses = total_accesses + 1`
  );

  const txn = db.transaction(() => {
    for (const kw of keywords) {
      const normalised = kw.toLowerCase().trim();
      if (normalised.length > 1) {
        upsertStmt.run(normalised, now, now);
      }
    }
  });
  txn();
}

function decrementTopicIndexForKeywords(db: Database, keywords: string[], layer: "semantic" | "procedural"): void {
  const col = layer === "semantic" ? "semantic_count" : "procedural_count";

  const decrementStmt = db.prepare(
    `UPDATE meta_topic_index SET ${col} = MAX(${col} - 1, 0) WHERE topic = ?`
  );
  const deleteStmt = db.prepare(
    `DELETE FROM meta_topic_index WHERE topic = ? AND semantic_count <= 0 AND procedural_count <= 0`
  );

  const txn = db.transaction(() => {
    for (const kw of keywords) {
      const normalised = kw.toLowerCase().trim();
      if (normalised.length > 1) {
        decrementStmt.run(normalised);
        deleteStmt.run(normalised);
      }
    }
  });
  txn();
}

export function getMemoryStatus(db: Database, threadId: number): MemoryStatus {
  const totalEpisodes = (
    db.prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE thread_id = ?`).get(threadId) as { cnt: number }
  ).cnt;

  const unconsolidatedEpisodes = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE thread_id = ? AND consolidated = 0`)
      .get(threadId) as { cnt: number }
  ).cnt;

  const totalSemanticNotes = (
    db.prepare(`SELECT COUNT(*) as cnt FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL`).get() as {
      cnt: number;
    }
  ).cnt;

  const totalProcedures = (
    db.prepare(`SELECT COUNT(*) as cnt FROM procedures`).get() as { cnt: number }
  ).cnt;

  const totalVoiceSignatures = (
    db.prepare(`SELECT COUNT(*) as cnt FROM voice_signatures`).get() as { cnt: number }
  ).cnt;

  const lastConsolidationRow = db
    .prepare(`SELECT run_at FROM meta_consolidation_log ORDER BY run_at DESC LIMIT 1`)
    .get() as { run_at: string } | undefined;

  const topTopics = getTopicIndex(db).slice(0, 5);

  // Database file size
  const dbPath = join(homedir(), ".remote-copilot-mcp", "memory.db");
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    // file might not exist yet or be inaccessible
  }

  return {
    totalEpisodes,
    unconsolidatedEpisodes,
    totalSemanticNotes,
    totalProcedures,
    totalVoiceSignatures,
    lastConsolidation: lastConsolidationRow?.run_at ?? null,
    topTopics,
    dbSizeBytes,
  };
}

export function getTopicIndex(db: Database): TopicEntry[] {
  const rows = db
    .prepare(`SELECT * FROM meta_topic_index ORDER BY total_accesses DESC, semantic_count DESC LIMIT 50`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToTopicEntry);
}

function logConsolidation(db: Database, log: ConsolidationLog): void {
  db.prepare(
    `INSERT INTO meta_consolidation_log
       (run_at, episodes_processed, notes_created, duration_ms)
     VALUES (?, ?, ?, ?)`
  ).run(
    nowISO(),
    log.episodesProcessed,
    log.notesCreated,
    log.durationMs
  );
}

// ─── Voice Signatures ────────────────────────────────────────────────────────

export function saveVoiceSignature(
  db: Database,
  sig: {
    episodeId: string;
    emotion?: string;
    arousal?: number;
    dominance?: number;
    valence?: number;
    speechRate?: number;
    meanPitchHz?: number;
    pitchStdHz?: number;
    jitter?: number;
    shimmer?: number;
    hnrDb?: number;
    audioEvents?: Array<{ label: string; confidence: number }>;
    durationSec?: number;
  }
): void {
  db.prepare(
    `INSERT INTO voice_signatures
       (episode_id, emotion, arousal, dominance, valence, speech_rate, mean_pitch_hz, pitch_std_hz, jitter, shimmer, hnr_db, audio_events, duration_sec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sig.episodeId,
    sig.emotion ?? null,
    sig.arousal ?? null,
    sig.dominance ?? null,
    sig.valence ?? null,
    sig.speechRate ?? null,
    sig.meanPitchHz ?? null,
    sig.pitchStdHz ?? null,
    sig.jitter ?? null,
    sig.shimmer ?? null,
    sig.hnrDb ?? null,
    jsonOrNull(sig.audioEvents),
    sig.durationSec ?? null,
    nowISO()
  );
}

function getVoiceBaseline(db: Database, dayRange = 30): VoiceBaseline | null {
  const cutoff = new Date(Date.now() - dayRange * 24 * 60 * 60 * 1000).toISOString();

  const row = db
    .prepare(
      `SELECT
         AVG(arousal)       AS avg_arousal,
         AVG(dominance)     AS avg_dominance,
         AVG(valence)       AS avg_valence,
         AVG(speech_rate)   AS avg_speech_rate,
         AVG(mean_pitch_hz) AS avg_mean_pitch_hz,
         AVG(pitch_std_hz)  AS avg_pitch_std_hz,
         AVG(jitter)        AS avg_jitter,
         AVG(shimmer)       AS avg_shimmer,
         AVG(hnr_db)        AS avg_hnr_db,
         COUNT(*)           AS sample_count
       FROM voice_signatures
       WHERE created_at >= ?`
    )
    .get(cutoff) as Record<string, unknown> | undefined;

  if (!row || (row.sample_count as number) === 0) return null;

  return {
    avgArousal: row.avg_arousal as number | null,
    avgDominance: row.avg_dominance as number | null,
    avgValence: row.avg_valence as number | null,
    avgSpeechRate: row.avg_speech_rate as number | null,
    avgMeanPitchHz: row.avg_mean_pitch_hz as number | null,
    avgPitchStdHz: row.avg_pitch_std_hz as number | null,
    avgJitter: row.avg_jitter as number | null,
    avgShimmer: row.avg_shimmer as number | null,
    avgHnrDb: row.avg_hnr_db as number | null,
    sampleCount: row.sample_count as number,
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export function assembleBootstrap(db: Database, threadId: number): string {
  const status = getMemoryStatus(db, threadId);
  const recentEpisodes = getRecentEpisodes(db, threadId, 5);
  const topNotes = getTopSemanticNotes(db, { limit: 10, sortBy: "access_count" });
  // Preferences first
  const preferences = topNotes.filter((n) => n.type === "preference");
  const otherNotes = topNotes.filter((n) => n.type !== "preference");
  const sortedNotes = [...preferences, ...otherNotes].slice(0, 10);

  const activeProcedures = db
    .prepare(
      `SELECT * FROM procedures ORDER BY times_executed DESC, confidence DESC LIMIT 5`
    )
    .all() as Record<string, unknown>[];
  const procedures = activeProcedures.map(rowToProcedure);

  const baseline = getVoiceBaseline(db);

  const lines: string[] = [];
  lines.push("# Memory Briefing");
  lines.push("");

  // Status
  lines.push("## Status");
  lines.push(`- Episodes: ${status.totalEpisodes} (${status.unconsolidatedEpisodes} unconsolidated)`);
  lines.push(`- Semantic notes: ${status.totalSemanticNotes}`);
  lines.push(`- Procedures: ${status.totalProcedures}`);
  lines.push(`- Voice signatures: ${status.totalVoiceSignatures}`);
  if (status.lastConsolidation) {
    lines.push(`- Last consolidation: ${status.lastConsolidation}`);
  }
  lines.push(`- DB size: ${(status.dbSizeBytes / 1024).toFixed(1)} KB`);
  lines.push("");

  // Recent episodes
  if (recentEpisodes.length > 0) {
    lines.push("## Recent Episodes");
    for (const ep of recentEpisodes) {
      const summary =
        typeof ep.content === "object" && ep.content !== null
          ? (ep.content.text as string) ?? (ep.content.caption as string) ?? JSON.stringify(ep.content).slice(0, 120)
          : String(ep.content).slice(0, 120);
      lines.push(`- [${ep.type}/${ep.modality}] ${summary} (${ep.timestamp})`);
    }
    lines.push("");
  }

  // Key knowledge
  if (sortedNotes.length > 0) {
    lines.push("## Key Knowledge");
    for (const note of sortedNotes) {
      lines.push(`- **[${note.type}]** ${note.content} (conf: ${note.confidence.toFixed(2)}, accessed: ${note.accessCount}x)`);
    }
    lines.push("");
  }

  // Active procedures
  if (procedures.length > 0) {
    lines.push("## Active Procedures");
    for (const proc of procedures) {
      lines.push(
        `- **${proc.name}** (${proc.type}) — success: ${(proc.successRate * 100).toFixed(0)}%, used ${proc.timesExecuted}x`
      );
      if (proc.steps.length > 0) {
        lines.push(`  Steps: ${proc.steps.join(" → ")}`);
      }
    }
    lines.push("");
  }

  // Voice baseline
  if (baseline && baseline.sampleCount > 0) {
    lines.push("## Voice Baseline (30d)");
    lines.push(`- Samples: ${baseline.sampleCount}`);
    if (baseline.avgValence !== null) lines.push(`- Avg valence: ${baseline.avgValence.toFixed(2)}`);
    if (baseline.avgArousal !== null) lines.push(`- Avg arousal: ${baseline.avgArousal.toFixed(2)}`);
    if (baseline.avgSpeechRate !== null) lines.push(`- Avg speech rate: ${baseline.avgSpeechRate.toFixed(1)}`);
    if (baseline.avgMeanPitchHz !== null) lines.push(`- Avg pitch: ${baseline.avgMeanPitchHz.toFixed(1)} Hz`);
    lines.push("");
  }

  // Topics
  if (status.topTopics.length > 0) {
    lines.push("## Top Topics");
    for (const t of status.topTopics) {
      lines.push(`- ${t.topic} (semantic: ${t.semanticCount}, procedural: ${t.proceduralCount})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Compact memory refresh — a condensed briefing for injection during long sessions.
 * Much shorter than full bootstrap. Designed to re-ground the agent after context compaction.
 */
export function assembleCompactRefresh(db: Database, threadId: number): string {
  const topNotes = getTopSemanticNotes(db, { limit: 6, sortBy: "access_count" });
  if (topNotes.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Memory Refresh");
  for (const note of topNotes) {
    lines.push(`- **[${note.type}]** ${note.content}`);
  }
  return lines.join("\n");
}

// ─── Intelligent Consolidation ───────────────────────────────────────────────

// PRIVACY NOTE: This function sends conversation episode excerpts to OpenAI's
// API for knowledge extraction and consolidation. Operators can disable this
// by setting the environment variable CONSOLIDATION_ENABLED=false (or "0").

export async function runIntelligentConsolidation(
  db: Database,
  threadId: number,
  options?: { maxEpisodes?: number; dryRun?: boolean }
): Promise<ConsolidationReport> {
  // Opt-out: allow operators to disable consolidation for privacy reasons
  const consolidationEnabled = process.env.CONSOLIDATION_ENABLED;
  if (consolidationEnabled === "false" || consolidationEnabled === "0") {
    return {
      episodesProcessed: 0,
      notesCreated: 0,
      durationMs: 0,
      details: ["Consolidation disabled via CONSOLIDATION_ENABLED env var."],
    };
  }

  const startMs = Date.now();
  const maxEpisodes = options?.maxEpisodes ?? 30;
  const dryRun = options?.dryRun ?? false;

  const episodes = getUnconsolidatedEpisodes(db, threadId, maxEpisodes);

  if (episodes.length === 0) {
    return {
      episodesProcessed: 0,
      notesCreated: 0,
      durationMs: Date.now() - startMs,
      details: ["Nothing to consolidate."],
    };
  }

  // Format episodes for the prompt
  const episodesText = episodes
    .map((ep, i) => {
      const content =
        typeof ep.content === "object" && ep.content !== null
          ? (ep.content.text as string) ?? (ep.content.caption as string) ?? JSON.stringify(ep.content)
          : String(ep.content);
      return `[${i + 1}] (${ep.type}/${ep.modality}, ${ep.timestamp}) ${content}`;
    })
    .join("\n");

  // ── Contradiction detection: find existing notes related to these episodes ──
  // Extract keywords from episodes to search for potentially conflicting notes
  const episodeWords = episodesText.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3);
  const wordFreq = new Map<string, number>();
  const stopWords = new Set(["this", "that", "with", "from", "have", "been", "will", "would", "could", "should", "about", "there", "their", "which", "when", "what", "were", "they", "than", "then", "also", "just", "more", "some", "into", "over", "after", "before", "other", "very", "your", "here"]);
  for (const w of episodeWords) {
    if (!stopWords.has(w)) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
  }
  const topKeywords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);

  let existingNotesSection = "";
  if (topKeywords.length > 0) {
    try {
      const related = searchSemanticNotesRanked(db, topKeywords.join(" "), {
        maxResults: 15,
        skipAccessTracking: true,
        minMatchRatio: 0.2, // broader recall for contradiction scan
      });
      if (related.length > 0) {
        existingNotesSection = `\n\nExisting memory notes (potentially related):
${related.map(n => `[${n.noteId}] (${n.type}, conf: ${n.confidence}) ${n.content}`).join("\n")}`;
      }
    } catch (_) { /* non-fatal — proceed without existing notes */ }
  }

  const systemPrompt = `You are a memory consolidation agent. Analyze these conversation episodes and extract knowledge that should be remembered across sessions.

Episodes:
${episodesText}${existingNotesSection}

Output a JSON object with:
{
  "notes": [
    {
      "type": "fact" | "preference" | "pattern" | "entity" | "relationship",
      "content": "One clear sentence describing the knowledge",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "confidence": 0.0-1.0,
      "priority": 0 | 1 | 2
    }
  ],
  "supersede": [
    {
      "oldNoteId": "sn_xxx",
      "reason": "Why the old note is outdated/contradicted",
      "newContent": "Updated version of the knowledge",
      "type": "fact",
      "keywords": ["keyword1", "keyword2"],
      "confidence": 0.8,
      "priority": 0 | 1 | 2
    }
  ]
}

Rules:
- Only extract information that would be useful in future sessions
- Preferences are stronger signals than facts (confidence: 0.9)
- Do not extract trivial/transient information
- If the operator corrected the agent, extract the correction as a preference
- Focus on: operator name, preferences, communication style, technical choices, project context
- CRITICAL: Check existing notes for CONTRADICTIONS. If a new episode contradicts or updates an existing note, add a "supersede" entry. The new episodes represent MORE RECENT information.
- Common contradictions: decisions changed, projects completed/abandoned, preferences updated, tools/tech switched
- PRIORITY DETECTION: Infer priority from the operator's language and emotional investment:
  - priority 2 (high importance): operator says "important", "crucial", "I really need", "don't forget", shows strong emotional investment, repeated emphasis
  - priority 1 (notable): operator says "would be nice", "I'd like", "should", mentions something multiple times across conversations
  - priority 0 (normal): default for routine facts, observations, patterns
- Return {"notes": [], "supersede": []} if nothing notable`;

  let notesCreated = 0;
  const details: string[] = [];

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not set");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.CONSOLIDATION_MODEL ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Extract knowledge from the episodes above." },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`OpenAI API error: ${response.status} ${errText}`);
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = result.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      notes?: Array<{
        type: string;
        content: string;
        keywords: string[];
        confidence: number;
        priority?: number;
      }>;
      supersede?: Array<{
        oldNoteId: string;
        reason: string;
        newContent: string;
        type: string;
        keywords: string[];
        confidence: number;
        priority?: number;
      }>;
    };

    const extractedNotes = parsed.notes ?? [];
    const supersedeActions = parsed.supersede ?? [];
    const episodeIds = episodes.map((ep) => ep.episodeId);

    if (!dryRun) {
      for (const note of extractedNotes) {
        const validTypes = ["fact", "preference", "pattern", "entity", "relationship"];
        const noteType = validTypes.includes(note.type)
          ? (note.type as "fact" | "preference" | "pattern" | "entity" | "relationship")
          : "fact";

        saveSemanticNote(db, {
          type: noteType,
          content: note.content,
          keywords: Array.isArray(note.keywords) ? note.keywords : [],
          confidence: Math.max(0, Math.min(1, note.confidence ?? 0.5)),
          priority: Math.max(0, Math.min(2, note.priority ?? 0)),
          threadId: threadId,
          sourceEpisodes: episodeIds,
        });
        notesCreated++;
        details.push(`[${noteType}] ${note.content}`);
      }

      // Execute supersede actions — resolve contradictions with existing notes
      let supersededCount = 0;
      for (const action of supersedeActions) {
        if (!action.oldNoteId || !action.newContent) continue;
        // Verify old note exists and is still active
        const oldNote = db.prepare(
          `SELECT note_id FROM semantic_notes WHERE note_id = ? AND valid_to IS NULL AND superseded_by IS NULL`
        ).get(action.oldNoteId) as { note_id: string } | undefined;
        if (!oldNote) {
          details.push(`[skip-supersede] ${action.oldNoteId} not found or already superseded`);
          continue;
        }
        try {
          const validTypes = ["fact", "preference", "pattern", "entity", "relationship"];
          const noteType = validTypes.includes(action.type) ? action.type : "fact";
          const newId = supersedeNote(db, action.oldNoteId, {
            type: noteType,
            content: action.newContent,
            keywords: Array.isArray(action.keywords) ? action.keywords : [],
            confidence: Math.max(0, Math.min(1, action.confidence ?? 0.8)),
            priority: Math.max(0, Math.min(2, action.priority ?? 0)),
            sourceEpisodes: episodeIds,
          });
          supersededCount++;
          details.push(`[supersede] ${action.oldNoteId} → ${newId}: ${action.reason}`);
        } catch (err) {
          details.push(`[supersede-error] ${action.oldNoteId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (supersededCount > 0) {
        process.stderr.write(`[memory] Contradiction resolution: superseded ${supersededCount} outdated note(s)\n`);
      }

      // Mark episodes as consolidated
      markConsolidated(db, episodeIds);

      // Log the consolidation
      logConsolidation(db, {
        episodesProcessed: episodes.length,
        notesCreated: notesCreated + supersededCount,
        durationMs: Date.now() - startMs,
      });
    } else {
      for (const note of extractedNotes) {
        details.push(`[dry-run] [${note.type}] ${note.content}`);
        notesCreated++;
      }
      for (const action of supersedeActions) {
        details.push(`[dry-run] [supersede] ${action.oldNoteId} → ${action.reason}`);
      }
    }
    } finally { clearTimeout(timer); }
  } catch (err) {
    // Do NOT mark episodes as consolidated on failure — they should be
    // retried on the next consolidation run.  Previously this was a silent
    // data-loss bug: a transient OpenAI outage would permanently lose the
    // episodes' knowledge without extracting anything.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[memory] Intelligent consolidation failed (episodes NOT marked): ${msg}\n`);
    details.push(`Consolidation failed (will retry): ${msg}`);
  }

  return {
    episodesProcessed: episodes.length,
    notesCreated,
    durationMs: Date.now() - startMs,
    details,
  };
}

// ─── Forget ──────────────────────────────────────────────────────────────────

export function forgetMemory(
  db: Database,
  memoryId: string,
  reason: string
): { layer: string; deleted: boolean } {
  // Determine layer by prefix
  if (memoryId.startsWith("ep_")) {
    const existing = db.prepare(`SELECT episode_id FROM episodes WHERE episode_id = ?`).get(memoryId);
    if (!existing) return { layer: "episodic", deleted: false };
    db.transaction(() => {
      db.prepare(`DELETE FROM episodes WHERE episode_id = ?`).run(memoryId);
      // Also delete associated voice signature
      db.prepare(`DELETE FROM voice_signatures WHERE episode_id = ?`).run(memoryId);
    })();
    return { layer: "episodic", deleted: true };
  }

  if (memoryId.startsWith("sn_")) {
    const existing = db.prepare(`SELECT note_id, keywords FROM semantic_notes WHERE note_id = ?`).get(memoryId) as { note_id: string; keywords: string | null } | undefined;
    if (!existing) return { layer: "semantic", deleted: false };
    const kws = parseJsonArray(existing.keywords);
    db.transaction(() => {
      db.prepare(`DELETE FROM semantic_notes WHERE note_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM note_embeddings WHERE note_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, kws, "semantic");
    })();
    return { layer: "semantic", deleted: true };
  }

  if (memoryId.startsWith("pr_")) {
    const existing = db.prepare(`SELECT procedure_id, name FROM procedures WHERE procedure_id = ?`).get(memoryId) as { procedure_id: string; name: string } | undefined;
    if (!existing) return { layer: "procedural", deleted: false };
    const kws = existing.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    db.transaction(() => {
      db.prepare(`DELETE FROM procedures WHERE procedure_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, kws, "procedural");
    })();
    return { layer: "procedural", deleted: true };
  }

  // Unknown prefix — try all layers
  let row = db.prepare(`SELECT episode_id FROM episodes WHERE episode_id = ?`).get(memoryId);
  if (row) {
    db.transaction(() => {
      db.prepare(`DELETE FROM episodes WHERE episode_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM voice_signatures WHERE episode_id = ?`).run(memoryId);
    })();
    return { layer: "episodic", deleted: true };
  }

  row = db.prepare(`SELECT note_id, keywords FROM semantic_notes WHERE note_id = ?`).get(memoryId) as { note_id: string; keywords: string | null } | undefined;
  if (row) {
    const kws = parseJsonArray((row as { keywords: string | null }).keywords);
    db.transaction(() => {
      db.prepare(`DELETE FROM semantic_notes WHERE note_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM note_embeddings WHERE note_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, kws, "semantic");
    })();
    return { layer: "semantic", deleted: true };
  }

  row = db.prepare(`SELECT procedure_id, name FROM procedures WHERE procedure_id = ?`).get(memoryId) as { procedure_id: string; name: string } | undefined;
  if (row) {
    const kws = ((row as { name: string }).name).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    db.transaction(() => {
      db.prepare(`DELETE FROM procedures WHERE procedure_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, kws, "procedural");
    })();
    return { layer: "procedural", deleted: true };
  }

  return { layer: "unknown", deleted: false };
}

// ─── Embedding-based Semantic Search ─────────────────────────────────────────

/** Store a pre-computed embedding vector for a semantic note. */
export function saveNoteEmbedding(db: Database, noteId: string, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    db.prepare(
      `INSERT OR REPLACE INTO note_embeddings (note_id, embedding, model, created_at) VALUES (?, ?, ?, ?)`
    ).run(noteId, buf, "text-embedding-3-small", nowISO());
}

/** Load all note embeddings into memory for cosine similarity search. */
export function loadAllEmbeddings(db: Database, threadId?: number): Map<string, Float32Array> {
    // When threadId is provided, return embeddings for notes in that thread OR global notes (thread_id IS NULL)
    let sql = `SELECT ne.note_id, ne.embedding FROM note_embeddings ne
       JOIN semantic_notes sn ON sn.note_id = ne.note_id
       WHERE sn.valid_to IS NULL AND sn.superseded_by IS NULL`;
    const params: unknown[] = [];
    if (threadId !== undefined) {
      sql += ` AND (sn.thread_id IS NULL OR sn.thread_id = ?)`;
      params.push(threadId);
    }
    const rows = db.prepare(sql).all(...params) as { note_id: string; embedding: Buffer }[];

    const map = new Map<string, Float32Array>();
    for (const row of rows) {
        map.set(row.note_id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    }
    return map;
}

/**
 * Search semantic notes using embedding cosine similarity.
 * Returns notes sorted by similarity score, filtered by minimum threshold.
 */
export function searchByEmbedding(
    db: Database,
    queryEmbedding: Float32Array,
    options?: { maxResults?: number; minSimilarity?: number; skipAccessTracking?: boolean; threadId?: number }
): (SemanticNote & { similarity: number })[] {
    const maxResults = options?.maxResults ?? 5;
    const minSimilarity = options?.minSimilarity ?? 0.3;

    // Load embeddings — filtered by thread when provided
    const embeddings = loadAllEmbeddings(db, options?.threadId);

    // Compute similarities
    const scores: { noteId: string; similarity: number }[] = [];
    for (const [noteId, emb] of embeddings) {
        const sim = cosineSimilarity(queryEmbedding, emb);
        if (sim >= minSimilarity) {
            scores.push({ noteId, similarity: sim });
        }
    }

    // Sort by similarity descending
    scores.sort((a, b) => b.similarity - a.similarity);
    const topIds = scores.slice(0, maxResults);

    if (topIds.length === 0) return [];

    // Fetch full notes
    const placeholders = topIds.map(() => "?").join(",");
    const rows = db.prepare(
        `SELECT * FROM semantic_notes WHERE note_id IN (${placeholders})`
    ).all(...topIds.map(s => s.noteId)) as Record<string, unknown>[];

    const noteMap = new Map<string, SemanticNote>();
    for (const row of rows) {
        const note = rowToSemanticNote(row);
        noteMap.set(note.noteId, note);
    }

    // Update access counts
    if (!options?.skipAccessTracking) {
        const now = nowISO();
        const updateStmt = db.prepare(
            `UPDATE semantic_notes SET access_count = access_count + 1, last_accessed = ? WHERE note_id = ?`
        );
        db.transaction(() => {
            for (const s of topIds) updateStmt.run(now, s.noteId);
        })();
    }

    // Return in similarity order
    return topIds
        .map(s => {
            const note = noteMap.get(s.noteId);
            return note ? { ...note, similarity: s.similarity } : null;
        })
        .filter((n): n is SemanticNote & { similarity: number } => n !== null);
}

/** Get note IDs that don't have embeddings yet (for backfill). */
export function getNotesWithoutEmbeddings(db: Database): { noteId: string; content: string }[] {
    return db.prepare(
        `SELECT sn.note_id as noteId, sn.content FROM semantic_notes sn
         LEFT JOIN note_embeddings ne ON ne.note_id = sn.note_id
         WHERE ne.note_id IS NULL AND sn.valid_to IS NULL AND sn.superseded_by IS NULL`
    ).all() as { noteId: string; content: string }[];
}

/**
 * Backfill thread_id on existing semantic notes that lack it.
 * Infers thread from source episodes. Notes with no episode links remain global (NULL).
 * Returns the number of notes updated.
 */
export function backfillNoteThreadIds(db: Database): number {
  const notes = db.prepare(
    `SELECT note_id, source_episodes FROM semantic_notes WHERE thread_id IS NULL AND valid_to IS NULL AND superseded_by IS NULL`
  ).all() as { note_id: string; source_episodes: string | null }[];

  if (notes.length === 0) return 0;

  const update = db.prepare(`UPDATE semantic_notes SET thread_id = ? WHERE note_id = ?`);
  let updated = 0;

  const txn = db.transaction(() => {
    for (const note of notes) {
      const episodeIds = parseJsonArray(note.source_episodes);
      if (episodeIds.length === 0) continue;

      // Find the most common thread_id among source episodes
      const placeholders = episodeIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT thread_id, COUNT(*) as cnt FROM episodes WHERE episode_id IN (${placeholders}) GROUP BY thread_id ORDER BY cnt DESC LIMIT 1`
      ).all(...episodeIds) as { thread_id: number; cnt: number }[];

      if (rows.length > 0 && rows[0].thread_id != null) {
        update.run(rows[0].thread_id, note.note_id);
        updated++;
      }
    }
  });
  txn();

  return updated;
}
