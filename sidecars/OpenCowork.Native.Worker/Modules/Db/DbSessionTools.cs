using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbSessionTools
{
    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 2000), 1, 10_000);
            var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));
            var hasProjectFilter = parameters.TryGetProperty("projectId", out var projectIdValue);
            var projectId = hasProjectFilter && projectIdValue.ValueKind != JsonValueKind.Null
                ? JsonHelpers.GetString(parameters, "projectId")
                : null;
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {SessionSelectSql}
                 WHERE {(hasProjectFilter ? (projectId is null ? "project_id IS NULL" : "project_id = $projectId") : "1 = 1")}
                 ORDER BY updated_at DESC
                 LIMIT $limit OFFSET $offset
                """;
            if (projectId is not null)
            {
                command.Parameters.AddWithValue("$projectId", projectId);
            }
            command.Parameters.AddWithValue("$limit", limit);
            command.Parameters.AddWithValue("$offset", offset);
            return WorkerResponse.Json(ReadSessionRows(command), WorkerJsonContext.Default.ListSessionRow);
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
            var session = GetSession(connection, null, id);
            return WorkerResponse.Json(
                new SessionFindResult(true, session, null),
                WorkerJsonContext.Default.SessionFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.SessionFindResult);
        }
    }

    public static WorkerResponse Create(JsonElement parameters)
    {
        try
        {
            var input = ReadSessionInput(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            ApplyProjectDefaults(connection, transaction, input);
            InsertSession(connection, transaction, input);
            transaction.Commit();
            return Mutation(1);
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
            AddPatchValue(patch, sets, values, "icon", "icon");
            AddPatchValue(patch, sets, values, "mode", "mode");
            AddPatchValue(patch, sets, values, "updatedAt", "updated_at");
            AddPatchValue(patch, sets, values, "projectId", "project_id");
            AddPatchValue(patch, sets, values, "workingFolder", "working_folder");
            AddPatchValue(patch, sets, values, "sshConnectionId", "ssh_connection_id");
            AddPatchValue(patch, sets, values, "planId", "plan_id");
            AddPatchBoolValue(patch, sets, values, "pinned", "pinned");
            AddPatchValue(patch, sets, values, "pluginId", "plugin_id");
            AddPatchValue(patch, sets, values, "providerId", "provider_id");
            AddPatchValue(patch, sets, values, "modelId", "model_id");
            AddPatchValue(patch, sets, values, "modelSelectionMode", "model_selection_mode");

            if (sets.Count == 0)
            {
                return Mutation(0);
            }

            values.Add(new DbSql.SqlParam("$id", id));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"UPDATE sessions SET {string.Join(", ", sets)} WHERE id = $id";
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
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $id",
                new DbSql.SqlParam("$id", id));
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM sessions WHERE id = $id",
                new DbSql.SqlParam("$id", id));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse ClearAll(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var sessionIds = GetNonPluginSessionIds(connection, transaction);
            var deletedMessages = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                DELETE FROM messages
                 WHERE session_id IN (
                   SELECT id FROM sessions WHERE plugin_id IS NULL
                 )
                """);
            var deletedSessions = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM sessions WHERE plugin_id IS NULL");
            transaction.Commit();

            return WorkerResponse.Json(
                new SessionClearAllResult(true, sessionIds, deletedMessages, deletedSessions, null),
                WorkerJsonContext.Default.SessionClearAllResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionClearAllResult(false, new List<string>(), 0, 0, ex.Message),
                WorkerJsonContext.Default.SessionClearAllResult);
        }
    }

    public static WorkerResponse ClearProject(JsonElement parameters)
    {
        try
        {
            var projectId = RequireString(parameters, "projectId");
            var excluded = new HashSet<string>(StringComparer.Ordinal);
            if (parameters.TryGetProperty("excludeSessionIds", out var excludeValue) &&
                excludeValue.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in excludeValue.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String)
                    {
                        var id = item.GetString();
                        if (!string.IsNullOrWhiteSpace(id)) excluded.Add(id);
                    }
                }
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var sessionIds = GetProjectSessionIds(connection, transaction, projectId, excluded);
            if (sessionIds.Count == 0)
            {
                transaction.Commit();
                return WorkerResponse.Json(
                    new SessionClearAllResult(true, sessionIds, 0, 0, null),
                    WorkerJsonContext.Default.SessionClearAllResult);
            }

            var placeholders = string.Join(", ", sessionIds.Select((_, index) => $"$id{index}"));
            var values = sessionIds
                .Select((id, index) => new DbSql.SqlParam($"$id{index}", id))
                .ToArray();
            var deletedMessages = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                $"DELETE FROM messages WHERE session_id IN ({placeholders})",
                values);
            var deletedSessions = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                $"DELETE FROM sessions WHERE id IN ({placeholders})",
                values);
            transaction.Commit();

            return WorkerResponse.Json(
                new SessionClearAllResult(true, sessionIds, deletedMessages, deletedSessions, null),
                WorkerJsonContext.Default.SessionClearAllResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionClearAllResult(false, new List<string>(), 0, 0, ex.Message),
                WorkerJsonContext.Default.SessionClearAllResult);
        }
    }

    public static WorkerResponse ResetConversation(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();

            var deleted = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId",
                new DbSql.SqlParam("$sessionId", sessionId));

            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE sessions
                   SET title = 'New Conversation',
                       updated_at = $updatedAt,
                       message_count = 0
                 WHERE id = $sessionId
                """,
                new DbSql.SqlParam("$updatedAt", updatedAt),
                new DbSql.SqlParam("$sessionId", sessionId));

            transaction.Commit();

            return WorkerResponse.Json(
                new SessionResetResult(true, deleted, updatedAt, null),
                WorkerJsonContext.Default.SessionResetResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionResetResult(false, 0, 0, ex.Message),
                WorkerJsonContext.Default.SessionResetResult);
        }
    }

    public static WorkerResponse Status(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT s.title,
                       s.created_at,
                       s.updated_at,
                       COUNT(m.id) AS message_count
                  FROM sessions s
                  LEFT JOIN messages m ON m.session_id = s.id
                 WHERE s.id = $sessionId
                 GROUP BY s.id
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);

            using var reader = command.ExecuteReader();
            if (!reader.Read())
            {
                return WorkerResponse.Json(
                    new SessionStatusResult(true, false, null, null, null, 0, null),
                    WorkerJsonContext.Default.SessionStatusResult);
            }

            return WorkerResponse.Json(
                new SessionStatusResult(
                    true,
                    true,
                    reader.IsDBNull(0) ? null : reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetInt64(1),
                    reader.IsDBNull(2) ? null : reader.GetInt64(2),
                    reader.GetInt32(3),
                    null),
                WorkerJsonContext.Default.SessionStatusResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionStatusResult(false, false, null, null, null, 0, ex.Message),
                WorkerJsonContext.Default.SessionStatusResult);
        }
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required session field: {name}");
    }

    private const string SessionSelectSql = """
        SELECT id, title, icon, mode, created_at, updated_at, project_id, working_folder,
               ssh_connection_id, plan_id, pinned, plugin_id, external_chat_id, provider_id,
               model_id, model_selection_mode, COALESCE(message_count, 0) AS message_count
          FROM sessions
        """;

    private static List<SessionRow> ReadSessionRows(SqliteCommand command)
    {
        var rows = new List<SessionRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(ReadSessionRow(reader));
        }
        return rows;
    }

    private static SessionRow ReadSessionRow(SqliteDataReader reader)
    {
        return new SessionRow
        {
            Id = reader.GetString(0),
            Title = reader.IsDBNull(1) ? string.Empty : reader.GetString(1),
            Icon = GetNullableString(reader, 2),
            Mode = reader.IsDBNull(3) ? "chat" : reader.GetString(3),
            CreatedAt = reader.GetInt64(4),
            UpdatedAt = reader.GetInt64(5),
            ProjectId = GetNullableString(reader, 6),
            WorkingFolder = GetNullableString(reader, 7),
            SshConnectionId = GetNullableString(reader, 8),
            PlanId = GetNullableString(reader, 9),
            Pinned = reader.IsDBNull(10) ? 0 : reader.GetInt32(10),
            PluginId = GetNullableString(reader, 11),
            ExternalChatId = GetNullableString(reader, 12),
            ProviderId = GetNullableString(reader, 13),
            ModelId = GetNullableString(reader, 14),
            ModelSelectionMode = GetNullableString(reader, 15),
            MessageCount = reader.IsDBNull(16) ? 0 : reader.GetInt32(16)
        };
    }

    private static SessionRow? GetSession(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            {SessionSelectSql}
             WHERE id = $id
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$id", id);
        return ReadSessionRows(command).FirstOrDefault();
    }

    private static SessionInput ReadSessionInput(JsonElement parameters)
    {
        var providerId = NormalizeOptional(JsonHelpers.GetString(parameters, "providerId"));
        var modelId = NormalizeOptional(JsonHelpers.GetString(parameters, "modelId"));
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return new SessionInput
        {
            Id = RequireString(parameters, "id"),
            Title = RequireString(parameters, "title"),
            Icon = NormalizeOptional(JsonHelpers.GetString(parameters, "icon")),
            Mode = NormalizeOptional(JsonHelpers.GetString(parameters, "mode")) ?? "chat",
            CreatedAt = JsonHelpers.GetLong(parameters, "createdAt", now),
            UpdatedAt = JsonHelpers.GetLong(parameters, "updatedAt", now),
            ProjectId = NormalizeOptional(JsonHelpers.GetString(parameters, "projectId")),
            WorkingFolder = NormalizeOptional(JsonHelpers.GetString(parameters, "workingFolder")),
            SshConnectionId = NormalizeOptional(JsonHelpers.GetString(parameters, "sshConnectionId")),
            PlanId = NormalizeOptional(JsonHelpers.GetString(parameters, "planId")),
            Pinned = JsonHelpers.GetBool(parameters, "pinned", false) ? 1 : 0,
            PluginId = NormalizeOptional(JsonHelpers.GetString(parameters, "pluginId")),
            ProviderId = providerId,
            ModelId = modelId,
            ModelSelectionMode = NormalizeOptional(JsonHelpers.GetString(parameters, "modelSelectionMode")) ??
                (providerId is not null && modelId is not null ? "manual" : "inherit")
        };
    }

    private static void ApplyProjectDefaults(
        SqliteConnection connection,
        SqliteTransaction transaction,
        SessionInput input)
    {
        if (input.ProjectId is null ||
            (input.WorkingFolder is not null && input.SshConnectionId is not null))
        {
            return;
        }

        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT working_folder, ssh_connection_id
              FROM projects
             WHERE id = $projectId
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$projectId", input.ProjectId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return;
        }

        input.WorkingFolder ??= GetNullableString(reader, 0);
        input.SshConnectionId ??= GetNullableString(reader, 1);
    }

    private static void InsertSession(
        SqliteConnection connection,
        SqliteTransaction transaction,
        SessionInput input)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO sessions (
              id, title, icon, mode, created_at, updated_at, message_count, project_id,
              working_folder, ssh_connection_id, plan_id, pinned, plugin_id, provider_id, model_id,
              model_selection_mode
            ) VALUES (
              $id, $title, $icon, $mode, $createdAt, $updatedAt, 0, $projectId,
              $workingFolder, $sshConnectionId, $planId, $pinned, $pluginId, $providerId, $modelId,
              $modelSelectionMode
            )
            """,
            new DbSql.SqlParam("$id", input.Id),
            new DbSql.SqlParam("$title", input.Title),
            new DbSql.SqlParam("$icon", input.Icon),
            new DbSql.SqlParam("$mode", input.Mode),
            new DbSql.SqlParam("$createdAt", input.CreatedAt),
            new DbSql.SqlParam("$updatedAt", input.UpdatedAt),
            new DbSql.SqlParam("$projectId", input.ProjectId),
            new DbSql.SqlParam("$workingFolder", input.WorkingFolder),
            new DbSql.SqlParam("$sshConnectionId", input.SshConnectionId),
            new DbSql.SqlParam("$planId", input.PlanId),
            new DbSql.SqlParam("$pinned", input.Pinned),
            new DbSql.SqlParam("$pluginId", input.PluginId),
            new DbSql.SqlParam("$providerId", input.ProviderId),
            new DbSql.SqlParam("$modelId", input.ModelId),
            new DbSql.SqlParam("$modelSelectionMode", input.ModelSelectionMode));
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
        values.Add(new DbSql.SqlParam($"${jsonName}", ReadJsonValue(value)));
    }

    private static void AddPatchBoolValue(
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

        var normalized = value.ValueKind switch
        {
            JsonValueKind.True => 1,
            JsonValueKind.False => 0,
            JsonValueKind.Number when value.TryGetInt32(out var numeric) => numeric == 0 ? 0 : 1,
            _ => 0
        };
        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", normalized));
    }

    private static object? ReadJsonValue(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number when value.TryGetInt64(out var longValue) => longValue,
            JsonValueKind.Number when value.TryGetDouble(out var doubleValue) => doubleValue,
            JsonValueKind.True => 1,
            JsonValueKind.False => 0,
            _ => value.GetRawText()
        };
    }

    private static List<string> GetProjectSessionIds(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string projectId,
        HashSet<string> excluded)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT id FROM sessions WHERE project_id = $projectId";
        command.Parameters.AddWithValue("$projectId", projectId);
        var ids = new List<string>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var id = reader.GetString(0);
            if (!excluded.Contains(id)) ids.Add(id);
        }
        return ids;
    }

    private static List<string> GetNonPluginSessionIds(
        SqliteConnection connection,
        SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT id FROM sessions WHERE plugin_id IS NULL";
        var ids = new List<string>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            ids.Add(reader.GetString(0));
        }
        return ids;
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new SessionMutationResult(true, changed, null),
            WorkerJsonContext.Default.SessionMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new SessionMutationResult(false, 0, error),
            WorkerJsonContext.Default.SessionMutationResult);
    }

    private static string? NormalizeOptional(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static string? GetNullableString(SqliteDataReader reader, int ordinal)
    {
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private sealed class SessionInput
    {
        public string Id { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string? Icon { get; set; }
        public string Mode { get; set; } = "chat";
        public long CreatedAt { get; set; }
        public long UpdatedAt { get; set; }
        public string? ProjectId { get; set; }
        public string? WorkingFolder { get; set; }
        public string? SshConnectionId { get; set; }
        public string? PlanId { get; set; }
        public int Pinned { get; set; }
        public string? PluginId { get; set; }
        public string? ProviderId { get; set; }
        public string? ModelId { get; set; }
        public string ModelSelectionMode { get; set; } = "inherit";
    }
}
