using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Sensorium.Supervisor.Infrastructure;

public enum UpdatePhase
{
    Idle,
    Downloading,
    Staged,
    Applying,
    Restarting,
    Verifying,
    Rollback,
    Failed
}

public sealed class UpdateState
{
    [JsonPropertyName("scope")]
    public string Scope { get; set; } = "supervisor";

    [JsonPropertyName("phase")]
    [JsonConverter(typeof(JsonStringEnumConverter<UpdatePhase>))]
    public UpdatePhase Phase { get; set; } = UpdatePhase.Idle;

    [JsonPropertyName("targetVersion")]
    public string TargetVersion { get; set; } = "";

    [JsonPropertyName("previousVersion")]
    public string PreviousVersion { get; set; } = "";

    [JsonPropertyName("updatedAt")]
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    [JsonPropertyName("lastError")]
    public string LastError { get; set; } = "";
}

public sealed class UpdateStateStore
{
    private readonly string _path;
    private readonly ILogger _log;

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        WriteIndented = false,
        PropertyNameCaseInsensitive = true
    };

    public UpdateStateStore(string path, ILogger log)
    {
        _path = path;
        _log = log;
    }

    public UpdateState Load()
    {
        try
        {
            if (!File.Exists(_path))
                return new UpdateState();

            var json = File.ReadAllText(_path);
            return JsonSerializer.Deserialize<UpdateState>(json, _jsonOpts) ?? new UpdateState();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to load update state from {Path}", _path);
            return new UpdateState();
        }
    }

    public void Transition(string scope, UpdatePhase phase, string targetVersion, string previousVersion, string lastError = "")
    {
        var state = new UpdateState
        {
            Scope = scope,
            Phase = phase,
            TargetVersion = targetVersion,
            PreviousVersion = previousVersion,
            UpdatedAt = DateTimeOffset.UtcNow,
            LastError = lastError
        };

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var json = JsonSerializer.Serialize(state, _jsonOpts);
            AtomicWrite(_path, json);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to persist update state (scope={Scope} phase={Phase})", scope, phase);
        }
    }

    private static void AtomicWrite(string path, string content)
    {
        var tmp = path + ".tmp." + Environment.ProcessId;
        File.WriteAllText(tmp, content);
        File.Move(tmp, path, overwrite: true);
    }
}

/// <summary>
/// Coordinator lock preventing concurrent update apply operations.
/// </summary>
public sealed class UpdateCoordinatorLock : IDisposable
{
    private readonly string _path;
    private readonly ILogger _log;
    private bool _disposed;

    private UpdateCoordinatorLock(string path, ILogger log)
    {
        _path = path;
        _log = log;
    }

    public static UpdateCoordinatorLock? TryAcquire(string path, string scope, ILogger log)
    {
        var owner = new { scope, pid = Environment.ProcessId, at = DateTimeOffset.UtcNow };
        var payload = JsonSerializer.Serialize(owner);

        try
        {
            using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var writer = new StreamWriter(fs);
            writer.Write(payload);
            log.LogDebug("Update coordinator lock acquired by {Scope}", scope);
            return new UpdateCoordinatorLock(path, log);
        }
        catch (IOException)
        {
            // Lock exists — check if stale
            try
            {
                var existing = File.ReadAllText(path);
                var doc = JsonDocument.Parse(existing).RootElement;
                int holderPid = doc.GetProperty("pid").GetInt32();

                bool alive = IsProcessAlive(holderPid);
                if (alive)
                {
                    string holderScope = doc.TryGetProperty("scope", out var s) ? s.GetString() ?? "unknown" : "unknown";
                    log.LogInformation("Skipping {Scope} update apply: coordinator lock held by {HolderScope} (PID {Pid})", scope, holderScope, holderPid);
                    return null;
                }

                // Stale — reclaim
                File.Delete(path);
                using var fs2 = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                using var w2 = new StreamWriter(fs2);
                w2.Write(payload);
                log.LogWarning("Reclaimed stale update coordinator lock for {Scope}", scope);
                return new UpdateCoordinatorLock(path, log);
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Failed to acquire/reclaim update coordinator lock {Path}", path);
                return null;
            }
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            using var proc = Process.GetProcessById(pid);
            return !proc.HasExited;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { File.Delete(_path); } catch { /* best-effort */ }
        _log.LogDebug("Update coordinator lock released");
    }
}
