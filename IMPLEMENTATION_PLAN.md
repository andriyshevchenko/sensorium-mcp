# Sensorium Architecture Refactor — Implementation Plan

> Approved: 2026-04-14. Update checkboxes as work completes.
> Thread: Sensorium-Debug (11753)

---

## Phase A — Repository Interfaces *(scope: S, risk: Low)*

- [ ] Define `IThreadRepository`, `ISessionRepository`, `IScheduleRepository` interfaces in `src/data/`
- [ ] Wrap current SQLite/JSON/PID implementations behind these interfaces (no behavior change)
- [ ] Update all import sites to use interfaces instead of concrete modules
- [ ] Verify: `npx tsc --noEmit` passes, zero behavior change

---

## Phase B — ThreadLifecycleService *(scope: L, risk: Medium)*

- [ ] Define explicit thread state machine (states: active / dormant / exited / archived / expired + valid transitions doc)
- [ ] Create `src/services/thread-lifecycle.service.ts` — single owner of all thread state transitions
- [ ] Consolidate 5 creation paths into 1 via the service
- [ ] Consolidate 4 destruction paths into 1 via the service
- [ ] Remove JSON session file as a primary lookup; SQLite `thread_registry` is the only source of truth
- [ ] Verify: all create/destroy flows call the service, no direct `updateThread()` from tool handlers

---

## Phase C — BackgroundJobRunner *(scope: M, risk: Medium)*

- [ ] Create `src/services/background-runner.ts` — single owner of all recurring timers
- [ ] Register jobs: worker cleanup (every 5 min), daily rotation check (every 5 min at 04:00), scheduler tick (every 60s), consolidation trigger
- [ ] Remove `cleanupExpiredWorkers` call from `src/tools/wait/drive-handler.ts` (keep only the runner's call)
- [ ] Strip unrelated background tasks out of `wait_for_instructions` poll loop
- [ ] Verify: exactly 1 cleanup owner, wait loop only polls messages + updates heartbeat

---

## Phase D — Split thread-lifecycle.ts *(scope: M, risk: Medium)*

- [ ] Extract `src/services/process.service.ts` — spawn, PID files, adopt, health classification
- [ ] Extract `src/services/topic.service.ts` — Telegram topic create / delete / remap
- [ ] Extract `src/services/worker-cleanup.service.ts` — TTL cleanup, archival, deletion
- [ ] Reduce `src/tools/thread-lifecycle.ts` to a thin shim or delete it
- [ ] Verify: no file in this domain exceeds 400 LOC

---

## Phase E — Memory Layer Split *(scope: L, risk: Medium — do last)*

- [ ] Split `src/data/memory/schema.ts` into:
  - `schema-ddl.ts` — DDL constants only
  - `migration-runner.ts` — migration logic
  - `schema-guard.ts` — self-heal / integrity checks
- [ ] Extract `src/services/consolidation.service.ts` — LLM orchestration separate from DB mutations
- [ ] Move prompt assembly out of `bootstrap.ts` into `src/services/memory-briefing.service.ts`
- [ ] Move SQLite writes out of `telegram.ts` into `src/data/sent-message.repository.ts`
- [ ] Verify: no storage module calls OpenAI or assembles prompt strings; `tsc --noEmit` passes

---

## Invariants (must hold after every phase)

- All existing MCP tools work correctly
- Go supervisor / keeper integration unaffected
- Telegram, HTTP dashboard, and stdio transport surface unchanged
- SQLite remains the durable store
- No file should exceed 500 LOC after its phase completes
