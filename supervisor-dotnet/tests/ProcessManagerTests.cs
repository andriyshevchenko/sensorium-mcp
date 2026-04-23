using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor.Tests;

/// <summary>
/// Tests for ProcessManager that complement the existing PidFileTests.
/// Focuses on IsProcessAlive behaviour and read/write round-trips.
/// </summary>
public class ProcessManagerTests : IDisposable
{
    private readonly string _tmpDir;
    private readonly ProcessManager _pm;

    public ProcessManagerTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "sv-procmgr-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tmpDir);

        var opts = Options.Create(new SupervisorOptions
        {
            DataDir     = _tmpDir,
            McpHttpPort = 9999,
            Paths = new SupervisorPaths
            {
                ServerPid    = Path.Combine(_tmpDir, "server.pid"),
                McpStderrLog = Path.Combine(_tmpDir, "logs", "mcp-stderr.log"),
            }
        });
        _pm = new ProcessManager(opts, NullLogger<ProcessManager>.Instance);
    }

    // ── IsProcessAlive ────────────────────────────────────────────────────────

    [Fact]
    public void IsProcessAlive_NonexistentPid_ReturnsFalse()
    {
        Assert.False(_pm.IsProcessAlive(999_999_999));
    }

    [Fact]
    public void IsProcessAlive_CurrentProcess_ReturnsTrue()
    {
        Assert.True(_pm.IsProcessAlive(Environment.ProcessId));
    }

    [Fact]
    public void IsProcessAlive_ZeroPid_ReturnsFalse()
    {
        Assert.False(_pm.IsProcessAlive(0));
    }

    [Fact]
    public void IsProcessAlive_NegativePid_ReturnsFalse()
    {
        Assert.False(_pm.IsProcessAlive(-1));
    }

    // ── ReadPidFileAsync formats ──────────────────────────────────────────────

    [Fact]
    public async Task ReadPidFile_JsonFormat_ParsesCorrectly()
    {
        string pidPath = Path.Combine(_tmpDir, "json.pid");
        await File.WriteAllTextAsync(pidPath, """{"pid":42001}""");

        var (ok, pid) = await _pm.ReadPidFileAsync(pidPath);

        Assert.True(ok);
        Assert.Equal(42001, pid);
    }

    [Fact]
    public async Task ReadPidFile_RawIntFormat_ParsesCorrectly()
    {
        string pidPath = Path.Combine(_tmpDir, "raw.pid");
        await File.WriteAllTextAsync(pidPath, "42002\n");

        var (ok, pid) = await _pm.ReadPidFileAsync(pidPath);

        Assert.True(ok);
        Assert.Equal(42002, pid);
    }

    // ── Write / read round-trip ───────────────────────────────────────────────

    [Fact]
    public async Task WritePidFile_ThenRead_PreservesValue()
    {
        string pidPath = Path.Combine(_tmpDir, "roundtrip.pid");
        await _pm.WritePidFileAsync(pidPath, 55123);

        var (ok, pid) = await _pm.ReadPidFileAsync(pidPath);

        Assert.True(ok);
        Assert.Equal(55123, pid);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}
