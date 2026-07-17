using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbProjectTools
{
    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {ProjectSelectSql}
                 ORDER BY pinned DESC, CASE WHEN plugin_id IS NULL THEN 0 ELSE 1 END, updated_at DESC
                """;
            return WorkerResponse.Json(
                ReadProjectRows(command),
                WorkerJsonContext.Default.ListProjectRow);
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
            var project = GetProject(connection, null, id);
            return WorkerResponse.Json(
                new ProjectFindResult(true, project, null),
                WorkerJsonContext.Default.ProjectFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new ProjectFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.ProjectFindResult);
        }
    }

    public static WorkerResponse FindByPluginId(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {ProjectSelectSql}
                 WHERE plugin_id = $pluginId
                 ORDER BY pinned DESC, updated_at DESC
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$pluginId", pluginId);
            var rows = ReadProjectRows(command);
            return WorkerResponse.Json(
                new ProjectFindResult(true, rows.FirstOrDefault(), null),
                WorkerJsonContext.Default.ProjectFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new ProjectFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.ProjectFindResult);
        }
    }

    public static WorkerResponse Create(JsonElement parameters)
    {
        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var id = NormalizeOptional(JsonHelpers.GetString(parameters, "id")) ?? CreateId();
            var name = SanitizeProjectName(RequireString(parameters, "name"));
            var sshConnectionId = NormalizeOptional(JsonHelpers.GetString(parameters, "sshConnectionId"));
            var workingFolder = NormalizeOptional(JsonHelpers.GetString(parameters, "workingFolder"));
            var pluginId = NormalizeOptional(JsonHelpers.GetString(parameters, "pluginId"));
            var pinned = JsonHelpers.GetBool(parameters, "pinned", false) ? 1 : 0;
            var createdAt = JsonHelpers.GetLong(parameters, "createdAt", now);
            var updatedAt = JsonHelpers.GetLong(parameters, "updatedAt", now);

            if (workingFolder is null && sshConnectionId is null)
            {
                var allocated = EnsureUniqueLocalProjectDirectory(
                    JsonHelpers.GetString(parameters, "baseDirectory"),
                    name);
                name = allocated.Name;
                workingFolder = allocated.FolderPath;
            }
            else if (workingFolder is not null && sshConnectionId is null)
            {
                Directory.CreateDirectory(workingFolder);
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var row = new ProjectRow
            {
                Id = id,
                Name = name,
                WorkingFolder = workingFolder,
                SshConnectionId = sshConnectionId,
                PluginId = pluginId,
                Pinned = pinned,
                CreatedAt = createdAt,
                UpdatedAt = updatedAt
            };
            InsertProject(connection, transaction, row);
            transaction.Commit();

            return WorkerResponse.Json(row, WorkerJsonContext.Default.ProjectRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Update(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            if (!parameters.TryGetProperty("patch", out var patch) || patch.ValueKind != JsonValueKind.Object)
            {
                return WorkerResponse.Json(
                    new ProjectFindResult(true, null, null),
                    WorkerJsonContext.Default.ProjectFindResult);
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var current = GetProject(connection, transaction, id);
            if (current is null)
            {
                transaction.Commit();
                return WorkerResponse.Json(
                    new ProjectFindResult(true, null, null),
                    WorkerJsonContext.Default.ProjectFindResult);
            }

            ApplyProjectPatch(parameters, patch, current);
            UpdateProjectRow(connection, transaction, current);
            transaction.Commit();

            return WorkerResponse.Json(
                new ProjectFindResult(true, current, null),
                WorkerJsonContext.Default.ProjectFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new ProjectFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.ProjectFindResult);
        }
    }

    public static WorkerResponse Delete(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var project = GetProject(connection, transaction, id);
            if (project is null)
            {
                transaction.Commit();
                return WorkerResponse.Json(
                    new ProjectDeleteResult(true, false, null, new List<string>(), null),
                    WorkerJsonContext.Default.ProjectDeleteResult);
            }

            var sessionIds = GetSessionIdsForProject(connection, transaction, id);
            foreach (var sessionId in sessionIds)
            {
                DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    "DELETE FROM messages WHERE session_id = $sessionId",
                    new DbSql.SqlParam("$sessionId", sessionId));
            }
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM sessions WHERE project_id = $projectId",
                new DbSql.SqlParam("$projectId", id));
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM projects WHERE id = $projectId",
                new DbSql.SqlParam("$projectId", id));
            transaction.Commit();

            return WorkerResponse.Json(
                new ProjectDeleteResult(true, true, id, sessionIds, null),
                WorkerJsonContext.Default.ProjectDeleteResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new ProjectDeleteResult(false, false, null, new List<string>(), ex.Message),
                WorkerJsonContext.Default.ProjectDeleteResult);
        }
    }

    public static WorkerResponse EnsureDefault(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var existing = GetFirstNormalProject(connection, transaction);
            if (existing is not null)
            {
                if (existing.WorkingFolder is null && existing.SshConnectionId is null)
                {
                    var allocated = EnsureUniqueLocalProjectDirectory(
                        JsonHelpers.GetString(parameters, "baseDirectory"),
                        existing.Name);
                    existing.Name = allocated.Name;
                    existing.WorkingFolder = allocated.FolderPath;
                    existing.SshConnectionId = null;
                    existing.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    UpdateProjectRow(connection, transaction, existing);
                }

                transaction.Commit();
                return WorkerResponse.Json(existing, WorkerJsonContext.Default.ProjectRow);
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var allocatedNew = EnsureUniqueLocalProjectDirectory(
                JsonHelpers.GetString(parameters, "baseDirectory"),
                "New Project");
            var project = new ProjectRow
            {
                Id = CreateId(),
                Name = allocatedNew.Name,
                WorkingFolder = allocatedNew.FolderPath,
                SshConnectionId = null,
                PluginId = null,
                Pinned = 0,
                CreatedAt = now,
                UpdatedAt = now
            };
            InsertProject(connection, transaction, project);
            transaction.Commit();
            return WorkerResponse.Json(project, WorkerJsonContext.Default.ProjectRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse EnsurePluginProject(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var existing = GetProjectByPluginId(connection, transaction, pluginId);
            if (existing is not null)
            {
                transaction.Commit();
                return WorkerResponse.Json(existing, WorkerJsonContext.Default.ProjectRow);
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var name = SanitizeProjectName(
                NormalizeOptional(JsonHelpers.GetString(parameters, "preferredName")) ?? $"Plugin {pluginId}");
            var allocated = EnsureUniqueLocalProjectDirectory(
                JsonHelpers.GetString(parameters, "baseDirectory"),
                name);
            var project = new ProjectRow
            {
                Id = CreateId(),
                Name = allocated.Name,
                WorkingFolder = allocated.FolderPath,
                SshConnectionId = null,
                PluginId = pluginId,
                Pinned = 0,
                CreatedAt = now,
                UpdatedAt = now
            };
            InsertProject(connection, transaction, project);
            transaction.Commit();
            return WorkerResponse.Json(project, WorkerJsonContext.Default.ProjectRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    private const string ProjectSelectSql = """
        SELECT p.id, p.name, p.working_folder, p.ssh_connection_id, p.plugin_id, p.pinned,
               p.created_at, p.updated_at,
               (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS session_count
          FROM projects p
        """;

    private static ProjectRow? GetProject(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            {ProjectSelectSql}
             WHERE id = $id
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$id", id);
        return ReadProjectRows(command).FirstOrDefault();
    }

    private static ProjectRow? GetProjectByPluginId(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string pluginId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            {ProjectSelectSql}
             WHERE plugin_id = $pluginId
             ORDER BY pinned DESC, updated_at DESC
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$pluginId", pluginId);
        return ReadProjectRows(command).FirstOrDefault();
    }

    private static ProjectRow? GetFirstNormalProject(
        SqliteConnection connection,
        SqliteTransaction transaction)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            {ProjectSelectSql}
             WHERE plugin_id IS NULL
             ORDER BY pinned DESC, updated_at DESC
             LIMIT 1
            """;
        return ReadProjectRows(command).FirstOrDefault();
    }

    private static List<ProjectRow> ReadProjectRows(SqliteCommand command)
    {
        var rows = new List<ProjectRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(new ProjectRow
            {
                Id = reader.GetString(0),
                Name = reader.GetString(1),
                WorkingFolder = GetNullableString(reader, 2),
                SshConnectionId = GetNullableString(reader, 3),
                PluginId = GetNullableString(reader, 4),
                Pinned = reader.IsDBNull(5) ? 0 : reader.GetInt32(5),
                CreatedAt = reader.GetInt64(6),
                UpdatedAt = reader.GetInt64(7),
                SessionCount = reader.IsDBNull(8) ? 0 : reader.GetInt32(8)
            });
        }

        return rows;
    }

    private static void InsertProject(
        SqliteConnection connection,
        SqliteTransaction transaction,
        ProjectRow row)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO projects (
              id, name, working_folder, ssh_connection_id, plugin_id, pinned, created_at, updated_at
            ) VALUES (
              $id, $name, $workingFolder, $sshConnectionId, $pluginId, $pinned, $createdAt, $updatedAt
            )
            """,
            new DbSql.SqlParam("$id", row.Id),
            new DbSql.SqlParam("$name", row.Name),
            new DbSql.SqlParam("$workingFolder", row.WorkingFolder),
            new DbSql.SqlParam("$sshConnectionId", row.SshConnectionId),
            new DbSql.SqlParam("$pluginId", row.PluginId),
            new DbSql.SqlParam("$pinned", row.Pinned),
            new DbSql.SqlParam("$createdAt", row.CreatedAt),
            new DbSql.SqlParam("$updatedAt", row.UpdatedAt));
    }

    private static void UpdateProjectRow(
        SqliteConnection connection,
        SqliteTransaction transaction,
        ProjectRow row)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            UPDATE projects
               SET name = $name,
                   working_folder = $workingFolder,
                   ssh_connection_id = $sshConnectionId,
                   plugin_id = $pluginId,
                   pinned = $pinned,
                   updated_at = $updatedAt
             WHERE id = $id
            """,
            new DbSql.SqlParam("$name", row.Name),
            new DbSql.SqlParam("$workingFolder", row.WorkingFolder),
            new DbSql.SqlParam("$sshConnectionId", row.SshConnectionId),
            new DbSql.SqlParam("$pluginId", row.PluginId),
            new DbSql.SqlParam("$pinned", row.Pinned),
            new DbSql.SqlParam("$updatedAt", row.UpdatedAt),
            new DbSql.SqlParam("$id", row.Id));
    }

    private static void ApplyProjectPatch(
        JsonElement parameters,
        JsonElement patch,
        ProjectRow row)
    {
        if (patch.TryGetProperty("name", out var nameElement) &&
            nameElement.ValueKind == JsonValueKind.String)
        {
            row.Name = SanitizeProjectName(nameElement.GetString() ?? string.Empty);
        }

        var hasSshPatch = patch.TryGetProperty("sshConnectionId", out var sshElement);
        if (hasSshPatch)
        {
            row.SshConnectionId = sshElement.ValueKind == JsonValueKind.String
                ? NormalizeOptional(sshElement.GetString())
                : null;
        }

        if (patch.TryGetProperty("workingFolder", out var folderElement))
        {
            row.WorkingFolder = folderElement.ValueKind == JsonValueKind.String
                ? NormalizeOptional(folderElement.GetString())
                : null;

            var effectiveSshConnectionId = hasSshPatch ? row.SshConnectionId : row.SshConnectionId;
            if (row.WorkingFolder is not null && effectiveSshConnectionId is null)
            {
                Directory.CreateDirectory(row.WorkingFolder);
            }
        }

        if (patch.TryGetProperty("pluginId", out var pluginElement))
        {
            row.PluginId = pluginElement.ValueKind == JsonValueKind.String
                ? NormalizeOptional(pluginElement.GetString())
                : null;
        }

        if (patch.TryGetProperty("pinned", out var pinnedElement))
        {
            row.Pinned = pinnedElement.ValueKind switch
            {
                JsonValueKind.True => 1,
                JsonValueKind.False => 0,
                JsonValueKind.Number when pinnedElement.TryGetInt32(out var value) => value == 0 ? 0 : 1,
                _ => row.Pinned
            };
        }

        if (JsonHelpers.GetLongNullable(patch, "updatedAt") is { } updatedAt)
        {
            row.UpdatedAt = updatedAt;
        }
        else
        {
            row.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        if (row.WorkingFolder is null && row.SshConnectionId is null &&
            JsonHelpers.GetBool(parameters, "allocateLocalFolderIfMissing", false))
        {
            var allocated = EnsureUniqueLocalProjectDirectory(
                JsonHelpers.GetString(parameters, "baseDirectory"),
                row.Name);
            row.Name = allocated.Name;
            row.WorkingFolder = allocated.FolderPath;
        }
    }

    private static List<string> GetSessionIdsForProject(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string projectId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT id FROM sessions WHERE project_id = $projectId";
        command.Parameters.AddWithValue("$projectId", projectId);
        var ids = new List<string>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            ids.Add(reader.GetString(0));
        }
        return ids;
    }

    private static string SanitizeProjectName(string rawName)
    {
        var replaced = new string(rawName
            .Select(c => c is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*'
                ? ' '
                : c)
            .ToArray());
        var cleaned = string.Join(' ', replaced.Split(
            ' ',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return cleaned.Length == 0 ? "New Project" : cleaned;
    }

    private static ProjectDirectoryAllocation EnsureUniqueLocalProjectDirectory(
        string? requestedBaseDirectory,
        string baseName)
    {
        var baseDirectory = NormalizeOptional(requestedBaseDirectory) ??
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Documents");
        Directory.CreateDirectory(baseDirectory);

        var safeBaseName = SanitizeProjectName(baseName);
        var candidateName = safeBaseName;
        var suffix = 1;
        var candidatePath = Path.Combine(baseDirectory, candidateName);
        while (Directory.Exists(candidatePath) || File.Exists(candidatePath))
        {
            candidateName = $"{safeBaseName} ({suffix})";
            candidatePath = Path.Combine(baseDirectory, candidateName);
            suffix++;
        }

        Directory.CreateDirectory(candidatePath);
        return new ProjectDirectoryAllocation(candidateName, candidatePath);
    }

    private static string CreateId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required project field: {name}");
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

    private sealed record ProjectDirectoryAllocation(string Name, string FolderPath);
}
