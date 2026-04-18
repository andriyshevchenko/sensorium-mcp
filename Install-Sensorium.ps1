#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install or update sensorium-supervisor from GitHub Releases.
.DESCRIPTION
    Downloads the latest sensorium-supervisor release binary from GitHub Releases
    (tag: supervisor-latest, repo: andriyshevchenko/sensorium-mcp) and places
    it in ~/.remote-copilot-mcp/bin/ as sensorium-supervisor.exe.

    Installs user-context autorun via shell:startup and starts the supervisor
    as a background process immediately.

    Re-running this script performs an update: stops the existing process,
    replaces the binary, then restarts.
.PARAMETER Update
    Explicitly force update mode even if the binary doesn't exist yet.
.PARAMETER Foreground
    Run supervisor in the current console with live logs instead of background
    hidden mode.
.PARAMETER WatcherMode
    Supervisor mode to use (`production` or `development`).
.PARAMETER MCPStartCommand
    Command used by supervisor to start MCP child process. When omitted, installer
    uses published npm package command `npx -y sensorium-mcp@latest`.
.EXAMPLE
    .\Install-Sensorium.ps1
    .\Install-Sensorium.ps1 -Foreground
    .\Install-Sensorium.ps1 -WatcherMode production
    .\Install-Sensorium.ps1 -MCPStartCommand "node C:\src\remote-copilot-mcp\dist\index.js"
#>
param(
    [switch]$Update,
    [switch]$Foreground,
    [ValidateSet("production", "development")]
    [string]$WatcherMode = "production",
    [string]$MCPStartCommand = ""
)

$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────
$GithubRepo   = "andriyshevchenko/sensorium-mcp"
$ReleaseTag   = "supervisor-latest"
$AssetName    = "sensorium-supervisor-windows-amd64.exe"
$InstalledBinaryName = "sensorium-supervisor.exe"

$DataDir = Join-Path $env:USERPROFILE ".remote-copilot-mcp"
$BinDir  = Join-Path $DataDir "bin"
$Binary  = Join-Path $BinDir $InstalledBinaryName
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupLauncher = Join-Path $StartupDir "SensoriumSupervisor.cmd"
function Resolve-MCPStartCommand {
    if (-not [string]::IsNullOrWhiteSpace($MCPStartCommand)) {
        return $MCPStartCommand.Trim()
    }
    return "npx -y sensorium-mcp@latest"
}

$EffectiveMCPStartCommand = Resolve-MCPStartCommand

# ── Helpers ──────────────────────────────────────────────────────────────────

function Stop-SupervisorProcess {
    $procs = Get-Process -Name "sensorium-supervisor" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Stopping background sensorium-supervisor process(es)..."
        $procs | Stop-Process -Force
        Write-Host "Process(es) stopped." -ForegroundColor Yellow
    }
}

function Get-BinaryAsset {
    param([string]$Destination)

    $apiUrl = "https://api.github.com/repos/$GithubRepo/releases/tags/$ReleaseTag"
    Write-Host "Fetching release info from GitHub..."

    $headers = @{ "User-Agent" = "Install-Sensorium.ps1" }
    try {
        $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers -ErrorAction Stop
    } catch {
        throw "Failed to fetch GitHub release info: $_"
    }

    $asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
    if (-not $asset) {
        throw "Asset '$AssetName' not found in release '$ReleaseTag'. Available assets: $(($release.assets | Select-Object -ExpandProperty name) -join ', ')"
    }

    $downloadUrl = $asset.browser_download_url
    Write-Host "Downloading $AssetName from $downloadUrl ..."

    $tmpFile = "$Destination.tmp"
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing -ErrorAction Stop
    } catch {
        if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force }
        throw "Download failed: $_"
    }

    # Atomic replace
    if (Test-Path $Destination) {
        $backupPath = "$Destination.bak"
        Copy-Item $Destination $backupPath -Force
    }
    Move-Item $tmpFile $Destination -Force
    Unblock-File -Path $Destination -ErrorAction SilentlyContinue
    Write-Host "Binary placed at: $Destination" -ForegroundColor Green
}

