using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbAgentChangeTools
{
    private const string ChangeSetSelectColumns = """
        run_id,
        session_id,
        assistant_message_id,
        status,
        created_at,
        updated_at
        """;

    private const string FileChangeSelectColumns = """
        id,
        run_id,
        session_id,
        tool_use_id,
        tool_name,
        file_path,
        transport,
        connection_id,
        op,
        status,
        before_json,
        after_json,
        created_at,
        reverted_at,
        sort_order
        """;

    public static WorkerResponse Get(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var changeSet = LoadChangeSetByRunId(connection, runId);
            return WorkerResponse.Json(
                new AgentChangeSetFindResult(true, changeSet, null),
                WorkerJsonContext.Default.AgentChangeSetFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new AgentChangeSetFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.AgentChangeSetFindResult);
        }
    }

    public static WorkerResponse ListBySession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId").Trim();
            if (sessionId.Length == 0)
            {
                return WorkerResponse.Json(new List<StoredRunChangeSet>(), WorkerJsonContext.Default.ListStoredRunChangeSet);
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            return WorkerResponse.Json(
                LoadChangeSetsBySession(connection, sessionId),
                WorkerJsonContext.Default.ListStoredRunChangeSet);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse AppendFileChange(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            var assistantMessageId = RequireString(parameters, "assistantMessageId");
            var sessionId = GetOptionalString(parameters, "sessionId");
            var now = JsonHelpers.GetLong(parameters, "now", Now());
            var changeElement = RequireObject(parameters, "change");
            var change = new StoredTrackedFileChange
            {
                Id = RequireString(changeElement, "id"),
                RunId = runId,
                SessionId = GetOptionalString(changeElement, "sessionId") ?? sessionId,
                ToolUseId = GetOptionalString(changeElement, "toolUseId"),
                ToolName = GetOptionalString(changeElement, "toolName"),
                FilePath = RequireString(changeElement, "filePath"),
                Transport = NormalizeTransport(JsonHelpers.GetString(changeElement, "transport")),
                ConnectionId = GetOptionalString(changeElement, "connectionId"),
                Op = NormalizeOp(JsonHelpers.GetString(changeElement, "op")),
                Status = NormalizeStatus(JsonHelpers.GetString(changeElement, "status")),
                Before = ParseSnapshot(RequireRawObject(changeElement, "before")),
                After = ParseSnapshot(RequireRawObject(changeElement, "after")),
                CreatedAt = JsonHelpers.GetLong(changeElement, "createdAt", now),
                RevertedAt = JsonHelpers.GetLongNullable(changeElement, "revertedAt")
            };

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = AppendTrackedFileChange(
                connection,
                transaction,
                runId,
                sessionId,
                assistantMessageId,
                change,
                now);
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse MarkFileReverted(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            var changeId = RequireString(parameters, "changeId");
            var revertedAt = JsonHelpers.GetLong(parameters, "revertedAt", Now());
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE agent_file_changes
                   SET status = 'reverted',
                       reverted_at = $revertedAt
                 WHERE run_id = $runId AND id = $changeId
                """,
                new DbSql.SqlParam("$revertedAt", revertedAt),
                new DbSql.SqlParam("$runId", runId),
                new DbSql.SqlParam("$changeId", changeId));
            RecomputeRunStatus(connection, transaction, runId, revertedAt);
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Recompute(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            var now = JsonHelpers.GetLong(parameters, "now", Now());
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = RecomputeRunStatus(connection, transaction, runId, now);
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse DeleteFinalizedOlderThan(JsonElement parameters)
    {
        try
        {
            var cutoff = JsonHelpers.GetLong(parameters, "cutoff", 0);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var select = connection.CreateCommand();
            select.Transaction = transaction;
            select.CommandText = """
                SELECT run_id
                  FROM agent_change_sets
                 WHERE updated_at < $cutoff AND status = 'reverted'
                """;
            select.Parameters.AddWithValue("$cutoff", cutoff);
            var runIds = new List<string>();
            using (var reader = select.ExecuteReader())
            {
                while (reader.Read())
                {
                    runIds.Add(reader.GetString(0));
                }
            }

            if (runIds.Count > 0)
            {
                var inClause = AddInParameters(runIds, "$run", out var parametersList);
                using var deleteChanges = connection.CreateCommand();
                deleteChanges.Transaction = transaction;
                deleteChanges.CommandText = $"DELETE FROM agent_file_changes WHERE run_id IN ({inClause})";
                foreach (var parameter in parametersList)
                {
                    deleteChanges.Parameters.AddWithValue(parameter.Name, parameter.Value);
                }
                deleteChanges.ExecuteNonQuery();

                using var deleteSets = connection.CreateCommand();
                deleteSets.Transaction = transaction;
                deleteSets.CommandText = $"DELETE FROM agent_change_sets WHERE run_id IN ({inClause})";
                foreach (var parameter in parametersList)
                {
                    deleteSets.Parameters.AddWithValue(parameter.Name, parameter.Value);
                }
                deleteSets.ExecuteNonQuery();
            }

            transaction.Commit();
            return WorkerResponse.Json(
                new AgentChangeDeleteResult(true, runIds.Count, null),
                WorkerJsonContext.Default.AgentChangeDeleteResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new AgentChangeDeleteResult(false, 0, ex.Message),
                WorkerJsonContext.Default.AgentChangeDeleteResult);
        }
    }

    internal static StoredRunChangeSet? LoadChangeSetByRunId(SqliteConnection connection, string runId)
    {
        return LoadChangeSetsByRunIds(connection, [runId]).FirstOrDefault();
    }

    internal static int AppendTrackedFileChange(
        JsonElement dbParameters,
        string runId,
        string? sessionId,
        string assistantMessageId,
        StoredTrackedFileChange change,
        long now)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(dbParameters);
        using var transaction = connection.BeginTransaction();
        var changed = AppendTrackedFileChange(
            connection,
            transaction,
            runId,
            sessionId,
            assistantMessageId,
            change,
            now);
        transaction.Commit();
        return changed;
    }

    internal static int AppendTrackedFileChange(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string runId,
        string? sessionId,
        string assistantMessageId,
        StoredTrackedFileChange change,
        long now)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO agent_change_sets (
              run_id,
              session_id,
              assistant_message_id,
              status,
              created_at,
              updated_at
            ) VALUES (
              $runId,
              $sessionId,
              $assistantMessageId,
              'open',
              $createdAt,
              $updatedAt
            )
            ON CONFLICT(run_id) DO UPDATE SET
              session_id = COALESCE(agent_change_sets.session_id, excluded.session_id),
              assistant_message_id = excluded.assistant_message_id,
              status = 'open',
              updated_at = excluded.updated_at
            """,
            new DbSql.SqlParam("$runId", runId),
            new DbSql.SqlParam("$sessionId", sessionId),
            new DbSql.SqlParam("$assistantMessageId", assistantMessageId),
            new DbSql.SqlParam("$createdAt", now),
            new DbSql.SqlParam("$updatedAt", now));

        var nextSort = ReadNextSortOrder(connection, transaction, runId);
        if (string.IsNullOrWhiteSpace(change.Id))
        {
            change.Id = $"{runId}:{nextSort + 1}";
        }

        return DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO agent_file_changes (
              id,
              run_id,
              session_id,
              tool_use_id,
              tool_name,
              file_path,
              transport,
              connection_id,
              op,
              status,
              before_json,
              after_json,
              created_at,
              reverted_at,
              sort_order
            ) VALUES (
              $id,
              $runId,
              $sessionId,
              $toolUseId,
              $toolName,
              $filePath,
              $transport,
              $connectionId,
              $op,
              $status,
              $beforeJson,
              $afterJson,
              $createdAt,
              $revertedAt,
              $sortOrder
            )
            """,
            new DbSql.SqlParam("$id", change.Id),
            new DbSql.SqlParam("$runId", runId),
            new DbSql.SqlParam("$sessionId", change.SessionId ?? sessionId),
            new DbSql.SqlParam("$toolUseId", change.ToolUseId),
            new DbSql.SqlParam("$toolName", change.ToolName),
            new DbSql.SqlParam("$filePath", change.FilePath),
            new DbSql.SqlParam("$transport", NormalizeTransport(change.Transport)),
            new DbSql.SqlParam("$connectionId", change.ConnectionId),
            new DbSql.SqlParam("$op", NormalizeOp(change.Op)),
            new DbSql.SqlParam("$status", NormalizeStatus(change.Status)),
            new DbSql.SqlParam("$beforeJson", SerializeSnapshot(change.Before)),
            new DbSql.SqlParam("$afterJson", SerializeSnapshot(change.After)),
            new DbSql.SqlParam("$createdAt", change.CreatedAt == 0 ? now : change.CreatedAt),
            new DbSql.SqlParam("$revertedAt", change.RevertedAt),
            new DbSql.SqlParam("$sortOrder", nextSort));
    }

    internal static List<StoredRunChangeSet> LoadChangeSetsBySession(
        SqliteConnection connection,
        string sessionId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT DISTINCT s.run_id
              FROM agent_change_sets s
              LEFT JOIN agent_file_changes c ON c.run_id = s.run_id
             WHERE s.session_id = $sessionId OR c.session_id = $sessionId
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        var runIds = new List<string>();
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                runIds.Add(reader.GetString(0));
            }
        }

        return LoadChangeSetsByRunIds(connection, runIds);
    }

    internal static List<StoredRunChangeSet> LoadChangeSetsByRunIds(
        SqliteConnection connection,
        IEnumerable<string> runIds)
    {
        var ids = runIds.Where(static id => !string.IsNullOrWhiteSpace(id)).Distinct().ToArray();
        if (ids.Length == 0)
        {
            return new List<StoredRunChangeSet>();
        }

        var inClause = AddInParameters(ids, "$run", out var parameters);
        using var setCommand = connection.CreateCommand();
        setCommand.CommandText = $"SELECT {ChangeSetSelectColumns} FROM agent_change_sets WHERE run_id IN ({inClause})";
        foreach (var parameter in parameters)
        {
            setCommand.Parameters.AddWithValue(parameter.Name, parameter.Value);
        }

        var setRows = ReadChangeSetRows(setCommand);
        if (setRows.Count == 0)
        {
            return new List<StoredRunChangeSet>();
        }

        using var changeCommand = connection.CreateCommand();
        changeCommand.CommandText = $"""
            SELECT {FileChangeSelectColumns}
              FROM agent_file_changes
             WHERE run_id IN ({inClause})
             ORDER BY run_id ASC, sort_order ASC, created_at ASC
            """;
        foreach (var parameter in parameters)
        {
            changeCommand.Parameters.AddWithValue(parameter.Name, parameter.Value);
        }

        var changesByRunId = new Dictionary<string, List<FileChangeRow>>();
        foreach (var change in ReadFileChangeRows(changeCommand))
        {
            if (!changesByRunId.TryGetValue(change.RunId, out var rows))
            {
                rows = new List<FileChangeRow>();
                changesByRunId[change.RunId] = rows;
            }
            rows.Add(change);
        }

        return setRows
            .Select(row => MapChangeSet(row, changesByRunId.TryGetValue(row.RunId, out var rows) ? rows : []))
            .OrderBy(row => row.CreatedAt)
            .ToList();
    }

    private static List<ChangeSetRow> ReadChangeSetRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<ChangeSetRow>();
        while (reader.Read())
        {
            rows.Add(new ChangeSetRow(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.GetString(2),
                NormalizeStatus(reader.GetString(3)),
                reader.GetInt64(4),
                reader.GetInt64(5)));
        }

        return rows;
    }

    private static List<FileChangeRow> ReadFileChangeRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<FileChangeRow>();
        while (reader.Read())
        {
            rows.Add(new FileChangeRow(
                reader.GetString(0),
                reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5),
                reader.GetString(6),
                reader.IsDBNull(7) ? null : reader.GetString(7),
                reader.GetString(8),
                NormalizeStatus(reader.GetString(9)),
                reader.GetString(10),
                reader.GetString(11),
                reader.GetInt64(12),
                reader.IsDBNull(13) ? null : reader.GetInt64(13),
                reader.GetInt32(14)));
        }

        return rows;
    }

    private static StoredRunChangeSet MapChangeSet(ChangeSetRow setRow, List<FileChangeRow> changeRows)
    {
        return new StoredRunChangeSet
        {
            RunId = setRow.RunId,
            SessionId = setRow.SessionId,
            AssistantMessageId = setRow.AssistantMessageId,
            Status = setRow.Status,
            Changes = changeRows.Select(MapChange).ToList(),
            CreatedAt = setRow.CreatedAt,
            UpdatedAt = setRow.UpdatedAt
        };
    }

    private static StoredTrackedFileChange MapChange(FileChangeRow row)
    {
        return new StoredTrackedFileChange
        {
            Id = row.Id,
            RunId = row.RunId,
            SessionId = row.SessionId,
            ToolUseId = row.ToolUseId,
            ToolName = row.ToolName,
            FilePath = row.FilePath,
            Transport = row.Transport,
            ConnectionId = row.ConnectionId,
            Op = row.Op,
            Status = row.Status,
            Before = ParseSnapshot(row.BeforeJson),
            After = ParseSnapshot(row.AfterJson),
            CreatedAt = row.CreatedAt,
            RevertedAt = row.RevertedAt
        };
    }

    private static StoredFileSnapshot ParseSnapshot(string value)
    {
        using var document = JsonDocument.Parse(value);
        var root = document.RootElement;
        return new StoredFileSnapshot
        {
            Exists = GetBool(root, "exists"),
            Text = JsonHelpers.GetString(root, "text"),
            FullText = JsonHelpers.GetString(root, "fullText"),
            PreviewText = JsonHelpers.GetString(root, "previewText"),
            TailPreviewText = JsonHelpers.GetString(root, "tailPreviewText"),
            TextOmitted = GetBoolNullable(root, "textOmitted"),
            Hash = JsonHelpers.GetString(root, "hash"),
            Size = JsonHelpers.GetLong(root, "size", 0),
            LineCount = JsonHelpers.GetIntNullable(root, "lineCount")
        };
    }

    private static string SerializeSnapshot(StoredFileSnapshot snapshot)
    {
        return JsonSerializer.Serialize(snapshot, WorkerJsonContext.Default.StoredFileSnapshot);
    }

    private static int ReadNextSortOrder(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string runId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT COALESCE(MAX(sort_order), -1) + 1
              FROM agent_file_changes
             WHERE run_id = $runId
            """;
        command.Parameters.AddWithValue("$runId", runId);
        return Convert.ToInt32(command.ExecuteScalar());
    }

    private static int RecomputeRunStatus(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string runId,
        long now)
    {
        using var countsCommand = connection.CreateCommand();
        countsCommand.Transaction = transaction;
        countsCommand.CommandText = """
            SELECT
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
              COUNT(*) AS total
            FROM agent_file_changes
            WHERE run_id = $runId
            """;
        countsCommand.Parameters.AddWithValue("$runId", runId);
        long total = 0;
        long openCount = 0;
        using (var reader = countsCommand.ExecuteReader())
        {
            if (reader.Read())
            {
                openCount = reader.IsDBNull(0) ? 0 : reader.GetInt64(0);
                total = reader.GetInt64(1);
            }
        }

        var status = total > 0 && openCount == 0 ? "reverted" : "open";
        return DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            UPDATE agent_change_sets
               SET status = $status,
                   updated_at = $updatedAt
             WHERE run_id = $runId
            """,
            new DbSql.SqlParam("$status", status),
            new DbSql.SqlParam("$updatedAt", now),
            new DbSql.SqlParam("$runId", runId));
    }

    private static string AddInParameters(
        IReadOnlyList<string> values,
        string prefix,
        out List<DbSql.SqlParam> parameters)
    {
        parameters = new List<DbSql.SqlParam>(values.Count);
        var names = new List<string>(values.Count);
        for (var i = 0; i < values.Count; i++)
        {
            var name = $"{prefix}{i}";
            names.Add(name);
            parameters.Add(new DbSql.SqlParam(name, values[i]));
        }

        return string.Join(", ", names);
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new AgentChangeMutationResult(true, changed, null),
            WorkerJsonContext.Default.AgentChangeMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new AgentChangeMutationResult(false, 0, error),
            WorkerJsonContext.Default.AgentChangeMutationResult);
    }

    private static JsonElement RequireObject(JsonElement parameters, string name)
    {
        if (parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object)
        {
            return value;
        }

        throw new InvalidOperationException($"Missing required agent change object: {name}");
    }

    private static string RequireRawObject(JsonElement parameters, string name)
    {
        if (parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object)
        {
            return value.GetRawText();
        }

        throw new InvalidOperationException($"Missing required agent change snapshot: {name}");
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required agent change field: {name}");
    }

    private static string? GetOptionalString(JsonElement parameters, string name)
    {
        return parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static bool GetBool(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.True;
    }

    private static bool? GetBoolNullable(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var property))
        {
            return null;
        }

        return property.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static string NormalizeStatus(string? status)
    {
        return status == "reverted" ? "reverted" : "open";
    }

    private static string NormalizeTransport(string? transport)
    {
        return transport == "ssh" ? "ssh" : "local";
    }

    private static string NormalizeOp(string? op)
    {
        return op == "create" ? "create" : "modify";
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private sealed record ChangeSetRow(
        string RunId,
        string? SessionId,
        string AssistantMessageId,
        string Status,
        long CreatedAt,
        long UpdatedAt);

    private sealed record FileChangeRow(
        string Id,
        string RunId,
        string? SessionId,
        string? ToolUseId,
        string? ToolName,
        string FilePath,
        string Transport,
        string? ConnectionId,
        string Op,
        string Status,
        string BeforeJson,
        string AfterJson,
        long CreatedAt,
        long? RevertedAt,
        int SortOrder);
}
