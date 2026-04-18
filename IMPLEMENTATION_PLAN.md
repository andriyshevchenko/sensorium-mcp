# Implementation Plan — Infrastructure Hardening & .NET Supervisor Migration

> Created: 2026-04-18. Thread: Sensorium-Debug (11753)
> Ground rules: No backward compatibility. No feature flags. Clean cut.

---

## Phase 1: Strip SecureVault/Keyring from Go Supervisor ✅

**Goal:** Remove all secret-resolution code so the supervisor reads plain `os.Getenv()` only.
SecureVault CLI (`securevault run --detach`) injects secrets into the process environment externally.

### Tasks

- [x] **1.1** Delete `supervisor/secrets.go` (resolveSecretWithKeyring, resolveIntWithKeyring, resolveFromSecureVault, resolveStringChain, resolveIntChain)
- [x] **1.2** Delete `supervisor/secrets_test.go`
- [x] **1.3** Delete `supervisor/secrets_securevault_test.go`
- [x] **1.4** Simplify `supervisor/config.go`:
  - Remove imports: `sv "github.com/andriyshevchenko/SecureVault/securevault-go"`, `regexp`, `errors`
  - Remove fields: `KeyringService`, `SecureVaultProfile`, `SecureVaultBaseDir`, `ResolvedProfileEnv`
  - Replace all resolve chains with plain `os.Getenv()` + `envOr()` / `envInt()`
  - Delete functions: `resolveProfileEnv`, `isAllowedProfileEnvKey`
  - Delete variables: `profileEnvKeyPattern`, `deniedProfileEnvKeys`
- [x] **1.5** Simplify `supervisor/process.go` `SpawnMCPServer`:
  - Remove `ResolvedProfileEnv` loop (env vars already inherited from parent process)
- [x] **1.6** Run `go mod tidy` to drop `go-keyring` and `SecureVault/securevault-go` from `go.mod` / `go.sum`
- [x] **1.7** Verify: `go build ./...` and `go test ./...` pass
- [x] **1.8** Commit: `refactor: strip SecureVault/keyring from supervisor config`

---

## Phase 2: .NET 10 Supervisor Rewrite ✅

**Goal:** Replace the entire `supervisor/` Go codebase with a .NET 10 console app using Generic Host.
Runs from shell:startup shortcut. No Windows service — keep it simple.
Uses proper .NET patterns: DI, `IConfiguration`, Serilog, `IHttpClientFactory`.

### Tasks

- [x] **2.0** Project setup: `supervisor-dotnet/` with .NET 10 Worker Service template
- [x] **2.1** Config: `SupervisorOptions` bound via `IConfiguration` from env vars
- [x] **2.2** Process management: `ProcessManager` with P/Invoke `CreateProcess` (Windows), `Process.Start` (Unix)
- [x] **2.3** MCP health client: `McpClient` with `OPTIONS /mcp` and `POST /api/prepare-shutdown`
- [x] **2.4** Main worker loop: `SupervisorWorker` as `BackgroundService` with `PeriodicTimer`
- [x] **2.5** Self-update: `Updater` + `SelfUpdate` with apply-helper .cmd pattern
- [x] **2.6** Host & DI: Generic Host with Serilog, `IHttpClientFactory`, all services as singletons
- [x] **2.7** Unified log directory: `~/.remote-copilot-mcp/logs/{supervisor,mcp}/`
- [x] **2.8** Singleton lock: `SingletonLock` with stale reclaim
- [x] **2.9** Telegram notifications: `TelegramNotifier` via `IHttpClientFactory`
- [x] **2.10** Update state persistence: JSON file with coordinator lock
- [x] **2.11** Build: `dotnet publish -r win-x64` → single-file exe
- [x] **2.12** Testing: 21 xUnit tests (config, PID files, singleton lock, update state)
- [x] **2.13** Code review fixes: H1 (stderr append), M1 (IConfiguration), M2 (recursive output paths)
- [ ] **2.14** Delete `supervisor/` Go directory entirely (pending operator go-ahead)

---

## Phase 3: MCP State Store Consolidation ✅

**Goal:** Collapse 4 state stores into 2 authoritative sources.

**Current:** spawnedThreads[] (in-memory), PID files (disk), SQLite (DB), heartbeat files (disk)
**Target:** SQLite = intent, PID files = OS evidence, spawnedThreads[] = cache, heartbeats = hints

### Tasks

- [x] **3.1** Add `reconcileState()` function
- [x] **3.2** Call `reconcileState()` at startup (replaces `restoreFromPidFiles` + `cleanupStalePidFiles`)
- [x] **3.3** Ensure `pid` column exists in `thread_registry` (migration 22)
- [x] **3.4** KeeperService reads SQLite for keepAlive, PID files for liveness
- [x] **3.5** Verify: TypeScript builds, all existing behavior preserved
- [x] **3.6** Commit: `refactor: consolidate thread state stores (SQLite + PID files)`

---

## Phase 4: Explicit Thread State Machine ✅

**Goal:** Replace implicit transitions with validated state machine.

### Tasks

- [x] **4.1** Add `Created`, `Spawning`, `Stuck`, `Exiting` to `ThreadState` enum
- [x] **4.2** Update `VALID_TRANSITIONS` map with new states
- [x] **4.3** Add SQLite migration 23 for new status values
- [x] **4.4–4.8** Update dispatchSpawn, KeeperService, decommissionWorker, handleProcessExit
- [x] **4.9** Add `transitionThread(db, threadId, targetState)` helper with validation
- [x] **4.10** Verify: TypeScript builds, no behavior change
- [x] **4.11** Commit: `refactor: explicit thread state machine with validated transitions`

---

## Execution Summary

All 4 phases complete. Commits (not pushed):

1. `5f98bb2` — refactor: strip SecureVault/keyring from supervisor config (Phase 1)
2. `52717af` — refactor: consolidate thread state stores (Phase 3)
3. `f54eeb9` — refactor: explicit thread state machine with validated transitions (Phase 4)
4. `cc7bff8` — feat: .NET 10 supervisor rewrite (Phase 2)
5. `ff446b4` — fix: address .NET supervisor code review findings (Phase 2 review)

Remaining: Task 2.14 (delete Go `supervisor/` directory) — pending operator decision.
