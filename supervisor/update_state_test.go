package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUpdateStateStore_TransitionAndLoad(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	store := NewUpdateStateStore(filepath.Join(dir, "update-state.json"), log)
	store.Transition(updateScopeMCP, updatePhaseApplying, "2.0.0", "1.0.0", "")

	state, err := store.Load()
	if err != nil {
		t.Fatalf("Load() after applying transition failed: %v", err)
	}
	if state.Scope != updateScopeMCP {
		t.Fatalf("Scope = %q, want %q", state.Scope, updateScopeMCP)
	}
	if state.Phase != updatePhaseApplying {
		t.Fatalf("Phase = %q, want %q", state.Phase, updatePhaseApplying)
	}
	if state.TargetVersion != "2.0.0" {
		t.Fatalf("TargetVersion = %q, want 2.0.0", state.TargetVersion)
	}
	if state.PreviousVersion != "1.0.0" {
		t.Fatalf("PreviousVersion = %q, want 1.0.0", state.PreviousVersion)
	}
	if !state.UpdatedAt.UTC().Equal(state.UpdatedAt) {
		t.Fatal("UpdatedAt must be UTC")
	}

	store.Transition(updateScopeMCP, updatePhaseFailed, "2.0.0", "1.0.0", "boom")
	state, err = store.Load()
	if err != nil {
		t.Fatalf("Load() after failed transition failed: %v", err)
	}
	if state.Phase != updatePhaseFailed {
		t.Fatalf("Phase = %q, want %q", state.Phase, updatePhaseFailed)
	}
	if state.LastError != "boom" {
		t.Fatalf("LastError = %q, want boom", state.LastError)
	}

	store.Transition(updateScopeMCP, updatePhaseIdle, "2.0.0", "1.0.0", "")
	state, err = store.Load()
	if err != nil {
		t.Fatalf("Load() after idle transition failed: %v", err)
	}
	if state.Phase != updatePhaseIdle {
		t.Fatalf("Phase = %q, want %q", state.Phase, updatePhaseIdle)
	}
	if state.LastError != "" {
		t.Fatalf("LastError = %q, want empty", state.LastError)
	}
}

func TestAcquireUpdateCoordinatorLock_SerializesScopes(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	lockPath := filepath.Join(dir, "update-apply.lock")

	mcpLock, ok := AcquireUpdateCoordinatorLock(lockPath, updateScopeMCP, log)
	if !ok || mcpLock == nil {
		t.Fatal("expected MCP scope lock acquisition to succeed")
	}

	supervisorLock, ok := AcquireUpdateCoordinatorLock(lockPath, updateScopeSupervisor, log)
	if ok || supervisorLock != nil {
		t.Fatal("expected supervisor scope lock acquisition to fail while MCP lock is held")
	}

	mcpLock.Release()

	supervisorLock, ok = AcquireUpdateCoordinatorLock(lockPath, updateScopeSupervisor, log)
	if !ok || supervisorLock == nil {
		t.Fatal("expected supervisor scope lock acquisition to succeed after release")
	}
	supervisorLock.Release()
}

type fakeUpdateLockFile struct {
	writeErr error
	closeErr error
}

func (f *fakeUpdateLockFile) Write(_ []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return 1, nil
}

func (f *fakeUpdateLockFile) Close() error {
	return f.closeErr
}

func TestWriteUpdateLockMetadata_CleansUpOnWriteError(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "update-apply.lock")
	if err := os.WriteFile(lockPath, []byte("partial"), 0644); err != nil {
		t.Fatalf("seed lock file: %v", err)
	}

	originalOpen := openUpdateLockFile
	defer func() { openUpdateLockFile = originalOpen }()
	openUpdateLockFile = func(string) (updateLockFile, error) {
		return &fakeUpdateLockFile{writeErr: errors.New("write fail")}, nil
	}

	err := writeUpdateLockMetadata(lockPath, []byte(`{"pid":1}`))
	if err == nil {
		t.Fatal("expected writeUpdateLockMetadata to fail")
	}
	if _, statErr := os.Stat(lockPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("expected lock file to be removed after write error, statErr=%v", statErr)
	}
}

func TestWriteUpdateLockMetadata_CleansUpOnCloseError(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "update-apply.lock")
	if err := os.WriteFile(lockPath, []byte("partial"), 0644); err != nil {
		t.Fatalf("seed lock file: %v", err)
	}

	originalOpen := openUpdateLockFile
	defer func() { openUpdateLockFile = originalOpen }()
	openUpdateLockFile = func(string) (updateLockFile, error) {
		return &fakeUpdateLockFile{closeErr: errors.New("close fail")}, nil
	}

	err := writeUpdateLockMetadata(lockPath, []byte(`{"pid":1}`))
	if err == nil {
		t.Fatal("expected writeUpdateLockMetadata to fail")
	}
	if _, statErr := os.Stat(lockPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("expected lock file to be removed after close error, statErr=%v", statErr)
	}
}

func TestAcquireUpdateCoordinatorLock_ReclaimsWhenOwnerDead(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	lockPath := filepath.Join(dir, "update-apply.lock")
	owner := updateLockOwner{
		Scope:     updateScopeMCP,
		PID:       999999,
		UpdatedAt: time.Now().UTC(),
	}
	data, _ := json.Marshal(owner)
	if err := os.WriteFile(lockPath, data, 0644); err != nil {
		t.Fatalf("seed lock owner: %v", err)
	}

	lock, ok := AcquireUpdateCoordinatorLock(lockPath, updateScopeSupervisor, log)
	if !ok || lock == nil {
		t.Fatal("expected lock to be reclaimed for dead owner PID")
	}
	lock.Release()
}

