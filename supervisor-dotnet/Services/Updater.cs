using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Infrastructure;

namespace Sensorium.Supervisor.Services;

public sealed class Updater : IUpdater
{
    private const string ReleaseUrl =
        "https://api.github.com/repos/andriyshevchenko/remote-copilot-mcp/releases/tags/supervisor-latest";

    private readonly SupervisorOptions _opts;
    private readonly IMcpClient _mcp;
    private readonly ITelegramNotifier _notify;
    private readonly ILogger<Updater> _log;
    private readonly UpdateStateStore _state;
    private readonly HttpClient _http;

    private readonly DateTime _startedAt = DateTime.UtcNow;
    private Task? _loop;
    private CancellationTokenSource? _cts;

    public Updater(
        IHttpClientFactory httpFactory,
        IOptions<SupervisorOptions> opts,
        IMcpClient mcp,
        ITelegramNotifier notify,
        ILogger<Updater> log)
    {
        _opts = opts.Value;
        _mcp = mcp;
        _notify = notify;
        _log = log;
        _http = httpFactory.CreateClient("github");
        _http.Timeout = TimeSpan.FromSeconds(30);
        _http.DefaultRequestHeaders.Add("User-Agent", "sensorium-supervisor-updater");
        _http.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
        _state = new UpdateStateStore(_opts.Paths.UpdateState, log);
    }

