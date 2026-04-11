package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const registryURL = "https://registry.npmjs.org/sensorium-mcp/latest"

// Updater checks the npm registry for new versions and performs updates.
type Updater struct {
	cfg     Config
	mcp     *MCPClient
	log     *Logger
	startAt time.Time
	cancel  context.CancelFunc
	done    chan struct{}
}

func NewUpdater(cfg Config, mcp *MCPClient, log *Logger) *Updater {
	return &Updater{
		cfg:     cfg,
		mcp:     mcp,
		log:     log,
		startAt: time.Now(),
		done:    make(chan struct{}),
	}
}

// Start begins the update check loop.
func (u *Updater) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	u.cancel = cancel
	go u.run(ctx)
}

// Stop signals the updater to shut down and waits.
func (u *Updater) Stop() {
	if u.cancel != nil {
		u.cancel()
	}
	<-u.done
}

func (u *Updater) run(ctx context.Context) {
	defer close(u.done)
	u.log.Info("Updater started (mode=%s)", u.cfg.Mode)

	// In development mode, check every PollInterval.
	// In production, check once per day at PollAtHour.
	for {
		var sleepDuration time.Duration
		if u.cfg.Mode == "development" {
			sleepDuration = u.cfg.PollInterval
		} else {
			sleepDuration = u.timeUntilNextPoll()
		}
		u.log.Debug("Updater: next version check in %v", sleepDuration.Round(time.Second))

		select {
		case <-ctx.Done():
			return
		case <-time.After(sleepDuration):
		}

		if ctx.Err() != nil {
			return
		}

		u.checkAndUpdate(ctx)
	}
}

func (u *Updater) timeUntilNextPoll() time.Duration {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), u.cfg.PollAtHour, 0, 0, 0, now.Location())
	if next.Before(now) {
		next = next.Add(24 * time.Hour)
	}
	return time.Until(next)
}

// getRemoteVersion fetches the latest version from npm registry.
func (u *Updater) getRemoteVersion(ctx context.Context) (string, error) {
	ctx2, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx2, "GET", registryURL, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("npm registry HTTP %d", resp.StatusCode)
	}

	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pkg); err != nil {
		return "", err
	}
	return pkg.Version, nil
}

// getLocalVersion reads the current version from the version file.
func (u *Updater) getLocalVersion() string {
	data, err := os.ReadFile(u.cfg.Paths.VersionFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (u *Updater) setLocalVersion(v string) {
	os.MkdirAll(u.cfg.DataDir, 0755)
	if err := atomicWrite(u.cfg.Paths.VersionFile, []byte(v)); err != nil {
		u.log.Warn("Failed to write version file: %v", err)
	}
}

func (u *Updater) checkAndUpdate(ctx context.Context) {
	// Enforce minimum uptime before updating
	uptime := time.Since(u.startAt)
	if uptime < u.cfg.MinUptime {
		u.log.Info("Deferring update — too early (uptime %v < %v)", uptime.Round(time.Second), u.cfg.MinUptime)
		return
	}

	remote, err := u.getRemoteVersion(ctx)
	if err != nil {
		u.log.Warn("Failed to check npm registry: %v", err)
		return
	}

	local := u.getLocalVersion()
	if local == "" {
		u.log.Info("No local version recorded — storing %s", remote)
		u.setLocalVersion(remote)
		return
	}

	if local == remote {
		u.log.Debug("Updater: version %s is up to date", local)
		return
	}

	u.log.Info("Update available: %s → %s", local, remote)
	NotifyOperator(u.cfg, u.log, fmt.Sprintf("⚙️ Supervisor: updating sensorium v%s → v%s. Grace period %v...", local, remote, u.cfg.GracePeriod), 0)

	// Grace period
	u.log.Info("Grace period %v...", u.cfg.GracePeriod)
	select {
	case <-ctx.Done():
		return
	case <-time.After(u.cfg.GracePeriod):
	}

	// Set maintenance flag — always clean up on exit
	if err := atomicWrite(u.cfg.Paths.MaintenanceFlag, []byte(time.Now().Format(time.RFC3339))); err != nil {
		u.log.Warn("Failed to write maintenance flag: %v", err)
	}
	defer os.Remove(u.cfg.Paths.MaintenanceFlag)

	// Kill the current MCP server
	if ctx.Err() != nil {
		return
	}
	u.killServer()

	// Clean npx cache
	if ctx.Err() != nil {
		return
	}
	u.clearNpxCache()

	// Spawn new server — retry up to 3 times on failure
	var pid int
	for attempt := 1; attempt <= 3; attempt++ {
		if ctx.Err() != nil {
			return
		}
		pid, err = SpawnMCPServer(u.cfg, u.log)
		if err == nil {
			break
		}
		u.log.Error("Failed to spawn updated MCP server (attempt %d/3): %v", attempt, err)
		if attempt < 3 {
			time.Sleep(2 * time.Second)
		}
	}
	if err != nil {
		u.log.Error("All spawn attempts failed — server is down!")
		NotifyOperator(u.cfg, u.log, "🔴 Supervisor: update FAILED — server is down! Manual intervention required.", 0)
		return
	}

	// Wait for new server to be ready
	if u.mcp.WaitForReady(ctx, 3*time.Second, 60*time.Second) {
		u.log.Info("Updated MCP server ready (PID %d)", pid)
	} else {
		u.log.Warn("Updated server did not become ready in 60s")
	}

	u.setLocalVersion(remote)

	NotifyOperator(u.cfg, u.log, fmt.Sprintf("✅ Supervisor: update to v%s complete. Server ready.", remote), 0)
	u.log.Info("Update complete: v%s → v%s", local, remote)

	// Reset start time for min uptime tracking
	u.startAt = time.Now()
}

func (u *Updater) killServer() {
	u.log.Info("Updater: stopping current MCP server for update")
	pid, err := ReadPIDFile(u.cfg.Paths.ServerPID)
	if err != nil {
		u.log.Warn("Could not read server PID file: %v", err)
		// Try killing by port as fallback
		KillByPort(u.cfg.MCPHttpPort, u.log)
		return
	}
	if err := KillProcess(pid, u.log); err != nil {
		u.log.Error("Failed to kill server (PID %d): %v", pid, err)
		KillByPort(u.cfg.MCPHttpPort, u.log)
	}
}

// clearNpxCache removes the cached sensorium-mcp package from the npx cache
// so the next `npx -y sensorium-mcp@latest` fetches the new version.
func (u *Updater) clearNpxCache() {
	u.log.Info("Updater: clearing npx cache")
	var base string
	if runtime.GOOS == "windows" {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			home, _ := os.UserHomeDir()
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		base = filepath.Join(localAppData, "npm-cache", "_npx")
	} else {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".npm", "_npx")
	}

	u.log.Info("Clearing sensorium-mcp from npx cache (%s)", base)

	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pkgDir := filepath.Join(base, e.Name(), "node_modules", "sensorium-mcp")
		// Validate path doesn't escape base directory
		if !strings.HasPrefix(pkgDir, base) {
			continue
		}
		if _, err := os.Stat(pkgDir); err == nil {
			if err := os.RemoveAll(pkgDir); err != nil {
				u.log.Warn("Failed to clear npx cache entry %s: %v", pkgDir, err)
			}
		}
	}
}
