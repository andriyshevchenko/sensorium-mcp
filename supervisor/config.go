package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config holds all supervisor configuration, sourced from environment variables
// with sensible defaults matching the TypeScript watcher-service.ts CONFIG object.
type Config struct {
	// Watcher
	Mode             string
	PollAtHour       int
	PollInterval     time.Duration
	GracePeriod      time.Duration
	MinUptime        time.Duration
	MCPStartCommand  string
	HostMode         string
	DataDir          string
	MCPHttpPort      int
	MCPHttpSecret    string
	TelegramToken    string
	TelegramChatID   string
	HealthFailThresh int

	// MCP readiness timeout used by WaitForReady at startup
	MCPReadyTimeout time.Duration

	// Derived paths
	Paths Paths
}

// Paths holds all filesystem paths derived from DataDir.
type Paths struct {
	BinaryDir         string
	MaintenanceFlag   string
	VersionFile       string
	SupervisorVersion string
	UpdateState       string
	UpdateApplyLock   string
	PendingBinary     string
	PendingVersion    string
	LastActivity      string
	MCPStderrLog      string
	ServerPID         string
	WatcherLock       string
	WatcherLog        string
	PIDsDir           string
	HeartbeatsDir     string
}

func LoadConfig(runningAsService bool) Config {
	dataDir := filepath.Join(homeDir(), ".remote-copilot-mcp")

	mode := envOr("WATCHER_MODE", "development")
	graceDef := 300
	if mode == "development" {
		graceDef = 10
	}

	c := Config{
		Mode:             mode,
		PollAtHour:       envInt("WATCHER_POLL_HOUR", 4),
		PollInterval:     time.Duration(envInt("WATCHER_POLL_INTERVAL", 60)) * time.Second,
		GracePeriod:      time.Duration(envInt("WATCHER_GRACE_PERIOD", graceDef)) * time.Second,
		MinUptime:        600 * time.Second,
		MCPStartCommand:  envOr("MCP_START_COMMAND", "npx -y sensorium-mcp@latest"),
		HostMode:         parseHostMode(os.Getenv("HOST_MODE"), runningAsService),
		DataDir:          dataDir,
		HealthFailThresh: 3,

		MCPHttpPort:     envInt("MCP_HTTP_PORT", 0),
		MCPHttpSecret:   os.Getenv("MCP_HTTP_SECRET"),
		TelegramToken:   os.Getenv("TELEGRAM_TOKEN"),
		TelegramChatID:  os.Getenv("TELEGRAM_CHAT_ID"),
		MCPReadyTimeout: 2 * time.Minute,

		Paths: Paths{
			BinaryDir:         filepath.Join(dataDir, "bin"),
			MaintenanceFlag:   filepath.Join(dataDir, "maintenance.flag"),
			VersionFile:       filepath.Join(dataDir, "current-version.txt"),
			SupervisorVersion: filepath.Join(dataDir, "supervisor-version.txt"),
			UpdateState:       filepath.Join(dataDir, "update-state.json"),
			UpdateApplyLock:   filepath.Join(dataDir, "update-apply.lock"),
			PendingBinary:     filepath.Join(dataDir, "bin", "sensorium-supervisor.new.exe"),
			PendingVersion:    filepath.Join(dataDir, "bin", "sensorium-supervisor.new.exe.version"),
			LastActivity:      filepath.Join(dataDir, "last-activity.txt"),
			MCPStderrLog:      filepath.Join(dataDir, "mcp-stderr.log"),
			ServerPID:         filepath.Join(dataDir, "server.pid"),
			WatcherLock:       filepath.Join(dataDir, "watcher.lock"),
			WatcherLog:        filepath.Join(dataDir, "watcher.log"),
			PIDsDir:           filepath.Join(dataDir, "pids"),
			HeartbeatsDir:     filepath.Join(dataDir, "heartbeats"),
		},
	}

	return c
}

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: cannot determine home directory: %v\n", err)
		os.Exit(1)
	}
	return h
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	s := os.Getenv(key)
	if s == "" {
		return fallback
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return v
}

func parseHostMode(value string, runningAsService bool) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if runningAsService {
		if normalized == "" || normalized == "service" {
			return "service"
		}
		if normalized == "task" {
			fmt.Fprintf(os.Stderr, "WARN: HOST_MODE=%q ignored because process is running as a Windows service; forcing \"service\"\n", value)
		} else {
			fmt.Fprintf(os.Stderr, "WARN: invalid HOST_MODE=%q ignored because process is running as a Windows service; forcing \"service\" (allowed: task|service)\n", value)
		}
		return "service"
	}

	if normalized == "" {
		return "task"
	}

	switch normalized {
	case "task", "service":
		return normalized
	default:
		fmt.Fprintf(os.Stderr, "WARN: invalid HOST_MODE=%q (allowed: task|service); using default \"task\"\n", value)
		return "task"
	}
}
