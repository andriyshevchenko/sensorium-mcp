#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install or update sensorium-supervisor from GitHub Releases.
.DESCRIPTION
    Downloads the latest sensorium-supervisor release binary from GitHub Releases
    (tag: supervisor-latest, repo: andriyshevchenko/sensorium-mcp) and places
    it in ~/.remote-copilot-mcp/bin/ as sensorium-supervisor.exe.

    All configuration is read from ~/.remote-copilot-mcp/install.config.json.
    Edit that file to change settings. Defaults are written on first run.
.EXAMPLE
    .\Install-Sensorium.ps1
#>

$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────
$GithubRepo = "andriyshevchenko/sensorium-mcp"
$ReleaseTag = "supervisor-latest"
$AssetName = "sensorium-supervisor-windows-amd64.exe"
$InstalledBinaryName = "sensorium-supervisor.exe"

$DataDir = Join-Path $env:USERPROFILE ".remote-copilot-mcp"
$BinDir = Join-Path $DataDir "bin"
$Binary = Join-Path $BinDir $InstalledBinaryName
$BinaryMetadata = Join-Path $BinDir "$InstalledBinaryName.release.json"
$ConfigFile = Join-Path $DataDir "install.config.json"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupLauncher = Join-Path $StartupDir "SensoriumSupervisor.cmd"

# ── Config File ──────────────────────────────────────────────────────────────
$Defaults = @{
    SecureVaultProfile = "SENSORIUM"
    UpdateMode         = "production"
    MCPStartCommand    = "npx -y sensorium-mcp@latest"
}

function Load-Config {
    if (Test-Path -LiteralPath $ConfigFile) {
        try {
            $saved = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
            $cfg = @{}
            foreach ($key in $Defaults.Keys) {
                $val = $saved.$key
                $cfg[$key] = if (![string]::IsNullOrWhiteSpace($val)) { $val } else { $Defaults[$key] }
            }
            return $cfg
        }
        catch {
            Write-Host "[WARN] Failed to read $ConfigFile — using defaults." -ForegroundColor Yellow
        }
    }
    return $Defaults.Clone()
}

function Save-Config([hashtable]$cfg) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    [pscustomobject]$cfg | ConvertTo-Json | Set-Content -LiteralPath $ConfigFile -Encoding UTF8
}

# Load config (writes defaults on first run)
$Config = Load-Config

# Resolve effective values
$SecureVaultProfile = $Config["SecureVaultProfile"]
$UpdateMode = $Config["UpdateMode"]
$EffectiveMCPStartCommand = $Config["MCPStartCommand"]

# Validate config values
if ($UpdateMode -notin @("production", "development")) {
    Write-Host "[WARN] Invalid UpdateMode '$UpdateMode' in config — falling back to 'production'" -ForegroundColor Yellow
    $UpdateMode = "production"
    $Config["UpdateMode"] = "production"
}

# Persist (so next run picks up any overrides)
Save-Config $Config

# ── Helpers ──────────────────────────────────────────────────────────────────
function Stop-SupervisorProcess {
    $procs = Get-Process -Name "sensorium-supervisor" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Stopping background sensorium-supervisor process(es)..."
        $procs | Stop-Process -Force
        Write-Host "Process(es) stopped." -ForegroundColor Yellow
    }
}

function Get-ReleaseAssetInfo {
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

    return [pscustomobject]@{
        ReleaseTag     = $ReleaseTag
        ReleaseName    = $release.name
        AssetId        = [string]$asset.id
        AssetName      = $asset.name
        AssetSize      = [int64]$asset.size
        AssetUpdatedAt = $asset.updated_at
        DownloadUrl    = $asset.browser_download_url
    }
}

function Test-BinaryUpToDate {
    param(
        [string]$Destination,
        [string]$MetadataPath,
        [pscustomobject]$AssetInfo
    )

    if (-not (Test-Path -LiteralPath $Destination)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $MetadataPath)) {
        return $false
    }

    try {
        $metadata = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
        if ($null -eq $metadata) {
            return $false
        }

        return (
            $metadata.AssetId -eq $AssetInfo.AssetId -and
            $metadata.AssetName -eq $AssetInfo.AssetName -and
            [int64]$metadata.AssetSize -eq $AssetInfo.AssetSize
        )
    }
    catch {
        Write-Host "[WARN] Failed to read binary metadata at $MetadataPath - forcing refresh." -ForegroundColor Yellow
        return $false
    }
}

function Save-BinaryMetadata {
    param(
        [string]$MetadataPath,
        [pscustomobject]$AssetInfo
    )

    $metadata = [pscustomobject]@{
        ReleaseTag     = $AssetInfo.ReleaseTag
        ReleaseName    = $AssetInfo.ReleaseName
        AssetId        = $AssetInfo.AssetId
        AssetName      = $AssetInfo.AssetName
        AssetSize      = $AssetInfo.AssetSize
        AssetUpdatedAt = $AssetInfo.AssetUpdatedAt
        InstalledAt    = (Get-Date).ToString("o")
    }

    $metadata | ConvertTo-Json | Set-Content -LiteralPath $MetadataPath -Encoding ASCII
}

function Get-BinaryAsset {
    param(
        [string]$Destination,
        [string]$MetadataPath,
        [pscustomobject]$AssetInfo
    )

    $downloadUrl = $AssetInfo.DownloadUrl
    Write-Host "Downloading $($AssetInfo.AssetName) from $downloadUrl ..."

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
    Save-BinaryMetadata -MetadataPath $MetadataPath -AssetInfo $AssetInfo
    Write-Host "Binary placed at: $Destination" -ForegroundColor Green
}

function Install-StartupLauncher {
    # Copy this script to bin/ so startup doesn't depend on repo checkout
    $installedScript = Join-Path $BinDir "Install-Sensorium.ps1"
    if ($PSCommandPath -ne $installedScript) {
        Copy-Item $PSCommandPath $installedScript -Force
    }

    # Resolve the full path to pwsh at install time (we know it exists — we're running in it)
    $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
    if (-not $pwshPath) { $pwshPath = "pwsh" }

    $launcherContent = @(
        "@echo off",
        "`"$pwshPath`" -NoProfile -File `"$installedScript`""
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

# Step 3 — fetch release metadata and download only when needed
$assetInfo = Get-ReleaseAssetInfo
$binaryUpToDate = Test-BinaryUpToDate -Destination $Binary -MetadataPath $BinaryMetadata -AssetInfo $assetInfo

if ($binaryUpToDate) {
    Write-Host "Installed binary already matches release asset '$($assetInfo.AssetName)' - skipping download." -ForegroundColor Green
}
else {
    Get-BinaryAsset -Destination $Binary -MetadataPath $BinaryMetadata -AssetInfo $assetInfo
}

# Step 4 — install launcher and start
Install-StartupLauncher
Start-Supervisor

# Step 5 — verify
Show-Status
