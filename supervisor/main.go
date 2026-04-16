package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	globalCancelMu sync.Mutex
	globalCancel   context.CancelFunc
)

// KeeperEntry tracks a running keeper and its settings.
type KeeperEntry struct {
	keeper   *Keeper
	settings KeeperConfig
}

func main() {
	isService, err := isWindowsService()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to detect service mode: %v\n", err)
		os.Exit(1)
	}
	if isService {
		if err := runAsService(); err != nil {
			fmt.Fprintf(os.Stderr, "Service run failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if handled, err := handleServiceCommand(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	} else if handled {
		return
	}

	if err := runSupervisor(); err != nil {
		fmt.Fprintf(os.Stderr, "Supervisor failed: %v\n", err)
		os.Exit(1)
	}
}

func handleServiceCommand(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}

	switch args[0] {
	case "install":
		fs := flag.NewFlagSet("install", flag.ContinueOnError)
		serviceUser := fs.String("service-user", "", "Windows account to run service as (e.g. .\\YourUser). Defaults to LocalSystem if empty.")
		servicePassword := fs.String("service-password", "", "Password for the service account (required for regular user accounts; not needed for LocalSystem/LocalService/NetworkService, NT SERVICE\\*, or gMSA names ending with '$').")
		if err := fs.Parse(args[1:]); err != nil {
			return true, err
		}
		if *serviceUser != "" && *servicePassword == "" && !isPasswordlessServiceIdentity(*serviceUser) {
			return true, fmt.Errorf("install failed: -service-password is required for regular -service-user accounts\nAllowed passwordless identities: LocalSystem/LocalService/NetworkService, NT SERVICE\\*, and gMSA names ending with '$'\nNote: prefer using Install-Sensorium.ps1, which prompts securely for passwords")
		}
		exePath, err := os.Executable()
		if err != nil {
			return true, fmt.Errorf("install failed: resolve executable: %w", err)
		}
		return true, installService(exePath, *serviceUser, *servicePassword)
	case "uninstall":
		return true, uninstallService()
	case "start":
		return true, startService()
	case "stop":
		return true, stopService()
	case "status":
		return true, serviceStatus()
	default:
		return false, nil
	}
}

func isPasswordlessServiceIdentity(user string) bool {
	trimmed := strings.TrimSpace(user)
	if trimmed == "" {
		return false
	}

	lower := strings.ToLower(trimmed)
	switch lower {
	case "localsystem", "nt authority\\system", "localservice", "nt authority\\localservice", "networkservice", "nt authority\\networkservice":
		return true
	}

	if strings.HasPrefix(lower, "nt service\\") {
		return true
	}

	return strings.HasSuffix(trimmed, "$")
}

func stopSupervisor() {
	globalCancelMu.Lock()
	fn := globalCancel
	globalCancelMu.Unlock()
	if fn != nil {
		fn()
	}
}

