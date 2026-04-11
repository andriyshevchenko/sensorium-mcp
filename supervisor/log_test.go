package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogRotation(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "test.log")

	l := &Logger{
		logPath: logPath,
		maxSize: 100, // tiny threshold for test
		maxKeep: 2,
	}
	l.openFile()
	defer l.Close()

	// Write enough lines to trigger multiple rotations
	for i := 0; i < 50; i++ {
		l.Info("line %d: %s", i, strings.Repeat("x", 20))
	}

	// Current log should exist and be under maxSize
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatalf("log file missing: %v", err)
	}
	if info.Size() >= 100 {
		t.Errorf("log file should have been rotated, size=%d", info.Size())
	}

	// At least .1 should exist
	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Error("expected .1 rotated file to exist")
	}

	// .3 should NOT exist (maxKeep=2)
	if _, err := os.Stat(logPath + ".3"); err == nil {
		t.Error("expected .3 file to not exist (maxKeep=2)")
	}
}
