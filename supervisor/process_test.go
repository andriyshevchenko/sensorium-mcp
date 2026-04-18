package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadPIDFile_JSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.pid")
	os.WriteFile(path, []byte(`{"pid":12345}`), 0644)

	pid, err := ReadPIDFile(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pid != 12345 {
		t.Errorf("got %d, want 12345", pid)
	}
}

func TestReadPIDFile_RawInt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.pid")
	os.WriteFile(path, []byte("54321\n"), 0644)

	pid, err := ReadPIDFile(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pid != 54321 {
		t.Errorf("got %d, want 54321", pid)
	}
}

func TestReadPIDFile_Invalid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.pid")
	os.WriteFile(path, []byte("not-a-pid"), 0644)

	_, err := ReadPIDFile(path)
	if err == nil {
		t.Fatal("expected error for invalid PID content")
	}
}

func TestReadPIDFile_Missing(t *testing.T) {
	_, err := ReadPIDFile(filepath.Join(t.TempDir(), "missing.pid"))
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestAtomicWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.txt")

	if err := atomicWrite(path, []byte("hello")); err != nil {
		t.Fatalf("atomicWrite failed: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("got %q, want %q", string(data), "hello")
	}
}

func TestUpsertEnv_ReplacesExistingAndAppendsMissing(t *testing.T) {
	env := []string{"A=1", "B=2"}

	env = upsertEnv(env, "B", "updated")
	if env[1] != "B=updated" {
		t.Fatalf("expected existing key to be replaced, got %q", env[1])
	}

	env = upsertEnv(env, "C", "3")
	if env[len(env)-1] != "C=3" {
		t.Fatalf("expected missing key to be appended, got %q", env[len(env)-1])
	}
}
