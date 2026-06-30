using System.Text.Json.Serialization;

internal sealed record UsageMaintenanceResult(
    bool Success,
    string DbPath,
    long Cutoff,
    int Deleted,
    string? Error);

internal sealed record UsageAddEventResult(
    bool Success,
    string DbPath,
    string? Id,
    long? CreatedAt,
    string? Error);

internal sealed class UsageAnalyticsResult
{
    public bool Success { get; init; }
    public UsageAnalyticsRow? Row { get; init; }
    public List<UsageAnalyticsRow>? Rows { get; init; }
    public int? Deleted { get; init; }
    public string? Error { get; init; }

    public static UsageAnalyticsResult One(UsageAnalyticsRow? row)
    {
        return new UsageAnalyticsResult { Success = true, Row = row ?? new UsageAnalyticsRow() };
    }

    public static UsageAnalyticsResult Many(List<UsageAnalyticsRow> rows)
    {
        return new UsageAnalyticsResult { Success = true, Rows = rows };
    }

    public static UsageAnalyticsResult DeleteCount(int deleted)
    {
        return new UsageAnalyticsResult { Success = true, Deleted = deleted };
    }

    public static UsageAnalyticsResult Failure(string error)
    {
        return new UsageAnalyticsResult { Success = false, Error = error };
    }
}

internal sealed class UsageAnalyticsRow
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("day")]
    public string? Day { get; set; }

    [JsonPropertyName("bucket_label")]
    public string? BucketLabel { get; set; }

    [JsonPropertyName("session_id")]
    public string? SessionId { get; set; }

    [JsonPropertyName("message_id")]
    public string? MessageId { get; set; }

    [JsonPropertyName("project_id")]
    public string? ProjectId { get; set; }

    [JsonPropertyName("source_kind")]
    public string? SourceKind { get; set; }

    [JsonPropertyName("provider_id")]
    public string? ProviderId { get; set; }

    [JsonPropertyName("provider_name")]
    public string? ProviderName { get; set; }

    [JsonPropertyName("provider_type")]
    public string? ProviderType { get; set; }

    [JsonPropertyName("provider_builtin_id")]
    public string? ProviderBuiltinId { get; set; }

    [JsonPropertyName("provider_base_url")]
    public string? ProviderBaseUrl { get; set; }

    [JsonPropertyName("model_id")]
    public string? ModelId { get; set; }

    [JsonPropertyName("model_name")]
    public string? ModelName { get; set; }

    [JsonPropertyName("model_category")]
    public string? ModelCategory { get; set; }

    [JsonPropertyName("request_type")]
    public string? RequestType { get; set; }

    [JsonPropertyName("provider_response_id")]
    public string? ProviderResponseId { get; set; }

    [JsonPropertyName("created_at")]
    public long? CreatedAt { get; set; }

    [JsonPropertyName("request_started_at")]
    public long? RequestStartedAt { get; set; }

    [JsonPropertyName("request_finished_at")]
    public long? RequestFinishedAt { get; set; }

    [JsonPropertyName("request_count")]
    public long? RequestCount { get; set; }

    [JsonPropertyName("input_tokens")]
    public long? InputTokens { get; set; }

    [JsonPropertyName("billable_input_tokens")]
    public long? BillableInputTokens { get; set; }

    [JsonPropertyName("total_input_tokens")]
    public long? TotalInputTokens { get; set; }

    [JsonPropertyName("output_tokens")]
    public long? OutputTokens { get; set; }

    [JsonPropertyName("cache_creation_tokens")]
    public long? CacheCreationTokens { get; set; }

    [JsonPropertyName("cache_read_tokens")]
    public long? CacheReadTokens { get; set; }

    [JsonPropertyName("reasoning_tokens")]
    public long? ReasoningTokens { get; set; }

    [JsonPropertyName("context_tokens")]
    public long? ContextTokens { get; set; }

    [JsonPropertyName("request_debug_chars")]
    public long? RequestDebugChars { get; set; }

    [JsonPropertyName("usage_raw_chars")]
    public long? UsageRawChars { get; set; }

    [JsonPropertyName("meta_chars")]
    public long? MetaChars { get; set; }

    [JsonPropertyName("input_price")]
    public double? InputPrice { get; set; }

    [JsonPropertyName("output_price")]
    public double? OutputPrice { get; set; }

    [JsonPropertyName("cache_creation_price")]
    public double? CacheCreationPrice { get; set; }

    [JsonPropertyName("cache_hit_price")]
    public double? CacheHitPrice { get; set; }

    [JsonPropertyName("input_cost_usd")]
    public double? InputCostUsd { get; set; }

    [JsonPropertyName("output_cost_usd")]
    public double? OutputCostUsd { get; set; }

    [JsonPropertyName("cache_creation_cost_usd")]
    public double? CacheCreationCostUsd { get; set; }

    [JsonPropertyName("cache_hit_cost_usd")]
    public double? CacheHitCostUsd { get; set; }

    [JsonPropertyName("total_cost_usd")]
    public double? TotalCostUsd { get; set; }

    [JsonPropertyName("ttft_ms")]
    public double? TtftMs { get; set; }

    [JsonPropertyName("total_ms")]
    public double? TotalMs { get; set; }

    [JsonPropertyName("tps")]
    public double? Tps { get; set; }

    [JsonPropertyName("avg_ttft_ms")]
    public double? AvgTtftMs { get; set; }

    [JsonPropertyName("avg_total_ms")]
    public double? AvgTotalMs { get; set; }
}
