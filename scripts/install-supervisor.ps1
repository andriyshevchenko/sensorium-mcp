#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build and install the sensorium-supervisor Go binary.
.DESCRIPTION
    Compiles the Go supervisor and places it in ~/.remote-copilot-mcp/bin/.
    Requires Go 1.22+ installed and on PATH.
.PARAMETER Force
    Rebuild even if the binary already exists.
#>
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$DataDir = Join-Path $env:USERPROFILE ".remote-copilot-mcp"
$BinDir  = Join-Path $DataDir "bin"
$Binary  = Join-Path $BinDir "sensorium-supervisor.exe"

# Find the supervisor source directory (relative to this script)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SupervisorDir = Join-Path (Split-Path -Parent $ScriptDir) "supervisor"

if (-not (Test-Path (Join-Path $SupervisorDir "go.mod"))) {
    Write-Error "Cannot find supervisor source at $SupervisorDir"
    exit 1
}

# Check if Go is available
$goExe = Get-Command go -ErrorAction SilentlyContinue
if (-not $goExe) {
    Write-Host "Go is not installed. Install from https://go.dev/dl/ (requires Go 1.22+)" -ForegroundColor Red
    exit 1
}

# Check version
$goVersion = (go version) -replace 'go version go', '' -replace ' .*', ''
Write-Host "Found Go $goVersion"

# Skip build if binary exists and is newer than source (unless -Force)
if (-not $Force -and (Test-Path $Binary)) {
    $binaryTime = (Get-Item $Binary).LastWriteTime
    $sourceFiles = Get-ChildItem $SupervisorDir -Filter "*.go"
    $newestSource = ($sourceFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    if ($binaryTime -gt $newestSource) {
        Write-Host "sensorium-supervisor is up to date ($Binary)"
        exit 0
    }
}

# Ensure bin directory exists
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

Write-Host "Building sensorium-supervisor..."
Push-Location $SupervisorDir
try {
    go build -o $Binary .
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Go build failed"
        exit 1
    }
} finally {
    Pop-Location
}

Write-Host "Installed: $Binary" -ForegroundColor Green
