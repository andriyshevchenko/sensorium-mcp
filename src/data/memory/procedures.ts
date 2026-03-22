/**
 * Procedure CRUD operations for the memory system.
 *
 * Extracted from memory.ts — procedural memory layer.
 */

import { randomUUID } from "crypto";
import type { Database } from "./schema.js";
import { updateTopicIndexForKeywords } from "./semantic.js";

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface Procedure {
  procedureId: string;
  name: string;
  type: "workflow" | "habit" | "tool_pattern" | "template";
  description: string;
  steps: string[];
  triggerConditions: string[];
  successRate: number;
  timesExecuted: number;
  lastExecutedAt: string | null;
  learnedFrom: string[];
  corrections: string[];
  relatedProcedures: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function jsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val);
}

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

// ─── Row → Interface mapper ─────────────────────────────────────────────────

export function rowToProcedure(row: Record<string, unknown>): Procedure {
  return {
    procedureId: row.procedure_id as string,
    name: row.name as string,
    type: row.type as Procedure["type"],
    description: row.description as string,
    steps: parseJsonArray(row.steps as string | null),
    triggerConditions: parseJsonArray(row.trigger_conditions as string | null),
    successRate: row.success_rate as number,
    timesExecuted: row.times_executed as number,
    lastExecutedAt: (row.last_executed_at as string) ?? null,
    learnedFrom: parseJsonArray(row.learned_from as string | null),
    corrections: parseJsonArray(row.corrections as string | null),
    relatedProcedures: parseJsonArray(row.related_procedures as string | null),
    confidence: row.confidence as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ─── Procedural Memory ──────────────────────────────────────────────────────

export function saveProcedure(
  db: Database,
  proc: {
    name: string;
    type: "workflow" | "habit" | "tool_pattern" | "template";
    description: string;
    steps?: string[];
    triggerConditions?: string[];
  }
): string {
  const id = generateId("pr");
  const now = nowISO();

  db.prepare(
    `INSERT INTO procedures
       (procedure_id, name, type, description, steps, trigger_conditions, success_rate, times_executed, learned_from, corrections, related_procedures, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0, ?, ?, ?, 0.5, ?, ?)`
  ).run(
    id,
    proc.name,
    proc.type,
    proc.description,
    jsonOrNull(proc.steps),
    jsonOrNull(proc.triggerConditions),
    null, // learned_from
    null, // corrections
    null, // related_procedures
    now,
    now
  );

  // Update topic index based on procedure name words
  const keywords = proc.name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  updateTopicIndexForKeywords(db, keywords, "procedural");

  return id;
}

export function searchProcedures(db: Database, query: string, maxResults = 10): Procedure[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const term of terms) {
    const escaped = term.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(`(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\' OR LOWER(steps) LIKE ? ESCAPE '\\' OR LOWER(trigger_conditions) LIKE ? ESCAPE '\\')`);
    params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }

  const sql = `SELECT * FROM procedures WHERE ${conditions.join(" OR ")} ORDER BY confidence DESC, success_rate DESC LIMIT ?`;
  params.push(maxResults);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToProcedure);
}

export function updateProcedure(
  db: Database,
  procedureId: string,
  updates: Partial<{
    description: string;
    steps: string[];
    triggerConditions: string[];
    successRate: number;
    timesExecuted: number;
    corrections: string[];
    confidence: number;
  }>
): void {
  const now = nowISO();
  const setClauses: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (updates.description !== undefined) {
    setClauses.push("description = ?");
    params.push(updates.description);
  }
  if (updates.steps !== undefined) {
    setClauses.push("steps = ?");
    params.push(JSON.stringify(updates.steps));
  }
  if (updates.triggerConditions !== undefined) {
    setClauses.push("trigger_conditions = ?");
    params.push(JSON.stringify(updates.triggerConditions));
  }
  if (updates.successRate !== undefined) {
    setClauses.push("success_rate = ?");
    params.push(updates.successRate);
  }
  if (updates.timesExecuted !== undefined) {
    setClauses.push("times_executed = ?");
    params.push(updates.timesExecuted);
  }
  if (updates.corrections !== undefined) {
    setClauses.push("corrections = ?");
    params.push(JSON.stringify(updates.corrections));
  }
  if (updates.confidence !== undefined) {
    setClauses.push("confidence = ?");
    params.push(updates.confidence);
  }

  params.push(procedureId);
  db.prepare(`UPDATE procedures SET ${setClauses.join(", ")} WHERE procedure_id = ?`).run(...params);
}
