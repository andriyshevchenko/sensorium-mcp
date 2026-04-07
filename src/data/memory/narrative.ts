/**
 * Temporal Narrative Generator
 *
 * Produces multi-resolution narratives from episodes and semantic notes:
 * - day:       detailed events (~500 tokens)
 * - week:      key decisions and progress (~300 tokens)
 * - month:     high-level arc (~200 tokens)
 * - quarter:   strategic 3-month arc (~150 tokens)
 * - half_year: bird's-eye 6-month arc (~120 tokens)
 *
 * These narratives replace raw note dumps in bootstrap and give the agent
 * coherent temporal awareness across long-running sessions.
 */

import type { Database } from "./schema.js";
import { chatCompletion } from "../../integrations/openai/chat.js";
import { type Episode } from "./episodes.js";
import { type SemanticNote } from "./semantic.js";
import { resolveKnowledgeThreadId } from "../../config.js";
import { parseJsonArray, parseJsonObject } from "./utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type NarrativeResolution = "day" | "week" | "month" | "quarter" | "half_year";

interface TemporalNarrative {
  id: number;
  threadId: number;
  resolution: NarrativeResolution;
  periodStart: string;
  periodEnd: string;
  narrative: string;
  sourceEpisodeCount: number;
  sourceNoteCount: number;
  model: string | null;
  createdAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Cooldown per resolution before regenerating */
const COOLDOWNS: Record<NarrativeResolution, number> = {
  day: 2 * 60 * 60 * 1000,        // 2 hours
  week: 12 * 60 * 60 * 1000,      // 12 hours
  month: 24 * 60 * 60 * 1000,     // 24 hours
  quarter: 7 * 24 * 60 * 60 * 1000,   // 7 days
  half_year: 14 * 24 * 60 * 60 * 1000, // 14 days
};

/** Max tokens (approximate via chars) for each resolution */
const TOKEN_BUDGETS: Record<NarrativeResolution, number> = {
  day: 2000,       // ~500 tokens
  week: 1200,      // ~300 tokens
  month: 800,      // ~200 tokens
  quarter: 600,    // ~150 tokens
  half_year: 500,  // ~120 tokens
};

const NARRATIVE_MODEL =
  process.env.NARRATIVE_MODEL || process.env.CONSOLIDATION_MODEL || "gpt-4o-mini";

// ─── Period Calculation ──────────────────────────────────────────────────────

function getPeriodBounds(resolution: NarrativeResolution): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();

  if (resolution === "day") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), end };
  }
  if (resolution === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), end };
  }
  if (resolution === "quarter") {
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    start.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), end };
  }
  if (resolution === "half_year") {
    const start = new Date(now);
    start.setDate(start.getDate() - 180);
    start.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), end };
  }
  if (resolution === "month") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    start.setUTCHours(0, 0, 0, 0);
    return { start: start.toISOString(), end };
  }
  const _exhaustive: never = resolution;
  throw new Error(`Unhandled narrative resolution: ${_exhaustive}`);
}

// ─── Source Data Collection ──────────────────────────────────────────────────

