#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install, update, inspect, or remove the Sensorium supervisor Scheduled Task.
.DESCRIPTION
    Creates a per-user Scheduled Task named SensoriumSupervisorTask that runs
    the installed supervisor binary when the current user logs on.
.PARAMETER Uninstall
    Remove the scheduled task.
.PARAMETER Status
    Show current task status and basic details.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

$TaskName = "SensoriumSupervisorTask"
$BinaryPath = Join-Path $env:USERPROFILE ".remote-copilot-mcp\bin\sensorium-supervisor-windows-amd64.exe"

function Get-Task {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Show-TaskStatus {
    $task = Get-Task
    if (-not $task) {
        Write-Host "[INFO] Scheduled Task '$TaskName' is not installed." -ForegroundColor Yellow
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "[OK] Scheduled Task '$TaskName' is installed." -ForegroundColor Green
    Write-Host "       State      : $($task.State)"
    Write-Host "       Last Run   : $($info.LastRunTime)"
    Write-Host "       Last Result: $($info.LastTaskResult)"
    Write-Host "       Next Run   : $($info.NextRunTime)"
    Write-Host "       User       : $($task.Principal.UserId)"

    foreach ($action in $task.Actions) {
        Write-Host "       Action     : $($action.Execute) $($action.Arguments)"
    }
}

if ($Uninstall -and $Status) {
    Write-Error "Choose only one mode: -Uninstall or -Status."
    exit 2
}

try {
    $registerCmd = Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue
    if (-not $registerCmd) {
        throw "ScheduledTasks module is not available on this system."
    }

    if ($Status) {
        Show-TaskStatus
        exit 0
    }

    if ($Uninstall) {
        if (Get-Task) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "[OK] Removed Scheduled Task '$TaskName'." -ForegroundColor Green
        } else {
            Write-Host "[INFO] Scheduled Task '$TaskName' was not installed." -ForegroundColor Yellow
        }
        exit 0
    }

    if (-not (Test-Path -LiteralPath $BinaryPath)) {
        throw "Supervisor binary not found: $BinaryPath`nBuild or install it before registering the task."
    }

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ([string]::IsNullOrWhiteSpace($currentUser)) {
        throw "Could not resolve current Windows user identity."
    }

    $action = New-ScheduledTaskAction -Execute $BinaryPath
    $triggerAtLogon = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 10 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $triggerAtLogon `
        -Principal $principal `
        -Settings $settings `
        -Description "Starts Sensorium Supervisor in user context at user logon." `
        -Force | Out-Null

    Write-Host "[OK] Installed/updated Scheduled Task '$TaskName'." -ForegroundColor Green
    Write-Host "     Binary   : $BinaryPath"
    Write-Host "     Principal: $currentUser (RunLevel: Highest)"
    Write-Host "     Trigger  : AtLogOn (user context; starts after this user signs in)"
    Write-Host "     Runtime  : unlimited (ExecutionTimeLimit=0)"
    Write-Host "     Recovery : restart every 1 minute, up to 10 attempts"

    Show-TaskStatus
    exit 0
} catch {
    Write-Error "[ERROR] install-supervisor-task failed: $($_.Exception.Message)"
    exit 1
}
