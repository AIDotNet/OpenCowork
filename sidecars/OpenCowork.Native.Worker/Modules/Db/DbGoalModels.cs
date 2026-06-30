using System.Text.Json.Serialization;

internal sealed class SessionGoalRow
{
    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("goal_id")]
    public string GoalId { get; set; } = string.Empty;

    [JsonPropertyName("objective")]
    public string Objective { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = "active";

    [JsonPropertyName("token_budget")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? TokenBudget { get; set; }

    [JsonPropertyName("tokens_used")]
    public long TokensUsed { get; set; }

    [JsonPropertyName("time_used_seconds")]
    public long TimeUsedSeconds { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed class SessionGoalEventRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("goal_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? GoalId { get; set; }

    [JsonPropertyName("event_type")]
    public string EventType { get; set; } = string.Empty;

    [JsonPropertyName("message")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Message { get; set; }

    [JsonPropertyName("metadata_json")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? MetadataJson { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }
}

internal sealed record SessionGoalFindResult(
    bool Success,
    SessionGoalRow? Goal,
    string? Error);

internal sealed record SessionGoalClearResult(
    bool Success,
    bool Cleared,
    string? Error);
