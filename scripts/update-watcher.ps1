<#
.SYNOPSIS
    Sensorium MCP Server Auto-Update Watcher

.DESCRIPTION
    Continuously polls the npm registry for new versions of sensorium-mcp.
    When a new version is detected, it:
      1. Writes a maintenance flag file so agents can gracefully wind down
      2. Waits a grace period for agents to notice and call sleep
      3. Stops the running MCP server process
      4. Clears the npx cache to force a fresh download
      5. Restarts the MCP server
      6. Removes the maintenance flag file

.USAGE
    # Run directly (keeps running in foreground):
    powershell -ExecutionPolicy Bypass -File .\scripts\update-watcher.ps1

    # Run in background as a job:
    Start-Job -FilePath .\scripts\update-watcher.ps1

.NOTES
    Requires: Node.js / npm / npx on PATH
    Configure the variables in the "Configuration" section below.
#>

# ============================================================================
# Configuration
# ============================================================================

$MCP_START_COMMAND = "securevault run npx -y sensorium-mcp@latest --profile SENSORIUM"
$POLL_INTERVAL_SECONDS = 60
$GRACE_PERIOD_SECONDS = 180
$DATA_DIR = "$env:USERPROFILE\.remote-copilot-mcp"
$MAINTENANCE_FLAG = "$DATA_DIR\maintenance.flag"
$VERSION_FILE = "$DATA_DIR\current-version.txt"
$NPX_CACHE_DIR = "$env:LOCALAPPDATA\npm-cache\_npx"
$REGISTRY_URL = "https://registry.npmjs.org/sensorium-mcp/latest"

# ============================================================================
# Helpers
# ============================================================================

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

function Get-RemoteVersion {
    <#
    .SYNOPSIS
        Fetches the latest published version of sensorium-mcp from the npm registry.
    #>
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
    <#
    .SYNOPSIS
        Reads the currently installed version from the version file on disk.
    #>
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
    <#
    .SYNOPSIS
        Finds and stops node processes running sensorium-mcp.
    #>
    Write-Log "Searching for running sensorium-mcp processes..."

    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "sensorium-mcp" }

    if ($processes) {
        foreach ($proc in $processes) {
            try {
                Write-Log "Stopping process PID=$($proc.ProcessId): $($proc.CommandLine)"
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-Log "Process PID=$($proc.ProcessId) stopped."
            }
            catch {
                Write-Log "Failed to stop PID=$($proc.ProcessId): $_" -Level "WARN"
            }
        }
        # Brief pause to let OS release handles
        Start-Sleep -Seconds 2
    }
    else {
        Write-Log "No running sensorium-mcp processes found." -Level "WARN"
    }
}

function Clear-NpxCache {
    <#
    .SYNOPSIS
        Removes the npx cache directory contents to force a fresh package download.
    #>
    if (Test-Path $NPX_CACHE_DIR) {
        Write-Log "Clearing npx cache at: $NPX_CACHE_DIR"
        try {
            Get-ChildItem -Path $NPX_CACHE_DIR -Force | Remove-Item -Recurse -Force -ErrorAction Stop
            Write-Log "npx cache cleared."
        }
        catch {
            Write-Log "Failed to fully clear npx cache: $_" -Level "WARN"
        }
    }
    else {
        Write-Log "npx cache directory does not exist, skipping." -Level "WARN"
    }
}