func TestAcquireUpdateCoordinatorLock_DoesNotReclaimFromAliveOwnerEvenWhenStaleByAge(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	lockPath := filepath.Join(dir, "update-apply.lock")
	owner := updateLockOwner{
		Scope:     updateScopeMCP,
		PID:       os.Getpid(),
		UpdatedAt: time.Now().UTC().Add(-updateCoordinatorLockMaxAge - time.Minute),
	}
	data, _ := json.Marshal(owner)
	if err := os.WriteFile(lockPath, data, 0644); err != nil {
		t.Fatalf("seed lock owner: %v", err)
	}

	lock, ok := AcquireUpdateCoordinatorLock(lockPath, updateScopeSupervisor, log)
	if ok || lock != nil {
		t.Fatal("expected lock acquisition to fail while alive owner still holds lock")
	}

	raw, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("read original lock: %v", err)
	}
	var current updateLockOwner
	if err := json.Unmarshal(raw, &current); err != nil {
		t.Fatalf("unmarshal lock owner: %v", err)
	}
	if current.Scope != updateScopeMCP {
		t.Fatalf("scope = %q, want %q", current.Scope, updateScopeMCP)
	}
	if current.PID != os.Getpid() {
		t.Fatalf("pid = %d, want %d", current.PID, os.Getpid())
	}
}

func TestRecoverPersistedUpdateStateOnStartup_StaleNonIdleBecomesFailed(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	cfg := Config{Paths: Paths{UpdateState: filepath.Join(dir, "update-state.json")}}
	store := NewUpdateStateStore(cfg.Paths.UpdateState, log)
	store.Transition(updateScopeMCP, updatePhaseApplying, "2.0.0", "1.0.0", "")

	recoverPersistedUpdateStateOnStartup(cfg, log)

	state, err := store.Load()
	if err != nil {
		t.Fatalf("load recovered state: %v", err)
	}
	if state.Phase != updatePhaseFailed {
		t.Fatalf("phase = %q, want %q", state.Phase, updatePhaseFailed)
	}
	if state.Scope != updateScopeMCP {
		t.Fatalf("scope = %q, want %q", state.Scope, updateScopeMCP)
	}
	if state.LastError == "" {
		t.Fatal("expected recovery reason in LastError")
	}
}

func TestRecoverPersistedUpdateStateOnStartup_SupervisorRestartingReachesIdleWhenVersionApplied(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	target := "2.0.0"
	cfg := Config{Paths: Paths{
		UpdateState:       filepath.Join(dir, "update-state.json"),
		SupervisorVersion: filepath.Join(dir, "supervisor-version.txt"),
	}}
	if err := os.WriteFile(cfg.Paths.SupervisorVersion, []byte(target), 0644); err != nil {
		t.Fatalf("seed supervisor version: %v", err)
	}

	store := NewUpdateStateStore(cfg.Paths.UpdateState, log)
	store.Transition(updateScopeSupervisor, updatePhaseRestarting, target, "1.0.0", "")

	recoverPersistedUpdateStateOnStartup(cfg, log)

	state, err := store.Load()
	if err != nil {
		t.Fatalf("load recovered state: %v", err)
	}
	if state.Scope != updateScopeSupervisor {
		t.Fatalf("scope = %q, want %q", state.Scope, updateScopeSupervisor)
	}
	if state.Phase != updatePhaseIdle {
		t.Fatalf("phase = %q, want %q", state.Phase, updatePhaseIdle)
	}
	if state.TargetVersion != target {
		t.Fatalf("target version = %q, want %q", state.TargetVersion, target)
	}
}

func TestRecoverPersistedUpdateStateOnStartup_SupervisorFailedReachesIdleWhenVersionApplied(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	target := "2.1.0"
	cfg := Config{Paths: Paths{
		UpdateState:       filepath.Join(dir, "update-state.json"),
		SupervisorVersion: filepath.Join(dir, "supervisor-version.txt"),
	}}
	if err := os.WriteFile(cfg.Paths.SupervisorVersion, []byte(target), 0644); err != nil {
		t.Fatalf("seed supervisor version: %v", err)
	}

	store := NewUpdateStateStore(cfg.Paths.UpdateState, log)
	store.Transition(updateScopeSupervisor, updatePhaseFailed, target, "2.0.0", "previous helper failure")

	recoverPersistedUpdateStateOnStartup(cfg, log)

	state, err := store.Load()
	if err != nil {
		t.Fatalf("load recovered state: %v", err)
	}
	if state.Scope != updateScopeSupervisor {
		t.Fatalf("scope = %q, want %q", state.Scope, updateScopeSupervisor)
	}
	if state.Phase != updatePhaseIdle {
		t.Fatalf("phase = %q, want %q", state.Phase, updatePhaseIdle)
	}
	if state.TargetVersion != target {
		t.Fatalf("target version = %q, want %q", state.TargetVersion, target)
	}
	if state.LastError != "" {
		t.Fatalf("last error = %q, want empty", state.LastError)
	}
}
