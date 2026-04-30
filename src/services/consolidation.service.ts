import type { Database } from "../data/memory/schema.js";
import { getUnconsolidatedEpisodes, markConsolidated } from "../data/memory/episodes.js";
import {
  saveSemanticNote,
  searchSemanticNotesRanked,
  searchByEmbedding,
  saveNoteEmbedding,
  supersedeNote,
} from "../data/memory/semantic.js";
import {
  cleanupConsolidationHousekeeping,
  type ConsolidationReport,
  getCandidateNotesForPruning,
  getUnconsolidatedThreadIds,
  getActiveNoteContent,
  hasActiveNote,
  expireNote,
  logConsolidation,
  mergeDuplicateNote,
  type PruningReport,
  sweepOrphanedNotes,
} from "../data/memory/consolidation.js";
import { resolveKnowledgeThreadId } from "../config.js";
import { passesStructuralGate, passesQualityGate, parseReflectionFields } from "../data/memory/reflection.js";
import { chatCompletion, generateEmbedding, type ChatMessage } from "../integrations/openai/chat.js";
import { log } from "../logger.js";
import { nowISO, repairAndParseJSON } from "../data/memory/utils.js";
import { errorMessage } from "../utils.js";

const CONSOLIDATION_DEDUP_THRESHOLD = 0.88;
const VALID_NOTE_TYPES = ["fact", "preference", "pattern", "entity", "relationship"] as const;
type ValidNoteType = (typeof VALID_NOTE_TYPES)[number];
let consolidationInProgress = false;

function extractEpisodeText(episodes: ReturnType<typeof getUnconsolidatedEpisodes>): string {
  return episodes
    .map((episode, index) => {
      const contentRecord = episode.content as Record<string, unknown>;
      let content: string;
      if (contentRecord && typeof contentRecord === "object") {
        content = (contentRecord.text as string) ?? (contentRecord.caption as string) ?? JSON.stringify(contentRecord);
      } else {
        content = JSON.stringify(episode.content);
      }
      return `[${index + 1}] (${episode.type}/${episode.modality}, ${episode.timestamp}) ${content}`;
    })
    .join("\n");
}

async function buildExistingNotesSection(db: Database, episodesText: string, apiKey: string, threadId: number): Promise<string> {
  try {
    // Use embedding search to find semantically related notes (not just keyword match)
    const embedding = await generateEmbedding(episodesText.slice(0, 8000), apiKey);
    const related = searchByEmbedding(db, embedding, {
      maxResults: 30,
      minSimilarity: 0.3,
      skipAccessTracking: true,
      threadId,
    });
    if (related.length === 0) return "";

    return `\n\nExisting memory notes (check for contradictions — supersede any that are outdated):
${related.map((note) => `[${note.noteId}] (${note.type}, conf: ${note.confidence}) ${note.content}`).join("\n")}`;
  } catch (err) {
    log.warn(`[consolidation] Embedding search for existing notes failed: ${errorMessage(err)}`);
    // Fallback to keyword search
    try {
      const topKeywords = episodesText
        .toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 12);
      if (topKeywords.length === 0) return "";
      const ranked = searchSemanticNotesRanked(db, topKeywords.join(" "), {
        maxResults: 15,
        skipAccessTracking: true,
        minMatchRatio: 0.2,
        threadId,
      });
      if (ranked.length === 0) return "";
      return `\n\nExisting memory notes (check for contradictions — supersede any that are outdated):
${ranked.map((note) => `[${note.noteId}] (${note.type}, conf: ${note.confidence}) ${note.content}`).join("\n")}`;
    } catch {
      return "";
    }
  }
}