function getEpisodesInPeriod(db: Database, threadId: number, start: string, end: string): Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM episodes
       WHERE thread_id = ? AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`,
    )
    .all(threadId, start, end) as Record<string, unknown>[];

  // Inline light rowToEpisode to avoid circular dep
  return rows.map((r) => ({
    episodeId: r.episode_id as string,
    sessionId: r.session_id as string,
    threadId: r.thread_id as number,
    timestamp: r.timestamp as string,
    type: r.type as Episode["type"],
    modality: r.modality as Episode["modality"],
    content: parseJsonObject(r.content as string),
    topicTags: parseJsonArray(r.topic_tags as string),
    importance: r.importance as number,
    consolidated: (r.consolidated as number) === 1,
    accessedCount: r.accessed_count as number,
    lastAccessed: r.last_accessed as string | null,
    createdAt: r.created_at as string,
  }));
}

function getNotesInPeriod(db: Database, threadId: number, start: string): SemanticNote[] {
  const rows = db
    .prepare(
      `SELECT * FROM semantic_notes
       WHERE thread_id = ? AND valid_to IS NULL AND created_at >= ?
       ORDER BY access_count DESC LIMIT 30`,
    )
    .all(threadId, start) as Record<string, unknown>[];

  return rows.map((r) => ({
    noteId: r.note_id as string,
    type: r.type as SemanticNote["type"],
    content: r.content as string,
    keywords: parseJsonArray(r.keywords as string),
    confidence: r.confidence as number,
    sourceEpisodes: parseJsonArray(r.source_episodes as string),
    linkedNotes: parseJsonArray(r.linked_notes as string),
    linkReasons: parseJsonObject(r.link_reasons as string) as Record<string, string>,
    validFrom: r.valid_from as string,
    validTo: r.valid_to as string | null,
    supersededBy: r.superseded_by as string | null,
    accessCount: r.access_count as number,
    lastAccessed: r.last_accessed as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    priority: (r.priority as number) ?? 0,
    threadId: r.thread_id as number,
    isGuardrail: (r.is_guardrail as number) === 1,
    pinned: (r.pinned as number) === 1,
  }));
}

// ─── Content Extraction ──────────────────────────────────────────────────────

function extractEpisodeText(ep: Episode): string {
  const content = ep.content as Record<string, unknown>;
  const text = (content.text || content.caption || content.message || "") as string;
  return text.slice(0, 300);
}

function formatEpisodesForLLM(episodes: Episode[], maxChars: number): string {
  const lines: string[] = [];
  let chars = 0;

  for (const ep of episodes) {
    const text = extractEpisodeText(ep);
    if (!text.trim()) continue;

    const ts = ep.timestamp.slice(0, 16).replace("T", " ");
    const line = `[${ts}] (${ep.type}/${ep.modality}) ${text}`;

    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }

  return lines.join("\n");
}

function formatNotesForLLM(notes: SemanticNote[], maxChars: number): string {
  const lines: string[] = [];
  let chars = 0;

  for (const n of notes) {
    const line = `- [${n.type}] ${n.content.slice(0, 200)} (conf: ${n.confidence.toFixed(2)})`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }

  return lines.join("\n");
}

// ─── LLM Prompts ─────────────────────────────────────────────────────────────

function buildPrompt(
  resolution: NarrativeResolution,
  episodesText: string,
  notesText: string,
  episodeCount: number,
  periodLabel: string,
): string {
  const instructions: Record<NarrativeResolution, string> = {
    day: `Write a detailed narrative of what happened today (${periodLabel}). Include specific events, decisions made, problems encountered, and outcomes. Use chronological order. Be concrete — mention specific features, fixes, discussions. Target ~500 tokens.`,
    week: `Write a concise narrative of the key developments this past week (${periodLabel}). Focus on: major decisions, direction changes, breakthroughs, blockers resolved. Group by theme rather than strict chronology. Target ~300 tokens.`,
    month: `Write a high-level narrative arc for this past month (${periodLabel}). Capture: the overall trajectory of the project, the operator's evolving priorities, major milestones, and where things stand now. Be strategic, not tactical. Target ~200 tokens.`,
    quarter: `Write a strategic narrative arc for this quarter (${periodLabel}). Capture: the major phases of work, how priorities shifted over three months, key turning points, and the overall trajectory. Identify patterns and recurring themes. Be executive-level, not detailed. Target ~150 tokens.`,
    half_year: `Write a bird's-eye narrative for this half-year (${periodLabel}). Capture: the broadest arcs of the project over six months — where it started, how it evolved, major pivots, and where it stands now. Focus on transformation and long-term patterns. Target ~120 tokens.`,
  };

  return `You are a temporal memory narrator. You create coherent stories from raw interaction data.

${instructions[resolution]}

FORMAT RULES:
- Write in first person for yourself ("I did...", "I noticed...") and third person for the operator ("The operator...")
- Use concrete timestamps when referencing specific events
- Preserve causal chains: "X happened, which led to Y, resulting in Z"
- Do NOT list facts — weave them into a narrative
- Do NOT use bullet points — write flowing paragraphs
- End with current status / what's next

SOURCE DATA (${episodeCount} episodes):

=== Recent Episodes ===
${episodesText || "(no episodes in this period)"}

=== Relevant Knowledge ===
${notesText || "(no notes)"}

Write the narrative now. Plain text, no markdown headers.`;
}

// ─── Cooldown Check ──────────────────────────────────────────────────────────

