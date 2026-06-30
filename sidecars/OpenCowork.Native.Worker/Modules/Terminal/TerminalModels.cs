internal sealed record TerminalCreateResult(
    string? Id,
    string? Shell,
    string? Cwd,
    int? Cols,
    int? Rows,
    long? CreatedAt,
    string? Title,
    string? Command,
    string? Error);

internal sealed record TerminalMutationResult(
    bool Success,
    string? Error);

internal sealed record TerminalSnapshotResult(
    bool Success,
    TerminalSessionRecord? Session,
    string? Error);

internal sealed record TerminalSessionRecord(
    string Id,
    string Shell,
    string Cwd,
    int Cols,
    int Rows,
    long CreatedAt,
    string Title,
    string? Command,
    int? ExitCode,
    int? ExitSignal,
    List<TerminalOutputChunk> Buffer);

internal sealed record TerminalOutputChunk(
    int Seq,
    string Data);

internal sealed record TerminalOutputEvent(
    string Id,
    string Data,
    int Seq);

internal sealed record TerminalExitEvent(
    string Id,
    int ExitCode,
    int? Signal);
