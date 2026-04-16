# Supervisor + SecureVault Reliability Plan

Scope: reliable always-on operation for supervisor + autonomous agents, secure secrets via SecureVault, safe MCP/supervisor updates with rollback, and dual deployment modes (user-context task now, service mode for VPS).

---

## Phase 0 — Baseline Done

- [x] Integrate SecureVault-backed secret resolution chain in supervisor (`env -> SecureVault profile -> keyring`)
- [x] Add `securevault-go` package and tests in SecureVault repo
- [x] Publish `securevault-go` and pin supervisor dependency
- [x] Keep Windows Service support in supervisor
- [x] Add user-scoped service install parameters and validation
- [x] Run code reviews and resolve high/medium findings raised during integration

---

## Phase 1 — Host Mode Strategy (Minimal Change)

### 1.1 Add explicit host mode
- [ ] Add `HOST_MODE` config (`task` | `service`) in supervisor config
- [ ] Default behavior:
	- [ ] service context -> `service`
	- [ ] non-service context -> `task`

### 1.2 Add scheduled task installer (user-context)
- [ ] Add `scripts/install-supervisor-task.ps1`
- [ ] Task registration requirements:
	- [ ] startup trigger
	- [ ] user logon trigger
	- [ ] restart on failure policy
	- [ ] single instance policy
	- [ ] run under current user context (SecureVault-compatible)
- [ ] Add `-Uninstall` and `-Status` operations for task script

### 1.3 Documentation
- [ ] Document host mode decision matrix in README:
	- [ ] local machine with SecureVault -> scheduled task
	- [ ] Windows VPS -> service (preferred) or task
	- [ ] Linux VPS -> systemd

---

## Phase 2 — Update Coordinator + State Machine

### 2.1 Persisted update state
- [ ] Add `update-state.json` in data directory
- [ ] Define states:
	- [ ] `idle`
	- [ ] `staged`
	- [ ] `applying`
	- [ ] `restarting`
	- [ ] `verifying`
	- [ ] `rollback`
	- [ ] `failed`
- [ ] Store scope metadata (`mcp` | `supervisor`) and target version

### 2.2 Serialize updater scopes
- [ ] Add single update coordinator lock
- [ ] Ensure MCP updater and supervisor updater cannot apply concurrently
- [ ] Resume safely from persisted state after crash/restart

### 2.3 Deterministic host-mode restart behavior
- [ ] Task mode: stage -> controlled exit -> apply helper -> scheduler restart
- [ ] Service mode: coordinated stop -> swap -> start -> verify

---

## Phase 3 — Rollback and Verification Hardening

### 3.1 MCP update rollback
- [ ] Persist last-known-good MCP version
- [ ] Add post-update health verification window
- [ ] Auto-rollback on verification failure

### 3.2 Supervisor binary rollback
- [ ] Keep previous binary backup
- [ ] Detect repeated startup failures after self-update
- [ ] Auto-restore previous binary and mark update state failed

### 3.3 Keeper continuity guarantees
- [ ] Verify startup re-sync always reattaches keepAlive thread keepers after supervisor restart
- [ ] Add test coverage for restart + keeper rehydration path

---

## Phase 4 — Reliability Testing Matrix

### 4.1 Failure injection tests
- [ ] Crash after `staged`
- [ ] Crash during `applying`
- [ ] Crash before `restarting`
- [ ] Crash during `verifying`

### 4.2 Deployment mode tests
- [ ] Scheduled task mode end-to-end (user context + SecureVault)
- [ ] Service mode end-to-end (Windows VPS profile)
- [ ] Update + rollback in both modes

### 4.3 CI checks
- [ ] Add/update test jobs for new update-state and host-mode logic
- [ ] Keep existing SecureVault Go package CI green after supervisor-side changes

---

## Design Constraints (Must Keep)

- [x] Do not remove Windows Service support
- [x] Keep SecureVault user-context compatibility for local machine operation
- [x] Keep autonomous thread keeper model and rehydration behavior
- [x] Avoid direct runtime git pull; use release artifacts/metadata only
- [ ] Guarantee single-writer update orchestration with persisted state
- [ ] Guarantee rollback path for failed updates

---

## Immediate Next Step (Recommended)

- [ ] Implement Phase 1 only (host mode + scheduled task installer) as a small safe slice
- [ ] Run dogfooding locally for 24h
- [ ] Then implement Phase 2 state machine with tests
