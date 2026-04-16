package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	updateScopeMCP        = "mcp"
	updateScopeSupervisor = "supervisor"

	// A coordinator lock older than this is treated as stale metadata for
	// diagnostics, but age never overrides live-owner safety.
	updateCoordinatorLockMaxAge = 10 * time.Minute

	updatePhaseIdle       = "idle"
	updatePhaseStaged     = "staged"
	updatePhaseApplying   = "applying"
	updatePhaseRestarting = "restarting"
	updatePhaseVerifying  = "verifying"
	updatePhaseRollback   = "rollback"
	updatePhaseFailed     = "failed"
)

type UpdateState struct {
	Scope           string    `json:"scope"`
	Phase           string    `json:"phase"`
	TargetVersion   string    `json:"targetVersion"`
	PreviousVersion string    `json:"previousVersion"`
	UpdatedAt       time.Time `json:"updatedAt"`
	LastError       string    `json:"lastError"`
}

type UpdateStateStore struct {
	path string
	log  *Logger
}

func NewUpdateStateStore(path string, log *Logger) *UpdateStateStore {
	return &UpdateStateStore{path: path, log: log}
}

func (s *UpdateStateStore) Load() (UpdateState, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return UpdateState{Phase: updatePhaseIdle, UpdatedAt: time.Now().UTC()}, nil
		}
		return UpdateState{}, err
	}

	var state UpdateState
	if err := json.Unmarshal(data, &state); err != nil {
		return UpdateState{}, err
	}
	if state.Phase == "" {
		state.Phase = updatePhaseIdle
	}
	return state, nil
}

func (s *UpdateStateStore) Save(state UpdateState) error {
	if state.UpdatedAt.IsZero() {
		state.UpdatedAt = time.Now().UTC()
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return fmt.Errorf("create update state dir: %w", err)
	}

	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal update state: %w", err)
	}
	if err := atomicWrite(s.path, data); err != nil {
		return fmt.Errorf("write update state: %w", err)
	}
	return nil
}

func (s *UpdateStateStore) Transition(scope, phase, targetVersion, previousVersion, lastError string) {
	state := UpdateState{
		Scope:           scope,
		Phase:           phase,
		TargetVersion:   targetVersion,
		PreviousVersion: previousVersion,
		UpdatedAt:       time.Now().UTC(),
		LastError:       lastError,
	}
	if err := s.Save(state); err != nil {
		s.log.Warn("Failed to persist update state (scope=%s phase=%s): %v", scope, phase, err)
	}
}

