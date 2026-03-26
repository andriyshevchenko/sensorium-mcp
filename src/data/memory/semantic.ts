/**
 * Semantic note CRUD operations for the memory system.
 *
 * Extracted from memory.ts — semantic memory layer.
 */

import type { Database } from "./schema.js";
import { generateId, nowISO, jsonOrNull, parseJsonArray, parseJsonObject } from "./utils.js";
import { cosineSimilarity } from "../../openai.js";

// ─── Type Definitions ────────────────────────────────────────────────────────

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
  isGuardrail: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum guardrail notes returned by getGuardrailNotes. */
const GUARDRAIL_LIMIT = 5;

/** Minimum shared keywords required to flag a note as a potential conflict. */
const MIN_KEYWORD_OVERLAP = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Increment access_count and update last_accessed for a batch of note IDs. */
function bumpAccessCounts(db: Database, noteIds: string[]): void {
  if (noteIds.length === 0) return;
  const now = nowISO();
  const stmt = db.prepare(
    `UPDATE semantic_notes SET access_count = access_count + 1, last_accessed = ? WHERE note_id = ?`
  );
  db.transaction(() => {
    for (const id of noteIds) stmt.run(now, id);
  })();
}

// ─── Row → Interface mappers ─────────────────────────────────────────────────

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
    isGuardrail: (row.is_guardrail as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ─── Topic Index ─────────────────────────────────────────────────────────────

export function updateTopicIndexForKeywords(db: Database, keywords: string[], layer: "semantic" | "procedural"): void {
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

export function decrementTopicIndexForKeywords(db: Database, keywords: string[], layer: "semantic" | "procedural"): void {
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

// ─── Semantic Memory CRUD ────────────────────────────────────────────────────

/** Look up a single semantic note by ID (returns type + keywords only, or undefined). */
export function getSemanticNoteById(
  db: Database,
  noteId: string,
): { type: string; keywords: string[] } | undefined {
  const row = db.prepare(
    "SELECT type, keywords FROM semantic_notes WHERE note_id = ?"
  ).get(noteId) as { type: string; keywords: string } | undefined;
  if (!row) return undefined;
  return { type: row.type, keywords: parseJsonArray(row.keywords) };
}

export function saveSemanticNote(
  db: Database,
  note: {
    type: "fact" | "preference" | "pattern" | "entity" | "relationship";
    content: string;
    keywords: string[];
    confidence?: number;
    priority?: number;
    threadId?: number | null;
    isGuardrail?: boolean;
    sourceEpisodes?: string[];
  }
): string {
  const id = generateId("sn");
  const now = nowISO();

  db.prepare(
    `INSERT INTO semantic_notes
       (note_id, type, content, keywords, confidence, priority, thread_id, is_guardrail, source_episodes, linked_notes, link_reasons, valid_from, access_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    note.type,
    note.content,
    JSON.stringify(note.keywords),
    Math.max(0, Math.min(1, note.confidence ?? 0.5)),
    Math.max(0, Math.min(2, note.priority ?? 0)),
    note.threadId ?? null,
    note.isGuardrail ? 1 : 0,
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
    bumpAccessCounts(db, rows.map(r => r.note_id as string));
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
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  // Use OR to get broad recall
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const term of terms) {
    const escaped = term.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(`(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(keywords) LIKE ? ESCAPE '\\')`);
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
  const allNotes = rows.map(rowToSemanticNote);

  // Score by how many terms match
  const minMatches = Math.max(2, Math.ceil(terms.length * minMatchRatio));
  const scored = allNotes.map(n => {
    const text = (n.content + " " + n.keywords.join(" ")).toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      if (text.includes(term)) matchCount++;
    }
    return { ...n, _matchCount: matchCount };
  })
  .filter(n => n._matchCount >= minMatches)
  .sort((a, b) => {
    if (b._matchCount !== a._matchCount) return b._matchCount - a._matchCount;
    return b.confidence - a.confidence;
  })
  .slice(0, maxResults);
  const notes: SemanticNote[] = scored;

  // Update access counts
  if (!options?.skipAccessTracking) {
    bumpAccessCounts(db, notes.map(n => n.noteId));
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

/**
 * Guardrail notes: explicitly flagged decision constraints the LLM must always
 * follow. Capped at 5, ordered by priority DESC then access_count DESC.
 */
export function getGuardrailNotes(db: Database): SemanticNote[] {
  const rows = db
    .prepare(
      `SELECT * FROM semantic_notes
       WHERE valid_to IS NULL AND superseded_by IS NULL
         AND is_guardrail = 1
       ORDER BY priority DESC, access_count DESC, confidence DESC
       LIMIT ?`
    )
    .all(GUARDRAIL_LIMIT) as Record<string, unknown>[];
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
  // Inherit thread_id and is_guardrail from the old note being superseded
  const oldRow = db.prepare(`SELECT thread_id, is_guardrail FROM semantic_notes WHERE note_id = ?`).get(oldNoteId) as { thread_id: number | null; is_guardrail: number } | undefined;
  const newId = saveSemanticNote(db, {
    type: newNote.type as SemanticNote["type"],
    content: newNote.content,
    keywords: newNote.keywords,
    confidence: newNote.confidence,
    priority: newNote.priority,
    threadId: oldRow?.thread_id ?? null,
    isGuardrail: (oldRow?.is_guardrail ?? 0) === 1,
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

// ─── Embedding-based Semantic Search ─────────────────────────────────────────

/** Store a pre-computed embedding vector for a semantic note. */
export function saveNoteEmbedding(db: Database, noteId: string, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    db.prepare(
      `INSERT OR REPLACE INTO note_embeddings (note_id, embedding, model, created_at) VALUES (?, ?, ?, ?)`
    ).run(noteId, buf, "text-embedding-3-small", nowISO());
}

/** Load all note embeddings into memory for cosine similarity search. */
function loadAllEmbeddings(db: Database, threadId?: number): Map<string, Float32Array> {
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
        bumpAccessCounts(db, topIds.map(s => s.noteId));
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
 * Find semantic notes that potentially conflict with a given note
 * by sharing >= 2 keywords of the same type.
 */
export function findPotentialConflicts(
  db: Database,
  noteId: string,
): SemanticNote[] {
  const row = db.prepare(
    `SELECT note_id, type, keywords FROM semantic_notes WHERE note_id = ?`
  ).get(noteId) as { note_id: string; type: string; keywords: string } | undefined;

  if (!row) return [];

  const noteKeywords: string[] = row.keywords ? JSON.parse(row.keywords) : [];
  if (noteKeywords.length < MIN_KEYWORD_OVERLAP) return [];

  // Fetch all active notes of the same type (excluding this note and superseded ones)
  const candidates = db.prepare(
    `SELECT * FROM semantic_notes
     WHERE type = ? AND note_id != ? AND valid_to IS NULL AND superseded_by IS NULL`
  ).all(row.type, noteId) as Record<string, unknown>[];

  const lowerKeywords = new Set(noteKeywords.map(k => k.toLowerCase()));

  return candidates
    .filter(c => {
      const cKeywords: string[] = c.keywords ? JSON.parse(c.keywords as string) : [];
      const overlap = cKeywords.filter(k => lowerKeywords.has(k.toLowerCase())).length;
      return overlap >= MIN_KEYWORD_OVERLAP;
    })
    .map(rowToSemanticNote);
}
