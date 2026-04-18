using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Serilog;
using Serilog.Events;
using Sensorium.Supervisor;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Infrastructure;
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

// ── Apply pending self-update before DI is initialised ───────────────────────
var earlyOpts = BuildSupervisorOptions(dataDir);

bool shouldExit = SelfUpdate.ApplyPendingUpdate(earlyOpts, NullLogger.Instance);
if (shouldExit)
{
    Log.Information("Apply helper launched — exiting for binary swap");
    await Log.CloseAndFlushAsync();
    return;
}

RecoverUpdateStateOnStartup(earlyOpts);

// ── Build Generic Host ────────────────────────────────────────────────────────
var builder = new HostApplicationBuilder(args);

builder.Services.AddSerilog(Log.Logger);

builder.Services.Configure<SupervisorOptions>(opts => ConfigureOptions(opts, dataDir));

builder.Services.AddHttpClient("mcp");
builder.Services.AddHttpClient("telegram");
builder.Services.AddHttpClient("github");

builder.Services.AddSingleton<ISingletonLock, SingletonLock>();
builder.Services.AddSingleton<IProcessManager, ProcessManager>();
builder.Services.AddSingleton<IMcpClient, McpClient>();
builder.Services.AddSingleton<ITelegramNotifier, TelegramNotifier>();
builder.Services.AddSingleton<IUpdater, Updater>();
builder.Services.AddHostedService<SupervisorWorker>();

var host = builder.Build();

SupervisorShutdown.Register(host.Services.GetRequiredService<IHostApplicationLifetime>());

await host.RunAsync();
await Log.CloseAndFlushAsync();

// ── Local helpers ─────────────────────────────────────────────────────────────

static SupervisorOptions BuildSupervisorOptions(string dataDir)
{
    var opts = new SupervisorOptions();
    ConfigureOptions(opts, dataDir);
    return opts;
}

static void ConfigureOptions(SupervisorOptions opts, string dataDir)
{
    opts.Mode = Env("WATCHER_MODE", "development");
    opts.PollAtHour = EnvInt("WATCHER_POLL_HOUR", 4);
    opts.PollInterval = TimeSpan.FromSeconds(EnvInt("WATCHER_POLL_INTERVAL", 60));
    opts.GracePeriod = TimeSpan.FromSeconds(
        EnvInt("WATCHER_GRACE_PERIOD", opts.Mode == "development" ? 10 : 300));
    opts.MinUptime = TimeSpan.FromSeconds(600);
    opts.McpStartCommand = Env("MCP_START_COMMAND", "npx -y sensorium-mcp@latest");
    opts.DataDir = dataDir;
    opts.McpHttpPort = EnvInt("MCP_HTTP_PORT", 0);
    opts.McpHttpSecret = EnvOrNull("MCP_HTTP_SECRET");
    opts.TelegramToken = EnvOrNull("TELEGRAM_TOKEN");
    opts.TelegramChatId = EnvOrNull("TELEGRAM_CHAT_ID");
    opts.HealthFailThresh = 3;
    opts.McpReadyTimeout = TimeSpan.FromMinutes(2);

    string bin = Path.Combine(dataDir, "bin");
    string logs = Path.Combine(dataDir, "logs");
    opts.Paths = new SupervisorPaths
    {
        BinaryDir = bin,
        MaintenanceFlag = Path.Combine(dataDir, "maintenance.flag"),
        VersionFile = Path.Combine(dataDir, "current-version.txt"),
        SupervisorVersion = Path.Combine(dataDir, "supervisor-version.txt"),
        UpdateState = Path.Combine(dataDir, "update-state.json"),
        UpdateApplyLock = Path.Combine(dataDir, "update-apply.lock"),
        PendingBinary = Path.Combine(bin, "sensorium-supervisor.new.exe"),
        PendingVersion = Path.Combine(bin, "sensorium-supervisor.new.exe.version"),
        LastActivity = Path.Combine(dataDir, "last-activity.txt"),
        McpStderrLog = Path.Combine(logs, "mcp", "mcp-stderr.log"),
        ServerPid = Path.Combine(dataDir, "server.pid"),
        WatcherLock = Path.Combine(dataDir, "watcher.lock"),
        SupervisorLog = Path.Combine(logs, "supervisor", "supervisor-.log"),
        PidsDir = Path.Combine(dataDir, "pids"),
        HeartbeatsDir = Path.Combine(dataDir, "heartbeats"),
        ApplyFailureMarker = Path.Combine(bin, "sensorium-supervisor.new.exe.failed"),
    };
}

static void RecoverUpdateStateOnStartup(SupervisorOptions opts)
{
    var store = new UpdateStateStore(opts.Paths.UpdateState, NullLogger.Instance);
    var state = store.Load();

    if (state.Phase is UpdatePhase.Idle or UpdatePhase.Failed)
        return;

    if (state.Scope == "supervisor")
    {
        string cur = ReadTrimmedFile(opts.Paths.SupervisorVersion);
        if (!string.IsNullOrEmpty(state.TargetVersion) && cur == state.TargetVersion)
        {
            Log.Information("Startup recovery: supervisor update {Version} already applied; transitioning to idle",
                state.TargetVersion);
            store.Transition("supervisor", UpdatePhase.Idle, state.TargetVersion, state.PreviousVersion);
            return;
        }
    }

    string reason = $"startup recovery: stale non-idle update state ({state.Scope}/{state.Phase})";
    Log.Warning(reason);
    store.Transition(state.Scope, UpdatePhase.Failed, state.TargetVersion, state.PreviousVersion, reason);
}

static string ReadTrimmedFile(string path)
{
    try { return File.Exists(path) ? File.ReadAllText(path).Trim() : ""; }
    catch { return ""; }
}

static string Env(string key, string fallback)
    => Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : fallback;

static string? EnvOrNull(string key)
    => Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : null;

static int EnvInt(string key, int fallback)
    => int.TryParse(Environment.GetEnvironmentVariable(key), out int v) ? v : fallback;
