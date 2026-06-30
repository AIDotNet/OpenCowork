using System.Text.Json.Serialization;

internal sealed class MemoryAutomationEntry
{
    public string Id { get; set; } = string.Empty;

    public string Scope { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? RootScope { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? MemoryRootId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? JobId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ProjectId { get; set; }

    public string Target { get; set; } = string.Empty;

    public string Kind { get; set; } = string.Empty;

    public string Content { get; set; } = string.Empty;

    public double Confidence { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SourceSessionId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? TargetPath { get; set; }

    public string Status { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? FilterReason { get; set; }

    public string Fingerprint { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? EvidenceJson { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? WrittenAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Error { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? BeforeContent { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? AfterContent { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? AppendedText { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SshConnectionId { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? UndoneAt { get; set; }
}

internal sealed record MemoryAutomationEntryResult(
    bool Success,
    MemoryAutomationEntry? Entry,
    string? Error);

internal sealed record MemoryAutomationRollupResult(
    bool Success,
    bool AlreadyProcessed,
    string? Error);
