namespace Sensorium.Supervisor.Services;

public interface IMcpClient
{
    /// <summary>OPTIONS /mcp — returns true if status &lt; 500.</summary>
    Task<bool> IsServerReadyAsync(CancellationToken ct = default);

    /// <summary>Polls until the server is ready or timeout elapses.</summary>
    Task<bool> WaitForReadyAsync(TimeSpan pollInterval, TimeSpan timeout, CancellationToken ct = default);

    /// <summary>POST /api/prepare-shutdown — best-effort, caller proceeds regardless.</summary>
    Task<bool> PrepareShutdownAsync(CancellationToken ct = default);
}
