using System.Reflection;
using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Tests;

/// <summary>
/// Tests for SupervisorWorker using mocked dependencies.
/// ExecuteAsync is called via reflection (the method is protected on BackgroundService).
/// Timing-sensitive tests use short intervals (20ms) with generous wait windows (400ms+).
/// </summary>
public class SupervisorWorkerTests : IDisposable
{
    private readonly string _tmpDir;

    public SupervisorWorkerTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "sv-worker-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tmpDir);
    }

    // ── Factory helpers ───────────────────────────────────────────────────────

    private record WorkerBundle(
        SupervisorWorker Worker,
        FakeProcessManager Proc,
        FakeMcpClient Mcp,
        FakeSingletonLock Lock);

    private WorkerBundle MakeWorker(Action<SupervisorOptions>? configure = null)
    {
        var proc   = new FakeProcessManager();
        var mcp    = new FakeMcpClient { IsReadyResult = true };
        var slock  = new FakeSingletonLock { AcquireResult = true };
        var notify = new FakeTelegramNotifier();

        var opts = new SupervisorOptions
        {
            McpHttpPort          = 9999,
            DataDir              = _tmpDir,
            StartupDelay         = TimeSpan.FromMilliseconds(1),
            HealthCheckInterval  = TimeSpan.FromMilliseconds(20),
            HttpCheckEveryNTicks = 1,
            HealthFailThresh     = 1,
            ReadyPollInterval    = TimeSpan.FromMilliseconds(1),
            McpReadyTimeout      = TimeSpan.FromMilliseconds(50),
            Paths = new SupervisorPaths
            {
                ServerPid       = Path.Combine(_tmpDir, "server.pid"),
                SupervisorLog   = Path.Combine(_tmpDir, "logs", "supervisor.log"),
                McpStderrLog    = Path.Combine(_tmpDir, "logs", "mcp-stderr.log"),
                MaintenanceFlag = Path.Combine(_tmpDir, "maintenance.flag"),
                PollerLock      = Path.Combine(_tmpDir, "poller.lock"),
                SupervisorLock  = Path.Combine(_tmpDir, "supervisor.lock"),
            }
        };
        configure?.Invoke(opts);

        var worker = new SupervisorWorker(
            Options.Create(opts), slock, proc, mcp, notify,
            NullLogger<SupervisorWorker>.Instance);

        return new WorkerBundle(worker, proc, mcp, slock);
    }

    private static Task InvokeExecuteAsync(SupervisorWorker worker, CancellationToken ct) =>
        (Task)typeof(SupervisorWorker)
            .GetMethod("ExecuteAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(worker, [ct])!;

    // ── Config validation ─────────────────────────────────────────────────────

    [Fact]
    public async Task InvalidPort_ThrowsInvalidOperationException()
    {
        var b = MakeWorker(o => o.McpHttpPort = 0);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => InvokeExecuteAsync(b.Worker, CancellationToken.None));
    }

    // ── Lock acquisition ──────────────────────────────────────────────────────

    [Fact]
    public async Task LockAcquisitionFails_ThrowsInvalidOperationException()
    {
        var b = MakeWorker();
        b.Lock.AcquireResult = false;

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => InvokeExecuteAsync(b.Worker, CancellationToken.None));
    }

    [Fact]
    public async Task Worker_AcquiresLockBeforeStarting()
    {
        var b = MakeWorker();
        b.Proc.PidFileResult = (false, 0);

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        try { await InvokeExecuteAsync(b.Worker, cts.Token); } catch (OperationCanceledException) { }

        Assert.True(b.Lock.AcquireCalled);
    }

    // ── Startup: spawn vs inherit ─────────────────────────────────────────────

    [Fact]
    public async Task Worker_SpawnsMcpOnStart_WhenNoPriorProcess()
    {
        var b = MakeWorker();
        b.Proc.PidFileResult = (false, 0); // no existing MCP

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        try { await InvokeExecuteAsync(b.Worker, cts.Token); } catch (OperationCanceledException) { }

        Assert.True(b.Proc.SpawnCount >= 1);
    }

    [Fact]
    public async Task Worker_InheritsExistingHealthyMcp_DoesNotSpawn()
    {
        var b = MakeWorker();
        b.Proc.PidFileResult = (true, 1234);
        b.Proc.IsAliveResult = true;
        b.Mcp.IsReadyResult  = true; // health check passes → inherit

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        try { await InvokeExecuteAsync(b.Worker, cts.Token); } catch (OperationCanceledException) { }

        Assert.Equal(0, b.Proc.SpawnCount);
    }

    // ── Health loop ───────────────────────────────────────────────────────────

    [Fact]
    public async Task Worker_RestartsMcp_WhenProcessDiesInHealthLoop()
    {
        var b = MakeWorker();
        // ReadPidFile always returns (false, 0) → process "dead" on every health tick
        b.Proc.PidFileResult = (false, 0);
        b.Mcp.IsReadyResult  = true;

        // Allow multiple health ticks to fire (20ms interval, 400ms window = ~20 ticks)
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(400));
        try { await InvokeExecuteAsync(b.Worker, cts.Token); } catch (OperationCanceledException) { }

        // Initial spawn + at least 1 health-loop restart
        Assert.True(b.Proc.SpawnCount >= 2);
    }

    // ── Shutdown ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task Worker_KillsMcp_OnGracefulShutdown()
    {
        var b = MakeWorker();
        // Inherit an existing healthy MCP so SpawnCount stays 0 and shutdown kills it
        b.Proc.PidFileResult = (true, 1234);
        b.Proc.IsAliveResult = true;
        b.Mcp.IsReadyResult  = true;

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        try { await InvokeExecuteAsync(b.Worker, cts.Token); } catch (OperationCanceledException) { }

        // Graceful shutdown: PrepareShutdown + KillProcessDirect
        Assert.True(b.Proc.KillDirectCount >= 1);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}
