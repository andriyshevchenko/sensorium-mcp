using System.Text;
using Microsoft.Extensions.Logging;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Services;

/// <summary>
/// Handles the Windows apply-helper pattern for self-update.
/// A running .exe cannot overwrite itself on Windows, so we launch a detached
/// .cmd helper that waits for this process to exit, swaps the binary, then
/// relaunches the supervisor from shell:startup.
/// </summary>
public static class SelfUpdate
{
    private const string RollbackMarkerTag = "rollback_attempted=true";

    /// <summary>
    /// Checks for a pending binary and launches the apply helper on Windows.
    /// On Unix, applies directly via File.Move.
    /// Returns true if the process should exit to allow the update to proceed.
    /// </summary>
    public static bool ApplyPendingUpdate(SupervisorOptions opts, ILogger log)
    {
        RecordApplyFailureIfPresent(opts, log);

        if (!File.Exists(opts.Paths.PendingBinary))
        {
            // Clean up stale version file if present
            if (File.Exists(opts.Paths.PendingVersion))
            {
                log.LogWarning("Removing stale pending supervisor version file {Path}", opts.Paths.PendingVersion);
                TryDelete(opts.Paths.PendingVersion);
            }
            return false;
        }

        string exePath = System.Environment.ProcessPath
            ?? throw new InvalidOperationException("Cannot resolve current executable path");

        if (OperatingSystem.IsWindows())
        {
            try
            {
                LaunchWindowsApplyHelper(opts, exePath);
                log.LogInformation("Pending supervisor update detected; launching apply helper and exiting");
                return true; // caller should exit
            }
            catch (Exception ex)
            {
                MarkApplyFailure(opts, log, $"schedule pending supervisor apply: {ex.Message}");
                Cleanup(opts, log);
                return false;
            }
        }
        else
        {
            // Unix: directly replace the binary
            try
            {
                File.Move(opts.Paths.PendingBinary, exePath, overwrite: true);
                FinalizePendingVersion(opts, log);
                log.LogInformation("Applied supervisor update");
                return false;
            }
            catch (Exception ex)
            {
                Cleanup(opts, log);
                log.LogWarning(ex, "Failed to apply pending supervisor binary");
                return false;
            }
        }
    }

    public static void LaunchWindowsApplyHelper(SupervisorOptions opts, string exePath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(opts.Paths.SupervisorVersion)!);

        // GetTempFileName creates a zero-byte file; we need a .cmd extension for cmd.exe
        // to execute it correctly. Delete the placeholder and use a .cmd path instead.
        string tempBase = Path.GetTempFileName();
        File.Delete(tempBase);
        var scriptPath = tempBase + ".cmd";
        var script = BuildApplyScript(opts, exePath);

        File.WriteAllText(scriptPath, script, Encoding.ASCII);

