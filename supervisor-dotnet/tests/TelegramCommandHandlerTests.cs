using System.Reflection;
using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor.Tests;

public class TelegramCommandHandlerTests : IDisposable
{
    private readonly string _tmpDir;
    private readonly FakeProcessManager _proc;
    private readonly FakeMcpClient _mcp;
    private readonly FakeSnapshotManager _snapshots;
    private readonly FakeHttpHandler _httpHandler;
    private readonly TelegramCommandHandler _handler;

    public TelegramCommandHandlerTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "sv-cmd-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tmpDir);

        _proc      = new FakeProcessManager { PidFileResult = (true, 1234), IsAliveResult = true };
        _mcp       = new FakeMcpClient();
        _snapshots = new FakeSnapshotManager();
        _httpHandler = new FakeHttpHandler();

        var httpClient = new HttpClient(_httpHandler) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

        var opts = Options.Create(new SupervisorOptions
        {
            TelegramToken      = "test-token",
            TelegramOperatorId = 99001,
            McpHttpPort        = 9999,
            DataDir            = _tmpDir,
            Paths = new SupervisorPaths
            {
                ServerPid       = Path.Combine(_tmpDir, "server.pid"),
                MaintenanceFlag = Path.Combine(_tmpDir, "maintenance.flag"),
                PollerLock      = Path.Combine(_tmpDir, "poller.lock"),
                SnapshotsDir    = Path.Combine(_tmpDir, "snapshots"),
            }
        });

