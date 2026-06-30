using System.Buffers;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbGoalTools
{
    private const string GoalSelectSql = """
        SELECT session_id,
               goal_id,
               objective,
               status,
               token_budget,
               tokens_used,
               time_used_seconds,
               created_at,
               updated_at
          FROM session_goals
        """;

    private const string GoalEventSelectSql = """
        SELECT id,
               session_id,
               goal_id,
               event_type,
               message,
               metadata_json,
               created_at
          FROM session_goal_events
        """;

    public static WorkerResponse AddEvent(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var row = AddGoalEvent(connection, transaction, parameters);
            transaction.Commit();
            return WorkerResponse.Json(row, WorkerJsonContext.Default.SessionGoalEventRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse ListEvents(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var goalId = NormalizeOptional(JsonHelpers.GetString(parameters, "goalId"));
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 40), 1, 100);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            if (goalId is not null)
            {
                command.CommandText = $"""
                    {GoalEventSelectSql}
                     WHERE session_id = $sessionId AND goal_id = $goalId
                     ORDER BY created_at DESC
                     LIMIT $limit
                    """;
                command.Parameters.AddWithValue("$goalId", goalId);
            }
            else
            {
                command.CommandText = $"""
                    {GoalEventSelectSql}
                     WHERE session_id = $sessionId
                     ORDER BY created_at DESC
                     LIMIT $limit
                    """;
            }
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$limit", limit);
            return WorkerResponse.Json(ReadGoalEvents(command), WorkerJsonContext.Default.ListSessionGoalEventRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse ListGoals(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{GoalSelectSql} ORDER BY updated_at DESC";
            return WorkerResponse.Json(ReadGoals(command), WorkerJsonContext.Default.ListSessionGoalRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse GetGoal(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var goal = GetGoal(connection, null, sessionId);
            return WorkerResponse.Json(
                new SessionGoalFindResult(true, goal, null),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionGoalFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
    }

    public static WorkerResponse CreateGoal(JsonElement parameters)
    {
        try
        {
            var tokenBudget = ReadTokenBudget(parameters, "tokenBudget", false).Value;
            ValidateGoalBudget(tokenBudget);
            var sessionId = RequireString(parameters, "sessionId");
            var now = Now();
            var status = NormalizeStatusAfterBudget("active", 0, tokenBudget);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"""
                INSERT INTO session_goals (
                  session_id, goal_id, objective, status, token_budget,
                  tokens_used, time_used_seconds, created_at, updated_at
                ) VALUES (
                  $sessionId, $goalId, $objective, $status, $tokenBudget, 0, 0, $createdAt, $updatedAt
                )
                ON CONFLICT(session_id) DO NOTHING
                RETURNING {GoalReturningColumns}
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$goalId", CreateId());
            command.Parameters.AddWithValue("$objective", RequireString(parameters, "objective"));
            command.Parameters.AddWithValue("$status", status);
            command.Parameters.AddWithValue("$tokenBudget", tokenBudget ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$createdAt", now);
            command.Parameters.AddWithValue("$updatedAt", now);
            var goal = ReadGoals(command).FirstOrDefault();
            if (goal is not null)
            {
                AddGoalEvent(
                    connection,
                    transaction,
                    goal.SessionId,
                    goal.GoalId,
                    "created",
                    null,
                    WriteMetadata(writer => WriteNullableLong(writer, "tokenBudget", goal.TokenBudget)),
                    null);
            }
            transaction.Commit();
            return WorkerResponse.Json(
                new SessionGoalFindResult(true, goal, null),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionGoalFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
    }

    public static WorkerResponse ReplaceGoal(JsonElement parameters)
    {
        try
        {
            var tokenBudget = ReadTokenBudget(parameters, "tokenBudget", false).Value;
            ValidateGoalBudget(tokenBudget);
            var sessionId = RequireString(parameters, "sessionId");
            var now = Now();
            var status = NormalizeStatusAfterBudget(JsonHelpers.GetString(parameters, "status") ?? "active", 0, tokenBudget);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var existing = GetGoal(connection, transaction, sessionId);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"""
                INSERT INTO session_goals (
                  session_id, goal_id, objective, status, token_budget,
                  tokens_used, time_used_seconds, created_at, updated_at
                ) VALUES (
                  $sessionId, $goalId, $objective, $status, $tokenBudget, 0, 0, $createdAt, $updatedAt
                )
                ON CONFLICT(session_id) DO UPDATE SET
                  goal_id = excluded.goal_id,
                  objective = excluded.objective,
                  status = excluded.status,
                  token_budget = excluded.token_budget,
                  tokens_used = 0,
                  time_used_seconds = 0,
                  created_at = excluded.created_at,
                  updated_at = excluded.updated_at
                RETURNING {GoalReturningColumns}
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$goalId", CreateId());
            command.Parameters.AddWithValue("$objective", RequireString(parameters, "objective"));
            command.Parameters.AddWithValue("$status", status);
            command.Parameters.AddWithValue("$tokenBudget", tokenBudget ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$createdAt", now);
            command.Parameters.AddWithValue("$updatedAt", now);
            var goal = ReadGoals(command).First();
            AddGoalEvent(
                connection,
                transaction,
                goal.SessionId,
                goal.GoalId,
                existing is null ? "created" : "replaced",
                null,
                WriteMetadata(writer =>
                {
                    writer.WriteString("status", goal.Status);
                    WriteNullableLong(writer, "tokenBudget", goal.TokenBudget);
                }),
                null);
            transaction.Commit();
            return WorkerResponse.Json(goal, WorkerJsonContext.Default.SessionGoalRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse UpdateGoal(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            if (!parameters.TryGetProperty("patch", out var patch) || patch.ValueKind != JsonValueKind.Object)
            {
                return WorkerResponse.Json(
                    new SessionGoalFindResult(true, null, null),
                    WorkerJsonContext.Default.SessionGoalFindResult);
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var existing = GetGoal(connection, transaction, sessionId);
            if (existing is null)
            {
                transaction.Commit();
                return WorkerResponse.Json(
                    new SessionGoalFindResult(true, null, null),
                    WorkerJsonContext.Default.SessionGoalFindResult);
            }

            var tokenBudgetPatch = ReadTokenBudget(patch, "tokenBudget", true);
            ValidateGoalBudget(tokenBudgetPatch.Value);
            var objectivePatch = JsonHelpers.GetString(patch, "objective");
            var objectiveChanged = objectivePatch is not null &&
                !string.Equals(objectivePatch.Trim(), existing.Objective.Trim(), StringComparison.Ordinal);

            var row = objectiveChanged
                ? UpdateObjective(connection, transaction, sessionId, existing, patch, tokenBudgetPatch)
                : UpdateExistingGoal(connection, transaction, sessionId, existing, patch, tokenBudgetPatch);
            transaction.Commit();

            return WorkerResponse.Json(
                new SessionGoalFindResult(true, row, null),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionGoalFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
    }

    public static WorkerResponse ClearGoal(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var existing = GetGoal(connection, transaction, sessionId);
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM session_goals WHERE session_id = $sessionId",
                new DbSql.SqlParam("$sessionId", sessionId));
            if (changed > 0)
            {
                AddGoalEvent(connection, transaction, sessionId, existing?.GoalId, "cleared", null, null, null);
            }
            transaction.Commit();
            return WorkerResponse.Json(
                new SessionGoalClearResult(true, changed > 0, null),
                WorkerJsonContext.Default.SessionGoalClearResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionGoalClearResult(false, false, ex.Message),
                WorkerJsonContext.Default.SessionGoalClearResult);
        }
    }

    public static WorkerResponse AccountGoal(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var timeDeltaSeconds = Math.Max(0, JsonHelpers.GetLong(parameters, "timeDeltaSeconds", 0));
            var tokenDelta = Math.Max(0, JsonHelpers.GetLong(parameters, "tokenDelta", 0));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            if (timeDeltaSeconds == 0 && tokenDelta == 0)
            {
                var current = GetGoal(connection, transaction, sessionId);
                transaction.Commit();
                return WorkerResponse.Json(
                    new SessionGoalFindResult(true, current, null),
                    WorkerJsonContext.Default.SessionGoalFindResult);
            }

            var expectedGoalId = NormalizeOptional(JsonHelpers.GetString(parameters, "expectedGoalId"));
            var existing = GetGoal(connection, transaction, sessionId);
            var now = Now();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"""
                UPDATE session_goals
                   SET time_used_seconds = time_used_seconds + $timeDeltaSeconds,
                       tokens_used = tokens_used + $tokenDelta,
                       status = CASE
                         WHEN status IN ('active', 'paused')
                           AND token_budget IS NOT NULL
                           AND tokens_used + $tokenDeltaForBudget >= token_budget
                         THEN 'budget_limited'
                         ELSE status
                       END,
                       updated_at = $updatedAt
                 WHERE session_id = $sessionId
                   AND ($expectedGoalId IS NULL OR goal_id = $expectedGoalId)
                   AND status IN (
                     'active',
                     'paused',
                     'blocked',
                     'usage_limited',
                     'budget_limited',
                     'complete'
                   )
                 RETURNING {GoalReturningColumns}
                """;
            command.Parameters.AddWithValue("$timeDeltaSeconds", timeDeltaSeconds);
            command.Parameters.AddWithValue("$tokenDelta", tokenDelta);
            command.Parameters.AddWithValue("$tokenDeltaForBudget", tokenDelta);
            command.Parameters.AddWithValue("$updatedAt", now);
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$expectedGoalId", expectedGoalId ?? (object)DBNull.Value);
            var row = ReadGoals(command).FirstOrDefault();
            if (row is not null)
            {
                AddGoalEvent(
                    connection,
                    transaction,
                    sessionId,
                    row.GoalId,
                    "usage_accounted",
                    null,
                    WriteMetadata(writer =>
                    {
                        writer.WriteNumber("timeDeltaSeconds", timeDeltaSeconds);
                        writer.WriteNumber("tokenDelta", tokenDelta);
                        writer.WriteNumber("tokensUsed", row.TokensUsed);
                        writer.WriteNumber("timeUsedSeconds", row.TimeUsedSeconds);
                    }),
                    null);
                if (existing?.Status != "budget_limited" && row.Status == "budget_limited")
                {
                    AddGoalEvent(
                        connection,
                        transaction,
                        sessionId,
                        row.GoalId,
                        "budget_limited",
                        null,
                        WriteUsageLimitMetadata(row),
                        null);
                }
                if (existing?.Status != "usage_limited" && row.Status == "usage_limited")
                {
                    AddGoalEvent(
                        connection,
                        transaction,
                        sessionId,
                        row.GoalId,
                        "usage_limited",
                        null,
                        WriteUsageLimitMetadata(row),
                        null);
                }
            }
            transaction.Commit();
            return WorkerResponse.Json(
                new SessionGoalFindResult(true, row, null),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionGoalFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.SessionGoalFindResult);
        }
    }

    private const string GoalReturningColumns = """
        session_id,
        goal_id,
        objective,
        status,
        token_budget,
        tokens_used,
        time_used_seconds,
        created_at,
        updated_at
        """;

    private static SessionGoalRow? UpdateObjective(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        SessionGoalRow existing,
        JsonElement patch,
        OptionalLong tokenBudgetPatch)
    {
        var now = Now();
        var replacementBudget = tokenBudgetPatch.HasValue ? tokenBudgetPatch.Value : existing.TokenBudget;
        var patchStatus = JsonHelpers.GetString(patch, "status");
        var statusBasis = patchStatus ?? ResetStatusForObjectiveChange(existing.Status);
        var replacementStatus = NormalizeStatusAfterBudget(statusBasis, 0, replacementBudget);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            UPDATE session_goals
               SET goal_id = $goalId,
                   objective = $objective,
                   status = $status,
                   token_budget = $tokenBudget,
                   tokens_used = 0,
                   time_used_seconds = 0,
                   created_at = $createdAt,
                   updated_at = $updatedAt
             WHERE session_id = $sessionId
             RETURNING {GoalReturningColumns}
            """;
        command.Parameters.AddWithValue("$goalId", CreateId());
        command.Parameters.AddWithValue("$objective", JsonHelpers.GetString(patch, "objective") ?? existing.Objective);
        command.Parameters.AddWithValue("$status", replacementStatus);
        command.Parameters.AddWithValue("$tokenBudget", replacementBudget ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$createdAt", now);
        command.Parameters.AddWithValue("$updatedAt", now);
        command.Parameters.AddWithValue("$sessionId", sessionId);
        var row = ReadGoals(command).FirstOrDefault();
        if (row is null)
        {
            return null;
        }

        AddGoalEvent(
            connection,
            transaction,
            sessionId,
            row.GoalId,
            "objective_updated",
            null,
            WriteMetadata(writer =>
            {
                writer.WriteString("previousGoalId", existing.GoalId);
                writer.WriteString("previousObjective", existing.Objective);
                writer.WriteString("status", row.Status);
                WriteNullableLong(writer, "tokenBudget", row.TokenBudget);
            }),
            null);
        AddDerivedGoalEvents(connection, transaction, sessionId, existing, row, tokenBudgetPatch.HasValue);
        return row;
    }

    private static SessionGoalRow? UpdateExistingGoal(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        SessionGoalRow existing,
        JsonElement patch,
        OptionalLong tokenBudgetPatch)
    {
        var objective = JsonHelpers.GetString(patch, "objective") ?? existing.Objective;
        var tokenBudget = tokenBudgetPatch.HasValue ? tokenBudgetPatch.Value : existing.TokenBudget;
        var status = NormalizeStatusAfterBudget(JsonHelpers.GetString(patch, "status") ?? existing.Status, existing.TokensUsed, tokenBudget);
        var now = Now();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            UPDATE session_goals
               SET objective = $objective,
                   status = $status,
                   token_budget = $tokenBudget,
                   updated_at = $updatedAt
             WHERE session_id = $sessionId
             RETURNING {GoalReturningColumns}
            """;
        command.Parameters.AddWithValue("$objective", objective);
        command.Parameters.AddWithValue("$status", status);
        command.Parameters.AddWithValue("$tokenBudget", tokenBudget ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$updatedAt", now);
        command.Parameters.AddWithValue("$sessionId", sessionId);
        var row = ReadGoals(command).FirstOrDefault();
        if (row is null)
        {
            return null;
        }

        if (patch.TryGetProperty("objective", out _) && row.Objective != existing.Objective)
        {
            AddGoalEvent(connection, transaction, sessionId, row.GoalId, "objective_updated", null, null, null);
        }
        AddDerivedGoalEvents(connection, transaction, sessionId, existing, row, tokenBudgetPatch.HasValue);
        return row;
    }

    private static void AddDerivedGoalEvents(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        SessionGoalRow existing,
        SessionGoalRow row,
        bool tokenBudgetPatched)
    {
        if (tokenBudgetPatched && row.TokenBudget != existing.TokenBudget)
        {
            AddGoalEvent(
                connection,
                transaction,
                sessionId,
                row.GoalId,
                "budget_updated",
                null,
                WriteUsageLimitMetadata(row),
                null);
        }

        if (row.Status != existing.Status)
        {
            AddGoalEvent(
                connection,
                transaction,
                sessionId,
                row.GoalId,
                StatusEventType(row.Status),
                null,
                WriteMetadata(writer =>
                {
                    writer.WriteString("from", existing.Status);
                    writer.WriteString("to", row.Status);
                }),
                null);
        }
    }

    private static SessionGoalEventRow AddGoalEvent(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement parameters)
    {
        return AddGoalEvent(
            connection,
            transaction,
            RequireString(parameters, "sessionId"),
            NormalizeOptional(JsonHelpers.GetString(parameters, "goalId")),
            RequireString(parameters, "eventType"),
            NormalizeOptional(JsonHelpers.GetString(parameters, "message")),
            SerializeMetadata(parameters),
            JsonHelpers.GetLongNullable(parameters, "createdAt"));
    }

    private static SessionGoalEventRow AddGoalEvent(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        string? goalId,
        string eventType,
        string? message,
        string? metadataJson,
        long? createdAt)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            INSERT INTO session_goal_events (
              id, session_id, goal_id, event_type, message, metadata_json, created_at
            ) VALUES (
              $id, $sessionId, $goalId, $eventType, $message, $metadataJson, $createdAt
            )
            RETURNING {GoalEventReturningColumns}
            """;
        command.Parameters.AddWithValue("$id", CreateId());
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$goalId", goalId ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$eventType", eventType);
        command.Parameters.AddWithValue("$message", NormalizeOptional(message) ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$metadataJson", NormalizeOptional(metadataJson) ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$createdAt", createdAt ?? Now());
        return ReadGoalEvents(command).First();
    }

    private const string GoalEventReturningColumns = """
        id,
        session_id,
        goal_id,
        event_type,
        message,
        metadata_json,
        created_at
        """;

    private static SessionGoalRow? GetGoal(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string sessionId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{GoalSelectSql} WHERE session_id = $sessionId LIMIT 1";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        return ReadGoals(command).FirstOrDefault();
    }

    private static List<SessionGoalRow> ReadGoals(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<SessionGoalRow>();
        while (reader.Read())
        {
            rows.Add(new SessionGoalRow
            {
                SessionId = reader.GetString(0),
                GoalId = reader.GetString(1),
                Objective = reader.GetString(2),
                Status = reader.GetString(3),
                TokenBudget = reader.IsDBNull(4) ? null : reader.GetInt64(4),
                TokensUsed = reader.GetInt64(5),
                TimeUsedSeconds = reader.GetInt64(6),
                CreatedAt = reader.GetInt64(7),
                UpdatedAt = reader.GetInt64(8)
            });
        }

        return rows;
    }

    private static List<SessionGoalEventRow> ReadGoalEvents(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<SessionGoalEventRow>();
        while (reader.Read())
        {
            rows.Add(new SessionGoalEventRow
            {
                Id = reader.GetString(0),
                SessionId = reader.GetString(1),
                GoalId = reader.IsDBNull(2) ? null : reader.GetString(2),
                EventType = reader.GetString(3),
                Message = reader.IsDBNull(4) ? null : reader.GetString(4),
                MetadataJson = reader.IsDBNull(5) ? null : reader.GetString(5),
                CreatedAt = reader.GetInt64(6)
            });
        }

        return rows;
    }

    private static string? SerializeMetadata(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("metadata", out var metadata) || metadata.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        if (metadata.ValueKind == JsonValueKind.Object && !metadata.EnumerateObject().Any())
        {
            return null;
        }

        return metadata.GetRawText();
    }

    private static string WriteUsageLimitMetadata(SessionGoalRow row)
    {
        return WriteMetadata(writer =>
        {
            WriteNullableLong(writer, "tokenBudget", row.TokenBudget);
            writer.WriteNumber("tokensUsed", row.TokensUsed);
        });
    }

    private static string WriteMetadata(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        writeProperties(writer);
        writer.WriteEndObject();
        writer.Flush();
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteNullableLong(Utf8JsonWriter writer, string name, long? value)
    {
        if (value is null)
        {
            writer.WriteNull(name);
            return;
        }

        writer.WriteNumber(name, value.Value);
    }

    private static OptionalLong ReadTokenBudget(JsonElement element, string name, bool optional)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return optional ? OptionalLong.Missing : new OptionalLong(true, null);
        }

        if (value.ValueKind == JsonValueKind.Null)
        {
            return new OptionalLong(true, null);
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
        {
            return new OptionalLong(true, number);
        }

        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out number))
        {
            return new OptionalLong(true, number);
        }

        throw new InvalidOperationException("goal token budget must be a finite number");
    }

    private static void ValidateGoalBudget(long? tokenBudget)
    {
        if (tokenBudget is <= 0)
        {
            throw new InvalidOperationException("goal budgets must be positive when provided");
        }
    }

    private static string NormalizeStatusAfterBudget(string status, long tokensUsed, long? tokenBudget)
    {
        return (status == "active" || status == "paused") && tokenBudget is not null && tokensUsed >= tokenBudget
            ? "budget_limited"
            : status;
    }

    private static string ResetStatusForObjectiveChange(string status)
    {
        return status is "complete" or "budget_limited" or "usage_limited" or "blocked" ? "active" : status;
    }

    private static string StatusEventType(string status)
    {
        return status switch
        {
            "budget_limited" => "budget_limited",
            "usage_limited" => "usage_limited",
            "blocked" => "blocked",
            _ => "status_changed"
        };
    }

    private static string CreateId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required goal field: {name}");
    }

    private static string? NormalizeOptional(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private readonly record struct OptionalLong(bool HasValue, long? Value)
    {
        public static OptionalLong Missing => new(false, null);
    }
}
