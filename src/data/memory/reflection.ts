/**
 * Reflection pipeline — the "dreaming" phase that generates deeper insights
 * from episodic memories after consolidation.
 *
 * Unlike consolidation (which extracts facts and preferences), reflection
 * finds causal chains, recurring patterns, counterfactuals, and
 * self-assessments across episodes.  It runs post-consolidation when
 * enough episodes exist, rate-limited to once per 4 hours.
 */

import type { Database } from "./schema.js";
import { type Episode, rowToEpisode } from "./episodes.js";
import { saveSemanticNote, searchByEmbedding, saveNoteEmbedding } from "./semantic.js";
import { saveProcedure, enforceProcedureCap, getProcedureByName } from "./procedures.js";
import { nowISO } from "./utils.js";
import { log } from "../../logger.js";
import { resolveKnowledgeThreadId } from "../../config.js";
import {
  chatCompletion,
  generateEmbedding,
  type ChatMessage,
} from "../../integrations/openai/chat.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReflectionInsight {
  type: "causal" | "pattern" | "self_assessment" | "counterfactual";
  content: string;
  confidence: number;
  relatedEpisodeIds: string[];
}

interface ReflectionResult {
  insights: ReflectionInsight[];
  processedEpisodeCount: number;
  duration: number;
}

// ─── Rate-limiting ───────────────────────────────────────────────────────────

const REFLECTION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_EPISODES_FOR_REFLECTION = 20;

// ─── Buffer cap & quality gate ───────────────────────────────────────────────
const MAX_ACTIVE_REFLECTIONS = 150;
const STALE_REFLECTION_DAYS = 30;
const MIN_INSIGHT_LENGTH = 40;
const VAGUE_PATTERNS = [
  /\bthe agent tends to\b/i,
  /\bthe agent demonstrates\b/i,
  /\bthe agent frequently\b/i,
  /\bthis (is|was) (a |an )?(good|important|useful)\b/i,
  /\bin general\b/i,
  /\boverall\b.*\b(good|well|effective)\b/i,
];

/** Per-thread timestamp of the last successful reflection run. */
const lastReflectionAt = new Map<number, number>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract text from an episode's content object. */
function episodeText(ep: Episode): string {
  const c = ep.content;
  if (typeof c === "string") return c;
  return (c.text as string) ?? (c.caption as string) ?? JSON.stringify(c);
}

/** Build a time-ordered narrative from a list of episodes. */
function buildNarrative(episodes: Episode[]): string {
  return episodes
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((ep) => `[${ep.episodeId}] (${ep.type}/${ep.modality}, ${ep.timestamp}) ${episodeText(ep)}`)
    .join("\n");
}

