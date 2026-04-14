import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "./schema.js";
import { getRecentEpisodes, type Episode } from "./episodes.js";
import {
  getTopSemanticNotes,
  getGuardrailNotes,
  getPinnedNotes,
  decrementTopicIndexForKeywords,
  type SemanticNote,
} from "./semantic.js";
import { rowToProcedure, type Procedure } from "./procedures.js";
import { getVoiceBaseline } from "./voice-sig.js";
import { parseJsonArray } from "./utils.js";
import { getNarrativesForBootstrap } from "./narrative.js";
import { getThread } from "./thread-registry.js";
import { getGuardrailsEnabled, getBootstrapMessageCount, resolveKnowledgeThreadId } from "../../config.js";

export const MAX_BOOTSTRAP_CONVERSATION_CHARS = 100_000;
export const MAX_MESSAGE_CONTENT_CHARS = 500;

export interface TopicEntry {
  topic: string;
  semanticCount: number;
  proceduralCount: number;
  lastUpdated: string | null;
  avgConfidence: number;
  totalAccesses: number;
}

export interface MemoryStatus {
  totalEpisodes: number;
  unconsolidatedEpisodes: number;
  totalSemanticNotes: number;
  totalProcedures: number;
  totalVoiceSignatures: number;
  lastConsolidation: string | null;
  topTopics: TopicEntry[];
  dbSizeBytes: number;
}

export interface BootstrapNarratives {
  half_year?: string;
  quarter?: string;
  month?: string;
  week?: string;
  day?: string;
}

export interface BootstrapReflection {
  content: string;
  confidence: number;
  createdAt: string;
}

export interface BootstrapContext {
  identityPrompt?: string;
  threadId: number;
  queryThreadId: number;
  memorySourceThreadId?: number;
  recentEpisodes: Episode[];
  guardrails: SemanticNote[];
  pinnedNotes: SemanticNote[];
  keyKnowledge: SemanticNote[];
  procedures: Procedure[];
  baseline: ReturnType<typeof getVoiceBaseline>;
  narratives: BootstrapNarratives | null;
  reflections: BootstrapReflection[];
}

interface ReflectionRow {
  content: string;
  confidence: number;
  created_at: string;
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

export function getMemoryStatus(db: Database, threadId: number): MemoryStatus {
  const totalEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes`).get() as { cnt: number }).cnt;
  const unconsolidatedEpisodes = (db.prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE consolidated = 0`).get() as { cnt: number }).cnt;
  const totalSemanticNotes = (
    db.prepare(`SELECT COUNT(*) as cnt FROM semantic_notes WHERE valid_to IS NULL AND superseded_by IS NULL AND thread_id = ?`).get(threadId) as { cnt: number }
  ).cnt;
  const totalProcedures = (db.prepare(`SELECT COUNT(*) as cnt FROM procedures`).get() as { cnt: number }).cnt;
  const totalVoiceSignatures = (db.prepare(`SELECT COUNT(*) as cnt FROM voice_signatures`).get() as { cnt: number }).cnt;
  const lastConsolidationRow = db
    .prepare(`SELECT run_at FROM meta_consolidation_log ORDER BY run_at DESC LIMIT 1`)
    .get() as { run_at: string } | undefined;

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
    topTopics: getTopicIndex(db).slice(0, 5),
    dbSizeBytes,
  };
}

export function getTopicIndex(db: Database): TopicEntry[] {
  const rows = db
    .prepare(`SELECT * FROM meta_topic_index ORDER BY total_accesses DESC, semantic_count DESC LIMIT 50`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToTopicEntry);
}

