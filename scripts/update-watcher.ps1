param(
    [ValidateSet("production", "development")]
    [string]$Mode = "production"
)

<#
.SYNOPSIS
    Sensorium MCP Server Auto-Update Watcher
#>

# ============================================================================
# Configuration
# ============================================================================

$POLL_AT_HOUR = 4
$MCP_START_COMMAND = "securevault run npx -y sensorium-mcp@latest --profile SENSORIUM"
$POLL_INTERVAL_SECONDS = 60
$GRACE_PERIOD_SECONDS = 300
$MIN_UPTIME_SECONDS = 600
$DATA_DIR = "$env:USERPROFILE\.remote-copilot-mcp"
$MAINTENANCE_FLAG = "$DATA_DIR\maintenance.flag"
$VERSION_FILE = "$DATA_DIR\current-version.txt"
$NPX_CACHE_DIR = "$env:LOCALAPPDATA\npm-cache\_npx"
$REGISTRY_URL = "https://registry.npmjs.org/sensorium-mcp/latest"

# Normalize mode (safety)
$Mode = $Mode.ToLower()

# ============================================================================
# Helpers
# ============================================================================

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

function Get-RemoteVersion {
    try {
        $response = Invoke-RestMethod -Uri $REGISTRY_URL -ErrorAction Stop
        return $response.version
    }
    catch {
        Write-Log "Failed to fetch remote version: $_" -Level "ERROR"
        return $null
    }
}

function Get-LocalVersion {
    if (Test-Path $VERSION_FILE) {
        $version = (Get-Content $VERSION_FILE -Raw).Trim()
        if ($version) { return $version }
    }
    return $null
}

function Set-LocalVersion {
    param([string]$Version)
    if (-not (Test-Path $DATA_DIR)) {
        New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
    }
    $Version | Out-File -FilePath $VERSION_FILE -Encoding utf8 -NoNewline
}

function Write-MaintenanceFlag {
    param([string]$NewVersion)
    if (-not (Test-Path $DATA_DIR)) {
        New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
    }
    $content = @{
        version   = $NewVersion
        timestamp = (Get-Date -Format "o")
    } | ConvertTo-Json -Compress

    $content | Out-File -FilePath $MAINTENANCE_FLAG -Encoding utf8 -Force
    Write-Log "Maintenance flag written: $MAINTENANCE_FLAG"
}

function Remove-MaintenanceFlag {
    if (Test-Path $MAINTENANCE_FLAG) {
        Remove-Item -Path $MAINTENANCE_FLAG -Force
        Write-Log "Maintenance flag removed."
    }
}

function Stop-McpServer {
    Write-Log "Searching for running sensorium-mcp processes..."

    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match "sensorium-mcp" }

    if ($processes) {
        foreach ($proc in $processes) {
            try {
                Write-Log "Stopping PID=$($proc.ProcessId)"
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            }
            catch {
                Write-Log "Failed to stop PID=$($proc.ProcessId): $_" -Level "WARN"
            }
        }
        Start-Sleep -Seconds 2
    }
    else {
        Write-Log "No running sensorium-mcp processes found." -Level "WARN"
    }
}

function Stop-StaleProcesses {
    <#
    .SYNOPSIS
        Kill sensorium-mcp processes that were started before the last update.
        Compares each process CreationDate against the VERSION_FILE last-write
        time. If a process predates the version file, it's running old code.
    #>
    if (-not (Test-Path $VERSION_FILE)) { return }
    $versionFileTime = (Get-Item $VERSION_FILE).LastWriteTime

    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match "sensorium-mcp" }

    if (-not $processes) { return }

    foreach ($proc in $processes) {
        $ageSec = ($versionFileTime - $proc.CreationDate).TotalSeconds
        if ($proc.CreationDate -lt $versionFileTime -and $ageSec -gt 60) {
            Write-Log "Killing stale process PID=$($proc.ProcessId) (started $($proc.CreationDate), version file updated $versionFileTime)" -Level "WARN"
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            }
            catch {
                Write-Log "Failed to kill stale PID=$($proc.ProcessId): $_" -Level "WARN"
            }
        }
    }
}

