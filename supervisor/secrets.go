package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/zalando/go-keyring"

	sv "github.com/andriyshevchenko/sandboxed-ui/securevault-go"
)

const defaultKeyringService = "sensorium-supervisor"

var keyringGet = keyring.Get

// resolveSecretWithKeyring returns environment value first, then keyring fallback.
// If both sources are unavailable, it returns an empty string.
func resolveSecretWithKeyring(envKey, keyringService string) string {
	if v := os.Getenv(envKey); v != "" {
		return v
	}

	if keyringService == "" {
		return ""
	}

	secret, err := keyringGet(keyringService, envKey)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return ""
		}
		fmt.Fprintf(os.Stderr, "WARN: keyring lookup failed for %s (service=%s): %v\n", envKey, keyringService, err)
		return ""
	}
	return secret
}

// resolveIntWithKeyring parses an integer value from env first, then keyring fallback.
// If parsing fails or no value exists, it returns fallback.
func resolveIntWithKeyring(envKey, keyringService string, fallback int) int {
	v := resolveSecretWithKeyring(envKey, keyringService)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN: invalid integer for %s: %q\n", envKey, v)
		return fallback
	}
	return parsed
}

// resolveFromSecureVault looks up envKey in the named SecureVault profile.
// baseDir may be empty (defaults to %LOCALAPPDATA%\SecureVault).
// Returns empty string on any error, with a warning for unexpected failures.
func resolveFromSecureVault(profileName, envKey, baseDir string) string {
	store := sv.NewStore(baseDir)
	val, err := store.ResolveKey(profileName, envKey)
	if err != nil {
		if errors.Is(err, sv.ErrNotFound) || errors.Is(err, sv.ErrUnsupportedPlatform) {
			return ""
		}
		fmt.Fprintf(os.Stderr, "WARN: securevault lookup failed for %s (profile=%s): %v\n", envKey, profileName, err)
		return ""
	}
	return val
}

// resolveStringChain resolves a string config key using the chain:
// environment variable → SecureVault profile → OS keyring → empty string.
func resolveStringChain(envKey, svProfile, svBaseDir, keyringService string) string {
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	if v := resolveFromSecureVault(svProfile, envKey, svBaseDir); v != "" {
		return v
	}
	return resolveSecretWithKeyring(envKey, keyringService)
}

// resolveIntChain resolves an integer config key using the same chain as resolveStringChain.
func resolveIntChain(envKey, svProfile, svBaseDir, keyringService string, fallback int) int {
	v := resolveStringChain(envKey, svProfile, svBaseDir, keyringService)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN: invalid integer for %s: %q\n", envKey, v)
		return fallback
	}
	return parsed
}
