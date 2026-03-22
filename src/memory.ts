import { randomUUID } from "crypto";
import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "./logger.js";
import type { Database } from "./data/memory/schema.js";

export { initMemoryDb } from "./data/memory/schema.js";
export type { Database } from "./data/memory/schema.js";
export { saveEpisode, getRecentEpisodes, type Episode } from "./data/memory/episodes.js";
import { getRecentEpisodes, getUnconsolidatedEpisodes, markConsolidated } from "./data/memory/episodes.js";
export {
  type SemanticNote,
  saveSemanticNote,
  searchSemanticNotes,
  searchSemanticNotesRanked,
  getTopSemanticNotes,
  updateSemanticNote,
  supersedeNote,
  saveNoteEmbedding,
  searchByEmbedding,
  getNotesWithoutEmbeddings,
  updateTopicIndexForKeywords,
  decrementTopicIndexForKeywords,
} from "./data/memory/semantic.js";
import {
  saveSemanticNote,
  searchSemanticNotesRanked,
  supersedeNote,
  getTopSemanticNotes,
  updateTopicIndexForKeywords,
  decrementTopicIndexForKeywords,
} from "./data/memory/semantic.js";
export {
  type Procedure,
  rowToProcedure,
  saveProcedure,
  searchProcedures,
  updateProcedure,
} from "./data/memory/procedures.js";
import { rowToProcedure } from "./data/memory/procedures.js";
export {
  type VoiceBaseline,
  saveVoiceSignature,
  getVoiceBaseline,
} from "./data/memory/voice-sig.js";
import { getVoiceBaseline } from "./data/memory/voice-sig.js";

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



// ─── Row → Interface mappers ─────────────────────────────────────────────────

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
        log.info(`[memory] Contradiction resolution: superseded ${supersededCount} outdated note(s)`);
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
    log.error(`[memory] Intelligent consolidation failed (episodes NOT marked): ${msg}`);
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


