using System.IO.Compression;
using System.Text.Json;
using Xunit;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Services;

namespace Sensorium.Supervisor.Tests;

public class SnapshotManagerTests : IDisposable
{
    private readonly string _tmpDir;
    private readonly string _snapshotsDir;
    private readonly string _dataDir;
    private readonly SnapshotManager _mgr;

    public SnapshotManagerTests()
    {
        _tmpDir      = Path.Combine(Path.GetTempPath(), "sv-snap-tests-" + Guid.NewGuid());
        _snapshotsDir = Path.Combine(_tmpDir, "snapshots");
        _dataDir     = Path.Combine(_tmpDir, "data");
        Directory.CreateDirectory(_snapshotsDir);
        Directory.CreateDirectory(_dataDir);

        var opts = Options.Create(new SupervisorOptions
        {
            DataDir = _dataDir,
            Paths   = new SupervisorPaths { SnapshotsDir = _snapshotsDir }
        });
        _mgr = new SnapshotManager(opts, NullLogger<SnapshotManager>.Instance);
    }

    // ── ListSnapshots ─────────────────────────────────────────────────────────

    [Fact]
    public void ListSnapshots_EmptyDirectory_ReturnsEmpty()
    {
        var result = _mgr.ListSnapshots();

        Assert.Empty(result);
    }

    [Fact]
    public void ListSnapshots_ValidManifest_ReadsFieldsCorrectly()
    {
        var createdAt = new DateTimeOffset(2026, 3, 15, 12, 0, 0, TimeSpan.Zero);
        CreateSnapshot("snap1", createdAt, "3.0.24");

        var result = _mgr.ListSnapshots();

        Assert.Single(result);
        Assert.Equal("snap1", result[0].Name);
        Assert.Equal("3.0.24", result[0].McpVersion);
        Assert.Equal(2026, result[0].CreatedAt.Year);
        Assert.Equal(15, result[0].CreatedAt.Day);
    }

    [Fact]
    public void ListSnapshots_CorruptedManifest_SkipsAndReturnsOthers()
    {
        CreateSnapshot("good", DateTimeOffset.UtcNow, "3.0.0");
        File.WriteAllText(Path.Combine(_snapshotsDir, "bad.json"), "not-valid-json");
        CreateZipPlaceholder("bad");

        var result = _mgr.ListSnapshots();

        Assert.Single(result);
        Assert.Equal("good", result[0].Name);
    }

    [Fact]
    public void ListSnapshots_ExcludesInternalUnderscoreFiles()
    {
        // _pre-restore-backup starts with '_' and should be excluded
        var manifest = new { createdAt = DateTimeOffset.UtcNow.ToString("o"), mcpVersion = "3.0.0" };
        File.WriteAllText(
            Path.Combine(_snapshotsDir, "_pre-restore-backup.json"),
            JsonSerializer.Serialize(manifest));
        CreateZipPlaceholder("_pre-restore-backup");

        var result = _mgr.ListSnapshots();

        Assert.Empty(result);
    }

    [Fact]
    public void ListSnapshots_MissingZipFile_SkipsEntry()
    {
        // Manifest exists but no matching .zip
        var manifest = new { createdAt = DateTimeOffset.UtcNow.ToString("o"), mcpVersion = "3.0.0" };
        File.WriteAllText(
            Path.Combine(_snapshotsDir, "orphan.json"),
            JsonSerializer.Serialize(manifest));
        // No orphan.zip created

        var result = _mgr.ListSnapshots();

        Assert.Empty(result);
    }

    [Fact]
    public void ListSnapshots_MultipleSnapshots_ReturnedNewestFirst()
    {
        var older = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var newer = new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero);
        CreateSnapshot("old-snap", older, "3.0.0");
        CreateSnapshot("new-snap", newer, "3.1.0");

        var result = _mgr.ListSnapshots();

        Assert.Equal(2, result.Count);
        Assert.Equal("new-snap", result[0].Name);
        Assert.Equal("old-snap", result[1].Name);
    }

    // ── Restore ───────────────────────────────────────────────────────────────

    [Fact]
    public void Restore_NonexistentSnapshot_ReturnsFailure()
    {
        var result = _mgr.Restore("does-not-exist");

        Assert.False(result.Success);
        Assert.Contains("not found", result.Message);
    }

    [Theory]
    [InlineData("../traversal")]
    [InlineData("..\\traversal")]
    [InlineData("bad/name")]
    [InlineData("bad\\name")]
    public void Restore_InvalidName_PathTraversal_ReturnsFailure(string badName)
    {
        var result = _mgr.Restore(badName);

        Assert.False(result.Success);
        Assert.Contains("Invalid", result.Message);
    }

    [Fact]
    public void Restore_ValidSnapshot_ExtractsFilesAndReturnsSuccess()
    {
        // Create a real zip containing a test file
        string zipPath = Path.Combine(_snapshotsDir, "mysnap.zip");
        using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            var entry = archive.CreateEntry("restored-marker.txt");
            using var w = new StreamWriter(entry.Open());
            w.Write("restore-ok");
        }
        // Manifest is not needed for Restore itself, only for ListSnapshots
        // But the zip must exist (which it does)

        var result = _mgr.Restore("mysnap");

        Assert.True(result.Success, result.Message);
        Assert.True(File.Exists(Path.Combine(_dataDir, "restored-marker.txt")));
    }

    [Fact]
    public void Restore_ValidSnapshot_WipesExistingDataBeforeExtract()
    {
        // Pre-populate data dir with known DataFiles and DataDirs
        File.WriteAllText(Path.Combine(_dataDir, "memory.db"), "old");
        Directory.CreateDirectory(Path.Combine(_dataDir, "threads"));
        File.WriteAllText(Path.Combine(_dataDir, "threads", "old.json"), "stale");

        // Create snapshot that only puts a new memory.db (no threads/)
        string zipPath = Path.Combine(_snapshotsDir, "cleanwipe.zip");
        using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            var entry = archive.CreateEntry("memory.db");
            using var w = new StreamWriter(entry.Open());
            w.Write("new-content");
        }

        _mgr.Restore("cleanwipe");

        // threads/ must be gone — wiped before extract, not in snapshot
        Assert.False(Directory.Exists(Path.Combine(_dataDir, "threads")));
        // memory.db should contain the snapshot's version
        Assert.Equal("new-content", File.ReadAllText(Path.Combine(_dataDir, "memory.db")));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void CreateSnapshot(string name, DateTimeOffset createdAt, string mcpVersion)
    {
        var manifest = new { createdAt = createdAt.ToString("o"), mcpVersion };
        File.WriteAllText(
            Path.Combine(_snapshotsDir, name + ".json"),
            JsonSerializer.Serialize(manifest));
        CreateZipPlaceholder(name);
    }

    private void CreateZipPlaceholder(string name)
    {
        string zipPath = Path.Combine(_snapshotsDir, name + ".zip");
        using var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create);
        // Empty zip is valid for listing (size = FileInfo.Length of the archive file)
    }

    public void Dispose()
    {
        if (Directory.Exists(_tmpDir))
            Directory.Delete(_tmpDir, recursive: true);
    }
}
