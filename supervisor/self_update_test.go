package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyPendingSupervisorUpdate_ConvergesToFailedFromRollbackMarker(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	cfg := Config{
		Paths: Paths{
			PendingBinary:     filepath.Join(dir, "bin", "sensorium-supervisor.new.exe"),
			PendingVersion:    filepath.Join(dir, "bin", "sensorium-supervisor.new.exe.version"),
			SupervisorVersion: filepath.Join(dir, "supervisor-version.txt"),
			UpdateState:       filepath.Join(dir, "update-state.json"),
		},
	}

	if err := os.MkdirAll(filepath.Dir(cfg.Paths.PendingBinary), 0755); err != nil {
		t.Fatalf("create pending dir: %v", err)
	}

	store := NewUpdateStateStore(cfg.Paths.UpdateState, log)
	store.Transition(updateScopeSupervisor, updatePhaseRestarting, "2.0.0", "1.0.0", "")

	reason := "helper failed to swap pending supervisor binary after retries"
	if err := os.WriteFile(supervisorApplyFailureMarkerPath(cfg), []byte(reason), 0644); err != nil {
		t.Fatalf("write apply failure marker: %v", err)
	}

	shouldRestart, err := applyPendingSupervisorUpdate(cfg, log)
	if err != nil {
		t.Fatalf("applyPendingSupervisorUpdate() error = %v", err)
	}
	if shouldRestart {
		t.Fatal("applyPendingSupervisorUpdate() shouldRestart = true, want false")
	}

	state, err := store.Load()
	if err != nil {
		t.Fatalf("load state: %v", err)
	}
	if state.Scope != updateScopeSupervisor {
		t.Fatalf("scope = %q, want %q", state.Scope, updateScopeSupervisor)
	}
	if state.Phase != updatePhaseFailed {
		t.Fatalf("phase = %q, want %q", state.Phase, updatePhaseFailed)
	}
	if !strings.Contains(state.LastError, reason) {
		t.Fatalf("last error = %q, want reason %q", state.LastError, reason)
	}
	if !strings.Contains(state.LastError, supervisorRollbackAttemptedMarker) {
		t.Fatalf("last error = %q, missing rollback marker %q", state.LastError, supervisorRollbackAttemptedMarker)
	}

	if _, statErr := os.Stat(supervisorApplyFailureMarkerPath(cfg)); !os.IsNotExist(statErr) {
		t.Fatalf("expected apply failure marker to be removed, got: %v", statErr)
	}
}

func TestBuildWindowsApplyHelperScript_TaskModeFailPathRestartsCurrentBinary(t *testing.T) {
	cfg := Config{
		Paths: Paths{
			PendingBinary:     `C:\data\bin\sensorium-supervisor.new.exe`,
			PendingVersion:    `C:\data\bin\sensorium-supervisor.new.exe.version`,
			SupervisorVersion: `C:\data\supervisor-version.txt`,
		},
	}
	exePath := `C:\data\sensorium-supervisor.exe`

	script := buildWindowsApplyHelperScript(cfg, exePath, false)

	failStart := `:fail` + "\r\n" + `set "FAIL_REASON=helper failed to swap pending supervisor binary after retries (pending=C:\data\bin\sensorium-supervisor.new.exe current=C:\data\sensorium-supervisor.exe)"` + "\r\n" + `<nul set /p "=%FAIL_REASON%" > "C:\data\bin\sensorium-supervisor.new.exe.failed"` + "\r\n" + `if exist "C:\data\bin\sensorium-supervisor.new.exe" del /F /Q "C:\data\bin\sensorium-supervisor.new.exe"` + "\r\n" + `if exist "C:\data\bin\sensorium-supervisor.new.exe.version" del /F /Q "C:\data\bin\sensorium-supervisor.new.exe.version"` + "\r\n" + `start "" "C:\data\sensorium-supervisor.exe"`
	if !strings.Contains(script, failStart) {
		t.Fatalf("task-mode fail fallback restart block missing\nscript:\n%s", script)
	}

	if !strings.Contains(script, `:applied`+"\r\n"+`if exist "C:\data\bin\sensorium-supervisor.new.exe.version" move /Y "C:\data\bin\sensorium-supervisor.new.exe.version" "C:\data\supervisor-version.txt" >NUL`+"\r\n"+`if exist "C:\data\bin\sensorium-supervisor.new.exe.failed" del /F /Q "C:\data\bin\sensorium-supervisor.new.exe.failed"`+"\r\n"+`start "" "C:\data\sensorium-supervisor.exe"`) {
		t.Fatalf("task-mode applied restart block missing\nscript:\n%s", script)
	}
}