/** Gather consolidated episodes: last N recent + random sample of older ones. */
function gatherEpisodes(
  db: Database,
  threadId: number,
  maxRecent: number,
  oldSampleSize: number,
): Episode[] {
  // Recent consolidated episodes
  const recentRows = db
    .prepare(
      `SELECT * FROM episodes
       WHERE thread_id = ? AND consolidated = 1
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(threadId, maxRecent) as Record<string, unknown>[];

  const recentIds = new Set(recentRows.map((r) => r.episode_id as string));

  // Random sample of older consolidated episodes from the past 7 days
  // (excluding the ones already in the recent set)
  const olderRows = db
    .prepare(
      `SELECT * FROM episodes
       WHERE thread_id = ? AND consolidated = 1
         AND timestamp >= datetime('now', '-7 days')
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(threadId, oldSampleSize + recentRows.length) as Record<string, unknown>[];

  const olderFiltered = olderRows
    .filter((r) => !recentIds.has(r.episode_id as string))
    .slice(0, oldSampleSize);

  const allRows = [...recentRows, ...olderFiltered];
  return allRows.map(rowToEpisode);
}

// ─── JSON repair (minimal — shared pattern with consolidation.ts) ────────────

/** Return true if the character at `pos` is preceded by an odd number of backslashes (i.e. it is escaped). */
function isEscaped(text: string, pos: number): boolean {
  let count = 0;
  let i = pos - 1;
  while (i >= 0 && text[i] === "\\") { count++; i--; }
  return count % 2 !== 0;
}

function repairAndParseJSON(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* continue */ }

  let text = raw.trim();

  // Strip markdown fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    try { return JSON.parse(text); } catch { /* continue */ }
  }

  // Fix unescaped control characters inside strings
  const chars: string[] = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !isEscaped(text, i)) { inStr = !inStr; chars.push(ch); continue; }
    if (inStr) {
      if (ch === "\n") { chars.push("\\n"); continue; }
      if (ch === "\r") { chars.push("\\r"); continue; }
      if (ch === "\t") { chars.push("\\t"); continue; }
    }
    chars.push(ch);
  }
  text = chars.join("");
  try { return JSON.parse(text); } catch { /* continue */ }

  // Close truncated structures
  let quoteCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && !isEscaped(text, i)) quoteCount++;
  }
  if (quoteCount % 2 !== 0) text += '"';

  text = text.replace(/,\s*"[^"]*"\s*:\s*$/, "");
  text = text.replace(/,\s*$/, "");

  const opens: string[] = [];
  let scanning = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && !isEscaped(text, i)) { scanning = !scanning; continue; }
    if (scanning) continue;
    if (c === "{" || c === "[") opens.push(c);
    else if (c === "}" || c === "]") opens.pop();
  }
  for (let i = opens.length - 1; i >= 0; i--) {
    text += opens[i] === "{" ? "}" : "]";
  }

  try { return JSON.parse(text); } catch { /* continue */ }
  throw new SyntaxError(`Unable to repair reflection JSON (length=${raw.length}): ${raw.slice(0, 200)}…`);
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const REFLECTION_SYSTEM_PROMPT = `You are a reflective reasoning system analyzing your own recent experiences. Your job is to extract DEEP insights — not surface-level summaries. Write in first person ("I").

## Analysis tasks:

1. CAUSAL CHAINS: What caused what? Find cause-effect relationships. "When [X happened], it led to [Y] because [Z]." Be specific — cite episode IDs.

2. RECURRING PATTERNS: What behaviors, problems, or situations keep repeating? "The operator tends to [X] when [Y]." or "I tend to fail at [X] in [Y] conditions."

3. COUNTERFACTUALS: For any negative outcomes or frustrations, what could have been done differently? "Instead of [X], I could have [Y], which would have [Z]."

4. SELF-ASSESSMENT: What do I do well? What are my weaknesses? "I'm strong at [X] but struggle with [Y]."

Respond in JSON format:
{
  "insights": [
    {
      "type": "causal" | "pattern" | "self_assessment" | "counterfactual",
      "content": "Specific, actionable insight with references to specific events",
      "confidence": 0.0-1.0,
      "episode_refs": ["ep_xxx", "ep_yyy"]
    }
  ]
}

Rules:
- Minimum 3, maximum 10 insights
- Each insight must reference specific episodes by their ID
- Avoid generic statements — be specific to the actual events
- Confidence should reflect how well-supported the insight is by evidence
- Causal and pattern insights are most valuable
- Every insight MUST be actionable: it should tell future-me what to DO differently, not just observe a pattern
- BAD: "The agent tends to struggle with complex tasks" (vague, no action)
- GOOD: "When I receive multi-step requests, I should decompose them into sub-tasks before starting, because attempting all at once led to errors in ep_xxx"
- Reject any insight shorter than 40 characters — depth matters`;

// ─── De-duplication ──────────────────────────────────────────────────────────

const DEDUP_SIMILARITY_THRESHOLD = 0.90;

