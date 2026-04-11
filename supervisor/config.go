package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config holds all supervisor configuration, sourced from environment variables
// with sensible defaults matching the TypeScript watcher-service.ts CONFIG object.
type Config struct {
	// Watcher
	Mode              string
	PollAtHour        int
	PollInterval      time.Duration
	GracePeriod       time.Duration
	MinUptime         time.Duration
	MCPStartCommand   string
	DataDir           string
	MCPHttpPort       int
	MCPHttpSecret     string
	TelegramToken     string
	TelegramChatID    string
	HealthFailThresh  int

	// Keeper defaults
	KeeperBaseBackoff        time.Duration
	KeeperMaxBackoff         time.Duration
	KeeperHealthCheckInterval time.Duration
	KeeperMaxRetries         int
	KeeperCooldown           time.Duration
	KeeperReadyPollInterval  time.Duration
	KeeperReadyTimeout       time.Duration
	FastExitThreshold        time.Duration
	FastExitMaxCount         int
	FastExitBaseCooldown     time.Duration
	FastExitMaxCooldown      time.Duration
	StuckThreshold           time.Duration

	// Derived paths
	Paths Paths
}

// Paths holds all filesystem paths derived from DataDir.
type Paths struct {
	MaintenanceFlag string
	VersionFile     string
	LastActivity    string
	ServerPID       string
	WatcherLock     string
	WatcherLog      string
	PIDsDir         string
	HeartbeatsDir   string
}

func LoadConfig() Config {
	dataDir := filepath.Join(homeDir(), ".remote-copilot-mcp")

	mode := envOr("WATCHER_MODE", "development")
	graceDef := "300"
	if mode == "development" {
		graceDef = "10"
	}

	c := Config{
		Mode:              mode,
		PollAtHour:        envInt("WATCHER_POLL_HOUR", 4),
		PollInterval:      time.Duration(envInt("WATCHER_POLL_INTERVAL", 60)) * time.Second,
		GracePeriod:       time.Duration(envInt("WATCHER_GRACE_PERIOD", safeAtoi(graceDef))) * time.Second,
		MinUptime:         600 * time.Second,
		MCPStartCommand:   envOr("MCP_START_COMMAND", "npx -y sensorium-mcp@latest"),
		DataDir:           dataDir,
		MCPHttpPort:       envInt("MCP_HTTP_PORT", 0),
		MCPHttpSecret:     os.Getenv("MCP_HTTP_SECRET"),
		TelegramToken:     os.Getenv("TELEGRAM_TOKEN"),
		TelegramChatID:    os.Getenv("TELEGRAM_CHAT_ID"),
		HealthFailThresh:  3,

		KeeperBaseBackoff:        5 * time.Second,
		KeeperMaxBackoff:         5 * time.Minute,
		KeeperHealthCheckInterval: 2 * time.Minute,
		KeeperMaxRetries:         5,
		KeeperCooldown:           5 * time.Minute,
		KeeperReadyPollInterval:  3 * time.Second,
		KeeperReadyTimeout:       2 * time.Minute,
		FastExitThreshold:        60 * time.Second,
		FastExitMaxCount:         3,
		FastExitBaseCooldown:     10 * time.Minute,
		FastExitMaxCooldown:      4 * time.Hour,
		StuckThreshold:           10 * time.Minute,

		Paths: Paths{
			MaintenanceFlag: filepath.Join(dataDir, "maintenance.flag"),
			VersionFile:     filepath.Join(dataDir, "current-version.txt"),
			LastActivity:    filepath.Join(dataDir, "last-activity.txt"),
			ServerPID:       filepath.Join(dataDir, "server.pid"),
			WatcherLock:     filepath.Join(dataDir, "watcher.lock"),
			WatcherLog:      filepath.Join(dataDir, "watcher.log"),
			PIDsDir:         filepath.Join(dataDir, "pids"),
			HeartbeatsDir:   filepath.Join(dataDir, "heartbeats"),
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

func safeAtoi(s string) int {
	v, _ := strconv.Atoi(s)
	return v
}
