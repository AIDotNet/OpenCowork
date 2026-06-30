using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbPlanTools
{
    private const string PlanSelectSql = """
        SELECT id,
               session_id,
               title,
               status,
               file_path,
               content,
               spec_json,
               created_at,
               updated_at
          FROM plans
        """;

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{PlanSelectSql} ORDER BY updated_at DESC";
            return WorkerResponse.Json(ReadPlanRows(command), WorkerJsonContext.Default.ListPlanRow);
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
            command.CommandText = $"{PlanSelectSql} WHERE id = $id LIMIT 1";
            command.Parameters.AddWithValue("$id", id);
            var plan = ReadPlanRows(command).FirstOrDefault();
            return WorkerResponse.Json(
                new PlanFindResult(true, plan, null),
                WorkerJsonContext.Default.PlanFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new PlanFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.PlanFindResult);
        }
    }

    public static WorkerResponse GetBySession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{PlanSelectSql} WHERE session_id = $sessionId ORDER BY updated_at DESC LIMIT 1";
            command.Parameters.AddWithValue("$sessionId", sessionId);
            var plan = ReadPlanRows(command).FirstOrDefault();
            return WorkerResponse.Json(
                new PlanFindResult(true, plan, null),
                WorkerJsonContext.Default.PlanFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new PlanFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.PlanFindResult);
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
                INSERT INTO plans (id, session_id, title, status, file_path, content, spec_json, created_at, updated_at)
                VALUES ($id, $sessionId, $title, $status, $filePath, $content, $specJson, $createdAt, $updatedAt)
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$sessionId", RequireString(parameters, "sessionId")),
                new DbSql.SqlParam("$title", RequireString(parameters, "title")),
                new DbSql.SqlParam("$status", JsonHelpers.GetString(parameters, "status") ?? "drafting"),
                new DbSql.SqlParam("$filePath", JsonHelpers.GetString(parameters, "filePath")),
                new DbSql.SqlParam("$content", JsonHelpers.GetString(parameters, "content")),
                new DbSql.SqlParam("$specJson", JsonHelpers.GetString(parameters, "specJson")),
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
            AddPatchValue(patch, sets, values, "title", "title");
            AddPatchValue(patch, sets, values, "status", "status");
            AddPatchValue(patch, sets, values, "filePath", "file_path");
            AddPatchValue(patch, sets, values, "content", "content");
            AddPatchValue(patch, sets, values, "specJson", "spec_json");
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
            command.CommandText = $"UPDATE plans SET {string.Join(", ", sets)} WHERE id = $id";
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
                "DELETE FROM plans WHERE id = $id",
                new DbSql.SqlParam("$id", id));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static List<PlanRow> ReadPlanRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<PlanRow>();
        while (reader.Read())
        {
            rows.Add(new PlanRow
            {
                Id = reader.GetString(0),
                SessionId = reader.GetString(1),
                Title = reader.GetString(2),
                Status = reader.GetString(3),
                FilePath = reader.IsDBNull(4) ? null : reader.GetString(4),
                Content = reader.IsDBNull(5) ? null : reader.GetString(5),
                SpecJson = reader.IsDBNull(6) ? null : reader.GetString(6),
                CreatedAt = reader.GetInt64(7),
                UpdatedAt = reader.GetInt64(8)
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

    private static string RequireString(JsonElement element, string name)
    {
        return JsonHelpers.GetString(element, name) ??
            throw new InvalidOperationException($"Missing required parameter: {name}");
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new PlanMutationResult(true, changed, null),
            WorkerJsonContext.Default.PlanMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new PlanMutationResult(false, 0, error),
            WorkerJsonContext.Default.PlanMutationResult);
    }
}
