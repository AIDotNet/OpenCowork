using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbDrawRunTools
{
    private const string DrawRunSelectSql = """
        SELECT id,
               prompt,
               provider_name,
               model_name,
               mode,
               meta_json,
               created_at,
               is_generating,
               images_json,
               error_json,
               updated_at
          FROM draw_runs
        """;

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{DrawRunSelectSql} ORDER BY created_at DESC";
            return WorkerResponse.Json(ReadRows(command), WorkerJsonContext.Default.ListDrawRunRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Save(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT OR REPLACE INTO draw_runs (
                  id,
                  prompt,
                  provider_name,
                  model_name,
                  mode,
                  meta_json,
                  created_at,
                  is_generating,
                  images_json,
                  error_json,
                  updated_at
                ) VALUES (
                  $id,
                  $prompt,
                  $providerName,
                  $modelName,
                  $mode,
                  $metaJson,
                  $createdAt,
                  $isGenerating,
                  $imagesJson,
                  $errorJson,
                  $updatedAt
                )
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$prompt", RequireString(parameters, "prompt")),
                new DbSql.SqlParam("$providerName", RequireString(parameters, "providerName")),
                new DbSql.SqlParam("$modelName", RequireString(parameters, "modelName")),
                new DbSql.SqlParam("$mode", JsonHelpers.GetString(parameters, "mode") ?? "image"),
                new DbSql.SqlParam("$metaJson", JsonHelpers.GetString(parameters, "metaJson")),
                new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(parameters, "createdAt", Now())),
                new DbSql.SqlParam("$isGenerating", JsonHelpers.GetBool(parameters, "isGenerating", false) ? 1 : 0),
                new DbSql.SqlParam("$imagesJson", JsonHelpers.GetString(parameters, "imagesJson") ?? "[]"),
                new DbSql.SqlParam("$errorJson", JsonHelpers.GetString(parameters, "errorJson")),
                new DbSql.SqlParam("$updatedAt", JsonHelpers.GetLong(parameters, "updatedAt", Now())));
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
                "DELETE FROM draw_runs WHERE id = $id",
                new DbSql.SqlParam("$id", id));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Clear(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(connection, transaction, "DELETE FROM draw_runs");
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static List<DrawRunRow> ReadRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<DrawRunRow>();
        while (reader.Read())
        {
            rows.Add(new DrawRunRow
            {
                Id = reader.GetString(0),
                Prompt = reader.GetString(1),
                ProviderName = reader.GetString(2),
                ModelName = reader.GetString(3),
                Mode = reader.GetString(4),
                MetaJson = reader.IsDBNull(5) ? null : reader.GetString(5),
                CreatedAt = reader.GetInt64(6),
                IsGenerating = reader.GetInt32(7),
                ImagesJson = reader.GetString(8),
                ErrorJson = reader.IsDBNull(9) ? null : reader.GetString(9),
                UpdatedAt = reader.GetInt64(10)
            });
        }

        return rows;
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new DrawRunMutationResult(true, changed, null),
            WorkerJsonContext.Default.DrawRunMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new DrawRunMutationResult(false, 0, error),
            WorkerJsonContext.Default.DrawRunMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required draw run field: {name}");
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
