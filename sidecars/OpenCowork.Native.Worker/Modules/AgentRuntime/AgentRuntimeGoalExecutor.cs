using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class AgentRuntimeGoalExecutor
{
    private const int GoalBlockedTurnThreshold = 3;

    private static readonly HashSet<string> GoalToolNames = new(StringComparer.Ordinal)
    {
        "get_goal", "create_goal", "update_goal"
    };

    public static bool IsGoalTool(string toolName)
    {
        return GoalToolNames.Contains(toolName);
    }

    public static string Execute(NativeToolCallView call, JsonElement parameters)
    {
        return call.Name switch
        {
            "get_goal" => ExecuteGet(parameters),
            "create_goal" => ExecuteCreate(call.Input, parameters),
            "update_goal" => ExecuteUpdate(call.Input, parameters),
            _ => EncodeError($"Native goal tool not registered: {call.Name}")
        };
    }

    private static string ExecuteGet(JsonElement parameters)
    {
        var sessionId = GetSessionId(parameters);
        if (sessionId.Length == 0)
        {
            return EncodeError("No active session for get_goal.");
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        return EncodeGoalResponse(LoadGoal(connection, null, sessionId));
    }

    private static string ExecuteCreate(JsonElement input, JsonElement parameters)
    {
        var sessionId = GetSessionId(parameters);
        if (sessionId.Length == 0)
        {
            return EncodeError("No active session for create_goal.");
        }

        var objective = JsonHelpers.GetString(input, "objective")?.Trim() ?? string.Empty;
        if (objective.Length == 0)
        {
            return EncodeError("create_goal requires a non-empty objective.");
        }

        var tokenBudget = ReadTokenBudget(input, "token_budget", optional: true);
        try
        {
            ValidateGoalBudget(tokenBudget);
        }
        catch (InvalidOperationException ex)
        {
            return EncodeError(ex.Message);
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        if (LoadGoal(connection, transaction, sessionId) is not null)
        {
            transaction.Commit();
            return EncodeError("A goal already exists for this session. Use update_goal only for status changes.");
        }

        var now = Now();
        var goal = new NativeGoalRow
        {
            SessionId = sessionId,
            GoalId = CreateId(),
            Objective = objective,
            Status = NormalizeStatusAfterBudget("active", 0, tokenBudget),
            TokenBudget = tokenBudget,
            TokensUsed = 0,
            TimeUsedSeconds = 0,
            CreatedAt = now,
            UpdatedAt = now
        };
        InsertGoal(connection, transaction, goal);
        AddGoalEvent(
            connection,
            transaction,
            sessionId,
            goal.GoalId,
            "created",
            null,
            WriteMetadata(writer => WriteNullableLong(writer, "tokenBudget", goal.TokenBudget)));
        transaction.Commit();
        return EncodeGoalResponse(goal);
    }

    private static string ExecuteUpdate(JsonElement input, JsonElement parameters)
    {
        var sessionId = GetSessionId(parameters);
        if (sessionId.Length == 0)
        {
            return EncodeError("No active session for update_goal.");
        }

        var status = JsonHelpers.GetString(input, "status");
        if (status is not ("complete" or "blocked"))
        {
            return EncodeError(
                "update_goal can only mark the existing goal complete or blocked; pause, resume, and limit status changes are controlled by the user or system.");
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        var existing = LoadGoal(connection, transaction, sessionId);
        if (existing is null)
        {
            transaction.Commit();
            return EncodeError("No active goal exists for update_goal.");
        }

        if (status == "blocked" &&
            existing.Status != "blocked" &&
            !CanMarkBlocked(connection, transaction, sessionId, existing.GoalId))
        {
            transaction.Commit();
            return EncodeError(
                "update_goal can only mark the goal blocked after the same blocker has recurred for at least three consecutive goal turns.");
        }

        var updated = UpdateGoalStatus(connection, transaction, existing, status);
        transaction.Commit();
        return EncodeGoalResponse(
            updated,
            status == "complete" ? BuildCompletionBudgetReport(updated) : null);
    }

    private static string GetSessionId(JsonElement parameters)
    {
        return JsonHelpers.GetString(parameters, "sessionId")?.Trim() ?? string.Empty;
    }

    private static long? ReadTokenBudget(JsonElement input, string propertyName, bool optional)
    {
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty(propertyName, out var value))
        {
            return optional ? null : null;
        }

        if (value.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String &&
            long.TryParse(value.GetString(), out number))
        {
            return number;
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

    private static void InsertGoal(
        SqliteConnection connection,
        SqliteTransaction transaction,
        NativeGoalRow goal)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO session_goals (
              session_id, goal_id, objective, status, token_budget,
              tokens_used, time_used_seconds, created_at, updated_at
            ) VALUES (
              $sessionId, $goalId, $objective, $status, $tokenBudget,
              $tokensUsed, $timeUsedSeconds, $createdAt, $updatedAt
            )
            """,
            new DbSql.SqlParam("$sessionId", goal.SessionId),
            new DbSql.SqlParam("$goalId", goal.GoalId),
            new DbSql.SqlParam("$objective", goal.Objective),
            new DbSql.SqlParam("$status", goal.Status),
            new DbSql.SqlParam("$tokenBudget", goal.TokenBudget),
            new DbSql.SqlParam("$tokensUsed", goal.TokensUsed),
            new DbSql.SqlParam("$timeUsedSeconds", goal.TimeUsedSeconds),
            new DbSql.SqlParam("$createdAt", goal.CreatedAt),
            new DbSql.SqlParam("$updatedAt", goal.UpdatedAt));
    }

    private static NativeGoalRow UpdateGoalStatus(
        SqliteConnection connection,
        SqliteTransaction transaction,
        NativeGoalRow existing,
        string status)
    {
        var updated = new NativeGoalRow
        {
            SessionId = existing.SessionId,
            GoalId = existing.GoalId,
            Objective = existing.Objective,
            Status = NormalizeStatusAfterBudget(status, existing.TokensUsed, existing.TokenBudget),
            TokenBudget = existing.TokenBudget,
            TokensUsed = existing.TokensUsed,
            TimeUsedSeconds = existing.TimeUsedSeconds,
            CreatedAt = existing.CreatedAt,
            UpdatedAt = Now()
        };

        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            UPDATE session_goals
               SET status = $status,
                   updated_at = $updatedAt
             WHERE session_id = $sessionId
            """,
            new DbSql.SqlParam("$status", updated.Status),
            new DbSql.SqlParam("$updatedAt", updated.UpdatedAt),
            new DbSql.SqlParam("$sessionId", updated.SessionId));

        if (updated.Status != existing.Status)
        {
            AddGoalEvent(
                connection,
                transaction,
                updated.SessionId,
                updated.GoalId,
                StatusEventType(updated.Status),
                null,
                WriteMetadata(writer =>
                {
                    writer.WriteString("from", existing.Status);
                    writer.WriteString("to", updated.Status);
                }));
        }

        return updated;
    }

    private static NativeGoalRow? LoadGoal(
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

    private static List<NativeGoalRow> ReadGoals(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<NativeGoalRow>();
        while (reader.Read())
        {
            rows.Add(new NativeGoalRow
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

    private static void AddGoalEvent(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        string? goalId,
        string eventType,
        string? message,
        string? metadataJson)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO session_goal_events (
              id, session_id, goal_id, event_type, message, metadata_json, created_at
            ) VALUES (
              $id, $sessionId, $goalId, $eventType, $message, $metadataJson, $createdAt
            )
            """,
            new DbSql.SqlParam("$id", CreateId()),
            new DbSql.SqlParam("$sessionId", sessionId),
            new DbSql.SqlParam("$goalId", goalId),
            new DbSql.SqlParam("$eventType", eventType),
            new DbSql.SqlParam("$message", NormalizeOptional(message)),
            new DbSql.SqlParam("$metadataJson", NormalizeOptional(metadataJson)),
            new DbSql.SqlParam("$createdAt", Now()));
    }

    private static bool CanMarkBlocked(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        string goalId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT metadata_json
              FROM session_goal_events
             WHERE session_id = $sessionId
               AND goal_id = $goalId
               AND event_type IN ('completion_deferred', 'auto_continue_blocked', 'blocked')
             ORDER BY created_at DESC
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$goalId", goalId);
        var metadataJson = command.ExecuteScalar() as string;
        if (string.IsNullOrWhiteSpace(metadataJson))
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(metadataJson);
            return JsonHelpers.GetLong(document.RootElement, "consecutiveTurns", 0) >= GoalBlockedTurnThreshold;
        }
        catch
        {
            return false;
        }
    }

    private static string EncodeGoalResponse(NativeGoalRow? goal, string? completionBudgetReport = null)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WritePropertyName("goal");
            if (goal is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                WriteGoal(writer, goal);
            }

            writer.WritePropertyName("remaining_tokens");
            if (goal?.TokenBudget is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                writer.WriteNumberValue(Math.Max(0, goal.TokenBudget.Value - goal.TokensUsed));
            }

            if (completionBudgetReport is not null)
            {
                writer.WriteString("completion_budget_report", completionBudgetReport);
            }
        });
    }

    private static void WriteGoal(Utf8JsonWriter writer, NativeGoalRow goal)
    {
        writer.WriteStartObject();
        writer.WriteString("sessionId", goal.SessionId);
        writer.WriteString("goalId", goal.GoalId);
        writer.WriteString("objective", goal.Objective);
        writer.WriteString("status", goal.Status);
        if (goal.TokenBudget is null)
        {
            writer.WriteNull("tokenBudget");
        }
        else
        {
            writer.WriteNumber("tokenBudget", goal.TokenBudget.Value);
        }
        writer.WriteNumber("tokensUsed", goal.TokensUsed);
        writer.WriteNumber("timeUsedSeconds", goal.TimeUsedSeconds);
        writer.WriteNumber("createdAt", goal.CreatedAt);
        writer.WriteNumber("updatedAt", goal.UpdatedAt);
        writer.WriteEndObject();
    }

    private static string? BuildCompletionBudgetReport(NativeGoalRow goal)
    {
        var parts = new List<string>();
        if (goal.TokenBudget is not null)
        {
            parts.Add($"tokens used: {goal.TokensUsed} of {goal.TokenBudget.Value}");
        }
        if (goal.TimeUsedSeconds > 0)
        {
            parts.Add($"time used: {goal.TimeUsedSeconds} seconds");
        }
        return parts.Count == 0
            ? null
            : $"Goal achieved. Report final budget usage to the user: {string.Join("; ", parts)}.";
    }

    private static string WriteMetadata(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
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

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static string NormalizeStatusAfterBudget(string status, long tokensUsed, long? tokenBudget)
    {
        return (status == "active" || status == "paused") && tokenBudget is not null && tokensUsed >= tokenBudget
            ? "budget_limited"
            : status;
    }

    private static string StatusEventType(string status)
    {
        return status switch
        {
            "budget_limited" => "budget_limited",
            "usage_limited" => "usage_limited",
            "blocked" => "blocked",
            "complete" => "completed",
            _ => "status_changed"
        };
    }

    private static string? NormalizeOptional(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static string CreateId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

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

    private sealed class NativeGoalRow
    {
        public string SessionId { get; set; } = string.Empty;
        public string GoalId { get; set; } = string.Empty;
        public string Objective { get; set; } = string.Empty;
        public string Status { get; set; } = "active";
        public long? TokenBudget { get; set; }
        public long TokensUsed { get; set; }
        public long TimeUsedSeconds { get; set; }
        public long CreatedAt { get; set; }
        public long UpdatedAt { get; set; }
    }
}
