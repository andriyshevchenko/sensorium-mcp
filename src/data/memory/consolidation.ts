import type { Database } from "./schema.js";
import { cleanupOldSentMessages } from "./schema.js";
import { getUnconsolidatedEpisodes, markConsolidated } from "./episodes.js";
import {
  saveSemanticNote,
  searchSemanticNotesRanked,
  supersedeNote,
  archiveNotesForThread,
  getThreadIdsWithActiveNotes,
  searchByEmbedding,
  saveNoteEmbedding,
} from "./semantic.js";
import { log } from "../../logger.js";
import { resolveKnowledgeThreadId } from "../../config.js";
import { nowISO, repairAndParseJSON } from "./utils.js";
import { chatCompletion, generateEmbedding, type ChatMessage } from "../../integrations/openai/chat.js";
import { errorMessage } from "../../utils.js";
import { getAllThreads } from "./thread-registry.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConsolidationReport {
  episodesProcessed: number;
  notesCreated: number;
  durationMs: number;
  details: string[];
}

interface ConsolidationLog {
  episodesProcessed: number;
  notesCreated: number;
  durationMs: number;
}

interface PruningReport {
  notesScanned: number;
  notesExpired: number;
  notesMerged: number;
  durationMs: number;
  details: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logConsolidation(db: Database, entry: ConsolidationLog): void {
  db.prepare(
    `INSERT INTO meta_consolidation_log
       (run_at, episodes_processed, notes_created, duration_ms)
     VALUES (?, ?, ?, ?)`
  ).run(
    nowISO(),
    entry.episodesProcessed,
    entry.notesCreated,
    entry.durationMs
  );
}


// ─── Write-time deduplication ────────────────────────────────────────────────

const CONSOLIDATION_DEDUP_THRESHOLD = 0.85;

async function checkConsolidationDuplicate(
  db: Database,
  content: string,
  apiKey: string,
  threadId: number,
): Promise<{ isDuplicate: boolean; matchId?: string; similarity?: number; embedding: Float32Array | null }> {
  try {
    const embedding = await generateEmbedding(content, apiKey);
    const matches = searchByEmbedding(db, embedding, {
      maxResults: 1,
      minSimilarity: CONSOLIDATION_DEDUP_THRESHOLD,
      skipAccessTracking: true,
      threadId,
    });
    const match = matches.find((m) => m.similarity >= CONSOLIDATION_DEDUP_THRESHOLD);
    if (match) {
      return { isDuplicate: true, matchId: match.noteId, similarity: match.similarity, embedding };
    }
    return { isDuplicate: false, embedding };
  } catch (err) {
    log.warn(`[consolidation] Dedup embedding check failed, proceeding without dedup: ${err instanceof Error ? err.message : err}`);
    return { isDuplicate: false, embedding: null };
  }
}

// ─── Orphaned Notes Sweep ────────────────────────────────────────────────────

/** Terminal thread statuses that indicate notes should be expired. */
const TERMINAL_THREAD_STATUSES = new Set(['archived', 'expired', 'exited']);

/**
 * Find threads with active semantic notes whose registry status is terminal
 * (archived/expired/exited) and expire those notes.
 * Returns total number of notes archived.
 */
function sweepOrphanedNotes(db: Database): number {
  const threadIdsWithNotes = getThreadIdsWithActiveNotes(db);
  if (threadIdsWithNotes.length === 0) return 0;

  const allThreads = getAllThreads(db);
  const threadStatusMap = new Map(allThreads.map(t => [t.threadId, t.status]));

  let totalArchived = 0;
  for (const threadId of threadIdsWithNotes) {
    const status = threadStatusMap.get(threadId);
    // Archive notes for terminal threads AND threads missing from registry
    if (!status || TERMINAL_THREAD_STATUSES.has(status)) {
      totalArchived += archiveNotesForThread(db, threadId);
    }
  }

  if (totalArchived > 0) {
    log.info(`[memory] Orphan sweep: archived ${totalArchived} notes from dead threads`);
  }
  return totalArchived;
}

// ─── Intelligent Consolidation ───────────────────────────────────────────────

// PRIVACY NOTE: This function sends conversation episode excerpts to OpenAI's
// API for knowledge extraction and consolidation. Operators can disable this
// by setting the environment variable CONSOLIDATION_ENABLED=false (or "0").

let consolidationInProgress = false;

/**
 * Consolidate ALL threads that have unconsolidated episodes.
 * Iterates distinct thread_ids and runs per-thread consolidation for each.
 * Returns an aggregated report.
 *
 * Owns the global `consolidationInProgress` lock so that per-thread calls
 * within the loop don't block each other and concurrent invocations are
 * properly serialized.
 */
export async function runConsolidationAllThreads(
  db: Database,
  options?: { maxEpisodesPerThread?: number; dryRun?: boolean }
): Promise<ConsolidationReport> {
  if (consolidationInProgress) {
    log.info("Consolidation already in progress — skipping (all-threads)");
    return {
      episodesProcessed: 0,
      notesCreated: 0,
      durationMs: 0,
      details: ["Skipped — consolidation already in progress."],
    };
  }

  consolidationInProgress = true;
  try {

  const startMs = Date.now();
  const threadRows = db
    .prepare(`SELECT DISTINCT thread_id FROM episodes WHERE consolidated = 0`)
    .all() as { thread_id: number }[];

  if (threadRows.length === 0) {
    return {
      episodesProcessed: 0,
      notesCreated: 0,
      durationMs: Date.now() - startMs,
      details: ["Nothing to consolidate across any thread."],
    };
  }

  let totalProcessed = 0;
  let totalNotes = 0;
  const allDetails: string[] = [];

  for (const { thread_id } of threadRows) {
    const report = await runIntelligentConsolidation(db, thread_id, {
      maxEpisodes: options?.maxEpisodesPerThread ?? 30,
      dryRun: options?.dryRun,
      _skipLock: true, // lock is held by this function
    });
    totalProcessed += report.episodesProcessed;
    totalNotes += report.notesCreated;
    allDetails.push(`Thread ${thread_id}: ${report.episodesProcessed} eps → ${report.notesCreated} notes`);
  }

  // Phase 2: Memory pruning — scan for outdated, duplicate, or low-quality notes
  try {
    const pruneReport = await runMemoryPruning(db);
    if (pruneReport.notesExpired + pruneReport.notesMerged > 0) {
      allDetails.push(`Pruning: scanned ${pruneReport.notesScanned}, expired ${pruneReport.notesExpired}, merged ${pruneReport.notesMerged}`);
      allDetails.push(...pruneReport.details);
    }
  } catch (err) {
    log.warn(`[memory] Pruning phase failed: ${errorMessage(err)}`);
  }

  // Phase 3: Orphaned notes sweep — expire notes for dead/archived threads
  try {
    const orphanedCount = sweepOrphanedNotes(db);
    if (orphanedCount > 0) {
      allDetails.push(`Orphan sweep: archived ${orphanedCount} notes from dead threads`);
    }
  } catch (err) {
    log.warn(`[memory] Orphan notes sweep failed: ${errorMessage(err)}`);
  }

  return {
    episodesProcessed: totalProcessed,
    notesCreated: totalNotes,
    durationMs: Date.now() - startMs,
    details: allDetails,
  };

  } finally {
    consolidationInProgress = false;
  }
}

export async function runIntelligentConsolidation(
  db: Database,
  threadId: number,
  options?: { maxEpisodes?: number; dryRun?: boolean; _skipLock?: boolean }
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

  const skipLock = options?._skipLock ?? false;

  if (!skipLock && consolidationInProgress) {
    log.info("Consolidation already in progress — skipping");
    return {
      episodesProcessed: 0,
      notesCreated: 0,
      durationMs: 0,
      details: ["Skipped — consolidation already in progress."],
    };
  }

  if (!skipLock) consolidationInProgress = true;
  try {

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
      const c = ep.content as Record<string, unknown>;
      let content: string;
      if (c && typeof c === "object") {
        content = (c.text as string) ?? (c.caption as string) ?? JSON.stringify(c);
      } else {
        content = JSON.stringify(ep.content);
      }
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
    } catch (err) { log.warn(`[consolidation] searchSemanticNotesRanked failed during contradiction scan: ${errorMessage(err)}`); }
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

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Extract knowledge from the episodes above." },
    ];

