using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbTaskTools
{
    private const string TaskSelectSql = """
        SELECT id,
               session_id,
               plan_id,
               subject,
               description,
               active_form,
               status,
               owner,
               blocks,
               blocked_by,
               metadata,
               sort_order,
               created_at,
               updated_at
          FROM tasks
        """;

    public static WorkerResponse ListBySession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{TaskSelectSql} WHERE session_id = $sessionId ORDER BY sort_order ASC";
            command.Parameters.AddWithValue("$sessionId", sessionId);
            return WorkerResponse.Json(ReadTaskRows(command), WorkerJsonContext.Default.ListTaskRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Get(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{TaskSelectSql} WHERE id = $id LIMIT 1";
            command.Parameters.AddWithValue("$id", id);
            var task = ReadTaskRows(command).FirstOrDefault();
            return WorkerResponse.Json(
                new TaskFindResult(true, task, null),
                WorkerJsonContext.Default.TaskFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new TaskFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.TaskFindResult);
        }
    }

    public static WorkerResponse Create(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO tasks (
                    id, session_id, plan_id, subject, description, active_form, status, owner,
                    blocks, blocked_by, metadata, sort_order, created_at, updated_at
                )
                VALUES (
                    $id, $sessionId, $planId, $subject, $description, $activeForm, $status, $owner,
                    $blocks, $blockedBy, $metadata, $sortOrder, $createdAt, $updatedAt
                )
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$sessionId", RequireString(parameters, "sessionId")),
                new DbSql.SqlParam("$planId", JsonHelpers.GetString(parameters, "planId")),
                new DbSql.SqlParam("$subject", RequireString(parameters, "subject")),
                new DbSql.SqlParam("$description", JsonHelpers.GetString(parameters, "description") ?? string.Empty),
                new DbSql.SqlParam("$activeForm", JsonHelpers.GetString(parameters, "activeForm")),
                new DbSql.SqlParam("$status", JsonHelpers.GetString(parameters, "status") ?? "pending"),
                new DbSql.SqlParam("$owner", JsonHelpers.GetString(parameters, "owner")),
                new DbSql.SqlParam("$blocks", GetRawJson(parameters, "blocks") ?? "[]"),
                new DbSql.SqlParam("$blockedBy", GetRawJson(parameters, "blockedBy") ?? "[]"),
                new DbSql.SqlParam("$metadata", GetRawJson(parameters, "metadata")),
                new DbSql.SqlParam("$sortOrder", JsonHelpers.GetInt(parameters, "sortOrder", 0)),
                new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(parameters, "createdAt", 0)),
                new DbSql.SqlParam("$updatedAt", JsonHelpers.GetLong(parameters, "updatedAt", 0)));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Update(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            if (!parameters.TryGetProperty("patch", out var patch) || patch.ValueKind != JsonValueKind.Object)
            {
                return Mutation(0);
            }

            var sets = new List<string>();
            var values = new List<DbSql.SqlParam>();
            AddPatchValue(patch, sets, values, "subject", "subject");
            AddPatchValue(patch, sets, values, "description", "description");
            AddPatchValue(patch, sets, values, "activeForm", "active_form");
            AddPatchValue(patch, sets, values, "status", "status");
            AddPatchValue(patch, sets, values, "owner", "owner");
            AddPatchJsonValue(patch, sets, values, "blocks", "blocks");
            AddPatchJsonValue(patch, sets, values, "blockedBy", "blocked_by");
            AddPatchJsonValue(patch, sets, values, "metadata", "metadata");
            AddPatchIntValue(patch, sets, values, "sortOrder", "sort_order");
            AddPatchLongValue(patch, sets, values, "updatedAt", "updated_at");

            if (sets.Count == 0)
            {
                return Mutation(0);
            }

            values.Add(new DbSql.SqlParam("$id", id));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"UPDATE tasks SET {string.Join(", ", sets)} WHERE id = $id";
            foreach (var value in values)
            {
                command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
            }

            var changed = command.ExecuteNonQuery();
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Delete(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM tasks WHERE id = $id",
                new DbSql.SqlParam("$id", id));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse DeleteBySession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM tasks WHERE session_id = $sessionId",
                new DbSql.SqlParam("$sessionId", sessionId));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static List<TaskRow> ReadTaskRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<TaskRow>();
        while (reader.Read())
        {
            rows.Add(new TaskRow
            {
                Id = reader.GetString(0),
                SessionId = reader.GetString(1),
                PlanId = reader.IsDBNull(2) ? null : reader.GetString(2),
                Subject = reader.GetString(3),
                Description = reader.GetString(4),
                ActiveForm = reader.IsDBNull(5) ? null : reader.GetString(5),
                Status = reader.GetString(6),
                Owner = reader.IsDBNull(7) ? null : reader.GetString(7),
                Blocks = reader.IsDBNull(8) ? "[]" : reader.GetString(8),
                BlockedBy = reader.IsDBNull(9) ? "[]" : reader.GetString(9),
                Metadata = reader.IsDBNull(10) ? null : reader.GetString(10),
                SortOrder = reader.GetInt32(11),
                CreatedAt = reader.GetInt64(12),
                UpdatedAt = reader.GetInt64(13)
            });
        }

        return rows;
    }

    private static void AddPatchValue(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", value.ValueKind == JsonValueKind.Null ? null : value.GetString()));
    }

    private static void AddPatchJsonValue(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", value.ValueKind == JsonValueKind.Null ? null : value.GetRawText()));
    }

    private static void AddPatchIntValue(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", ReadInt(value)));
    }

    private static void AddPatchLongValue(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", ReadLong(value)));
    }

    private static int ReadInt(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out number))
        {
            return number;
        }

        throw new InvalidOperationException("Expected integer value.");
    }

    private static long ReadLong(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out number))
        {
            return number;
        }

        throw new InvalidOperationException("Expected integer value.");
    }

    private static string? GetRawJson(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetRawText()
            : null;
    }

    private static string RequireString(JsonElement element, string name)
    {
        return JsonHelpers.GetString(element, name) ??
            throw new InvalidOperationException($"Missing required parameter: {name}");
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new TaskMutationResult(true, changed, null),
            WorkerJsonContext.Default.TaskMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new TaskMutationResult(false, 0, error),
            WorkerJsonContext.Default.TaskMutationResult);
    }
}
