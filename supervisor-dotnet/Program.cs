using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Serilog;
using Serilog.Events;
using Sensorium.Supervisor;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Services;

// ── Paths derived from env ────────────────────────────────────────────────────
var dataDir = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
    ".remote-copilot-mcp");
var logPath = Path.Combine(dataDir, "logs", "supervisor", "supervisor-.log");
Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

// ── Set up Serilog early (console-only for bootstrap phase) ─────────────────
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .WriteTo.Console(outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
    .WriteTo.File(
        logPath,
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 7,
        outputTemplate: "[{Timestamp:yyyy-MM-dd HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
    .CreateLogger();

// ── Build Generic Host ────────────────────────────────────────────────────────
var builder = new HostApplicationBuilder(args);

builder.Services.AddSerilog(Log.Logger);

builder.Services.Configure<SupervisorOptions>(opts => ConfigureOptions(opts, dataDir, builder.Configuration));

builder.Services.AddHttpClient("mcp");
builder.Services.AddHttpClient("telegram");

builder.Services.AddSingleton<ISingletonLock, SingletonLock>();
builder.Services.AddSingleton<IProcessManager, ProcessManager>();
builder.Services.AddSingleton<IMcpClient, McpClient>();
builder.Services.AddSingleton<ITelegramNotifier, TelegramNotifier>();
builder.Services.AddSingleton<ISnapshotManager, SnapshotManager>();
builder.Services.AddSingleton<TelegramCommandHandler>();
builder.Services.AddSingleton<ITelegramCommandHandler>(sp => sp.GetRequiredService<TelegramCommandHandler>());
builder.Services.AddHostedService(sp => sp.GetRequiredService<TelegramCommandHandler>());
builder.Services.AddHostedService<SupervisorWorker>();

var host = builder.Build();

await host.RunAsync();
await Log.CloseAndFlushAsync();

// ── Local helpers ─────────────────────────────────────────────────────────────

static void ConfigureOptions(SupervisorOptions opts, string dataDir, IConfiguration? config)
{
    // IConfiguration includes EnvironmentVariablesConfigurationProvider by default.
    string Cfg(string key, string fallback)
        => (config?[key] ?? Environment.GetEnvironmentVariable(key)) is { Length: > 0 } v ? v : fallback;
    string? CfgOrNull(string key)
        => (config?[key] ?? Environment.GetEnvironmentVariable(key)) is { Length: > 0 } v ? v : null;
    int CfgInt(string key, int fallback)
        => int.TryParse(config?[key] ?? Environment.GetEnvironmentVariable(key), out int v) ? v : fallback;
    long? CfgLong(string key)
        => long.TryParse(config?[key] ?? Environment.GetEnvironmentVariable(key), out long v) ? v : null;

    opts.McpStartCommand = Cfg("MCP_START_COMMAND", "npx -y sensorium-mcp@latest");
    opts.DataDir = dataDir;
    opts.McpHttpPort = CfgInt("MCP_HTTP_PORT", 0);
    opts.McpHttpSecret = CfgOrNull("MCP_HTTP_SECRET");
    opts.TelegramToken = CfgOrNull("TELEGRAM_TOKEN");
    opts.TelegramChatId = CfgOrNull("TELEGRAM_CHAT_ID");
    opts.TelegramOperatorId = CfgLong("TELEGRAM_OPERATOR_ID");
    opts.HealthFailThresh = 5;
    opts.McpReadyTimeout = TimeSpan.FromMinutes(5);

    string logs = Path.Combine(dataDir, "logs");
    opts.Paths = new SupervisorPaths
    {
        MaintenanceFlag = Path.Combine(dataDir, "maintenance.flag"),
        McpStderrLog = Path.Combine(logs, "mcp", "mcp-stderr.log"),
        ServerPid = Path.Combine(dataDir, "server.pid"),
        SupervisorLock = Path.Combine(dataDir, "supervisor.lock"),
        SupervisorLog = Path.Combine(logs, "supervisor", "supervisor-.log"),
        PidsDir = Path.Combine(dataDir, "pids"),
        HeartbeatsDir = Path.Combine(dataDir, "heartbeats"),
        PollerLock = Path.Combine(dataDir, "poller.lock"),
        SnapshotsDir = Path.Combine(dataDir, "snapshots"),
    };
}
