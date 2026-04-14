//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func scheduleServiceRestartForUpdate(log *Logger) error {
	scriptFile, err := os.CreateTemp("", "sensorium-supervisor-service-restart-*.cmd")
	if err != nil {
		return fmt.Errorf("create service restart helper: %w", err)
	}

	script := strings.Join([]string{
		"@echo off",
		"setlocal",
		fmt.Sprintf(`sc stop %s >NUL 2>&1`, batchQuote(serviceName)),
		"timeout /T 2 /NOBREAK >NUL",
		"set attempts=0",
		":waitStopped",
		fmt.Sprintf(`sc query %s | find "STATE" | find "STOPPED" >NUL`, batchQuote(serviceName)),
		"if not errorlevel 1 goto start",
		"set /a attempts+=1",
		"if %attempts% GEQ 10 goto start",
		"timeout /T 1 /NOBREAK >NUL",
		"goto waitStopped",
		":start",
		"timeout /T 3 /NOBREAK >NUL",
		fmt.Sprintf(`sc start %s >NUL 2>&1`, batchQuote(serviceName)),
		"exit /b 0",
		"",
	}, "\r\n")

	if _, err := scriptFile.WriteString(script); err != nil {
		scriptFile.Close()
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("write service restart helper: %w", err)
	}
	if err := scriptFile.Close(); err != nil {
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("close service restart helper: %w", err)
	}

	cmd := exec.Command("cmd", "/c", scriptFile.Name())
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	setSysProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		_ = os.Remove(scriptFile.Name())
		return fmt.Errorf("start service restart helper: %w", err)
	}

	_ = cmd.Process.Release()
	log.Info("Scheduled detached service restart helper to apply pending supervisor update")
	return nil
}