function Install-StartupLauncher {
    $safeMode = $WatcherMode.Replace('"', '')
    $safeMcpStart = $EffectiveMCPStartCommand.Replace('"', '""')
    $launcherContent = @(
        "@echo off",
        "set `"WATCHER_MODE=$safeMode`"",
        "set `"MCP_START_COMMAND=$safeMcpStart`"",
        "start `"`" /min `"$Binary`""
    ) -join [Environment]::NewLine

    Set-Content -LiteralPath $StartupLauncher -Value $launcherContent -Encoding ASCII
    Write-Host "Startup launcher installed: $StartupLauncher" -ForegroundColor Green
}

function Start-AsBackground {
    Write-Host "Starting sensorium-supervisor as a background process..."
    $env:WATCHER_MODE = $WatcherMode
    $env:MCP_START_COMMAND = $EffectiveMCPStartCommand
    $logDir = Join-Path $DataDir "logs\supervisor"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $logOut = Join-Path $logDir "supervisor-stdout.log"
    $logErr = Join-Path $logDir "supervisor-stderr.log"
    try {
        Start-Process -FilePath $Binary `
                      -RedirectStandardOutput $logOut `
                      -RedirectStandardError  $logErr `
                      -WindowStyle Hidden `
                      -PassThru | Out-Null
    } catch {
        Write-Host "[ERROR] Failed to start supervisor in background: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "[HINT] If Windows Defender blocked the binary, run:" -ForegroundColor Yellow
        Write-Host "       Unblock-File -Path `"$Binary`"" -ForegroundColor Yellow
        Write-Host "[HINT] Then run foreground mode for live logs:" -ForegroundColor Yellow
        Write-Host "       .\Install-Sensorium.ps1 -Foreground" -ForegroundColor Yellow
        throw
    }
    Start-Sleep -Seconds 2
}

function Start-InForeground {
    $env:WATCHER_MODE = $WatcherMode
    $env:MCP_START_COMMAND = $EffectiveMCPStartCommand
    Write-Host "Starting sensorium-supervisor in foreground (live logs)..." -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
    & $Binary
    exit $LASTEXITCODE
}

function Show-Status {
    $procs = Get-Process -Name "sensorium-supervisor" -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $StartupLauncher) {
        Write-Host "[OK] Autorun launcher present: $StartupLauncher" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Autorun launcher missing: $StartupLauncher" -ForegroundColor Yellow
    }
    if ($procs) {
        Write-Host "`n[OK] sensorium-supervisor is RUNNING (PID: $(($procs | Select-Object -ExpandProperty Id) -join ', '))." -ForegroundColor Green
    } else {
        Write-Host "`n[WARN] sensorium-supervisor process not found after install." -ForegroundColor Yellow
    }
}

# ── Main ─────────────────────────────────────────────────────────────────────
$alreadyExists = Test-Path $Binary
$needsDownload = $Update -or -not $alreadyExists

Write-Host ""
if ($Update) {
    Write-Host "=== Sensorium Supervisor UPDATE ===" -ForegroundColor Cyan
} else {
    Write-Host "=== Sensorium Supervisor INSTALL ===" -ForegroundColor Cyan
}
Write-Host "Watcher mode: $WatcherMode"
Write-Host "MCP start command: $EffectiveMCPStartCommand"
Write-Host "Binary     : $Binary"
Write-Host ""

# Step 1 — stop existing instance
if ($alreadyExists) {
    Stop-SupervisorProcess
}

# Step 2 — ensure bin dir exists
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

# Step 3 — download binary when missing or explicitly requested
if ($needsDownload) {
    Get-BinaryAsset -Destination $Binary
} else {
    Write-Host "Using existing binary: $Binary" -ForegroundColor Cyan
}

# Step 4 — register autorun and start
Install-StartupLauncher
if ($Foreground) {
    Start-InForeground
} else {
    Start-AsBackground
}

# Step 5 — verify
Show-Status
