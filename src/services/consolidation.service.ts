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

function buildExistingNotesSection(db: Database, episodesText: string): string {
  const episodeWords = episodesText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
  const wordFreq = new Map<string, number>();
  const stopWords = new Set([
    "this", "that", "with", "from", "have", "been", "will", "would", "could", "should",
    "about", "there", "their", "which", "when", "what", "were", "they", "than", "then",
    "also", "just", "more", "some", "into", "over", "after", "before", "other", "very",
    "your", "here",
  ]);

  for (const word of episodeWords) {
    if (!stopWords.has(word)) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }
  }

  const topKeywords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word);
  if (topKeywords.length === 0) return "";

  try {
    const related = searchSemanticNotesRanked(db, topKeywords.join(" "), {
      maxResults: 15,
      skipAccessTracking: true,
      minMatchRatio: 0.2,
    });
    if (related.length === 0) return "";

    return `\n\nExisting memory notes (potentially related):
${related.map((note) => `[${note.noteId}] (${note.type}, conf: ${note.confidence}) ${note.content}`).join("\n")}`;
  } catch (err) {
    log.warn(`[consolidation] searchSemanticNotesRanked failed during contradiction scan: ${errorMessage(err)}`);
    return "";
  }
}

function buildConsolidationPrompt(db: Database, episodes: ReturnType<typeof getUnconsolidatedEpisodes>): string {
  const episodesText = extractEpisodeText(episodes);
  const existingNotesSection = buildExistingNotesSection(db, episodesText);

  return `You are a memory consolidation agent. Analyze these conversation episodes and extract knowledge that should be remembered across sessions.

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
- Do NOT extract notes about the memory system itself, consolidation process, reflection quality, or memory management — these are implementation internals, not durable knowledge
- Do NOT extract notes about your own behavioral tendencies, self-assessments, or meta-observations about how you operate — only extract knowledge about the external world (the project, operator, codebase, tools, decisions). EXCEPTION: if the operator explicitly corrected the agent's behavior, extract that correction as a preference
- If the operator corrected the agent, extract the correction as a preference
- Focus on: operator name, preferences, communication style, technical choices, project context
- CRITICAL: Check existing notes for CONTRADICTIONS. If a new episode contradicts or updates an existing note, add a "supersede" entry. The new episodes represent MORE RECENT information.
- Common contradictions: decisions changed, projects completed/abandoned, preferences updated, tools/tech switched
- PRIORITY DETECTION: Infer priority from the operator's language and emotional investment:
  - priority 2 (high importance): operator says "important", "crucial", "I really need", "don't forget", shows strong emotional investment, repeated emphasis
  - priority 1 (notable): operator says "would be nice", "I'd like", "should", mentions something multiple times across conversations
  - priority 0 (normal): default for routine facts, observations, patterns
- When extracting facts about completed work, name the specific components, features, or decisions — not just "a bug fix sprint was completed". E.g. "Switched auth from JWT to session cookies because of mobile token refresh latency." Only apply this to sessions involving substantive work, not Q&A or exploration
- Note content should capture WHY (motivation/context), not just WHAT (action taken). Include outcome if determinable from the episode. If neither WHY nor outcome is available, consider whether the note is worth extracting at all
- Return {"notes": [], "supersede": []} if nothing notable`;
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
  } catch {
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

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");

      const messages: ChatMessage[] = [
        { role: "system", content: buildConsolidationPrompt(db, episodes) },
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
      const episodeIds = episodes.map((episode) => episode.episodeId);

      if (!dryRun) {
        const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

        // Phase 1: async dedup checks — collect what to write before entering transaction.
        type NoteWrite = {
          type: "fact" | "preference" | "pattern" | "entity" | "relationship";
          content: string;
          keywords: string[];
          confidence: number;
          priority: number;
          embedding: Float32Array | null;
        };
        const noteWrites: NoteWrite[] = [];

        for (const note of extractedNotes) {
          if (typeof note.content !== "string" || note.content.length === 0 || note.content.length >= 2000) {
            log.warn(`[consolidation] Skipping note with invalid content (type=${typeof note.content}, len=${typeof note.content === "string" ? note.content.length : "N/A"})`);
            continue;
          }

          const validTypes = ["fact", "preference", "pattern", "entity", "relationship"];
          const noteType = validTypes.includes(note.type)
            ? (note.type as "fact" | "preference" | "pattern" | "entity" | "relationship")
            : "fact";

          const dedup = await checkConsolidationDuplicate(db, note.content, apiKey, knowledgeThreadId);
          if (dedup.isDuplicate) {
            log.debug(`[consolidation] Dedup: skipping note similar to ${dedup.matchId} at ${dedup.similarity?.toFixed(3)}`);
            continue;
          }

          noteWrites.push({
            type: noteType,
            content: note.content,
            keywords: Array.isArray(note.keywords) ? note.keywords : [],
            confidence: Math.max(0, Math.min(1, note.confidence ?? 0.5)),
            priority: Math.max(0, Math.min(2, note.priority ?? 0)),
            embedding: dedup.embedding,
          });
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
              threadId: knowledgeThreadId,
              sourceEpisodes: episodeIds,
            });
            if (nw.embedding) {
              saveNoteEmbedding(db, noteId, nw.embedding);
            }
            notesCreated++;
            details.push(`[${nw.type}] ${nw.content}`);
          }

          for (const action of supersedeActions) {
            if (!action.oldNoteId || !action.newContent) continue;
            if (!hasActiveNote(db, action.oldNoteId)) {
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
        const knowledgeThreadId = resolveKnowledgeThreadId(threadId);
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
  const maxNotes = options?.maxNotes ?? (Number.isFinite(envSampleSize) && envSampleSize > 0 ? envSampleSize : 30);
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
