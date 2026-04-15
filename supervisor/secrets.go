package main

import (
	"errors"
	"fmt"
	"os"

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
