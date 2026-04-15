/**
 * Thread Synthesis
 *
 * When a ghost thread exits, harvests its key outcomes (episodes + notes)
 * and synthesizes them back into the parent thread's memory.
 *
 * This ensures the parent thread stays aware of what ghost threads
 * accomplished without having to carry the full conversation context.
 */

import type { Database } from "./schema.js";
import { getRecentEpisodes, saveEpisode } from "./episodes.js";
import { getTopSemanticNotes, saveSemanticNote } from "./semantic.js";
import { chatCompletion } from "../../integrations/openai/chat.js";
import { errorMessage } from "../../utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SynthesisResult {
  synthesizedNotes: number;
  synthesizedEpisode: boolean;
  ghostEpisodesRead: number;
  ghostNotesRead: number;
  error?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SYNTHESIS_MODEL =
  process.env.SYNTHESIS_MODEL || process.env.CONSOLIDATION_MODEL || "gpt-4o-mini";

/** Max episodes to read from ghost thread */
const MAX_GHOST_EPISODES = 50;

/** Max notes to read from ghost thread */
const MAX_GHOST_NOTES = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractText(content: Record<string, unknown>): string {
  return ((content.text || content.caption || content.message || "") as string).trim();
}

function formatGhostEpisodes(episodes: ReturnType<typeof getRecentEpisodes>): string {
  return episodes
    .map((ep) => {
      const text = extractText(ep.content as Record<string, unknown>);
      if (!text) return null;
      const ts = ep.timestamp.slice(0, 16).replace("T", " ");
      return `[${ts}] (${ep.type}) ${text.slice(0, 300)}`;
    })
    .filter(Boolean)
    .join("\n");
}

function formatGhostNotes(notes: ReturnType<typeof getTopSemanticNotes>): string {
  return notes
    .map((n) => `- [${n.type}] ${n.content.slice(0, 200)}`)
    .join("\n");
}

// ─── LLM Synthesis ───────────────────────────────────────────────────────────

