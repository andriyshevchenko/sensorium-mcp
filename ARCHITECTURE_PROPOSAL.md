# Architecture Proposal

## 1. Target Architecture

```text
+------------------------------------------------------------------+
| Layer 4: Interfaces                                              |
| MCP tools | HTTP/dashboard routes | Telegram transport adapters  |
| Own request parsing, response shaping, auth, and delivery only   |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
| Layer 3: Application Services                                    |
| ThreadLifecycleService | SessionService | SchedulerService        |
| MemoryService | ConsolidationService | MessagingService           |
| Own use cases, transactions, state transitions, policies         |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
| Layer 2: Domain + Ports                                          |
| Thread aggregate | Session aggregate | Schedule | Memory models   |
| Explicit state machine, repository interfaces, worker contracts   |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
| Layer 1: Infrastructure                                          |
| SQLite repositories | Telegram client | OpenAI client            |
| Supervisor/worker process adapter | file/JSON compatibility      |
| Own persistence, API calls, retries, and serialization only      |
+------------------------------------------------------------------+
```

Control flow should move top-down only. State changes happen in application services. Infrastructure never decides lifecycle policy.

## 2. Core Principles

1. One write path per concern. Thread/session state, schedules, and memory each need a single owning service.
2. Tool handlers stay thin. They validate input, call one application service, and format output.
3. Make thread lifecycle explicit. Replace implied status rules with a documented state machine and transition table.
4. Background work runs in dedicated runners. `wait_for_instructions` must not also act as a scheduler, cleaner, and recovery loop.
5. Repositories hide storage details. SQLite, JSON compatibility files, PID files, and in-memory caches stay behind interfaces.
6. Cross-thread or LLM workflows belong in services, not storage modules.
7. Preserve working transports and user-visible behavior while moving logic inward.

## 3. High-Impact Changes

| Priority | Change | Why | Scope | Risk |
|---|---|---|---|---|
| 1 | Create a `ThreadLifecycleService` with an explicit state machine and one source of truth for thread status | Removes the biggest correctness gap: five stores and inconsistent crash recovery | L | M |
| 2 | Introduce a real background runtime (`BackgroundJobRunner`) for cleanup, daily rotation, schedules, and consolidation triggers | Eliminates dual ownership, timing-dependent behavior, and the overloaded wait loop | M | M |
| 3 | Put repositories behind interfaces: `ThreadRepository`, `SessionRepository`, `ScheduleRepository`, `MemoryRepository` | Stops direct DB/file access from tools and makes migration possible without behavior drift | M | L |
| 4 | Split `thread-lifecycle.ts` into service + adapters + handlers | Shrinks the main god file and separates process management, topic management, and tool entrypoints | M | M |
| 5 | Refactor memory modules so `schema.ts`, `consolidation.ts`, and `bootstrap.ts` become infrastructure plus application services | Reduces coupling between LLM orchestration, storage mutations, and prompt assembly | L | M |
| 6 | Remove direct infrastructure writes from transport code, especially `telegram.ts` and tool handlers | Prevents hidden side effects and makes ownership of sent-message tracking and registry updates clear | S | L |

Recommended implementation order: 1, 2, 3, 4, 6, 5.

## 4. What NOT to Touch

- Keep the Go supervisor + agent restart model. The process boundary is useful; the problem is ownership, not the existence of a supervisor.
- Keep SQLite as the durable store. The issue is access discipline, not the database choice.
- Keep the current transport surface: MCP tools, Telegram topics, and the Vue dashboard should remain externally stable during the refactor.
- Keep the existing decomposition work where it already helped, especially separated OpenAI integrations and dashboard route splitting.
- Keep backward-compatibility shims where they reduce migration risk.

## 5. Migration Strategy

### Phase A: Establish ownership boundaries

1. Define domain state models and the thread lifecycle state machine.
2. Add repository interfaces and wrap current SQLite/JSON/PID implementations without changing behavior.
3. Route `thread-lifecycle` reads/writes through the new repositories.

### Phase B: Move orchestration out of handlers

1. Add `ThreadLifecycleService`, `SchedulerService`, and `MemoryService`.
2. Convert tool handlers and dashboard routes into thin adapters.
3. Move sent-message tracking and similar side effects out of `telegram.ts`.

### Phase C: Separate background execution

1. Add a dedicated background runner started from `index.ts`.
2. Move worker cleanup, daily rotation, due-schedule checks, and consolidation triggering into that runner.
3. Reduce `wait_for_instructions` to message polling and delivery only.

### Phase D: Simplify memory subsystem

1. Keep `schema.ts` focused on DB init and migrations.
2. Move consolidation orchestration into `ConsolidationService`.
3. Move bootstrap assembly into `MemoryBootstrapService` backed by read-only repository queries.

### Phase E: Remove compatibility debt

1. Delete duplicate state stores once repository-backed recovery is proven.
2. Collapse module globals into service-owned runtime state.
3. Add architecture tests: import-boundary checks, state-transition tests, and crash-recovery tests.

## Success Criteria

- One authoritative thread status per thread.
- One scheduler execution path.
- No direct SQLite writes from tool handlers or Telegram transport code.
- `wait_for_instructions` no longer performs unrelated background jobs.
- Crash recovery behavior is deterministic and testable.
