namespace Sensorium.Supervisor.Services;

public record SnapshotInfo(string Name, DateTimeOffset CreatedAt, long ZipSizeBytes, string McpVersion);

public record SnapshotRestoreResult(bool Success, string Message);

public interface ISnapshotManager
{
    List<SnapshotInfo> ListSnapshots();
    SnapshotRestoreResult Restore(string snapshotName);
}
