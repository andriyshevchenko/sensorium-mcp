/**
 * Memory quality scoring — samples random active notes and scores them
 * via LLM on specificity, actionability, and accuracy.
 *
 * Results are persisted in a `quality_scores` table for trend tracking.
 */

import type { Database } from "./schema.js";
import { generateId, nowISO, repairAndParseJSON } from "./utils.js";
import { chatCompletion, type ChatMessage } from "../../integrations/openai/chat.js";
import { log } from "../../logger.js";
import { errorMessage } from "../../utils.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SAMPLE_SIZE = 20;
const SCORING_MODEL_ENV = "QUALITY_SCORING_MODEL";
const FALLBACK_MODEL_ENV = "CONSOLIDATION_MODEL";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 60_000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface NoteScore {
  noteId: string;
  content: string;
  specificity: number;
  actionability: number;
  accuracy: number;
  avg: number;
}

export interface QualityScoreResult {
  id: string;
  scoredAt: string;
  sampleSize: number;
  avgSpecificity: number;
  avgActionability: number;
  avgAccuracy: number;
  overallAvg: number;
  details: NoteScore[];
}

interface PreviousRun {
  id: string;
  scored_at: string;
  overall_avg: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

function ensureQualityScoresTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_scores (
      id               TEXT PRIMARY KEY,
      scored_at        TEXT NOT NULL,
      sample_size      INTEGER NOT NULL,
      avg_specificity  REAL,
      avg_actionability REAL,
      avg_accuracy     REAL,
      overall_avg      REAL,
      details          TEXT
    )
  `);
}

// ─── LLM Prompt ──────────────────────────────────────────────────────────────

function buildScoringPrompt(notes: { noteId: string; content: string }[]): ChatMessage[] {
  const notesList = notes
    .map((n, i) => `${i + 1}. [${n.noteId}] ${n.content}`)
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "You are a memory quality auditor. Score each note on three dimensions (1-5 each):",
        "- **Specificity**: 1=vague platitude, 5=precise actionable fact",
        "- **Actionability**: 1=useless to a future agent, 5=directly actionable",
        "- **Accuracy**: 1=garbled/contradictory, 5=clear and coherent",
        "",
        "Respond ONLY with valid JSON: { \"scores\": [ { \"noteId\": \"...\", \"specificity\": N, \"actionability\": N, \"accuracy\": N } ] }",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Score these ${notes.length} memory notes:\n\n${notesList}`,
    },
  ];
}

// ─── Sampling ────────────────────────────────────────────────────────────────

