import type { Database } from "./schema.js";
import { cleanupOldSentMessages } from "./schema.js";
import { getUnconsolidatedEpisodes, markConsolidated } from "./episodes.js";
import {
  saveSemanticNote,
  searchSemanticNotesRanked,
  supersedeNote,
} from "./semantic.js";
import { log } from "../../logger.js";
import { resolveKnowledgeThreadId } from "../../config.js";
import { nowISO } from "./utils.js";
import { chatCompletion, type ChatMessage } from "../../integrations/openai/chat.js";

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

// ─── JSON repair ─────────────────────────────────────────────────────────────

/**
 * Attempt to parse JSON with automatic repair for common LLM output issues:
 * - Markdown code fences wrapping the JSON
 * - Unescaped newlines/tabs inside string values
 * - Truncated output (unclosed strings, arrays, objects)
 */
function repairAndParseJSON(raw: string): unknown {
  // 1. Direct parse
  try { return JSON.parse(raw); } catch { /* continue */ }

  let text = raw.trim();

  // 2. Strip markdown code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    try { return JSON.parse(text); } catch { /* continue */ }
  }

  // 3. Fix unescaped control characters inside JSON string values
  //    Walk character-by-character; when inside a quoted string, escape
  //    raw \n, \r, \t that are not already escaped.
  const chars: string[] = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (ch === '"' && prev !== "\\") { inStr = !inStr; chars.push(ch); continue; }
    if (inStr) {
      if (ch === "\n") { chars.push("\\n"); continue; }
      if (ch === "\r") { chars.push("\\r"); continue; }
      if (ch === "\t") { chars.push("\\t"); continue; }
    }
    chars.push(ch);
  }
  text = chars.join("");
  try { return JSON.parse(text); } catch { /* continue */ }

  // 4. Handle truncation: close any open strings, arrays, objects
  //    If there is an odd number of unescaped quotes, the last string is
  //    unterminated — close it then remove any trailing partial key/value.
  let quoteCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && (i === 0 || text[i - 1] !== "\\")) quoteCount++;
  }
  if (quoteCount % 2 !== 0) {
    // Unterminated string — close it
    text += '"';
  }

  // Remove a trailing partial key-value (e.g. `"key": "val"` is fine,
  // but `"key":` or `"key": ` with nothing after is not).
  text = text.replace(/,\s*"[^"]*"\s*:\s*$/, "");
  text = text.replace(/,\s*$/, "");

  // Close open brackets / braces
  const opens: string[] = [];
  let scanning = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (i === 0 || text[i - 1] !== "\\")) { scanning = !scanning; continue; }
    if (scanning) continue;
    if (c === "{" || c === "[") opens.push(c);
    else if (c === "}" || c === "]") opens.pop();
  }
  for (let i = opens.length - 1; i >= 0; i--) {
    text += opens[i] === "{" ? "}" : "]";
  }

  try { return JSON.parse(text); } catch { /* continue */ }

  throw new SyntaxError(`Unable to repair JSON from LLM (length=${raw.length}): ${raw.slice(0, 200)}…`);
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
        content = String(ep.content);
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
    } catch (err) { log.warn(`[consolidation] searchSemanticNotesRanked failed during contradiction scan: ${err instanceof Error ? err.message : String(err)}`); }
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
          threadId: resolveKnowledgeThreadId(threadId),
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
  } catch (err) {
    // Do NOT mark episodes as consolidated on failure — they should be
    // retried on the next consolidation run.  Previously this was a silent
    // data-loss bug: a transient OpenAI outage would permanently lose the
    // episodes' knowledge without extracting anything.
    const msg = err instanceof Error ? err.message : String(err);
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
