package main

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// KeeperConfig describes a thread that must be kept alive.
type KeeperConfig struct {
	ThreadID         int
	SessionName      string
	Client           string // e.g. "claude-code", "codex"
	WorkingDirectory string
	MaxRetries       int
	CooldownMs       int
}

// Keeper supervises a single thread, restarting it via the MCP server's
// start_thread tool when it stops running. One goroutine per keeper.
type Keeper struct {
	cfg     KeeperConfig
	global  Config
	mcp     *MCPClient
	log     *Logger
	onDeath func(threadID int, sessionName string)

	mu      sync.Mutex
	stopped bool
	cancel  context.CancelFunc
	done    chan struct{}
}

func NewKeeper(cfg KeeperConfig, global Config, mcp *MCPClient, log *Logger, onDeath func(int, string)) *Keeper {
	maxRetries := cfg.MaxRetries
	if maxRetries <= 0 {
		maxRetries = global.KeeperMaxRetries
	}
	cfg.MaxRetries = maxRetries
	return &Keeper{
		cfg:     cfg,
		global:  global,
		mcp:     mcp,
		log:     log,
		onDeath: onDeath,
		done:    make(chan struct{}),
	}
}

// Start begins the keeper loop in a separate goroutine.
func (k *Keeper) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	k.mu.Lock()
	k.cancel = cancel
	k.mu.Unlock()

	go k.run(ctx)
}

// Stop signals the keeper to shut down and waits for it to finish.
func (k *Keeper) Stop() {
	k.mu.Lock()
	k.stopped = true
	if k.cancel != nil {
		k.cancel()
	}
	k.mu.Unlock()
	<-k.done
}

func (k *Keeper) isStopped() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.stopped
}

func (k *Keeper) run(ctx context.Context) {
	defer close(k.done)
	defer func() {
		if r := recover(); r != nil {
			k.log.Error("Keeper panicked for thread %d: %v", k.cfg.ThreadID, r)
		}
	}()
	defer k.log.Info("Keeper stopped for thread %d", k.cfg.ThreadID)

	k.log.Info("Keeper started for thread %d ('%s') [client=%s]", k.cfg.ThreadID, k.cfg.SessionName, k.cfg.Client)

	// Wait for MCP server to be ready
	ready := k.mcp.WaitForReady(ctx, k.global.KeeperReadyPollInterval, k.global.KeeperReadyTimeout)
	if !ready && !k.isStopped() {
		k.log.Warn("MCP server not ready after %v — attempting start_thread anyway", k.global.KeeperReadyTimeout)
	}

	retryCount := 0
	fastExitCount := 0
	fastExitEscalation := 0
	var lastStartTime time.Time

	checkAndStart := func() {
		if k.isStopped() {
			return
		}

		// Check if thread is running
		running := k.mcp.IsThreadRunning(ctx, k.cfg.ThreadID)
		if running {
			// Check if stuck
			if k.mcp.IsThreadStuck(ctx, k.cfg.ThreadID, k.global.StuckThreshold) {
				k.log.Warn("Thread %d is stuck (no heartbeat for %v) — restarting", k.cfg.ThreadID, k.global.StuckThreshold)
				// Kill via MCP API, then fall through to restart
				k.killThread(ctx)
			} else {
				// Healthy — reset counters
				if retryCount > 0 {
					k.log.Info("Thread %d is healthy again (was at retry %d)", k.cfg.ThreadID, retryCount)
				} else {
					k.log.Debug("Thread %d is healthy", k.cfg.ThreadID)
				}
				retryCount = 0
				return
			}
		}

		// Thread is not running (or was stuck and killed)
		if retryCount >= k.cfg.MaxRetries {
			cooldown := k.global.KeeperCooldown
			if k.cfg.CooldownMs > 0 {
				cooldown = time.Duration(k.cfg.CooldownMs) * time.Millisecond
			}
			k.log.Warn("Max retries (%d) exceeded — cooling down for %v", k.cfg.MaxRetries, cooldown)
			if k.onDeath != nil {
				k.onDeath(k.cfg.ThreadID, k.cfg.SessionName)
			}
			k.sleep(ctx, cooldown)
			retryCount = 0
			fastExitCount = 0
			return
		}

		k.log.Info("Thread %d not running — calling start_thread (attempt %d/%d)", k.cfg.ThreadID, retryCount+1, k.cfg.MaxRetries)

		lastStartTime = time.Now()
		ok := k.callStartThread(ctx)

		if ok {
			k.log.Info("Thread %d start_thread succeeded", k.cfg.ThreadID)
			retryCount = 0
			// Check for fast exit on next check
		} else {
			// Check for fast exit pattern
			if !lastStartTime.IsZero() && time.Since(lastStartTime) < k.global.FastExitThreshold {
				fastExitCount++
				if fastExitCount >= k.global.FastExitMaxCount {
					cooldown := time.Duration(float64(k.global.FastExitBaseCooldown) * math.Pow(2, float64(fastExitEscalation)))
					if cooldown > k.global.FastExitMaxCooldown {
						cooldown = k.global.FastExitMaxCooldown
					}
					k.log.Warn("Thread %d: %d consecutive fast exits — backing off %v", k.cfg.ThreadID, fastExitCount, cooldown)
					if k.onDeath != nil {
						k.onDeath(k.cfg.ThreadID, k.cfg.SessionName+" (repeated fast exits — check credits/API key)")
					}
					fastExitEscalation++
					k.sleep(ctx, cooldown)
					fastExitCount = 0
					retryCount = 0
					return
				}
			} else {
				fastExitCount = 0
				fastExitEscalation = 0
			}

			retryCount++
			delay := k.backoff(retryCount)
			k.log.Info("Backing off %v before next attempt", delay)
			k.sleep(ctx, delay)
		}
	}

	// Initial check
	checkAndStart()

	// Health check loop
	for {
		if k.isStopped() {
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(k.global.KeeperHealthCheckInterval):
			checkAndStart()
		}
	}
}

