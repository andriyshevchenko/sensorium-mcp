using System.Net;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor.Tests;

// Shared test doubles used across multiple test files.
// No Moq in this project — all fakes are hand-rolled.

internal sealed class FakeProcessManager : IProcessManager
{
    public bool IsAliveResult { get; set; }
    public (bool ok, int pid) PidFileResult { get; set; } = (false, 0);
    public int SpawnCount { get; private set; }
    public int KillDirectCount { get; private set; }
    public int KillCount { get; private set; }

    public Task<int> SpawnMcpServerAsync(CancellationToken ct = default)
    {
        SpawnCount++;
        return Task.FromResult(1234);
    }
    public Task KillProcessDirectAsync(int pid) { KillDirectCount++; return Task.CompletedTask; }
    public Task KillProcessAsync(int pid) { KillCount++; return Task.CompletedTask; }
    public Task KillByPortAsync(int port) => Task.CompletedTask;
    public bool IsProcessAlive(int pid) => IsAliveResult;
    public Task<(bool ok, int pid)> ReadPidFileAsync(string path) => Task.FromResult(PidFileResult);
    public Task WritePidFileAsync(string path, int pid) => Task.CompletedTask;
}

internal sealed class FakeMcpClient : IMcpClient
{
    public bool IsReadyResult { get; set; } = true;
    public Task<bool> IsServerReadyAsync(CancellationToken ct = default) => Task.FromResult(IsReadyResult);
    public Task<bool> WaitForReadyAsync(TimeSpan pollInterval, TimeSpan timeout, CancellationToken ct = default)
        => Task.FromResult(IsReadyResult);
    public Task<bool> PrepareShutdownAsync(CancellationToken ct = default) => Task.FromResult(true);
}

internal sealed class FakeSnapshotManager : ISnapshotManager
{
    public List<SnapshotInfo> Snapshots { get; set; } = [];
    public SnapshotRestoreResult RestoreResult { get; set; } = new(true, "ok");
    public List<SnapshotInfo> ListSnapshots() => Snapshots;
    public SnapshotRestoreResult Restore(string snapshotName) => RestoreResult;
}

internal sealed class FakeSingletonLock : ISingletonLock
{
    public bool AcquireResult { get; set; } = true;
    public bool AcquireCalled { get; private set; }
    public bool ReleaseCalled { get; private set; }
    public bool Acquire() { AcquireCalled = true; return AcquireResult; }
    public void Release() { ReleaseCalled = true; }
    public void Dispose() => Release();
}

internal sealed class FakeTelegramNotifier : ITelegramNotifier
{
    public int NotifyCount { get; private set; }
    public Task NotifyAsync(string text, int threadId = 0, CancellationToken ct = default)
    {
        NotifyCount++;
        return Task.CompletedTask;
    }
}

internal sealed class FakeHttpHandler : HttpMessageHandler
{
    public string ResponseJson { get; set; } = """{"ok":true,"result":[]}""";
    public List<HttpRequestMessage> Requests { get; } = [];
    public List<string> SentBodies { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        if (request.Content != null)
            SentBodies.Add(await request.Content.ReadAsStringAsync(cancellationToken));
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(ResponseJson, System.Text.Encoding.UTF8, "application/json")
        };
    }
}

internal sealed class FakeHttpClientFactory : IHttpClientFactory
{
    private readonly HttpClient _client;
    public FakeHttpClientFactory(HttpClient client) => _client = client;
    public HttpClient CreateClient(string name) => _client;
}
