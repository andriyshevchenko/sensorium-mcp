# Implementation Plan: Supervisor Hardening & Emergency Recovery

## Context

The .NET supervisor (`supervisor-dotnet/`, ~2,180 LOC) currently handles too many concerns:
watchdog, self-update (730 LOC state machine), Telegram notifications, process management.
The operator wants to simplify it into a **bulletproof watchdog + emergency Telegram bot**,
remove self-update complexity, and add snapshot-based recovery — all with proper test coverage.

**MCP runs via `npx sensorium-mcp@<version>`** — no git checkout involved.
Supervisor binary updates are handled by the PowerShell bootstrap script (`installSensorium.ps1`).

---

## Architecture (After)

```
SecureVault → Supervisor (.NET) → MCP (npx sensorium-mcp@latest)
                  │
                  ├── Watchdog: health-check MCP, restart if dead
                  ├── Telegram Bot: emergency commands (status/restart/restore/nuke)
                  └── Snapshot Restore: unzip data + pin MCP version

Dashboard (inside MCP) → Snapshot Create/List/Delete UI
PowerShell bootstrap   → First-time install / supervisor binary replacement
```

**Two actors at runtime.** Supervisor = safety net. MCP = everything else.

---

## Phase 1: Strip Self-Update (~730 LOC removed)

**Goal:** Remove the update state machine and all associated code.

### Files to delete:
- `Services/Updater.cs` (339 lines) — GitHub release polling, download, staging
- `Services/SelfUpdate.cs` (202 lines) — Binary swap (.cmd helper on Windows)
- `Infrastructure/UpdateState.cs` (189 lines) — FSM persistence

### Files to modify:
- `SupervisorWorker.cs` — Remove update-related branches, `_updater` references, restart-for-update logic
- `Program.cs` — Remove `SelfUpdate.ApplyPendingUpdate()` call at startup, remove Updater DI registration
- `SupervisorOptions.cs` — Remove update-related config (UpdateMode, UpdatePollInterval, GracePeriodSeconds, MinUptimeBeforeUpdate)
- `Infrastructure/MaintenanceFlagWriter.cs` — Keep (still useful for restart signaling)

### Tests to remove:
- `tests/UpdateStateTests.cs` (94 lines)

### Estimated delta: -730 LOC production, -94 LOC tests

---

## Phase 2: Telegram Command Handler (~200 LOC added)

**Goal:** Turn the supervisor into an emergency control panel via Telegram.

### New file: `Services/TelegramCommandHandler.cs`

**Design:**
- Long-poll Telegram `getUpdates` on the same bot token (separate offset from MCP poller)
- Filter messages by operator's chat ID only (security)
- Parse commands with simple prefix matching

**Commands:**

| Command | Action |
|---------|--------|
| `/sv status` | Reply with: supervisor uptime, MCP PID + uptime, health status, current MCP version |
| `/sv restart` | Kill MCP gracefully (prepare-shutdown → kill), respawn |
| `/sv restore <name>` | Restore named snapshot (Phase 4), restart MCP |
| `/sv snapshots` | List available snapshots with date/size/version |
| `/sv nuke` | Kill ALL node processes, delete lock files + temp files, respawn MCP fresh |

**Important:** Commands use `/sv` prefix to avoid collision with MCP's Telegram bot on the same chat.

### Files to modify:
- `Program.cs` — Register TelegramCommandHandler as hosted service
- `SupervisorOptions.cs` — Add `TelegramOperatorChatId` for auth filtering
- `TelegramNotifier.cs` — Extract shared HTTP client / bot token to avoid duplication

### Estimated delta: +200 LOC

---

## Phase 3: Snapshot Logic in Supervisor (~150 LOC added)

**Goal:** Supervisor can restore a snapshot package on command.

### New file: `Services/SnapshotManager.cs`

**Snapshot format:**
```
snapshots/
  stable-2026-04-23T2100.zip    ← data directory contents
  stable-2026-04-23T2100.json   ← manifest: { mcpVersion, createdAt, description }
```

