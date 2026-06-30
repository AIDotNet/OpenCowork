internal sealed record ShellExecResult(
    bool Success,
    int ExitCode,
    string Stdout,
    string Stderr,
    string? Error,
    string? ProcessId,
    string? TerminalId,
    ShellExecutionTiming Timing);

internal sealed record ShellExecutionTiming(
    long TotalMs,
    long SpawnMs,
    long? FirstChunkMs,
    string Shell,
    bool TimedOut,
    bool Aborted);

internal sealed record ShellAbortResult(
    bool Success,
    bool Aborted,
    string? Error);

internal sealed record ShellStartedEvent(
    string ExecId,
    string ProcessId,
    string TerminalId);

internal sealed record ShellOutputEvent(
    string ExecId,
    string Chunk,
    string Stream);
