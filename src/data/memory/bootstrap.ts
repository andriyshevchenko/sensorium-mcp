/**
 * Session memory bootstrap / briefing assembly.
 *
 * Extracted from memory.ts — assembles the memory briefing injected at
 * session start, provides memory status, topic index, forget, and
 * compact refresh helpers.
 */

import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Database } from "./schema.js";
import { getRecentEpisodes } from "./episodes.js";
import {
  getTopSemanticNotes,
  decrementTopicIndexForKeywords,
} from "./semantic.js";
import { rowToProcedure } from "./procedures.js";
import { getVoiceBaseline } from "./voice-sig.js";

// ─── Type Definitions ────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
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

// ─── Memory Status ───────────────────────────────────────────────────────────

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

// ─── Topic Index ─────────────────────────────────────────────────────────────

export function getTopicIndex(db: Database): TopicEntry[] {
  const rows = db
    .prepare(`SELECT * FROM meta_topic_index ORDER BY total_accesses DESC, semantic_count DESC LIMIT 50`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToTopicEntry);
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
export function assembleCompactRefresh(db: Database, _threadId: number): string {
  const topNotes = getTopSemanticNotes(db, { limit: 6, sortBy: "access_count" });
  if (topNotes.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Memory Refresh");
  for (const note of topNotes) {
    lines.push(`- **[${note.type}]** ${note.content}`);
  }
  return lines.join("\n");
}

// ─── Forget ──────────────────────────────────────────────────────────────────

export function forgetMemory(
  db: Database,
  memoryId: string,
  _reason: string
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