async function checkDuplicate(
  db: Database,
  content: string,
  apiKey: string,
  threadId: number,
): Promise<{ isDuplicate: boolean; embedding: Float32Array | null }> {
  try {
    const embedding = await generateEmbedding(content, apiKey);
    const matches = searchByEmbedding(db, embedding, {
      maxResults: 3,
      minSimilarity: DEDUP_SIMILARITY_THRESHOLD,
      skipAccessTracking: true,
      threadId,
    });
    const isDuplicate = matches.some(
      (m) => m.similarity >= DEDUP_SIMILARITY_THRESHOLD && m.content.startsWith("[REFLECTION]"),
    );
    return { isDuplicate, embedding };
  } catch {
    // Embedding lookup failed — allow the insight through to avoid data loss
    return { isDuplicate: false, embedding: null };
  }
}

// ─── Quality gate ────────────────────────────────────────────────────────────

/** Check if an insight passes the quality gate (actionable, specific, non-vague). */
function passesQualityGate(content: string, confidence: number): { pass: boolean; reason?: string } {
  if (content.length < MIN_INSIGHT_LENGTH) {
    return { pass: false, reason: "too short" };
  }
  if (confidence < 0.3) {
    return { pass: false, reason: "confidence too low" };
  }
  for (const pattern of VAGUE_PATTERNS) {
    if (pattern.test(content)) {
      return { pass: false, reason: `matches vague pattern: ${pattern.source}` };
    }
  }
  return { pass: true };
}

