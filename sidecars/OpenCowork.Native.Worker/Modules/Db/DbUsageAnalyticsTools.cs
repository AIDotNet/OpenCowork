using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbUsageAnalyticsTools
{
    private const int DefaultListLimit = 50;
    private const int MaxListLimit = 200;

    private const string EffectiveInputTokensExpr = """
        COALESCE(
          billable_input_tokens,
          MAX(input_tokens - COALESCE(cache_read_tokens, 0) - COALESCE(cache_creation_tokens, 0), 0)
        )
        """;

    public static WorkerResponse Query(JsonElement parameters)
    {
        var operation = JsonHelpers.GetString(parameters, "operation") ?? string.Empty;

        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);

            var result = operation switch
            {
                "overview" => UsageAnalyticsResult.One(GetRawOverview(connection, parameters)),
                "daily" => UsageAnalyticsResult.Many(GetRawDaily(connection, parameters)),
                "timeline" => UsageAnalyticsResult.Many(GetRawTimeline(connection, parameters)),
                "by-model" => UsageAnalyticsResult.Many(GetRawByModel(connection, parameters)),
                "by-provider" => UsageAnalyticsResult.Many(GetRawByProvider(connection, parameters)),
                "activity-overview" => UsageAnalyticsResult.One(GetActivityOverview(connection, parameters)),
                "activity-daily" => UsageAnalyticsResult.Many(GetActivityDaily(connection, parameters)),
                "activity-by-model" => UsageAnalyticsResult.Many(GetActivityByModel(connection, parameters)),
                "activity-by-provider" => UsageAnalyticsResult.Many(GetActivityByProvider(connection, parameters)),
                "list" => UsageAnalyticsResult.Many(GetUsageEventList(connection, parameters)),
                "delete" => UsageAnalyticsResult.DeleteCount(DeleteUsageEvents(connection, parameters)),
                _ => UsageAnalyticsResult.Failure($"Unsupported usage query operation: {operation}")
            };

            return WorkerResponse.Json(result, WorkerJsonContext.Default.UsageAnalyticsResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                UsageAnalyticsResult.Failure(ex.Message),
                WorkerJsonContext.Default.UsageAnalyticsResult);
        }
    }

    private static UsageAnalyticsRow? GetRawOverview(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        return QueryOne(
            connection,
            $$"""
            SELECT
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              AVG(ttft_ms) AS avg_ttft_ms,
              AVG(total_ms) AS avg_total_ms
            FROM usage_events
            {{where.Clause}}
            """,
            where.Parameters);
    }

    private static List<UsageAnalyticsRow> GetRawDaily(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        return QueryRows(
            connection,
            $$"""
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              AVG(ttft_ms) AS avg_ttft_ms,
              AVG(total_ms) AS avg_total_ms
            FROM usage_events
            {{where.Clause}}
            GROUP BY day
            ORDER BY day DESC
            """,
            where.Parameters);
    }

    private static List<UsageAnalyticsRow> GetRawTimeline(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        var bucket = JsonHelpers.GetString(parameters, "bucket") == "hour" ? "hour" : "day";
        var bucketLabelExpr = bucket == "hour"
            ? "strftime('%Y-%m-%d %H:00', created_at / 1000, 'unixepoch', 'localtime')"
            : "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')";

        return QueryRows(
            connection,
            $$"""
            SELECT
              {{bucketLabelExpr}} AS bucket_label,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
            FROM usage_events
            {{where.Clause}}
            GROUP BY bucket_label
            ORDER BY bucket_label DESC
            """,
            where.Parameters);
    }

    private static List<UsageAnalyticsRow> GetRawByModel(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        return QueryRows(
            connection,
            $$"""
            SELECT
              model_id,
              model_name,
              provider_id,
              provider_name,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              AVG(ttft_ms) AS avg_ttft_ms,
              AVG(total_ms) AS avg_total_ms
            FROM usage_events
            {{where.Clause}}
            GROUP BY model_id, model_name, provider_id, provider_name
            ORDER BY total_cost_usd DESC, request_count DESC
            """,
            where.Parameters);
    }

    private static List<UsageAnalyticsRow> GetRawByProvider(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        return QueryRows(
            connection,
            $$"""
            SELECT
              provider_id,
              provider_name,
              provider_type,
              provider_builtin_id,
              provider_base_url,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              AVG(ttft_ms) AS avg_ttft_ms,
              AVG(total_ms) AS avg_total_ms
            FROM usage_events
            {{where.Clause}}
            GROUP BY provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url
            ORDER BY total_cost_usd DESC, request_count DESC
            """,
            where.Parameters);
    }

    private static UsageAnalyticsRow? GetActivityOverview(SqliteConnection connection, JsonElement parameters)
    {
        var range = ReadActivityRange(parameters);
        return QueryOne(
            connection,
            """
            SELECT
              COALESCE(SUM(request_count), 0) AS request_count,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(input_tokens), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              NULL AS avg_ttft_ms,
              NULL AS avg_total_ms
            FROM usage_activity_daily
            WHERE day >= $fromDay AND day <= $toDay
            """,
            new List<SqlParam> { new("$fromDay", range.FromDay), new("$toDay", range.ToDay) });
    }

    private static List<UsageAnalyticsRow> GetActivityDaily(SqliteConnection connection, JsonElement parameters)
    {
        var range = ReadActivityRange(parameters);
        return QueryRows(
            connection,
            """
            SELECT
              day,
              request_count,
              input_tokens,
              input_tokens AS billable_input_tokens,
              input_tokens + cache_creation_tokens + cache_read_tokens AS total_input_tokens,
              output_tokens,
              cache_creation_tokens,
              cache_read_tokens,
              reasoning_tokens,
              total_cost_usd,
              NULL AS avg_ttft_ms,
              NULL AS avg_total_ms
            FROM usage_activity_daily
            WHERE day >= $fromDay AND day <= $toDay
            ORDER BY day DESC
            """,
            new List<SqlParam> { new("$fromDay", range.FromDay), new("$toDay", range.ToDay) });
    }

    private static List<UsageAnalyticsRow> GetActivityByModel(SqliteConnection connection, JsonElement parameters)
    {
        var range = ReadActivityRange(parameters);
        var limit = ClampLimit(JsonHelpers.GetInt(parameters, "limit", DefaultListLimit));
        var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));
        return QueryRows(
            connection,
            """
            SELECT
              NULLIF(model_id, '') AS model_id,
              COALESCE(MAX(model_name), NULLIF(model_id, ''), '-') AS model_name,
              NULLIF(provider_id, '') AS provider_id,
              COALESCE(MAX(provider_name), NULLIF(provider_id, ''), '-') AS provider_name,
              COALESCE(SUM(request_count), 0) AS request_count,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(input_tokens), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
            FROM usage_activity_daily_models
            WHERE day >= $fromDay AND day <= $toDay
            GROUP BY model_id, provider_id
            ORDER BY
              COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) +
                COALESCE(SUM(cache_creation_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) DESC,
              COALESCE(SUM(request_count), 0) DESC
            LIMIT $limit OFFSET $offset
            """,
            new List<SqlParam>
            {
                new("$fromDay", range.FromDay),
                new("$toDay", range.ToDay),
                new("$limit", limit),
                new("$offset", offset)
            });
    }

    private static List<UsageAnalyticsRow> GetActivityByProvider(SqliteConnection connection, JsonElement parameters)
    {
        var range = ReadActivityRange(parameters);
        var limit = ClampLimit(JsonHelpers.GetInt(parameters, "limit", DefaultListLimit));
        var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));
        return QueryRows(
            connection,
            """
            SELECT
              NULLIF(provider_id, '') AS provider_id,
              COALESCE(MAX(provider_name), NULLIF(provider_id, ''), '-') AS provider_name,
              MAX(provider_type) AS provider_type,
              MAX(provider_builtin_id) AS provider_builtin_id,
              MAX(provider_base_url) AS provider_base_url,
              COALESCE(SUM(request_count), 0) AS request_count,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(input_tokens), 0) AS billable_input_tokens,
              COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
            FROM usage_activity_daily_providers
            WHERE day >= $fromDay AND day <= $toDay
            GROUP BY provider_id
            ORDER BY
              COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) +
                COALESCE(SUM(cache_creation_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) DESC,
              COALESCE(SUM(request_count), 0) DESC
            LIMIT $limit OFFSET $offset
            """,
            new List<SqlParam>
            {
                new("$fromDay", range.FromDay),
                new("$toDay", range.ToDay),
                new("$limit", limit),
                new("$offset", offset)
            });
    }

    private static List<UsageAnalyticsRow> GetUsageEventList(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        where.Parameters.Add(new SqlParam("$limit", ClampLimit(query.Limit ?? DefaultListLimit)));
        where.Parameters.Add(new SqlParam("$offset", Math.Max(0, query.Offset ?? 0)));

        return QueryRows(
            connection,
            $$"""
            SELECT
              id,
              created_at,
              request_started_at,
              request_finished_at,
              session_id,
              message_id,
              project_id,
              source_kind,
              provider_id,
              provider_name,
              provider_type,
              provider_builtin_id,
              provider_base_url,
              model_id,
              model_name,
              model_category,
              request_type,
              input_tokens,
              billable_input_tokens,
              output_tokens,
              cache_creation_tokens,
              cache_read_tokens,
              reasoning_tokens,
              context_tokens,
              input_price,
              output_price,
              cache_creation_price,
              cache_hit_price,
              input_cost_usd,
              output_cost_usd,
              cache_creation_cost_usd,
              cache_hit_cost_usd,
              total_cost_usd,
              ttft_ms,
              total_ms,
              tps,
              provider_response_id,
              LENGTH(COALESCE(request_debug_json, '')) AS request_debug_chars,
              LENGTH(COALESCE(usage_raw_json, '')) AS usage_raw_chars,
              LENGTH(COALESCE(meta_json, '')) AS meta_chars
            FROM usage_events
            {{where.Clause}}
            ORDER BY created_at DESC
            LIMIT $limit OFFSET $offset
            """,
            where.Parameters);
    }

    private static int DeleteUsageEvents(SqliteConnection connection, JsonElement parameters)
    {
        var query = ReadUsageQuery(parameters);
        var where = BuildRawWhere(query);
        using var command = CreateCommand(connection, $"DELETE FROM usage_events {where.Clause}", where.Parameters);
        return command.ExecuteNonQuery();
    }

    private static UsageQuery ReadUsageQuery(JsonElement parameters)
    {
        return new UsageQuery(
            JsonHelpers.GetLong(parameters, "from", 0),
            JsonHelpers.GetLong(parameters, "to", DateTimeOffset.Now.ToUnixTimeMilliseconds()),
            JsonHelpers.GetString(parameters, "providerId"),
            JsonHelpers.GetString(parameters, "modelId"),
            JsonHelpers.GetString(parameters, "sourceKind"),
            JsonHelpers.GetIntNullable(parameters, "limit"),
            JsonHelpers.GetIntNullable(parameters, "offset"));
    }

    private static ActivityRange ReadActivityRange(JsonElement parameters)
    {
        return new ActivityRange(
            FormatActivityDay(JsonHelpers.GetLong(parameters, "from", 0)),
            FormatActivityDay(JsonHelpers.GetLong(parameters, "to", DateTimeOffset.Now.ToUnixTimeMilliseconds())));
    }

    private static (string Clause, List<SqlParam> Parameters) BuildRawWhere(UsageQuery query)
    {
        var where = new List<string> { "created_at >= $from", "created_at <= $to" };
        var parameters = new List<SqlParam>
        {
            new("$from", query.From),
            new("$to", query.To)
        };

        if (!string.IsNullOrWhiteSpace(query.ProviderId))
        {
            where.Add("provider_id = $providerId");
            parameters.Add(new SqlParam("$providerId", query.ProviderId));
        }
        if (!string.IsNullOrWhiteSpace(query.ModelId))
        {
            where.Add("model_id = $modelId");
            parameters.Add(new SqlParam("$modelId", query.ModelId));
        }
        if (!string.IsNullOrWhiteSpace(query.SourceKind))
        {
            where.Add("source_kind = $sourceKind");
            parameters.Add(new SqlParam("$sourceKind", query.SourceKind));
        }

        return ($"WHERE {string.Join(" AND ", where)}", parameters);
    }

    private static UsageAnalyticsRow? QueryOne(
        SqliteConnection connection,
        string commandText,
        IReadOnlyList<SqlParam> parameters)
    {
        using var command = CreateCommand(connection, commandText, parameters);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadRow(reader) : null;
    }

    private static List<UsageAnalyticsRow> QueryRows(
        SqliteConnection connection,
        string commandText,
        IReadOnlyList<SqlParam> parameters)
    {
        using var command = CreateCommand(connection, commandText, parameters);
        using var reader = command.ExecuteReader();
        var rows = new List<UsageAnalyticsRow>();
        while (reader.Read())
        {
            rows.Add(ReadRow(reader));
        }
        return rows;
    }

    private static SqliteCommand CreateCommand(
        SqliteConnection connection,
        string commandText,
        IReadOnlyList<SqlParam> parameters)
    {
        var command = connection.CreateCommand();
        command.CommandText = commandText;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }
        return command;
    }

    private static UsageAnalyticsRow ReadRow(SqliteDataReader reader)
    {
        var row = new UsageAnalyticsRow();
        for (var i = 0; i < reader.FieldCount; i++)
        {
            if (reader.IsDBNull(i))
            {
                continue;
            }

            var name = reader.GetName(i);
            switch (name)
            {
                case "id": row.Id = reader.GetString(i); break;
                case "day": row.Day = reader.GetString(i); break;
                case "bucket_label": row.BucketLabel = reader.GetString(i); break;
                case "session_id": row.SessionId = reader.GetString(i); break;
                case "message_id": row.MessageId = reader.GetString(i); break;
                case "project_id": row.ProjectId = reader.GetString(i); break;
                case "source_kind": row.SourceKind = reader.GetString(i); break;
                case "provider_id": row.ProviderId = reader.GetString(i); break;
                case "provider_name": row.ProviderName = reader.GetString(i); break;
                case "provider_type": row.ProviderType = reader.GetString(i); break;
                case "provider_builtin_id": row.ProviderBuiltinId = reader.GetString(i); break;
                case "provider_base_url": row.ProviderBaseUrl = reader.GetString(i); break;
                case "model_id": row.ModelId = reader.GetString(i); break;
                case "model_name": row.ModelName = reader.GetString(i); break;
                case "model_category": row.ModelCategory = reader.GetString(i); break;
                case "request_type": row.RequestType = reader.GetString(i); break;
                case "provider_response_id": row.ProviderResponseId = reader.GetString(i); break;
                case "created_at": row.CreatedAt = reader.GetInt64(i); break;
                case "request_started_at": row.RequestStartedAt = reader.GetInt64(i); break;
                case "request_finished_at": row.RequestFinishedAt = reader.GetInt64(i); break;
                case "request_count": row.RequestCount = reader.GetInt64(i); break;
                case "input_tokens": row.InputTokens = reader.GetInt64(i); break;
                case "billable_input_tokens": row.BillableInputTokens = reader.GetInt64(i); break;
                case "total_input_tokens": row.TotalInputTokens = reader.GetInt64(i); break;
                case "output_tokens": row.OutputTokens = reader.GetInt64(i); break;
                case "cache_creation_tokens": row.CacheCreationTokens = reader.GetInt64(i); break;
                case "cache_read_tokens": row.CacheReadTokens = reader.GetInt64(i); break;
                case "reasoning_tokens": row.ReasoningTokens = reader.GetInt64(i); break;
                case "context_tokens": row.ContextTokens = reader.GetInt64(i); break;
                case "request_debug_chars": row.RequestDebugChars = reader.GetInt64(i); break;
                case "usage_raw_chars": row.UsageRawChars = reader.GetInt64(i); break;
                case "meta_chars": row.MetaChars = reader.GetInt64(i); break;
                case "input_price": row.InputPrice = reader.GetDouble(i); break;
                case "output_price": row.OutputPrice = reader.GetDouble(i); break;
                case "cache_creation_price": row.CacheCreationPrice = reader.GetDouble(i); break;
                case "cache_hit_price": row.CacheHitPrice = reader.GetDouble(i); break;
                case "input_cost_usd": row.InputCostUsd = reader.GetDouble(i); break;
                case "output_cost_usd": row.OutputCostUsd = reader.GetDouble(i); break;
                case "cache_creation_cost_usd": row.CacheCreationCostUsd = reader.GetDouble(i); break;
                case "cache_hit_cost_usd": row.CacheHitCostUsd = reader.GetDouble(i); break;
                case "total_cost_usd": row.TotalCostUsd = reader.GetDouble(i); break;
                case "ttft_ms": row.TtftMs = reader.GetDouble(i); break;
                case "total_ms": row.TotalMs = reader.GetDouble(i); break;
                case "tps": row.Tps = reader.GetDouble(i); break;
                case "avg_ttft_ms": row.AvgTtftMs = reader.GetDouble(i); break;
                case "avg_total_ms": row.AvgTotalMs = reader.GetDouble(i); break;
            }
        }
        return row;
    }

    private static string FormatActivityDay(long timestamp)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).LocalDateTime;
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
    }

    private static int ClampLimit(int limit)
    {
        return Math.Clamp(limit, 1, MaxListLimit);
    }

    private sealed record UsageQuery(
        long From,
        long To,
        string? ProviderId,
        string? ModelId,
        string? SourceKind,
        int? Limit,
        int? Offset);

    private sealed record ActivityRange(string FromDay, string ToDay);

    private sealed record SqlParam(string Name, object? Value);
}
