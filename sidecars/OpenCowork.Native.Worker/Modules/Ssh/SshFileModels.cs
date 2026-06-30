internal sealed record SshFileMutationResult(
    bool Success,
    string? Error,
    string? Op = null);

internal sealed record SshFileHomeResult(
    bool Success,
    string? Path,
    string? Error);

internal sealed record SshFileTextResult(
    bool Success,
    string? Content,
    string? Name,
    string? Path,
    int? LineCount,
    int? MaxLines,
    bool? Truncated,
    string? Error);

internal sealed record SshFileBinaryResult(
    bool Success,
    string? Data,
    string? Error);

internal sealed record SshFileStatResult(
    bool Success,
    bool Exists,
    string? Type,
    long? Size,
    long? MtimeMs,
    string? Error);

internal sealed record SshFileListResult(
    bool Success,
    List<SshFileListEntry>? Entries,
    bool? HasMore,
    string? NextCursor,
    string? Error);

internal sealed record SshFileListEntry(
    string Name,
    string Path,
    string Type,
    long Size,
    long ModifyTime);

internal sealed record SshFilePathResult(
    bool Success,
    string? Path,
    string? Error);

internal sealed record SshTransferScanResult(
    bool Success,
    SshTransferNode? Node,
    string? Error);

internal sealed record SshTransferNode(
    string Name,
    string Type,
    long Size,
    long ItemCount,
    long TotalBytes,
    string RemotePath,
    string? ConnectionId,
    List<SshTransferNode>? Children);
