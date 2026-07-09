internal sealed record HookTrustRow(
    string Id,
    string IdentityKey,
    string TrustKey,
    string SourceKind,
    string SourcePath,
    string SourceRealPath,
    string SourceConfigHash,
    string? ProjectId,
    string? ProjectRoot,
    string? ProjectRootRealPath,
    string EventName,
    string Matcher,
    string HandlerType,
    string Command,
    string ResolvedCwd,
    string EnvFingerprint,
    string DefinitionHash,
    string? ArtifactHashesJson,
    string Status,
    bool LocalDisabled,
    string SnapshotJson,
    long? LastReviewedAt,
    long CreatedAt,
    long UpdatedAt);

internal sealed record HookTrustListResult(bool Success, List<HookTrustRow> Rows, string? Error);

internal sealed record HookTrustMutationResult(bool Success, int Changed, HookTrustRow? Row, string? Error);

internal sealed record HookRunRow(
    string Id,
    string TrustKey,
    string? RunId,
    string? SessionId,
    string EventName,
    long StartedAt,
    long? CompletedAt,
    long? DurationMs,
    string Status,
    int? ExitCode,
    string? SkippedReason,
    string? StdoutPreview,
    string? StderrPreview,
    string? DecisionJson,
    string? Error,
    long? RetainedUntil);

internal sealed record HookRunListResult(bool Success, List<HookRunRow> Rows, string? Error);

internal sealed record HookRunMutationResult(bool Success, int Changed, string? Error);
