using System.Text.Json;

internal static class DbQqWakeupTools
{
    private const string SourcePeriodKey = "__source__";

    public static WorkerResponse ResolveEligibility(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var openId = RequireString(parameters, "openId");
            var now = JsonHelpers.GetLong(parameters, "now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var sourceCommand = connection.CreateCommand();
            sourceCommand.CommandText = """
                SELECT source_message_id, source_timestamp
                  FROM qq_wakeup_windows
                 WHERE plugin_id = $pluginId
                   AND open_id = $openId
                   AND period_key = $periodKey
                 LIMIT 1
                """;
            sourceCommand.Parameters.AddWithValue("$pluginId", pluginId);
            sourceCommand.Parameters.AddWithValue("$openId", openId);
            sourceCommand.Parameters.AddWithValue("$periodKey", SourcePeriodKey);

            string? sourceMessageId = null;
            var sourceTimestamp = now;
            using (var reader = sourceCommand.ExecuteReader())
            {
                if (reader.Read())
                {
                    sourceMessageId = reader.IsDBNull(0) ? null : reader.GetString(0);
                    sourceTimestamp = reader.GetInt64(1);
                }
            }

            var periodKey = GetWakeupPeriodKey(sourceTimestamp, now);
            if (periodKey is null)
            {
                return WorkerResponse.Json(
                    new QqWakeupEligibilityResult(
                        true,
                        false,
                        null,
                        sourceMessageId,
                        sourceTimestamp,
                        null),
                    WorkerJsonContext.Default.QqWakeupEligibilityResult);
            }

            using var existingCommand = connection.CreateCommand();
            existingCommand.CommandText = """
                SELECT 1
                  FROM qq_wakeup_windows
                 WHERE plugin_id = $pluginId
                   AND open_id = $openId
                   AND period_key = $periodKey
                 LIMIT 1
                """;
            existingCommand.Parameters.AddWithValue("$pluginId", pluginId);
            existingCommand.Parameters.AddWithValue("$openId", openId);
            existingCommand.Parameters.AddWithValue("$periodKey", periodKey);
            var existing = existingCommand.ExecuteScalar() is not null;

            return WorkerResponse.Json(
                new QqWakeupEligibilityResult(
                    true,
                    !existing,
                    periodKey,
                    sourceMessageId,
                    sourceTimestamp,
                    null),
                WorkerJsonContext.Default.QqWakeupEligibilityResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new QqWakeupEligibilityResult(false, false, null, null, 0, ex.Message),
                WorkerJsonContext.Default.QqWakeupEligibilityResult);
        }
    }

    public static WorkerResponse MarkSent(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var openId = RequireString(parameters, "openId");
            var periodKey = RequireString(parameters, "periodKey");
            var sourceMessageId = JsonHelpers.GetString(parameters, "sourceMessageId");
            var sourceTimestamp = JsonHelpers.GetLong(parameters, "sourceTimestamp", 0);
            var now = JsonHelpers.GetLong(parameters, "now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT OR REPLACE INTO qq_wakeup_windows (
                  plugin_id,
                  open_id,
                  period_key,
                  source_message_id,
                  source_timestamp,
                  sent_at,
                  created_at,
                  updated_at
                )
                VALUES (
                  $pluginId,
                  $openId,
                  $periodKey,
                  $sourceMessageId,
                  $sourceTimestamp,
                  $sentAt,
                  COALESCE((
                    SELECT created_at
                      FROM qq_wakeup_windows
                     WHERE plugin_id = $pluginId
                       AND open_id = $openId
                       AND period_key = $periodKey
                  ), $createdAt),
                  $updatedAt
                )
                """,
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$openId", openId),
                new DbSql.SqlParam("$periodKey", periodKey),
                new DbSql.SqlParam("$sourceMessageId", sourceMessageId),
                new DbSql.SqlParam("$sourceTimestamp", sourceTimestamp),
                new DbSql.SqlParam("$sentAt", now),
                new DbSql.SqlParam("$createdAt", now),
                new DbSql.SqlParam("$updatedAt", now));
            transaction.Commit();

            return WorkerResponse.Json(
                new QqWakeupMutationResult(true, changed, null),
                WorkerJsonContext.Default.QqWakeupMutationResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new QqWakeupMutationResult(false, 0, ex.Message),
                WorkerJsonContext.Default.QqWakeupMutationResult);
        }
    }

    private static string? GetWakeupPeriodKey(long sourceTimestamp, long now)
    {
        var diffMs = now - sourceTimestamp;
        if (diffMs < 0)
        {
            return null;
        }

        const long dayMs = 24 * 60 * 60 * 1000;
        if (diffMs < dayMs)
        {
            return "day-0";
        }
        if (diffMs < 3 * dayMs)
        {
            return "day-1-3";
        }
        if (diffMs < 7 * dayMs)
        {
            return "day-3-7";
        }
        if (diffMs < 30 * dayMs)
        {
            return "day-7-30";
        }
        return null;
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        var value = JsonHelpers.GetString(parameters, name);
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException($"Missing required string parameter: {name}");
        }
        return value;
    }
}