**Data directory contents** (zipped):
- `memory.db` — SQLite database (threads, memory notes, settings)
- `settings.json` — User settings
- `sessions/` — Thread session state
- `topic_registry.json` — Telegram topic mappings

**Restore flow** (triggered by `/sv restore <name>`):
1. Kill MCP process
2. Backup current data dir to `snapshots/_pre-restore-backup.zip` (safety net)
3. Unzip snapshot over data directory
4. Read manifest → set `MCP_START_COMMAND` to `npx sensorium-mcp@<pinnedVersion>`
5. Respawn MCP

**Snapshot creation** is handled by the MCP dashboard (Phase 5), NOT the supervisor.
The supervisor only reads/restores snapshots.

### Estimated delta: +150 LOC

---

## Phase 4: Dashboard Snapshot UI (~200 LOC added to MCP)

**Goal:** Create and manage snapshots from the dashboard when the system is healthy.

### New files (MCP side):
- `src/dashboard/routes/snapshots.ts` (~80 LOC) — REST API
  - `GET /api/snapshots` — List all snapshots
  - `POST /api/snapshots` — Create snapshot (zip data dir + write manifest with current npm version)
  - `DELETE /api/snapshots/:name` — Delete a snapshot
- `src/dashboard/vue/src/components/SnapshotsTab.vue` (~100 LOC) — Vue component
  - "Create Snapshot" button with optional description field
  - Table: name, date, MCP version, size, delete button
  - No restore from dashboard (that's the supervisor's job via Telegram)

### Files to modify (MCP side):
- `src/dashboard/vue/src/App.vue` — Add Snapshots tab
- `src/http-server.ts` — Mount snapshot routes

### Shared utility:
- `src/utils/snapshot.ts` (~20 LOC) — Zip/unzip helpers using Node's built-in `node:zlib` + `tar`

### Estimated delta: +200 LOC

---

## Phase 5: Test Hardening (~500 LOC added)

**Goal:** Comprehensive test coverage for the simplified supervisor.

### New/expanded test files:

| Test File | Coverage Target | Estimated LOC |
|-----------|----------------|---------------|
| `tests/SupervisorWorkerTests.cs` | Health check loop, restart decisions, shutdown | 150 |
| `tests/ProcessManagerTests.cs` | Spawn, kill, PID tracking, port cleanup | 100 |
| `tests/TelegramCommandHandlerTests.cs` | Command parsing, auth filtering, response formatting | 100 |
| `tests/SnapshotManagerTests.cs` | Zip/unzip, manifest parsing, restore flow, pre-restore backup | 100 |
| `tests/SingletonLockTests.cs` | Expand existing: stress test, stale reclaim race conditions | 50 |

**Testing approach:**
- Unit tests with mocked interfaces (IProcessManager, IMcpClient, ITelegramNotifier)
- Integration test for snapshot zip/unzip round-trip
- No live Telegram/process tests (mock everything external)

### Estimated delta: +500 LOC tests

---

## Summary

| Phase | Description | LOC Delta | Priority |
|-------|-------------|-----------|----------|
| 1 | Strip self-update | -730 prod, -94 test | P0 — reduces attack surface |
| 2 | Telegram command handler | +200 prod | P0 — enables remote recovery |
| 3 | Snapshot restore in supervisor | +150 prod | P1 — core recovery mechanism |
| 4 | Dashboard snapshot UI | +200 prod (MCP side) | P1 — create snapshots when healthy |
| 5 | Test hardening | +500 test | P1 — confidence for VPS deployment |

**Net result:**
- Production code: ~2,180 → ~1,800 LOC (smaller, focused)
- Test code: ~356 → ~760 LOC (2x coverage)
- Removed: update state machine, binary swap, GitHub polling
- Added: emergency Telegram bot, snapshot restore, dashboard snapshot UI

---

## Execution Order

1. Phase 1 first (strip complexity, verify build + existing tests pass)
2. Phase 2 + Phase 3 together (Telegram commands need snapshot restore)
3. Phase 4 independently (MCP side, can be done in parallel)
4. Phase 5 throughout (write tests as each phase completes)

Each phase is independently deployable. Phase 1 alone makes the supervisor more reliable.
