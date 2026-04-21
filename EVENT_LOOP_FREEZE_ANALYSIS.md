# Event Loop Freeze Analysis — 2026-04-21 18:21 UTC

Server process (PID 31668) froze completely — no logs, no heartbeats, no Telegram polling.
All 12+ threads hung on `wait_for_instructions` indefinitely. Process stayed alive but unresponsive.

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 15:13-15:33 | Keeper kills 12+ threads via `taskkill /F /T` — 120+ "could not be terminated" errors |
| 15:33-18:20 | Zombie processes accumulate, FD leaks, SQLite contention grows |
| ~18:21 | Event loop freezes — no more logs, heartbeats, or Telegram polling |
| 21:19 | User notices no responses; process still alive (zombie state) |

## Root Cause 1: SQLite write lock during consolidation (CRITICAL)

`better-sqlite3` is synchronous. When one thread triggers consolidation:

1. Opens `db.transaction()`
2. Calls OpenAI API inside the transaction (up to 60 seconds)
3. **Holds SQLite write lock for the entire duration**

All other 12 threads trying `touchThread()` or `buildSmartContext()` block on the write lock.

**Missing:** `db.pragma("busy_timeout = ...")` in `src/data/memory/schema.ts` — readers get instant SQLITE_BUSY, errors silently swallowed.

**Fix:**
- Add `db.pragma("busy_timeout = 5000")`
- Move API call **outside** the transaction — fetch data first, then batch-write

## Root Cause 2: Synchronous file I/O in poll loop (HIGH)

Every 2 seconds, each of 12+ threads executes:
- `existsSync()` — pending task check (`src/tools/wait/poll-loop.ts:67`)
- `writeFileSync()` — heartbeat (`src/tools/wait/poll-loop.ts:322-324`)
- `readFileSync()` / `renameSync()` — lock refresh (`src/services/dispatcher/lock.ts:74-91`)

12 threads x 1 cycle/2s = **6 synchronous file I/O bursts per second**, starving the event loop.

**Fix:**
- Replace all sync file ops in hot paths with `fs.promises.*`
- Batch heartbeat writes every 30s instead of every 2s
- Increase `POLL_INTERVAL_MS` from 2000 to 5000+

## Root Cause 3: taskkill execSync blocks event loop (HIGH)

`killProcessTree()` in `src/services/process.service.ts:198`:
```typescript
execSync(`taskkill /F /T /PID ${pid}`, { timeout: 10000 });
```

Each failed kill blocks event loop up to 10 seconds. Between 15:13-15:33, keeper killed 12+ processes — potentially 2+ minutes of total blocking. Zombie processes that survive:
- Consume file descriptors (log FDs stay open)
- Inflate `spawnedThreads[]` (max 20, blocks new spawns)
- Never get cleaned up (PID file deleted regardless of kill success)

**Fix:**
- Replace `execSync` with async `execFile()`
- Verify kill success with PID check after 2-3 seconds
- Auto-prune `spawnedThreads[]` periodically

## Root Cause 4: Lock refresh uses all-sync operations (MEDIUM)

`refreshLock()` in `src/services/dispatcher/lock.ts:74-91`:
```
readFileSync() → writeFileSync(tmp) → renameSync(tmp, lockFile)
```

Called from `setInterval` every 15 seconds AND from the poll loop. If file system is slow, blocks everything.

**Fix:** Replace with async `fs.promises.readFile/writeFile/rename`.

## Root Cause 5: No consolidation mutex (MEDIUM)

`consolidationInProgress` is a simple boolean flag (`src/services/consolidation.service.ts:31`).
Fire-and-forget pattern clears the flag before async work finishes, allowing concurrent consolidations competing for SQLite write locks.

**Fix:** Use a Promise-based mutex instead of a boolean.

## Summary of Required Fixes

| Priority | Fix | Files |
|----------|-----|-------|
| CRITICAL | SQLite busy_timeout + move API call outside transaction | `schema.ts`, `consolidation.service.ts` |
| HIGH | Async file I/O in poll loop | `poll-loop.ts`, `lock.ts` |
| HIGH | Async taskkill + kill verification | `process.service.ts` |
| MEDIUM | Proper consolidation mutex | `consolidation.service.ts` |
| MEDIUM | Increase poll interval, batch heartbeats | `poll-loop.ts` |
| LOW | Auto-prune spawnedThreads[], FD monitoring | `agent-spawn.service.ts` |
