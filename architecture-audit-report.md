# Architecture Audit: remote-copilot-mcp — Bulletproofing Findings

Date: 2026-04-19 | Files read: 25+

---

## HIGH

**H1 — Dual SIGTERM handlers: HTTP mode exits before sessions drain**
`src/index.ts:147` and `src/http-server.ts:473` both register `process.on("SIGTERM")`. In HTTP mode, the `index.ts` handler runs first: calls `keeperService.stop()`, `closeMemoryDb()`, then `process.exit(0)` synchronously. The `http-server.ts` async `shutdown()` (which closes SSE transports, writes reconnect snapshot, cleans up sessions) never executes. Connected agents get hard-disconnected with no reconnect snapshot.

**Fix:** In HTTP mode, remove the SIGTERM handler from `index.ts` and ensure `http-server.ts`'s `shutdown()` also calls `keeperService.stop()` and `backgroundRunner.stop()` before exiting.

---

**H2 — Unix: Supervisor sends SIGKILL, not SIGTERM, to MCP process**
`supervisor-dotnet/Services/ProcessManager.cs:271`: .NET's `proc.Kill(entireProcessTree: false)` sends SIGKILL on Unix. Bypasses Node.js's `process.on("SIGTERM")` handler entirely — reconnect snapshot not written, keeperService/backgroundRunner don't stop, in-progress SQLite write aborted mid-WAL.

**Fix:** Send SIGTERM and wait up to 5s before escalating to SIGKILL on Unix.

---

## MEDIUM

**M1 — Consolidation: notes + markConsolidated not in one transaction**
`src/services/consolidation.service.ts:337-385`: Notes saved one-by-one, then `markConsolidated(db, episodeIds)` separately. Crash between them causes duplicate notes on re-run. Also `saveNoteEmbedding` is separate from `saveSemanticNote` — crash between them creates orphan notes invisible to semantic search.

**Fix:** Wrap notes-save + embeddings-save + markConsolidated in a single `db.transaction()`.

---

**M2 — Heartbeat file path mismatch: cleanup never fires**
`src/services/thread-lifecycle.service.ts:70` deletes `heartbeats/${threadId}.json` but `src/data/file-storage.ts:68` writes `heartbeats/${threadId}` (no `.json`). Heartbeat files accumulate indefinitely.

**Fix:** Remove `.json` from the heartbeat path in `cleanupThreadFiles`.

---

**M3 — No `busy_timeout` on SQLite; concurrent SQLITE_BUSY possible**
`src/data/memory/schema.ts:50`: Only WAL + foreign_keys set. Multiple concurrent writers (background runner + poll loop + consolidation + keeper) can collide. Without `busy_timeout`, second writer gets `SQLITE_BUSY` immediately and throws.

**Fix:** Add `db.pragma("busy_timeout = 5000")` after WAL mode init.

---

**M4 — Migration failure leaves schema in partial state**
`src/data/memory/migration-runner.ts:452`: Failed migration breaks loop without rollback. Version bump is outside the migration transaction. Crash between DDL and version bump causes half-migrated state.

**Fix:** Wrap `migration(db)` and the version bump together in a transaction.

---

**M5 — Windows `CreateProcess` inherits all inheritable handles**
`supervisor-dotnet/Services/ProcessManager.cs:120-121`: All inheritable handles flow into MCP child. Should use `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` to restrict to only `hStderr`.

---

**M6 — `isPidAlive` in dispatcher lock doesn't handle EPERM**
`src/services/dispatcher/lock.ts:40-47`: Returns `false` for all errors including EPERM. On multi-user systems, incorrectly reclaims lock from an alive process, causing dual pollers and Telegram 409 conflicts.

**Fix:** Return `true` for `code === "EPERM"`.

---

## LOW

**L1** — `SelfUpdate.cs:78`: Temp `.cmd` script not self-deleting. Accumulates in `%TEMP%`.

**L2** — `file-storage.ts:16,64`: Module-level `mkdirSync` at import time. Crashes server if FS unavailable.

**L3** — `background-runner.ts:36,41` + `http-server.ts:438`: `setInterval` calls without `.unref()`.

**L4** — `index.ts:159`: Reconnect snapshot clear timer not `.unref()`'d.

**L5** — `SupervisorWorker.cs:69-79`: Lock acquired before `try/finally`. Logger throw leaks lock (theoretical).
