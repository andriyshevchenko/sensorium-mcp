#!/usr/bin/env tsx
process.env.TELEGRAM_TOKEN = "dummy";
process.env.TELEGRAM_CHAT_ID = "1";

import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const THREAD_ID = 1327;
const dbPath = join(homedir(), ".remote-copilot-mcp", "memory.db");
const db = new BetterSqlite3(dbPath) as any;
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

async function main() {
  const mod = await import("../dist/data/memory/narrative.js");

  // Delete existing quarter and half_year to force regeneration
  db.prepare(
    "DELETE FROM temporal_narratives WHERE thread_id = ? AND resolution IN ('quarter', 'half_year')"
  ).run(THREAD_ID);
  console.log("Cleared existing quarter and half_year narratives.");

  // Generate all (day/week/month will be cached, quarter/half_year will regenerate)
  const result = await mod.runNarrativeGeneration(db, THREAD_ID, { force: false });
  console.log("Generated:", result.generated);
  console.log("Errors:", result.errors);

  // Export quarter and half_year to files
  for (const res of ["quarter", "half_year"]) {
    const row = db
      .prepare(
        "SELECT narrative, source_episode_count, created_at FROM temporal_narratives WHERE thread_id = ? AND resolution = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(THREAD_ID, res) as any;
    if (row) {
      const outPath = join("C:/src/remote-copilot-mcp/tmp", `narrative-${res}-experiment.md`);
      writeFileSync(outPath, `# ${res} narrative (experiment)\nEpisodes: ${row.source_episode_count} | Created: ${row.created_at}\n\n${row.narrative}`);
      console.log(`Wrote ${outPath}`);
    }
  }

  db.close();
}

main().catch(console.error);
