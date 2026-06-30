using System.Text.Json.Serialization;

internal sealed class DrawRunRow
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("prompt")]
    public string Prompt { get; set; } = string.Empty;

    [JsonPropertyName("provider_name")]
    public string ProviderName { get; set; } = string.Empty;

    [JsonPropertyName("model_name")]
    public string ModelName { get; set; } = string.Empty;

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = "image";

    [JsonPropertyName("meta_json")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? MetaJson { get; set; }

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("is_generating")]
    public int IsGenerating { get; set; }

    [JsonPropertyName("images_json")]
    public string ImagesJson { get; set; } = "[]";

    [JsonPropertyName("error_json")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? ErrorJson { get; set; }

    [JsonPropertyName("updated_at")]
    public long UpdatedAt { get; set; }
}

internal sealed record DrawRunMutationResult(
    bool Success,
    int Changed,
    string? Error);
