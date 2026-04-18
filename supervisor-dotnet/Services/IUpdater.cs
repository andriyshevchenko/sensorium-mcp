namespace Sensorium.Supervisor.Services;

public interface IUpdater
{
    /// <summary>Starts the background update-check loop.</summary>
    void Start(CancellationToken ct);

    /// <summary>Stops the update loop and waits for it to finish.</summary>
    Task StopAsync();
}
