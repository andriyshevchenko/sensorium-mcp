using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor.Tests;

public class SingletonLockTests : IDisposable
{
    private readonly string _tmpDir;

    public SingletonLockTests()
    {
        _tmpDir = Path.Combine(Path.GetTempPath(), "supervisor-lock-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tmpDir);
    }

    private SingletonLock MakeLock(string? lockPath = null)
    {
        var path = lockPath ?? Path.Combine(_tmpDir, "test.lock");
        var opts = Options.Create(new SupervisorOptions
        {
            Paths = new SupervisorPaths { SupervisorLock = path }
        });
        return new SingletonLock(opts, NullLogger<SingletonLock>.Instance);
    }

    [Fact]
    public void Acquire_Succeeds_WhenNoLockExists()
    {
        using var slock = MakeLock();
        bool ok = slock.Acquire();
        Assert.True(ok);
    }

    [Fact]
    public void Acquire_WritesOwnPid()
    {
        string lockPath = Path.Combine(_tmpDir, "pid.lock");
        using var slock = MakeLock(lockPath);
        slock.Acquire();

        string content = File.ReadAllText(lockPath).Trim();
        Assert.Equal(Environment.ProcessId.ToString(), content);
    }

    [Fact]
    public void Release_DeletesLockFile()
    {
        string lockPath = Path.Combine(_tmpDir, "rel.lock");
        using var slock = MakeLock(lockPath);
        slock.Acquire();
        Assert.True(File.Exists(lockPath));

        slock.Release();
        Assert.False(File.Exists(lockPath));
    }

    [Fact]
    public void Acquire_Fails_WhenLiveInstanceHoldsLock()
    {
        string lockPath = Path.Combine(_tmpDir, "live.lock");

        // Write our own PID as the "other" instance (it's alive)
        File.WriteAllText(lockPath, Environment.ProcessId.ToString());

        using var slock = MakeLock(lockPath);
        bool ok = slock.Acquire();
        Assert.False(ok);
    }

    [Fact]
    public void Acquire_Reclaims_StaleLock()
    {
        string lockPath = Path.Combine(_tmpDir, "stale.lock");

        // Write a PID that is almost certainly dead
        File.WriteAllText(lockPath, "99999999");

        using var slock = MakeLock(lockPath);
        bool ok = slock.Acquire();
        Assert.True(ok);

        // Our PID should now be in the file
        string content = File.ReadAllText(lockPath).Trim();
        Assert.Equal(Environment.ProcessId.ToString(), content);
    }

    [Fact]
    public void Dispose_ReleasesLock()
    {
        string lockPath = Path.Combine(_tmpDir, "disp.lock");
        var slock = MakeLock(lockPath);
        slock.Acquire();
        slock.Dispose();
        Assert.False(File.Exists(lockPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}
