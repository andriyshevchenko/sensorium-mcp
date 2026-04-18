namespace Sensorium.Supervisor.Services;

public interface ISingletonLock : IDisposable
{
    /// <summary>
    /// Acquires the lock. Reclaims a stale lock if the previous owner PID is no longer alive.
    /// Returns false if another live instance holds the lock.
    /// </summary>
    bool Acquire();

    /// <summary>Releases the lock file.</summary>
    void Release();
}
