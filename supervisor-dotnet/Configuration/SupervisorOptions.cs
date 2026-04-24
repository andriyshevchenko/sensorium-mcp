namespace Sensorium.Supervisor.Configuration;

public sealed class SupervisorOptions
{
    public string McpStartCommand { get; set; } = "npx -y sensorium-mcp@latest";
    public string DataDir { get; set; } = "";
    public int McpHttpPort { get; set; }
    public string? McpHttpSecret { get; set; }
    public string? TelegramToken { get; set; }
    public string? TelegramChatId { get; set; }
    public long? TelegramOperatorId { get; set; }
    public int HealthFailThresh { get; set; } = 5;
    public TimeSpan McpReadyTimeout { get; set; } = TimeSpan.FromMinutes(5);
    /// <summary>How often the health check loop ticks. Default 60s.</summary>
    public TimeSpan HealthCheckInterval { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>How often WaitForReady polls during startup. Default 5s.</summary>
    public TimeSpan ReadyPollInterval { get; set; } = TimeSpan.FromSeconds(5);
    /// <summary>Fixed wait after MCP spawn before the first health check attempt. Default 30s.</summary>
    public TimeSpan StartupDelay { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>Run HTTP liveness check every N health-check ticks. Default 5 (= 5 min with 60s interval).</summary>
    public int HttpCheckEveryNTicks { get; set; } = 5;
    /// <summary>Telegram long-poll timeout in seconds for the command handler. Default 30.</summary>
    public int CommandPollTimeoutSeconds { get; set; } = 30;
    public SupervisorPaths Paths { get; set; } = new();
}

public sealed class SupervisorPaths
{
    public string MaintenanceFlag { get; set; } = "";
    public string McpStderrLog { get; set; } = "";
    public string ServerPid { get; set; } = "";
    public string SupervisorLock { get; set; } = "";
    public string SupervisorLog { get; set; } = "";
    public string PidsDir { get; set; } = "";
    public string HeartbeatsDir { get; set; } = "";
    public string PollerLock { get; set; } = "";
    public string SnapshotsDir { get; set; } = "";
}