    const raw = await chatCompletion(messages, apiKey, {
      model: process.env.CONSOLIDATION_MODEL ?? "gpt-4o-mini",
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
      timeoutMs: 60_000,
    });

    const parsed = repairAndParseJSON(raw) as {
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
      const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

      for (const note of extractedNotes) {
        if (typeof note.content !== 'string' || note.content.length === 0 || note.content.length >= 2000) {
          log.warn(`[consolidation] Skipping note with invalid content (type=${typeof note.content}, len=${typeof note.content === 'string' ? note.content.length : 'N/A'})`);
          continue;
        }
        const validTypes = ["fact", "preference", "pattern", "entity", "relationship"];
        const noteType = validTypes.includes(note.type)
          ? (note.type as "fact" | "preference" | "pattern" | "entity" | "relationship")
          : "fact";

        // Write-time dedup: skip notes that are too similar to existing ones
        const dedup = await checkConsolidationDuplicate(db, note.content, apiKey, knowledgeThreadId);
        if (dedup.isDuplicate) {
          log.debug(`[consolidation] Dedup: skipping note similar to ${dedup.matchId} at ${dedup.similarity?.toFixed(3)}`);
          continue;
        }

        const noteId = saveSemanticNote(db, {
          type: noteType,
          content: note.content,
          keywords: Array.isArray(note.keywords) ? note.keywords : [],
          confidence: Math.max(0, Math.min(1, note.confidence ?? 0.5)),
          priority: Math.max(0, Math.min(2, note.priority ?? 0)),
          threadId: knowledgeThreadId,
          sourceEpisodes: episodeIds,
        });

        // Persist the embedding computed during dedup check
        if (dedup.embedding) {
          saveNoteEmbedding(db, noteId, dedup.embedding);
        }

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
          details.push(`[supersede-error] ${action.oldNoteId}: ${errorMessage(err)}`);
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
  } catch (err) {
    // Do NOT mark episodes as consolidated on failure — they should be
    // retried on the next consolidation run.  Previously this was a silent
    // data-loss bug: a transient OpenAI outage would permanently lose the
    // episodes' knowledge without extracting anything.
    const msg = errorMessage(err);
    log.error(`[memory] Intelligent consolidation failed (episodes NOT marked): ${msg}`);
    details.push(`Consolidation failed (will retry): ${msg}`);
  }

  // Housekeeping: clean up old sent_messages entries (>7 days)
  cleanupOldSentMessages(db);

  return {
    episodesProcessed: episodes.length,
    notesCreated,
    durationMs: Date.now() - startMs,
    details,
  };

  } finally {
    if (!skipLock) consolidationInProgress = false;
  }
}

