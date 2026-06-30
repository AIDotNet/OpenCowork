internal sealed record AgentChangeHydratedListResult(
    bool Success,
    List<StoredRunChangeSet>? ChangeSets,
    string? Error);

internal sealed record AgentChangeHydratedGetResult(
    bool Success,
    StoredRunChangeSet? ChangeSet,
    string? Error);

internal sealed record AgentChangeDiffResult(
    bool Success,
    bool Handled,
    bool NotFound,
    string? BeforeText,
    string? AfterText,
    string? Error);

internal sealed record AgentChangeRollbackResult(
    bool Success,
    bool Handled,
    bool Reverted,
    long? RevertedAt,
    string? Reason,
    string? Error);
