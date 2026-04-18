namespace Sensorium.Supervisor.Services;

public interface ITelegramNotifier
{
    /// <summary>
    /// Sends a message to the operator via Telegram.
    /// Silent no-op if Telegram credentials are not configured.
    /// Never throws — failures are logged.
    /// </summary>
    Task NotifyAsync(string text, int threadId = 0, CancellationToken ct = default);
}