// ─── Memory Pruning ──────────────────────────────────────────────────────────

// PRIVACY NOTE: Like consolidation, this sends note excerpts to OpenAI for
// quality evaluation. Disable via PRUNING_ENABLED=false (or "0").

/** Raw DB row shape for the pruning query. */
interface RawNoteRow {
  note_id: string;
  type: string;
  content: string;
  keywords: string;
  confidence: number;
  priority: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  valid_to: string | null;
  superseded_by: string | null;
  is_guardrail: number;
  pinned: number;
  thread_id: number | null;
}

/**
 * Scan a batch of existing semantic notes for quality issues:
 * - Outdated facts that no longer reflect reality
 * - Duplicate notes conveying the same information
 * - Low-quality notes that are vague or non-actionable
 *
 * Designed to run as a post-consolidation phase, gradually cleaning
 * the memory DB over successive runs.
 */
export async function runMemoryPruning(
  db: Database,
  options?: { maxNotes?: number; dryRun?: boolean }
): Promise<PruningReport> {
  const pruningEnabled = process.env.PRUNING_ENABLED;
  if (pruningEnabled === "false" || pruningEnabled === "0") {
    return {
      notesScanned: 0, notesExpired: 0, notesMerged: 0, durationMs: 0,
      details: ["Pruning disabled via PRUNING_ENABLED env var."],
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      notesScanned: 0, notesExpired: 0, notesMerged: 0, durationMs: 0,
      details: ["Pruning skipped — OPENAI_API_KEY not set."],
    };
  }

  const startMs = Date.now();
  const envSampleSize = parseInt(process.env.PRUNING_SAMPLE_SIZE ?? "", 10);
  const maxNotes = options?.maxNotes ?? (Number.isFinite(envSampleSize) && envSampleSize > 0 ? envSampleSize : 30);
  const dryRun = options?.dryRun ?? false;
  const details: string[] = [];

  // Sample candidate notes: lowest access count first, then oldest.
  // Guardrails and pinned notes are excluded — they're intentionally permanent.
  const candidates = db.prepare(`
    SELECT * FROM semantic_notes
    WHERE valid_to IS NULL
      AND superseded_by IS NULL
      AND is_guardrail = 0
      AND pinned = 0
    ORDER BY access_count ASC, created_at ASC
    LIMIT ?
  `).all(maxNotes) as RawNoteRow[];

  if (candidates.length < 5) {
    return {
      notesScanned: 0, notesExpired: 0, notesMerged: 0,
      durationMs: Date.now() - startMs,
      details: ["Too few candidate notes for pruning (< 5)."],
    };
  }

  const now = new Date();
  const notesText = candidates.map((row) => {
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));
    return `[${row.note_id}] (${row.type}, conf: ${row.confidence}, accesses: ${row.access_count}, age: ${ageDays}d) ${row.content}`;
  }).join("\n");

  const systemPrompt = `You are a memory quality manager. Review these semantic notes and identify problems.

Notes to review:
${notesText}

Output a JSON object:
{
  "expire": [
    { "noteId": "sn_xxx", "reason": "Brief explanation" }
  ],
  "merge": [
    { "keepId": "sn_xxx", "expireId": "sn_yyy", "mergedContent": "Best combined version", "reason": "Brief explanation" }
  ]
}

Decision criteria:
- EXPIRE if: the note is vague/non-actionable ("the system has issues"), trivially obvious, or clearly outdated (references old versions, completed tasks still marked pending)
- MERGE if: two or more notes convey the same information — keep the more specific/accurate one. Provide mergedContent combining the best of both when useful.
- KEEP (omit from output) if: the note contains unique, specific, actionable information

Be conservative — when in doubt, keep the note. Only expire notes you are confident are low-value.
Do NOT expire preferences or guardrails unless they clearly contradict each other.
Return {"expire": [], "merge": []} if nothing needs pruning.`;

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Review the notes above and identify any that should be expired or merged." },
    ];

    const raw = await chatCompletion(messages, apiKey, {
      model: process.env.CONSOLIDATION_MODEL ?? "gpt-4o-mini",
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
      timeoutMs: 60_000,
    });

    const parsed = repairAndParseJSON(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`LLM returned non-object response: ${typeof parsed}`);
    }
    const result = parsed as {
      expire?: unknown;
      merge?: unknown;
    };
    const expireActions = (Array.isArray(result.expire) ? result.expire : []) as Array<{
      noteId: string;
      reason: string;
    }>;
    const mergeActions = (Array.isArray(result.merge) ? result.merge : []) as Array<{
      keepId: string;
      expireId: string;
      mergedContent?: string;
      reason: string;
    }>;

    // Only allow actions targeting notes in the candidate set — prevents
    // LLM hallucinations from expiring pinned/guardrail notes outside the batch.
    const candidateIds = new Set(candidates.map((c) => c.note_id));
    let expired = 0;
    let merged = 0;
    const nowStr = nowISO();

    if (!dryRun) {
      // Wrap all mutations in a transaction so partial failures roll back.
      db.transaction(() => {
        for (const action of expireActions) {
          if (!action.noteId) continue;
          if (!candidateIds.has(action.noteId)) {
            details.push(`[skip-expire] ${action.noteId} not in candidate set`);
            continue;
          }
          const exists = db.prepare(
            `SELECT note_id FROM semantic_notes WHERE note_id = ? AND valid_to IS NULL`
          ).get(action.noteId) as { note_id: string } | undefined;
          if (!exists) {
            details.push(`[skip-expire] ${action.noteId} not found or already expired`);
            continue;
          }
          db.prepare(
            `UPDATE semantic_notes SET valid_to = ?, updated_at = ? WHERE note_id = ?`
          ).run(nowStr, nowStr, action.noteId);
          expired++;
          details.push(`[pruned] ${action.noteId}: ${action.reason}`);
        }

        for (const action of mergeActions) {
          if (!action.keepId || !action.expireId) continue;
          if (action.keepId === action.expireId) {
            details.push(`[skip-merge] ${action.keepId}: keepId === expireId`);
            continue;
          }
          if (!candidateIds.has(action.keepId) || !candidateIds.has(action.expireId)) {
            details.push(`[skip-merge] ${action.keepId}/${action.expireId} not in candidate set`);
            continue;
          }
          const keepNote = db.prepare(
            `SELECT note_id, content FROM semantic_notes WHERE note_id = ? AND valid_to IS NULL`
          ).get(action.keepId) as { note_id: string; content: string } | undefined;
          const expireNote = db.prepare(
            `SELECT note_id FROM semantic_notes WHERE note_id = ? AND valid_to IS NULL`
          ).get(action.expireId) as { note_id: string } | undefined;

          if (!keepNote || !expireNote) {
            details.push(`[skip-merge] ${action.keepId}/${action.expireId} not found`);
            continue;
          }

          // Update kept note with merged content when provided
          if (action.mergedContent && action.mergedContent !== keepNote.content) {
            db.prepare(
              `UPDATE semantic_notes SET content = ?, updated_at = ? WHERE note_id = ?`
            ).run(action.mergedContent, nowStr, keepNote.note_id);
          }

          // Expire the duplicate, linking to the kept note
          db.prepare(
            `UPDATE semantic_notes SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE note_id = ?`
          ).run(nowStr, keepNote.note_id, nowStr, action.expireId);
          merged++;
          details.push(`[merged] ${action.expireId} → ${action.keepId}: ${action.reason}`);
        }
      })();
    } else {
      for (const action of expireActions) {
        details.push(`[dry-run] [prune] ${action.noteId}: ${action.reason}`);
        expired++;
      }
      for (const action of mergeActions) {
        details.push(`[dry-run] [merge] ${action.expireId} → ${action.keepId}: ${action.reason}`);
        merged++;
      }
    }

    if (expired + merged > 0) {
      log.info(`[memory] Pruning: expired ${expired}, merged ${merged} note(s)`);
    }

    return {
      notesScanned: candidates.length,
      notesExpired: expired,
      notesMerged: merged,
      durationMs: Date.now() - startMs,
      details,
    };
  } catch (err) {
    const msg = errorMessage(err);
    log.error(`[memory] Pruning failed: ${msg}`);
    return {
      notesScanned: candidates.length,
      notesExpired: 0,
      notesMerged: 0,
      durationMs: Date.now() - startMs,
      details: [`Pruning failed: ${msg}`],
    };
  }
}
