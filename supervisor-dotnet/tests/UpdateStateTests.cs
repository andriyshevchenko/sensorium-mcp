using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Sensorium.Supervisor.Infrastructure;

namespace Sensorium.Supervisor.Tests;

public class UpdateStateTests : IDisposable
{
    private readonly string _tmpDir;

    public UpdateStateTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "supervisor-state-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tmpDir);
    }

    private UpdateStateStore MakeStore(string? fileName = null)
    {
        string path = Path.Combine(_tmpDir, fileName ?? "update-state.json");
        return new UpdateStateStore(path, NullLogger.Instance);
    }

    [Fact]
    public void Load_ReturnsIdleDefault_WhenFileAbsent()
    {
        var store = MakeStore("missing.json");
        var state = store.Load();

        Assert.Equal(UpdatePhase.Idle, state.Phase);
    }

    [Fact]
    public void Transition_PersistsState()
    {
        var store = MakeStore();
        store.Transition("supervisor", UpdatePhase.Staged, "1.2.0", "1.1.0");

        var state = store.Load();
        Assert.Equal(UpdatePhase.Staged, state.Phase);
        Assert.Equal("supervisor", state.Scope);
        Assert.Equal("1.2.0", state.TargetVersion);
        Assert.Equal("1.1.0", state.PreviousVersion);
    }

    [Fact]
    public void Transition_ToFailed_IncludesError()
    {
        var store = MakeStore();
        store.Transition("supervisor", UpdatePhase.Failed, "1.2.0", "1.1.0", "download timed out");

        var state = store.Load();
        Assert.Equal(UpdatePhase.Failed, state.Phase);
        Assert.Equal("download timed out", state.LastError);
    }

    [Fact]
    public void Transition_UpdatedAt_IsRecent()
    {
        var before = DateTimeOffset.UtcNow.AddSeconds(-1);
        var store = MakeStore();
        store.Transition("supervisor", UpdatePhase.Downloading, "1.2.0", "1.1.0");

        var state = store.Load();
        Assert.True(state.UpdatedAt >= before, "UpdatedAt should be recent");
    }

    [Fact]
    public void Load_CorruptFile_ReturnsDefault()
    {
        string path = Path.Combine(_tmpDir, "corrupt.json");
        File.WriteAllText(path, "{ invalid json !!!");

        var store = new UpdateStateStore(path, NullLogger.Instance);
        var state = store.Load();

        Assert.Equal(UpdatePhase.Idle, state.Phase);
    }

    [Fact]
    public void Transition_IsAtomic_NoTempFiles()
    {
        var store = MakeStore();
        store.Transition("supervisor", UpdatePhase.Staged, "1.0.0", "0.9.0");

        var tmpFiles = Directory.GetFiles(_tmpDir, "*.tmp.*");
        Assert.Empty(tmpFiles);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}