type updateLockOwner struct {
	Scope     string    `json:"scope"`
	PID       int       `json:"pid"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type UpdateCoordinatorLock struct {
	path  string
	scope string
	log   *Logger
}

type updateLockFile interface {
	Write([]byte) (int, error)
	Close() error
}

var openUpdateLockFile = func(lockPath string) (updateLockFile, error) {
	return os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
}

func writeUpdateLockMetadata(lockPath string, payload []byte) error {
	f, err := openUpdateLockFile(lockPath)
	if err != nil {
		return err
	}

	if _, err := f.Write(payload); err != nil {
		closeErr := f.Close()
		_ = os.Remove(lockPath)
		if closeErr != nil {
			return errors.Join(fmt.Errorf("write lock metadata: %w", err), fmt.Errorf("close lock file after write failure: %w", closeErr))
		}
		return fmt.Errorf("write lock metadata: %w", err)
	}

	if err := f.Close(); err != nil {
		_ = os.Remove(lockPath)
		return fmt.Errorf("close lock metadata file: %w", err)
	}

	return nil
}

func AcquireUpdateCoordinatorLock(lockPath, scope string, log *Logger) (*UpdateCoordinatorLock, bool) {
	owner := updateLockOwner{Scope: scope, PID: os.Getpid(), UpdatedAt: time.Now().UTC()}
	payload, _ := json.Marshal(owner)

	err := writeUpdateLockMetadata(lockPath, payload)
	if err == nil {
		log.Debug("Update coordinator lock acquired by %s", scope)
		return &UpdateCoordinatorLock{path: lockPath, scope: scope, log: log}, true
	}

	if !errors.Is(err, os.ErrExist) {
		log.Warn("Failed to acquire update coordinator lock %s: %v", lockPath, err)
		return nil, false
	}

	data, readErr := os.ReadFile(lockPath)
	if readErr != nil {
		log.Warn("Update coordinator lock exists but could not be read (%s): %v", lockPath, readErr)
		return nil, false
	}

	var holder updateLockOwner
	if json.Unmarshal(data, &holder) == nil {
		lockAge := time.Since(holder.UpdatedAt)
		alive := holder.PID > 0 && IsProcessAlive(holder.PID)
		staleByAge := !holder.UpdatedAt.IsZero() && lockAge > updateCoordinatorLockMaxAge

		if alive {
			holderScope := holder.Scope
			if holderScope == "" {
				holderScope = "unknown"
			}
			ageNote := ""
			if staleByAge {
				ageNote = fmt.Sprintf("; stale metadata age %v exceeds %v", lockAge.Round(time.Second), updateCoordinatorLockMaxAge)
			}
			log.Info("Skipping %s update apply: coordinator lock held by %s (PID %d, age %v%s)", scope, holderScope, holder.PID, lockAge.Round(time.Second), ageNote)
			return nil, false
		}

		holderScope := holder.Scope
		if holderScope == "" {
			holderScope = "unknown"
		}
		reason := "owner PID not alive"
		if staleByAge {
			reason = fmt.Sprintf("owner PID not alive (metadata age %v exceeds %v)", lockAge.Round(time.Second), updateCoordinatorLockMaxAge)
		}
		log.Warn("Reclaiming update coordinator lock for %s: previous owner=%s pid=%d (%s)", scope, holderScope, holder.PID, reason)
	}

	_ = os.Remove(lockPath)
	err = writeUpdateLockMetadata(lockPath, payload)
	if err != nil {
		log.Warn("Failed to reclaim update coordinator lock %s: %v", lockPath, err)
		return nil, false
	}
	log.Warn("Reclaimed stale update coordinator lock for %s", scope)
	return &UpdateCoordinatorLock{path: lockPath, scope: scope, log: log}, true
}

func (l *UpdateCoordinatorLock) Release() {
	if l == nil {
		return
	}
	_ = os.Remove(l.path)
	l.log.Debug("Update coordinator lock released by %s", l.scope)
}

func recoverPersistedUpdateStateOnStartup(cfg Config, log *Logger) {
	store := NewUpdateStateStore(cfg.Paths.UpdateState, log)
	state, err := store.Load()
	if err != nil {
		log.Warn("Failed to load persisted update state for startup recovery: %v", err)
		return
	}

	scope := state.Scope
	if scope == "" {
		scope = updateScopeMCP
	}

	if scope == updateScopeSupervisor {
		currentVersion := readTrimmedFile(cfg.Paths.SupervisorVersion)
		targetVersion := strings.TrimSpace(state.TargetVersion)
		if targetVersion != "" && currentVersion == targetVersion && state.Phase != updatePhaseIdle {
			log.Info("Startup recovery: supervisor update %s already applied locally; transitioning state to idle", targetVersion)
			store.Transition(updateScopeSupervisor, updatePhaseIdle, targetVersion, state.PreviousVersion, "")
			return
		}
	}

	if state.Phase == "" || state.Phase == updatePhaseIdle || state.Phase == updatePhaseFailed {
		return
	}

	if !isRecoverableStartupPhase(state.Phase) {
		return
	}

	reason := fmt.Sprintf("startup recovery: stale non-idle update state detected (%s/%s)", scope, state.Phase)
	log.Warn("%s", reason)
	store.Transition(scope, updatePhaseFailed, state.TargetVersion, state.PreviousVersion, reason)
}

func isRecoverableStartupPhase(phase string) bool {
	switch phase {
	case updatePhaseApplying, updatePhaseRestarting, updatePhaseVerifying, updatePhaseStaged:
		return true
	default:
		return false
	}
}

func readTrimmedFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
