/**
 * Temporal Narrative Generator
 *
 * Produces multi-resolution narratives from episodes and semantic notes:
 * - day:       detailed events (~400 tokens)
 * - week:      key decisions and progress (~600 tokens)
 * - month:     high-level arc (~800 tokens)
 * - quarter:   strategic 3-month arc (~1000 tokens)
 * - half_year: bird's-eye 6-month arc (~1200 tokens)
 *
 * These narratives replace raw note dumps in bootstrap and give the agent
 * coherent temporal awareness across long-running sessions.
 */

import type { Database } from "./schema.js";
import { chatCompletion } from "../../integrations/openai/chat.js";
import { type Episode } from "./episodes.js";
import { type SemanticNote } from "./semantic.js";
import { resolveKnowledgeThreadId } from "../../config.js";
import { getThread } from "./thread-registry.js";
import { parseJsonArray, parseJsonObject } from "./utils.js";
import { errorMessage } from "../../utils.js";
import { log } from "../../logger.js";

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

const NARRATIVE_FILLER_PHRASES: RegExp[] = [
  /\bsignificant progress\b/i,
  /\bnotable improvements?\b/i,
  /\bvarious features\b/i,
  /\bseveral enhancements\b/i,
  /\bsignificant (evolution|strides|developments?)\b/i,
  /\boverall.{0,20}(positive|good|well)\b/i,
  /\bpivotal moments?\b/i,
  /\bcrucial (step|milestone|decision)\b/i,
  /\bnotable (milestone|achievement|development)\b/i,
  /\bsubstantial (progress|improvement)\b/i,
  /\bremarkable (progress|growth|improvement)\b/i,
  /\bmeaningful (progress|improvement|change)\b/i,
  /\bas I (navigated|reflected|observed|witnessed)\b/i,
  /\bthis (prompted|led) me to reflect\b/i,
  /\bI (noticed|observed|witnessed) a (critical|pivotal|key)\b/i,
];

function findFillerPhrase(text: string): string | null {
  for (const pattern of NARRATIVE_FILLER_PHRASES) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function findDateViolation(text: string, periodStart: string, periodEnd: string): string | null {
  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);
  const validYears = new Set<number>();
  for (let y = startDate.getFullYear(); y <= endDate.getFullYear(); y++) validYears.add(y);

  // Check standalone year references (e.g. "in 2025", "2025–2026")
  const yearMatches = text.matchAll(/\b(20\d{2})\b/g);
  for (const m of yearMatches) {
    const year = parseInt(m[1], 10);
    if (!validYears.has(year)) return `year ${year} outside valid range ${[...validYears].join("–")}`;
  }

  // Check month+year combos (e.g. "March 2026", "Apr 2025")
  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthPattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/gi;
  for (const m of text.matchAll(monthPattern)) {
    const monthStr = m[1].toLowerCase().slice(0, 3);
    const monthIdx = monthNames.findIndex((mn) => mn.startsWith(monthStr));
    const year = parseInt(m[2], 10);
    if (monthIdx === -1) continue;
    const refDate = new Date(year, monthIdx, 15);
    const windowStart = new Date(startDate);
    windowStart.setDate(windowStart.getDate() - 7);
    const windowEnd = new Date(endDate);
    windowEnd.setDate(windowEnd.getDate() + 7);
    if (refDate < windowStart || refDate > windowEnd) {
      return `"${m[0]}" falls outside the period ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}`;
    }
  }

  return null;
}

