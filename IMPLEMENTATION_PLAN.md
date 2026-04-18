# Implementation Plan — Infrastructure Hardening & .NET Supervisor Migration

> Created: 2026-04-18. Thread: Sensorium-Debug (11753)
> Ground rules: No backward compatibility. No feature flags. Clean cut.

---

## Phase 1: Strip SecureVault/Keyring from Go Supervisor

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

## Phase 2: .NET 10 Supervisor Rewrite

**Goal:** Replace the entire `supervisor/` Go codebase with a .NET 10 console app using Generic Host.
Runs from shell:startup shortcut. No Windows service — keep it simple.
Uses proper .NET patterns: DI, `IConfiguration`, Serilog, `IHttpClientFactory`.

### 2.0 Project Setup

- [ ] **2.0.1** Create `supervisor-dotnet/` directory with `dotnet new worker` template
- [ ] **2.0.2** Target .NET 10, single-file self-contained publish:
  ```xml
  <TargetFramework>net10.0</TargetFramework>
  <PublishSingleFile>true</PublishSingleFile>
  <SelfContained>true</SelfContained>
  <RuntimeIdentifier>win-x64</RuntimeIdentifier>
  ```
- [ ] **2.0.3** Add NuGet references:
  - `Serilog.Extensions.Hosting` + `Serilog.Sinks.File` + `Serilog.Sinks.Console` — structured logging
  - `Microsoft.Extensions.Http` — `IHttpClientFactory` for MCP + Telegram + GitHub API
- [ ] **2.0.4** Project structure:
  ```
  supervisor-dotnet/
  ├── Program.cs              — entry point, host builder, DI registration, Serilog config
  ├── SupervisorWorker.cs     — BackgroundService, main loop
  ├── Configuration/
  │   └── SupervisorOptions.cs — IConfiguration-bound options (env vars)
  ├── Services/
  │   ├── IMcpClient.cs        — interface for MCP health/shutdown
  │   ├── McpClient.cs         — HttpClient-based implementation
  │   ├── IProcessManager.cs   — interface for process lifecycle
  │   ├── ProcessManager.cs    — spawn, kill, PID file, alive check
  │   ├── IUpdater.cs          — interface for self-update
  │   ├── Updater.cs           — check + download + apply
  │   ├── SelfUpdate.cs        — apply-helper script generation
  │   ├── ISingletonLock.cs    — interface
  │   ├── SingletonLock.cs     — file-based PID lock
  │   ├── ITelegramNotifier.cs — interface
  │   └── TelegramNotifier.cs  — operator notifications
  ├── Infrastructure/
  │   ├── NativeMethods.cs     — P/Invoke for CreateProcess (Windows)
  │   └── UpdateState.cs       — update state machine persistence
  └── Sensorium.Supervisor.csproj
  ```

### 2.1 Config — `IConfiguration` + Environment Variables

- [ ] **2.1.1** `SupervisorOptions.cs`: POCO bound via `IConfiguration` from env vars
  ```csharp
  builder.Configuration.AddEnvironmentVariables();
  builder.Services.Configure<SupervisorOptions>(builder.Configuration);
  ```
  - `WATCHER_MODE` (default: "development")
  - `WATCHER_POLL_HOUR` (default: 4)
  - `WATCHER_POLL_INTERVAL` (default: 60s)
  - `WATCHER_GRACE_PERIOD` (default: 10s dev / 300s prod)
  - `MCP_START_COMMAND` (default: "npx -y sensorium-mcp@latest")
  - `MCP_HTTP_PORT` (required, int)
  - `MCP_HTTP_SECRET` (optional)
  - `TELEGRAM_TOKEN` (optional)
  - `TELEGRAM_CHAT_ID` (optional)
  - `DataDir`: computed `~/.remote-copilot-mcp/`
  - Derived `Paths` property for all file paths
- [ ] **2.1.2** No SecureVault. No keyring. No profile resolution.
  All secrets injected by `securevault run --detach`.
- [ ] **2.1.3** Validate required config at startup (fail fast if `MCP_HTTP_PORT` missing)

### 2.2 Process Management

