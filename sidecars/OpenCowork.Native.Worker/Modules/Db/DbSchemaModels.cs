internal sealed record DbInitializeResult(
    bool Success,
    string DbPath,
    string? Error);