        var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c \"{scriptPath}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            RedirectStandardInput = false
        };
        // Detach
        var proc = System.Diagnostics.Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start apply helper process");
        proc.Dispose();
    }

    private static string BuildApplyScript(SupervisorOptions opts, string exePath)
    {
        static string Q(string p) => "\"" + p.Replace("\"", "\"\"") + "\"";

        string markerPath = opts.Paths.ApplyFailureMarker;
        string failReason = $"helper failed to swap pending supervisor binary after retries (pending={opts.Paths.PendingBinary} current={exePath})"
            .Replace("%", "%%").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ");

        var sb = new StringBuilder();
        sb.AppendLine("@echo off");
        sb.AppendLine("setlocal");
        sb.AppendLine(":wait");
        sb.AppendLine($"tasklist /FI \"PID eq {System.Environment.ProcessId}\" 2>NUL | find \"{System.Environment.ProcessId}\" >NUL");
        sb.AppendLine("if not errorlevel 1 (");
        sb.AppendLine("  timeout /T 1 /NOBREAK >NUL");
        sb.AppendLine("  goto wait");
        sb.AppendLine(")");
        sb.AppendLine("set attempts=0");
        sb.AppendLine(":move");
        sb.AppendLine($"move /Y {Q(opts.Paths.PendingBinary)} {Q(exePath)} >NUL");
        sb.AppendLine("if not errorlevel 1 goto applied");
        sb.AppendLine("set /a attempts+=1");
        sb.AppendLine("if %attempts% GEQ 5 goto fail");
        sb.AppendLine("timeout /T 1 /NOBREAK >NUL");
        sb.AppendLine("goto move");
        sb.AppendLine(":applied");
        sb.AppendLine($"if exist {Q(opts.Paths.PendingVersion)} move /Y {Q(opts.Paths.PendingVersion)} {Q(opts.Paths.SupervisorVersion)} >NUL");
        sb.AppendLine($"if exist {Q(markerPath)} del /F /Q {Q(markerPath)}");
        sb.AppendLine($"start \"\" {Q(exePath)}");
        sb.AppendLine("exit /b 0");
        sb.AppendLine(":fail");
        sb.AppendLine($"set \"FAIL_REASON={failReason}\"");
        sb.AppendLine($"<nul set /p \"=%FAIL_REASON%\" > {Q(markerPath)}");
        sb.AppendLine($"if exist {Q(opts.Paths.PendingBinary)} del /F /Q {Q(opts.Paths.PendingBinary)}");
        sb.AppendLine($"if exist {Q(opts.Paths.PendingVersion)} del /F /Q {Q(opts.Paths.PendingVersion)}");
        sb.AppendLine($"start \"\" {Q(exePath)}");
        sb.AppendLine("exit /b 1");

        return sb.ToString();
    }

    private static void RecordApplyFailureIfPresent(SupervisorOptions opts, ILogger log)
    {
        if (!File.Exists(opts.Paths.ApplyFailureMarker)) return;

        string reason = "";
        try { reason = File.ReadAllText(opts.Paths.ApplyFailureMarker).Trim(); }
        catch (Exception ex) { log.LogWarning(ex, "Failed to read apply failure marker"); }

        if (string.IsNullOrEmpty(reason))
            reason = "pending supervisor apply helper reported failure";

        log.LogWarning("Supervisor apply failure detected: {Reason}", reason);
        TryDelete(opts.Paths.ApplyFailureMarker);
    }

    public static void MarkApplyFailure(SupervisorOptions opts, ILogger log, string reason)
    {
        if (!reason.Contains(RollbackMarkerTag))
            reason = reason.TrimEnd() + "; " + RollbackMarkerTag;

        log.LogError("Supervisor apply failure: {Reason}", reason);

        // Persist to disk so RecordApplyFailureIfPresent can surface it on next startup.
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(opts.Paths.ApplyFailureMarker)!);
            File.WriteAllText(opts.Paths.ApplyFailureMarker, reason);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Failed to write apply failure marker to {Path}", opts.Paths.ApplyFailureMarker);
        }
    }

    private static void FinalizePendingVersion(SupervisorOptions opts, ILogger log)
    {
        try
        {
            if (!File.Exists(opts.Paths.PendingVersion)) return;
            var version = File.ReadAllText(opts.Paths.PendingVersion).Trim();
            var tmp = opts.Paths.SupervisorVersion + ".tmp." + System.Environment.ProcessId;
            File.WriteAllText(tmp, version);
            File.Move(tmp, opts.Paths.SupervisorVersion, overwrite: true);
            TryDelete(opts.Paths.PendingVersion);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Applied update but failed to persist version");
        }
    }

    private static void Cleanup(SupervisorOptions opts, ILogger log)
    {
        foreach (var path in new[] { opts.Paths.PendingBinary, opts.Paths.PendingVersion })
        {
            try { File.Delete(path); }
            catch (Exception ex) { log.LogWarning(ex, "Failed to remove stale artifact {Path}", path); }
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* best-effort */ }
    }
}
