using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Infrastructure;

namespace Sensorium.Supervisor.Services;

/// <summary>
/// BackgroundService that long-polls Telegram getUpdates for /sv commands.
/// Uses a separate offset file to avoid conflicts with the MCP's own Telegram poller.
/// </summary>
public sealed class TelegramCommandHandler : BackgroundService, ITelegramCommandHandler
{
    private readonly SupervisorOptions _opts;
    private readonly HttpClient _http;
    private readonly IProcessManager _proc;
    private readonly IMcpClient _mcp;
    private readonly ISnapshotManager _snapshots;
    private readonly ILogger<TelegramCommandHandler> _log;
    private readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;
    private readonly string? _token;

    public TelegramCommandHandler(
        IOptions<SupervisorOptions> opts,
        IHttpClientFactory factory,
        IProcessManager proc,
        IMcpClient mcp,
        ISnapshotManager snapshots,
        ILogger<TelegramCommandHandler> log)
    {
        _opts      = opts.Value;
        _http      = factory.CreateClient("telegram");
        _http.Timeout = System.Threading.Timeout.InfiniteTimeSpan;
        _proc      = proc;
        _mcp       = mcp;
        _snapshots = snapshots;
        _log       = log;
        _token     = _opts.TelegramSupervisorToken ?? _opts.TelegramToken;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrEmpty(_token) || !_opts.TelegramOperatorId.HasValue)
        {
            _log.LogInformation("TelegramCommandHandler: TELEGRAM_TOKEN/TELEGRAM_SUPERVISOR_TOKEN or TELEGRAM_OPERATOR_ID not set — disabled");
            return;
        }

        var usingSupervisorToken = !string.IsNullOrEmpty(_opts.TelegramSupervisorToken);
        _log.LogInformation("TelegramCommandHandler started, listening for DM commands from operator {OperatorId} (token: {TokenType})",
            _opts.TelegramOperatorId.Value, usingSupervisorToken ? "supervisor-specific" : "shared");

        await SendReplyAsync("🟢 Supervisor online", _opts.TelegramOperatorId.Value.ToString(), stoppingToken).ConfigureAwait(false);

        long offset = await LoadOffsetAsync().ConfigureAwait(false);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                offset = await PollOnceAsync(offset, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "TelegramCommandHandler: poll error — retrying in 5s");
                await Task.Delay(5_000, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    // ── Long-poll ─────────────────────────────────────────────────────────────

    private async Task<long> PollOnceAsync(long offset, CancellationToken ct)
    {
        int timeoutSec = _opts.CommandPollTimeoutSeconds;
        var url = $"https://api.telegram.org/bot{_token}/getUpdates"
                + $"?offset={offset}&timeout={timeoutSec}&allowed_updates=[\"message\"]";

        // Give a generous per-request timeout beyond the Telegram long-poll window
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(timeoutSec + 15));

        using var resp = await _http.GetAsync(url, cts.Token).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        var json = await resp.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);

        if (!doc.RootElement.TryGetProperty("result", out var results)) return offset;

        long newOffset = offset;
        foreach (var update in results.EnumerateArray())
        {
            long updateId = update.GetProperty("update_id").GetInt64();
            if (updateId >= newOffset) newOffset = updateId + 1;

            if (!update.TryGetProperty("message", out var msg)) continue;
            if (!msg.TryGetProperty("text", out var textProp)) continue;

            string text   = textProp.GetString() ?? "";
            string chatId = "";
            if (msg.TryGetProperty("chat", out var chat)
                && chat.TryGetProperty("id", out var chatIdProp))
                chatId = chatIdProp.GetInt64().ToString();

            // Only accept /commands from the authorized operator in a private chat
            if (!chat.TryGetProperty("type", out var typeProp)
                || typeProp.GetString() != "private") continue;
            if (!text.StartsWith("/", StringComparison.Ordinal)) continue;
            if (!_opts.TelegramOperatorId.HasValue) continue;
            if (!msg.TryGetProperty("from", out var from)
                || !from.TryGetProperty("id", out var fromId)
                || fromId.GetInt64() != _opts.TelegramOperatorId.Value) continue;

            // Map /command to /sv command for internal dispatch
            string commandText = "/sv " + text.Trim().TrimStart('/');

            _log.LogInformation("TelegramCommandHandler: received: {Text}", text);
            await HandleCommandAsync(commandText, chatId, ct).ConfigureAwait(false);
        }

        if (newOffset != offset)
            await SaveOffsetAsync(newOffset).ConfigureAwait(false);

