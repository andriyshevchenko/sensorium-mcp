package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	sv "github.com/andriyshevchenko/SecureVault/securevault-go"
)

// Config holds all supervisor configuration, sourced from environment variables
// with sensible defaults matching the TypeScript watcher-service.ts CONFIG object.
type Config struct {
	// Watcher
	Mode               string
	PollAtHour         int
	PollInterval       time.Duration
	GracePeriod        time.Duration
	MinUptime          time.Duration
	MCPStartCommand    string
	HostMode           string
	DataDir            string
	KeyringService     string
	SecureVaultProfile string
	SecureVaultBaseDir string
	MCPHttpPort        int
	MCPHttpSecret      string
	TelegramToken      string
	TelegramChatID     string
	HealthFailThresh   int
	ResolvedProfileEnv map[string]string

	// Keeper defaults
	KeeperBaseBackoff         time.Duration
	KeeperMaxBackoff          time.Duration
	KeeperHealthCheckInterval time.Duration
	KeeperMaxRetries          int
	KeeperCooldown            time.Duration
	KeeperReadyPollInterval   time.Duration
	KeeperReadyTimeout        time.Duration
	FastExitThreshold         time.Duration
	FastExitMaxCount          int
	FastExitBaseCooldown      time.Duration
	FastExitMaxCooldown       time.Duration
	StuckThreshold            time.Duration

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
		Mode:               mode,
		PollAtHour:         envInt("WATCHER_POLL_HOUR", 4),
		PollInterval:       time.Duration(envInt("WATCHER_POLL_INTERVAL", 60)) * time.Second,
		GracePeriod:        time.Duration(envInt("WATCHER_GRACE_PERIOD", graceDef)) * time.Second,
		MinUptime:          600 * time.Second,
		MCPStartCommand:    envOr("MCP_START_COMMAND", "npx -y sensorium-mcp@latest"),
		HostMode:           parseHostMode(os.Getenv("HOST_MODE"), runningAsService),
		DataDir:            dataDir,
		KeyringService:     envOr("SUPERVISOR_KEYRING_SERVICE", defaultKeyringService),
		SecureVaultProfile: os.Getenv("SUPERVISOR_SECUREVAULT_PROFILE"),
		SecureVaultBaseDir: os.Getenv("SUPERVISOR_SECUREVAULT_BASEDIR"),
		HealthFailThresh:   3,

		KeeperBaseBackoff:         5 * time.Second,
		KeeperMaxBackoff:          5 * time.Minute,
		KeeperHealthCheckInterval: 2 * time.Minute,
		KeeperMaxRetries:          5,
		KeeperCooldown:            5 * time.Minute,
		KeeperReadyPollInterval:   3 * time.Second,
		KeeperReadyTimeout:        2 * time.Minute,
		FastExitThreshold:         60 * time.Second,
		FastExitMaxCount:          3,
		FastExitBaseCooldown:      10 * time.Minute,
		FastExitMaxCooldown:       4 * time.Hour,
		StuckThreshold:            time.Duration(envInt("KEEPER_STUCK_THRESHOLD_MIN", 30)) * time.Minute,

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

	// Use the full chain (env → SecureVault → keyring) when a profile is configured;
	// otherwise fall back to the plain env → keyring path.
	if c.SecureVaultProfile != "" {
		c.ResolvedProfileEnv = resolveProfileEnv(c.SecureVaultProfile, c.SecureVaultBaseDir)
		c.MCPHttpPort = resolveIntChain("MCP_HTTP_PORT", c.SecureVaultProfile, c.SecureVaultBaseDir, c.KeyringService, 0)
		c.MCPHttpSecret = resolveStringChain("MCP_HTTP_SECRET", c.SecureVaultProfile, c.SecureVaultBaseDir, c.KeyringService)
		c.TelegramToken = resolveStringChain("TELEGRAM_TOKEN", c.SecureVaultProfile, c.SecureVaultBaseDir, c.KeyringService)
		c.TelegramChatID = resolveStringChain("TELEGRAM_CHAT_ID", c.SecureVaultProfile, c.SecureVaultBaseDir, c.KeyringService)
	} else {
		c.ResolvedProfileEnv = map[string]string{}
		c.MCPHttpPort = resolveIntWithKeyring("MCP_HTTP_PORT", c.KeyringService, 0)
		c.MCPHttpSecret = resolveSecretWithKeyring("MCP_HTTP_SECRET", c.KeyringService)
		c.TelegramToken = resolveSecretWithKeyring("TELEGRAM_TOKEN", c.KeyringService)
		c.TelegramChatID = resolveSecretWithKeyring("TELEGRAM_CHAT_ID", c.KeyringService)
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

func resolveProfileEnv(profileName, baseDir string) map[string]string {
	resolved := map[string]string{}
	if strings.TrimSpace(profileName) == "" {
		return resolved
	}

	store := sv.NewStore(baseDir)
	vals, err := store.ResolveProfile(profileName)
	if err != nil {
		if errors.Is(err, sv.ErrNotFound) || errors.Is(err, sv.ErrUnsupportedPlatform) {
			return resolved
		}
		fmt.Fprintf(os.Stderr, "WARN: failed to resolve SecureVault profile %q: %v\n", profileName, err)
		return resolved
	}

	for k, v := range vals {
		if !isAllowedProfileEnvKey(k) {
			fmt.Fprintf(os.Stderr, "WARN: skipping unsafe profile env key %q\n", k)
			continue
		}
		if envVal := os.Getenv(k); envVal != "" {
			resolved[k] = envVal
			continue
		}
		resolved[k] = v
	}

	return resolved
}

var profileEnvKeyPattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

var deniedProfileEnvKeys = map[string]struct{}{
	"PATH":         {},
	"PATHEXT":      {},
	"COMSPEC":      {},
	"SYSTEMROOT":   {},
	"WINDIR":       {},
	"NODE_OPTIONS": {},
}

func isAllowedProfileEnvKey(key string) bool {
	trimmed := strings.TrimSpace(key)
	if !profileEnvKeyPattern.MatchString(trimmed) {
		return false
	}
	_, denied := deniedProfileEnvKeys[trimmed]
	return !denied
}
