#!/usr/bin/env tsx
/**
 * Standalone narrative regeneration script.
 * Bypasses config.ts validation by setting dummy Telegram env vars,
 * then calls runNarrativeGeneration directly.
 * Uses dynamic import() because ESM hoists static imports above process.env assignments.
 */
process.env.TELEGRAM_TOKEN = "dummy";
process.env.TELEGRAM_CHAT_ID = "1";

import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const THREAD_ID = 1327;
const dbPath = join(homedir(), ".remote-copilot-mcp", "memory.db");
const db = new BetterSqlite3(dbPath) as any;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

async function main() {
  const { runNarrativeGeneration } = await import("../dist/data/memory/narrative.js");

  console.log(`Regenerating narratives for thread ${THREAD_ID}...\n`);
  const result = await runNarrativeGeneration(db, THREAD_ID, { force: true });
  console.log("Generated:", result.generated);
  console.log("Cached:", result.cached);
  console.log("Errors:", result.errors);

  const rows = db
    .prepare(
      `SELECT resolution, narrative, source_episode_count, created_at
       FROM temporal_narratives WHERE thread_id = ? ORDER BY resolution`,
    )
    .all(THREAD_ID) as any[];

  for (const row of rows) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Resolution: ${row.resolution} | Episodes: ${row.source_episode_count} | Created: ${row.created_at}`);
    console.log("=".repeat(80));
    console.log(row.narrative);
  }

  db.close();
}

main().catch(console.error);