/** Expire stale reflections (>30 days old, never accessed) and enforce buffer cap. */
function enforceReflectionCap(db: Database, threadId: number): { expired: number } {
  const knowledgeThreadId = resolveKnowledgeThreadId(threadId);
  let expired = 0;

  // Phase 1: Expire stale never-accessed reflections
  const staleResult = db
    .prepare(
      `UPDATE semantic_notes
       SET valid_to = ?
       WHERE valid_to IS NULL AND superseded_by IS NULL
         AND content LIKE '[REFLECTION]%'
         AND access_count = 0
         AND created_at < datetime('now', '-' || ? || ' days')
         AND (thread_id = ? OR thread_id IS NULL)`,
    )
    .run(nowISO(), STALE_REFLECTION_DAYS, knowledgeThreadId);
  expired += staleResult.changes;

  // Phase 2: Enforce hard cap — if still over limit, expire lowest-value
  const countRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM semantic_notes
       WHERE valid_to IS NULL AND superseded_by IS NULL
         AND content LIKE '[REFLECTION]%'
         AND (thread_id = ? OR thread_id IS NULL)`,
    )
    .get(knowledgeThreadId) as { c: number };

  if (countRow.c > MAX_ACTIVE_REFLECTIONS) {
    const excess = countRow.c - MAX_ACTIVE_REFLECTIONS;
    const toExpire = db
      .prepare(
        `SELECT note_id FROM semantic_notes
         WHERE valid_to IS NULL AND superseded_by IS NULL
           AND content LIKE '[REFLECTION]%'
           AND pinned = 0 AND is_guardrail = 0
           AND (thread_id = ? OR thread_id IS NULL)
         ORDER BY access_count ASC, created_at ASC
         LIMIT ?`,
      )
      .all(knowledgeThreadId, excess) as { note_id: string }[];

    if (toExpire.length > 0) {
      const now = nowISO();
      const stmt = db.prepare(`UPDATE semantic_notes SET valid_to = ? WHERE note_id = ?`);
      db.transaction(() => {
        for (const row of toExpire) stmt.run(now, row.note_id);
      })();
      expired += toExpire.length;
    }
  }

  if (expired > 0) {
    log.info(`[reflection] Buffer maintenance: expired ${expired} stale/excess reflections`);
  }
  return { expired };
}

// ─── Core Pipeline ───────────────────────────────────────────────────────────

/**
 * Run the reflection pipeline on recent consolidated episodes.
 * Generates deeper insights beyond simple fact/preference extraction.
 *
 * Pipeline:
 *   1. Gate check — enough episodes, rate limit, API key present
 *   2. Gather episodes — recent + random sample of older ones
 *   3. Build a narrative from episode content
 *   4. Send to OpenAI with the reflection prompt
 *   5. Parse insights, de-duplicate, and save as semantic notes
 */
export async function runReflection(
  db: Database,
  threadId: number,
  options?: { maxEpisodes?: number; includeOldSample?: boolean },
): Promise<ReflectionResult> {
  const startMs = Date.now();
  const maxRecent = options?.maxEpisodes ?? 30;
  const oldSampleSize = options?.includeOldSample !== false ? 10 : 0;

  // ── Gate: rate limit ──────────────────────────────────────────────────────
  const lastRun = lastReflectionAt.get(threadId) ?? 0;
  if (Date.now() - lastRun < REFLECTION_COOLDOWN_MS) {
    log.info("[reflection] Skipped — cooldown not elapsed");
    return { insights: [], processedEpisodeCount: 0, duration: Date.now() - startMs };
  }

  // ── Gate: environment ─────────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("[reflection] Skipped — OPENAI_API_KEY not set");
    return { insights: [], processedEpisodeCount: 0, duration: Date.now() - startMs };
  }

  const reflectionEnabled = process.env.REFLECTION_ENABLED;
  if (reflectionEnabled === "false" || reflectionEnabled === "0") {
    return { insights: [], processedEpisodeCount: 0, duration: Date.now() - startMs };
  }

  // ── Gate: episode count ───────────────────────────────────────────────────
  const countRow = db
    .prepare("SELECT COUNT(*) as c FROM episodes WHERE thread_id = ? AND consolidated = 1")
    .get(threadId) as { c: number };
  if (countRow.c < MIN_EPISODES_FOR_REFLECTION) {
    log.info(`[reflection] Skipped — only ${countRow.c} consolidated episodes (need ${MIN_EPISODES_FOR_REFLECTION})`);
    return { insights: [], processedEpisodeCount: 0, duration: Date.now() - startMs };
  }

  // ── Step 0: Buffer maintenance — expire stale, enforce cap ─────────────
  enforceReflectionCap(db, threadId);

  // ── Step 1: Gather episodes ───────────────────────────────────────────────
  const episodes = gatherEpisodes(db, threadId, maxRecent, oldSampleSize);
  if (episodes.length === 0) {
    return { insights: [], processedEpisodeCount: 0, duration: Date.now() - startMs };
  }

  // ── Step 2: Build narrative ───────────────────────────────────────────────
  const narrative = buildNarrative(episodes);

  // ── Step 3: LLM call ─────────────────────────────────────────────────────
  const messages: ChatMessage[] = [
    { role: "system", content: REFLECTION_SYSTEM_PROMPT },
    { role: "user", content: `## Episodes to reflect on:\n${narrative}\n\nAnalyze the episodes above and produce deep reflective insights.` },
  ];

  let raw: string;
  try {
    raw = await chatCompletion(messages, apiKey, {
      model: process.env.REFLECTION_MODEL ?? process.env.CONSOLIDATION_MODEL ?? "gpt-4o-mini",
      maxTokens: 4096,
      temperature: 0.4, // slightly creative for deeper reasoning
      responseFormat: { type: "json_object" },
      timeoutMs: 90_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[reflection] LLM call failed: ${msg}`);
    return { insights: [], processedEpisodeCount: episodes.length, duration: Date.now() - startMs };
  }

  // ── Step 4: Parse response ────────────────────────────────────────────────
  let parsed: { insights?: RawInsight[] };
  try {
    parsed = repairAndParseJSON(raw) as { insights?: RawInsight[] };
  } catch (err) {
    log.error(`[reflection] JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return { insights: [], processedEpisodeCount: episodes.length, duration: Date.now() - startMs };
  }

  const rawInsights = parsed.insights ?? [];
  const validTypes = new Set(["causal", "pattern", "self_assessment", "counterfactual"]);

  // ── Step 5: Save insights ─────────────────────────────────────────────────
  const savedInsights: ReflectionInsight[] = [];
  const episodeIdSet = new Set(episodes.map((e) => e.episodeId));

  for (const ins of rawInsights) {
    if (!ins.content || typeof ins.content !== "string") continue;

    const insightType = validTypes.has(ins.type) ? ins.type : "pattern";
    const confidence = Math.max(0, Math.min(1, ins.confidence ?? 0.5));
    const refs = (ins.episode_refs ?? []).filter((id) => typeof id === "string" && episodeIdSet.has(id));

    // Quality gate — reject vague/generic insights before expensive dedup
    const quality = passesQualityGate(ins.content, confidence);
    if (!quality.pass) {
      log.info(`[reflection] Quality gate rejected: ${quality.reason} — "${ins.content.slice(0, 60)}…"`);
      continue;
    }

    // De-duplicate against existing reflections (embedding is cached for reuse)
    const prefixedContent = `[REFLECTION] [${insightType.toUpperCase()}] ${ins.content}`;
    const { isDuplicate: duplicate, embedding: cachedEmbedding } = await checkDuplicate(db, prefixedContent, apiKey, threadId);
    if (duplicate) {
      log.info(`[reflection] Skipped duplicate insight: ${ins.content.slice(0, 60)}…`);
      continue;
    }

    // Generate keywords from content
    const keywords = extractKeywords(ins.content);

    // Save as a semantic note of type "pattern" (reflection insights are patterns)
    const noteId = saveSemanticNote(db, {
      type: "pattern",
      content: prefixedContent,
      keywords: ["reflection", insightType, ...keywords],
      confidence,
      priority: confidence >= 0.8 ? 1 : 0,
      threadId: resolveKnowledgeThreadId(threadId),
      sourceEpisodes: refs,
    });

    // Reuse the embedding from dedup check — avoids a second API call
    if (cachedEmbedding) {
      saveNoteEmbedding(db, noteId, cachedEmbedding);
    } else {
      try {
        const embedding = await generateEmbedding(prefixedContent, apiKey);
        saveNoteEmbedding(db, noteId, embedding);
      } catch {
        // Non-fatal — backfill will catch it later
      }
    }

    savedInsights.push({
      type: insightType as ReflectionInsight["type"],
      content: ins.content,
      confidence,
      relatedEpisodeIds: refs,
    });
  }

  // ── Log result ────────────────────────────────────────────────────────────
  logReflection(db, {
    episodesProcessed: episodes.length,
    insightsCreated: savedInsights.length,
    durationMs: Date.now() - startMs,
  });

  lastReflectionAt.set(threadId, Date.now());

  log.info(
    `[reflection] Completed: ${episodes.length} episodes → ${savedInsights.length} insights (${Date.now() - startMs}ms)`,
  );

  // ── Step 6: Generate procedures from high-quality reflections ──────────
  if (savedInsights.length > 0) {
    try {
      const procResult = await generateProceduresFromReflections(db, threadId);
      if (procResult.created > 0) {
        log.info(`[reflection] Procedural generation: ${procResult.created} new procedures`);
      }
    } catch (err) {
      log.error(`[reflection] Procedural generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    insights: savedInsights,
    processedEpisodeCount: episodes.length,
    duration: Date.now() - startMs,
  };
}

// ─── Keyword extraction ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "this", "that", "with", "from", "have", "been", "will", "would", "could",
  "should", "about", "there", "their", "which", "when", "what", "were",
  "they", "than", "then", "also", "just", "more", "some", "into", "over",
  "after", "before", "other", "very", "your", "here", "does", "because",
  "instead", "agent", "operator", "the", "and", "for", "are", "but", "not",
  "you", "all", "can", "had", "her", "was", "one", "our", "out",
]);

/** Extract up to 5 meaningful keywords from free-text content. */
function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

// ─── Consolidation log ───────────────────────────────────────────────────────

function logReflection(
  db: Database,
  entry: { episodesProcessed: number; insightsCreated: number; durationMs: number },
): void {
  db.prepare(
    `INSERT INTO meta_consolidation_log
       (run_at, episodes_processed, notes_created, duration_ms)
     VALUES (?, ?, ?, ?)`,
  ).run(nowISO(), entry.episodesProcessed, entry.insightsCreated, entry.durationMs);
}

// ─── Internal type for raw LLM output ────────────────────────────────────────

interface RawInsight {
  type: string;
  content: string;
  confidence: number;
  episode_refs: string[];
}