function sampleActiveNotes(
  db: Database,
  count: number,
): { noteId: string; content: string }[] {
  const rows = db.prepare(
    `SELECT note_id AS noteId, content
       FROM semantic_notes
      WHERE valid_to IS NULL AND superseded_by IS NULL
      ORDER BY RANDOM()
      LIMIT ?`,
  ).all(count) as { noteId: string; content: string }[];
  return rows;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveScoreResult(db: Database, result: QualityScoreResult): void {
  db.prepare(
    `INSERT INTO quality_scores (id, scored_at, sample_size, avg_specificity, avg_actionability, avg_accuracy, overall_avg, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.id,
    result.scoredAt,
    result.sampleSize,
    result.avgSpecificity,
    result.avgActionability,
    result.avgAccuracy,
    result.overallAvg,
    JSON.stringify(result.details),
  );
}

function getLastRun(db: Database): PreviousRun | undefined {
  const row = db.prepare(
    `SELECT id, scored_at, overall_avg
       FROM quality_scores
      ORDER BY scored_at DESC
      LIMIT 1`,
  ).get() as PreviousRun | undefined;
  return row;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateScores(
  notes: { noteId: string; content: string }[],
  rawScores: { noteId: string; specificity: number; actionability: number; accuracy: number }[],
): NoteScore[] {
  const scoreMap = new Map(rawScores.map(s => [s.noteId, s]));
  return notes
    .filter(n => scoreMap.has(n.noteId))
    .map(n => {
      const s = scoreMap.get(n.noteId)!;
      return {
        noteId: n.noteId,
        content: n.content,
        specificity: clampScore(s.specificity),
        actionability: clampScore(s.actionability),
        accuracy: clampScore(s.accuracy),
        avg: round((clampScore(s.specificity) + clampScore(s.actionability) + clampScore(s.accuracy)) / 3),
      };
    });
}

function clampScore(v: number): number {
  return Math.max(1, Math.min(5, Math.round(v)));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function computeAverages(details: NoteScore[]): {
  avgSpecificity: number;
  avgActionability: number;
  avgAccuracy: number;
  overallAvg: number;
} {
  if (details.length === 0) {
    return { avgSpecificity: 0, avgActionability: 0, avgAccuracy: 0, overallAvg: 0 };
  }
  const sum = details.reduce(
    (acc, d) => ({
      s: acc.s + d.specificity,
      a: acc.a + d.actionability,
      c: acc.c + d.accuracy,
    }),
    { s: 0, a: 0, c: 0 },
  );
  const n = details.length;
  const avgSpecificity = round(sum.s / n);
  const avgActionability = round(sum.a / n);
  const avgAccuracy = round(sum.c / n);
  const overallAvg = round((avgSpecificity + avgActionability + avgAccuracy) / 3);
  return { avgSpecificity, avgActionability, avgAccuracy, overallAvg };
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export interface ScoreOptions {
  sampleSize?: number;
}

export async function scoreMemoryQuality(
  db: Database,
  options?: ScoreOptions,
): Promise<QualityScoreResult> {
  ensureQualityScoresTable(db);

  const sampleSize = options?.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const notes = sampleActiveNotes(db, sampleSize);

  if (notes.length === 0) {
    throw new Error("No active semantic notes to score.");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set — cannot score memory quality.");
  }

  const model =
    process.env[SCORING_MODEL_ENV] ??
    process.env[FALLBACK_MODEL_ENV] ??
    DEFAULT_MODEL;

  const messages = buildScoringPrompt(notes);
  const raw = await chatCompletion(messages, apiKey, {
    model,
    maxTokens: MAX_TOKENS,
    responseFormat: { type: "json_object" },
    timeoutMs: TIMEOUT_MS,
  });

  const parsed = repairAndParseJSON(raw) as {
    scores?: { noteId: string; specificity: number; actionability: number; accuracy: number }[];
  };

  if (!parsed.scores || !Array.isArray(parsed.scores)) {
    throw new Error("LLM returned invalid scoring response — missing 'scores' array.");
  }

  const details = aggregateScores(notes, parsed.scores);
  const averages = computeAverages(details);

  const result: QualityScoreResult = {
    id: generateId("qs"),
    scoredAt: nowISO(),
    sampleSize: notes.length,
    ...averages,
    details,
  };

  saveScoreResult(db, result);
  log.info(`[quality-scoring] Scored ${details.length} notes — overall avg: ${result.overallAvg}`);

  return result;
}

// ─── Comparison Helper ───────────────────────────────────────────────────────

export function formatScoreComparison(
  db: Database,
  current: QualityScoreResult,
): string {
  ensureQualityScoresTable(db);

  const prev = db.prepare(
    `SELECT id, scored_at, overall_avg
       FROM quality_scores
      WHERE id != ?
      ORDER BY scored_at DESC
      LIMIT 1`,
  ).get(current.id) as PreviousRun | undefined;

  const lines: string[] = [
    "## Memory Quality Score",
    `- **Specificity**: ${current.avgSpecificity}/5`,
    `- **Actionability**: ${current.avgActionability}/5`,
    `- **Accuracy**: ${current.avgAccuracy}/5`,
    `- **Overall**: ${current.overallAvg}/5`,
    `- Sample size: ${current.sampleSize} notes`,
  ];

  if (prev) {
    const delta = round(current.overallAvg - prev.overall_avg);
    const pct = prev.overall_avg > 0
      ? round((delta / prev.overall_avg) * 100)
      : 0;
    const direction = delta > 0 ? "improved" : delta < 0 ? "declined" : "unchanged";
    lines.push(
      "",
      `### Comparison to previous run`,
      `- Previous overall: ${prev.overall_avg}/5 (${prev.scored_at})`,
      `- Change: ${delta > 0 ? "+" : ""}${delta} (${direction} by ${Math.abs(pct)}%)`,
    );
  } else {
    lines.push("", "_First run — no previous data for comparison._");
  }

  return lines.join("\n");
}
