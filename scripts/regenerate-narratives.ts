#!/usr/bin/env tsx
/**
 * One-time script: delete all temporal_narratives for thread 1327
 * so the cooldown is bypassed and narratives are regenerated fresh.
 *
 * Usage: npx tsx scripts/regenerate-narratives.ts
 */

import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const THREAD_ID = 1327;

const dbPath = join(homedir(), ".remote-copilot-mcp", "memory.db");
const db = new BetterSqlite3(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Preview what will be deleted ────────────────────────────────────────────

interface NarrativeRow {
  id: number;
  resolution: string;
  period_start: string;
  period_end: string;
  source_episode_count: number;
  created_at: string;
}

const rows = db
  .prepare(
    `SELECT id, resolution, period_start, period_end, source_episode_count, created_at
     FROM temporal_narratives
     WHERE thread_id = ?
     ORDER BY resolution, created_at DESC`,
  )
  .all(THREAD_ID) as NarrativeRow[];

console.log(`\nFound ${rows.length} temporal_narratives for thread ${THREAD_ID}:\n`);

for (const row of rows) {
  console.log(
    `  id=${row.id}  resolution=${row.resolution.padEnd(10)}  episodes=${row.source_episode_count}  created=${row.created_at.slice(0, 16)}`,
  );
}

// ─── Delete ───────────────────────────────────────────────────────────────────

const result = db
  .prepare(`DELETE FROM temporal_narratives WHERE thread_id = ?`)
  .run(THREAD_ID);

console.log(`\nDeleted ${result.changes} row(s) from temporal_narratives for thread ${THREAD_ID}.`);
console.log("Cooldowns cleared — narratives will regenerate on next run.\n");

db.close();
