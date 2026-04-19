#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install or update sensorium-supervisor from GitHub Releases.
.DESCRIPTION
    Downloads the latest sensorium-supervisor release binary from GitHub Releases
    (tag: supervisor-latest, repo: andriyshevchenko/sensorium-mcp) and places
    it in ~/.remote-copilot-mcp/bin/ as sensorium-supervisor.exe.

    Always downloads the latest binary, stops any running instance, and restarts
    via `securevault run --detached` which injects secrets from the OS keychain
    as environment variables and launches in a separate console window.
.PARAMETER SecureVaultProfile
    SecureVault profile name to resolve runtime secrets from.
.PARAMETER UpdateMode
    Supervisor mode to use (`production` or `development`).
.PARAMETER MCPStartCommand
    Command used by supervisor to start MCP child process. When omitted, installer
    uses published npm package command `npx -y sensorium-mcp@latest`.
.EXAMPLE
    .\Install-Sensorium.ps1
    .\Install-Sensorium.ps1 -SecureVaultProfile "SENSORIUM" -UpdateMode production
    .\Install-Sensorium.ps1 -UpdateMode development
    .\Install-Sensorium.ps1 -MCPStartCommand "node C:\src\remote-copilot-mcp\dist\index.js"
#>
param(
    [string]$SecureVaultProfile = "SENSORIUM",
    [ValidateSet("production", "development")]
    [string]$UpdateMode = "production",
    [string]$MCPStartCommand = ""
)

$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────
$GithubRepo = "andriyshevchenko/sensorium-mcp"
$ReleaseTag = "supervisor-latest"
$AssetName = "sensorium-supervisor-windows-amd64.exe"
$InstalledBinaryName = "sensorium-supervisor.exe"

$DataDir = Join-Path $env:USERPROFILE ".remote-copilot-mcp"
$BinDir = Join-Path $DataDir "bin"
$Binary = Join-Path $BinDir $InstalledBinaryName
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
    }
    catch {
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
    }
    catch {
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
    $safeProfile = $SecureVaultProfile.Replace('"', '')
    $safeMode = $UpdateMode.Replace('"', '')
    $safeMcpStart = $EffectiveMCPStartCommand.Replace('"', '""')

    $launcherContent = @(
        "@echo off",
        "set `"SUPERVISOR_UPDATE_MODE=$safeMode`"",
        "set `"MCP_START_COMMAND=$safeMcpStart`"",
        "securevault run `"$Binary`" --profile $safeProfile --detached"
    ) -join [Environment]::NewLine

    Set-Content -LiteralPath $StartupLauncher -Value $launcherContent -Encoding ASCII
    Write-Host "Startup launcher installed: $StartupLauncher" -ForegroundColor Green
}

function Start-Supervisor {
    $env:SUPERVISOR_UPDATE_MODE = $UpdateMode
    $env:MCP_START_COMMAND = $EffectiveMCPStartCommand

    Write-Host "Starting sensorium-supervisor via SecureVault (profile: $SecureVaultProfile)..."
    try {
        securevault run "`"$Binary`"" --profile $SecureVaultProfile --detached
    }
    catch {
        Write-Host "[ERROR] SecureVault launch failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "[HINT] Make sure SecureVault backend is running: securevault" -ForegroundColor Yellow
        throw
    }
    Start-Sleep -Seconds 2
}

function Show-Status {
    $procs = Get-Process -Name "sensorium-supervisor" -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $StartupLauncher) {
        Write-Host "[OK] Autorun launcher present: $StartupLauncher" -ForegroundColor Green
    }
    else {
        Write-Host "[WARN] Autorun launcher missing: $StartupLauncher" -ForegroundColor Yellow
    }
    if ($procs) {
        Write-Host "`n[OK] sensorium-supervisor is RUNNING (PID: $(($procs | Select-Object -ExpandProperty Id) -join ', '))." -ForegroundColor Green
    }
    else {
        Write-Host "`n[WARN] sensorium-supervisor process not found after install." -ForegroundColor Yellow
    }
}

# ── Main ─────────────────────────────────────────────────────────────────────
$alreadyExists = Test-Path $Binary

Write-Host ""
if ($alreadyExists) {
    Write-Host "=== Sensorium Supervisor UPDATE ===" -ForegroundColor Cyan
}
else {
    Write-Host "=== Sensorium Supervisor INSTALL ===" -ForegroundColor Cyan
}
Write-Host "SecureVault profile: $(if ([string]::IsNullOrWhiteSpace($SecureVaultProfile)) { '<disabled>' } else { $SecureVaultProfile })"
Write-Host "Watcher mode: $UpdateMode"
Write-Host "MCP start command: $EffectiveMCPStartCommand"
Write-Host "Binary     : $Binary"
Write-Host ""

# Step 1 — stop existing instance
if ($alreadyExists) {
    Stop-SupervisorProcess
}

# Step 2 — ensure bin dir exists
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

# Step 3 — always download latest binary
Get-BinaryAsset -Destination $Binary

# Step 4 — install launcher and start
Install-StartupLauncher
Start-Supervisor

# Step 5 — verify
Show-Status
