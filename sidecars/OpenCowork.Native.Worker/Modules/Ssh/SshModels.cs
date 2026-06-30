internal sealed record SshExecResult(
    bool Success,
    int ExitCode,
    string Stdout,
    string Stderr,
    string? Error,
    SshExecTiming Timing);

internal sealed record SshExecTiming(
    long TotalMs,
    long SpawnMs,
    bool TimedOut,
    string Engine);

internal sealed record SshConnectionTestResult(
    bool Success,
    string? Error,
    SshExecTiming? Timing);

internal sealed record SshFileTransferResult(
    bool Success,
    string? Error,
    string? Path,
    long Bytes,
    SshExecTiming? Timing);

internal sealed record SshUploadProgress(
    long Current,
    long Total,
    int? Percent);

internal sealed record SshUploadProgressEvent(
    string TaskId,
    string ConnectionId,
    string Stage,
    SshUploadProgress? Progress,
    string? Message);

internal sealed record SshTransferProgress(
    long CurrentBytes,
    long TotalBytes,
    int Percent,
    long ProcessedItems,
    long TotalItems);

internal sealed record SshTransferProgressEvent(
    string TaskId,
    string Type,
    string Stage,
    string? SourceConnectionId,
    string? TargetConnectionId,
    SshTransferProgress? Progress,
    string? Message,
    string? CurrentItem,
    string? ConflictPolicy);