func TestBuildWindowsApplyHelperScript_ServiceModeDoesNotStartBinary(t *testing.T) {
	cfg := Config{
		Paths: Paths{
			PendingBinary:     `C:\data\bin\sensorium-supervisor.new.exe`,
			PendingVersion:    `C:\data\bin\sensorium-supervisor.new.exe.version`,
			SupervisorVersion: `C:\data\supervisor-version.txt`,
		},
	}
	exePath := `C:\data\sensorium-supervisor.exe`

	script := buildWindowsApplyHelperScript(cfg, exePath, true)
	if strings.Contains(script, `start "" "C:\data\sensorium-supervisor.exe"`) {
		t.Fatalf("service-mode helper unexpectedly starts supervisor binary\nscript:\n%s", script)
	}

	serviceFailRestart := `:fail` + "\r\n" + `set "FAIL_REASON=helper failed to swap pending supervisor binary after retries (pending=C:\data\bin\sensorium-supervisor.new.exe current=C:\data\sensorium-supervisor.exe)"` + "\r\n" + `<nul set /p "=%FAIL_REASON%" > "C:\data\bin\sensorium-supervisor.new.exe.failed"` + "\r\n" + `if exist "C:\data\bin\sensorium-supervisor.new.exe" del /F /Q "C:\data\bin\sensorium-supervisor.new.exe"` + "\r\n" + `if exist "C:\data\bin\sensorium-supervisor.new.exe.version" del /F /Q "C:\data\bin\sensorium-supervisor.new.exe.version"` + "\r\n" + `sc start "SensoriumSupervisor" >NUL 2>&1` + "\r\n" + `if errorlevel 1 (` + "\r\n" + `  timeout /T 2 /NOBREAK >NUL` + "\r\n" + `  sc start "SensoriumSupervisor" >NUL 2>&1` + "\r\n" + `)`
	if !strings.Contains(script, serviceFailRestart) {
		t.Fatalf("service-mode fail recovery assist block missing\nscript:\n%s", script)
	}
}

func TestBuildWindowsApplyHelperScript_EscapesFailReasonForCmdSafety(t *testing.T) {
	cfg := Config{
		Paths: Paths{
			PendingBinary:     `C:\data\bin\sensorium&supervisor.new%TMP%.exe`,
			PendingVersion:    `C:\data\bin\sensorium-supervisor.new.exe.version`,
			SupervisorVersion: `C:\data\supervisor-version.txt`,
		},
	}
	exePath := `C:\data\sensorium"supervisor.exe`

	script := buildWindowsApplyHelperScript(cfg, exePath, false)

	if !strings.Contains(script, `set "FAIL_REASON=helper failed to swap pending supervisor binary after retries (pending=C:\data\bin\sensorium&supervisor.new%%TMP%%.exe current=C:\data\sensorium'supervisor.exe)"`) {
		t.Fatalf("expected escaped quoted FAIL_REASON assignment\nscript:\n%s", script)
	}
	if strings.Contains(script, `set FAIL_REASON=`) {
		t.Fatalf("found unsafe unquoted FAIL_REASON assignment\nscript:\n%s", script)
	}
}

func TestRecordPendingSupervisorApplyFailureIfPresent_IgnoresStaleMarkerWhenTargetAlreadyApplied(t *testing.T) {
	dir := t.TempDir()
	log := NewLogger(filepath.Join(dir, "test.log"))
	defer log.Close()

	targetVersion := "2.0.0"
	cfg := Config{
		Paths: Paths{
			PendingBinary:     filepath.Join(dir, "bin", "sensorium-supervisor.new.exe"),
			PendingVersion:    filepath.Join(dir, "bin", "sensorium-supervisor.new.exe.version"),
			SupervisorVersion: filepath.Join(dir, "supervisor-version.txt"),
			UpdateState:       filepath.Join(dir, "update-state.json"),
		},
	}

	if err := os.MkdirAll(filepath.Dir(cfg.Paths.PendingBinary), 0755); err != nil {
		t.Fatalf("create pending dir: %v", err)
	}
	if err := os.WriteFile(cfg.Paths.SupervisorVersion, []byte(targetVersion), 0644); err != nil {
		t.Fatalf("write supervisor version: %v", err)
	}

	store := NewUpdateStateStore(cfg.Paths.UpdateState, log)
	store.Transition(updateScopeSupervisor, updatePhaseFailed, targetVersion, "1.0.0", "old failure")

	if err := os.WriteFile(supervisorApplyFailureMarkerPath(cfg), []byte("stale helper failure"), 0644); err != nil {
		t.Fatalf("write apply failure marker: %v", err)
	}

	recordPendingSupervisorApplyFailureIfPresent(cfg, log)

	state, err := store.Load()
	if err != nil {
		t.Fatalf("load state: %v", err)
	}
	if state.Phase != updatePhaseIdle {
		t.Fatalf("phase = %q, want %q", state.Phase, updatePhaseIdle)
	}
	if state.TargetVersion != targetVersion {
		t.Fatalf("target = %q, want %q", state.TargetVersion, targetVersion)
	}
	if state.LastError != "" {
		t.Fatalf("last error = %q, want empty", state.LastError)
	}

	if _, statErr := os.Stat(supervisorApplyFailureMarkerPath(cfg)); !os.IsNotExist(statErr) {
		t.Fatalf("expected apply failure marker to be removed, got: %v", statErr)
	}
}