- [ ] **2.2.1** `ProcessManager.SpawnMcpServer()`:
  - Use `System.Diagnostics.Process` with `ProcessStartInfo`
  - Set `CreateNoWindow = true`
  - On Windows: use P/Invoke `CreateProcess` with `CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB` flags
  - Redirect stderr to `mcp-stderr.log` (append)
  - Inherit parent environment (secrets already present)
  - Set `MCP_HTTP_PORT`, `MCP_HTTP_SECRET`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` explicitly
  - Write PID file after start

  **⚠️ Pitfall — `CREATE_BREAKAWAY_FROM_JOB`:**
  `System.Diagnostics.Process` doesn't expose `CreationFlags` directly.
  Use P/Invoke `CreateProcess` for the MCP spawn path only (~30 lines in `NativeMethods.cs`).
  Requires the parent job to have `JOB_OBJECT_LIMIT_BREAKAWAY_OK`; fail fast with
  clear error if it doesn't.

- [ ] **2.2.2** `ProcessManager.KillProcessDirect(pid)`:
  - Windows: `taskkill /F /PID {pid}` (no `/T` — never tree kill MCP)
  - Unix: `Process.Kill()` with graceful SIGTERM first
- [ ] **2.2.3** `ProcessManager.IsProcessAlive(pid)`:
  - `Process.GetProcessById()` + catch `ArgumentException`
- [ ] **2.2.4** `ProcessManager.KillByPort(port)`:
  - Windows: parse `netstat` output, kill matching PIDs
- [ ] **2.2.5** PID file helpers: read/write JSON `{"pid":123}` format

### 2.3 MCP Health Client

- [ ] **2.3.1** `McpClient.IsServerReady()`: `OPTIONS /mcp` with 3s timeout
- [ ] **2.3.2** `McpClient.WaitForReady()`: poll with 3s interval, 2min timeout
- [ ] **2.3.3** `McpClient.PrepareShutdown()`: `POST /api/prepare-shutdown` with 5s timeout
  - Called before killing MCP to write reconnect snapshot
  - Best-effort: log warning on failure, proceed with kill

### 2.4 Main Worker Loop (`SupervisorWorker.cs`)

- [ ] **2.4.1** Inherit `BackgroundService`, implement `ExecuteAsync(CancellationToken)`
- [ ] **2.4.2** Startup sequence:
  1. Acquire singleton lock (PID file with stale reclaim)
  2. Apply pending self-update if present
  3. Check for existing healthy MCP → inherit if alive + ready
  4. If not inherited: kill orphan MCP, spawn fresh
  5. Wait for MCP ready (poll 3s interval, 2min timeout)
  6. Start updater background task
  7. Start health check loop
- [ ] **2.4.3** Health check loop (use `PeriodicTimer`, 30s interval):
  - PID check every tick
  - HTTP liveness check every 5th tick (~2.5 min)
  - 3 consecutive HTTP failures → PrepareShutdown → kill → respawn
  - Notify operator via Telegram on restart
- [ ] **2.4.4** Shutdown sequence (CancellationToken fired):
  1. Stop updater
  2. Stop health check loop
  3. `PrepareShutdown()` → `KillProcessDirect(mcpPid)`
  4. Release singleton lock

  **⚠️ Pitfall — `ExecuteAsync` blocking:**
  Keep `StartAsync` fast. Use `PeriodicTimer` for loops (not `Task.Delay`).
  Always check `stoppingToken.IsCancellationRequested` before spawning.

### 2.5 Self-Update (`Updater.cs` + `SelfUpdate.cs`)

- [ ] **2.5.1** Check GitHub Releases API for `supervisor-latest` tag
  - Asset naming: `sensorium-supervisor-{os}-{arch}.exe`
  - Compare remote version vs local `supervisor-version.txt`
- [ ] **2.5.2** Download to `PendingBinary` path with temp file + atomic rename
- [ ] **2.5.3** Stage pending version file
- [ ] **2.5.4** Apply pattern (console mode):
  Launch apply-helper .cmd → exit supervisor → helper waits for PID death → swaps binary → relaunches from shell:startup
- [ ] **2.5.5** Rollback detection: read failure marker on startup, transition state to failed
- [ ] **2.5.6** Grace period before applying (300s prod / 10s dev)
- [ ] **2.5.7** Min uptime check (600s) — don't update right after restart

  **⚠️ Pitfall — File locking on Windows:**
  A running .exe cannot be overwritten. Apply-helper pattern is mandatory.
  Do NOT try `File.Move` on the running exe.

### 2.6 Host & DI Setup (`Program.cs`)

- [ ] **2.6.1** Generic Host builder:
  ```csharp
  var builder = Host.CreateApplicationBuilder(args);
  builder.Configuration.AddEnvironmentVariables();
  builder.Services.Configure<SupervisorOptions>(builder.Configuration);

  // Serilog
  builder.Host.UseSerilog((ctx, cfg) => cfg
      .WriteTo.Console()
      .WriteTo.File(logPath, rollingInterval: RollingInterval.Day));

  // DI
  builder.Services.AddHttpClient<McpClient>();
  builder.Services.AddHttpClient<TelegramNotifier>();
  builder.Services.AddSingleton<ISingletonLock, SingletonLock>();
  builder.Services.AddSingleton<IProcessManager, ProcessManager>();
  builder.Services.AddSingleton<IMcpClient, McpClient>();
  builder.Services.AddSingleton<ITelegramNotifier, TelegramNotifier>();
  builder.Services.AddSingleton<IUpdater, Updater>();
  builder.Services.AddHostedService<SupervisorWorker>();

  var host = builder.Build();
  host.Run();
  ```
- [ ] **2.6.2** No Windows service support — console-only, launched from shell:startup shortcut
  (Can be added later with `AddWindowsService()` if needed — one-line change)

### 2.7 Unified Log Directory

**Goal:** All logs in `~/.remote-copilot-mcp/logs/` with clear subdirectories.

- [ ] **2.7.1** Log directory structure:
  ```
  ~/.remote-copilot-mcp/logs/
  ├── supervisor/           — Serilog rolling files
  │   ├── supervisor-20260418.log
  │   └── supervisor-20260419.log
  ├── mcp/                  — MCP stderr (redirected by supervisor)
  │   └── mcp-stderr.log
  └── agents/               — per-thread agent logs (already here)
      ├── Thread_Name_12345_2026-04-18.json
      └── ...
  ```
- [ ] **2.7.2** Update `SupervisorOptions.Paths` to use `logs/supervisor/` for supervisor log
- [ ] **2.7.3** Update `ProcessManager.SpawnMcpServer` to redirect stderr to `logs/mcp/mcp-stderr.log`
- [ ] **2.7.4** Agent logs already go to `logs/` — just rename path config for consistency

### 2.8 Singleton Lock

- [ ] **2.8.1** `SingletonLock.Acquire()`: `FileMode.CreateNew` (atomic), write PID
  - On conflict: read PID, check alive, reclaim if stale
- [ ] **2.8.2** `SingletonLock.Release()`: delete lock file
- [ ] **2.8.3** Implement `IDisposable` for automatic release

### 2.9 Telegram Notifications

- [ ] **2.9.1** `TelegramNotifier` via `IHttpClientFactory`, POST sendMessage, 10s timeout
  - Injected via DI, silent no-op if token/chatId not configured
  - Failures logged via `ILogger<TelegramNotifier>`

### 2.10 Update State Persistence

- [ ] **2.10.1** JSON `update-state.json` with phases: idle, downloading, staged, restarting, rollback, failed
- [ ] **2.10.2** Coordinator lock file for concurrent update prevention

### 2.11 Build & Deploy

- [ ] **2.11.1** `dotnet publish` → single-file exe to `~/.remote-copilot-mcp/bin/sensorium-supervisor.exe`
- [ ] **2.11.2** GitHub Actions workflow for release builds (win-x64, linux-x64)
- [ ] **2.11.3** Update `Install-Sensorium.ps1` to download .NET binary
- [ ] **2.11.4** Update `src/index.ts` supervisor launcher if binary name changes

### 2.12 Testing

- [ ] **2.12.1** Unit tests (xUnit): Config binding, PID file read/write, singleton lock, update state
- [ ] **2.12.2** Integration: spawn MCP → health check → kill → respawn cycle
- [ ] **2.12.3** Manual: apply-helper binary swap flow

### 2.13 Cleanup

- [ ] **2.13.1** Delete `supervisor/` Go directory entirely
- [ ] **2.13.2** Remove Go supervisor from CI/CD

---

## Phase 3: MCP State Store Consolidation

**Goal:** Collapse 4 state stores into 2 authoritative sources.

**Current:** spawnedThreads[] (in-memory), PID files (disk), SQLite (DB), heartbeat files (disk)
**Target:** SQLite = intent, PID files = OS evidence, spawnedThreads[] = cache, heartbeats = hints

### Tasks

- [ ] **3.1** Add `reconcileState()` function:
  - Read all active/exited threads from SQLite
  - Read all PID files
  - Cross-reference: alive PID → populate `spawnedThreads[]`
  - Dead PID → clean up file, mark exited in DB
  - `spawnedThreads[]` without DB record → warn and remove
- [ ] **3.2** Call `reconcileState()` at startup (replaces `restoreFromPidFiles` + `cleanupStalePidFiles`)
- [ ] **3.3** Ensure `pid` column exists in `thread_registry` (add migration if needed)
- [ ] **3.4** KeeperService reads SQLite for keepAlive, PID files for liveness (not `spawnedThreads[]`)
- [ ] **3.5** Verify: TypeScript builds, all existing behavior preserved
- [ ] **3.6** Commit: `refactor: consolidate thread state stores (SQLite + PID files)`

---

## Phase 4: Explicit Thread State Machine

**Goal:** Replace implicit transitions with validated state machine.

**Proposed states:**

```
Created ──→ Spawning ──→ Active ──→ Exiting ──→ Exited ──→ Archived
                           │                                   │
                           ├──→ Stuck ──→ Exiting              │
                           │                                   │
                           └──→ Archived ←─────────────────────┘
