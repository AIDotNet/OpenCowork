using System.Text.Json.Serialization;

internal sealed class StoredFileSnapshot
{
    public bool Exists { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FullText { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PreviewText { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TailPreviewText { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? TextOmitted { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Hash { get; set; }

    public long Size { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? LineCount { get; set; }
}

internal sealed class StoredTrackedFileChange
{
    public string Id { get; set; } = string.Empty;

    public string RunId { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SessionId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolUseId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolName { get; set; }

    public string FilePath { get; set; } = string.Empty;

    public string Transport { get; set; } = "local";

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ConnectionId { get; set; }

    public string Op { get; set; } = "modify";

    public string Status { get; set; } = "open";

    public StoredFileSnapshot Before { get; set; } = new();

    public StoredFileSnapshot After { get; set; } = new();

    public long CreatedAt { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? RevertedAt { get; set; }
}

internal sealed class StoredRunChangeSet
{
    public string RunId { get; set; } = string.Empty;

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SessionId { get; set; }

    public string AssistantMessageId { get; set; } = string.Empty;

    public string Status { get; set; } = "open";

    public List<StoredTrackedFileChange> Changes { get; set; } = new();

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }
}

internal sealed record AgentChangeSetFindResult(
    bool Success,
    StoredRunChangeSet? ChangeSet,
    string? Error);

internal sealed record AgentChangeMutationResult(
    bool Success,
    int Changed,
    string? Error);

internal sealed record AgentChangeDeleteResult(
    bool Success,
    int DeletedRunCount,
    string? Error);
