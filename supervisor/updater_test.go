package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVerifyUpdatedMCPServerReady_FailureSetsFailedStateAndNoSuccessMessage(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	cfg := Config{
		DataDir: dir,
		Paths: Paths{
			UpdateState: filepath.Join(dir, "update-state.json"),
		},
	}

	u := NewUpdater(cfg, NewMCPClient(1, ""), log)
	u.state = NewUpdateStateStore(cfg.Paths.UpdateState, log)

	origNotify := notifyUpdaterOperator
	origPoll := mcpUpdateReadyPollInterval
	origTimeout := mcpUpdateReadyTimeout
	defer func() {
		notifyUpdaterOperator = origNotify
		mcpUpdateReadyPollInterval = origPoll
		mcpUpdateReadyTimeout = origTimeout
	}()

	mcpUpdateReadyPollInterval = 1 * time.Millisecond
	mcpUpdateReadyTimeout = 5 * time.Millisecond

	var messages []string
	notifyUpdaterOperator = func(_ Config, _ *Logger, text string, _ int) {
		messages = append(messages, text)
	}

	ok := u.verifyUpdatedMCPServerReady(context.Background(), "2.0.0", "1.0.0", 4242)
	if ok {
		t.Fatal("expected verification to fail")
	}

	state, err := u.state.Load()
	if err != nil {
		t.Fatalf("load update state: %v", err)
	}
	if state.Phase != updatePhaseFailed {
		t.Fatalf("state phase = %q, want %q", state.Phase, updatePhaseFailed)
	}
	if !strings.Contains(state.LastError, "did not become ready") {
		t.Fatalf("last error = %q, want readiness failure detail", state.LastError)
	}
	if len(messages) == 0 {
		t.Fatal("expected failure notification message")
	}
	if strings.Contains(messages[len(messages)-1], "complete") {
		t.Fatalf("unexpected success message: %q", messages[len(messages)-1])
	}
}