        return newOffset;
    }

    // ── Command dispatch ──────────────────────────────────────────────────────

    private async Task HandleCommandAsync(string text, string replyChatId, CancellationToken ct)
    {
        string[] parts  = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        string command  = parts.Length >= 2 ? parts[1].ToLowerInvariant() : "help";

        string reply;
        try
        {
            reply = command switch
            {
                "status"    => await GetStatusAsync(ct).ConfigureAwait(false),
                "restart"   => await RestartMcpAsync(ct).ConfigureAwait(false),
                "snapshots" => GetSnapshotsList(),
                "restore" when parts.Length >= 3 => await RestoreSnapshotAsync(parts[2], ct).ConfigureAwait(false),
                "restore"   => "Usage: /restore &lt;name&gt;",
                "nuke"      => await NukeMcpAsync(ct).ConfigureAwait(false),
                _           => GetHelpText()
            };
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "TelegramCommandHandler: error handling '{Text}'", text);
            reply = $"❌ Error: {Encode(ex.Message)}";
        }

        await SendReplyAsync(reply, replyChatId, ct).ConfigureAwait(false);
    }

    // ── /sv status ────────────────────────────────────────────────────────────

    private async Task<string> GetStatusAsync(CancellationToken ct)
    {
        var uptime    = DateTimeOffset.UtcNow - _startedAt;
        string uptimeStr = $"{(int)uptime.TotalHours}h {uptime.Minutes}m {uptime.Seconds}s";

        var (pidOk, pid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
        string pidStr = pidOk ? pid.ToString() : "unknown";

        bool healthy = false;
        try { healthy = await _mcp.IsServerReadyAsync(ct).ConfigureAwait(false); } catch { }
        string healthStr = healthy ? "✅ ready" : "❌ not ready";

        string version = await GetMcpVersionAsync().ConfigureAwait(false);

        return $"📊 <b>Supervisor Status</b>\n" +
               $"Uptime: {uptimeStr}\n" +
               $"MCP PID: {pidStr}\n" +
               $"MCP Health: {healthStr}\n" +
               $"MCP Version: {Encode(version)}";
    }

    private async Task<string> GetMcpVersionAsync()
    {
        try
        {
            // npm is a cmd script on Windows; wrap in cmd /c for cross-platform safety
            var (fileName, args) = OperatingSystem.IsWindows()
                ? ("cmd", "/c npm list -g sensorium-mcp --depth=0")
                : ("npm", "list -g sensorium-mcp --depth=0");

            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName               = fileName,
                Arguments              = args,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true
            };

            using var proc = System.Diagnostics.Process.Start(psi);
            if (proc == null) return "unknown";

            using var procCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            string output = await proc.StandardOutput.ReadToEndAsync(procCts.Token).ConfigureAwait(false);
            await proc.WaitForExitAsync(procCts.Token).ConfigureAwait(false);

            // Output contains lines like "├── sensorium-mcp@3.0.24"
            var line = output.Split('\n').FirstOrDefault(l => l.Contains("sensorium-mcp@"));
            if (line != null)
            {
                int idx = line.IndexOf("sensorium-mcp@", StringComparison.Ordinal);
                return line[idx..].Trim();
            }
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "TelegramCommandHandler: could not determine MCP version from npm");
        }

        return "unknown";
    }

    // ── /sv restart ───────────────────────────────────────────────────────────

    private async Task<string> RestartMcpAsync(CancellationToken ct)
    {
        _log.LogInformation("TelegramCommandHandler: /sv restart");

        var (pidOk, pid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
        MaintenanceFlagWriter.Write(_opts.Paths.MaintenanceFlag, "cmd-restart", _log);

        await _mcp.PrepareShutdownAsync(ct).ConfigureAwait(false);

        if (pidOk && pid > 0)
            await _proc.KillProcessAsync(pid).ConfigureAwait(false);

        await _proc.KillByPortAsync(_opts.McpHttpPort).ConfigureAwait(false);
        TryDeleteFile(_opts.Paths.PollerLock);

        if (!ct.IsCancellationRequested)
            await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);

        TryDeleteFile(_opts.Paths.MaintenanceFlag);

        return "✅ MCP server restarted.";
    }

    // ── /sv snapshots ─────────────────────────────────────────────────────────

    private string GetSnapshotsList()
    {
        var list = _snapshots.ListSnapshots();
        if (list.Count == 0)
            return "📦 No snapshots available.";

        var sb = new StringBuilder();
        sb.AppendLine("📦 <b>Available Snapshots</b>");
        foreach (var s in list)
        {
            string sizeMb = (s.ZipSizeBytes / 1024.0 / 1024.0).ToString("F1");
            sb.AppendLine($"• <b>{Encode(s.Name)}</b>  ({sizeMb} MB)");
            sb.AppendLine($"  Version: {Encode(s.McpVersion)}");
            sb.AppendLine($"  Date: {s.CreatedAt:yyyy-MM-dd HH:mm} UTC");
        }
        return sb.ToString().TrimEnd();
    }

    // ── /sv restore <name> ────────────────────────────────────────────────────

    private async Task<string> RestoreSnapshotAsync(string name, CancellationToken ct)
    {
        _log.LogInformation("TelegramCommandHandler: /sv restore {Name}", name);

        var (pidOk, pid) = await _proc.ReadPidFileAsync(_opts.Paths.ServerPid).ConfigureAwait(false);
        MaintenanceFlagWriter.Write(_opts.Paths.MaintenanceFlag, "cmd-restore", _log);

        await _mcp.PrepareShutdownAsync(ct).ConfigureAwait(false);
        if (pidOk && pid > 0)
            await _proc.KillProcessAsync(pid).ConfigureAwait(false);

        var result = _snapshots.Restore(name);
        if (!result.Success)
        {
            TryDeleteFile(_opts.Paths.MaintenanceFlag);
            return $"❌ Restore failed: {Encode(result.Message)}";
        }

        await _proc.KillByPortAsync(_opts.McpHttpPort).ConfigureAwait(false);
        TryDeleteFile(_opts.Paths.PollerLock);

        if (!ct.IsCancellationRequested)
            await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);

        TryDeleteFile(_opts.Paths.MaintenanceFlag);

        return $"✅ Snapshot '{Encode(name)}' restored. MCP restarted.";
    }

    // ── /sv nuke ──────────────────────────────────────────────────────────────

    private async Task<string> NukeMcpAsync(CancellationToken ct)
    {
        _log.LogWarning("TelegramCommandHandler: /sv nuke");

        MaintenanceFlagWriter.Write(_opts.Paths.MaintenanceFlag, "cmd-nuke", _log);

        // Kill all node.exe / node processes
        try
        {
            var (fileName, args) = OperatingSystem.IsWindows()
                ? ("taskkill", "/F /IM node.exe")
                : ("pkill", "-9 node");

            using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName        = fileName,
                Arguments       = args,
                UseShellExecute = false,
                CreateNoWindow  = true
            });
            if (p != null) await p.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "TelegramCommandHandler: nuke — kill-all node failed");
        }

        // Clear lock files and stale state
        TryDeleteFile(_opts.Paths.PollerLock);
        TryDeleteFile(_opts.Paths.ServerPid);

        await Task.Delay(1_000, ct).ConfigureAwait(false);

        // Respawn MCP
        if (!ct.IsCancellationRequested)
            await _proc.SpawnMcpServerAsync(ct).ConfigureAwait(false);

        TryDeleteFile(_opts.Paths.MaintenanceFlag);

        return "💥 Nuke complete — all node processes killed, lock files cleared, MCP respawned.";
    }

    // ── Help ──────────────────────────────────────────────────────────────────

    private static string GetHelpText() =>
        "<b>Supervisor Commands</b>\n" +
        "/status — uptime, PID, health, version\n" +
        "/restart — graceful MCP restart\n" +
        "/snapshots — list available snapshots\n" +
        "/restore &lt;name&gt; — restore a snapshot\n" +
        "/nuke — kill all node processes and respawn";

    // ── Telegram send ─────────────────────────────────────────────────────────

    private async Task SendReplyAsync(string text, string chatId, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));

            var url     = $"https://api.telegram.org/bot{_token}/sendMessage";
            var payload = new Dictionary<string, object>
            {
                ["chat_id"]    = chatId,
                ["text"]       = text,
                ["parse_mode"] = "HTML"
            };

            using var resp = await _http.PostAsJsonAsync(url, payload, cts.Token).ConfigureAwait(false);
            if ((int)resp.StatusCode >= 400)
                _log.LogWarning("TelegramCommandHandler: send reply HTTP {Status}", (int)resp.StatusCode);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "TelegramCommandHandler: failed to send reply");
        }
    }

    // ── Offset persistence ────────────────────────────────────────────────────

    private string OffsetFilePath => Path.Combine(_opts.DataDir, "supervisor-cmd-offset.json");

    private async Task<long> LoadOffsetAsync()
    {
        try
        {
            if (File.Exists(OffsetFilePath))
            {
                var json = await File.ReadAllTextAsync(OffsetFilePath).ConfigureAwait(false);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("offset", out var o))
                    return o.GetInt64();
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "TelegramCommandHandler: failed to load offset — starting from 0");
        }
        return 0;
    }

    private async Task SaveOffsetAsync(long offset)
    {
        try
        {
            var json = JsonSerializer.Serialize(new { offset });
            await File.WriteAllTextAsync(OffsetFilePath, json).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "TelegramCommandHandler: failed to save offset");
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private static string Encode(string s) => System.Net.WebUtility.HtmlEncode(s);
    private static void TryDeleteFile(string path) { try { File.Delete(path); } catch { /* best-effort */ } }
}
