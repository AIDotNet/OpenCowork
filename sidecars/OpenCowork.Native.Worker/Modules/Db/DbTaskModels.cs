using System.Text.Json.Serialization;

internal sealed class TaskRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("plan_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? PlanId { get; set; }

    [JsonPropertyName("subject")]
    public string Subject { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("active_form")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ActiveForm { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "pending";

    [JsonPropertyName("owner")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Owner { get; set; }

    [JsonPropertyName("blocks")]
    public string Blocks { get; set; } = "[]";

    [JsonPropertyName("blocked_by")]
    public string BlockedBy { get; set; } = "[]";

    [JsonPropertyName("metadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Metadata { get; set; }

    [JsonPropertyName("sort_order")]
    public int SortOrder { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed record TaskFindResult(
    bool Success,
    TaskRow? Task,
    string? Error);

internal sealed record TaskMutationResult(
    bool Success,
    int Changed,
    string? Error);
