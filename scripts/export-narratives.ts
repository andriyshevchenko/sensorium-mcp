#!/usr/bin/env tsx
process.env.TELEGRAM_TOKEN = "dummy";
process.env.TELEGRAM_CHAT_ID = "0";

import BetterSqlite3 from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const db = new BetterSqlite3(join(homedir(), ".remote-copilot-mcp", "memory.db"));

const rows = db
  .prepare(
    `SELECT resolution, narrative, source_episode_count, created_at
     FROM temporal_narratives WHERE thread_id = 1327
     ORDER BY CASE resolution
       WHEN 'day' THEN 1 WHEN 'week' THEN 2 WHEN 'month' THEN 3
       WHEN 'quarter' THEN 4 WHEN 'half_year' THEN 5 END`,
  )
  .all() as any[];

let out = "# Regenerated Narratives — May 14, 2026\n\n";
for (const r of rows) {
  out += `## ${(r.resolution as string).toUpperCase()} (${r.source_episode_count} episodes)\n\n`;
  out += r.narrative + "\n\n---\n\n";
}
writeFileSync("tmp/regenerated-narratives.md", out);
console.log("Written to tmp/regenerated-narratives.md");
db.close();
