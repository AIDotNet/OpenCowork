using System.Buffers;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbMessageTools
{
    private static readonly IReadOnlyDictionary<string, int> RoleOrder = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        ["user"] = 0,
        ["assistant"] = 1,
        ["system"] = 2
    };

    public static WorkerResponse List(JsonElement parameters)
    {
        return ReadRows(parameters, role: null, paged: false);
    }

    public static WorkerResponse ListUser(JsonElement parameters)
    {
        return ReadRows(parameters, role: "user", paged: false);
    }

    public static WorkerResponse ListPage(JsonElement parameters)
    {
        return ReadRows(parameters, role: null, paged: true);
    }

    public static WorkerResponse SearchContent(JsonElement parameters)
    {
        try
        {
            var query = (JsonHelpers.GetString(parameters, "query") ?? string.Empty).Trim();
            if (query.Length == 0)
            {
                return WorkerResponse.Json(
                    new List<MessageContentMatch>(),
                    WorkerJsonContext.Default.ListMessageContentMatch);
            }

            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 50), 1, 200);
            var escaped = EscapeLike(query);

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT m.session_id AS session_id, m.content AS snippet
                  FROM messages m
                  JOIN (
                    SELECT session_id, MIN(sort_order) AS so
                      FROM messages
                     WHERE content LIKE $like ESCAPE '\'
                     GROUP BY session_id
                  ) f ON f.session_id = m.session_id AND f.so = m.sort_order
                 LIMIT $limit
                """;
            command.Parameters.AddWithValue("$like", $"%{escaped}%");
            command.Parameters.AddWithValue("$limit", limit);

            var rows = new List<MessageContentMatch>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(new MessageContentMatch(reader.GetString(0), reader.GetString(1)));
            }

            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListMessageContentMatch);
        }
        catch
        {
            return WorkerResponse.Json(
                new List<MessageContentMatch>(),
                WorkerJsonContext.Default.ListMessageContentMatch);
        }
    }

    public static WorkerResponse Add(JsonElement parameters)
    {
        try
        {
            var message = ReadMessageInput(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = InsertMessage(connection, transaction, message, "INSERT OR IGNORE");
            if (changed > 0)
            {
                IncrementMessageCount(connection, transaction, message.SessionId, changed);
            }
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse AddBatch(JsonElement parameters)
    {
        try
        {
            if (!parameters.TryGetProperty("messages", out var messagesElement) ||
                messagesElement.ValueKind != JsonValueKind.Array)
            {
                return Mutation(0);
            }

            var messages = messagesElement
                .EnumerateArray()
                .Select(message => ReadMessageInput(message))
                .ToList();
            if (messages.Count == 0)
            {
                return Mutation(0);
            }

            var changedBySession = new Dictionary<string, int>(StringComparer.Ordinal);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            foreach (var message in messages)
            {
                var changed = InsertMessage(connection, transaction, message, "INSERT OR IGNORE");
                if (changed > 0)
                {
                    changedBySession[message.SessionId] =
                        changedBySession.GetValueOrDefault(message.SessionId) + changed;
                }
            }
            foreach (var item in changedBySession)
            {
                IncrementMessageCount(connection, transaction, item.Key, item.Value);
            }
            transaction.Commit();

            return Mutation(changedBySession.Values.Sum());
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Upsert(JsonElement parameters)
    {
        try
        {
            var message = ReadMessageInput(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var exists = MessageExists(connection, transaction, message.Id);
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = """
                    INSERT INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
                    VALUES ($id, $sessionId, $role, $content, $meta, $createdAt, $usage, $sortOrder)
                    ON CONFLICT(id) DO UPDATE SET
                      session_id = excluded.session_id,
                      role = excluded.role,
                      content = excluded.content,
                      meta = excluded.meta,
                      usage = excluded.usage
                    """;
                AddMessageParameters(command, message);
                command.ExecuteNonQuery();
            }
            if (!exists)
            {
                IncrementMessageCount(connection, transaction, message.SessionId, 1);
            }
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
            var values = new List<SqlParam>();
            AddPatchValue(patch, sets, values, "content", "content");
            AddPatchValue(patch, sets, values, "meta", "meta");
            AddPatchValue(patch, sets, values, "usage", "usage");
            if (sets.Count == 0)
            {
                return Mutation(0);
            }

            values.Add(new("$id", id));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"UPDATE messages SET {string.Join(", ", sets)} WHERE id = $id";
            foreach (var value in values)
            {
                command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
            }
            return Mutation(command.ExecuteNonQuery());
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
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId",
                new SqlParam("$sessionId", sessionId));
            SetMessageCount(connection, transaction, sessionId, 0);
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
            var sessionId = RequireString(parameters, "sessionId");
            var messageId = RequireString(parameters, "messageId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId AND id = $messageId",
                new("$sessionId", sessionId),
                new("$messageId", messageId));
            if (changed > 0)
            {
                IncrementMessageCount(connection, transaction, sessionId, -changed);
            }
            transaction.Commit();
            return WorkerResponse.Json(
                new MessageDeleteResult(true, changed > 0, null),
                WorkerJsonContext.Default.MessageDeleteResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageDeleteResult(false, false, ex.Message),
                WorkerJsonContext.Default.MessageDeleteResult);
        }
    }

    public static WorkerResponse Replace(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            if (!parameters.TryGetProperty("messages", out var messagesElement) ||
                messagesElement.ValueKind != JsonValueKind.Array)
            {
                return Mutation(0);
            }

            var messages = messagesElement
                .EnumerateArray()
                .Select(message => ReadMessageInput(message, sessionId))
                .ToList();

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId",
                new SqlParam("$sessionId", sessionId));
            foreach (var message in messages)
            {
                InsertMessage(connection, transaction, message, "INSERT OR REPLACE");
            }
            SetMessageCount(connection, transaction, sessionId, messages.Count);
            transaction.Commit();
            return Mutation(messages.Count);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse TruncateFrom(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var fromSortOrder = JsonHelpers.GetInt(parameters, "fromSortOrder", 0);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var removed = CountRows(
                connection,
                transaction,
                "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId AND sort_order >= $fromSortOrder",
                new("$sessionId", sessionId),
                new("$fromSortOrder", fromSortOrder));
            ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId AND sort_order >= $fromSortOrder",
                new("$sessionId", sessionId),
                new("$fromSortOrder", fromSortOrder));
            if (removed > 0)
            {
                IncrementMessageCount(connection, transaction, sessionId, -removed);
            }
            transaction.Commit();
            return Mutation(removed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Count(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT message_count AS cnt FROM sessions WHERE id = $sessionId";
            command.Parameters.AddWithValue("$sessionId", sessionId);
            var value = command.ExecuteScalar();
            var count = value is null || value == DBNull.Value ? 0 : Convert.ToInt32(value);
            return WorkerResponse.Json(
                new MessageCountResult(true, count, null),
                WorkerJsonContext.Default.MessageCountResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageCountResult(false, 0, ex.Message),
                WorkerJsonContext.Default.MessageCountResult);
        }
    }

    public static WorkerResponse DeleteLast(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var role = RequireString(parameters, "role");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var row = QueryOne(
                connection,
                transaction,
                """
                SELECT id, session_id, role, content, meta, created_at, usage, sort_order
                  FROM messages
                 WHERE session_id = $sessionId AND role = $role
                 ORDER BY sort_order DESC
                 LIMIT 1
                """,
                new("$sessionId", sessionId),
                new("$role", role));
            if (row is not null)
            {
                ExecuteNonQuery(
                    connection,
                    transaction,
                    "DELETE FROM messages WHERE id = $id",
                    new SqlParam("$id", row.Id));
                IncrementMessageCount(connection, transaction, sessionId, -1);
            }
            transaction.Commit();
            return WorkerResponse.Json(
                new MessageDeleteLastResult(true, row, null),
                WorkerJsonContext.Default.MessageDeleteLastResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageDeleteLastResult(false, null, ex.Message),
                WorkerJsonContext.Default.MessageDeleteLastResult);
        }
    }

    public static WorkerResponse CompactSession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var messages = LoadMessageContents(connection, sessionId);

            if (messages.Count < 6)
            {
                return WorkerResponse.Json(
                    new MessageCompactResult(true, messages.Count, 0, null),
                    WorkerJsonContext.Default.MessageCompactResult);
            }

            var cutoff = messages.Count - 6;
            var compacted = 0;
            using var transaction = connection.BeginTransaction();
            for (var index = 0; index < cutoff; index++)
            {
                var row = messages[index];
                var compactedContent = TryCompactMessageContent(row.Content);
                if (compactedContent is null)
                {
                    continue;
                }

                ExecuteNonQuery(
                    connection,
                    transaction,
                    "UPDATE messages SET content = $content WHERE id = $id",
                    new SqlParam("$content", compactedContent),
                    new SqlParam("$id", row.Id));
                compacted++;
            }
            transaction.Commit();

            return WorkerResponse.Json(
                new MessageCompactResult(true, messages.Count, compacted, null),
                WorkerJsonContext.Default.MessageCompactResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageCompactResult(false, 0, 0, ex.Message),
                WorkerJsonContext.Default.MessageCompactResult);
        }
    }

    public static WorkerResponse UsageStats(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT usage, created_at
                  FROM messages
                 WHERE session_id = $sessionId
                   AND role = 'assistant'
                   AND usage IS NOT NULL
                 ORDER BY created_at ASC
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);

            var stats = new UsageStatsAccumulator();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var usage = reader.IsDBNull(0) ? null : reader.GetString(0);
                if (string.IsNullOrWhiteSpace(usage))
                {
                    continue;
                }

                if (TryAddUsage(stats, usage))
                {
                    var createdAt = reader.GetInt64(1);
                    stats.AssistantReplies++;
                    stats.FirstCreatedAt ??= createdAt;
                    stats.LastCreatedAt = createdAt;
                }
            }

            return WorkerResponse.Json(
                new MessageUsageStatsResult(
                    true,
                    stats.AssistantReplies > 0,
                    stats.TotalInput,
                    stats.TotalOutput,
                    stats.TotalCacheCreation,
                    stats.TotalCacheRead,
                    stats.TotalReasoning,
                    stats.TotalDurationMs,
                    stats.RequestCount,
                    stats.AssistantReplies,
                    stats.FirstCreatedAt,
                    stats.LastCreatedAt,
                    null),
                WorkerJsonContext.Default.MessageUsageStatsResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageUsageStatsResult(false, false, 0, 0, 0, 0, 0, 0, 0, 0, null, null, ex.Message),
                WorkerJsonContext.Default.MessageUsageStatsResult);
        }
    }

    private static WorkerResponse ReadRows(JsonElement parameters, string? role, bool paged)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            NormalizeSessionMessageSortOrders(connection, sessionId);

            using var command = connection.CreateCommand();
            var roleClause = role is null ? string.Empty : " AND role = $role";
            var pageClause = paged ? " LIMIT $limit OFFSET $offset" : string.Empty;
            command.CommandText =
                $"""
                 SELECT id, session_id, role, content, meta, created_at, usage, sort_order
                   FROM messages
                  WHERE session_id = $sessionId{roleClause}
                  ORDER BY sort_order ASC, created_at ASC{pageClause}
                 """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            if (role is not null)
            {
                command.Parameters.AddWithValue("$role", role);
            }
            if (paged)
            {
                command.Parameters.AddWithValue("$limit", Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 100), 1, 5000));
                command.Parameters.AddWithValue("$offset", Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0)));
            }

            var rows = new List<MessageRow>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadMessageRow(reader));
            }

            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListMessageRow);
        }
        catch (Exception)
        {
            return WorkerResponse.Json(new List<MessageRow>(), WorkerJsonContext.Default.ListMessageRow);
        }
    }

    private static List<MessageContentRow> LoadMessageContents(SqliteConnection connection, string sessionId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, content
              FROM messages
             WHERE session_id = $sessionId
             ORDER BY created_at ASC
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);

        var rows = new List<MessageContentRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(new MessageContentRow(reader.GetString(0), reader.GetString(1)));
        }

        return rows;
    }

    private static string? TryCompactMessageContent(string content)
    {
        try
        {
            using var document = JsonDocument.Parse(content);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var changed = false;
            var buffer = new ArrayBufferWriter<byte>();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartArray();
                foreach (var block in document.RootElement.EnumerateArray())
                {
                    WriteCompactedBlock(writer, block, ref changed);
                }
                writer.WriteEndArray();
            }

            return changed ? Encoding.UTF8.GetString(buffer.WrittenSpan) : null;
        }
        catch
        {
            return null;
        }
    }

    private static void WriteCompactedBlock(
        Utf8JsonWriter writer,
        JsonElement block,
        ref bool changed)
    {
        if (block.ValueKind != JsonValueKind.Object)
        {
            block.WriteTo(writer);
            return;
        }

        var type = block.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
            ? typeElement.GetString()
            : null;
        var replaceToolResultContent =
            type == "tool_result" &&
            block.TryGetProperty("content", out var contentElement) &&
            GetJsonTextLength(contentElement) > 200;
        var replaceThinking = type == "thinking";

        if (replaceToolResultContent || replaceThinking)
        {
            changed = true;
        }

        writer.WriteStartObject();
        foreach (var property in block.EnumerateObject())
        {
            if (replaceToolResultContent && property.NameEquals("content"))
            {
                continue;
            }
            if (replaceThinking && property.NameEquals("thinking"))
            {
                continue;
            }

            property.WriteTo(writer);
        }

        if (replaceToolResultContent)
        {
            writer.WriteString("content", "[Context compressed \u2014 stale tool result cleared]");
        }
        if (replaceThinking)
        {
            writer.WriteString("thinking", "[Thinking cleared during compression]");
        }
        writer.WriteEndObject();
    }

    private static int GetJsonTextLength(JsonElement element)
    {
        return element.ValueKind == JsonValueKind.String
            ? element.GetString()?.Length ?? 0
            : element.GetRawText().Length;
    }

    private static bool TryAddUsage(UsageStatsAccumulator stats, string usageJson)
    {
        try
        {
            using var document = JsonDocument.Parse(usageJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var inputTokens = GetDouble(root, "inputTokens");
            var cacheReadTokens = GetDouble(root, "cacheReadTokens");
            var cacheCreationTokens = GetDouble(root, "cacheCreationTokens");
            var billableInputTokens = GetDoubleNullable(root, "billableInputTokens");

            stats.TotalInput += billableInputTokens ??
                Math.Max(0, inputTokens - Math.Max(0, cacheReadTokens) - Math.Max(0, cacheCreationTokens));
            stats.TotalOutput += GetDouble(root, "outputTokens");
            stats.TotalCacheCreation += cacheCreationTokens;
            stats.TotalCacheRead += cacheReadTokens;
            stats.TotalReasoning += GetDouble(root, "reasoningTokens");
            stats.TotalDurationMs += GetDouble(root, "totalDurationMs");
            stats.RequestCount += GetRequestTimingCount(root);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static int GetRequestTimingCount(JsonElement root)
    {
        if (root.TryGetProperty("requestTimings", out var requestTimings) &&
            requestTimings.ValueKind == JsonValueKind.Array)
        {
            return requestTimings.GetArrayLength();
        }

        return 1;
    }

    private static double GetDouble(JsonElement element, string propertyName)
    {
        return GetDoubleNullable(element, propertyName) ?? 0;
    }

    private static double? GetDoubleNullable(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property))
        {
            return null;
        }
        if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out var value))
        {
            return value;
        }
        if (property.ValueKind == JsonValueKind.String && double.TryParse(property.GetString(), out value))
        {
            return value;
        }

        return null;
    }

    private static void NormalizeSessionMessageSortOrders(SqliteConnection connection, string sessionId)
    {
        var rows = new List<MessageOrderRow>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT id, role, created_at, sort_order
                  FROM messages
                 WHERE session_id = $sessionId
                 ORDER BY sort_order ASC, created_at ASC
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(new MessageOrderRow(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetInt64(2),
                    reader.GetInt32(3)));
            }
        }

        if (!HasSortOrderAnomaly(rows))
        {
            return;
        }

        var ordered = rows
            .OrderBy(row => row.CreatedAt)
            .ThenBy(row => RoleOrder.GetValueOrDefault(row.Role, 10))
            .ThenBy(row => row.SortOrder)
            .ToList();

        using var transaction = connection.BeginTransaction();
        using var update = connection.CreateCommand();
        update.Transaction = transaction;
        update.CommandText = "UPDATE messages SET sort_order = $sortOrder WHERE id = $id";
        var sortOrderParameter = update.Parameters.Add("$sortOrder", SqliteType.Integer);
        var idParameter = update.Parameters.Add("$id", SqliteType.Text);
        for (var index = 0; index < ordered.Count; index++)
        {
            var row = ordered[index];
            if (row.SortOrder == index)
            {
                continue;
            }
            sortOrderParameter.Value = index;
            idParameter.Value = row.Id;
            update.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    private static bool HasSortOrderAnomaly(IReadOnlyList<MessageOrderRow> rows)
    {
        if (rows.Count == 0)
        {
            return false;
        }

        var seen = new HashSet<int>();
        for (var index = 0; index < rows.Count; index++)
        {
            var sortOrder = rows[index].SortOrder;
            if (sortOrder != index || !seen.Add(sortOrder))
            {
                return true;
            }
        }

        return false;
    }

    private static int InsertMessage(
        SqliteConnection connection,
        SqliteTransaction transaction,
        MessageInput message,
        string insertMode)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            $"""
             {insertMode} INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
             VALUES ($id, $sessionId, $role, $content, $meta, $createdAt, $usage, $sortOrder)
             """;
        AddMessageParameters(command, message);
        return command.ExecuteNonQuery();
    }

    private static bool MessageExists(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string id)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT 1 FROM messages WHERE id = $id LIMIT 1";
        command.Parameters.AddWithValue("$id", id);
        return command.ExecuteScalar() is not null;
    }

    private static void AddMessageParameters(SqliteCommand command, MessageInput message)
    {
        command.Parameters.AddWithValue("$id", message.Id);
        command.Parameters.AddWithValue("$sessionId", message.SessionId);
        command.Parameters.AddWithValue("$role", message.Role);
        command.Parameters.AddWithValue("$content", message.Content);
        command.Parameters.AddWithValue("$meta", message.Meta is null ? DBNull.Value : message.Meta);
        command.Parameters.AddWithValue("$createdAt", message.CreatedAt);
        command.Parameters.AddWithValue("$usage", message.Usage is null ? DBNull.Value : message.Usage);
        command.Parameters.AddWithValue("$sortOrder", message.SortOrder);
    }

    private static MessageInput ReadMessageInput(JsonElement element, string? sessionIdOverride = null)
    {
        return new MessageInput(
            RequireString(element, "id"),
            sessionIdOverride ?? RequireString(element, "sessionId"),
            RequireString(element, "role"),
            JsonHelpers.GetString(element, "content") ?? string.Empty,
            JsonHelpers.GetString(element, "meta"),
            JsonHelpers.GetLong(element, "createdAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            JsonHelpers.GetString(element, "usage"),
            JsonHelpers.GetInt(element, "sortOrder", 0));
    }

    private static MessageRow ReadMessageRow(SqliteDataReader reader)
    {
        return new MessageRow
        {
            Id = reader.GetString(0),
            SessionId = reader.GetString(1),
            Role = reader.GetString(2),
            Content = reader.GetString(3),
            Meta = reader.IsDBNull(4) ? null : reader.GetString(4),
            CreatedAt = reader.GetInt64(5),
            Usage = reader.IsDBNull(6) ? null : reader.GetString(6),
            SortOrder = reader.GetInt32(7)
        };
    }

    private static MessageRow? QueryOne(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sql,
        params SqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }

        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadMessageRow(reader) : null;
    }

    private static void IncrementMessageCount(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        int delta)
    {
        ExecuteNonQuery(
            connection,
            transaction,
            "UPDATE sessions SET message_count = MAX(COALESCE(message_count, 0) + $delta, 0) WHERE id = $sessionId",
            new("$delta", delta),
            new("$sessionId", sessionId));
    }

    private static void SetMessageCount(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        int count)
    {
        ExecuteNonQuery(
            connection,
            transaction,
            "UPDATE sessions SET message_count = $count WHERE id = $sessionId",
            new("$count", count),
            new("$sessionId", sessionId));
    }

    private static int ExecuteNonQuery(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string commandText,
        params SqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = commandText;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }
        return command.ExecuteNonQuery();
    }

    private static int CountRows(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string commandText,
        params SqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = commandText;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }
        return Convert.ToInt32(command.ExecuteScalar() ?? 0);
    }

    private static void AddPatchValue(
        JsonElement patch,
        List<string> sets,
        List<SqlParam> values,
        string propertyName,
        string columnName)
    {
        if (!patch.TryGetProperty(propertyName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${propertyName}");
        values.Add(new($"${propertyName}", value.ValueKind == JsonValueKind.Null ? null : value.GetString()));
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new MessageMutationResult(true, changed, null),
            WorkerJsonContext.Default.MessageMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new MessageMutationResult(false, 0, error),
            WorkerJsonContext.Default.MessageMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required message field: {name}");
    }

    private static string EscapeLike(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);
    }

    private sealed record MessageOrderRow(string Id, string Role, long CreatedAt, int SortOrder);

    private sealed record MessageContentRow(string Id, string Content);

    private sealed class UsageStatsAccumulator
    {
        public double TotalInput { get; set; }
        public double TotalOutput { get; set; }
        public double TotalCacheCreation { get; set; }
        public double TotalCacheRead { get; set; }
        public double TotalReasoning { get; set; }
        public double TotalDurationMs { get; set; }
        public int RequestCount { get; set; }
        public int AssistantReplies { get; set; }
        public long? FirstCreatedAt { get; set; }
        public long? LastCreatedAt { get; set; }
    }

    private sealed record SqlParam(string Name, object? Value);
}
