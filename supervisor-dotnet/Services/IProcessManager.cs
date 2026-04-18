namespace Sensorium.Supervisor.Services;

public interface IProcessManager
{
    /// <summary>
    /// Spawns the MCP server process. On Windows uses CreateProcess with
    /// CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP.
    /// Returns the PID on success.
    /// </summary>
    Task<int> SpawnMcpServerAsync(CancellationToken ct = default);

    /// <summary>Kill only the specific PID (no tree kill). Windows: taskkill /F /PID.</summary>
    Task KillProcessDirectAsync(int pid);

    /// <summary>Kill the process tree. Windows: taskkill /F /T /PID. Unix: SIGTERM then SIGKILL.</summary>
    Task KillProcessAsync(int pid);

    /// <summary>Find any process listening on the port and kill it (Windows orphan cleanup).</summary>
    Task KillByPortAsync(int port);

    /// <summary>Check whether a process with the given PID is alive.</summary>
    bool IsProcessAlive(int pid);

    /// <summary>Read PID from file. Supports JSON {"pid":123} and raw integer.</summary>
    Task<(bool ok, int pid)> ReadPidFileAsync(string path);

    /// <summary>Write PID to file in JSON format {"pid":123}.</summary>
    Task WritePidFileAsync(string path, int pid);
}
