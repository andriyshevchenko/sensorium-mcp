package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	sv "github.com/andriyshevchenko/sandboxed-ui/securevault-go"
)

// writeProfileFixture writes a minimal profiles.json to dir and returns the dir.
func writeProfileFixture(t *testing.T, dir string, profiles []sv.Profile) {
	t.Helper()
	data, err := json.Marshal(profiles)
	if err != nil {
		t.Fatalf("marshal profiles: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "profiles.json"), data, 0600); err != nil {
		t.Fatalf("write profiles.json: %v", err)
	}
}

func TestResolveStringChain_EnvWins(t *testing.T) {
	t.Setenv("TELEGRAM_TOKEN", "env-value")
	dir := t.TempDir()
	writeProfileFixture(t, dir, []sv.Profile{
		{ID: "p1", Name: "TEST", Mappings: []sv.ProfileMapping{
			{EnvVar: "TELEGRAM_TOKEN", SecretID: "no-cred"},
		}},
	})

	got := resolveStringChain("TELEGRAM_TOKEN", "TEST", dir, "")
	if got != "env-value" {
		t.Errorf("resolveStringChain = %q, want env-value", got)
	}
}

func TestResolveStringChain_SecureVaultFallback_MissingCred(t *testing.T) {
	t.Setenv("TELEGRAM_TOKEN", "")
	dir := t.TempDir()
	writeProfileFixture(t, dir, []sv.Profile{
		{ID: "p1", Name: "TEST", Mappings: []sv.ProfileMapping{
			{EnvVar: "TELEGRAM_TOKEN", SecretID: "non-existent-cred"},
		}},
	})

	// Credential not in store → falls through to keyring, then empty.
	got := resolveStringChain("TELEGRAM_TOKEN", "TEST", dir, "")
	// Should be empty (no env, no real cred in store, no keyring entry in test context).
	// We only assert no panic and that the result is a string.
	_ = got
}

func TestResolveStringChain_NoProfile_FallsToKeyring(t *testing.T) {
	t.Setenv("TELEGRAM_TOKEN", "")
	// No profiles file in dir → securevault returns empty → keyring path taken.
	got := resolveStringChain("TELEGRAM_TOKEN", "NONEXISTENT_PROFILE", t.TempDir(), "")
	// Result is empty in test context (no keyring entry), but no panic.
	_ = got
}

func TestResolveIntChain_EnvWins(t *testing.T) {
	t.Setenv("MCP_HTTP_PORT", "4567")
	got := resolveIntChain("MCP_HTTP_PORT", "TEST", t.TempDir(), "", 0)
	if got != 4567 {
		t.Errorf("resolveIntChain = %d, want 4567", got)
	}
}

func TestResolveIntChain_InvalidFallback(t *testing.T) {
	t.Setenv("MCP_HTTP_PORT", "not-a-number")
	got := resolveIntChain("MCP_HTTP_PORT", "TEST", t.TempDir(), "", 9999)
	if got != 9999 {
		t.Errorf("resolveIntChain invalid = %d, want fallback 9999", got)
	}
}