        _handler = new TelegramCommandHandler(
            opts,
            new FakeHttpClientFactory(httpClient),
            _proc, _mcp, _snapshots,
            NullLogger<TelegramCommandHandler>.Instance);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Task InvokeHandleCommand(string text, string replyChatId = "12345") =>
        (Task)typeof(TelegramCommandHandler)
            .GetMethod("HandleCommandAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(_handler, [text, replyChatId, CancellationToken.None])!;

    private Task<long> InvokePollOnce(string responseJson, long offset = 0)
    {
        _httpHandler.ResponseJson = responseJson;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        return (Task<long>)typeof(TelegramCommandHandler)
            .GetMethod("PollOnceAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(_handler, [offset, cts.Token])!;
    }

    // ── Command parsing / dispatch ────────────────────────────────────────────

    [Fact]
    public async Task StatusCommand_IncludesSupervisorStatusInfo()
    {
        await InvokeHandleCommand("/sv status");

        Assert.Single(_httpHandler.SentBodies);
        Assert.Contains("Supervisor Status", _httpHandler.SentBodies[0]);
    }

    [Fact]
    public async Task RestartCommand_SpawnsMcpServer()
    {
        await InvokeHandleCommand("/sv restart");

        Assert.True(_proc.SpawnCount >= 1);
    }

    [Fact]
    public async Task SnapshotsCommand_EmptyList_ReportsNoSnapshots()
    {
        _snapshots.Snapshots = [];

        await InvokeHandleCommand("/sv snapshots");

        Assert.Contains("No snapshots", _httpHandler.SentBodies[0]);
    }

    [Fact]
    public async Task SnapshotsCommand_WithItems_ListsSnapshotNames()
    {
        _snapshots.Snapshots =
        [
            new SnapshotInfo("backup-2026", DateTimeOffset.UtcNow, 2 * 1024 * 1024, "3.0.0")
        ];

        await InvokeHandleCommand("/sv snapshots");

        Assert.Contains("backup-2026", _httpHandler.SentBodies[0]);
    }

    [Fact]
    public async Task RestoreCommand_WithName_ReturnsSuccessMessage()
    {
        _snapshots.RestoreResult = new(true, "restored ok");

        await InvokeHandleCommand("/sv restore backup-2026");

        Assert.Contains("restored", _httpHandler.SentBodies[0]);
    }

    [Fact]
    public async Task RestoreCommand_MissingName_ReturnsUsageHint()
    {
        await InvokeHandleCommand("/sv restore");

        Assert.Contains("Usage", _httpHandler.SentBodies[0]);
    }

    [Fact]
    public async Task RestoreCommand_WhenRestoreFails_ReturnsErrorMessage()
    {
        _snapshots.RestoreResult = new(false, "snapshot not found");

        await InvokeHandleCommand("/sv restore missing");

        Assert.Contains("Restore failed", _httpHandler.SentBodies[0]);
    }

    [Fact]
    public async Task NukeCommand_SpawnsMcpAfterKill()
    {
        int before = _proc.SpawnCount;

        await InvokeHandleCommand("/sv nuke");

        Assert.True(_proc.SpawnCount > before);
    }

    [Fact]
    public async Task UnknownCommand_ReturnsHelpText()
    {
        await InvokeHandleCommand("/sv unknowncmd");

        Assert.Contains("Supervisor Commands", _httpHandler.SentBodies[0]);
    }

    // ── Auth filtering ────────────────────────────────────────────────────────

    [Fact]
    public async Task AuthFiltering_NonPrivateMessage_NoReplySent()
    {
        // Group/supergroup message — not a private chat, must be ignored
        await InvokePollOnce("""
            {
                "ok": true,
                "result": [{
                    "update_id": 42,
                    "message": {
                        "text": "/status",
                        "chat": { "id": 99001, "type": "supergroup" },
                        "from": { "id": 99001 }
                    }
                }]
            }
            """);

        // Only the GET getUpdates request — no POST sendMessage
        Assert.All(_httpHandler.Requests, r => Assert.Equal(HttpMethod.Get, r.Method));
    }

    [Fact]
    public async Task DmCommand_FromAuthorizedOperator_ExecutesCommand()
    {
        // Private chat from the configured operator ID, bare "status" command
        await InvokePollOnce("""
            {
                "ok": true,
                "result": [{
                    "update_id": 43,
                    "message": {
                        "text": "/status",
                        "chat": { "id": 99001, "type": "private" },
                        "from": { "id": 99001 }
                    }
                }]
            }
            """);

        Assert.Contains(_httpHandler.SentBodies, b => b.Contains("Supervisor Status"));
    }

    [Fact]
    public async Task DmCommand_WithSvPrefix_ReturnsHelpNotStatus()
    {
        // "/sv status" in DM is not a recognised simple command — falls through to help
        await InvokePollOnce("""
            {
                "ok": true,
                "result": [{
                    "update_id": 45,
                    "message": {
                        "text": "/sv status",
                        "chat": { "id": 99001, "type": "private" },
                        "from": { "id": 99001 }
                    }
                }]
            }
            """);

        Assert.Contains(_httpHandler.SentBodies, b => b.Contains("Supervisor Commands"));
    }

    [Fact]
    public async Task DmCommand_WithNoFromField_NoReplySent()
    {
        // Channel post forwarded to DM — no "from" field; must be silently ignored
        await InvokePollOnce("""
            {
                "ok": true,
                "result": [{
                    "update_id": 46,
                    "message": {
                        "text": "/status",
                        "chat": { "id": 99001, "type": "private" }
                    }
                }]
            }
            """);

        Assert.All(_httpHandler.Requests, r => Assert.Equal(HttpMethod.Get, r.Method));
    }

    [Fact]
    public async Task DmCommand_WhenOperatorIdNotConfigured_NoReplySent()
    {
        // Handler with no TelegramOperatorId set — DMs must be silently ignored
        var opts = Options.Create(new SupervisorOptions
        {
            TelegramToken  = "test-token",
            TelegramChatId = "12345",
            // TelegramOperatorId deliberately omitted
            McpHttpPort    = 9999,
            DataDir        = _tmpDir,
            Paths = new SupervisorPaths
            {
                ServerPid       = Path.Combine(_tmpDir, "server.pid"),
                MaintenanceFlag = Path.Combine(_tmpDir, "maintenance.flag"),
                PollerLock      = Path.Combine(_tmpDir, "poller.lock"),
            }
        });
        var fakeHttp = new FakeHttpHandler();
        using var handler = new TelegramCommandHandler(
            opts, new FakeHttpClientFactory(new HttpClient(fakeHttp) { Timeout = System.Threading.Timeout.InfiniteTimeSpan }),
            _proc, _mcp, _snapshots,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<TelegramCommandHandler>.Instance);

        fakeHttp.ResponseJson = """
            {
                "ok": true,
                "result": [{
                    "update_id": 47,
                    "message": {
                        "text": "/status",
                        "chat": { "id": 99001, "type": "private" },
                        "from": { "id": 99001 }
                    }
                }]
            }
            """;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await (Task<long>)typeof(TelegramCommandHandler)
            .GetMethod("PollOnceAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(handler, [0L, cts.Token])!;

        Assert.All(fakeHttp.Requests, r => Assert.Equal(HttpMethod.Get, r.Method));
    }

    [Fact]
    public async Task DmCommand_FromUnauthorizedUser_NoReplySent()
    {
        // Private chat from a different user — should be silently ignored
        await InvokePollOnce("""
            {
                "ok": true,
                "result": [{
                    "update_id": 44,
                    "message": {
                        "text": "/status",
                        "chat": { "id": 77777, "type": "private" },
                        "from": { "id": 77777 }
                    }
                }]
            }
            """);

        Assert.All(_httpHandler.Requests, r => Assert.Equal(HttpMethod.Get, r.Method));
    }

    // ── Error handling ────────────────────────────────────────────────────────

    [Fact]
    public async Task ExceptionInCommand_SendsErrorReply_DoesNotCrash()
    {
        var throwingProc = new ThrowOnSpawnProcessManager();
        var fakeHttp = new FakeHttpHandler();
        var httpClient = new HttpClient(fakeHttp) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };

        var opts = Options.Create(new SupervisorOptions
        {
            TelegramToken      = "test-token",
            TelegramOperatorId = 99001,
            McpHttpPort        = 9999,
            DataDir            = _tmpDir,
            Paths = new SupervisorPaths
            {
                ServerPid       = Path.Combine(_tmpDir, "s2.pid"),
                MaintenanceFlag = Path.Combine(_tmpDir, "m2.flag"),
                PollerLock      = Path.Combine(_tmpDir, "p2.lock"),
            }
        });

        using var handler = new TelegramCommandHandler(
            opts, new FakeHttpClientFactory(httpClient),
            throwingProc, _mcp, _snapshots,
            NullLogger<TelegramCommandHandler>.Instance);

        await (Task)typeof(TelegramCommandHandler)
            .GetMethod("HandleCommandAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(handler, ["/sv restart", "12345", CancellationToken.None])!;

        Assert.Single(fakeHttp.SentBodies);
        Assert.Contains("Error", fakeHttp.SentBodies[0]);
    }

    public void Dispose()
    {
        _handler.Dispose();
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}

// File-scoped to avoid conflicts with other test files
file sealed class ThrowOnSpawnProcessManager : IProcessManager
{
    public Task<int> SpawnMcpServerAsync(CancellationToken ct = default)
        => throw new InvalidOperationException("spawn error for test");
    public Task KillProcessDirectAsync(int pid) => Task.CompletedTask;
    public Task KillProcessAsync(int pid) => Task.CompletedTask;
    public Task KillByPortAsync(int port) => Task.CompletedTask;
    public bool IsProcessAlive(int pid) => false;
    public Task<(bool ok, int pid)> ReadPidFileAsync(string path) => Task.FromResult((true, 1234));
    public Task WritePidFileAsync(string path, int pid) => Task.CompletedTask;
}