function getLastNarrative(
  db: Database,
  threadId: number,
  resolution: NarrativeResolution,
): TemporalNarrative | null {
  const row = db
    .prepare(
      `SELECT * FROM temporal_narratives
       WHERE thread_id = ? AND resolution = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(threadId, resolution) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as number,
    threadId: row.thread_id as number,
    resolution: row.resolution as NarrativeResolution,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    narrative: row.narrative as string,
    sourceEpisodeCount: row.source_episode_count as number,
    sourceNoteCount: row.source_note_count as number,
    model: row.model as string | null,
    createdAt: row.created_at as string,
  };
}

function isCooldownActive(db: Database, threadId: number, resolution: NarrativeResolution): boolean {
  const last = getLastNarrative(db, threadId, resolution);
  if (!last) return false;

  const elapsed = Date.now() - new Date(last.createdAt).getTime();
  return elapsed < COOLDOWNS[resolution];
}

// ─── Generation ──────────────────────────────────────────────────────────────

async function generateNarrative(
  db: Database,
  threadId: number,
  resolution: NarrativeResolution,
): Promise<TemporalNarrative | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

  const { start, end } = getPeriodBounds(resolution);
  const episodes = getEpisodesInPeriod(db, knowledgeThreadId, start, end);

  // Skip if too few episodes
  if (episodes.length < 3) return null;

  const notes = getNotesInPeriod(db, knowledgeThreadId, start);
  const maxChars = TOKEN_BUDGETS[resolution] * 4; // ~4 chars per token

  const episodesText = formatEpisodesForLLM(episodes, maxChars * 2);
  const notesText = formatNotesForLLM(notes, maxChars);

  const fmtShort = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const fmtRange = `${fmtShort(start)} – ${fmtShort(end)}`;
  const periodLabels: Record<NarrativeResolution, string> = {
    day: fmtShort(start),
    week: fmtRange,
    month: `Month of ${new Date(end).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
    quarter: `Quarter: ${fmtRange}`,
    half_year: `Half-year: ${fmtRange}`,
  };
  const periodLabel = periodLabels[resolution];

  const prompt = buildPrompt(resolution, episodesText, notesText, episodes.length, periodLabel);

  const narrative = await chatCompletion(
    [{ role: "user", content: prompt }],
    apiKey,
    {
      model: NARRATIVE_MODEL,
      temperature: 0.3,
      maxTokens: Math.ceil(TOKEN_BUDGETS[resolution] / 4), // rough token limit
      timeoutMs: 60_000,
    },
  );

  if (!narrative?.trim()) return null;

  // Upsert (replace existing for same period)
  db.prepare(
    `INSERT INTO temporal_narratives (thread_id, resolution, period_start, period_end, narrative, source_episode_count, source_note_count, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, resolution, period_start) DO UPDATE SET
       period_end = excluded.period_end,
       narrative = excluded.narrative,
       source_episode_count = excluded.source_episode_count,
       source_note_count = excluded.source_note_count,
       model = excluded.model,
       created_at = datetime('now')`,
  ).run(knowledgeThreadId, resolution, start, end, narrative.trim(), episodes.length, notes.length, NARRATIVE_MODEL);

  return getLastNarrative(db, knowledgeThreadId, resolution);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate all temporal narratives for a thread, respecting cooldowns.
 * Returns narratives that were generated or already cached.
 */
export async function runNarrativeGeneration(
  db: Database,
  threadId: number,
  options?: { force?: boolean },
): Promise<{ generated: NarrativeResolution[]; cached: NarrativeResolution[]; errors: string[] }> {
  const result: { generated: NarrativeResolution[]; cached: NarrativeResolution[]; errors: string[] } = {
    generated: [],
    cached: [],
    errors: [],
  };

  const resolutions: NarrativeResolution[] = ["day", "week", "month", "quarter", "half_year"];

  for (const res of resolutions) {
    try {
      if (!options?.force && isCooldownActive(db, threadId, res)) {
        result.cached.push(res);
        continue;
      }

      const narrative = await generateNarrative(db, threadId, res);
      if (narrative) {
        result.generated.push(res);
      } else {
        result.cached.push(res);
      }
    } catch (err) {
      result.errors.push(`${res}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Get the latest narratives for bootstrap injection.
 * Returns available narratives without triggering generation.
 */
export function getNarrativesForBootstrap(
  db: Database,
  threadId: number,
): Record<NarrativeResolution, string | null> {
  const result: Record<NarrativeResolution, string | null> = {
    day: null,
    week: null,
    month: null,
    quarter: null,
    half_year: null,
  };

  try {
    for (const res of ["day", "week", "month", "quarter", "half_year"] as NarrativeResolution[]) {
      const last = getLastNarrative(db, threadId, res);
      if (last) {
        result[res] = last.narrative;
      }
    }
  } catch { /* table might not exist in older schemas */ }

  return result;
}
