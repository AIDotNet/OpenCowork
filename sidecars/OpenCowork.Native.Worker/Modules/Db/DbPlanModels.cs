using System.Text.Json.Serialization;

internal sealed class PlanRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("session_id")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = "drafting";

    [JsonPropertyName("file_path")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? FilePath { get; set; }

    [JsonPropertyName("content")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Content { get; set; }

    [JsonPropertyName("spec_json")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? SpecJson { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed record PlanFindResult(
    bool Success,
    PlanRow? Plan,
    string? Error);

internal sealed record PlanMutationResult(
    bool Success,
    int Changed,
    string? Error);