async function buildConsolidationPrompt(db: Database, episodes: ReturnType<typeof getUnconsolidatedEpisodes>, apiKey: string, threadId: number): Promise<string> {
  const episodesText = extractEpisodeText(episodes);
  const existingNotesSection = await buildExistingNotesSection(db, episodesText, apiKey, threadId);

  return `You are a memory consolidation agent. Extract ONLY actionable, durable knowledge from these episodes. Quality over quantity — fewer, better notes.

Episodes:
${episodesText}${existingNotesSection}

Output a JSON object with:
{
  "notes": [
    {
      "type": "fact" | "preference" | "pattern" | "entity",
      "content": "One clear, actionable sentence",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "confidence": 0.0-1.0,
      "priority": 0 | 1 | 2,
      "quality_score": 1-5,
      "linked_notes": ["sn_xxx"],
      "link_reasons": ["brief causal relationship explanation"]
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

ACTIONABILITY TEST — apply to every note before including it:
- Facts must answer: "What should the agent DO with this information?" If a fact is just "X was discussed" or "Y happened" with no implication for future behavior, do NOT extract it.
- Preferences must be testable: "Given situation X, the operator wants Y." Vague preferences like "prefers quality" are useless — specify the concrete behavior.
- If a note doesn't change how the agent acts in a future session, it's not worth saving. Prefer zero notes over low-quality notes.

BANNED content — do NOT extract:
- Notes about the memory system, consolidation, audits, reflection quality, or memory management
- Self-assessments or meta-observations about the agent's own behavior ("I tend to...", "I regularly...")
- Passive observations that don't inform decisions ("a discussion occurred", "code was reviewed")
- Transient status ("currently working on X", "PR is open", "tests passing")
- Duplicate information already captured in an existing note (check the existing notes section carefully)

EXCEPTION: If the operator explicitly corrected the agent's behavior, extract that correction as a preference.

SUPERSEDE — check existing notes for contradictions:
- CRITICAL: If a new episode contradicts or updates an existing note, add a "supersede" entry
- Common triggers: decisions changed, projects completed/abandoned, preferences updated, tools/tech switched, version numbers changed
- The new episodes represent MORE RECENT information

TYPE RULES:
- fact: Durable knowledge about the project, codebase, architecture, people, or external world
- preference: Operator's explicit or strongly implied preference for how things should be done
- pattern: Recurring behavior or decision pattern that predicts future situations
- entity: Named entity (person, project, service) with identifying attributes

PRIORITY DETECTION:
- priority 2: operator says "important", "crucial", "don't forget", shows strong emotional investment
- priority 1: operator says "would be nice", "should", mentions something repeatedly
- priority 0: default for routine facts

QUALITY SCORE (quality_score):
- 1: Vague or useless — generic statement with no actionable implication
- 2: Weak — some value but missing context or specificity
- 3: Acceptable — actionable but not particularly memorable
- 4: Good — specific, actionable, with context or motivation
- 5: Highly actionable — captures a decision, constraint, or pattern with full context and clear behavioral implication
Assign honestly. A score below 3 flags the note for monitoring — do NOT use this to suppress extraction; assign a low score and let the system decide.

CONTENT QUALITY:
- Name specific components, features, versions, or decisions — never "a bug fix was completed"
- Capture WHY (motivation/context), not just WHAT. Include outcome if known
- If neither WHY nor outcome is available, the note is probably not worth extracting
- Include dates when known. Write "On April 15, operator requested X" not just "operator requested X." If the episode contains timestamps or date references, include them in the note content.
- Return {"notes": [], "supersede": []} if nothing actionable

SPECIFICITY GATE — apply to every note before including it:
- Every note MUST contain at least one specific anchor: a file name, commit hash, person name, date, or concrete number. If you cannot name something specific, do not create the note.
- Do NOT create notes that merely say "X was completed" or "Y was done." If something was completed, state WHAT specifically was done — which files changed, what bug was fixed, what the outcome was. Headlines without substance are useless.

CAUSAL LINKING:
- For each note, if it is causally related to any of the existing notes shown above (one caused the other, one is a consequence of the other, or they are part of the same chain of events), populate \`linked_notes\` with the existing note IDs and \`link_reasons\` with a brief explanation of the causal relationship.
- If there are no causal relationships, omit \`linked_notes\` and \`link_reasons\` or set them to empty arrays.`;
}

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
    const match = matches.find((candidate) => candidate.similarity >= CONSOLIDATION_DEDUP_THRESHOLD);
    if (match) {
      return { isDuplicate: true, matchId: match.noteId, similarity: match.similarity, embedding };
    }
    return { isDuplicate: false, embedding };
  } catch (err) {
    log.warn(`[consolidation] Deduplication check failed: ${err instanceof Error ? err.message : err}`);
    return { isDuplicate: false, embedding: null };
  }
}

