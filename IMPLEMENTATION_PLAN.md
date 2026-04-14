# Sensorium Architecture Refactor — Implementation Plan

> Approved: 2026-04-14. Update checkboxes as work completes.
> Thread: Sensorium-Debug (11753)

---

## Phase A — Repository Interfaces *(scope: S, risk: Low)*

- [x] Define `IThreadRepository`, `ISessionRepository`, `IScheduleRepository` interfaces in `src/data/`
- [x] Wrap current SQLite/JSON/PID implementations behind these interfaces (no behavior change)
- [x] Update all import sites to use interfaces instead of concrete modules
- [x] Verify: `npx tsc --noEmit` passes, zero behavior change

---

## Phase B — ThreadLifecycleService *(scope: L, risk: Medium)*

- [x] Define explicit thread state machine (states: active / dormant / exited / archived / expired + valid transitions doc)
- [x] Create `src/services/thread-lifecycle.service.ts` — single owner of all thread state transitions
- [x] Consolidate 5 creation paths into 1 via the service
- [x] Consolidate 4 destruction paths into 1 via the service
- [x] Remove JSON session file as a primary lookup; SQLite `thread_registry` is the only source of truth
- [x] Verify: all create/destroy flows call the service, no direct `updateThread()` from tool handlers

Notes:
`start_session`, `start_thread`, keepAlive restores, worker cleanup, topic remap, process-exit handling, and poll-loop heartbeats all route through `ThreadLifecycleService`. Name-based thread lookup in `start_session` and `start_thread` now resolves from SQLite `thread_registry` rather than the JSON session map.

---

## Phase C — BackgroundJobRunner *(scope: M, risk: Medium)*

- [x] Create `src/services/background-runner.ts` — single owner of recurring server-level timers
- [x] Register jobs: worker cleanup (every 5 min) and daily rotation check (every 5 min at 04:00) from `src/index.ts`
- [x] Remove `cleanupExpiredWorkers` call from `src/tools/wait/drive-handler.ts` (keep only the runner's call)
- [ ] Strip unrelated background tasks out of `wait_for_instructions` poll loop
- [ ] Verify: exactly 1 cleanup owner, wait loop only polls messages + updates heartbeat

---

## Phase D — Split thread-lifecycle.ts *(scope: M, risk: Medium)*

- [x] Extract `src/services/process.service.ts` — spawn, PID files, adopt, health classification
- [x] Extract `src/services/topic.service.ts` — Telegram topic create / delete / remap
- [x] Extract `src/services/worker-cleanup.service.ts` — TTL cleanup, archival, deletion
- [x] Reduce `src/tools/thread-lifecycle.ts` to a thin shim or delete it
- [x] Verify: no file in this domain exceeds 400 LOC

---

## Phase E — Memory Layer Split *(scope: L, risk: Medium — do last)*

- [x] Split `src/data/memory/schema.ts` into:
  - `schema-ddl.ts` — DDL constants only
  - `migration-runner.ts` — migration logic
  - `schema-guard.ts` — self-heal / integrity checks
- [x] Extract `src/services/consolidation.service.ts` — LLM orchestration separate from DB mutations
- [x] Move prompt assembly out of `bootstrap.ts` into `src/services/memory-briefing.service.ts`
- [x] Move SQLite writes out of `telegram.ts` into `src/data/sent-message.repository.ts`
- [x] Verify: no storage module calls OpenAI or assembles prompt strings; `tsc --noEmit` passes

---

## Invariants (must hold after every phase)

- All existing MCP tools work correctly
- Go supervisor / keeper integration unaffected
- Telegram, HTTP dashboard, and stdio transport surface unchanged
- SQLite remains the durable store
- No file should exceed 500 LOC after its phase completes
