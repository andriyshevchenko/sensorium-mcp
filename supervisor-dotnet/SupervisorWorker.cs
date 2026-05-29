using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Infrastructure;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor;

/// <summary>
/// Main supervisor loop as a Generic Host BackgroundService.
///
/// Startup sequence:
///   1. Acquire singleton lock
///   2. Check for existing healthy MCP → inherit if alive + ready
///   3. If not inherited: kill orphan, spawn fresh
///   4. Wait for MCP ready (ReadyPollInterval, McpReadyTimeout)
///   5. Run health check loop (PeriodicTimer at HealthCheckInterval)
///
/// Shutdown sequence:
///   1. Cancel health loop
///   2. PrepareShutdown → KillProcessDirect
///   3. Release lock
/// </summary>
public sealed class SupervisorWorker : BackgroundService
{
    private readonly SupervisorOptions _opts;
    private readonly ISingletonLock _lock;
    private readonly IProcessManager _proc;
    private readonly IMcpClient _mcp;
    private readonly ITelegramNotifier _notify;
    private readonly ILogger<SupervisorWorker> _log;

    public SupervisorWorker(
        IOptions<SupervisorOptions> opts,
        ISingletonLock @lock,
        IProcessManager proc,
        IMcpClient mcp,
        ITelegramNotifier notify,
        ILogger<SupervisorWorker> log)
    {
        _opts = opts.Value;
        _lock = @lock;
        _proc = proc;
        _mcp = mcp;
        _notify = notify;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // ── Validate config ─────────────────────────────────────────────────────
        if (_opts.McpHttpPort <= 0)
        {
            _log.LogCritical("MCP_HTTP_PORT must be set (got {Port}). Aborting.", _opts.McpHttpPort);
            throw new InvalidOperationException($"MCP_HTTP_PORT must be set (got {_opts.McpHttpPort})");
        }

        // ── Create data directories ──────────────────────────────────────────────
        Directory.CreateDirectory(_opts.DataDir);
        Directory.CreateDirectory(Path.GetDirectoryName(_opts.Paths.SupervisorLog)!);
        Directory.CreateDirectory(Path.GetDirectoryName(_opts.Paths.McpStderrLog)!);

        // ── Singleton lock ──────────────────────────────────────────────────────
        if (!_lock.Acquire())
        {
            _log.LogCritical("Another supervisor instance is already running. Exiting.");
            throw new InvalidOperationException("Another supervisor instance is already running.");
        }

        _log.LogInformation(
            "sensorium-supervisor starting (port={Port}, dataDir={DataDir})",
            _opts.McpHttpPort, _opts.DataDir);

        try
        {
            await RunAsync(stoppingToken).ConfigureAwait(false);
        }
        finally
        {
            _lock.Release();
            _log.LogInformation("Supervisor stopped cleanly");
        }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        // ── Check for existing healthy MCP to inherit ─────────────────────────
        bool inherited = false;
        var (pidOk, existingPid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
        if (pidOk && existingPid > 0 && _proc.IsProcessAlive(existingPid))
        {
            if (await _mcp.IsServerReadyAsync(ct).ConfigureAwait(false))
            {
                _log.LogInformation("Inherited running MCP server (PID {Pid}) — skipping full restart", existingPid);
                inherited = true;
            }
            else
            {
                _log.LogInformation("MCP process (PID {Pid}) did not pass health check — proceeding with full restart", existingPid);
            }
        }

        if (!inherited)
        {
            // Kill any orphan from previous run
            if (pidOk && existingPid > 0 && _proc.IsProcessAlive(existingPid))
            {
                _log.LogInformation("Killing orphan MCP server (PID {Pid}) from previous run", existingPid);
                // Write maintenance flag before killing so active threads get graceful notice
                MaintenanceFlagWriter.Write(_opts.Paths.MaintenanceFlag, "orphan-restart", _log);
                await _mcp.PrepareShutdownAsync(ct).ConfigureAwait(false);
                await _proc.KillProcessAsync(existingPid).ConfigureAwait(false);
                await Task.Delay(1000, ct).ConfigureAwait(false);
            }
            TryDeleteFile(_opts.Paths.ServerPid);
            await _proc.KillByPortAsync(_opts.McpHttpPort).ConfigureAwait(false);

            if (ct.IsCancellationRequested) return;

            // Clean up stale poller lock so the fresh MCP can always acquire it
            TryDeleteFile(_opts.Paths.PollerLock);

            // Spawn fresh MCP
            try
            {
                await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _log.LogCritical(ex, "Failed to start MCP server — aborting");
                throw;
            }

            // Give the process time to bind its port before we start probing
            _log.LogInformation("Waiting {Delay}s for MCP server to start up...", _opts.StartupDelay.TotalSeconds);
            await Task.Delay(_opts.StartupDelay, ct).ConfigureAwait(false);
        }

        // ── Wait for MCP to become ready ────────────────────────────────────────
        bool ready = await _mcp.WaitForReadyAsync(
            _opts.ReadyPollInterval, _opts.McpReadyTimeout, ct).ConfigureAwait(false);

        if (ready)
            _log.LogInformation("MCP server is ready");
        else
            _log.LogWarning("MCP server did not become ready in {Timeout} — proceeding anyway; clearing maintenance flag", _opts.McpReadyTimeout);

        // Clear maintenance flag now that MCP is accepting connections (or we've given up waiting).
        // Active threads watching the flag will stop sleeping and reconnect.
        TryDeleteFile(_opts.Paths.MaintenanceFlag);
        _log.LogInformation("Maintenance flag cleared — threads may reconnect");

        // ── Health check loop ────────────────────────────────────────────────────
        _log.LogInformation("All subsystems started — supervisor is running (PID {Pid})", Environment.ProcessId);

        using var timer = new PeriodicTimer(_opts.HealthCheckInterval);
        long tickCount = 0;
        int httpFailCount = 0;
        var lastTick = DateTimeOffset.UtcNow;
        // Hibernation threshold: if the time between ticks is > 3× the expected interval,
        // the system was likely asleep (suspended/hibernated).
        var wakeDetectionThreshold = _opts.HealthCheckInterval * 3;

        try
        {
            while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
            {
                tickCount++;
                var now = DateTimeOffset.UtcNow;
                var elapsed = now - lastTick;
                lastTick = now;

                // ── Hibernation/sleep detection ──────────────────────────────
                if (elapsed > wakeDetectionThreshold)
                {
                    _log.LogInformation(
                        "System wake detected: tick gap {Elapsed:F0}s (expected ~{Expected:F0}s)",
                        elapsed.TotalSeconds, _opts.HealthCheckInterval.TotalSeconds);

                    // Skip wake notification during maintenance (e.g. /nuke in progress)
                    if (!File.Exists(_opts.Paths.MaintenanceFlag))
                        await HandleSystemWakeAsync(ct).ConfigureAwait(false);
                }

                // Skip auto-restart when maintenance flag is present (e.g. after /nuke)
                if (File.Exists(_opts.Paths.MaintenanceFlag))
                {
                    _log.LogDebug("Maintenance flag present — skipping health check");
                    continue;
                }

                var (ok, pid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
                if (!ok || !_proc.IsProcessAlive(pid))
                {
                    _log.LogError("MCP server process is dead — restarting");
                    await _notify.NotifyAsync("⚠️ Supervisor: MCP server process died — restarting...", ct: ct)
                        .ConfigureAwait(false);
                    await _proc.KillByPortAsync(_opts.McpHttpPort).ConfigureAwait(false);
                    TryDeleteFile(_opts.Paths.PollerLock);
                    if (!ct.IsCancellationRequested)
                        await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);
                    httpFailCount = 0;
                    continue;
                }

                // HTTP liveness every N ticks
                if (tickCount % _opts.HttpCheckEveryNTicks == 0)
                {
                    if (await _mcp.IsServerReadyAsync(ct).ConfigureAwait(false))
                    {
                        httpFailCount = 0;
                    }
                    else
                    {
                        httpFailCount++;
                        _log.LogWarning("MCP server HTTP check failed ({Count}/{Thresh})",
                            httpFailCount, _opts.HealthFailThresh);

                        if (httpFailCount >= _opts.HealthFailThresh)
                        {
                            _log.LogError("MCP server not responding to HTTP — restarting");
                            await _notify.NotifyAsync(
                                "⚠️ Supervisor: MCP server hung (not responding to HTTP) — restarting...",
                                ct: ct).ConfigureAwait(false);

                            MaintenanceFlagWriter.Write(_opts.Paths.MaintenanceFlag, "hung-mcp-restart", _log);
                            await _mcp.PrepareShutdownAsync(ct).ConfigureAwait(false);
                            await _proc.KillProcessDirectAsync(pid).ConfigureAwait(false);
                            await _proc.KillByPortAsync(_opts.McpHttpPort).ConfigureAwait(false);
                            TryDeleteFile(_opts.Paths.PollerLock);

                            if (!ct.IsCancellationRequested)
                                await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);

                            bool hungReady = await _mcp.WaitForReadyAsync(_opts.ReadyPollInterval, _opts.McpReadyTimeout, ct)
                                .ConfigureAwait(false);
                            if (!hungReady)
                                _log.LogWarning("MCP server did not become ready after hung-MCP restart within {Timeout} — proceeding anyway", _opts.McpReadyTimeout);
                            TryDeleteFile(_opts.Paths.MaintenanceFlag);
                            _log.LogInformation("Maintenance flag cleared after hung-MCP restart");

                            httpFailCount = 0;
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown
        }

        // ── Graceful shutdown ────────────────────────────────────────────────────
        var (shutdownOk, shutdownPid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
        if (shutdownOk && shutdownPid > 0)
        {
            _log.LogInformation("Stopping MCP server (PID {Pid})", shutdownPid);
            await _mcp.PrepareShutdownAsync(CancellationToken.None).ConfigureAwait(false);
            await _proc.KillProcessDirectAsync(shutdownPid).ConfigureAwait(false);
        }
    }

    private async Task HandleSystemWakeAsync(CancellationToken ct)
    {
        // Give MCP a moment to recover (network stack, DNS, etc.)
        await Task.Delay(_opts.WakeRecoveryDelay, ct).ConfigureAwait(false);

        var (pidOk, pid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
        bool mcpAlive = pidOk && _proc.IsProcessAlive(pid);
        bool mcpReady = mcpAlive && await _mcp.IsServerReadyAsync(ct).ConfigureAwait(false);

        if (!mcpReady)
        {
            _log.LogWarning("MCP not ready after wake — waiting up to {Timeout}s...", _opts.WakeReadyTimeout.TotalSeconds);
            mcpReady = await _mcp.WaitForReadyAsync(
                _opts.ReadyPollInterval, _opts.WakeReadyTimeout, ct).ConfigureAwait(false);
        }

        if (!mcpReady)
        {
            _log.LogError("MCP not responding after wake — restarting immediately");
            await _notify.NotifyAsync(
                "⚠️ <b>System woke from sleep</b> — MCP server is NOT responding. Restarting...",
                ct: ct).ConfigureAwait(false);
            await _proc.KillByPortAsync(_opts.McpHttpPort).ConfigureAwait(false);
            TryDeleteFile(_opts.Paths.PollerLock);
            if (!ct.IsCancellationRequested)
                await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);
            return;
        }

        // Count alive thread processes from PID files
        int activeThreads = CountAliveThreads();

        var message = activeThreads > 0
            ? $"✅ <b>System woke from sleep</b> — MCP healthy, {activeThreads} thread(s) listening."
            : "⚠️ <b>System woke from sleep</b> — MCP healthy but no active threads detected.";

        _log.LogInformation("Post-wake status: MCP ready, active threads = {Count}", activeThreads);
        await _notify.NotifyAsync(message, ct: ct).ConfigureAwait(false);
    }

    private int CountAliveThreads()
    {
        var pidsDir = Path.Combine(_opts.DataDir, "pids");
        if (!Directory.Exists(pidsDir)) return 0;

        int count = 0;
        foreach (var file in Directory.EnumerateFiles(pidsDir, "*.pid"))
        {
            try
            {
                var content = File.ReadAllText(file);
                using var doc = JsonDocument.Parse(content);
                if (doc.RootElement.TryGetProperty("pid", out var pidProp))
                {
                    int threadPid = pidProp.GetInt32();
                    if (_proc.IsProcessAlive(threadPid))
                        count++;
                }
            }
            catch (Exception ex)
            {
                _log.LogDebug(ex, "Failed to read thread PID file {File}", file);
            }
        }
        return count;
    }

    private static void TryDeleteFile(string path)
    {
        try { File.Delete(path); } catch { /* best-effort */ }
    }

}
