using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbMemoryPipelineTools
{
    private const string RootSelectSql = """
        SELECT id,
               scope,
               project_id,
               working_folder,
               ssh_connection_id,
               root_path,
               transport,
               owner_key,
               created_at,
               updated_at
          FROM memory_roots
        """;

    private const string JobSelectSql = """
        SELECT id,
               kind,
               status,
               memory_root_id,
               source_session_id,
               lease_owner,
               lease_expires_at,
               attempts,
               error,
               started_at,
               finished_at,
               created_at,
               updated_at
          FROM memory_jobs
        """;

    private const string Stage1SelectSql = """
        SELECT id,
               memory_root_id,
               scope,
               source_session_id,
               source_updated_at,
               raw_memory,
               rollout_summary,
               rollout_slug,
               fingerprint,
               status,
               usage_count,
               last_usage_at,
               created_at,
               updated_at
          FROM memory_stage1_outputs
        """;

    public static WorkerResponse EnsureRoot(JsonElement parameters)
    {
        try
        {
            var now = Now();
            var ownerKey = BuildOwnerKey(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var existing = GetRootByOwnerKey(connection, transaction, ownerKey);
            if (existing is not null)
            {
                DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    """
                    UPDATE memory_roots
                       SET project_id = $projectId,
                           working_folder = $workingFolder,
                           ssh_connection_id = $sshConnectionId,
                           root_path = $rootPath,
                           transport = $transport,
                           updated_at = $updatedAt
                     WHERE id = $id
                    """,
                    new DbSql.SqlParam("$projectId", JsonHelpers.GetString(parameters, "projectId")),
                    new DbSql.SqlParam("$workingFolder", JsonHelpers.GetString(parameters, "workingFolder")),
                    new DbSql.SqlParam("$sshConnectionId", JsonHelpers.GetString(parameters, "sshConnectionId")),
                    new DbSql.SqlParam("$rootPath", RequireString(parameters, "rootPath")),
                    new DbSql.SqlParam("$transport", ResolveTransport(parameters)),
                    new DbSql.SqlParam("$updatedAt", now),
                    new DbSql.SqlParam("$id", existing.Id));
                var updated = GetRoot(connection, transaction, existing.Id);
                transaction.Commit();
                return WorkerResponse.Json(updated!, WorkerJsonContext.Default.MemoryRootDescriptor);
            }

            var id = CreateId();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO memory_roots (
                  id, scope, project_id, working_folder, ssh_connection_id, root_path, transport,
                  owner_key, created_at, updated_at
                )
                VALUES ($id, $scope, $projectId, $workingFolder, $sshConnectionId, $rootPath, $transport, $ownerKey, $createdAt, $updatedAt)
                """,
                new DbSql.SqlParam("$id", id),
                new DbSql.SqlParam("$scope", RequireString(parameters, "scope")),
                new DbSql.SqlParam("$projectId", JsonHelpers.GetString(parameters, "projectId")),
                new DbSql.SqlParam("$workingFolder", JsonHelpers.GetString(parameters, "workingFolder")),
                new DbSql.SqlParam("$sshConnectionId", JsonHelpers.GetString(parameters, "sshConnectionId")),
                new DbSql.SqlParam("$rootPath", RequireString(parameters, "rootPath")),
                new DbSql.SqlParam("$transport", ResolveTransport(parameters)),
                new DbSql.SqlParam("$ownerKey", ownerKey),
                new DbSql.SqlParam("$createdAt", now),
                new DbSql.SqlParam("$updatedAt", now));

            var root = GetRoot(connection, transaction, id);
            transaction.Commit();
            return WorkerResponse.Json(root!, WorkerJsonContext.Default.MemoryRootDescriptor);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse GetRoot(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var root = GetRoot(connection, null, id);
            return WorkerResponse.Json(
                new MemoryRootFindResult(true, root, null),
                WorkerJsonContext.Default.MemoryRootFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryRootFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.MemoryRootFindResult);
        }
    }

    public static WorkerResponse ListRoots(JsonElement parameters)
    {
        try
        {
            var where = new List<string>();
            var values = new List<DbSql.SqlParam>();
            var scope = JsonHelpers.GetString(parameters, "scope");
            if (!string.IsNullOrEmpty(scope) && !string.Equals(scope, "both", StringComparison.Ordinal))
            {
                where.Add("scope = $scope");
                values.Add(new DbSql.SqlParam("$scope", scope));
            }
            AddNullableFilter(parameters, where, values, "projectId", "project_id");
            AddNullableFilter(parameters, where, values, "workingFolder", "working_folder");
            AddNullableFilter(parameters, where, values, "sshConnectionId", "ssh_connection_id");
            AddNullableFilter(parameters, where, values, "rootPath", "root_path");

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {RootSelectSql}
                {(where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : string.Empty)}
                 ORDER BY scope ASC, updated_at DESC
                """;
            foreach (var value in values)
            {
                command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
            }

            return WorkerResponse.Json(ReadRoots(command), WorkerJsonContext.Default.ListMemoryRootDescriptor);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse CreateJob(JsonElement parameters)
    {
        try
        {
            var now = Now();
            var status = JsonHelpers.GetString(parameters, "status") ?? "running";
            var leaseOwner = JsonHelpers.GetString(parameters, "leaseOwner");
            var running = status == "running";
            var id = CreateId();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO memory_jobs (
                  id, kind, status, memory_root_id, source_session_id, lease_owner, lease_expires_at,
                  attempts, error, started_at, finished_at, created_at, updated_at
                )
                VALUES (
                  $id, $kind, $status, $memoryRootId, $sourceSessionId, $leaseOwner, $leaseExpiresAt,
                  $attempts, NULL, $startedAt, NULL, $createdAt, $updatedAt
                )
                """,
                new DbSql.SqlParam("$id", id),
                new DbSql.SqlParam("$kind", JsonHelpers.GetString(parameters, "kind") ?? "stage1"),
                new DbSql.SqlParam("$status", status),
                new DbSql.SqlParam("$memoryRootId", JsonHelpers.GetString(parameters, "memoryRootId")),
                new DbSql.SqlParam("$sourceSessionId", JsonHelpers.GetString(parameters, "sourceSessionId")),
                new DbSql.SqlParam("$leaseOwner", leaseOwner),
                new DbSql.SqlParam("$leaseExpiresAt", leaseOwner is not null ? now + 60 * 60 * 1000 : null),
                new DbSql.SqlParam("$attempts", running ? 1 : 0),
                new DbSql.SqlParam("$startedAt", running ? now : null),
                new DbSql.SqlParam("$createdAt", now),
                new DbSql.SqlParam("$updatedAt", now));
            var job = GetJob(connection, transaction, id);
            transaction.Commit();
            return WorkerResponse.Json(job!, WorkerJsonContext.Default.MemoryPipelineJob);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse GetJob(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var job = GetJob(connection, null, id);
            return WorkerResponse.Json(
                new MemoryJobFindResult(true, job, null),
                WorkerJsonContext.Default.MemoryJobFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryJobFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.MemoryJobFindResult);
        }
    }

    public static WorkerResponse FinishJob(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            var now = Now();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE memory_jobs
                   SET status = $status,
                       error = $error,
                       lease_owner = NULL,
                       lease_expires_at = NULL,
                       finished_at = $finishedAt,
                       updated_at = $updatedAt
                 WHERE id = $id
                """,
                new DbSql.SqlParam("$status", JsonHelpers.GetString(parameters, "status") ?? "succeeded"),
                new DbSql.SqlParam("$error", JsonHelpers.GetString(parameters, "error")),
                new DbSql.SqlParam("$finishedAt", now),
                new DbSql.SqlParam("$updatedAt", now),
                new DbSql.SqlParam("$id", id));
            var job = GetJob(connection, transaction, id);
            transaction.Commit();
            return WorkerResponse.Json(
                new MemoryJobFindResult(true, job, null),
                WorkerJsonContext.Default.MemoryJobFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryJobFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.MemoryJobFindResult);
        }
    }

    public static WorkerResponse ListJobs(JsonElement parameters)
    {
        try
        {
            var where = new List<string>();
            var values = new List<DbSql.SqlParam>();
            AddNullableFilter(parameters, where, values, "memoryRootId", "memory_root_id");
            AddNullableFilter(parameters, where, values, "sourceSessionId", "source_session_id");
            AddInFilter(parameters, where, values, "statuses", "status");
            AddInFilter(parameters, where, values, "kinds", "kind");
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 50), 1, 500);

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {JobSelectSql}
                {(where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : string.Empty)}
                 ORDER BY updated_at DESC
                 LIMIT $limit
                """;
            foreach (var value in values)
            {
                command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
            }
            command.Parameters.AddWithValue("$limit", limit);

            return WorkerResponse.Json(ReadJobs(command), WorkerJsonContext.Default.ListMemoryPipelineJob);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse AddStage1Output(JsonElement parameters)
    {
        try
        {
            var now = Now();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO memory_stage1_outputs (
                  id, memory_root_id, scope, source_session_id, source_updated_at, raw_memory,
                  rollout_summary, rollout_slug, fingerprint, status, usage_count, last_usage_at,
                  created_at, updated_at
                )
                VALUES (
                  $id, $memoryRootId, $scope, $sourceSessionId, $sourceUpdatedAt, $rawMemory,
                  $rolloutSummary, $rolloutSlug, $fingerprint, $status, 0, NULL, $createdAt, $updatedAt
                )
                ON CONFLICT(memory_root_id, source_session_id, fingerprint) DO UPDATE SET
                  raw_memory = excluded.raw_memory,
                  rollout_summary = excluded.rollout_summary,
                  rollout_slug = excluded.rollout_slug,
                  status = excluded.status,
                  source_updated_at = excluded.source_updated_at,
                  updated_at = excluded.updated_at
                """,
                new DbSql.SqlParam("$id", CreateId()),
                new DbSql.SqlParam("$memoryRootId", RequireString(parameters, "memoryRootId")),
                new DbSql.SqlParam("$scope", RequireString(parameters, "scope")),
                new DbSql.SqlParam("$sourceSessionId", RequireString(parameters, "sourceSessionId")),
                new DbSql.SqlParam("$sourceUpdatedAt", JsonHelpers.GetLongNullable(parameters, "sourceUpdatedAt")),
                new DbSql.SqlParam("$rawMemory", RequireString(parameters, "rawMemory")),
                new DbSql.SqlParam("$rolloutSummary", RequireString(parameters, "rolloutSummary")),
                new DbSql.SqlParam("$rolloutSlug", RequireString(parameters, "rolloutSlug")),
                new DbSql.SqlParam("$fingerprint", RequireString(parameters, "fingerprint")),
                new DbSql.SqlParam("$status", JsonHelpers.GetString(parameters, "status") ?? "active"),
                new DbSql.SqlParam("$createdAt", now),
                new DbSql.SqlParam("$updatedAt", now));
            var output = GetStage1OutputByKey(
                connection,
                transaction,
                RequireString(parameters, "memoryRootId"),
                RequireString(parameters, "sourceSessionId"),
                RequireString(parameters, "fingerprint"));
            transaction.Commit();
            return WorkerResponse.Json(output!, WorkerJsonContext.Default.MemoryStage1Output);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse ListStage1Outputs(JsonElement parameters)
    {
        try
        {
            var memoryRootId = RequireString(parameters, "memoryRootId");
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 500), 1, 5000);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {Stage1SelectSql}
                 WHERE memory_root_id = $memoryRootId
                   AND status = 'active'
                 ORDER BY created_at DESC
                 LIMIT $limit
                """;
            command.Parameters.AddWithValue("$memoryRootId", memoryRootId);
            command.Parameters.AddWithValue("$limit", limit);
            return WorkerResponse.Json(ReadStage1Outputs(command), WorkerJsonContext.Default.ListMemoryStage1Output);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse RecordCitationUsage(JsonElement parameters)
    {
        try
        {
            var now = Now();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO memory_citation_usage (
                  id, memory_root_id, scope, source_session_id, path, line, citation_json, created_at
                )
                VALUES ($id, $memoryRootId, $scope, $sourceSessionId, $path, $line, $citationJson, $createdAt)
                """,
                new DbSql.SqlParam("$id", CreateId()),
                new DbSql.SqlParam("$memoryRootId", RequireString(parameters, "memoryRootId")),
                new DbSql.SqlParam("$scope", RequireString(parameters, "scope")),
                new DbSql.SqlParam("$sourceSessionId", JsonHelpers.GetString(parameters, "sourceSessionId")),
                new DbSql.SqlParam("$path", RequireString(parameters, "path")),
                new DbSql.SqlParam("$line", JsonHelpers.GetIntNullable(parameters, "line")),
                new DbSql.SqlParam("$citationJson", JsonHelpers.GetString(parameters, "citationJson")),
                new DbSql.SqlParam("$createdAt", now));
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE memory_stage1_outputs
                   SET usage_count = usage_count + 1,
                       last_usage_at = $lastUsageAt,
                       updated_at = $updatedAt
                 WHERE memory_root_id = $memoryRootId
                """,
                new DbSql.SqlParam("$lastUsageAt", now),
                new DbSql.SqlParam("$updatedAt", now),
                new DbSql.SqlParam("$memoryRootId", RequireString(parameters, "memoryRootId")));
            transaction.Commit();
            return WorkerResponse.Json(
                new MemoryMutationResult(true, changed, null),
                WorkerJsonContext.Default.MemoryMutationResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryMutationResult(false, 0, ex.Message),
                WorkerJsonContext.Default.MemoryMutationResult);
        }
    }

    public static WorkerResponse ClearRoot(JsonElement parameters)
    {
        try
        {
            var memoryRootId = RequireString(parameters, "memoryRootId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var deletedStage1Outputs = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM memory_stage1_outputs WHERE memory_root_id = $memoryRootId",
                new DbSql.SqlParam("$memoryRootId", memoryRootId));
            var deletedJobs = JsonHelpers.GetBool(parameters, "includeJobs", false)
                ? DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    "DELETE FROM memory_jobs WHERE memory_root_id = $memoryRootId",
                    new DbSql.SqlParam("$memoryRootId", memoryRootId))
                : 0;
            transaction.Commit();
            return WorkerResponse.Json(
                new MemoryClearRootResult(true, deletedStage1Outputs, deletedJobs, null),
                WorkerJsonContext.Default.MemoryClearRootResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryClearRootResult(false, 0, 0, ex.Message),
                WorkerJsonContext.Default.MemoryClearRootResult);
        }
    }

    private static MemoryRootDescriptor? GetRoot(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{RootSelectSql} WHERE id = $id LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return ReadRoots(command).FirstOrDefault();
    }

    private static MemoryRootDescriptor? GetRootByOwnerKey(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string ownerKey)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{RootSelectSql} WHERE owner_key = $ownerKey LIMIT 1";
        command.Parameters.AddWithValue("$ownerKey", ownerKey);
        return ReadRoots(command).FirstOrDefault();
    }

    private static MemoryPipelineJob? GetJob(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{JobSelectSql} WHERE id = $id LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return ReadJobs(command).FirstOrDefault();
    }

    private static MemoryStage1Output? GetStage1OutputByKey(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string memoryRootId,
        string sourceSessionId,
        string fingerprint)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
            {Stage1SelectSql}
             WHERE memory_root_id = $memoryRootId
               AND source_session_id = $sourceSessionId
               AND fingerprint = $fingerprint
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$memoryRootId", memoryRootId);
        command.Parameters.AddWithValue("$sourceSessionId", sourceSessionId);
        command.Parameters.AddWithValue("$fingerprint", fingerprint);
        return ReadStage1Outputs(command).FirstOrDefault();
    }

    private static List<MemoryRootDescriptor> ReadRoots(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<MemoryRootDescriptor>();
        while (reader.Read())
        {
            rows.Add(new MemoryRootDescriptor
            {
                Id = reader.GetString(0),
                Scope = reader.GetString(1),
                ProjectId = reader.IsDBNull(2) ? null : reader.GetString(2),
                WorkingFolder = reader.IsDBNull(3) ? null : reader.GetString(3),
                SshConnectionId = reader.IsDBNull(4) ? null : reader.GetString(4),
                RootPath = reader.GetString(5),
                Transport = reader.GetString(6),
                OwnerKey = reader.GetString(7),
                CreatedAt = reader.GetInt64(8),
                UpdatedAt = reader.GetInt64(9)
            });
        }

        return rows;
    }

    private static List<MemoryPipelineJob> ReadJobs(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<MemoryPipelineJob>();
        while (reader.Read())
        {
            rows.Add(new MemoryPipelineJob
            {
                Id = reader.GetString(0),
                Kind = reader.GetString(1),
                Status = reader.GetString(2),
                MemoryRootId = reader.IsDBNull(3) ? null : reader.GetString(3),
                SourceSessionId = reader.IsDBNull(4) ? null : reader.GetString(4),
                LeaseOwner = reader.IsDBNull(5) ? null : reader.GetString(5),
                LeaseExpiresAt = reader.IsDBNull(6) ? null : reader.GetInt64(6),
                Attempts = reader.GetInt32(7),
                Error = reader.IsDBNull(8) ? null : reader.GetString(8),
                StartedAt = reader.IsDBNull(9) ? null : reader.GetInt64(9),
                FinishedAt = reader.IsDBNull(10) ? null : reader.GetInt64(10),
                CreatedAt = reader.GetInt64(11),
                UpdatedAt = reader.GetInt64(12)
            });
        }

        return rows;
    }

    private static List<MemoryStage1Output> ReadStage1Outputs(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<MemoryStage1Output>();
        while (reader.Read())
        {
            rows.Add(new MemoryStage1Output
            {
                Id = reader.GetString(0),
                MemoryRootId = reader.GetString(1),
                Scope = reader.GetString(2),
                SourceSessionId = reader.GetString(3),
                SourceUpdatedAt = reader.IsDBNull(4) ? null : reader.GetInt64(4),
                RawMemory = reader.GetString(5),
                RolloutSummary = reader.GetString(6),
                RolloutSlug = reader.GetString(7),
                Fingerprint = reader.GetString(8),
                Status = reader.GetString(9),
                UsageCount = reader.GetInt32(10),
                LastUsageAt = reader.IsDBNull(11) ? null : reader.GetInt64(11),
                CreatedAt = reader.GetInt64(12),
                UpdatedAt = reader.GetInt64(13)
            });
        }

        return rows;
    }

    private static void AddNullableFilter(
        JsonElement parameters,
        List<string> where,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!parameters.TryGetProperty(jsonName, out var property))
        {
            return;
        }

        where.Add($"{columnName} IS ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", property.ValueKind == JsonValueKind.Null ? null : property.GetString()));
    }

    private static void AddInFilter(
        JsonElement parameters,
        List<string> where,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        var items = JsonHelpers.GetStringArray(parameters, jsonName);
        if (items.Length == 0)
        {
            return;
        }

        var markers = new List<string>();
        for (var i = 0; i < items.Length; i++)
        {
            var name = $"${jsonName}{i}";
            markers.Add(name);
            values.Add(new DbSql.SqlParam(name, items[i]));
        }

        where.Add($"{columnName} IN ({string.Join(", ", markers)})");
    }

    private static string BuildOwnerKey(JsonElement parameters)
    {
        var transport = ResolveTransport(parameters);
        var projectId = JsonHelpers.GetString(parameters, "projectId")?.Trim() ?? string.Empty;
        var sshConnectionId = JsonHelpers.GetString(parameters, "sshConnectionId")?.Trim() ?? string.Empty;
        var workingFolder = NormalizeOwnerPath(
            JsonHelpers.GetString(parameters, "workingFolder") ?? string.Empty,
            sshConnectionId);
        var rootPath = NormalizeOwnerPath(RequireString(parameters, "rootPath"), sshConnectionId);
        return string.Join(
            "::",
            RequireString(parameters, "scope"),
            transport,
            projectId,
            sshConnectionId,
            workingFolder,
            rootPath);
    }

    private static string NormalizeOwnerPath(string value, string? sshConnectionId)
    {
        var trimmed = value.Trim();
        if (trimmed.Length == 0)
        {
            return string.Empty;
        }

        return !string.IsNullOrEmpty(sshConnectionId)
            ? trimmed.Replace('\\', '/')
            : Path.GetFullPath(trimmed).Replace('\\', '/').ToLowerInvariant();
    }

    private static string ResolveTransport(JsonElement parameters)
    {
        return JsonHelpers.GetString(parameters, "transport") ??
            (JsonHelpers.GetString(parameters, "sshConnectionId") is null ? "local" : "ssh");
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static string CreateId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required memory pipeline field: {name}");
    }
}
