using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbUsageWriterTools
{
    private const int JsonMaxChars = 16_384;
    private const int JsonPreviewChars = 12_000;

    public static WorkerResponse AddEvent(JsonElement parameters)
    {
        var dbPath = DbConnectionFactory.ResolveDbPath(parameters);
        try
        {
            var createdAt = JsonHelpers.GetLongNullable(parameters, "created_at")
                ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var usageEvent = ReadUsageEvent(parameters, createdAt);

            using var connection = DbConnectionFactory.OpenReadWrite(dbPath);
            using var transaction = connection.BeginTransaction();

            InsertUsageEvent(connection, transaction, usageEvent);
            UpsertUsageActivity(connection, transaction, usageEvent);

            transaction.Commit();

            return WorkerResponse.Json(
                new UsageAddEventResult(true, dbPath, usageEvent.Id, usageEvent.CreatedAt, null),
                WorkerJsonContext.Default.UsageAddEventResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new UsageAddEventResult(false, dbPath, null, null, ex.Message),
                WorkerJsonContext.Default.UsageAddEventResult);
        }
    }

    private static UsageEventInput ReadUsageEvent(JsonElement parameters, long createdAt)
    {
        return new UsageEventInput(
            RequireString(parameters, "id"),
            createdAt,
            JsonHelpers.GetLongNullable(parameters, "request_started_at"),
            JsonHelpers.GetLongNullable(parameters, "request_finished_at"),
            JsonHelpers.GetString(parameters, "session_id"),
            JsonHelpers.GetString(parameters, "message_id"),
            JsonHelpers.GetString(parameters, "project_id"),
            RequireString(parameters, "source_kind"),
            JsonHelpers.GetString(parameters, "provider_id"),
            JsonHelpers.GetString(parameters, "provider_name"),
            JsonHelpers.GetString(parameters, "provider_type"),
            JsonHelpers.GetString(parameters, "provider_builtin_id"),
            JsonHelpers.GetString(parameters, "provider_base_url"),
            JsonHelpers.GetString(parameters, "model_id"),
            JsonHelpers.GetString(parameters, "model_name"),
            JsonHelpers.GetString(parameters, "model_category"),
            JsonHelpers.GetString(parameters, "request_type"),
            JsonHelpers.GetLong(parameters, "input_tokens", 0),
            JsonHelpers.GetLongNullable(parameters, "billable_input_tokens"),
            JsonHelpers.GetLong(parameters, "output_tokens", 0),
            JsonHelpers.GetLongNullable(parameters, "cache_creation_tokens"),
            JsonHelpers.GetLongNullable(parameters, "cache_read_tokens"),
            JsonHelpers.GetLongNullable(parameters, "reasoning_tokens"),
            JsonHelpers.GetLongNullable(parameters, "context_tokens"),
            JsonHelpers.GetDoubleNullable(parameters, "input_price"),
            JsonHelpers.GetDoubleNullable(parameters, "output_price"),
            JsonHelpers.GetDoubleNullable(parameters, "cache_creation_price"),
            JsonHelpers.GetDoubleNullable(parameters, "cache_hit_price"),
            JsonHelpers.GetDoubleNullable(parameters, "input_cost_usd"),
            JsonHelpers.GetDoubleNullable(parameters, "output_cost_usd"),
            JsonHelpers.GetDoubleNullable(parameters, "cache_creation_cost_usd"),
            JsonHelpers.GetDoubleNullable(parameters, "cache_hit_cost_usd"),
            JsonHelpers.GetDoubleNullable(parameters, "total_cost_usd"),
            JsonHelpers.GetDoubleNullable(parameters, "ttft_ms"),
            JsonHelpers.GetDoubleNullable(parameters, "total_ms"),
            JsonHelpers.GetDoubleNullable(parameters, "tps"),
            JsonHelpers.GetString(parameters, "provider_response_id"),
            TruncateJsonText(JsonHelpers.GetString(parameters, "request_debug_json")),
            TruncateJsonText(JsonHelpers.GetString(parameters, "usage_raw_json")),
            TruncateJsonText(JsonHelpers.GetString(parameters, "meta_json")));
    }

    private static void InsertUsageEvent(
        SqliteConnection connection,
        SqliteTransaction transaction,
        UsageEventInput usageEvent)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO usage_events (
              id, created_at, request_started_at, request_finished_at, session_id, message_id, project_id,
              source_kind, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
              model_id, model_name, model_category, request_type,
              input_tokens, billable_input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, context_tokens,
              input_price, output_price, cache_creation_price, cache_hit_price,
              input_cost_usd, output_cost_usd, cache_creation_cost_usd, cache_hit_cost_usd, total_cost_usd,
              ttft_ms, total_ms, tps, provider_response_id, request_debug_json, usage_raw_json, meta_json
            ) VALUES (
              $id, $createdAt, $requestStartedAt, $requestFinishedAt, $sessionId, $messageId, $projectId,
              $sourceKind, $providerId, $providerName, $providerType, $providerBuiltinId, $providerBaseUrl,
              $modelId, $modelName, $modelCategory, $requestType,
              $inputTokens, $billableInputTokens, $outputTokens, $cacheCreationTokens, $cacheReadTokens,
              $reasoningTokens, $contextTokens,
              $inputPrice, $outputPrice, $cacheCreationPrice, $cacheHitPrice,
              $inputCostUsd, $outputCostUsd, $cacheCreationCostUsd, $cacheHitCostUsd, $totalCostUsd,
              $ttftMs, $totalMs, $tps, $providerResponseId, $requestDebugJson, $usageRawJson, $metaJson
            )
            """;

        AddUsageEventParameters(command, usageEvent);
        command.ExecuteNonQuery();
    }

    private static void UpsertUsageActivity(
        SqliteConnection connection,
        SqliteTransaction transaction,
        UsageEventInput usageEvent)
    {
        var day = FormatActivityDay(usageEvent.CreatedAt);
        var updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var inputTokens = GetEffectiveInputTokens(usageEvent);
        var outputTokens = usageEvent.OutputTokens;
        var cacheCreationTokens = usageEvent.CacheCreationTokens ?? 0;
        var cacheReadTokens = usageEvent.CacheReadTokens ?? 0;
        var reasoningTokens = usageEvent.ReasoningTokens ?? 0;
        var totalCostUsd = usageEvent.TotalCostUsd ?? 0;
        var providerId = usageEvent.ProviderId ?? string.Empty;
        var modelId = usageEvent.ModelId ?? string.Empty;

        ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO usage_activity_daily (
              day, first_at, last_at, request_count, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, reasoning_tokens, total_cost_usd, updated_at
            ) VALUES (
              $day, $createdAt, $createdAt, 1, $inputTokens, $outputTokens,
              $cacheCreationTokens, $cacheReadTokens, $reasoningTokens, $totalCostUsd, $updatedAt
            )
            ON CONFLICT(day) DO UPDATE SET
              first_at = MIN(first_at, excluded.first_at),
              last_at = MAX(last_at, excluded.last_at),
              request_count = request_count + excluded.request_count,
              input_tokens = input_tokens + excluded.input_tokens,
              output_tokens = output_tokens + excluded.output_tokens,
              cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
              cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
              reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
              total_cost_usd = total_cost_usd + excluded.total_cost_usd,
              updated_at = excluded.updated_at
            """,
            new("$day", day),
            new("$createdAt", usageEvent.CreatedAt),
            new("$inputTokens", inputTokens),
            new("$outputTokens", outputTokens),
            new("$cacheCreationTokens", cacheCreationTokens),
            new("$cacheReadTokens", cacheReadTokens),
            new("$reasoningTokens", reasoningTokens),
            new("$totalCostUsd", totalCostUsd),
            new("$updatedAt", updatedAt));

        ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO usage_activity_daily_models (
              day, provider_id, provider_name, model_id, model_name, request_count,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, total_cost_usd, updated_at
            ) VALUES (
              $day, $providerId, $providerName, $modelId, $modelName, 1,
              $inputTokens, $outputTokens, $cacheCreationTokens, $cacheReadTokens,
              $reasoningTokens, $totalCostUsd, $updatedAt
            )
            ON CONFLICT(day, provider_id, model_id) DO UPDATE SET
              provider_name = COALESCE(excluded.provider_name, provider_name),
              model_name = COALESCE(excluded.model_name, model_name),
              request_count = request_count + excluded.request_count,
              input_tokens = input_tokens + excluded.input_tokens,
              output_tokens = output_tokens + excluded.output_tokens,
              cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
              cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
              reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
              total_cost_usd = total_cost_usd + excluded.total_cost_usd,
              updated_at = excluded.updated_at
            """,
            new("$day", day),
            new("$providerId", providerId),
            new("$providerName", usageEvent.ProviderName),
            new("$modelId", modelId),
            new("$modelName", usageEvent.ModelName),
            new("$inputTokens", inputTokens),
            new("$outputTokens", outputTokens),
            new("$cacheCreationTokens", cacheCreationTokens),
            new("$cacheReadTokens", cacheReadTokens),
            new("$reasoningTokens", reasoningTokens),
            new("$totalCostUsd", totalCostUsd),
            new("$updatedAt", updatedAt));

        ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO usage_activity_daily_providers (
              day, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
              request_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, total_cost_usd, updated_at
            ) VALUES (
              $day, $providerId, $providerName, $providerType, $providerBuiltinId, $providerBaseUrl,
              1, $inputTokens, $outputTokens, $cacheCreationTokens, $cacheReadTokens,
              $reasoningTokens, $totalCostUsd, $updatedAt
            )
            ON CONFLICT(day, provider_id) DO UPDATE SET
              provider_name = COALESCE(excluded.provider_name, provider_name),
              provider_type = COALESCE(excluded.provider_type, provider_type),
              provider_builtin_id = COALESCE(excluded.provider_builtin_id, provider_builtin_id),
              provider_base_url = COALESCE(excluded.provider_base_url, provider_base_url),
              request_count = request_count + excluded.request_count,
              input_tokens = input_tokens + excluded.input_tokens,
              output_tokens = output_tokens + excluded.output_tokens,
              cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
              cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
              reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
              total_cost_usd = total_cost_usd + excluded.total_cost_usd,
              updated_at = excluded.updated_at
            """,
            new("$day", day),
            new("$providerId", providerId),
            new("$providerName", usageEvent.ProviderName),
            new("$providerType", usageEvent.ProviderType),
            new("$providerBuiltinId", usageEvent.ProviderBuiltinId),
            new("$providerBaseUrl", usageEvent.ProviderBaseUrl),
            new("$inputTokens", inputTokens),
            new("$outputTokens", outputTokens),
            new("$cacheCreationTokens", cacheCreationTokens),
            new("$cacheReadTokens", cacheReadTokens),
            new("$reasoningTokens", reasoningTokens),
            new("$totalCostUsd", totalCostUsd),
            new("$updatedAt", updatedAt));
    }

    private static void AddUsageEventParameters(SqliteCommand command, UsageEventInput usageEvent)
    {
        command.Parameters.AddWithValue("$id", usageEvent.Id);
        command.Parameters.AddWithValue("$createdAt", usageEvent.CreatedAt);
        command.Parameters.AddWithValue("$requestStartedAt", ToDbValue(usageEvent.RequestStartedAt));
        command.Parameters.AddWithValue("$requestFinishedAt", ToDbValue(usageEvent.RequestFinishedAt));
        command.Parameters.AddWithValue("$sessionId", ToDbValue(usageEvent.SessionId));
        command.Parameters.AddWithValue("$messageId", ToDbValue(usageEvent.MessageId));
        command.Parameters.AddWithValue("$projectId", ToDbValue(usageEvent.ProjectId));
        command.Parameters.AddWithValue("$sourceKind", usageEvent.SourceKind);
        command.Parameters.AddWithValue("$providerId", ToDbValue(usageEvent.ProviderId));
        command.Parameters.AddWithValue("$providerName", ToDbValue(usageEvent.ProviderName));
        command.Parameters.AddWithValue("$providerType", ToDbValue(usageEvent.ProviderType));
        command.Parameters.AddWithValue("$providerBuiltinId", ToDbValue(usageEvent.ProviderBuiltinId));
        command.Parameters.AddWithValue("$providerBaseUrl", ToDbValue(usageEvent.ProviderBaseUrl));
        command.Parameters.AddWithValue("$modelId", ToDbValue(usageEvent.ModelId));
        command.Parameters.AddWithValue("$modelName", ToDbValue(usageEvent.ModelName));
        command.Parameters.AddWithValue("$modelCategory", ToDbValue(usageEvent.ModelCategory));
        command.Parameters.AddWithValue("$requestType", ToDbValue(usageEvent.RequestType));
        command.Parameters.AddWithValue("$inputTokens", usageEvent.InputTokens);
        command.Parameters.AddWithValue("$billableInputTokens", ToDbValue(usageEvent.BillableInputTokens));
        command.Parameters.AddWithValue("$outputTokens", usageEvent.OutputTokens);
        command.Parameters.AddWithValue("$cacheCreationTokens", ToDbValue(usageEvent.CacheCreationTokens));
        command.Parameters.AddWithValue("$cacheReadTokens", ToDbValue(usageEvent.CacheReadTokens));
        command.Parameters.AddWithValue("$reasoningTokens", ToDbValue(usageEvent.ReasoningTokens));
        command.Parameters.AddWithValue("$contextTokens", ToDbValue(usageEvent.ContextTokens));
        command.Parameters.AddWithValue("$inputPrice", ToDbValue(usageEvent.InputPrice));
        command.Parameters.AddWithValue("$outputPrice", ToDbValue(usageEvent.OutputPrice));
        command.Parameters.AddWithValue("$cacheCreationPrice", ToDbValue(usageEvent.CacheCreationPrice));
        command.Parameters.AddWithValue("$cacheHitPrice", ToDbValue(usageEvent.CacheHitPrice));
        command.Parameters.AddWithValue("$inputCostUsd", ToDbValue(usageEvent.InputCostUsd));
        command.Parameters.AddWithValue("$outputCostUsd", ToDbValue(usageEvent.OutputCostUsd));
        command.Parameters.AddWithValue("$cacheCreationCostUsd", ToDbValue(usageEvent.CacheCreationCostUsd));
        command.Parameters.AddWithValue("$cacheHitCostUsd", ToDbValue(usageEvent.CacheHitCostUsd));
        command.Parameters.AddWithValue("$totalCostUsd", ToDbValue(usageEvent.TotalCostUsd));
        command.Parameters.AddWithValue("$ttftMs", ToDbValue(usageEvent.TtftMs));
        command.Parameters.AddWithValue("$totalMs", ToDbValue(usageEvent.TotalMs));
        command.Parameters.AddWithValue("$tps", ToDbValue(usageEvent.Tps));
        command.Parameters.AddWithValue("$providerResponseId", ToDbValue(usageEvent.ProviderResponseId));
        command.Parameters.AddWithValue("$requestDebugJson", ToDbValue(usageEvent.RequestDebugJson));
        command.Parameters.AddWithValue("$usageRawJson", ToDbValue(usageEvent.UsageRawJson));
        command.Parameters.AddWithValue("$metaJson", ToDbValue(usageEvent.MetaJson));
    }

    private static int ExecuteNonQuery(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string commandText,
        params SqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.CommandText = commandText;
        command.Transaction = transaction;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }

        return command.ExecuteNonQuery();
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required usage field: {name}");
    }

    private static long GetEffectiveInputTokens(UsageEventInput usageEvent)
    {
        if (usageEvent.BillableInputTokens is { } billableInputTokens)
        {
            return Math.Max(0, billableInputTokens);
        }

        return Math.Max(
            0,
            usageEvent.InputTokens - (usageEvent.CacheReadTokens ?? 0) - (usageEvent.CacheCreationTokens ?? 0));
    }

    private static string FormatActivityDay(long timestamp)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).LocalDateTime;
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
    }

    private static string? TruncateJsonText(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }
        if (value.Length <= JsonMaxChars)
        {
            return value;
        }

        var preview = value[..Math.Min(JsonPreviewChars, value.Length)]
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
        return $$"""{"__truncated":true,"originalChars":{{value.Length}},"preview":"{{preview}}"}""";
    }

    private static object ToDbValue<T>(T? value)
    {
        return value is null ? DBNull.Value : value;
    }

    private sealed record UsageEventInput(
        string Id,
        long CreatedAt,
        long? RequestStartedAt,
        long? RequestFinishedAt,
        string? SessionId,
        string? MessageId,
        string? ProjectId,
        string SourceKind,
        string? ProviderId,
        string? ProviderName,
        string? ProviderType,
        string? ProviderBuiltinId,
        string? ProviderBaseUrl,
        string? ModelId,
        string? ModelName,
        string? ModelCategory,
        string? RequestType,
        long InputTokens,
        long? BillableInputTokens,
        long OutputTokens,
        long? CacheCreationTokens,
        long? CacheReadTokens,
        long? ReasoningTokens,
        long? ContextTokens,
        double? InputPrice,
        double? OutputPrice,
        double? CacheCreationPrice,
        double? CacheHitPrice,
        double? InputCostUsd,
        double? OutputCostUsd,
        double? CacheCreationCostUsd,
        double? CacheHitCostUsd,
        double? TotalCostUsd,
        double? TtftMs,
        double? TotalMs,
        double? Tps,
        string? ProviderResponseId,
        string? RequestDebugJson,
        string? UsageRawJson,
        string? MetaJson);

    private sealed record SqlParam(string Name, object? Value);
}