func (k *Keeper) callStartThread(ctx context.Context) bool {
	sessionID, err := k.mcp.OpenMCPSession(ctx)
	if err != nil {
		k.log.Error("Failed to open MCP session: %v", err)
		return false
	}
	defer k.mcp.CloseMCPSession(ctx, sessionID)

	text, err := k.mcp.CallStartThread(ctx, sessionID, k.cfg.ThreadID, k.cfg.SessionName, k.cfg.Client, k.cfg.WorkingDirectory)
	if err != nil {
		k.log.Error("start_thread failed: %v", err)
		return false
	}

	if text != "" {
		k.log.Info("start_thread response: %.200s", text)
	}
	return true
}

func (k *Keeper) killThread(ctx context.Context) {
	k.log.Info("Killing stuck thread %d", k.cfg.ThreadID)
	// Read PID from thread PID file
	pidFile := k.global.Paths.PIDsDir + "/" + fmt.Sprintf("%d.pid", k.cfg.ThreadID)
	pid, err := ReadPIDFile(pidFile)
	if err != nil {
		k.log.Warn("Cannot read PID for thread %d: %v", k.cfg.ThreadID, err)
		return
	}
	if err := KillProcess(pid, k.log); err != nil {
		k.log.Error("Failed to kill thread %d (PID %d): %v", k.cfg.ThreadID, pid, err)
	}
}

func (k *Keeper) backoff(retry int) time.Duration {
	delay := time.Duration(float64(k.global.KeeperBaseBackoff) * math.Pow(2, float64(retry)))
	if delay > k.global.KeeperMaxBackoff {
		delay = k.global.KeeperMaxBackoff
	}
	return delay
}

func (k *Keeper) sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// fmt import is used in killThread and logging
