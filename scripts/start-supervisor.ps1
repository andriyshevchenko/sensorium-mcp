#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Launch sensorium-supervisor. Builds automatically if needed.
.DESCRIPTION
    Replaces update-watcher.ps1. Builds the Go supervisor if it doesn't exist,
    then runs it. All environment variables (MCP_HTTP_PORT, TELEGRAM_TOKEN, etc.)
    are passed through to the supervisor process.
.PARAMETER Mode
    Watcher mode: production or development. Maps to WATCHER_MODE env var.
.PARAMETER Build
    Force rebuild of the supervisor binary before starting.
#>
param(
    [ValidateSet("production", "development")]
    [string]$Mode = "production",
    [switch]$Build
)

$ErrorActionPreference = "Stop"

$DataDir = Join-Path $env:USERPROFILE ".remote-copilot-mcp"
$BinDir  = Join-Path $DataDir "bin"
$Binary  = Join-Path $BinDir "sensorium-supervisor.exe"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Build if missing or requested
if ($Build -or -not (Test-Path $Binary)) {
    $installScript = Join-Path $ScriptDir "install-supervisor.ps1"
    if ($Build) {
        & $installScript -Force
    } else {
        & $installScript
    }
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

# Set WATCHER_MODE if not already set
if (-not $env:WATCHER_MODE) {
    $env:WATCHER_MODE = $Mode
}

# Launch supervisor
Write-Host "Starting sensorium-supervisor ($Mode mode)..."
& $Binary
exit $LASTEXITCODE