func runSupervisor() error {
	cfg := LoadConfig()

	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return fmt.Errorf("cannot create data dir %s: %w", cfg.DataDir, err)
	}

	log := NewLogger(cfg.Paths.WatcherLog)
	defer log.Close()

	shouldRestart, err := applyPendingSupervisorUpdate(cfg, log)
	if err != nil {
		log.Warn("Pending supervisor update could not be applied: %v", err)
	}
	if shouldRestart {
		return nil
	}

	log.Info("sensorium-supervisor starting (mode=%s, port=%d, dataDir=%s)", cfg.Mode, cfg.MCPHttpPort, cfg.DataDir)
	log.Debug("Config: MCPStartCommand=%q, PollInterval=%v, MinUptime=%v, KeeperMaxRetries=%d", cfg.MCPStartCommand, cfg.PollInterval, cfg.MinUptime, cfg.KeeperMaxRetries)
	log.Debug("Config: TelegramToken=%v, HealthFailThresh=%d, StuckThreshold=%v", cfg.TelegramToken != "", cfg.HealthFailThresh, cfg.StuckThreshold)

	if err := os.MkdirAll(cfg.Paths.PIDsDir, 0755); err != nil {
		log.Warn("Cannot create PIDs dir %s: %v", cfg.Paths.PIDsDir, err)
	}
	if err := os.MkdirAll(cfg.Paths.HeartbeatsDir, 0755); err != nil {
		log.Warn("Cannot create heartbeats dir %s: %v", cfg.Paths.HeartbeatsDir, err)
	}

	// Acquire lock — prevent multiple instances
	if !AcquireLock(cfg.Paths.WatcherLock, log) {
		return fmt.Errorf("another supervisor instance is already running")
	}
	defer ReleaseLock(cfg.Paths.WatcherLock)

	if cfg.MCPHttpPort <= 0 {
		log.Error("MCP_HTTP_PORT must be set (got %d)", cfg.MCPHttpPort)
		return fmt.Errorf("MCP_HTTP_PORT must be set (got %d)", cfg.MCPHttpPort)
	}

	mcp := NewMCPClient(cfg.MCPHttpPort, cfg.MCPHttpSecret)
	mcp.Log = log

	// Clean stale PID files from previous runs
	CleanStalePIDs(cfg.Paths.PIDsDir, log)

	// Kill orphan process on our port
	KillByPort(cfg.MCPHttpPort, log)

	// Spawn MCP server
	_, err = SpawnMCPServer(cfg, log)
	if err != nil {
		log.Error("Failed to start MCP server: %v", err)
		return fmt.Errorf("failed to start MCP server: %w", err)
	}

	// Wait for server to be ready
	ctx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()
	globalCancelMu.Lock()
	globalCancel = rootCancel
	globalCancelMu.Unlock()
	defer func() {
		globalCancelMu.Lock()
		globalCancel = nil
		globalCancelMu.Unlock()
	}()

	if mcp.WaitForReady(ctx, 3*time.Second, cfg.KeeperReadyTimeout) {
		log.Info("MCP server is ready")
	} else {
		log.Warn("MCP server did not become ready in %v — proceeding anyway", cfg.KeeperReadyTimeout)
	}

	// Start keeper management
	var mu sync.Mutex
	keepers := make(map[int]*KeeperEntry)

	onDeath := func(threadID int, sessionName string) {
		log.Warn("Thread %d ('%s') died", threadID, sessionName)
		NotifyOperator(cfg, log, fmt.Sprintf("💀 <b>%s</b> session died — restarting…", sessionName), threadID)
	}

	syncKeepers := func() {
		if cfg.MCPHttpPort <= 0 {
			log.Debug("syncKeepers: skipped (no port configured)")
			return
		}

		log.Debug("syncKeepers: fetching keeper settings...")
		settings, err := fetchKeeperSettings(ctx, mcp, log)
		if err != nil {
			log.Warn("Failed to fetch keeper settings: %v", err)
			return
		}
		log.Debug("syncKeepers: got %d keeper configs", len(settings))

		mu.Lock()
		defer mu.Unlock()

		// Find keepers to remove (no longer in settings)
		wanted := make(map[int]bool)
		for _, s := range settings {
			wanted[s.ThreadID] = true
		}
		for tid, entry := range keepers {
			if !wanted[tid] {
				log.Info("Stopping keeper for removed thread %d", tid)
				entry.keeper.Stop()
				delete(keepers, tid)
			}
		}

		// Start or update keepers
		for _, s := range settings {
			existing, exists := keepers[s.ThreadID]
			if exists && settingsChanged(existing.settings, s) {
				log.Info("Settings changed for thread %d — restarting keeper", s.ThreadID)
				existing.keeper.Stop()
				delete(keepers, s.ThreadID)
				exists = false
			}
			if !exists {
				k := NewKeeper(s, cfg, mcp, log, onDeath)
				k.Start()
				keepers[s.ThreadID] = &KeeperEntry{keeper: k, settings: s}
				log.Info("Started keeper for thread %d ('%s')", s.ThreadID, s.SessionName)
			}
		}
	}

	// Initial sync
	log.Info("Running initial keeper sync")
	syncKeepers()

	// Keeper settings poller (every 2 min)
	keeperPollerDone := make(chan struct{})
	go func() {
		defer close(keeperPollerDone)
		ticker := time.NewTicker(2 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				log.Debug("Keeper settings poll triggered")
				syncKeepers()
			}
		}
	}()

	// Start updater
	log.Info("Starting auto-updater")
	updater := NewUpdater(cfg, mcp, log)
	updater.Start()

	// Health check loop for the server process itself
	healthDone := make(chan struct{})
	go func() {
		defer close(healthDone)
		consecutiveFails := 0
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if mcp.IsServerReady(ctx) {
					if consecutiveFails > 0 {
						log.Info("Server health check recovered (was at %d fails)", consecutiveFails)
					}
					consecutiveFails = 0
				} else {
					consecutiveFails++
					log.Warn("Server health check failed (%d/%d)", consecutiveFails, cfg.HealthFailThresh)
					if consecutiveFails >= cfg.HealthFailThresh {
						log.Error("Server unresponsive after %d consecutive failures — restarting", consecutiveFails)
						NotifyOperator(cfg, log, "⚠️ Supervisor: server process not running — restarting...", 0)

						// Kill and respawn
						pid, pidErr := ReadPIDFile(cfg.Paths.ServerPID)
						if pidErr != nil {
							log.Warn("Could not read server PID file: %v", pidErr)
						}
						if pid > 0 {
							_ = KillProcess(pid, log)
						}
						KillByPort(cfg.MCPHttpPort, log)

						if _, err := SpawnMCPServer(cfg, log); err != nil {
							log.Error("Failed to respawn server: %v", err)
						}
						consecutiveFails = 0
					}
				}
			}
		}
	}()

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	log.Info("All subsystems started — supervisor is running (PID %d)", os.Getpid())

	select {
	case sig := <-sigCh:
		log.Info("Received %s — shutting down", sig)
		rootCancel()
	case <-ctx.Done():
		log.Info("Shutdown requested")
	}

	// Stop keepers (with 10s timeout)
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	mu.Lock()
	var wg sync.WaitGroup
	for _, entry := range keepers {
		wg.Add(1)
		go func(k *Keeper) {
			defer wg.Done()
			k.Stop()
		}(entry.keeper)
	}
	mu.Unlock()

	doneCh := make(chan struct{})
	go func() { wg.Wait(); close(doneCh) }()
	select {
	case <-doneCh:
		log.Info("All keepers stopped")
	case <-shutdownCtx.Done():
		log.Warn("Keeper shutdown timed out after 10s")
	}

	// Stop updater
	updater.Stop()

	// Wait for background goroutines
	<-keeperPollerDone
	<-healthDone

	// Kill server process
	pid, err := ReadPIDFile(cfg.Paths.ServerPID)
	if err == nil && pid > 0 {
		log.Info("Stopping MCP server (PID %d)", pid)
		_ = KillProcess(pid, log)
	}

	log.Info("Supervisor stopped cleanly")
	return nil
}