function Start-McpServer {
    <#
    .SYNOPSIS
        Starts the MCP server in a new detached process using the configured command.
    #>
    Write-Log "Starting MCP server: $MCP_START_COMMAND"
    try {
        $parts = $MCP_START_COMMAND -split " ", 2
        $executable = $parts[0]
        $arguments = if ($parts.Length -gt 1) { $parts[1] } else { "" }

        Start-Process -FilePath $executable `
            -ArgumentList $arguments `
            -WindowStyle Hidden `
            -PassThru | Out-Null

        Write-Log "MCP server started successfully."
    }
    catch {
        Write-Log "Failed to start MCP server: $_" -Level "ERROR"
    }
}

function Test-McpServerRunning {
    <#
    .SYNOPSIS
        Returns $true if a node process running sensorium-mcp is found.
    #>
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "sensorium-mcp" }
    return ($null -ne $processes -and @($processes).Count -gt 0)
}

# ============================================================================
# Main Loop
# ============================================================================

Write-Log "=========================================="
Write-Log "Sensorium MCP Update Watcher started."
Write-Log "Poll interval : ${POLL_INTERVAL_SECONDS}s"
Write-Log "Grace period  : ${GRACE_PERIOD_SECONDS}s"
Write-Log "Data directory: $DATA_DIR"
Write-Log "=========================================="

# Ensure data directory exists
if (-not (Test-Path $DATA_DIR)) {
    New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null
    Write-Log "Created data directory: $DATA_DIR"
}

# --- Ensure MCP server is running on startup ---
$script:lastStartTime = [datetime]::MinValue
$STARTUP_GRACE_SECONDS = 30  # Don't health-check for this long after starting

if (-not (Test-McpServerRunning)) {
    Write-Log "MCP server is not running. Starting it now..."
    Start-McpServer
    $script:lastStartTime = Get-Date
    Start-Sleep -Seconds 10
    if (Test-McpServerRunning) {
        Write-Log "MCP server started successfully on initial launch."
    }
    else {
        Write-Log "MCP server may still be starting up. Will check again after grace period." -Level "WARN"
    }
}
else {
    Write-Log "MCP server is already running."
}

while ($true) {
    try {
        # --- Health check: restart server if it crashed ---
        # Skip if we recently started the server (npx needs time to download/start)
        $timeSinceStart = (Get-Date) - $script:lastStartTime
        if ($timeSinceStart.TotalSeconds -gt $STARTUP_GRACE_SECONDS -and -not (Test-McpServerRunning)) {
            Write-Log "MCP server process not found - restarting..." -Level "WARN"
            Start-McpServer
            $script:lastStartTime = Get-Date
        }

        # --- Step 1: Fetch the latest remote version ---
        $remoteVersion = Get-RemoteVersion
        if (-not $remoteVersion) {
            Write-Log "Could not determine remote version. Will retry in ${POLL_INTERVAL_SECONDS}s." -Level "WARN"
            Start-Sleep -Seconds $POLL_INTERVAL_SECONDS
            continue
        }

        # --- Step 2: Compare with local version ---
        $localVersion = Get-LocalVersion
        if (-not $localVersion) {
            Write-Log "No local version recorded. Saving current remote version ($remoteVersion) as baseline."
            Set-LocalVersion -Version $remoteVersion
            Start-Sleep -Seconds $POLL_INTERVAL_SECONDS
            continue
        }

        if ($remoteVersion -eq $localVersion) {
            Write-Log "Up to date: v$localVersion"
            Start-Sleep -Seconds $POLL_INTERVAL_SECONDS
            continue
        }

        # --- Step 3: New version detected - begin update sequence ---
        Write-Log "=========================================="
        Write-Log "NEW VERSION DETECTED: v$localVersion -> v$remoteVersion"
        Write-Log "=========================================="

        # 3a. Write maintenance flag
        Write-MaintenanceFlag -NewVersion $remoteVersion

        # 3b. Grace period for agents to wind down
        Write-Log "Waiting ${GRACE_PERIOD_SECONDS}s grace period for agents to enter sleep..."
        Start-Sleep -Seconds $GRACE_PERIOD_SECONDS

        # 3c. Stop the MCP server
        Stop-McpServer

        # 3d. Clear npx cache
        Clear-NpxCache

        # 3e. Start the MCP server again
        Start-McpServer

        # 3f. Record new version
        Set-LocalVersion -Version $remoteVersion
        Write-Log "Version file updated to v$remoteVersion."

        # 3g. Remove maintenance flag
        Remove-MaintenanceFlag

        Write-Log "=========================================="
        Write-Log "Update to v$remoteVersion complete."
        Write-Log "=========================================="
    }
    catch {
        Write-Log "Unhandled error in main loop: $_" -Level "ERROR"
        Write-Log $_.ScriptStackTrace -Level "ERROR"

        # Clean up maintenance flag if it was left behind
        Remove-MaintenanceFlag
    }

    Start-Sleep -Seconds $POLL_INTERVAL_SECONDS
}