    public void Start(CancellationToken ct)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _loop = RunLoopAsync(_cts.Token);
        _log.LogInformation("Updater started (mode={Mode})", _opts.Mode);
    }

    public async Task StopAsync()
    {
        _cts?.Cancel();
        if (_loop != null)
        {
            try { await _loop.ConfigureAwait(false); }
            catch (OperationCanceledException) { /* expected */ }
        }
    }

    private async Task RunLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TimeSpan delay = _opts.Mode == "development"
                ? _opts.PollInterval
                : TimeUntilNextPoll();

            _log.LogDebug("Updater: next check in {Delay}", delay);

            try { await Task.Delay(delay, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }

            await CheckSupervisorUpdateAsync(ct).ConfigureAwait(false);
        }
    }

    private TimeSpan TimeUntilNextPoll()
    {
        var now = DateTime.Now;
        var next = new DateTime(now.Year, now.Month, now.Day, _opts.PollAtHour, 0, 0, DateTimeKind.Local);
        if (next <= now) next = next.AddDays(1);
        return next - now;
    }

    private async Task CheckSupervisorUpdateAsync(CancellationToken ct)
    {
        var uptime = DateTime.UtcNow - _startedAt;
        if (uptime < _opts.MinUptime)
        {
            _log.LogInformation("Deferring update check — too early (uptime {Uptime} < {Min})",
                uptime.ToString(@"hh\:mm\:ss"), _opts.MinUptime);
            return;
        }

        string remoteVersion, downloadUrl;
        try
        {
            (remoteVersion, downloadUrl) = await GetLatestReleaseAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to check supervisor release");
            return;
        }

        string localVersion = ReadLocalVersion();
        if (string.IsNullOrEmpty(localVersion))
        {
            _log.LogInformation("No local supervisor version recorded — storing {Version}", remoteVersion);
            WriteLocalVersion(remoteVersion);
            return;
        }

        if (localVersion == remoteVersion)
        {
            _log.LogDebug("Supervisor is up to date ({Version})", localVersion);
            return;
        }

        _log.LogInformation("Supervisor update available: {Local} → {Remote}", localVersion, remoteVersion);

        using var coordLock = UpdateCoordinatorLock.TryAcquire(_opts.Paths.UpdateApplyLock, "supervisor", _log);
        if (coordLock is null)
        {
            _log.LogInformation("Deferring update {Local} → {Remote}: coordinator lock busy", localVersion, remoteVersion);
            return;
        }

        await _notify.NotifyAsync(
            $"⚙️ Supervisor: updating binary {localVersion} → {remoteVersion}. " +
            $"Grace period {_opts.GracePeriod.TotalSeconds}s. Supervisor will restart — MCP unaffected.",
            ct: ct).ConfigureAwait(false);

        try { await Task.Delay(_opts.GracePeriod, ct).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            _state.Transition("supervisor", UpdatePhase.Failed, remoteVersion, localVersion, "cancelled during grace period");
            return;
        }

        try
        {
            await DownloadBinaryAsync(downloadUrl, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _state.Transition("supervisor", UpdatePhase.Failed, remoteVersion, localVersion, ex.Message);
            _log.LogError(ex, "Supervisor binary download failed");
            await _notify.NotifyAsync($"🔴 Supervisor: update to {remoteVersion} failed during download.", ct: ct).ConfigureAwait(false);
            return;
        }

        try
        {
            await StagePendingVersionAsync(remoteVersion).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            TryDeleteFile(_opts.Paths.PendingBinary);
            _state.Transition("supervisor", UpdatePhase.Failed, remoteVersion, localVersion, ex.Message);
            _log.LogError(ex, "Failed to stage version {Version}", remoteVersion);
            await _notify.NotifyAsync($"🔴 Supervisor: update to {remoteVersion} failed during staging.", ct: ct).ConfigureAwait(false);
            return;
        }

        _state.Transition("supervisor", UpdatePhase.Staged, remoteVersion, localVersion);
        await _notify.NotifyAsync(
            $"⚙️ Supervisor: binary {remoteVersion} downloaded. Restarting supervisor — MCP will continue running.",
            ct: ct).ConfigureAwait(false);

        _state.Transition("supervisor", UpdatePhase.Restarting, remoteVersion, localVersion);
        RequestRestart();
    }

    private async Task<(string Version, string DownloadUrl)> GetLatestReleaseAsync(CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(20));

        using var resp = await _http.GetAsync(ReleaseUrl, cts.Token).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        using var doc = await JsonDocument.ParseAsync(
            await resp.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false),
            cancellationToken: cts.Token).ConfigureAwait(false);

        string assetName = SupervisorAssetName();
        var root = doc.RootElement;

        string version = root.TryGetProperty("name", out var name) ? name.GetString()?.Trim() ?? "" : "";
        if (string.IsNullOrEmpty(version) && root.TryGetProperty("tag_name", out var tag))
            version = tag.GetString()?.Trim() ?? "";

        if (string.IsNullOrEmpty(version))
            throw new InvalidOperationException("Release version is empty");

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            if (asset.GetProperty("name").GetString() == assetName)
            {
                string url = asset.GetProperty("browser_download_url").GetString()
                    ?? throw new InvalidOperationException("Asset download URL is empty");
                return (version, url);
            }
        }

        throw new InvalidOperationException($"Release asset '{assetName}' not found");
    }

    private static string SupervisorAssetName()
    {
        string os = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "windows"
            : RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? "darwin"
            : "linux";

        string arch = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "amd64",
            Architecture.Arm64 => "arm64",
            _ => RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant()
        };

        string ext = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? ".exe" : "";
        return $"sensorium-supervisor-{os}-{arch}{ext}";
    }

    private async Task DownloadBinaryAsync(string downloadUrl, CancellationToken ct)
    {
        Directory.CreateDirectory(_opts.Paths.BinaryDir);

        string tmpPath = _opts.Paths.PendingBinary + ".download";
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromMinutes(5));

            using var resp = await _http.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead, cts.Token)
                .ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();

            await using var fs = new FileStream(tmpPath, FileMode.Create, FileAccess.Write, FileShare.None,
                bufferSize: 81920, useAsync: true);
            await resp.Content.CopyToAsync(fs, cts.Token).ConfigureAwait(false);

            if (fs.Length == 0)
                throw new InvalidOperationException("Downloaded empty binary");

            _log.LogInformation("Supervisor binary downloaded ({Bytes} bytes); staging to {Path}", fs.Length, _opts.Paths.PendingBinary);
        }
        catch
        {
            TryDeleteFile(tmpPath);
            throw;
        }

        TryDeleteFile(_opts.Paths.PendingBinary);
        File.Move(tmpPath, _opts.Paths.PendingBinary, overwrite: false);
    }

    private async Task StagePendingVersionAsync(string version)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_opts.Paths.PendingVersion)!);
        var tmp = _opts.Paths.PendingVersion + ".tmp." + System.Environment.ProcessId;
        await File.WriteAllTextAsync(tmp, version).ConfigureAwait(false);
        File.Move(tmp, _opts.Paths.PendingVersion, overwrite: true);
    }

    private void RequestRestart()
    {
        _log.LogInformation("Requesting supervisor restart for binary swap");
        // Signal the host to shut down — the apply helper will swap the binary and relaunch.
        // Run on a separate thread so we don't block the updater loop; log any failure.
        Task.Run(() =>
        {
            try { SupervisorShutdown.RequestShutdown(); }
            catch (Exception ex) { _log.LogError(ex, "Failed to request supervisor shutdown for restart"); }
        });
    }

    private string ReadLocalVersion()
    {
        try { return File.Exists(_opts.Paths.SupervisorVersion) ? File.ReadAllText(_opts.Paths.SupervisorVersion).Trim() : ""; }
        catch { return ""; }
    }

    private void WriteLocalVersion(string version)
    {
        try
        {
            Directory.CreateDirectory(_opts.DataDir);
            var tmp = _opts.Paths.SupervisorVersion + ".tmp." + System.Environment.ProcessId;
            File.WriteAllText(tmp, version);
            File.Move(tmp, _opts.Paths.SupervisorVersion, overwrite: true);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to write supervisor version file");
        }
    }

    private static void TryDeleteFile(string path)
    {
        try { File.Delete(path); } catch { /* best-effort */ }
    }
}

/// <summary>Hook used by the Updater to signal the host to shut down.</summary>
internal static class SupervisorShutdown
{
    private static IHostApplicationLifetime? _lifetime;

    public static void Register(IHostApplicationLifetime lifetime) => _lifetime = lifetime;

    public static void RequestShutdown() => _lifetime?.StopApplication();
}
