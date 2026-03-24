import type { Database } from "./schema.js";
import { cleanupOldSentMessages } from "./schema.js";
import { getUnconsolidatedEpisodes, markConsolidated } from "./episodes.js";
import {
  saveSemanticNote,
  searchSemanticNotesRanked,
  supersedeNote,
} from "./semantic.js";
import { log } from "../../logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConsolidationReport {
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

function nowISO(): string {
  return new Date().toISOString();
}

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

// ─── Intelligent Consolidation ───────────────────────────────────────────────

// PRIVACY NOTE: This function sends conversation episode excerpts to OpenAI's
// API for knowledge extraction and consolidation. Operators can disable this
// by setting the environment variable CONSOLIDATION_ENABLED=false (or "0").

let consolidationInProgress = false;

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

  if (consolidationInProgress) {
    log.info("Consolidation already in progress — skipping");
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

  // Housekeeping: clean up old sent_messages entries (>7 days)
  cleanupOldSentMessages(db);

  return {
    episodesProcessed: episodes.length,
    notesCreated,
    durationMs: Date.now() - startMs,
    details,
  };

  } finally {
    consolidationInProgress = false;
  }
}
