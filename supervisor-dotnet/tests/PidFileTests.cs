using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor.Tests;

public class PidFileTests : IDisposable
{
    private readonly string _tmpDir;
    private readonly ProcessManager _pm;

    public PidFileTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "supervisor-pid-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tmpDir);

        var opts = Options.Create(new SupervisorOptions
        {
            DataDir = _tmpDir,
            McpHttpPort = 9999,
            Paths = new SupervisorPaths
            {
                ServerPid = Path.Combine(_tmpDir, "server.pid"),
                McpStderrLog = Path.Combine(_tmpDir, "mcp-stderr.log"),
            }
        });
        _pm = new ProcessManager(opts, NullLogger<ProcessManager>.Instance);
    }

    [Fact]
    public async Task WriteThenRead_JsonFormat()
    {
        string pidPath = Path.Combine(_tmpDir, "test.pid");
        await _pm.WritePidFileAsync(pidPath, 12345);

        string content = await File.ReadAllTextAsync(pidPath);
        Assert.Contains("\"pid\"", content);
        Assert.Contains("12345", content);

        var (ok, pid) = await _pm.ReadPidFileAsync(pidPath);
        Assert.True(ok);
        Assert.Equal(12345, pid);
    }

    [Fact]
    public async Task Read_RawIntFormat()
    {
        string pidPath = Path.Combine(_tmpDir, "raw.pid");
        await File.WriteAllTextAsync(pidPath, "99999");

        var (ok, pid) = await _pm.ReadPidFileAsync(pidPath);
        Assert.True(ok);
        Assert.Equal(99999, pid);
    }

    [Fact]
    public async Task Read_MissingFile_ReturnsFalse()
    {
        var (ok, pid) = await _pm.ReadPidFileAsync(Path.Combine(_tmpDir, "missing.pid"));
        Assert.False(ok);
        Assert.Equal(0, pid);
    }

    [Fact]
    public async Task Read_InvalidContent_ReturnsFalse()
    {
        string pidPath = Path.Combine(_tmpDir, "bad.pid");
        await File.WriteAllTextAsync(pidPath, "not-a-pid");

        var (ok, pid) = await _pm.ReadPidFileAsync(pidPath);
        Assert.False(ok);
        Assert.Equal(0, pid);
    }

    [Fact]
    public async Task Write_IsAtomic_TempFileRemoved()
    {
        string pidPath = Path.Combine(_tmpDir, "atomic.pid");
        await _pm.WritePidFileAsync(pidPath, 55555);

        // Only the final file should exist, no .tmp. files
        var tmpFiles = Directory.GetFiles(_tmpDir, "*.tmp.*");
        Assert.Empty(tmpFiles);
        Assert.True(File.Exists(pidPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}
