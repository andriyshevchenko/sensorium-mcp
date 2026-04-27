using System.IO.Compression;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Services;

/// <summary>
/// Lists and restores MCP data snapshots.
/// Snapshot creation is done by the MCP dashboard, not the supervisor.
/// </summary>
public sealed class SnapshotManager : ISnapshotManager
{
    private readonly SupervisorOptions _opts;
    private readonly ILogger<SnapshotManager> _log;

    // Files and directories within the data dir that are backed up / restored
    private static readonly string[] DataFiles = ["memory.db", "settings.json", "install.config.json"];
    private static readonly string[] DataDirs  = ["templates", "schedules", "pending-tasks", "threads", "files"];

    public SnapshotManager(IOptions<SupervisorOptions> opts, ILogger<SnapshotManager> log)
    {
        _opts = opts.Value;
        _log  = log;
    }

    public List<SnapshotInfo> ListSnapshots()
    {
        var result = new List<SnapshotInfo>();
        string dir = _opts.Paths.SnapshotsDir;

        if (!Directory.Exists(dir)) return result;

        foreach (var manifestPath in Directory.GetFiles(dir, "*.json"))
        {
            try
            {
                string name = Path.GetFileNameWithoutExtension(manifestPath);
                if (name.StartsWith('_')) continue; // skip internal files (_pre-restore-backup etc.)

                string zipPath = Path.Combine(dir, name + ".zip");
                if (!File.Exists(zipPath)) continue;

                using var stream = File.OpenRead(manifestPath);
                using var doc    = JsonDocument.Parse(stream);
                var root = doc.RootElement;

                DateTimeOffset createdAt = DateTimeOffset.MinValue;
                if (root.TryGetProperty("createdAt", out var ca))
                    DateTimeOffset.TryParse(ca.GetString(), out createdAt);

                string mcpVersion = "unknown";
                if (root.TryGetProperty("mcpVersion", out var mv))
                    mcpVersion = mv.GetString() ?? "unknown";

                long zipSize = new FileInfo(zipPath).Length;
                result.Add(new SnapshotInfo(name, createdAt, zipSize, mcpVersion));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "SnapshotManager: failed to read manifest {Path}", manifestPath);
            }
        }

        // Newest first
        result.Sort((a, b) => b.CreatedAt.CompareTo(a.CreatedAt));
        return result;
    }

    public SnapshotRestoreResult Restore(string snapshotName)
    {
        // Guard against path traversal — name must be a plain filename with no separators
        if (snapshotName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            return new SnapshotRestoreResult(false, "Invalid snapshot name");

        string dir     = _opts.Paths.SnapshotsDir;
        string zipPath = Path.Combine(dir, snapshotName + ".zip");

        if (!File.Exists(zipPath))
            return new SnapshotRestoreResult(false, $"Snapshot '{snapshotName}' not found");

        try
        {
            // Step 1 — create pre-restore backup of current data dir
            string backupPath = Path.Combine(dir, "_pre-restore-backup.zip");
            _log.LogInformation("SnapshotManager: creating pre-restore backup → {Path}", backupPath);
            TryDeleteFile(backupPath);
            CreateDataBackup(backupPath);
            _log.LogInformation("SnapshotManager: pre-restore backup created");

            // Step 2 — wipe known data files/dirs for a clean slate
            CleanDataDir();

            // Step 3 — extract snapshot zip
            _log.LogInformation("SnapshotManager: restoring '{Name}' → {DataDir}", snapshotName, _opts.DataDir);
            ZipFile.ExtractToDirectory(zipPath, _opts.DataDir, overwriteFiles: true);
            _log.LogInformation("SnapshotManager: restore complete");

            return new SnapshotRestoreResult(true, $"Snapshot '{snapshotName}' restored successfully");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "SnapshotManager: restore failed for '{Name}'", snapshotName);
            return new SnapshotRestoreResult(false, ex.Message);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    private void CleanDataDir()
    {
        foreach (var fileName in DataFiles)
        {
            var filePath = Path.Combine(_opts.DataDir, fileName);
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
                _log.LogInformation("SnapshotManager: wiped file {File}", fileName);
            }
        }

        foreach (var dirName in DataDirs)
        {
            var dirPath = Path.Combine(_opts.DataDir, dirName);
            if (Directory.Exists(dirPath))
            {
                Directory.Delete(dirPath, recursive: true);
                _log.LogInformation("SnapshotManager: wiped dir {Dir}", dirName);
            }
        }
    }

    private void CreateDataBackup(string backupZipPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(backupZipPath)!);

        using var archive = ZipFile.Open(backupZipPath, ZipArchiveMode.Create);

        foreach (var fileName in DataFiles)
        {
            var filePath = Path.Combine(_opts.DataDir, fileName);
            if (File.Exists(filePath))
                archive.CreateEntryFromFile(filePath, fileName, CompressionLevel.Optimal);
        }

        foreach (var dirName in DataDirs)
        {
            var dirPath = Path.Combine(_opts.DataDir, dirName);
            if (Directory.Exists(dirPath))
                AddDirectoryToArchive(archive, dirPath, dirName);
        }
    }

    private static void AddDirectoryToArchive(ZipArchive archive, string sourceDirPath, string archiveDirName)
    {
        foreach (var file in Directory.EnumerateFiles(sourceDirPath, "*", SearchOption.AllDirectories))
        {
            string relativePath = Path.GetRelativePath(sourceDirPath, file);
            string entryName    = Path.Combine(archiveDirName, relativePath).Replace('\\', '/');
            archive.CreateEntryFromFile(file, entryName, CompressionLevel.Optimal);
        }
    }

    private static void TryDeleteFile(string path) { try { File.Delete(path); } catch { /* best-effort */ } }
}
