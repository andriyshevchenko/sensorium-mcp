#!/usr/bin/env tsx
/**
 * One-time cleanup script: expire low-quality reflections from the DB.
 *
 * Applies the same VAGUE_PATTERNS check and passesStructuralGate logic
 * as reflection.ts to all currently active reflections, and expires any
 * that fail by setting valid_to = datetime('now').
 *
 * Usage: npx tsx scripts/cleanup-reflections.ts
 */

import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── DB setup ────────────────────────────────────────────────────────────────

const dbPath = join(homedir(), ".remote-copilot-mcp", "memory.db");
const db = new BetterSqlite3(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Quality gate (inlined from reflection.ts) ────────────────────────────────

const MIN_INSIGHT_LENGTH = 50;

const VAGUE_PATTERNS = [
  /\bthe agent tends to\b/i,
  /\bthe agent demonstrates\b/i,
  /\bthe agent frequently\b/i,
  /\bshould consider\b/i,
  /\bthis (is|was) (a |an )?(good|important|useful)\b/i,
  /\bin general\b/i,
  /\boverall\b.*\b(good|well|effective)\b/i,
  /\bthe key (insight|takeaway|lesson) is\b/i,
  /\bit('s| is) important to\b/i,
  /\bthis (led|leads) to\b/i,
  /\bgoing forward\b/i,
  /\bmoving forward\b/i,
  /\ba? ?valuable (lesson|experience|insight)\b/i,
  /\bI (learned|realized|recognized|acknowledged) that\b/i,
  /\bthis (highlights|underscores|demonstrates)\b/i,
];

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

// ─── Structural gate (inlined from reflection.ts) ────────────────────────────

const ACTION_VERBS = [
  "always", "never", "before", "after", "when", "if", "check", "verify",
  "ensure", "use", "avoid", "run", "test", "add", "remove", "set", "create",
  "implement", "review", "validate", "confirm", "monitor", "track", "log",
  "document", "separate", "isolate", "prefer", "prioritize", "consider",
  "evaluate", "compare", "measure",
];

function passesStructuralGate(insight: {
  decision: string;
  context: string;
  outcome: string;
  root_cause: string;
  lesson: string;
}): { pass: boolean; reason?: string } {
  const outcomeWords = new Set(insight.outcome.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const rootWords = new Set(insight.root_cause.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const overlap = [...outcomeWords].filter(w => rootWords.has(w)).length;
  const overlapRatio = overlap / Math.max(outcomeWords.size, 1);
  if (overlapRatio > 0.6) {
    return { pass: false, reason: "root_cause restates outcome" };
  }

  const lessonStart = insight.lesson.trim().split(/\s/)[0]?.toLowerCase() ?? "";
  if (!ACTION_VERBS.some(v => lessonStart.startsWith(v))) {
    return { pass: false, reason: "lesson does not start with an action verb" };
  }

  if (insight.root_cause.length < 30) {
    return { pass: false, reason: "root_cause too shallow (< 30 chars)" };
  }
  if (insight.lesson.length < 20) {
    return { pass: false, reason: "lesson too short (< 20 chars)" };
  }

  return { pass: true };
}

// ─── Field parser ─────────────────────────────────────────────────────────────

interface ParsedFields {
  decision: string;
  context: string;
  outcome: string;
  root_cause: string;
  lesson: string;
}

/**
 * Parse the 5 structured fields out of a reflection content string.
 *
 * Content format (after the prefix):
 *   "Decision: X. Context: Y. Outcome: Z. Root cause: W. Lesson: V"
 */
function parseReflectionFields(rawContent: string): ParsedFields | null {
  // Strip [REFLECTION] [TYPE] [DOMAIN] prefix
  const body = rawContent.replace(/^\[REFLECTION\]\s*\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?/, "");

  // Use lookahead so field values can contain ". " safely
  const decisionMatch  = body.match(/Decision:\s*(.*?)(?=\.\s*Context:)/s);
  const contextMatch   = body.match(/Context:\s*(.*?)(?=\.\s*Outcome:)/s);
  const outcomeMatch   = body.match(/Outcome:\s*(.*?)(?=\.\s*Root cause:)/s);
  const rootCauseMatch = body.match(/Root cause:\s*(.*?)(?=\.\s*Lesson:)/s);
  const lessonMatch    = body.match(/Lesson:\s*(.*?)\.?\s*$/s);

  if (!decisionMatch || !contextMatch || !outcomeMatch || !rootCauseMatch || !lessonMatch) {
    return null;
  }

  return {
    decision:   decisionMatch[1].trim(),
    context:    contextMatch[1].trim(),
    outcome:    outcomeMatch[1].trim(),
    root_cause: rootCauseMatch[1].trim(),
    lesson:     lessonMatch[1].trim(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface ReflectionRow {
  note_id: string;
  content: string;
  confidence: number;
  created_at: string;
  thread_id: number | null;
}

const rows = db
  .prepare(
    `SELECT note_id, content, confidence, created_at, thread_id
     FROM semantic_notes
     WHERE content LIKE '[REFLECTION]%'
       AND valid_to IS NULL
       AND superseded_by IS NULL`,
  )
  .all() as ReflectionRow[];

console.log(`\nFound ${rows.length} active reflections to check.\n`);

const now = new Date().toISOString();
const expireStmt = db.prepare(
  `UPDATE semantic_notes SET valid_to = ? WHERE note_id = ?`,
);

let totalExpired = 0;
const expirationLog: Array<{ noteId: string; reason: string; preview: string }> = [];

db.transaction(() => {
  for (const row of rows) {
    const qualityResult = passesQualityGate(row.content, row.confidence);
    if (!qualityResult.pass) {
      expireStmt.run(now, row.note_id);
      totalExpired++;
      expirationLog.push({
        noteId: row.note_id,
        reason: `quality gate: ${qualityResult.reason}`,
        preview: row.content.slice(0, 80),
      });
      continue;
    }

    const fields = parseReflectionFields(row.content);
    if (!fields) {
      expireStmt.run(now, row.note_id);
      totalExpired++;
      expirationLog.push({
        noteId: row.note_id,
        reason: "could not parse structured fields",
        preview: row.content.slice(0, 80),
      });
      continue;
    }

    const structuralResult = passesStructuralGate(fields);
    if (!structuralResult.pass) {
      expireStmt.run(now, row.note_id);
      totalExpired++;
      expirationLog.push({
        noteId: row.note_id,
        reason: `structural gate: ${structuralResult.reason}`,
        preview: row.content.slice(0, 80),
      });
    }
  }
})();

// ─── Report ───────────────────────────────────────────────────────────────────

if (expirationLog.length > 0) {
  console.log("Expired reflections:\n");
  for (const entry of expirationLog) {
    console.log(`  [${entry.noteId}] ${entry.reason}`);
    console.log(`    "${entry.preview}…"\n`);
  }
}

const totalKept = rows.length - totalExpired;
console.log("─────────────────────────────────────────");
console.log(`Total checked:  ${rows.length}`);
console.log(`Total expired:  ${totalExpired}`);
console.log(`Total kept:     ${totalKept}`);
console.log("─────────────────────────────────────────\n");

db.close();
