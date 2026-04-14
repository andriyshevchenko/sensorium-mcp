package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// applyPendingSupervisorUpdate applies a downloaded supervisor binary before the
// rest of the process starts. On Windows, a detached helper performs the swap
// after this bootstrap process exits because a running .exe cannot overwrite
// itself in place.
func applyPendingSupervisorUpdate(cfg Config, log *Logger) (bool, error) {
	if _, err := os.Stat(cfg.Paths.PendingBinary); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if _, versionErr := os.Stat(cfg.Paths.PendingVersion); versionErr == nil {
				log.Warn("Removing stale pending supervisor version file %s", cfg.Paths.PendingVersion)
				_ = os.Remove(cfg.Paths.PendingVersion)
			}
			return false, nil
		}
		return false, fmt.Errorf("stat pending supervisor binary: %w", err)
	}

	exePath, err := os.Executable()
	if err != nil {
		cleanupPendingSupervisorUpdate(cfg, log)
		return false, fmt.Errorf("resolve current executable: %w", err)
	}

	if runtime.GOOS == "windows" {
		isService, serviceErr := isWindowsService()
		if serviceErr != nil {
			cleanupPendingSupervisorUpdate(cfg, log)
			return false, fmt.Errorf("detect service mode for pending supervisor apply: %w", serviceErr)
		}

		if err := launchWindowsApplyHelper(cfg, exePath, isService); err != nil {
			cleanupPendingSupervisorUpdate(cfg, log)
			return false, fmt.Errorf("schedule pending supervisor apply: %w", err)
		}
		log.Info("Pending supervisor update detected; restarting to apply")
		return true, nil
	}

	if err := os.Rename(cfg.Paths.PendingBinary, exePath); err != nil {
		cleanupPendingSupervisorUpdate(cfg, log)
		return false, fmt.Errorf("apply pending supervisor binary: %w", err)
	}

	if err := finalizePendingSupervisorVersion(cfg); err != nil {
		log.Warn("Applied supervisor update but failed to persist version: %v", err)
	} else {
		log.Info("Applied supervisor update")
	}

	return false, nil
}

func finalizePendingSupervisorVersion(cfg Config) error {
	data, err := os.ReadFile(cfg.Paths.PendingVersion)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read pending supervisor version: %w", err)
	}

	if err := atomicWrite(cfg.Paths.SupervisorVersion, data); err != nil {
		return fmt.Errorf("write supervisor version: %w", err)
	}
	if err := os.Remove(cfg.Paths.PendingVersion); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove pending supervisor version: %w", err)
	}
	return nil
}

func cleanupPendingSupervisorUpdate(cfg Config, log *Logger) {
	for _, path := range []string{cfg.Paths.PendingBinary, cfg.Paths.PendingVersion} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Warn("Failed to remove stale supervisor update artifact %s: %v", path, err)
		}
	}
}

func launchWindowsApplyHelper(cfg Config, exePath string, restartViaService bool) error {
	if err := os.MkdirAll(filepath.Dir(cfg.Paths.SupervisorVersion), 0755); err != nil {
		return fmt.Errorf("create supervisor version directory: %w", err)
	}

	scriptFile, err := os.CreateTemp("", "sensorium-supervisor-apply-*.cmd")
	if err != nil {
		return fmt.Errorf("create apply helper script: %w", err)
	}

	script := strings.Join([]string{
		"@echo off",
		"setlocal",
		":wait",
		fmt.Sprintf(`tasklist /FI "PID eq %d" 2>NUL | find "%d" >NUL`, os.Getpid(), os.Getpid()),
		"if not errorlevel 1 (",
		"  timeout /T 1 /NOBREAK >NUL",
		"  goto wait",
		")",
		"set attempts=0",
		":move",
		fmt.Sprintf(`move /Y %s %s >NUL`, batchQuote(cfg.Paths.PendingBinary), batchQuote(exePath)),
		"if not errorlevel 1 goto applied",
		"set /a attempts+=1",
		"if %attempts% GEQ 5 goto fail",
		"timeout /T 1 /NOBREAK >NUL",
		"goto move",
		":applied",
		fmt.Sprintf(`if exist %s move /Y %s %s >NUL`, batchQuote(cfg.Paths.PendingVersion), batchQuote(cfg.Paths.PendingVersion), batchQuote(cfg.Paths.SupervisorVersion)),
		"exit /b 0",
		":fail",
		fmt.Sprintf(`if exist %s del /F /Q %s`, batchQuote(cfg.Paths.PendingBinary), batchQuote(cfg.Paths.PendingBinary)),
		fmt.Sprintf(`if exist %s del /F /Q %s`, batchQuote(cfg.Paths.PendingVersion), batchQuote(cfg.Paths.PendingVersion)),
		"exit /b 1",
		"",
	}, "\r\n")

	if !restartViaService {
		script = strings.Replace(script, "exit /b 0\r\n:fail", fmt.Sprintf("start \"\" %s\r\nexit /b 0\r\n:fail", batchQuote(exePath)), 1)
	}

	if _, err := scriptFile.WriteString(script); err != nil {
		scriptFile.Close()
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("write apply helper script: %w", err)
	}
	if err := scriptFile.Close(); err != nil {
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("close apply helper script: %w", err)
	}

	cmd := exec.Command("cmd", "/c", scriptFile.Name())
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	setSysProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("start apply helper: %w", err)
	}

	_ = cmd.Process.Release()
	return nil
}

func batchQuote(path string) string {
	return `"` + strings.ReplaceAll(path, `"`, `""`) + `"`
}
