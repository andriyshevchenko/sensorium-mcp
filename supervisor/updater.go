package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const supervisorReleaseURL = "https://api.github.com/repos/andriyshevchenko/remote-copilot-mcp/releases/tags/supervisor-latest"

var notifyUpdaterOperator = NotifyOperator

// Updater checks the npm registry for new versions and performs updates.
type Updater struct {
	cfg     Config
	mcp     *MCPClient
	log     *Logger
	state   *UpdateStateStore
	startAt time.Time
	cancel  context.CancelFunc
	done    chan struct{}
}

func NewUpdater(cfg Config, mcp *MCPClient, log *Logger) *Updater {
	return &Updater{
		cfg:     cfg,
		mcp:     mcp,
		log:     log,
		state:   NewUpdateStateStore(cfg.Paths.UpdateState, log),
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

		u.checkSupervisorUpdate(ctx)
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

type githubRelease struct {
	TagName string `json:"tag_name"`
	Name    string `json:"name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

func (u *Updater) getSupervisorRelease(ctx context.Context) (string, string, error) {
	ctx2, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx2, http.MethodGet, supervisorReleaseURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "sensorium-supervisor-updater")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("GitHub releases HTTP %d", resp.StatusCode)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", "", err
	}

	assetName := supervisorAssetName()
	for _, asset := range release.Assets {
		if asset.Name != assetName {
			continue
		}

		version := strings.TrimSpace(release.Name)
		if version == "" {
			version = strings.TrimSpace(release.TagName)
		}
		if version == "" {
			return "", "", fmt.Errorf("release version missing for %s", assetName)
		}
		if strings.TrimSpace(asset.URL) == "" {
			return "", "", fmt.Errorf("release asset URL missing for %s", assetName)
		}

		return version, asset.URL, nil
	}

	return "", "", fmt.Errorf("release asset %q not found", assetName)
}

func supervisorAssetName() string {
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	return fmt.Sprintf("sensorium-supervisor-%s-%s%s", runtime.GOOS, runtime.GOARCH, suffix)
}

func (u *Updater) getLocalSupervisorVersion() string {
	data, err := os.ReadFile(u.cfg.Paths.SupervisorVersion)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (u *Updater) setLocalSupervisorVersion(v string) {
	os.MkdirAll(u.cfg.DataDir, 0755)
	if err := atomicWrite(u.cfg.Paths.SupervisorVersion, []byte(v)); err != nil {
		u.log.Warn("Failed to write supervisor version file: %v", err)
	}
}

func (u *Updater) stagePendingSupervisorVersion(v string) error {
	if err := os.MkdirAll(filepath.Dir(u.cfg.Paths.PendingVersion), 0755); err != nil {
		return fmt.Errorf("create pending supervisor version dir: %w", err)
	}
	if err := atomicWrite(u.cfg.Paths.PendingVersion, []byte(v)); err != nil {
		return fmt.Errorf("write pending supervisor version: %w", err)
	}
	return nil
}

func (u *Updater) checkSupervisorUpdate(ctx context.Context) {
	uptime := time.Since(u.startAt)
	if uptime < u.cfg.MinUptime {
		u.log.Info("Deferring supervisor update — too early (uptime %v < %v)", uptime.Round(time.Second), u.cfg.MinUptime)
		return
	}

	remote, downloadURL, err := u.getSupervisorRelease(ctx)
	if err != nil {
		u.log.Warn("Failed to check supervisor release: %v", err)
		return
	}

	local := u.getLocalSupervisorVersion()
	if local == "" {
		u.log.Info("No local supervisor version recorded — storing %s", remote)
		u.setLocalSupervisorVersion(remote)
		return
	}

	if local == remote {
		u.log.Debug("Supervisor updater: version %s is up to date", local)
		return
	}

	u.log.Info("Supervisor update available: %s → %s", local, remote)
	coordLock, ok := AcquireUpdateCoordinatorLock(u.cfg.Paths.UpdateApplyLock, updateScopeSupervisor, u.log)
	if !ok {
		u.log.Info("Deferring supervisor binary update %s → %s due to active update apply lock", local, remote)
		return
	}
	defer coordLock.Release()

	markFailed := func(err error) {
		u.state.Transition(updateScopeSupervisor, updatePhaseFailed, remote, local, err.Error())
	}

	notifyUpdaterOperator(u.cfg, u.log, fmt.Sprintf("⚙️ Supervisor: updating supervisor binary %s → %s. Grace period %v. Supervisor process will restart — MCP server unaffected.", local, remote, u.cfg.GracePeriod), 0)

	select {
	case <-ctx.Done():
		markFailed(ctx.Err())
		return
	case <-time.After(u.cfg.GracePeriod):
	}

	if err := u.downloadSupervisorBinary(ctx, downloadURL); err != nil {
		markFailed(err)
		u.log.Error("Supervisor binary download failed: %v", err)
		notifyUpdaterOperator(u.cfg, u.log, fmt.Sprintf("🔴 Supervisor: supervisor binary update to %s failed during download.", remote), 0)
		return
	}

	if err := u.stagePendingSupervisorVersion(remote); err != nil {
		_ = os.Remove(u.cfg.Paths.PendingBinary)
		markFailed(err)
		u.log.Error("Failed to stage supervisor version %s: %v", remote, err)
		notifyUpdaterOperator(u.cfg, u.log, fmt.Sprintf("🔴 Supervisor: supervisor binary update to %s failed during staging.", remote), 0)
		return
	}
	u.state.Transition(updateScopeSupervisor, updatePhaseStaged, remote, local, "")
	notifyUpdaterOperator(u.cfg, u.log, fmt.Sprintf("⚙️ Supervisor: supervisor binary %s downloaded. Restarting supervisor to apply update — MCP server will continue running.", remote), 0)

	// Reset start time so minimum uptime is re-enforced after restart
	u.startAt = time.Now()

	isService, err := isWindowsService()
	if err != nil {
		markFailed(err)
		u.log.Error("Failed to detect service mode for restart: %v", err)
		notifyUpdaterOperator(u.cfg, u.log, "🔴 Supervisor: supervisor binary downloaded but service detection failed.", 0)
		return
	}
	u.state.Transition(updateScopeSupervisor, updatePhaseRestarting, remote, local, "")

	if isService {
		if err := scheduleServiceRestartForUpdate(u.log); err != nil {
			markFailed(err)
			u.log.Error("Failed to schedule service restart: %v", err)
			notifyUpdaterOperator(u.cfg, u.log, "🔴 Supervisor: supervisor binary downloaded but service restart scheduling failed.", 0)
		}
		return
	}

	if err := requestSupervisorRestart(u.cfg, u.log); err != nil {
		markFailed(err)
		u.log.Error("Failed to signal supervisor for restart: %v", err)
		notifyUpdaterOperator(u.cfg, u.log, "🔴 Supervisor: supervisor binary downloaded but restart signal failed.", 0)
	}
}

func (u *Updater) downloadSupervisorBinary(ctx context.Context, downloadURL string) error {
	if err := os.MkdirAll(u.cfg.Paths.BinaryDir, 0755); err != nil {
		return fmt.Errorf("create binary dir: %w", err)
	}

	tmpPath := u.cfg.Paths.PendingBinary + ".download"
	defer os.Remove(tmpPath)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "sensorium-supervisor-updater")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download HTTP %d", resp.StatusCode)
	}

	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}

	written, copyErr := io.Copy(f, resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written <= 0 {
		return fmt.Errorf("downloaded empty binary")
	}

	if err := os.Remove(u.cfg.Paths.PendingBinary); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(tmpPath, u.cfg.Paths.PendingBinary); err != nil {
		return err
	}

	u.log.Info("Supervisor binary downloaded to %s (%d bytes)", u.cfg.Paths.PendingBinary, written)
	return nil
}

func signalSelf(sig os.Signal) error {
	proc, err := os.FindProcess(os.Getpid())
	if err != nil {
		return err
	}
	return proc.Signal(sig)
}

func requestSupervisorRestart(cfg Config, log *Logger) error {
	if runtime.GOOS != "windows" {
		return signalSelf(syscall.SIGTERM)
	}

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}

	if err := launchWindowsApplyHelper(cfg, exePath, false); err != nil {
		return fmt.Errorf("launch apply helper for restart: %w", err)
	}

	if log != nil {
		log.Info("Apply helper launched — exiting cleanly for binary swap")
	}

	go stopSupervisor()
	return nil
}

func (u *Updater) killServer() {
	u.log.Info("Updater: stopping current MCP server for update")
	pid, err := ReadPIDFile(u.cfg.Paths.ServerPID)
	if err != nil {
		u.log.Warn("Could not read server PID file: %v", err)
		KillByPort(u.cfg.MCPHttpPort, u.log)
		return
	}
	if err := KillProcessDirect(pid, u.log); err != nil {
		u.log.Error("Failed to kill server (PID %d): %v", pid, err)
		KillByPort(u.cfg.MCPHttpPort, u.log)
	}
}

