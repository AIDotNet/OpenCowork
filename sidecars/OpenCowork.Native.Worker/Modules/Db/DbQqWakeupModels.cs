internal sealed record QqWakeupEligibilityResult(
    bool Success,
    bool Enabled,
    string? PeriodKey,
    string? SourceMessageId,
    long SourceTimestamp,
    string? Error);

internal sealed record QqWakeupMutationResult(
    bool Success,
    int Changed,
    string? Error);
