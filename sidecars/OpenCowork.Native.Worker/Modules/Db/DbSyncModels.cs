using System.Text.Json;

internal sealed class DbSyncTableSchema
{
    public string Name { get; set; } = string.Empty;

    public List<string> Columns { get; set; } = new();

    public List<string> PkColumns { get; set; } = new();

    public List<string> Dependencies { get; set; } = new();
}

internal interface DbSyncTableRecord
{
    string Domain { get; }

    string RecordId { get; }
}

internal sealed class DbSyncRecordDraft : DbSyncTableRecord
{
    public string Domain { get; set; } = string.Empty;

    public string RecordId { get; set; } = string.Empty;

    public JsonElement Value { get; set; }

    public long? UpdatedAt { get; set; }
}

internal sealed class DbSyncBaselineRecordState
{
    public string Domain { get; set; } = string.Empty;

    public string RecordId { get; set; } = string.Empty;

    public string ContentHash { get; set; } = string.Empty;
}

internal sealed class DbSyncTombstone : DbSyncTableRecord
{
    public string Domain { get; set; } = string.Empty;

    public string RecordId { get; set; } = string.Empty;

    public long DeletedAt { get; set; }

    public string OriginDeviceId { get; set; } = string.Empty;
}

internal sealed record DbSyncSnapshotResult(
    bool Success,
    List<DbSyncRecordDraft> Records,
    List<DbSyncBaselineRecordState> Baseline,
    List<DbSyncTombstone> Tombstones,
    string? Error);

internal sealed record DbSyncMutationResult(
    bool Success,
    int Changed,
    string? Error);

internal sealed record DbSyncCapturedColumn(string Name, object? Value);

internal sealed record DbSyncCapturedRecord(
    string Domain,
    string RecordId,
    string TableName,
    List<DbSyncCapturedColumn> Columns,
    long? UpdatedAt);
