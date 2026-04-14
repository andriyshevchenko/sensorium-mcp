/**
 * Memory database schema initialization and migrations.
 *
 * Owns the SQLite `db` handle creation via `initMemoryDb()`.
 * Other memory modules import `Database` (the type) and call
 * `initMemoryDb()` to obtain the singleton handle.
 */

import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../logger.js";
import { SCHEMA_SQL, cleanupOldSentMessages } from "./schema-ddl.js";
import { runMigrations } from "./migration-runner.js";
import { ensureSchemaIntegrity } from "./schema-guard.js";
import { nowISO } from "./utils.js";

export type Database = BetterSqlite3.Database;
export { cleanupOldSentMessages };

function migrateExistingRootThreads(db: Database): void {
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM thread_registry").get() as Record<string, unknown>).cnt as number;
  if (count > 0) return;

  const rows = db.prepare("SELECT DISTINCT thread_id FROM episodes ORDER BY thread_id").all() as Record<string, unknown>[];
  if (rows.length === 0) return;

  const now = nowISO();
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO thread_registry (thread_id, name, type, badge, client, keep_alive, created_at, status) VALUES (?, ?, 'root', 'root', 'claude', 0, ?, 'active')"
  );
  const txn = db.transaction(() => {
    for (const row of rows) {
      const threadId = row.thread_id as number;
      stmt.run(threadId, `Thread ${threadId}`, now);
    }
  });
  txn();
  log.info(`Migrated ${rows.length} existing threads as roots`);
}

export function initMemoryDb(): Database {
  const dbDir = join(homedir(), ".remote-copilot-mcp");
  mkdirSync(dbDir, { recursive: true });

  const dbPath = join(dbDir, "memory.db");
  const db = new BetterSqlite3(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const versionCount = (db.prepare("SELECT COUNT(*) as cnt FROM schema_version").get() as { cnt: number }).cnt;
  if (versionCount === 0) {
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?)").run(nowISO());
  }

  runMigrations(db);
  ensureSchemaIntegrity(db);
  migrateExistingRootThreads(db);

  try {
    db.prepare(
      `UPDATE thread_registry
       SET name = (
         SELECT tr.name FROM topic_registry tr
         WHERE tr.thread_id = thread_registry.thread_id AND tr.name IS NOT NULL AND tr.name != ''
         LIMIT 1
       )
       WHERE (thread_registry.name IS NULL OR thread_registry.name = '')`
    ).run();
  } catch {}

  return db;
}