function findLowDensitySentences(text: string): { count: number; total: number; examples: string[] } {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 20);
  if (sentences.length === 0) return { count: 0, total: 0, examples: [] };

  const identifierPattern = /\b(?:\d{4}[-/]\d{2}[-/]\d{2}|v\d+\.\d+|#\d+|ID\s*\d+|\d{4,}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2})/i;
  const quotedNamePattern = /['"][^'"]+['"]/;
  const threadIdPattern = /thread\s*\d+|ID\s*\d+/i;
  // Check for proper nouns after the first word (sentence-initial caps don't count)
  const midSentenceProperNoun = (s: string): boolean => {
    const afterFirst = s.replace(/^\S+\s+/, "");
    return /\b[A-Z][a-z]{2,}/.test(afterFirst);
  };

  const lowDensity: string[] = [];
  for (const sentence of sentences) {
    const hasIdentifier = identifierPattern.test(sentence);
    const hasProperNoun = midSentenceProperNoun(sentence);
    const hasQuotedName = quotedNamePattern.test(sentence);
    const hasThreadId = threadIdPattern.test(sentence);

    if (!hasIdentifier && !hasProperNoun && !hasQuotedName && !hasThreadId) {
      lowDensity.push(sentence.slice(0, 80));
    }
  }

  return { count: lowDensity.length, total: sentences.length, examples: lowDensity.slice(0, 3) };
}

/** Cooldown per resolution before regenerating */
const COOLDOWNS: Record<NarrativeResolution, number> = {
  day: 2 * 60 * 60 * 1000,        // 2 hours
  week: 12 * 60 * 60 * 1000,      // 12 hours
  month: 24 * 60 * 60 * 1000,     // 24 hours
  quarter: 7 * 24 * 60 * 60 * 1000,   // 7 days
  half_year: 14 * 24 * 60 * 60 * 1000, // 14 days
};

/** Target output token count per resolution */
const OUTPUT_TOKEN_TARGETS: Record<NarrativeResolution, number> = {
  day: 400,
  week: 600,
  month: 800,
  quarter: 1000,
  half_year: 1200,
};

const INPUT_CHAR_BUDGETS: Record<NarrativeResolution, { episodes: number; notes: number }> = {
  day: { episodes: 30_000, notes: 10_000 },
  week: { episodes: 50_000, notes: 15_000 },
  month: { episodes: 60_000, notes: 20_000 },
  quarter: { episodes: 80_000, notes: 25_000 },
  half_year: { episodes: 100_000, notes: 30_000 },
};

const CHILD_RESOLUTION: Partial<Record<NarrativeResolution, NarrativeResolution>> = {
  week: "day",
  month: "week",
  quarter: "month",
  half_year: "quarter",
};

const MIN_CHILD_NARRATIVES = 2;

const NARRATIVE_MODEL =
  process.env.NARRATIVE_MODEL || process.env.CONSOLIDATION_MODEL || "gpt-4o";

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
    qualityScore: (r.quality_score as number | null) ?? null,
  }));
}

// ─── Child Narrative Retrieval ──────────────────────────────────────────────

function getChildNarratives(
  db: Database,
  threadId: number,
  resolution: NarrativeResolution,
  start: string,
  end: string,
): TemporalNarrative[] {
  const child = CHILD_RESOLUTION[resolution];
  if (!child) return [];

  const rows = db
    .prepare(
      `SELECT * FROM temporal_narratives
       WHERE thread_id = ? AND resolution = ? AND period_start >= ? AND period_start <= ?
       ORDER BY period_start ASC`,
    )
    .all(threadId, child, start, end) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as number,
    threadId: r.thread_id as number,
    resolution: r.resolution as NarrativeResolution,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    narrative: r.narrative as string,
    sourceEpisodeCount: r.source_episode_count as number,
    sourceNoteCount: r.source_note_count as number,
    model: r.model as string | null,
    createdAt: r.created_at as string,
  }));
}

function formatChildNarrativesForLLM(narratives: TemporalNarrative[]): string {
  return narratives
    .map((n) => {
      const fmtDate = (d: string) =>
        new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `--- ${n.resolution} narrative (${fmtDate(n.periodStart)} – ${fmtDate(n.periodEnd)}, ${n.sourceEpisodeCount} episodes) ---\n${n.narrative}`;
    })
    .join("\n\n");
}

