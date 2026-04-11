package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAcquireLock_Fresh(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "test.lock")
	log := NewLogger("")

	if !AcquireLock(lockPath, log) {
		t.Fatal("expected lock acquisition to succeed")
	}
	defer ReleaseLock(lockPath)

	// Verify lock file was created with our PID
	data, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("lock file not created: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("lock file is empty")
	}
}

func TestAcquireLock_StalePID(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "test.lock")
	log := NewLogger("")

	// Write a stale lock with PID 1 (guaranteed to not be a supervisor)
	// Use PID 99999999 which is almost certainly not running
	os.WriteFile(lockPath, []byte("99999999"), 0644)

	if !AcquireLock(lockPath, log) {
		t.Fatal("expected stale lock to be reclaimed")
	}
	defer ReleaseLock(lockPath)
}

func TestReleaseLock(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "test.lock")
	os.WriteFile(lockPath, []byte("12345"), 0644)

	ReleaseLock(lockPath)

	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Error("expected lock file to be removed")
	}
}