// fetchKeeperSettings reads all keepAlive threads from the MCP server
// (root, branch, and daily — excludes worker threads).
func fetchKeeperSettings(ctx context.Context, mcp *MCPClient, log *Logger) ([]KeeperConfig, error) {
	roots, err := mcp.GetKeepAliveThreads(ctx)
	if err != nil {
		return nil, err
	}

	var result []KeeperConfig
	for _, r := range roots {
		keepAlive, _ := r["keepAlive"].(bool)
		if !keepAlive {
			continue
		}

		// Skip non-active roots (archived, expired, exited)
		if status, _ := r["status"].(string); status != "" && status != "active" {
			continue
		}

		tidFloat, _ := r["threadId"].(float64) // JSON numbers decode as float64
		tid := int(tidFloat)
		if tid <= 0 {
			continue
		}

		client := "claude"
		if c, ok := r["client"].(string); ok && c != "" {
			client = c
		}

		sessionName := ""
		if n, ok := r["name"].(string); ok {
			sessionName = n
		}

		maxRetries := 5
		if mr, ok := r["maxRetries"].(float64); ok {
			maxRetries = int(mr)
		}

		cooldownMs := 300_000
		if cd, ok := r["cooldownMs"].(float64); ok {
			cooldownMs = int(cd)
		}

		workDir := ""
		if wd, ok := r["workingDirectory"].(string); ok {
			workDir = wd
		}

		result = append(result, KeeperConfig{
			ThreadID:         tid,
			SessionName:      sessionName,
			Client:           client,
			WorkingDirectory: workDir,
			MaxRetries:       maxRetries,
			CooldownMs:       cooldownMs,
		})
	}
	return result, nil
}

func settingsChanged(a, b KeeperConfig) bool {
	return a.MaxRetries != b.MaxRetries ||
		a.CooldownMs != b.CooldownMs ||
		a.Client != b.Client ||
		a.SessionName != b.SessionName ||
		a.WorkingDirectory != b.WorkingDirectory
}
