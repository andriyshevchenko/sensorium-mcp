/**
 * Temporal Narrative Generator
 *
 * Produces multi-resolution narratives from episodes and semantic notes:
 * - day:       detailed events (~400 tokens)
 * - week:      key decisions and progress (~800 tokens)
 * - month:     high-level arc (~1200 tokens)
 * - quarter:   strategic 3-month arc (~2000 tokens)
 * - half_year: bird's-eye 6-month arc (~2500 tokens)
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
  /\bpivotal (moments?|decisions?|turning)\b/i,
  /\bcrucial (step|milestone|decision)\b/i,
  /\bnotable (milestone|achievement|development)\b/i,
  /\bsubstantial (progress|improvement)\b/i,
  /\bremarkable (progress|growth|improvement)\b/i,
  /\bmeaningful (progress|improvement|change)\b/i,
  /\bas I (navigated|reflected|observed|witnessed)\b/i,
  /\bthis (prompted|led) me to reflect\b/i,
  /\bI (noticed|observed|witnessed) a (critical|pivotal|key)\b/i,
  /\bmarked by a series of\b/i,
  /\bpart of a broader effort\b/i,
  /\bshaped the (direction|trajectory)\b/i,
  /\bturning points? that\b/i,
  /\bset the stage for\b/i,
  /\bnot only .{5,40} but also\b/i,
  /\bculminating in\b/i,
  /\bthe focus remains on\b/i,
  /\bdriven by a commitment\b/i,
  /\bthis decision to\b/i,
  /\bthe current status reflects\b/i,
  /\bresulting in a more\b/i,
  /\bleading to more\b/i,
  /\baddress(ed|ing) the root causes? of\b/i,
  /\benhancing overall\b/i,
  /\baligning with\b/i,
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

  const identifierPattern = /\b(?:\d{4}[-/]\d{2}[-/]\d{2}|\d{1,2}:\d{2}|v\d+\.\d+|#\d+|ID\s*\d+|\d{3,}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))/i;
  const quotedNamePattern = /['"][^'"]+['"]|`[^`]+`/;
  const namedEntityPattern = /thread\s*\d+|ID\s*\d+|(?:MCP|API|LLM|GPT|SQL|WAL|CLI|SDK|PR|CI|CD)\b/i;
  const midSentenceProperNoun = (s: string): boolean => {
    const afterFirst = s.replace(/^\S+\s+/, "");
    return /\b[A-Z][a-z]{2,}/.test(afterFirst);
  };
  const hasNumber = (s: string): boolean => /\d+/.test(s);

  const lowDensity: string[] = [];
  for (const sentence of sentences) {
    const hasIdentifier = identifierPattern.test(sentence);
    const hasProperNoun = midSentenceProperNoun(sentence);
    const hasQuotedName = quotedNamePattern.test(sentence);
    const hasEntity = namedEntityPattern.test(sentence);
    const hasNum = hasNumber(sentence);

    if (!hasIdentifier && !hasProperNoun && !hasQuotedName && !hasEntity && !hasNum) {
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
  week: 800,
  month: 1600,
  quarter: 3000,
  half_year: 4000,
};

const INPUT_CHAR_BUDGETS: Record<NarrativeResolution, { episodes: number; notes: number }> = {
  day: { episodes: 30_000, notes: 10_000 },
  week: { episodes: 50_000, notes: 15_000 },
  month: { episodes: 60_000, notes: 20_000 },
  quarter: { episodes: 80_000, notes: 25_000 },
  half_year: { episodes: 100_000, notes: 30_000 },
};

const CHILD_RESOLUTION: Partial<Record<NarrativeResolution, NarrativeResolution>> = {
  month: "week",
  quarter: "month",
  half_year: "quarter",
};



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

function getEarliestEpisodeDate(db: Database, threadId: number): string | null {
  const row = db
    .prepare(`SELECT MIN(timestamp) as earliest FROM episodes WHERE thread_id = ?`)
    .get(threadId) as { earliest: string | null } | undefined;
  return row?.earliest ?? null;
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
  const text = (content.text || content.raw || content.caption || content.message || "") as string;
  return text.slice(0, 1500);
}

function formatEpisodeLine(ep: Episode, text: string): string {
  const ts = ep.timestamp.slice(0, 16).replace("T", " ");
  const imp = ep.importance != null && ep.importance !== 0.5 ? ` [imp: ${ep.importance.toFixed(1)}]` : "";
  const tags = ep.topicTags.length > 0 ? ` [tags: ${ep.topicTags.join(", ")}]` : "";
  return `[${ts}] (${ep.type}/${ep.modality})${imp}${tags} ${text}`;
}

function formatEpisodesForLLM(episodes: Episode[], maxChars: number): string {
  const importanceBudget = Math.round(maxChars * 0.3);

  // Pool 1: top episodes by importance (guaranteed inclusion)
  const byImportance = [...episodes].sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5));
  const selected = new Set<string>();
  const pool1: Array<{ ep: Episode; line: string }> = [];
  let pool1Chars = 0;

  for (const ep of byImportance) {
    const text = extractEpisodeText(ep);
    if (!text.trim()) continue;
    const line = formatEpisodeLine(ep, text);
    if (pool1Chars + line.length > importanceBudget) break;
    pool1.push({ ep, line });
    selected.add(ep.episodeId);
    pool1Chars += line.length;
  }

  // Pool 2: chronological fill (remaining budget)
  const remainingBudget = maxChars - pool1Chars;
  const chronological = [...episodes]
    .filter(ep => !selected.has(ep.episodeId))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const pool2: Array<{ ep: Episode; line: string }> = [];
  let pool2Chars = 0;

  for (const ep of chronological) {
    const text = extractEpisodeText(ep);
    if (!text.trim()) continue;
    const line = formatEpisodeLine(ep, text);
    if (pool2Chars + line.length > remainingBudget) break;
    pool2.push({ ep, line });
    pool2Chars += line.length;
  }

  // Merge both pools and sort chronologically for coherent reading
  return [...pool1, ...pool2]
    .sort((a, b) => (a.ep.timestamp < b.ep.timestamp ? -1 : 1))
    .map(x => x.line)
    .join("\n");
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
    day: `Write a narrative of what happened today (${periodLabel}). Tell the story chronologically — what happened, why, what it caused. Include timestamps (hours:minutes) for each event. Write in flowing prose, connecting events with cause and effect. Be specific: name systems, threads, versions, IDs. Target ~400 tokens.`,
    week: `Write a narrative of the key developments this week (${periodLabel}). Tell the story chronologically by day. For each event: what triggered it, what was decided, what resulted. Connect events across days — show how Monday's decision led to Wednesday's outcome. Write in flowing prose, not a list. Use day-level dates, no hours. Target ~800 tokens.`,
    month: `Write a chronological decision log for this month (${periodLabel}). Format: "Date — decision/event. Reason. Result." One entry per line. Each entry should have enough context to stand alone — a reader who sees only this entry should understand why it matters. Only include: decisions that changed project direction, bugs that broke something, features shipped. Skip routine fixes, code reviews, type errors, status checks. Day-level dates, no hours. End with unresolved items. Target ~1600 tokens.`,
    quarter: `Write a chronological decision log for this quarter (${periodLabel}). Format: "Date — decision/event. Reason. Result." One entry per line. Each entry should have enough context to stand alone — explain what problem existed before, what decision was made, and what changed after. Only include: decisions that changed project direction, major bugs, features shipped, architectural changes. Skip routine fixes, minor code reviews, type errors. Episodes marked [imp: 0.6+] are operator-priority — include them. Day-level dates, strict chronological order. End with unresolved items. Target ~3000 tokens.`,
    half_year: `Write a chronological decision log for this half-year (${periodLabel}). Format: "Date — decision/event. Reason. Result." One entry per line. Each entry should have enough context to stand alone — explain the situation before, what decision was made, and what changed as a result. Only include: decisions that changed project direction, major bugs, features shipped, architectural changes. Skip routine fixes, minor code reviews, type errors. Episodes marked [imp: 0.6+] are operator-priority — include them. Day-level dates, strict chronological order. End with current state. Target ~4000 tokens.`,
  };

  const styleByResolution: Record<NarrativeResolution, string> = {
    day: `STYLE:
- Write flowing prose, not bullet points or numbered lists. Connect events into a story.
- First person for yourself ("I did..."), third person for the operator ("The operator...").
- Name every system, thread, feature by exact name with IDs where available.
- Be concrete — every sentence needs at least one identifier (name, version, date, ID, number).
- Preserve cause-and-effect chains: "X happened because Y, which led to Z."
- No filler phrases: "significant progress", "notable improvement", "pivotal moment", "crucial step".
- NEVER open with "In [Month]..." or "During [Month]..." — start with what happened.
- NEVER write introductory or concluding paragraphs that summarize.`,
    week: `STYLE:
- Write flowing prose, not bullet points or numbered lists. Connect events into a weekly story.
- First person for yourself ("I did..."), third person for the operator ("The operator...").
- Name every system, thread, feature by exact name with IDs where available.
- Be concrete — every sentence needs at least one identifier (name, version, date, ID, number).
- Preserve cause-and-effect chains across days.
- No filler phrases: "significant progress", "notable improvement", "pivotal moment", "crucial step".
- NEVER open with "In [Month]..." or "During [Month]..." — start with what happened.
- NEVER write introductory or concluding paragraphs that summarize.`,
    month: `STYLE:
- Each log entry: 1-2 sentences with full context. A reader should understand the entry without reading others.
- First person for yourself ("I did..."), third person for the operator ("The operator...").
- Name every system, thread, feature by exact name with IDs where available.
- No filler phrases: "significant progress", "notable improvement", "pivotal moment", "crucial step".
- NEVER open with "In [Month]..." or "During [Month]..." or "The period was marked by...".
- NEVER write introductory or concluding paragraphs.`,
    quarter: `STYLE:
- Each log entry: 1-3 sentences with full context. Explain the situation before the decision, not just the decision itself.
- First person for yourself ("I did..."), third person for the operator ("The operator...").
- Name every system, thread, feature by exact name with IDs where available.
- No filler phrases: "significant progress", "notable improvement", "pivotal moment", "crucial step".
- NEVER open with "In [Month]..." or "During [Month]..." or "The period was marked by...".
- NEVER write introductory or concluding paragraphs.`,
    half_year: `STYLE:
- Each log entry: 1-3 sentences with full context. Explain the situation before the decision, not just the decision itself.
- First person for yourself ("I did..."), third person for the operator ("The operator...").
- Name every system, thread, feature by exact name with IDs where available.
- No filler phrases: "significant progress", "notable improvement", "pivotal moment", "crucial step".
- NEVER open with "In [Month]..." or "During [Month]..." or "The period was marked by...".
- NEVER write introductory or concluding paragraphs.`,
  };

  return `You are a temporal memory narrator. You create concise records from raw interaction data.

${instructions[resolution]}

${styleByResolution[resolution]}
- Only use years in the range ${startYear}${startYear !== endYear ? `–${endYear}` : ""}.

SOURCE DATA (${episodeCount} episodes):

=== Recent Episodes ===
${episodesText || "(no episodes in this period)"}

=== Relevant Knowledge ===
${notesText || "(no notes)"}

Write now. Plain text, no markdown.`;
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
    month: `Write a chronological decision log for this month (${periodLabel}). You have ${childCount} weekly narratives below. Format: "Date — decision/event. Reason. Result." One entry per line. Each entry should have enough context to stand alone — a reader who sees only this entry should understand why it matters. Preserve important context from the weekly narratives — don't compress away the reasons and consequences. Only include: decisions that changed project direction, bugs that broke something, features shipped. Skip routine fixes, code reviews, type errors. Day-level dates, no hours. End with unresolved items. Target ~1600 tokens.`,
    quarter: `Write a chronological decision log for this quarter (${periodLabel}). You have ${childCount} monthly narratives and possibly top-importance raw episodes below. Format: "Date — decision/event. Reason. Result." One entry per line. Each entry should have enough context to stand alone — explain what problem existed before, what decision was made, and what changed after. Don't just extract dates and facts from the monthly narratives — preserve the WHY and the consequences. Only include: decisions that changed project direction, major bugs, features shipped, architectural changes. Raw episodes marked [imp: 0.6+] are operator-priority — include them. Day-level dates, strict chronological order. End with unresolved items. Target ~3000 tokens.`,
    half_year: `Write a chronological decision log for this half-year (${periodLabel}). You have ${childCount} quarterly narratives and possibly top-importance raw episodes below. Format: "Date — decision/event. Reason. Result." One entry per line. Each entry should have enough context to stand alone — explain the situation before, what decision was made, and what changed as a result. Don't just extract dates and facts — preserve the full story behind each entry from the source narratives. Only include: decisions that changed project direction, major bugs, features shipped, architectural changes. Raw episodes marked [imp: 0.6+] are operator-priority — include them. Day-level dates, strict chronological order. End with current state. Target ~4000 tokens.`,
  };

  return `You are a temporal memory narrator. You create concise decision logs by synthesizing lower-resolution narratives.

${instructions[resolution]}

STYLE:
- Each log entry: 1-3 sentences with full context. Explain the situation, not just the fact.
- First person for yourself ("I did..."), third person for the operator ("The operator...").
- Name every system, thread, feature by exact name with IDs where available.
- Every sentence must have at least one identifier (name, version, date, ID, number).
- No filler phrases: "significant progress", "notable improvement", "pivotal moment", "crucial step", "driven by", "shaped the direction", "the focus remains on".
- NEVER open with "In [Month]..." or "During [Month]..." or "The period was marked by...".
- NEVER write introductory or concluding paragraphs.
- Only use years in the range ${startYear}${startYear !== endYear ? `–${endYear}` : ""}.

SOURCE: ${childCount} ${childResolution} narratives

${childNarrativesText}

Write now. Plain text, no markdown.`;
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

function getCurrentNarrative(
  db: Database,
  threadId: number,
  resolution: NarrativeResolution,
): TemporalNarrative | null {
  const row = db
    .prepare(
      `SELECT * FROM temporal_narratives
       WHERE thread_id = ? AND resolution = ?
         AND period_start <= datetime('now')
         AND period_end >= datetime('now', '-1 day')
       ORDER BY julianday(period_end) - julianday(period_start) DESC, created_at DESC
       LIMIT 1`,
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

function getChildWindowDays(resolution: NarrativeResolution): number {
  switch (resolution) {
    case "week": return 1;
    case "month": return 7;
    case "quarter": return 30;
    case "half_year": return 90;
    default: return 0;
  }
}

function enumerateChildWindows(
  resolution: NarrativeResolution,
  parentStart: string,
  parentEnd: string,
): Array<{ start: string; end: string }> {
  const childRes = CHILD_RESOLUTION[resolution];
  if (!childRes) return [];
  const windowDays = getChildWindowDays(resolution);
  if (windowDays === 0) return [];

  const windows: Array<{ start: string; end: string }> = [];
  const pEnd = new Date(parentEnd);
  const cur = new Date(parentStart);
  cur.setUTCHours(0, 0, 0, 0);

  while (cur < pEnd) {
    const wEnd = new Date(cur);
    wEnd.setUTCDate(wEnd.getUTCDate() + windowDays);
    if (wEnd > pEnd) wEnd.setTime(pEnd.getTime());
    windows.push({ start: cur.toISOString(), end: wEnd.toISOString() });
    cur.setUTCDate(cur.getUTCDate() + windowDays);
  }
  return windows;
}

async function backfillChildNarratives(
  db: Database,
  threadId: number,
  resolution: NarrativeResolution,
  parentStart: string,
  parentEnd: string,
): Promise<void> {
  const childRes = CHILD_RESOLUTION[resolution];
  if (!childRes) return;

  const knowledgeThreadId = resolveKnowledgeThreadId(threadId);
  const existing = getChildNarratives(db, knowledgeThreadId, resolution, parentStart, parentEnd);
  const existingStarts = new Set(existing.map(n => n.periodStart.slice(0, 10)));

  const windows = enumerateChildWindows(resolution, parentStart, parentEnd);
  for (const w of windows) {
    if (existingStarts.has(w.start.slice(0, 10))) continue;
    const episodes = getEpisodesInPeriod(db, knowledgeThreadId, w.start, w.end);
    if (episodes.length < 5) continue;

    log.info(`[narrative] backfilling ${childRes} for ${w.start.slice(0, 10)} — ${w.end.slice(0, 10)} (${episodes.length} episodes)`);
    await generateNarrative(db, threadId, childRes, { start: w.start, end: w.end });
  }
}

async function generateNarrative(
  db: Database,
  threadId: number,
  resolution: NarrativeResolution,
  periodOverride?: { start: string; end: string },
): Promise<TemporalNarrative | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

  const bounds = periodOverride ?? getPeriodBounds(resolution);
  // Clamp period start to earliest actual episode to prevent hallucinated dates
  const earliest = getEarliestEpisodeDate(db, knowledgeThreadId);
  const start = earliest && earliest > bounds.start ? earliest : bounds.start;
  const end = bounds.end;

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
    await backfillChildNarratives(db, threadId, resolution, start, end);
    const children = getChildNarratives(db, knowledgeThreadId, resolution, start, end);
    if (children.length > 0) {
      const childText = formatChildNarrativesForLLM(children);
      const coveredPeriods = new Set(
        children.flatMap(c => {
          const dates: string[] = [];
          const cur = new Date(c.periodStart);
          const stop = new Date(c.periodEnd);
          while (cur <= stop) {
            dates.push(cur.toISOString().slice(0, 10));
            cur.setUTCDate(cur.getUTCDate() + 1);
          }
          return dates;
        }),
      );
      const episodes = getEpisodesInPeriod(db, knowledgeThreadId, start, end);
      const gapEpisodes = episodes.filter(ep => !coveredPeriods.has(ep.timestamp.slice(0, 10)));
      const budget = INPUT_CHAR_BUDGETS[resolution];
      const gapText = gapEpisodes.length > 0 ? formatEpisodesForLLM(gapEpisodes, budget.episodes) : "";

      // For quarter/half_year: inject top-20 highest-importance raw episodes so strategic
      // decisions survive hierarchical compression
      let topEpisodesText = "";
      if (resolution === "quarter" || resolution === "half_year") {
        const topN = [...episodes]
          .filter(ep => (ep.importance ?? 0.5) >= 0.6)
          .sort((a, b) => (b.importance ?? 0.5) - (a.importance ?? 0.5))
          .slice(0, 20);
        if (topN.length > 0) {
          topEpisodesText = topN.map(ep => {
            const text = extractEpisodeText(ep);
            return text.trim() ? formatEpisodeLine(ep, text) : "";
          }).filter(Boolean).join("\n");
        }
      }

      const parts = [`=== ${children.length} ${childRes} narrative(s) ===\n${childText}`];
      if (topEpisodesText) parts.push(`=== Top-importance raw episodes (for detail recovery) ===\n${topEpisodesText}`);
      if (gapEpisodes.length > 0) parts.push(`=== Raw episodes from uncovered periods ===\n${gapText}`);
      const source = parts.join("\n\n");
      prompt = buildHierarchicalPrompt(resolution, source, childRes, children.length, periodLabel, start);
      sourceEpisodeCount = children.reduce((sum, c) => sum + c.sourceEpisodeCount, 0) + gapEpisodes.length;
      sourceNoteCount = 0;
      log.info(`[narrative] ${resolution}: ${children.length} ${childRes} narratives + ${gapEpisodes.length} gap episodes`);
    } else {
      log.info(`[narrative] ${resolution}: no ${childRes} narratives available, falling back to raw episodes`);
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
  const hasDensityProblem = densityRatio > 0.35;
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
      if (retryFiller || retryDate || retryDensityRatio > 0.35) {
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
      const narrative = getCurrentNarrative(db, threadId, res) ?? getLastNarrative(db, threadId, res);
      if (narrative) {
        result[res] = narrative.narrative;
      }
    }
  } catch (err) { log.debug(`[narrative] getNarrativesForBootstrap failed: ${errorMessage(err)}`); }

  return result;
}