```

| State | Who sets it | Meaning |
|-------|-------------|---------|
| Created | registerThread | DB record exists, no process yet |
| Spawning | dispatchSpawn | Process is starting up |
| Active | KeeperService / session connect | Process running, healthy |
| Stuck | KeeperService | No heartbeat for 30min |
| Exiting | decommissionWorker | Teardown in progress |
| Exited | markExited | Process dead, awaiting cleanup |
| Archived | archiveThread | Final state |

### Tasks

- [ ] **4.1** Add `Created`, `Spawning`, `Stuck`, `Exiting` to `ThreadState` enum
- [ ] **4.2** Update `VALID_TRANSITIONS` map with new states
- [ ] **4.3** Add SQLite migration for new status values
- [ ] **4.4** Update `dispatchSpawn`: Created → Spawning → Active
- [ ] **4.5** Update KeeperService stuck detection: Active → Stuck → Exiting
- [ ] **4.6** Update `decommissionWorker`: any → Exiting → Archived
- [ ] **4.7** Update `handleProcessExit`: Active → Exited (non-keepAlive) or Active → Active (keepAlive)
- [ ] **4.8** Remove implicit state logic from agent-spawn and worker-cleanup
- [ ] **4.9** Add `transitionThread(db, threadId, targetState)` helper with validation
- [ ] **4.10** Verify: TypeScript builds, no behavior change
- [ ] **4.11** Commit: `refactor: explicit thread state machine with validated transitions`

---

## Execution Order

```
Phase 1 (Go cleanup)  ──→  Phase 2 (.NET rewrite)
                                     │