function Clear-NpxCache {
    if (Test-Path $NPX_CACHE_DIR) {
        Write-Log "Clearing npx cache..."
        try {
            Get-ChildItem -Path $NPX_CACHE_DIR -Force | Remove-Item -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-Log "Failed to fully clear npx cache: $_" -Level "WARN"
        }
    }
}

function Start-McpServer {
    Write-Log "Starting MCP server..."

    try {
        $parts = $MCP_START_COMMAND -split " ", 2
        Start-Process -FilePath $parts[0] -ArgumentList $parts[1] -WindowStyle Hidden | Out-Null
    }
    catch {
        Write-Log "Failed to start MCP server: $_" -Level "ERROR"
    }
}

function Test-McpServerRunning {
    # First check: is anything listening on the MCP HTTP port?
    $port = if ($env:MCP_HTTP_PORT) { $env:MCP_HTTP_PORT } else { 3847 }
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) { return $true }

    # Fallback: check for sensorium-mcp node processes
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "sensorium-mcp" }

    return ($processes.Count -gt 0)
}

# ============================================================================
# Update Logic
# ============================================================================

function Invoke-UpdateCheck {

    $timeSinceStart = (Get-Date) - $script:lastStartTime
    if ($timeSinceStart.TotalSeconds -gt $STARTUP_GRACE_SECONDS -and -not (Test-McpServerRunning)) {
        Write-Log "Server not running, restarting..." -Level "WARN"
        Start-McpServer
        $script:lastStartTime = Get-Date
    }

    $remoteVersion = Get-RemoteVersion
    if (-not $remoteVersion) { return }

    $localVersion = Get-LocalVersion

    if (-not $localVersion) {
        Set-LocalVersion $remoteVersion
        return
    }

    if ($remoteVersion -eq $localVersion) {
        Write-Log "Up to date: v$localVersion"
        return
    }

    $uptime = (Get-Date) - $script:lastStartTime
    if ($uptime.TotalSeconds -lt $MIN_UPTIME_SECONDS) {
        Write-Log "Deferring update (uptime too low)" -Level "WARN"
        return
    }

    Write-Log "Updating $localVersion → $remoteVersion"

    Write-MaintenanceFlag $remoteVersion
    Start-Sleep $GRACE_PERIOD_SECONDS

    Stop-McpServer
    Clear-NpxCache

    # Set version BEFORE starting server so stale detection won't kill the new process
    Set-LocalVersion $remoteVersion

    Start-McpServer

    # Wait for new process to start, then kill any leftover old-version processes
    Start-Sleep -Seconds 10
    Stop-StaleProcesses

    $script:lastStartTime = Get-Date

    Remove-MaintenanceFlag

    Write-Log "Update complete."
}

function Get-SecondsUntilHour {
    param([int]$Hour)

    $now = Get-Date
    $target = Get-Date -Hour $Hour -Minute 0 -Second 0

    if ($target -le $now) {
        $target = $target.AddDays(1)
    }

    return [math]::Ceiling(($target - $now).TotalSeconds)
}

# ============================================================================
# Startup
# ============================================================================

Write-Log "Watcher started (Mode: $Mode)"

$script:lastStartTime = [datetime]::MinValue
$STARTUP_GRACE_SECONDS = 30

# Kill any leftover processes running outdated versions
Stop-StaleProcesses

if (-not (Test-McpServerRunning)) {
    Start-McpServer
    $script:lastStartTime = Get-Date
}

# ============================================================================
# Main Loop
# ============================================================================

if ($Mode -eq "production") {

    while ($true) {
        $sleep = Get-SecondsUntilHour $POLL_AT_HOUR
        Write-Log "Next check in $sleep seconds"
        Start-Sleep $sleep

        try { Invoke-UpdateCheck }
        catch {
            Write-Log "Error: $_" -Level "ERROR"
            Remove-MaintenanceFlag
        }
    }

} else {

    Write-Log "Development mode polling every $POLL_INTERVAL_SECONDS sec"

    while ($true) {
        try {
            Stop-StaleProcesses
            Invoke-UpdateCheck
        }
        catch {
            Write-Log "Error: $_" -Level "ERROR"
            Remove-MaintenanceFlag
        }

        Start-Sleep $POLL_INTERVAL_SECONDS
    }
}