// ─── Content Extraction ──────────────────────────────────────────────────────

function extractEpisodeText(ep: Episode): string {
  const content = ep.content as Record<string, unknown>;
  const text = (content.text || content.caption || content.message || "") as string;
  return text.slice(0, 1500);
}

function formatEpisodesForLLM(episodes: Episode[], maxChars: number): string {
  const lines: string[] = [];
  let chars = 0;

  // Sort by importance DESC within chronological hour buckets so high-importance
  // episodes aren't crowded out when the char budget is hit.
  const sorted = [...episodes].sort((a, b) => {
    const hourA = a.timestamp.slice(0, 13);
    const hourB = b.timestamp.slice(0, 13);
    if (hourA !== hourB) return hourA < hourB ? -1 : 1;
    return (b.importance ?? 0.5) - (a.importance ?? 0.5);
  });

  for (const ep of sorted) {
    const text = extractEpisodeText(ep);
    if (!text.trim()) continue;

    const ts = ep.timestamp.slice(0, 16).replace("T", " ");
    const tags = ep.topicTags.length > 0 ? ` [tags: ${ep.topicTags.join(", ")}]` : "";
    const line = `[${ts}] (${ep.type}/${ep.modality})${tags} ${text}`;

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
    const line = `- [${n.type}] ${n.content.slice(0, 600)} (conf: ${n.confidence.toFixed(2)})`;
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
  periodStart: string,
): string {
  const startYear = new Date(periodStart).getFullYear();
  const endYear = new Date().getFullYear();
  const instructions: Record<NarrativeResolution, string> = {
    day: `Write a detailed narrative of what happened today (${periodLabel}). Include specific events, decisions made, problems encountered, and outcomes. Use chronological order. Be concrete — mention specific features, fixes, discussions. For each major event, explain WHY it happened and what it caused. Don't just list what happened — explain the chain of consequences. Target ~400 tokens.`,
    week: `Write a concise narrative of the key developments this past week (${periodLabel}). For each development, explain: what triggered it, what decision was made, and what resulted. Connect events causally — show how Monday's decision led to Wednesday's outcome. Group by causal chains, not just themes. Target ~600 tokens.`,
    month: `Write a narrative arc for this past month (${periodLabel}). Structure around 2-3 major cause-effect chains: what problem or opportunity emerged, what decisions were made in response, and how those decisions played out. Name specific features, tools, or systems — not abstractions. End with what's unresolved. Target ~800 tokens.`,
    quarter: `Write a narrative arc for this quarter (${periodLabel}). Identify 2-3 pivotal decisions or turning points. For each: what was the situation before, what changed, and what was the lasting impact. Show how the project's direction evolved through concrete cause-and-effect, not vague 'themes'. Target ~1000 tokens.`,
    half_year: `Write a bird's-eye narrative for this half-year (${periodLabel}). Capture the 1-2 biggest transformations: where the project started, what specific events or decisions caused the shift, and where it stands now. Every claim must reference a concrete event or decision — no unsupported generalizations like 'significant progress' or 'notable improvements'. Target ~1200 tokens.`,
  };

  return `You are a temporal memory narrator. You create coherent stories from raw interaction data.

${instructions[resolution]}

PRECISION RULES (non-negotiable):
- Name every thread, feature, tool, or system by its EXACT name. Include IDs/numbers where available (e.g., "thread 'Archived threads viewer' (ID 16586)", not "the new thread").
- Include timestamps (dates at minimum, times when relevant) for every event.
- Never write "the thread" / "the feature" / "this issue" / "the system" without naming it first.
- Every sentence must contain at least one concrete identifier: a name, version, date, ID, or number. If a sentence contains none, delete it.
- When referencing a decision, state WHO decided, WHAT was decided, and WHY.
- Zero filler: if removing a sentence loses no information, don't write it. Density over flow.

FORMAT RULES:
- Write in first person for yourself ("I did...", "I noticed...") and third person for the operator ("The operator...")
- Use concrete timestamps when referencing specific events
- Preserve causal chains: "X happened, which led to Y, resulting in Z"
- Do NOT list facts — weave them into a narrative
- Do NOT use bullet points — write flowing paragraphs
- End with current status / what's next
- NEVER use filler phrases like: "significant progress/evolution/strides", "notable improvement/milestone/achievement", "various features", "several enhancements", "pivotal moments", "crucial step/milestone/decision", "substantial/remarkable/meaningful progress", "overall good/positive", "as I navigated/reflected/observed", "this prompted me to reflect", "I noticed a critical/key ..."
- Every claim must be grounded in a specific event, decision, or outcome from the source data
- If you can't point to specific evidence, don't include it
- NEVER open with a date-setting sentence like "In [Month Year]..." or "During [Month Year]..." — start with what actually happened
- Only use years that appear in the period range (${startYear}${startYear !== endYear ? `–${endYear}` : ""}) — never substitute today's year for an earlier period

SOURCE DATA (${episodeCount} episodes):

=== Recent Episodes ===
${episodesText || "(no episodes in this period)"}

=== Relevant Knowledge ===
${notesText || "(no notes)"}

Write the narrative now. Plain text, no markdown headers.`;
}

function buildHierarchicalPrompt(
  resolution: NarrativeResolution,
  childNarrativesText: string,
  childResolution: NarrativeResolution,
  childCount: number,
  periodLabel: string,
  periodStart: string,
): string {
  const startYear = new Date(periodStart).getFullYear();
  const endYear = new Date().getFullYear();
  const instructions: Partial<Record<NarrativeResolution, string>> = {
    week: `Write a narrative of the key developments this past week (${periodLabel}). You have ${childCount} daily narratives below — synthesize them into a coherent weekly arc. For each development, explain: what triggered it, what decision was made, and what resulted. Connect events causally — show how earlier days' decisions led to later outcomes. Target ~600 tokens.`,
    month: `Write a narrative arc for this past month (${periodLabel}). You have ${childCount} weekly narratives below — synthesize them into 2-3 major cause-effect chains. Show how the week-to-week trajectory evolved: what problems emerged, what decisions were made, and how they played out across weeks. Name specific features, tools, or systems. End with what's unresolved. Target ~800 tokens.`,
    quarter: `Write a narrative arc for this quarter (${periodLabel}). You have ${childCount} monthly narratives below — synthesize them into 2-3 pivotal decisions or turning points. For each: what was the situation before, what changed, and what was the lasting impact. Show how the project's direction evolved month-over-month through concrete cause-and-effect. Target ~1000 tokens.`,
    half_year: `Write a bird's-eye narrative for this half-year (${periodLabel}). You have ${childCount} quarterly narratives below — synthesize them into the 1-2 biggest transformations. Where the project started, what specific events or decisions caused the shift, and where it stands now. Every claim must reference a concrete event or decision from the source narratives. Target ~1200 tokens.`,
  };

  return `You are a temporal memory narrator. You create coherent stories by synthesizing lower-resolution narratives into higher-level arcs.

${instructions[resolution]}

PRECISION RULES (non-negotiable):
- Name every thread, feature, tool, or system by its EXACT name. Include IDs/numbers where available (e.g., "thread 'Archived threads viewer' (ID 16586)", not "the new thread").
- Include timestamps (dates at minimum, times when relevant) for every event.
- Never write "the thread" / "the feature" / "this issue" / "the system" without naming it first.
- Every sentence must contain at least one concrete identifier: a name, version, date, ID, or number. If a sentence contains none, delete it.
- When referencing a decision, state WHO decided, WHAT was decided, and WHY.
- Zero filler: if removing a sentence loses no information, don't write it. Density over flow.

FORMAT RULES:
- Write in first person for yourself ("I did...", "I noticed...") and third person for the operator ("The operator...")
- Preserve causal chains: "X happened, which led to Y, resulting in Z"
- Do NOT list facts — weave them into a narrative
- Do NOT use bullet points — write flowing paragraphs
- End with current status / what's next
- NEVER use filler phrases like: "significant progress/evolution/strides", "notable improvement/milestone/achievement", "various features", "several enhancements", "pivotal moments", "crucial step/milestone/decision", "substantial/remarkable/meaningful progress", "overall good/positive", "as I navigated/reflected/observed", "this prompted me to reflect", "I noticed a critical/key ..."
- Every claim must be grounded in a specific event, decision, or outcome from the source narratives
- NEVER open with a date-setting sentence like "In [Month Year]..." or "During [Month Year]..." — start with what actually happened
- Only use years that appear in the period range (${startYear}${startYear !== endYear ? `–${endYear}` : ""}) — never substitute today's year for an earlier period

SOURCE: ${childCount} ${childResolution} narratives

${childNarrativesText}

Write the narrative now. Plain text, no markdown headers.`;
}

function buildFlatPrompt(
  db: Database,
  knowledgeThreadId: number,
  resolution: NarrativeResolution,
  start: string,
  end: string,
  periodLabel: string,
): { prompt: string; episodeCount: number; noteCount: number } | null {
  const episodes = getEpisodesInPeriod(db, knowledgeThreadId, start, end);
  const minEpisodes = resolution === "day" ? 3 : 5;
  if (episodes.length < minEpisodes) return null;

  const notes = getNotesInPeriod(db, knowledgeThreadId, start);
  const budget = INPUT_CHAR_BUDGETS[resolution];
  const episodesText = formatEpisodesForLLM(episodes, budget.episodes);

  if (episodesText.length < 200 && notes.length === 0) return null;

  const notesText = formatNotesForLLM(notes, budget.notes);
  return {
    prompt: buildPrompt(resolution, episodesText, notesText, episodes.length, periodLabel, start),
    episodeCount: episodes.length,
    noteCount: notes.length,
  };
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

  const fmtShort = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const fmtRange = `${fmtShort(start)} – ${fmtShort(end)}`;
  const periodLabels: Record<NarrativeResolution, string> = {
    day: fmtShort(start),
    week: fmtRange,
    month: `Month of ${new Date(start).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
    quarter: `Quarter: ${fmtRange}`,
    half_year: `Half-year: ${fmtRange}`,
  };
  const periodLabel = periodLabels[resolution];

  // Hierarchical composition: week+ resolutions compose from child narratives when available
  const childRes = CHILD_RESOLUTION[resolution];
  let prompt: string;
  let sourceEpisodeCount: number;
  let sourceNoteCount: number;

  if (childRes) {
    const children = getChildNarratives(db, knowledgeThreadId, resolution, start, end);
    if (children.length >= MIN_CHILD_NARRATIVES) {
      const childText = formatChildNarrativesForLLM(children);
      prompt = buildHierarchicalPrompt(resolution, childText, childRes, children.length, periodLabel, start);
      sourceEpisodeCount = children.length;
      sourceNoteCount = 0;
      log.info(`[narrative] ${resolution}: composing from ${children.length} ${childRes} narratives (hierarchical)`);
    } else {
      log.info(`[narrative] ${resolution}: only ${children.length} ${childRes} narratives available, falling back to raw episodes`);
      const fallback = buildFlatPrompt(db, knowledgeThreadId, resolution, start, end, periodLabel);
      if (!fallback) return null;
      prompt = fallback.prompt;
      sourceEpisodeCount = fallback.episodeCount;
      sourceNoteCount = fallback.noteCount;
    }
  } else {
    const fallback = buildFlatPrompt(db, knowledgeThreadId, resolution, start, end, periodLabel);
    if (!fallback) return null;
    prompt = fallback.prompt;
    sourceEpisodeCount = fallback.episodeCount;
    sourceNoteCount = fallback.noteCount;
  }

  const narrative = await chatCompletion(
    [{ role: "user", content: prompt }],
    apiKey,
    {
      model: NARRATIVE_MODEL,
      temperature: 0.3,
      maxTokens: Math.round(OUTPUT_TOKEN_TARGETS[resolution] * 1.5),
      timeoutMs: 60_000,
    },
  );

  if (!narrative?.trim()) return null;

  // ─── Quality gate: reject filler language, date errors, and low density, retry once ───
  let finalNarrative = narrative.trim();
  const fillerMatch = findFillerPhrase(finalNarrative);
  const dateViolation = findDateViolation(finalNarrative, start, end);
  const density = findLowDensitySentences(finalNarrative);
  const densityRatio = density.total > 0 ? density.count / density.total : 0;
  const hasDensityProblem = densityRatio > 0.2;
  if (fillerMatch || dateViolation || hasDensityProblem) {
    const issues: string[] = [];
    if (fillerMatch) issues.push(`filler phrase "${fillerMatch}"`);
    if (dateViolation) issues.push(`date violation: ${dateViolation}`);
    if (hasDensityProblem) issues.push(`${density.count}/${density.total} sentences lack identifiers (${(densityRatio * 100).toFixed(0)}%)`);
    log.warn(`[narrative] quality issue in ${resolution} narrative (${issues.join(", ")}) — retrying`);

    const corrections: string[] = [];
    if (fillerMatch) corrections.push("Rewrite using no filler phrases.");
    if (dateViolation) corrections.push(`Fix date error: ${dateViolation}. Only reference dates within the period ${start.slice(0, 10)} to ${end.slice(0, 10)}. Do NOT substitute the current year for dates in earlier periods.`);
    if (hasDensityProblem) corrections.push(`${density.count} sentences contain no identifiers (names, dates, numbers, IDs). Examples: ${density.examples.map(s => `"${s}..."`).join("; ")}. Every sentence must contain at least one concrete identifier.`);

    const retryPrompt = prompt + "\n\n" + corrections.join(" ") + " Every claim must reference a specific event or decision from the source data.";
    const retried = await chatCompletion(
      [{ role: "user", content: retryPrompt }],
      apiKey,
      { model: NARRATIVE_MODEL, temperature: 0.3, maxTokens: Math.round(OUTPUT_TOKEN_TARGETS[resolution] * 1.5), timeoutMs: 60_000 },
    );
    if (retried?.trim()) {
      const retryFiller = findFillerPhrase(retried.trim());
      const retryDate = findDateViolation(retried.trim(), start, end);
      const retryDensity = findLowDensitySentences(retried.trim());
      const retryDensityRatio = retryDensity.total > 0 ? retryDensity.count / retryDensity.total : 0;
      if (retryFiller || retryDate || retryDensityRatio > 0.2) {
        log.warn(`[narrative] retry still has issues in ${resolution} — keeping original`);
      } else {
        finalNarrative = retried.trim();
      }
    }
  }

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
  ).run(knowledgeThreadId, resolution, start, end, finalNarrative, sourceEpisodeCount, sourceNoteCount, NARRATIVE_MODEL);

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

  const threadEntry = getThread(db, threadId);
  if (threadEntry?.type === "worker") {
    log.info(`[narrative] Skipping — thread ${threadId} is a worker thread`);
    return result;
  }

  const resolutions: NarrativeResolution[] = ["day", "week", "month", "quarter", "half_year"];
  const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

  for (const res of resolutions) {
    try {
      if (!options?.force && isCooldownActive(db, knowledgeThreadId, res)) {
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
      result.errors.push(`${res}: ${errorMessage(err)}`);
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
  } catch (err) { log.debug(`[narrative] getNarrativesForBootstrap failed: ${errorMessage(err)}`); }

  return result;
}
