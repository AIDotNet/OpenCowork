using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbMemoryAutomationTools
{
    private const string EntrySelectColumns = """
        id,
        scope,
        root_scope,
        memory_root_id,
        job_id,
        project_id,
        target,
        kind,
        content,
        confidence,
        source_session_id,
        target_path,
        status,
        filter_reason,
        fingerprint,
        evidence_json,
        written_at,
        error,
        before_content,
        after_content,
        appended_text,
        ssh_connection_id,
        created_at,
        updated_at,
        undone_at
        """;

    public static WorkerResponse AddEntry(JsonElement parameters)
    {
        try
        {
            var now = Now();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"""
                INSERT INTO memory_automation_entries (
                  id,
                  scope,
                  root_scope,
                  memory_root_id,
                  job_id,
                  project_id,
                  target,
                  kind,
                  content,
                  confidence,
                  source_session_id,
                  target_path,
                  status,
                  filter_reason,
                  fingerprint,
                  evidence_json,
                  written_at,
                  error,
                  before_content,
                  after_content,
                  appended_text,
                  ssh_connection_id,
                  created_at,
                  updated_at,
                  undone_at
                )
                VALUES (
                  $id,
                  $scope,
                  $rootScope,
                  $memoryRootId,
                  $jobId,
                  $projectId,
                  $target,
                  $kind,
                  $content,
                  $confidence,
                  $sourceSessionId,
                  $targetPath,
                  $status,
                  $filterReason,
                  $fingerprint,
                  $evidenceJson,
                  $writtenAt,
                  $error,
                  $beforeContent,
                  $afterContent,
                  $appendedText,
                  $sshConnectionId,
                  $createdAt,
                  $updatedAt,
                  NULL
                )
                RETURNING {EntrySelectColumns}
                """;
            command.Parameters.AddWithValue("$id", CreateId());
            command.Parameters.AddWithValue("$scope", RequireString(parameters, "scope"));
            command.Parameters.AddWithValue("$rootScope", GetOptionalString(parameters, "rootScope") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$memoryRootId", GetOptionalString(parameters, "memoryRootId") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$jobId", GetOptionalString(parameters, "jobId") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$projectId", GetOptionalString(parameters, "projectId") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$target", RequireString(parameters, "target"));
            command.Parameters.AddWithValue("$kind", RequireString(parameters, "kind"));
            command.Parameters.AddWithValue("$content", RequireString(parameters, "content"));
            command.Parameters.AddWithValue("$confidence", ReadConfidence(parameters));
            command.Parameters.AddWithValue("$sourceSessionId", GetOptionalString(parameters, "sourceSessionId") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$targetPath", GetOptionalString(parameters, "targetPath") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$status", RequireString(parameters, "status"));
            command.Parameters.AddWithValue("$filterReason", GetOptionalString(parameters, "filterReason") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$fingerprint", RequireString(parameters, "fingerprint"));
            command.Parameters.AddWithValue("$evidenceJson", SerializeEvidence(parameters) ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$writtenAt", JsonHelpers.GetLongNullable(parameters, "writtenAt") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$error", GetOptionalString(parameters, "error") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$beforeContent", GetOptionalString(parameters, "beforeContent") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$afterContent", GetOptionalString(parameters, "afterContent") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$appendedText", GetOptionalString(parameters, "appendedText") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$sshConnectionId", GetOptionalString(parameters, "sshConnectionId") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$createdAt", now);
            command.Parameters.AddWithValue("$updatedAt", now);

            var entry = ReadEntries(command).First();
            transaction.Commit();
            return WorkerResponse.Json(
                new MemoryAutomationEntryResult(true, entry, null),
                WorkerJsonContext.Default.MemoryAutomationEntryResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryAutomationEntryResult(false, null, ex.Message),
                WorkerJsonContext.Default.MemoryAutomationEntryResult);
        }
    }

    public static WorkerResponse GetEntry(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var entry = GetEntry(connection, null, id);
            return WorkerResponse.Json(
                new MemoryAutomationEntryResult(true, entry, null),
                WorkerJsonContext.Default.MemoryAutomationEntryResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryAutomationEntryResult(false, null, ex.Message),
                WorkerJsonContext.Default.MemoryAutomationEntryResult);
        }
    }

    public static WorkerResponse ListEntries(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            var where = new List<string>();
            var parameterIndex = 0;

            AddInFilter(command, where, "status", "statuses", JsonHelpers.GetStringArray(parameters, "statuses"), ref parameterIndex);
            AddNullableStringFilter(command, where, parameters, "id", "id", ref parameterIndex);
            AddNullableStringFilter(command, where, parameters, "memoryRootId", "memory_root_id", ref parameterIndex);
            AddNullableStringFilter(command, where, parameters, "rootScope", "root_scope", ref parameterIndex);
            AddNullableStringFilter(command, where, parameters, "projectId", "project_id", ref parameterIndex);
            AddInFilter(command, where, "target", "targets", JsonHelpers.GetStringArray(parameters, "targets"), ref parameterIndex);
            AddNullableStringFilter(command, where, parameters, "sourceSessionId", "source_session_id", ref parameterIndex);
            AddExactOptionalFilter(command, where, parameters, "targetPath", "target_path", ref parameterIndex);
            AddLikeFilter(command, where, parameters, "targetPathIncludes", "target_path", ref parameterIndex);
            AddExactOptionalFilter(command, where, parameters, "fingerprint", "fingerprint", ref parameterIndex);

            var includeSnapshots = JsonHelpers.GetBool(parameters, "includeContentSnapshots", false);
            var snapshotColumns = includeSnapshots
                ? "before_content, after_content, appended_text,"
                : "NULL AS before_content, NULL AS after_content, NULL AS appended_text,";
            command.CommandText = $"""
                SELECT
                  id,
                  scope,
                  root_scope,
                  memory_root_id,
                  job_id,
                  project_id,
                  target,
                  kind,
                  content,
                  confidence,
                  source_session_id,
                  target_path,
                  status,
                  filter_reason,
                  fingerprint,
                  evidence_json,
                  written_at,
                  error,
                  {snapshotColumns}
                  ssh_connection_id,
                  created_at,
                  updated_at,
                  undone_at
                FROM memory_automation_entries
                {(where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : string.Empty)}
                ORDER BY created_at DESC
                LIMIT $limit OFFSET $offset
                """;
            command.Parameters.AddWithValue("$limit", ReadLimit(parameters));
            command.Parameters.AddWithValue("$offset", ReadOffset(parameters));
            return WorkerResponse.Json(ReadEntries(command), WorkerJsonContext.Default.ListMemoryAutomationEntry);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse MarkUndo(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            var status = JsonHelpers.GetString(parameters, "status") == "error" ? "error" : "undone";
            var now = Now();
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"""
                UPDATE memory_automation_entries
                   SET status = $status,
                       error = $error,
                       updated_at = $updatedAt,
                       undone_at = CASE WHEN $status = 'undone' THEN $updatedAt ELSE undone_at END
                 WHERE id = $id
                 RETURNING {EntrySelectColumns}
                """;
            command.Parameters.AddWithValue("$status", status);
            command.Parameters.AddWithValue("$error", GetOptionalString(parameters, "error") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$updatedAt", now);
            command.Parameters.AddWithValue("$id", id);
            var entry = ReadEntries(command).FirstOrDefault();
            transaction.Commit();
            return WorkerResponse.Json(
                new MemoryAutomationEntryResult(true, entry, null),
                WorkerJsonContext.Default.MemoryAutomationEntryResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryAutomationEntryResult(false, null, ex.Message),
                WorkerJsonContext.Default.MemoryAutomationEntryResult);
        }
    }

    public static WorkerResponse HasProcessedRollup(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT 1
                  FROM memory_automation_rollups
                 WHERE scope = $scope
                   AND target_path = $targetPath
                   AND source_date = $sourceDate
                   AND content_hash = $contentHash
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$scope", RequireString(parameters, "scope"));
            command.Parameters.AddWithValue("$targetPath", RequireString(parameters, "targetPath"));
            command.Parameters.AddWithValue("$sourceDate", RequireString(parameters, "sourceDate"));
            command.Parameters.AddWithValue("$contentHash", RequireString(parameters, "contentHash"));
            var exists = command.ExecuteScalar() is not null;
            return WorkerResponse.Json(
                new MemoryAutomationRollupResult(true, exists, null),
                WorkerJsonContext.Default.MemoryAutomationRollupResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryAutomationRollupResult(false, false, ex.Message),
                WorkerJsonContext.Default.MemoryAutomationRollupResult);
        }
    }

    public static WorkerResponse MarkProcessedRollup(JsonElement parameters)
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
                INSERT OR REPLACE INTO memory_automation_rollups (
                  scope,
                  target,
                  target_path,
                  source_date,
                  content_hash,
                  processed_at
                )
                VALUES (
                  $scope,
                  $target,
                  $targetPath,
                  $sourceDate,
                  $contentHash,
                  $processedAt
                )
                """,
                new DbSql.SqlParam("$scope", RequireString(parameters, "scope")),
                new DbSql.SqlParam("$target", JsonHelpers.GetString(parameters, "target") ?? "project_memory"),
                new DbSql.SqlParam("$targetPath", RequireString(parameters, "targetPath")),
                new DbSql.SqlParam("$sourceDate", RequireString(parameters, "sourceDate")),
                new DbSql.SqlParam("$contentHash", RequireString(parameters, "contentHash")),
                new DbSql.SqlParam("$processedAt", now));
            transaction.Commit();
            return WorkerResponse.Json(
                new MemoryAutomationRollupResult(true, true, null),
                WorkerJsonContext.Default.MemoryAutomationRollupResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MemoryAutomationRollupResult(false, false, ex.Message),
                WorkerJsonContext.Default.MemoryAutomationRollupResult);
        }
    }

    private static MemoryAutomationEntry? GetEntry(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"SELECT {EntrySelectColumns} FROM memory_automation_entries WHERE id = $id LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return ReadEntries(command).FirstOrDefault();
    }

    private static List<MemoryAutomationEntry> ReadEntries(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<MemoryAutomationEntry>();
        while (reader.Read())
        {
            rows.Add(new MemoryAutomationEntry
            {
                Id = reader.GetString(0),
                Scope = reader.GetString(1),
                RootScope = reader.IsDBNull(2) ? null : reader.GetString(2),
                MemoryRootId = reader.IsDBNull(3) ? null : reader.GetString(3),
                JobId = reader.IsDBNull(4) ? null : reader.GetString(4),
                ProjectId = reader.IsDBNull(5) ? null : reader.GetString(5),
                Target = reader.GetString(6),
                Kind = reader.GetString(7),
                Content = reader.GetString(8),
                Confidence = reader.GetDouble(9),
                SourceSessionId = reader.IsDBNull(10) ? null : reader.GetString(10),
                TargetPath = reader.IsDBNull(11) ? null : reader.GetString(11),
                Status = reader.GetString(12),
                FilterReason = reader.IsDBNull(13) ? null : reader.GetString(13),
                Fingerprint = reader.GetString(14),
                EvidenceJson = reader.IsDBNull(15) ? null : reader.GetString(15),
                WrittenAt = reader.IsDBNull(16) ? null : reader.GetInt64(16),
                Error = reader.IsDBNull(17) ? null : reader.GetString(17),
                BeforeContent = reader.IsDBNull(18) ? null : reader.GetString(18),
                AfterContent = reader.IsDBNull(19) ? null : reader.GetString(19),
                AppendedText = reader.IsDBNull(20) ? null : reader.GetString(20),
                SshConnectionId = reader.IsDBNull(21) ? null : reader.GetString(21),
                CreatedAt = reader.GetInt64(22),
                UpdatedAt = reader.GetInt64(23),
                UndoneAt = reader.IsDBNull(24) ? null : reader.GetInt64(24)
            });
        }

        return rows;
    }

    private static void AddInFilter(
        SqliteCommand command,
        List<string> where,
        string columnName,
        string parameterPrefix,
        string[] values,
        ref int parameterIndex)
    {
        if (values.Length == 0)
        {
            return;
        }

        var names = new List<string>();
        foreach (var value in values)
        {
            var parameterName = $"${parameterPrefix}{parameterIndex++}";
            names.Add(parameterName);
            command.Parameters.AddWithValue(parameterName, value);
        }

        where.Add($"{columnName} IN ({string.Join(", ", names)})");
    }

    private static void AddNullableStringFilter(
        SqliteCommand command,
        List<string> where,
        JsonElement parameters,
        string propertyName,
        string columnName,
        ref int parameterIndex)
    {
        if (!parameters.TryGetProperty(propertyName, out var value))
        {
            return;
        }

        var parameterName = $"$p{parameterIndex++}";
        where.Add($"{columnName} IS {parameterName}");
        command.Parameters.AddWithValue(parameterName, JsonValueToNullableString(value) ?? (object)DBNull.Value);
    }

    private static void AddExactOptionalFilter(
        SqliteCommand command,
        List<string> where,
        JsonElement parameters,
        string propertyName,
        string columnName,
        ref int parameterIndex)
    {
        var value = JsonHelpers.GetString(parameters, propertyName);
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        var parameterName = $"$p{parameterIndex++}";
        where.Add($"{columnName} = {parameterName}");
        command.Parameters.AddWithValue(parameterName, value);
    }

    private static void AddLikeFilter(
        SqliteCommand command,
        List<string> where,
        JsonElement parameters,
        string propertyName,
        string columnName,
        ref int parameterIndex)
    {
        var value = JsonHelpers.GetString(parameters, propertyName);
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        var parameterName = $"$p{parameterIndex++}";
        where.Add($"{columnName} LIKE {parameterName}");
        command.Parameters.AddWithValue(parameterName, $"%{value}%");
    }

    private static string? SerializeEvidence(JsonElement parameters)
    {
        if (JsonHelpers.GetString(parameters, "evidenceJson") is { } evidenceJson)
        {
            return evidenceJson;
        }

        if (!parameters.TryGetProperty("evidence", out var evidence) || evidence.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        return evidence.GetRawText();
    }

    private static double ReadConfidence(JsonElement parameters)
    {
        var confidence = JsonHelpers.GetDoubleNullable(parameters, "confidence") ?? 0;
        if (double.IsNaN(confidence) || double.IsInfinity(confidence))
        {
            return 0;
        }

        return Math.Clamp(confidence, 0, 1);
    }

    private static int ReadLimit(JsonElement parameters)
    {
        return Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 50), 1, 500);
    }

    private static int ReadOffset(JsonElement parameters)
    {
        return Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));
    }

    private static string? GetOptionalString(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var value))
        {
            return null;
        }

        return JsonValueToNullableString(value);
    }

    private static string? JsonValueToNullableString(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.String => value.GetString(),
            _ => null
        };
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required memory automation field: {name}");
    }

    private static string CreateId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
