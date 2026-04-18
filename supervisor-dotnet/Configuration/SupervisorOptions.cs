namespace Sensorium.Supervisor.Configuration;

public sealed class SupervisorOptions
{
    public string Mode { get; set; } = "development";
    public int PollAtHour { get; set; } = 4;
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(60);
    public TimeSpan GracePeriod { get; set; } = TimeSpan.FromSeconds(10);
    public TimeSpan MinUptime { get; set; } = TimeSpan.FromSeconds(600);
    public string McpStartCommand { get; set; } = "npx -y sensorium-mcp@latest";
    public string DataDir { get; set; } = "";
    public int McpHttpPort { get; set; }
    public string? McpHttpSecret { get; set; }
    public string? TelegramToken { get; set; }
    public string? TelegramChatId { get; set; }
    public int HealthFailThresh { get; set; } = 3;
    public TimeSpan McpReadyTimeout { get; set; } = TimeSpan.FromMinutes(2);
    public SupervisorPaths Paths { get; set; } = new();
}

public sealed class SupervisorPaths
{
    public string BinaryDir { get; set; } = "";
    public string MaintenanceFlag { get; set; } = "";
    public string VersionFile { get; set; } = "";
    public string SupervisorVersion { get; set; } = "";
    public string UpdateState { get; set; } = "";
    public string UpdateApplyLock { get; set; } = "";
    public string PendingBinary { get; set; } = "";
    public string PendingVersion { get; set; } = "";
    public string LastActivity { get; set; } = "";
    public string McpStderrLog { get; set; } = "";
    public string ServerPid { get; set; } = "";
    public string WatcherLock { get; set; } = "";
    public string SupervisorLog { get; set; } = "";
    public string PidsDir { get; set; } = "";
    public string HeartbeatsDir { get; set; } = "";
    public string ApplyFailureMarker { get; set; } = "";
}
