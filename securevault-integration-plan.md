# SecureVault Go Package + User-Scoped Supervisor Plan

## Summary

Two parallel goals:
1. Add a standalone Go package to `C:\src\SecureVault` (`securevault-go/`) that reads SecureVault profiles and resolves secrets via Windows Credential Manager — no CGo, no HTTP server dependency.
2. Change `SensoriumSupervisor` in this repo from `LocalSystem` to a user-scoped service account that matches the account where SecureVault credentials are stored.

---

## Phase 1 — SecureVault Go Package (`securevault-go/`)

### 1.1 Create Go module
- [ ] Create `securevault-go/go.mod` with module `github.com/andriyshevchenko/sandboxed-ui/securevault-go`
- [ ] Add `golang.org/x/sys` dependency (Windows Credential Manager via pure syscall, no CGo)

### 1.2 Core types (`securevault-go/securevault.go`)
- [ ] Define `ProfileMapping` struct — `{ EnvVar, SecretID string }`
- [ ] Define `Profile` struct — `{ ID, Name string; Mappings []ProfileMapping; CreatedAt, UpdatedAt int64 }`
- [ ] Define `SecretMetadata` struct — `{ ID, Title string; Category SecretCategory; Notes string; CreatedAt, UpdatedAt int64 }`
- [ ] Define `SecretCategory` type and constants (`password`, `api-key`, `token`, `certificate`, `note`, `other`)
- [ ] Add sentinel `ErrNotFound` error

### 1.3 Store + file resolvers
- [ ] `NewStore(baseDir string) *Store` — empty `baseDir` defaults to `%LOCALAPPDATA%\SecureVault`
- [ ] `(s *Store) ProfilesPath() (string, error)` — returns absolute path to `profiles.json`
- [ ] `(s *Store) LoadProfiles() ([]Profile, error)` — reads and parses `profiles.json`; returns `[]` if missing
- [ ] `(s *Store) MetadataPath() (string, error)` — returns absolute path to `metadata.json`
- [ ] `(s *Store) LoadMetadata() ([]SecretMetadata, error)` — reads and parses `metadata.json`; returns `[]` if missing

### 1.4 Credential Manager access (`securevault-go/credential_windows.go` + stub `credential_other.go`)
- [ ] `CredentialTarget(secretID string) string` — returns `"SecureVault/<secretID>"`
- [ ] `GetSecretValue(secretID string) (string, error)` — calls `CredReadW`/`CredFreeW` via `golang.org/x/sys/windows`; returns `ErrNotFound` if absent
- [ ] Stub for non-Windows with `ErrUnsupportedPlatform`

### 1.5 High-level resolver
- [ ] `(s *Store) ResolveProfile(profileName string) (map[string]string, error)` — finds profile by name, resolves all `envVar->secretId` mappings; silently skips missing credentials (match server behaviour); returns error only on I/O failure
- [ ] `(s *Store) ResolveKey(profileName, envVar string) (string, error)` — resolves a single env var from a named profile

### 1.6 Unit tests (no real keychain)
- [ ] `store_test.go` — test `LoadProfiles` / `LoadMetadata` with temp JSON fixture files
- [ ] `credential_test.go` — test `CredentialTarget` naming convention
- [ ] `resolve_test.go` — test `ResolveProfile` mapping, missing-secret skip behaviour, non-existent profile error

### 1.7 Expert review Phase 1
- [ ] Run expert review subagent on `securevault-go/`

---

## Phase 2 — CI for Go Package in SecureVault repo

### 2.1 Add `test-go` job to `.github/workflows/ci.yml`
- [ ] Runs on `windows-latest` (Credential Manager APIs are Windows-only)
- [ ] Steps: checkout, Go 1.22, `go test ./securevault-go/...`
- [ ] Skips CGo (`CGO_ENABLED=0`)

### 2.2 Expert review Phase 2
- [ ] Run expert review subagent on workflow changes

---

## Phase 3 — Integrate Go Package Into Supervisor (`remote-copilot-mcp`)

### 3.1 Add Go module dependency
- [ ] Add `github.com/andriyshevchenko/sandboxed-ui/securevault-go` to `supervisor/go.mod`
- [ ] Run `go mod tidy`

### 3.2 Wire SecureVault into secret resolution chain
- [ ] Add `SUPERVISOR_SECUREVAULT_PROFILE` config field and env var to `supervisor/config.go`
- [ ] Add `resolveFromSecureVault(profileName, envKey, storeBaseDir string) string` to `supervisor/secrets.go`
- [ ] Resolution chain: env var → SecureVault profile → OS keyring → empty string
- [ ] Warn on SecureVault I/O errors; silently pass through missing keys (no hard fail)

### 3.3 Tests
- [ ] Add `secrets_securevault_test.go` — test full resolution chain with mock Store

### 3.4 Expert review Phase 3
- [ ] Run expert review subagent on supervisor integration

---

## Phase 4 — Make Supervisor User-Scoped

### 4.1 Update `supervisor/service_windows.go`
- [ ] Accept optional `ServiceUser` and `ServicePassword` in `mgr.CreateService`
- [ ] Default: run under the current interactive user (use `WhoAmI`/`GetUserName`)

### 4.2 Update `supervisor/main.go`
- [ ] Add `-service-user` and `-service-password` flags for `install` command
- [ ] Pass resolved values to service creation

### 4.3 Update `Install-Sensorium.ps1`
- [ ] Add `$ServiceUser` parameter (default: `$env:USERDOMAIN\$env:USERNAME`)
- [ ] Add `$ServicePassword` parameter (SecureString prompt if not supplied)
- [ ] Pass `obj= $ServiceUser password= $ServicePassword` to `sc.exe create`
- [ ] Document "Log on as a service" right requirement in help comment

### 4.4 Update docs
- [ ] `README.md` — add recommended install path (user-scoped) and note about `Log on as a service` right
- [ ] `ARCHITECTURE.md` — update service identity section if present

### 4.5 Expert review Phase 4
- [ ] Run expert review subagent on user-scoped service changes

---

## Phase 5 — Final Integration Validation

- [ ] Rebuild supervisor binary: `scripts/install-supervisor.ps1 -Force`
- [ ] Run all supervisor Go tests: `go test ./...` in `supervisor/`
- [ ] Run all SecureVault Go tests: `go test ./securevault-go/...`
- [ ] Run `Install-Sensorium.ps1` with new user-scoped install path
- [ ] Verify service starts, reads SecureVault profile, and MCP endpoint responds
- [ ] Final expert review subagent across both repos

---

## Key Technical Constraints

| Constraint | Detail |
|---|---|
| No CGo | Go package uses `golang.org/x/sys/windows` syscall wrappers only |
| Credential target format | `SecureVault/<secretId>` with `CRED_TYPE_GENERIC`, `CRED_PERSIST_ENTERPRISE` |
| Profile store path | `%LOCALAPPDATA%\SecureVault\profiles.json` |
| Resolution chain | env var → SecureVault profile → OS keyring → empty |
| Service identity | Must match user where SecureVault credentials were created |
| Windows-only implementations | Build-tag-guarded; non-Windows stubs return `ErrUnsupportedPlatform` |
