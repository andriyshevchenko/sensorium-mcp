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

func TestListThreadPIDs(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "1234.pid"), []byte(`{"pid":100}`), 0644)
	os.WriteFile(filepath.Join(dir, "5678.pid"), []byte("200"), 0644)
	os.WriteFile(filepath.Join(dir, "not-a-pid.txt"), []byte("300"), 0644)

	result := ListThreadPIDs(dir)
	if len(result) != 2 {
		t.Fatalf("got %d entries, want 2", len(result))
	}
	if result["1234"] != 100 {
		t.Errorf("result[1234] = %d, want 100", result["1234"])
	}
	if result["5678"] != 200 {
		t.Errorf("result[5678] = %d, want 200", result["5678"])
	}
}

func TestListThreadPIDs_MissingDir(t *testing.T) {
	result := ListThreadPIDs(filepath.Join(t.TempDir(), "no-such-dir"))
	if len(result) != 0 {
		t.Errorf("expected empty map for missing directory, got %d entries", len(result))
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
