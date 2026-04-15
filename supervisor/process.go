package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// SpawnMCPServer starts the MCP server as a detached child process.
// Returns the PID of the spawned process.
func SpawnMCPServer(cfg Config, log *Logger) (int, error) {
	parts := strings.Fields(cfg.MCPStartCommand)
	if len(parts) == 0 {
		return 0, errors.New("empty MCP_START_COMMAND")
	}

	if err := os.MkdirAll(filepath.Dir(cfg.Paths.MCPStderrLog), 0755); err != nil {
		return 0, fmt.Errorf("create MCP stderr log directory: %w", err)
	}
	stderrFile, err := os.OpenFile(cfg.Paths.MCPStderrLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return 0, fmt.Errorf("open MCP stderr log: %w", err)
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = stderrFile
	setSysProcAttr(cmd)

	log.Info("Starting MCP server: %s", cfg.MCPStartCommand)
	log.Info("Capturing MCP server stderr to %s", cfg.Paths.MCPStderrLog)

	if err := cmd.Start(); err != nil {
		_ = stderrFile.Close()
		return 0, fmt.Errorf("spawn MCP server: %w", err)
	}

	pid := cmd.Process.Pid
	log.Info("MCP server started with PID %d", pid)

	// Don't wait — detached process
	go func() {
		_ = cmd.Wait()
		_ = stderrFile.Close()
	}()

	if err := writePIDFile(cfg.Paths.ServerPID, pid); err != nil {
		log.Warn("Failed to write server PID file: %v", err)
	}

	return pid, nil
}

// KillProcess kills a process by PID. On Windows, uses taskkill /F /T for tree kill.
func KillProcess(pid int, log *Logger) error {
	if !IsProcessAlive(pid) {
		log.Debug("KillProcess: PID %d already dead", pid)
		return nil
	}

	log.Debug("KillProcess: killing PID %d", pid)

	if runtime.GOOS == "windows" {
		// taskkill /F /T kills the tree
		out, err := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid)).CombinedOutput()
		if err != nil {
			return fmt.Errorf("taskkill PID %d: %w (%s)", pid, err, strings.TrimSpace(string(out)))
		}
		log.Info("Killed process tree PID %d", pid)
		return nil
	}

	// Unix: SIGTERM, wait 2s, then SIGKILL
	proc, err := os.FindProcess(pid)
	if err != nil {
		log.Debug("KillProcess: FindProcess(%d) failed: %v", pid, err)
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		// Already dead
		return nil
	}
	time.Sleep(2 * time.Second)
	if IsProcessAlive(pid) {
		_ = proc.Kill()
		log.Info("Force-killed PID %d", pid)
	} else {
		log.Info("Process PID %d terminated gracefully", pid)
	}
	return nil
}

// KillByPort finds a process listening on the given port and kills it (Windows-only orphan cleanup).
func KillByPort(port int, log *Logger) {
	if runtime.GOOS != "windows" || port <= 0 || port > 65535 {
		return
	}
	log.Debug("KillByPort: checking for processes on port %d", port)
	out, err := exec.Command("cmd", "/c", fmt.Sprintf("netstat -aon | findstr \":%d.*LISTENING\"", port)).CombinedOutput()
	if err != nil {
		log.Debug("KillByPort: no listeners on port %d", port)
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) >= 5 {
			pid, err := strconv.Atoi(fields[len(fields)-1])
			if err == nil && pid > 0 {
				log.Info("Found orphan PID %d on port %d — killing", pid, port)
				_ = KillProcess(pid, log)
			}
		}
	}
}

// IsProcessAlive checks whether a process with the given PID exists.
func IsProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH").CombinedOutput()
		if err != nil {
			return false
		}
		return strings.Contains(string(out), strconv.Itoa(pid))
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil // signal 0 = existence check on Unix
}

// --- PID File Helpers ---

type pidJSON struct {
	PID int `json:"pid"`
}

// ReadPIDFile reads a PID from a file. Supports both JSON {"pid":123} and raw integer formats.
func ReadPIDFile(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	raw := strings.TrimSpace(string(data))

	// Try JSON first
	var pj pidJSON
	if json.Unmarshal([]byte(raw), &pj) == nil && pj.PID > 0 {
		return pj.PID, nil
	}

	// Fallback: raw integer
	pid, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid PID file content: %q", raw)
	}
	if pid <= 0 {
		return 0, fmt.Errorf("invalid PID: %d", pid)
	}
	return pid, nil
}

func writePIDFile(path string, pid int) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, _ := json.Marshal(pidJSON{PID: pid})
	return atomicWrite(path, data)
}

// atomicWrite writes data to a temp file then renames — prevents partial reads.
func atomicWrite(path string, data []byte) error {
	tmp := fmt.Sprintf("%s.tmp.%d", path, os.Getpid())
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ListThreadPIDs returns a map of threadId → PID from the pids directory.
func ListThreadPIDs(pidsDir string) map[string]int {
	result := make(map[string]int)
	entries, err := os.ReadDir(pidsDir)
	if err != nil {
		// directory may not exist yet
		return result
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".pid") {
			continue
		}
		threadID := strings.TrimSuffix(e.Name(), ".pid")
		pid, err := ReadPIDFile(filepath.Join(pidsDir, e.Name()))
		if err != nil {
			continue
		}
		result[threadID] = pid
	}
	return result
}

// CleanStalePIDs removes PID files for processes that are no longer running.
func CleanStalePIDs(pidsDir string, log *Logger) {
	pids := ListThreadPIDs(pidsDir)
	if len(pids) == 0 {
		log.Debug("CleanStalePIDs: no PID files found in %s", pidsDir)
		return
	}
	log.Debug("CleanStalePIDs: checking %d PID files", len(pids))
	cleaned := 0
	for threadID, pid := range pids {
		if !IsProcessAlive(pid) {
			path := filepath.Join(pidsDir, threadID+".pid")
			log.Info("Removing stale PID file for thread %s (PID %d)", threadID, pid)
			_ = os.Remove(path)
			cleaned++
		}
	}
	if cleaned > 0 {
		log.Info("CleanStalePIDs: removed %d stale PID files", cleaned)
	}
}
