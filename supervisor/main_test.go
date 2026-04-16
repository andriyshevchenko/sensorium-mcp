package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveRunSupervisorMode(t *testing.T) {
	tests := []struct {
		name             string
		processIsService bool
		hostMode         string
		want             bool
	}{
		{
			name:             "service process always forces service mode",
			processIsService: true,
			hostMode:         "task",
			want:             true,
		},
		{
			name:             "non-service defaults to task mode",
			processIsService: false,
			hostMode:         "",
			want:             false,
		},
		{
			name:             "non-service task remains task mode",
			processIsService: false,
			hostMode:         "task",
			want:             false,
		},
		{
			name:             "non-service service mode is honored",
			processIsService: false,
			hostMode:         "service",
			want:             true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveRunSupervisorMode(tc.processIsService, tc.hostMode)
			if got != tc.want {
				t.Fatalf("resolveRunSupervisorMode(processIsService=%v, hostMode=%q) = %v, want %v", tc.processIsService, tc.hostMode, got, tc.want)
			}
		})
	}
}

func TestRunSupervisor_DoesNotRecoverPersistedStateWhenWatcherLockNotAcquired(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("USERPROFILE", tempHome)
	t.Setenv("HOME", tempHome)
	t.Setenv("MCP_HTTP_PORT", "7777")
	t.Setenv("MCP_HTTP_SECRET", "test-secret")
	t.Setenv("TELEGRAM_TOKEN", "test-token")
	t.Setenv("TELEGRAM_CHAT_ID", "test-chat")

	dataDir := filepath.Join(tempHome, ".remote-copilot-mcp")
	log := NewLogger(filepath.Join(dataDir, "test.log"))
	defer log.Close()

	store := NewUpdateStateStore(filepath.Join(dataDir, "update-state.json"), log)
	store.Transition(updateScopeMCP, updatePhaseApplying, "2.0.0", "1.0.0", "")

	watcherLock := filepath.Join(dataDir, "watcher.lock")
	if !AcquireLock(watcherLock, log) {
		t.Fatal("failed to pre-acquire watcher lock")
	}
	defer ReleaseLock(watcherLock)

	err := runSupervisor(false)
	if err == nil {
		t.Fatal("expected runSupervisor to fail when watcher lock is already held")
	}
	if !strings.Contains(err.Error(), "another supervisor instance") {
		t.Fatalf("unexpected error: %v", err)
	}

	state, loadErr := store.Load()
	if loadErr != nil {
		t.Fatalf("failed to load update state: %v", loadErr)
	}
	if state.Phase != updatePhaseApplying {
		t.Fatalf("phase = %q, want %q", state.Phase, updatePhaseApplying)
	}
}

func TestRunSupervisor_DoesNotApplyPendingSupervisorUpdateWhenWatcherLockNotAcquired(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("USERPROFILE", tempHome)
	t.Setenv("HOME", tempHome)
	t.Setenv("MCP_HTTP_PORT", "7777")
	t.Setenv("MCP_HTTP_SECRET", "test-secret")
	t.Setenv("TELEGRAM_TOKEN", "test-token")
	t.Setenv("TELEGRAM_CHAT_ID", "test-chat")

	dataDir := filepath.Join(tempHome, ".remote-copilot-mcp")
	log := NewLogger(filepath.Join(dataDir, "test.log"))
	defer log.Close()

	pendingVersion := filepath.Join(dataDir, "bin", "sensorium-supervisor.new.exe.version")
	if err := os.MkdirAll(filepath.Dir(pendingVersion), 0755); err != nil {
		t.Fatalf("failed to create pending version directory: %v", err)
	}
	if err := os.WriteFile(pendingVersion, []byte("2.0.0"), 0644); err != nil {
		t.Fatalf("failed to create stale pending version file: %v", err)
	}

	watcherLock := filepath.Join(dataDir, "watcher.lock")
	if !AcquireLock(watcherLock, log) {
		t.Fatal("failed to pre-acquire watcher lock")
	}
	defer ReleaseLock(watcherLock)

	err := runSupervisor(false)
	if err == nil {
		t.Fatal("expected runSupervisor to fail when watcher lock is already held")
	}
	if !strings.Contains(err.Error(), "another supervisor instance") {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, statErr := os.Stat(pendingVersion); statErr != nil {
		t.Fatalf("pending supervisor version file was unexpectedly modified: %v", statErr)
	}
}
