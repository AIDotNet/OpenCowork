using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbMaintenanceTools
{
    private const int CleanupBatchSize = 250;
    private const int CleanupBatchDelayMs = 50;

    private const string EffectiveInputTokensExpr = """
        COALESCE(
          billable_input_tokens,
          MAX(input_tokens - COALESCE(cache_read_tokens, 0) - COALESCE(cache_creation_tokens, 0), 0)
        )
        """;

    public static async Task<WorkerResponse> UsageMaintenanceAsync(JsonElement parameters)
    {
        var dbPath = DbConnectionFactory.ResolveDbPath(parameters);
        var cutoff = GetStartOfLocalDay(DateTimeOffset.Now).ToUnixTimeMilliseconds();

        try
        {
            if (!File.Exists(dbPath))
            {
                return WorkerResponse.Json(
                    new UsageMaintenanceResult(false, dbPath, cutoff, 0, "Database file does not exist"),
                    WorkerJsonContext.Default.UsageMaintenanceResult);
            }

            using var connection = DbConnectionFactory.OpenReadWrite(dbPath);
            EnsureMissingUsageActivityAggregates(connection, cutoff);
            var deleted = await DeleteAggregatedRawEventsAsync(connection, cutoff);

            return WorkerResponse.Json(
                new UsageMaintenanceResult(true, dbPath, cutoff, deleted, null),
                WorkerJsonContext.Default.UsageMaintenanceResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new UsageMaintenanceResult(false, dbPath, cutoff, 0, ex.Message),
                WorkerJsonContext.Default.UsageMaintenanceResult);
        }
    }

    private static DateTimeOffset GetStartOfLocalDay(DateTimeOffset value)
    {
        var local = value.LocalDateTime;
        return new DateTimeOffset(
            local.Year,
            local.Month,
            local.Day,
            0,
            0,
            0,
            value.Offset);
    }

    private static void EnsureMissingUsageActivityAggregates(SqliteConnection connection, long cutoff)
    {
        var updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var transaction = connection.BeginTransaction();

        ExecuteNonQuery(
            connection,
            transaction,
            $$"""
            INSERT OR IGNORE INTO usage_activity_daily (
              day, first_at, last_at, request_count, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, reasoning_tokens, total_cost_usd, updated_at
            )
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              $updatedAt AS updated_at
            FROM usage_events
            WHERE created_at < $cutoff
            GROUP BY day
            """,
            ("$updatedAt", updatedAt),
            ("$cutoff", cutoff));

        ExecuteNonQuery(
            connection,
            transaction,
            $$"""
            INSERT OR IGNORE INTO usage_activity_daily_models (
              day, provider_id, provider_name, model_id, model_name, request_count,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, total_cost_usd, updated_at
            )
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(provider_id, '') AS provider_id,
              provider_name,
              COALESCE(model_id, '') AS model_id,
              model_name,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              $updatedAt AS updated_at
            FROM usage_events
            WHERE created_at < $cutoff
            GROUP BY day, COALESCE(provider_id, ''), COALESCE(model_id, '')
            """,
            ("$updatedAt", updatedAt),
            ("$cutoff", cutoff));

        ExecuteNonQuery(
            connection,
            transaction,
            $$"""
            INSERT OR IGNORE INTO usage_activity_daily_providers (
              day, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
              request_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, total_cost_usd, updated_at
            )
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(provider_id, '') AS provider_id,
              provider_name,
              provider_type,
              provider_builtin_id,
              provider_base_url,
              COUNT(*) AS request_count,
              COALESCE(SUM({{EffectiveInputTokensExpr}}), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              $updatedAt AS updated_at
            FROM usage_events
            WHERE created_at < $cutoff
            GROUP BY day, COALESCE(provider_id, '')
            """,
            ("$updatedAt", updatedAt),
            ("$cutoff", cutoff));

        transaction.Commit();
    }

    private static async Task<int> DeleteAggregatedRawEventsAsync(SqliteConnection connection, long cutoff)
    {
        var deleted = 0;
        while (true)
        {
            var changes = ExecuteNonQuery(
                connection,
                null,
                """
                DELETE FROM usage_events
                WHERE rowid IN (
                  SELECT rowid
                  FROM usage_events
                  WHERE created_at < $cutoff
                    AND EXISTS (
                      SELECT 1
                      FROM usage_activity_daily
                      WHERE day = strftime(
                        '%Y-%m-%d',
                        usage_events.created_at / 1000,
                        'unixepoch',
                        'localtime'
                      )
                    )
                  ORDER BY created_at ASC
                  LIMIT $limit
                )
                """,
                ("$cutoff", cutoff),
                ("$limit", CleanupBatchSize));
            if (changes <= 0)
            {
                break;
            }

            deleted += changes;
            if (changes < CleanupBatchSize)
            {
                break;
            }

            await Task.Delay(CleanupBatchDelayMs);
        }

        return deleted;
    }

    private static int ExecuteNonQuery(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string commandText,
        params (string Name, object? Value)[] parameters)
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
}