export function getBootstrapContext(
  db: Database,
  threadId: number,
  memorySourceThreadId?: number,
): BootstrapContext {
  const queryThreadId = memorySourceThreadId ?? threadId;
  const knowledgeThreadId = resolveKnowledgeThreadId(queryThreadId);
  const bootstrapMessageCount = getBootstrapMessageCount();
  const threadEntry = getThread(db, queryThreadId);
  const sessionResetAt = threadEntry?.sessionResetAt ?? undefined;
  const recentEpisodes = [...getRecentEpisodes(
    db,
    queryThreadId,
    bootstrapMessageCount,
    sessionResetAt ? { since: sessionResetAt } : undefined,
  )].reverse();

  const topNotes = getTopSemanticNotes(db, { limit: 20, sortBy: "access_count", threadId: knowledgeThreadId });
  const preferences = topNotes.filter((note) => note.type === "preference");
  const otherNotes = topNotes.filter((note) => note.type !== "preference");
  const pinnedNotes = getPinnedNotes(db, knowledgeThreadId);
  const pinnedIds = new Set(pinnedNotes.map((note) => note.noteId));

  const procedures = db
    .prepare(`SELECT * FROM procedures ORDER BY times_executed DESC, confidence DESC LIMIT 5`)
    .all() as Record<string, unknown>[];

  let narratives: BootstrapNarratives | null = null;
  try {
    const fetched = getNarrativesForBootstrap(db, knowledgeThreadId);
    if (fetched.half_year || fetched.quarter || fetched.month || fetched.week || fetched.day) {
      narratives = {
        half_year: fetched.half_year ?? undefined,
        quarter: fetched.quarter ?? undefined,
        month: fetched.month ?? undefined,
        week: fetched.week ?? undefined,
        day: fetched.day ?? undefined,
      };
    }
  } catch {
    narratives = null;
  }

  let reflections: BootstrapReflection[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT content, confidence, created_at FROM semantic_notes
         WHERE content LIKE '[REFLECTION]%'
           AND valid_to IS NULL AND superseded_by IS NULL AND thread_id = ?
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(knowledgeThreadId) as ReflectionRow[];
    reflections = rows.map((row) => ({
      content: row.content,
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
  } catch {
    reflections = [];
  }

  return {
    identityPrompt: threadEntry?.identityPrompt ?? undefined,
    threadId,
    queryThreadId,
    memorySourceThreadId,
    recentEpisodes,
    guardrails: getGuardrailsEnabled() ? getGuardrailNotes(db) : [],
    pinnedNotes,
    keyKnowledge: [...preferences, ...otherNotes].slice(0, 20).filter((note) => !pinnedIds.has(note.noteId)),
    procedures: procedures.map(rowToProcedure),
    baseline: getVoiceBaseline(db),
    narratives,
    reflections,
  };
}

export function getCompactRefreshNotes(db: Database, threadId: number): SemanticNote[] {
  return getTopSemanticNotes(db, {
    limit: 12,
    sortBy: "access_count",
    threadId: resolveKnowledgeThreadId(threadId),
  });
}

export function forgetMemory(
  db: Database,
  memoryId: string,
  _reason: string,
): { layer: string; deleted: boolean } {
  if (memoryId.startsWith("ep_")) {
    const existing = db.prepare(`SELECT episode_id FROM episodes WHERE episode_id = ?`).get(memoryId);
    if (!existing) return { layer: "episodic", deleted: false };
    db.transaction(() => {
      db.prepare(`DELETE FROM episodes WHERE episode_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM voice_signatures WHERE episode_id = ?`).run(memoryId);
    })();
    return { layer: "episodic", deleted: true };
  }

  if (memoryId.startsWith("sn_")) {
    const existing = db.prepare(`SELECT note_id, keywords FROM semantic_notes WHERE note_id = ?`).get(memoryId) as { note_id: string; keywords: string | null } | undefined;
    if (!existing) return { layer: "semantic", deleted: false };
    const keywords = parseJsonArray(existing.keywords);
    db.transaction(() => {
      db.prepare(`DELETE FROM semantic_notes WHERE note_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM note_embeddings WHERE note_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, keywords, "semantic");
    })();
    return { layer: "semantic", deleted: true };
  }

  if (memoryId.startsWith("pr_")) {
    const existing = db.prepare(`SELECT procedure_id, name FROM procedures WHERE procedure_id = ?`).get(memoryId) as { procedure_id: string; name: string } | undefined;
    if (!existing) return { layer: "procedural", deleted: false };
    const keywords = existing.name.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
    db.transaction(() => {
      db.prepare(`DELETE FROM procedures WHERE procedure_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, keywords, "procedural");
    })();
    return { layer: "procedural", deleted: true };
  }

  const episodeRow = db.prepare(`SELECT episode_id FROM episodes WHERE episode_id = ?`).get(memoryId) as { episode_id: string } | undefined;
  if (episodeRow) {
    db.transaction(() => {
      db.prepare(`DELETE FROM episodes WHERE episode_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM voice_signatures WHERE episode_id = ?`).run(memoryId);
    })();
    return { layer: "episodic", deleted: true };
  }

  const noteRow = db.prepare(`SELECT note_id, keywords FROM semantic_notes WHERE note_id = ?`).get(memoryId) as { note_id: string; keywords: string | null } | undefined;
  if (noteRow) {
    const keywords = parseJsonArray(noteRow.keywords);
    db.transaction(() => {
      db.prepare(`DELETE FROM semantic_notes WHERE note_id = ?`).run(memoryId);
      db.prepare(`DELETE FROM note_embeddings WHERE note_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, keywords, "semantic");
    })();
    return { layer: "semantic", deleted: true };
  }

  const procRow = db.prepare(`SELECT procedure_id, name FROM procedures WHERE procedure_id = ?`).get(memoryId) as { procedure_id: string; name: string } | undefined;
  if (procRow) {
    const keywords = procRow.name.toLowerCase().split(/\s+/).filter((word: string) => word.length > 2);
    db.transaction(() => {
      db.prepare(`DELETE FROM procedures WHERE procedure_id = ?`).run(memoryId);
      decrementTopicIndexForKeywords(db, keywords, "procedural");
    })();
    return { layer: "procedural", deleted: true };
  }

  return { layer: "unknown", deleted: false };
}
