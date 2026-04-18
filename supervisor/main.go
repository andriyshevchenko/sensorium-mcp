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

	runningAsService := resolveRunSupervisorMode(isService, os.Getenv("HOST_MODE"))
	if err := runSupervisor(runningAsService); err != nil {
		fmt.Fprintf(os.Stderr, "Supervisor failed: %v\n", err)
		os.Exit(1)
	}
}

func resolveRunSupervisorMode(processIsService bool, hostModeValue string) bool {
	if processIsService {
		return true
	}

	return parseHostMode(hostModeValue, false) == "service"
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

func runSupervisor(runningAsService bool) error {
	cfg := LoadConfig(runningAsService)

	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return fmt.Errorf("cannot create data dir %s: %w", cfg.DataDir, err)
	}

	log := NewLogger(cfg.Paths.WatcherLog)
	defer log.Close()

	// Acquire lock — prevent multiple instances
	if !AcquireLock(cfg.Paths.WatcherLock, log) {
		return fmt.Errorf("another supervisor instance is already running")
	}
	defer ReleaseLock(cfg.Paths.WatcherLock)

	shouldRestart, err := applyPendingSupervisorUpdate(cfg, log)
	if err != nil {
		log.Warn("Pending supervisor update could not be applied: %v", err)
	}
	if shouldRestart {
		return nil
	}

	recoverPersistedUpdateStateOnStartup(cfg, log)

	log.Info("sensorium-supervisor starting (mode=%s, hostMode=%s, port=%d, dataDir=%s)", cfg.Mode, cfg.HostMode, cfg.MCPHttpPort, cfg.DataDir)
	log.Debug("Config: MCPStartCommand=%q, PollInterval=%v, MinUptime=%v", cfg.MCPStartCommand, cfg.PollInterval, cfg.MinUptime)
	log.Debug("Config: TelegramToken=%v, HealthFailThresh=%d, StuckThreshold=%v", cfg.TelegramToken != "", cfg.HealthFailThresh, cfg.StuckThreshold)

	if err := os.MkdirAll(cfg.Paths.PIDsDir, 0755); err != nil {
		log.Warn("Cannot create PIDs dir %s: %v", cfg.Paths.PIDsDir, err)
	}
	if err := os.MkdirAll(cfg.Paths.HeartbeatsDir, 0755); err != nil {
		log.Warn("Cannot create heartbeats dir %s: %v", cfg.Paths.HeartbeatsDir, err)
	}

	if cfg.MCPHttpPort <= 0 {
		log.Error("MCP_HTTP_PORT must be set (got %d)", cfg.MCPHttpPort)
		return fmt.Errorf("MCP_HTTP_PORT must be set (got %d)", cfg.MCPHttpPort)
	}

	mcp := NewMCPClient(cfg.MCPHttpPort, cfg.MCPHttpSecret)
	mcp.Log = log

	// Check if MCP server is already running and healthy — inherit it instead of
	// killing and restarting (allows transparent supervisor binary updates).
	inherited := false
	if oldPid, pidErr := ReadPIDFile(cfg.Paths.ServerPID); pidErr == nil && oldPid > 0 && IsProcessAlive(oldPid) {
		if mcp.IsServerReady(context.Background()) {
			log.Info("Inherited running MCP server (PID %d) — skipping full restart", oldPid)
			inherited = true
		} else {
			log.Info("MCP server process (PID %d) did not pass health check — proceeding with full restart", oldPid)
		}
	}

	if !inherited {
		// Kill orphan thread processes from previous runs, then clean PID files
		KillOrphanThreads(cfg.Paths.PIDsDir, log)

		// Kill orphan MCP server from previous run
		if oldPid, pidErr := ReadPIDFile(cfg.Paths.ServerPID); pidErr == nil && oldPid > 0 && IsProcessAlive(oldPid) {
			log.Info("Killing orphan MCP server (PID %d) from previous run", oldPid)
			_ = KillProcess(oldPid, log)
			time.Sleep(1 * time.Second) // allow port to release
		}
		_ = os.Remove(cfg.Paths.ServerPID)
		KillByPort(cfg.MCPHttpPort, log)

		// Spawn MCP server
		_, err = SpawnMCPServer(cfg, log)
		if err != nil {
			log.Error("Failed to start MCP server: %v", err)
			return fmt.Errorf("failed to start MCP server: %w", err)
		}
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

	// Stop updater
	updater.Stop()

	// Wait for background goroutines
	<-healthDone

	// Ask MCP to write reconnect snapshot before killing it
	mcp.PrepareShutdown(context.Background())

	// Kill server process
	pid, err := ReadPIDFile(cfg.Paths.ServerPID)
	if err == nil && pid > 0 {
		log.Info("Stopping MCP server (PID %d)", pid)
		_ = KillProcess(pid, log)
	}

	log.Info("Supervisor stopped cleanly")
	return nil
}
