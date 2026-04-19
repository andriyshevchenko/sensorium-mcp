using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Services;

public sealed class SingletonLock : ISingletonLock
{
    private readonly string _lockPath;
    private readonly ILogger<SingletonLock> _log;
    private bool _held;

    public SingletonLock(IOptions<SupervisorOptions> opts, ILogger<SingletonLock> log)
    {
        _lockPath = opts.Value.Paths.SupervisorLock;
        _log = log;
    }

    public bool Acquire()
    {
        try
        {
            // Atomic create (O_CREAT | O_EXCL equivalent)
            using var fs = new FileStream(_lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var w = new StreamWriter(fs);
            w.Write(Environment.ProcessId.ToString());
            _held = true;
            _log.LogInformation("Lock acquired: {LockPath} (PID {Pid})", _lockPath, Environment.ProcessId);
            return true;
        }
        catch (IOException)
        {
            // File exists — check if stale
            return TryReclaim();
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to acquire singleton lock {LockPath}", _lockPath);
            return false;
        }
    }

    private bool TryReclaim()
    {
        try
        {
            var content = File.ReadAllText(_lockPath).Trim();
            if (int.TryParse(content, out int pid) && pid > 0 && IsProcessAlive(pid))
            {
                _log.LogError("Another supervisor is running (PID {Pid}). Lock: {LockPath}", pid, _lockPath);
                return false;
            }

            _log.LogWarning("Reclaimed stale supervisor lock (old PID {OldPid})", content);
            File.Delete(_lockPath);

            // Re-acquire atomically
            using var fs = new FileStream(_lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var w = new StreamWriter(fs);
            w.Write(Environment.ProcessId.ToString());
            _held = true;
            _log.LogInformation("Lock acquired (after reclaim): {LockPath} (PID {Pid})", _lockPath, Environment.ProcessId);
            return true;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to reclaim stale lock {LockPath}", _lockPath);
            return false;
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            using var proc = Process.GetProcessById(pid);
            return !proc.HasExited;
        }
        catch
        {
            return false;
        }
    }

    public void Release()
    {
        if (!_held) return;
        try
        {
            File.Delete(_lockPath);
            _held = false;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to release singleton lock {LockPath}", _lockPath);
        }
    }

    public void Dispose() => Release();
}
