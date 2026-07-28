using System.Text.Json.Serialization;

internal sealed class MessageRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("meta")]
    public string? Meta { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("usage")]
    public string? Usage { get; set; }

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }

    [JsonPropertyName("content_bytes")]
    public int ContentBytes { get; set; }
}

internal sealed class MessageLocatorRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("meta")]
    public string? Meta { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }
}

internal sealed class MessageIndexRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("meta")]
    public string? Meta { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }

    [JsonPropertyName("content_bytes")]
    public int ContentBytes { get; set; }
}

internal sealed class MessageRangeRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string? Content { get; set; }

    [JsonPropertyName("preview")]
    public string? Preview { get; set; }

    [JsonPropertyName("meta")]
    public string? Meta { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("usage")]
    public string? Usage { get; set; }

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }

    [JsonPropertyName("content_bytes")]
    public int ContentBytes { get; set; }

    [JsonPropertyName("content_state")]
    public string ContentState { get; set; } = "full";
}

internal sealed record MessageContentMatch(
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("snippet")] string Snippet);

internal sealed record MessageMutationResult(
    bool Success,
    int Changed,
    string? Error,
    bool Inserted = false);

internal sealed record MessageDeleteResult(bool Success, bool Deleted, string? Error);

internal sealed record MessageCountResult(bool Success, int Count, string? Error);

internal sealed record MessageWindowResult(
    bool Success,
    List<MessageRow> Rows,
    int Start,
    int End,
    int Total,
    int AnchorSortOrder,
    string? Error);

internal sealed record MessageWindowIndexResult(
    bool Success,
    List<MessageIndexRow> Rows,
    int Start,
    int End,
    int Total,
    bool HasOlder,
    bool HasNewer,
    int LoadedBytes,
    string? Error);

internal sealed record MessageRangeResult(
    bool Success,
    List<MessageRangeRow> Rows,
    int Start,
    int End,
    int Total,
    bool HasOlder,
    bool HasNewer,
    int LoadedBytes,
    string? Error);

internal sealed record MessageContentResult(
    bool Success,
    MessageRow? Row,
    string? Error);

internal sealed record MessageInsertArtifactsResult(
    bool Success,
    int Inserted,
    int Start,
    int End,
    int Total,
    string? Error);

internal sealed record MessageDeleteLastResult(bool Success, MessageRow? Message, string? Error);

internal sealed record MessageCompactResult(
    bool Success,
    int TotalMessages,
    int Compacted,
    string? Error);

internal sealed record MessageUsageStatsResult(
    bool Success,
    bool HasUsage,
    double TotalInput,
    double TotalOutput,
    double TotalCacheCreation,
    double TotalCacheRead,
    double TotalReasoning,
    double TotalDurationMs,
    int RequestCount,
    int AssistantReplies,
    long? FirstCreatedAt,
    long? LastCreatedAt,
    string? Error);

internal sealed record MessageInput(
    string Id,
    string SessionId,
    string Role,
    string Content,
    string? Meta,
    long CreatedAt,
    string? Usage,
    int SortOrder);