Phase 3 (State stores) ──────────────┤  (independent, parallel with Phase 2)
Phase 4 (State machine) ─────────────┘
```

- Phase 1 is prerequisite for Phase 2 (clean baseline)
- Phases 3 & 4 are MCP-only, independent of supervisor language
- All phases committable independently

---

## Known Pitfalls & Mitigations

| Pitfall | Mitigation |
|---------|------------|
| `CREATE_BREAKAWAY_FROM_JOB` not in `System.Diagnostics.Process` | P/Invoke `CreateProcess` with explicit flags (~30 lines) |
| Running .exe locked on Windows | Apply-helper .cmd script: wait → swap → relaunch |
| `ExecuteAsync` blocking host startup | Keep `StartAsync` fast, use `PeriodicTimer` |
| Job Object killing MCP children | `CREATE_BREAKAWAY_FROM_JOB` on spawned MCP |
| Parent job missing `BREAKAWAY_OK` | Fail fast with clear error, document in README |
| Stale PID files after crash | Reclaim stale locks; `reconcileState()` at startup |
| HTTP false positives during MCP boot | Skip HTTP checks until `WaitForReady` completes |
| Self-update race (two supervisors) | Helper waits for old PID death before launching new |
| State machine migration breaking existing data | New states are additive; existing values remain valid |

---

## Success Criteria

- [ ] Go supervisor deleted, .NET supervisor builds as single-file exe
- [ ] `securevault run --detach -- sensorium-supervisor.exe` works end-to-end
- [ ] MCP survives supervisor restart (`CREATE_BREAKAWAY_FROM_JOB` verified)
- [ ] Self-update binary swap works in console and service mode
- [ ] Health check detects hung MCP (HTTP) and dead MCP (PID)
- [ ] Thread state machine rejects invalid transitions with clear errors
- [ ] State reconciliation catches orphans and stale records at startup
- [ ] All TypeScript builds pass, no MCP behavior regressions
