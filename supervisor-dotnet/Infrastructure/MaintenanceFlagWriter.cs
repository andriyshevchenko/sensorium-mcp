using Microsoft.Extensions.Logging;

namespace Sensorium.Supervisor.Infrastructure;

/// <summary>
/// Shared helper for writing the maintenance flag file that signals active
/// MCP threads to stop polling and wait for the server to come back online.
/// </summary>
internal static class MaintenanceFlagWriter
{
    /// <summary>
    /// Writes a JSON maintenance flag to <paramref name="path"/>.
    /// Uses no-BOM UTF-8 to avoid JSON.parse issues in Node.js.
    /// </summary>
    public static void Write(string path, string version, ILogger logger)
    {
        try
        {
            var payload = System.Text.Json.JsonSerializer.Serialize(new
            {
                version,
                timestamp = DateTime.UtcNow.ToString("o")
            });
            File.WriteAllText(path, payload, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            logger.LogInformation("Maintenance flag written (version={Version})", version);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to write maintenance flag — threads will not receive graceful restart notice");
        }
    }
}