async function generateSynthesis(
  ghostEpisodesText: string,
  ghostNotesText: string,
  ghostName: string,
  apiKey: string,
): Promise<{ summary: string; keyFacts: Array<{ type: string; content: string; keywords: string[]; confidence: number }> }> {
  const prompt = `You are a memory synthesis agent. A ghost thread named "${ghostName}" has finished its work. Synthesize its outcomes into the parent thread's memory.

SOURCE DATA:

=== Ghost Thread Episodes ===
${ghostEpisodesText || "(no episodes)"}

=== Ghost Thread Notes ===
${ghostNotesText || "(no notes)"}

OUTPUT (JSON):
{
  "summary": "A 1-2 sentence summary of what the ghost thread accomplished. Past tense. Concrete outcomes.",
  "keyFacts": [
    {
      "type": "fact",
      "content": "One clear sentence about a key outcome or decision",
      "keywords": ["keyword1", "keyword2"],
      "confidence": 0.8
    }
  ]
}

RULES:
- summary: what was done, what was the outcome
- keyFacts: max 5, only genuinely important outcomes that the parent thread needs to know
- Skip trivial details — focus on decisions, created artifacts, resolved issues
- If the ghost thread accomplished nothing notable, return empty keyFacts
- Return valid JSON only`;

  const response = await chatCompletion(
    [{ role: "user", content: prompt }],
    apiKey,
    { model: SYNTHESIS_MODEL, temperature: 0.2, maxTokens: 500 },
  );

  const fallback = {
    summary: `Ghost thread "${ghostName}" completed its work.`,
    keyFacts: [] as Array<{ type: string; content: string; keywords: string[]; confidence: number }>,
  };

  try {
    // Handle potential markdown fences
    const cleaned = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    // Validate LLM response shape
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.keyFacts)) {
      return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Synthesize a ghost thread's outcomes into the parent thread's memory.
 *
 * Called when a ghost thread exits (from the child.on("exit") handler).
 * Reads the ghost's episodes and notes, generates a synthesis via LLM,
 * and inserts the results as notes/episodes in the parent thread.
 */
export async function synthesizeGhostMemory(
  db: Database,
  ghostThreadId: number,
  parentThreadId: number,
  ghostName?: string,
): Promise<SynthesisResult> {
  const result: SynthesisResult = {
    synthesizedNotes: 0,
    synthesizedEpisode: false,
    ghostEpisodesRead: 0,
    ghostNotesRead: 0,
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    result.error = "No OPENAI_API_KEY";
    return result;
  }

  try {
    // Harvest ghost thread data
    const episodes = getRecentEpisodes(db, ghostThreadId, MAX_GHOST_EPISODES);
    const notes = getTopSemanticNotes(db, {
      limit: MAX_GHOST_NOTES,
      sortBy: "created_at",
      threadId: ghostThreadId,
    });

    result.ghostEpisodesRead = episodes.length;
    result.ghostNotesRead = notes.length;

    // Skip if ghost did very little
    if (episodes.length < 2 && notes.length === 0) {
      return result;
    }

    const episodesText = formatGhostEpisodes(episodes);
    const notesText = formatGhostNotes(notes);
    const name = ghostName || `thread-${ghostThreadId}`;

    // Generate synthesis
    const synthesis = await generateSynthesis(episodesText, notesText, name, apiKey);

    // Save synthesis summary as an episode in parent thread
    if (synthesis.summary) {
      saveEpisode(db, {
        sessionId: `synthesis-${ghostThreadId}`,
        threadId: parentThreadId,
        type: "system_event",
        modality: "text",
        content: {
          text: `[THREAD SYNTHESIS] Ghost thread "${name}" (thread ${ghostThreadId}) completed: ${synthesis.summary}`,
        },
        topicTags: ["thread-synthesis", name],
        importance: 0.7,
      });
      result.synthesizedEpisode = true;
    }

    // Save key facts as semantic notes in parent thread
    const VALID_NOTE_TYPES = new Set(["fact", "preference", "pattern", "entity", "relationship"] as const);
    type NoteType = "fact" | "preference" | "pattern" | "entity" | "relationship";

    for (const fact of synthesis.keyFacts) {
      const noteType: NoteType = VALID_NOTE_TYPES.has(fact.type as NoteType) ? (fact.type as NoteType) : "fact";
      saveSemanticNote(db, {
        type: noteType,
        content: `[From ghost thread "${name}"] ${fact.content}`,
        keywords: [...(fact.keywords || []), "thread-synthesis", name],
        confidence: fact.confidence || 0.7,
        sourceEpisodes: [],
        threadId: parentThreadId,
      });
      result.synthesizedNotes++;
    }
  } catch (err) {
    result.error = errorMessage(err);
  }

  return result;
}

/**
 * Fork memory from a source thread to a new branch thread.
 * Copies semantic_notes and temporal_narratives (not episodes — those are session-specific).
 * Returns the number of items copied.
 */
export function forkMemory(
  db: Database,
  sourceThreadId: number,
  targetThreadId: number,
): { notesCopied: number; narrativesCopied: number } {
  const now = new Date().toISOString();

  // Copy semantic notes (generate new IDs)
  const notes = db.prepare(
    `INSERT INTO semantic_notes (
       note_id, type, content, keywords, confidence, source_episodes, linked_notes, link_reasons,
       valid_from, valid_to, superseded_by, access_count, last_accessed, priority, thread_id,
       is_guardrail, pinned, created_at, updated_at
     )
     SELECT
       'sn_' || lower(hex(randomblob(6))), type, content, keywords, confidence, source_episodes, linked_notes, link_reasons,
       valid_from, valid_to, superseded_by, 0, NULL, priority, ?,
       is_guardrail, pinned, ?, ?
     FROM semantic_notes WHERE thread_id = ?`
  ).run(targetThreadId, now, now, sourceThreadId);

  // Copy temporal narratives
  const narratives = db.prepare(
    `INSERT OR IGNORE INTO temporal_narratives (
       thread_id, resolution, period_start, period_end, narrative,
       source_episode_count, source_note_count, model, created_at
     )
     SELECT ?, resolution, period_start, period_end, narrative,
            source_episode_count, source_note_count, model, ?
     FROM temporal_narratives WHERE thread_id = ?`
  ).run(targetThreadId, now, sourceThreadId);

  return {
    notesCopied: notes.changes,
    narrativesCopied: narratives.changes,
  };
}
