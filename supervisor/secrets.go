package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/zalando/go-keyring"
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
