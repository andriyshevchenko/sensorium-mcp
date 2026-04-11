package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// AcquireLock creates a lock file to prevent multiple supervisor instances.
// Uses O_CREATE|O_EXCL for atomic creation. If a stale lock exists (PID not
// running), it reclaims the lock.
func AcquireLock(lockPath string, log *Logger) bool {
	// Try atomic create first
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err == nil {
		// Lock acquired — write our PID
		fmt.Fprintf(f, "%d", os.Getpid())
		f.Close()
		log.Info("Lock acquired: %s (PID %d)", lockPath, os.Getpid())
		return true
	}

	// Lock file exists — check if the PID is still alive
	data, err := os.ReadFile(lockPath)
	if err != nil {
		log.Error("Failed to read lockfile %s: %v", lockPath, err)
		return false
	}

	pidStr := strings.TrimSpace(string(data))
	pid, err := strconv.Atoi(pidStr)
	if err == nil && pid > 0 && IsProcessAlive(pid) {
		log.Error("Another supervisor is running (PID %d). Lockfile: %s", pid, lockPath)
		return false
	}

	// Stale lock — reclaim
	log.Warn("Reclaimed stale supervisor lockfile (old PID %s)", pidStr)
	_ = os.Remove(lockPath)

	// Re-acquire atomically
	f, err = os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		log.Error("Failed to acquire lockfile after reclaim: %v", err)
		return false
	}
	fmt.Fprintf(f, "%d", os.Getpid())
	f.Close()
	return true
}

// ReleaseLock removes the lock file.
func ReleaseLock(lockPath string) {
	_ = os.Remove(lockPath)
}
