package main

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestResolveSecretWithKeyring_EnvWins(t *testing.T) {
	t.Setenv("MCP_HTTP_SECRET", "env-secret")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		return "keyring-secret", nil
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveSecretWithKeyring("MCP_HTTP_SECRET", "sensorium-supervisor")
	if got != "env-secret" {
		t.Fatalf("resolveSecretWithKeyring() = %q, want %q", got, "env-secret")
	}
}

func TestResolveSecretWithKeyring_FallbackToKeyring(t *testing.T) {
	t.Setenv("MCP_HTTP_SECRET", "")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		if service != "sensorium-supervisor" {
			t.Fatalf("service = %q, want %q", service, "sensorium-supervisor")
		}
		if user != "MCP_HTTP_SECRET" {
			t.Fatalf("user = %q, want %q", user, "MCP_HTTP_SECRET")
		}
		return "keyring-secret", nil
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveSecretWithKeyring("MCP_HTTP_SECRET", "sensorium-supervisor")
	if got != "keyring-secret" {
		t.Fatalf("resolveSecretWithKeyring() = %q, want %q", got, "keyring-secret")
	}
}

func TestResolveSecretWithKeyring_NotFound(t *testing.T) {
	t.Setenv("MCP_HTTP_SECRET", "")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		return "", keyring.ErrNotFound
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveSecretWithKeyring("MCP_HTTP_SECRET", "sensorium-supervisor")
	if got != "" {
		t.Fatalf("resolveSecretWithKeyring() = %q, want empty", got)
	}
}

func TestResolveSecretWithKeyring_OtherError(t *testing.T) {
	t.Setenv("MCP_HTTP_SECRET", "")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		return "", errors.New("keyring backend unavailable")
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveSecretWithKeyring("MCP_HTTP_SECRET", "sensorium-supervisor")
	if got != "" {
		t.Fatalf("resolveSecretWithKeyring() = %q, want empty", got)
	}
}

func TestResolveIntWithKeyring_EnvWins(t *testing.T) {
	t.Setenv("MCP_HTTP_PORT", "3847")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		return "9999", nil
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveIntWithKeyring("MCP_HTTP_PORT", "sensorium-supervisor", 0)
	if got != 3847 {
		t.Fatalf("resolveIntWithKeyring() = %d, want %d", got, 3847)
	}
}

func TestResolveIntWithKeyring_FallbackToKeyring(t *testing.T) {
	t.Setenv("MCP_HTTP_PORT", "")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		return "5001", nil
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveIntWithKeyring("MCP_HTTP_PORT", "sensorium-supervisor", 0)
	if got != 5001 {
		t.Fatalf("resolveIntWithKeyring() = %d, want %d", got, 5001)
	}
}

func TestResolveIntWithKeyring_InvalidFallback(t *testing.T) {
	t.Setenv("MCP_HTTP_PORT", "")

	orig := keyringGet
	keyringGet = func(service, user string) (string, error) {
		return "not-a-number", nil
	}
	t.Cleanup(func() { keyringGet = orig })

	got := resolveIntWithKeyring("MCP_HTTP_PORT", "sensorium-supervisor", 3847)
	if got != 3847 {
		t.Fatalf("resolveIntWithKeyring() = %d, want fallback %d", got, 3847)
	}
}
