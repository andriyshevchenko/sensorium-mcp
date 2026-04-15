#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install or update sensorium-supervisor from GitHub Releases.
.DESCRIPTION
    Downloads the latest sensorium-supervisor.exe from GitHub Releases
    (tag: supervisor-latest, repo: andriyshevchenko/sensorium-mcp) and places
    it in ~/.remote-copilot-mcp/bin/.

    If running as Administrator, registers and manages a Windows Service named
    'SensoriumSupervisor'. Otherwise starts the supervisor as a background process.

    Re-running this script performs an update: stops the existing service/process,
    replaces the binary, then restarts.
.PARAMETER Update
    Explicitly force update mode even if the binary doesn't exist yet (no-op difference
    for fresh installs — included for scripted pipelines that always pass -Update).
.EXAMPLE
    .\Install-Sensorium.ps1
    .\Install-Sensorium.ps1 -Update
#>
param(
    [switch]$Update
)

$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────
$GithubRepo   = "andriyshevchenko/sensorium-mcp"
$ReleaseTag   = "supervisor-latest"
$AssetName    = "sensorium-supervisor.exe"
$ServiceName  = "SensoriumSupervisor"
$ServiceDesc  = "Sensorium MCP Supervisor — manages the sensorium-mcp npx process"

$DataDir = Join-Path $env:USERPROFILE ".remote-copilot-mcp"
$BinDir  = Join-Path $DataDir "bin"
$Binary  = Join-Path $BinDir $AssetName

# ── Helpers ──────────────────────────────────────────────────────────────────
function Test-IsAdmin {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ServiceState {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) { return $svc.Status } else { return $null }
}

function Stop-SupervisorService {
    $state = Get-ServiceState
    if ($state -eq "Running") {
        Write-Host "Stopping Windows Service '$ServiceName'..."
        Stop-Service -Name $ServiceName -Force
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-ServiceState) -eq "Running" -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        if ((Get-ServiceState) -eq "Running") {
            throw "Service '$ServiceName' did not stop within 15 seconds."
        }
        Write-Host "Service stopped." -ForegroundColor Yellow
    }
}

function Stop-SupervisorProcess {
    $procs = Get-Process -Name "sensorium-supervisor" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Stopping background sensorium-supervisor process(es)..."
        $procs | Stop-Process -Force
        Write-Host "Process(es) stopped." -ForegroundColor Yellow
    }
}

function Download-Binary {
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
    Write-Host "Binary placed at: $Destination" -ForegroundColor Green
}

function Install-AsService {
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

    if ($existing) {
        Write-Host "Updating existing service '$ServiceName'..."
        # sc.exe config is the most reliable way to update the binary path
        $result = sc.exe config $ServiceName binPath= "`"$Binary`""
        if ($LASTEXITCODE -ne 0) {
            throw "sc.exe config failed (exit $LASTEXITCODE): $result"
        }
    } else {
        Write-Host "Registering Windows Service '$ServiceName'..."
        $result = sc.exe create $ServiceName binPath= "`"$Binary`"" start= auto DisplayName= $ServiceName
        if ($LASTEXITCODE -ne 0) {
            throw "sc.exe create failed (exit $LASTEXITCODE): $result"
        }
        sc.exe description $ServiceName $ServiceDesc | Out-Null
    }

    Write-Host "Starting service '$ServiceName'..."
    Start-Service -Name $ServiceName -ErrorAction Stop
}

function Start-AsBackground {
    Write-Host "Starting sensorium-supervisor as a background process (non-admin mode)..."
    $logOut = Join-Path $DataDir "supervisor.log"
    $logErr = Join-Path $DataDir "supervisor-error.log"
    Start-Process -FilePath $Binary `
                  -RedirectStandardOutput $logOut `
                  -RedirectStandardError  $logErr `
                  -WindowStyle Hidden `
                  -PassThru | Out-Null
    Start-Sleep -Seconds 2
}

function Show-Status {
    param([bool]$IsAdminContext)
    if ($IsAdminContext) {
        $state = Get-ServiceState
        if ($state -eq "Running") {
            Write-Host "`n[OK] Service '$ServiceName' is RUNNING." -ForegroundColor Green
        } else {
            Write-Host "`n[WARN] Service '$ServiceName' state: $state" -ForegroundColor Yellow
        }
    } else {
        $procs = Get-Process -Name "sensorium-supervisor" -ErrorAction SilentlyContinue
        if ($procs) {
            Write-Host "`n[OK] sensorium-supervisor is RUNNING (PID: $(($procs | Select-Object -ExpandProperty Id) -join ', '))." -ForegroundColor Green
        } else {
            Write-Host "`n[WARN] sensorium-supervisor process not found after install." -ForegroundColor Yellow
        }
    }
}

# ── Main ─────────────────────────────────────────────────────────────────────
$isAdmin       = Test-IsAdmin
$alreadyExists = Test-Path $Binary
$isUpdate      = $Update -or $alreadyExists

Write-Host ""
if ($isUpdate) {
    Write-Host "=== Sensorium Supervisor UPDATE ===" -ForegroundColor Cyan
} else {
    Write-Host "=== Sensorium Supervisor INSTALL ===" -ForegroundColor Cyan
}
Write-Host "Admin mode : $isAdmin"
Write-Host "Binary     : $Binary"
Write-Host ""

# Step 1 — stop existing instance
if ($isUpdate) {
    if ($isAdmin) {
        Stop-SupervisorService
    } else {
        Stop-SupervisorProcess
    }
}

# Step 2 — ensure bin dir exists
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

# Step 3 — download binary
Download-Binary -Destination $Binary

# Step 4 — register / start
if ($isAdmin) {
    Install-AsService
} else {
    Write-Host "Not running as Administrator — skipping service registration." -ForegroundColor Yellow
    Start-AsBackground
}

# Step 5 — verify
Show-Status -IsAdminContext $isAdmin
