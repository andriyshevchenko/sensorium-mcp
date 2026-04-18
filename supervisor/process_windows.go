//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// setSysProcAttr configures the spawned MCP process to:
//   - CREATE_NEW_PROCESS_GROUP — isolates Ctrl+C signals
//   - CREATE_BREAKAWAY_FROM_JOB (0x01000000) — allows the MCP process to
//     outlive the supervisor's Job Object.  Requires the parent job to have
//     JOB_OBJECT_LIMIT_BREAKAWAY_OK set; if not (e.g. some CI runners),
//     cmd.Start() will fail with ERROR_ACCESS_DENIED.
func setSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x01000000,
		HideWindow:    true,
	}
}