export async function runConsolidationAllThreads(
  db: Database,
  options?: { maxEpisodesPerThread?: number; dryRun?: boolean },
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
    const threadIds = getUnconsolidatedThreadIds(db);

    if (threadIds.length === 0) {
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

    for (const threadId of threadIds) {
      const report = await runIntelligentConsolidation(db, threadId, {
        maxEpisodes: options?.maxEpisodesPerThread ?? 30,
        dryRun: options?.dryRun,
        _skipLock: true,
      });
      totalProcessed += report.episodesProcessed;
      totalNotes += report.notesCreated;
      allDetails.push(`Thread ${threadId}: ${report.episodesProcessed} eps → ${report.notesCreated} notes`);
    }

    try {
      const pruneReport = await runMemoryPruning(db);
      if (pruneReport.notesExpired + pruneReport.notesMerged > 0) {
        allDetails.push(`Pruning: scanned ${pruneReport.notesScanned}, expired ${pruneReport.notesExpired}, merged ${pruneReport.notesMerged}`);
        allDetails.push(...pruneReport.details);
      }
    } catch (err) {
      log.warn(`[memory] Pruning phase failed: ${errorMessage(err)}`);
    }

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
  options?: { maxEpisodes?: number; dryRun?: boolean; _skipLock?: boolean },
): Promise<ConsolidationReport> {
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

    const details: string[] = [];
    let notesCreated = 0;
    const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      const messages: ChatMessage[] = [
        { role: "system", content: await buildConsolidationPrompt(db, episodes, apiKey, knowledgeThreadId) },
        { role: "user", content: "Extract knowledge from the episodes above." },
      ];

      const raw = await chatCompletion(messages, apiKey, {
        model: process.env.CONSOLIDATION_MODEL ?? "gpt-4o",
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
          quality_score?: number;
          linked_notes?: string[];
          link_reasons?: string[];
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
      const episodeIds = episodes.map((episode) => episode.episodeId);

      if (!dryRun) {
        // Phase 1: async dedup checks — collect what to write before entering transaction.
        type NoteWrite = {
          type: "fact" | "preference" | "pattern" | "entity" | "relationship";
          content: string;
          keywords: string[];
          confidence: number;
          priority: number;
          qualityScore: number | null;
          embedding: Float32Array | null;
          linkedNotes: string[];
          linkReasons: Record<string, string>;
        };
        const noteWrites: NoteWrite[] = [];

        for (const note of extractedNotes) {
          if (typeof note.content !== "string" || note.content.length === 0 || note.content.length >= 2000) {
            log.warn(`[consolidation] Skipping note with invalid content (type=${typeof note.content}, len=${typeof note.content === "string" ? note.content.length : "N/A"})`);
            continue;
          }

          const noteType = (VALID_NOTE_TYPES.includes(note.type as ValidNoteType) ? note.type : "fact") as ValidNoteType;

          const dedup = await checkConsolidationDuplicate(db, note.content, apiKey, knowledgeThreadId);
          if (dedup.isDuplicate) {
            log.debug(`[consolidation] Dedup: skipping note similar to ${dedup.matchId} at ${dedup.similarity?.toFixed(3)}`);
            continue;
          }

          const rawLinked = Array.isArray(note.linked_notes) ? note.linked_notes.filter((id): id is string => typeof id === "string") : [];
          const rawReasons: Record<string, string> = {};
          if (Array.isArray(note.link_reasons)) {
            rawLinked.forEach((id, i) => {
              if (typeof note.link_reasons![i] === "string") rawReasons[id] = note.link_reasons![i];
            });
          }
          noteWrites.push({
            type: noteType,
            content: note.content,
            keywords: Array.isArray(note.keywords) ? note.keywords : [],
            confidence: Math.max(0, Math.min(1, note.confidence ?? 0.5)),
            priority: Math.max(0, Math.min(2, note.priority ?? 0)),
            qualityScore: typeof note.quality_score === "number" ? note.quality_score : null,
            embedding: dedup.embedding,
            linkedNotes: rawLinked,
            linkReasons: rawReasons,
          });
        }

        // Phase 1b: pre-generate embeddings for supersede replacement notes (async, must be outside transaction).
        const supersedeWrites: Array<{
          action: (typeof supersedeActions)[number];
          noteType: ValidNoteType;
          embedding: Float32Array | null;
        }> = [];
        for (const action of supersedeActions) {
          if (!action.oldNoteId || !action.newContent) continue;
          const noteType = (VALID_NOTE_TYPES.includes(action.type as ValidNoteType) ? action.type : "fact") as ValidNoteType;
          let embedding: Float32Array | null = null;
          try {
            embedding = await generateEmbedding(action.newContent, apiKey);
          } catch {
            // non-fatal — supersede note will be saved without embedding
          }
          supersedeWrites.push({ action, embedding, noteType });
        }

        // Phase 2: all DB writes in a single atomic transaction.
        let supersededCount = 0;
        db.transaction(() => {
          for (const nw of noteWrites) {
            const noteId = saveSemanticNote(db, {
              type: nw.type,
              content: nw.content,
              keywords: nw.keywords,
              confidence: nw.confidence,
              priority: nw.priority,
              qualityScore: nw.qualityScore,
              threadId: knowledgeThreadId,
              sourceEpisodes: episodeIds,
              linkedNotes: nw.linkedNotes.length > 0 ? nw.linkedNotes : undefined,
              linkReasons: Object.keys(nw.linkReasons).length > 0 ? nw.linkReasons : undefined,
            });
            if (nw.embedding) {
              saveNoteEmbedding(db, noteId, nw.embedding);
            }
            notesCreated++;
            details.push(`[${nw.type}] ${nw.content}`);
          }

          for (const { action, noteType, embedding } of supersedeWrites) {
            if (!hasActiveNote(db, action.oldNoteId)) {
              details.push(`[skip-supersede] ${action.oldNoteId} not found or already superseded`);
              continue;
            }

            try {
              const newId = supersedeNote(db, action.oldNoteId, {
                type: noteType,
                content: action.newContent,
                keywords: Array.isArray(action.keywords) ? action.keywords : [],
                confidence: Math.max(0, Math.min(1, action.confidence ?? 0.8)),
                priority: Math.max(0, Math.min(2, action.priority ?? 0)),
                sourceEpisodes: episodeIds,
              });
              if (embedding) {
                saveNoteEmbedding(db, newId, embedding);
              }
              supersededCount++;
              details.push(`[supersede] ${action.oldNoteId} → ${newId}: ${action.reason}`);
            } catch (err) {
              details.push(`[supersede-error] ${action.oldNoteId}: ${errorMessage(err)}`);
            }
          }

          markConsolidated(db, episodeIds);
          logConsolidation(db, {
            episodesProcessed: episodes.length,
            notesCreated: notesCreated + supersededCount,
            durationMs: Date.now() - startMs,
          });
        })();

        if (supersededCount > 0) {
          log.info(`[memory] Contradiction resolution: superseded ${supersededCount} outdated note(s)`);
        }
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
      const msg = errorMessage(err);
      log.error(`[memory] Intelligent consolidation failed (episodes NOT marked): ${msg}`);
      details.push(`Consolidation failed (will retry): ${msg}`);
    }

    cleanupConsolidationHousekeeping(db);

    // Phase: Quality gate cleanup — expire existing reflection notes that fail structural or quality checks
    if (!dryRun) {
      try {
        // Only sweep reflections created after the quality gate was deployed (2026-04-19)
        // to avoid retroactively expiring older reflections that were valid under previous rules
        const QUALITY_GATE_CUTOFF = "2026-04-19T00:00:00.000Z";
        const reflectionRows = db
          .prepare(
            `SELECT note_id, content, confidence FROM semantic_notes
             WHERE content LIKE '[REFLECTION]%' AND valid_to IS NULL AND superseded_by IS NULL
               AND thread_id = ? AND created_at >= ?`,
          )
          .all(knowledgeThreadId, QUALITY_GATE_CUTOFF) as { note_id: string; content: string; confidence: number }[];

        let expiredReflections = 0;
        const nowStr = nowISO();

        for (const row of reflectionRows) {
          const fields = parseReflectionFields(row.content);
          if (!fields) continue;  // unparseable — skip, don't expire

          const structural = passesStructuralGate(fields);
          if (!structural.pass) {
            expireNote(db, row.note_id, nowStr);
            expiredReflections++;
            continue;
          }

          const quality = passesQualityGate(row.content, row.confidence);
          if (!quality.pass) {
            expireNote(db, row.note_id, nowStr);
            expiredReflections++;
          }
        }

        if (expiredReflections > 0) {
          log.info(`[consolidation] Quality gate cleanup: expired ${expiredReflections} low-quality reflection(s)`);
        }
      } catch (err) {
        log.warn(`[consolidation] Reflection quality gate cleanup failed: ${errorMessage(err)}`);
      }
    }

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

export async function runMemoryPruning(
  db: Database,
  options?: { maxNotes?: number; dryRun?: boolean },
): Promise<PruningReport> {
  const pruningEnabled = process.env.PRUNING_ENABLED;
  if (pruningEnabled === "false" || pruningEnabled === "0") {
    return {
      notesScanned: 0,
      notesExpired: 0,
      notesMerged: 0,
      durationMs: 0,
      details: ["Pruning disabled via PRUNING_ENABLED env var."],
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      notesScanned: 0,
      notesExpired: 0,
      notesMerged: 0,
      durationMs: 0,
      details: ["Pruning skipped — OPENAI_API_KEY not set."],
    };
  }

  const startMs = Date.now();
  const envSampleSize = parseInt(process.env.PRUNING_SAMPLE_SIZE ?? "", 10);
  const maxNotes = options?.maxNotes ?? (Number.isFinite(envSampleSize) && envSampleSize > 0 ? envSampleSize : 60);
  const dryRun = options?.dryRun ?? false;
  const details: string[] = [];
  const candidates = getCandidateNotesForPruning(db, maxNotes);

  if (candidates.length < 5) {
    return {
      notesScanned: 0,
      notesExpired: 0,
      notesMerged: 0,
      durationMs: Date.now() - startMs,
      details: ["Too few candidate notes for pruning (< 5)."],
    };
  }

  const now = new Date();
  const notesText = candidates
    .map((row) => {
      const ageMs = now.getTime() - new Date(row.created_at).getTime();
      const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));
      return `[${row.note_id}] (${row.type}, conf: ${row.confidence}, accesses: ${row.access_count}, age: ${ageDays}d) ${row.content}`;
    })
    .join("\n");

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
      model: process.env.CONSOLIDATION_MODEL ?? "gpt-4o",
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

    const candidateIds = new Set(candidates.map((candidate) => candidate.note_id));
    let expired = 0;
    let merged = 0;
    const nowStr = nowISO();

    if (!dryRun) {
      db.transaction(() => {
        for (const action of expireActions) {
          if (!action.noteId) continue;
          if (!candidateIds.has(action.noteId)) {
            details.push(`[skip-expire] ${action.noteId} not in candidate set`);
            continue;
          }
          if (!hasActiveNote(db, action.noteId)) {
            details.push(`[skip-expire] ${action.noteId} not found or already expired`);
            continue;
          }
          expireNote(db, action.noteId, nowStr);
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

          const keepNote = getActiveNoteContent(db, action.keepId);
          const expireNoteRow = getActiveNoteContent(db, action.expireId);
          if (!keepNote || !expireNoteRow) {
            details.push(`[skip-merge] ${action.keepId}/${action.expireId} not found`);
            continue;
          }

          mergeDuplicateNote(
            db,
            keepNote.noteId,
            expireNoteRow.noteId,
            nowStr,
            action.mergedContent && action.mergedContent !== keepNote.content ? action.mergedContent : undefined,
          );
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
