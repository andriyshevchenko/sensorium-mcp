/**
 * Procedure CRUD operations for the memory system.
 *
 * Extracted from memory.ts — procedural memory layer.
 */

import type { Database } from "./schema.js";
import { generateId, nowISO, parseJsonArray } from "./utils.js";
import { updateTopicIndexForKeywords } from "./semantic.js";
import { log } from "../../logger.js";

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

export function searchProcedures(db: Database, query: string, maxResults = 10, options?: { startTime?: string; endTime?: string }): Procedure[] {
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

  let sql = `SELECT * FROM procedures WHERE (${conditions.join(" OR ")})`;

  if (options?.startTime) {
    sql += ` AND created_at >= ?`;
    params.push(options.startTime);
  }
  if (options?.endTime) {
    sql += ` AND created_at <= ?`;
    params.push(options.endTime);
  }
  sql += ` ORDER BY confidence DESC, success_rate DESC LIMIT ?`;
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

// ─── Create ─────────────────────────────────────────────────────────────────

const MAX_PROCEDURES = 30;

export function saveProcedure(
  db: Database,
  proc: {
    name: string;
    type: Procedure["type"];
    description: string;
    steps: string[];
    triggerConditions: string[];
    learnedFrom: string[];
    confidence: number;
  },
): string {
  const id = generateId("pr");
  const now = nowISO();

  db.prepare(
    `INSERT INTO procedures
       (procedure_id, name, type, description, steps, trigger_conditions,
        success_rate, times_executed, last_executed_at,
        learned_from, corrections, related_procedures,
        confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0, NULL, ?, '[]', '[]', ?, ?, ?)`,
  ).run(
    id,
    proc.name,
    proc.type,
    proc.description,
    JSON.stringify(proc.steps),
    JSON.stringify(proc.triggerConditions),
    JSON.stringify(proc.learnedFrom),
    Math.max(0, Math.min(1, proc.confidence)),
    now,
    now,
  );

  const keywords = proc.name
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  updateTopicIndexForKeywords(db, keywords, "procedural");

  return id;
}

// ─── Cap enforcement ────────────────────────────────────────────────────────

export function enforceProcedureCap(db: Database): { expired: number } {
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM procedures`)
    .get() as { c: number };

  if (countRow.c <= MAX_PROCEDURES) return { expired: 0 };

  const excess = countRow.c - MAX_PROCEDURES;
  const toRemove = db
    .prepare(
      `SELECT procedure_id, name FROM procedures
       ORDER BY times_executed ASC, confidence ASC, created_at ASC
       LIMIT ?`,
    )
    .all(excess) as { procedure_id: string; name: string }[];

  if (toRemove.length === 0) return { expired: 0 };

  const stmt = db.prepare(`DELETE FROM procedures WHERE procedure_id = ?`);
  db.transaction(() => {
    for (const row of toRemove) stmt.run(row.procedure_id);
  })();

  log.info(`[procedures] Cap enforcement: removed ${toRemove.length} lowest-value procedures`);
  return { expired: toRemove.length };
}

export function getProcedureByName(db: Database, name: string): Procedure | null {
  const row = db
    .prepare(`SELECT * FROM procedures WHERE LOWER(name) = LOWER(?)`)
    .get(name) as Record<string, unknown> | undefined;
  return row ? rowToProcedure(row) : null;
}
