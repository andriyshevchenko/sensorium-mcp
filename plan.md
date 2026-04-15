# Centralization Refactoring Plan

Findings from codebase scan (2026-04-15). Grouped by severity.

---

## HIGH

### H1 — `getEffectiveAutonomousMode(threadId)` missing
- **Problem:** No central getter. `config.AUTONOMOUS_MODE` (global) is used directly in `start-session-tool.ts:114/424`, `task-handler.ts:60`, `drive-handler.ts:178/199`, `message-processing.ts:193/217`. `poll-loop.ts:157–165` correctly resolves per-thread and patches `ctx.config`, but the other sites bypass it.
- **Fix:** Add `getEffectiveAutonomousMode(threadId: number): boolean` to `src/config.ts` (mirrors `getEffectiveAgentType`). Replace all direct `config.AUTONOMOUS_MODE` reads with this function.
- **Files:** `config.ts`, `start-session-tool.ts`, `task-handler.ts`, `drive-handler.ts`, `message-processing.ts`, `poll-loop.ts`
- [x] Implement `getEffectiveAutonomousMode(threadId)` in `config.ts`
- [x] Replace all `config.AUTONOMOUS_MODE` direct reads in tool/wait files

---

## MEDIUM-HIGH

### MH1 — `process.env` reads scattered across 11 files
- **Problem:** `OPENAI_API_KEY` read in 6 files. `CONSOLIDATION_MODEL` in 4. Many others bypassing `config.ts`.
- **Fix:** Add typed getters to `config.ts` for all env vars not already covered: `getOpenAiApiKey()`, `getConsolidationModel()`, `getNarrativeModel()`, `getSynthesisModel()`, `getReflectionModel()`, `getMcpHttpPort()`, `getMcpHttpBind()`, `getMcpHttpSecret()`, `getWatcherPort()`. All callers import from config.
- **Worst files:** `data/memory/narrative.ts`, `reflection.ts`, `synthesis.ts`, `consolidation.service.ts`, `agent-spawn.service.ts`, `http-server.ts`
- [ ] Add env-var getters to `config.ts`
- [ ] Replace `process.env.*` reads in `src/data/memory/` files
- [ ] Replace `process.env.*` reads in `src/services/` files
- [ ] Replace `process.env.*` reads in `src/http-server.ts` and `src/index.ts`

---

## MEDIUM

### M1 — Raw SQL outside `src/data/` layer (7 files)
- **Problem:** SQL queries scattered in `sessions.ts`, `dashboard/routes/data.ts`, `dashboard/routes/threads.ts`, `tools/start-session-tool.ts`, `tools/wait/drive-handler.ts`, `services/worker-cleanup.service.ts`, `services/dispatcher/broker.ts`
- **Fix:** Move each query into a typed repository function in `src/data/`. Callers receive typed results, not raw rows.
- [ ] `sessions.ts` — move topic_registry SQL to `src/data/topic-registry.repository.ts`
- [ ] `dashboard/routes/data.ts` — move episode count/list SQL to `src/data/memory/episode.repository.ts`
- [ ] `dashboard/routes/threads.ts:96` — move thread list SQL to `thread-registry.ts`
- [ ] `tools/start-session-tool.ts:332` — move episode count to `episode.repository.ts`
- [ ] `tools/wait/drive-handler.ts:126` — move episode count to `episode.repository.ts`
- [ ] `services/worker-cleanup.service.ts:30` — move stale-row SQL to `thread-registry.ts`
- [ ] `services/dispatcher/broker.ts:67/81` — move task dispatch SQL to `src/data/task.repository.ts`

### M2 — `agentType` dual-store (settings.json + DB `client`)
- **Problem:** `getEffectiveAgentType()` reads from `settings.json` only. If settings.json is cleared, the DB `client` column is ignored. Two stores can diverge.
- **Fix:** Extend `getEffectiveAgentType(threadId)` to also check `thread_registry.client` from DB as a fallback (or primary source). The DB is more durable.
- **Files:** `config.ts:158`, `data/memory/thread-registry.ts`
- [ ] Update `getEffectiveAgentType` to use DB `client` as authoritative source

### M3 — Spawn dispatch branching duplicated
- **Problem:** Same `copilot/codex/claude` if-chain in `delegate-tool.ts:336–340` AND `agent-spawn.service.ts:239–243`.
- **Fix:** Add `dispatchSpawn(agentType, ...params)` to `agent-spawn.service.ts`. `delegate-tool.ts` calls the dispatcher.
- **Files:** `delegate-tool.ts`, `agent-spawn.service.ts`
- [x] Add `dispatchSpawn()` to `agent-spawn.service.ts`
- [x] Update `delegate-tool.ts` to call dispatcher

### M4 — `parsePositiveInt` and `parseAgentType` duplicated
- **Problem:** `parseNumArg` in `delegate-tool.ts:90–95` and `parseThreadId` in `start-session-tool.ts:79–83` are identical. `agentType` enum validation also duplicated between the two files.
- **Fix:** Extract to `src/tools/shared-agent-utils.ts` (file already exists).
- [x] Add `parsePositiveInt()` and `parseAgentType()` to `shared-agent-utils.ts`
- [x] Update both tool files to use shared helpers

### M5 — Direct Telegram `fetch()` calls outside service layer (2 files)
- **Problem:** `daily-session.ts:53` calls Telegram sendMessage directly. `dashboard/routes/threads.ts:331` calls deleteForumTopic directly (duplicates `topic.service.ts`).
- **Fix:** `daily-session.ts` → use `telegram.sendMessage(...)`. `threads.ts:331` → call `topic.service.deleteTelegramTopicByBotApi(...)`.
- [x] Fix `daily-session.ts:53`
- [x] Fix `dashboard/routes/threads.ts:331`

### M6 — `threadType` in-memory tracking lost on restart
- **Problem:** `worker-cleanup.service.ts` uses `SpawnedThread.threadType` (in-memory). After server restart the in-memory list is empty, so pre-restart workers are never cleaned up.
- **Fix:** `worker-cleanup.service.ts` should query `thread_registry.type = 'worker'` from DB for cleanup decisions, not the in-memory list.
- [x] Update `worker-cleanup.service.ts` to query DB for worker thread type

### M7 — `spawnKeepAliveThreads` ignores `exited` threads on startup
- **Problem:** `spawnKeepAliveThreads` filters `thread.status === "active"` only. If a thread exits (status → `'exited'`) while the supervisor is dead, it will never be restarted on server restart — it's stuck until manually resumed. Observed: thread 3868 ("Work (NICE)") had to be manually restarted via `start_thread(mode='resume')`.
- **Fix:** Extend the startup filter to include `status IN ('active', 'exited')` for threads with `keepAlive = true`. After spawn, `activateThread` already resets the status.
- **File:** `src/services/agent-spawn.service.ts:260`
- [x] Change filter to include `'exited'` status for keep-alive threads

---

## Priority Order

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 1 | H1 — `getEffectiveAutonomousMode` | Small | High — prevents future per-thread bypass bugs |
| 2 | M4 — Extract shared helpers | Small | Medium — reduce future divergence |
| 3 | M3 — `dispatchSpawn` dispatcher | Small | Medium — single place to add agent types |
| 4 | M5 — Telegram fetch leak | Small | Medium — correctness + API error handling |
| 5 | M6 — threadType DB query | Small | Medium — correctness after restart |
| 6 | MH1 — `process.env` → config getters | Medium | Medium — enables test overrides, central validation |
| 7 | M2 — `agentType` dual-store | Medium | Medium — reliability |
| 8 | M1 — SQL → data layer | Large | High — maintainability |
