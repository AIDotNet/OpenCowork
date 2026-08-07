using System.Buffers;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbMessageTools
{
    private const int DefaultRequestContextHeadLimit = 12;
    // Locator rails only need a short preview. Keeping this bounded prevents a
    // large history scan from becoming another full-content IPC transfer.
    private const int LocatorTextCharLimit = 1200;
    private const string LocatorTruncatedSuffix = "\n[...truncated for locator]";

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

    public static WorkerResponse ListLocator(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);

            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id, session_id, role,
                       CASE
                         WHEN length(CAST(content AS BLOB)) <= $previewChars
                         THEN content
                         ELSE substr(content, 1, $previewChars)
                       END AS content,
                       meta, created_at, sort_order
                  FROM messages
                 WHERE session_id = $sessionId
                 ORDER BY sort_order ASC, created_at ASC
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$previewChars", LocatorTextCharLimit * 8);

            var rows = new List<MessageLocatorRow>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadMessageLocatorRow(reader));
            }

            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListMessageLocatorRow);
        }
        catch
        {
            return WorkerResponse.Json(new List<MessageLocatorRow>(), WorkerJsonContext.Default.ListMessageLocatorRow);
        }
    }

    public static WorkerResponse ListPage(JsonElement parameters)
    {
        return ReadRows(parameters, role: null, paged: true);
    }

    public static WorkerResponse WindowIndex(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var direction = (JsonHelpers.GetString(parameters, "direction") ?? "tail").Trim().ToLowerInvariant();
            var byteBudget = Math.Clamp(
                JsonHelpers.GetInt(parameters, "byteBudget", 256 * 1024),
                1,
                8 * 1024 * 1024);
            var maxRows = Math.Clamp(JsonHelpers.GetInt(parameters, "maxRows", 30), 1, 240);
            var anchorSortOrder = JsonHelpers.GetInt(parameters, "anchorSortOrder", -1);

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var total = GetSessionMessageCount(connection, sessionId);
            if (total <= 0)
            {
                return WorkerResponse.Json(
                    new MessageWindowIndexResult(true, new List<MessageIndexRow>(), 0, 0, 0, false, false, 0, null),
                    WorkerJsonContext.Default.MessageWindowIndexResult);
            }

            var rows = ReadMessageIndexRows(connection, sessionId, direction, anchorSortOrder, maxRows);
            var selected = new List<MessageIndexRow>(rows.Count);
            var loadedBytes = 0;
            foreach (var row in rows)
            {
                if (selected.Count > 0 && loadedBytes >= byteBudget)
                {
                    break;
                }

                selected.Add(row);
                loadedBytes = Math.Min(int.MaxValue, loadedBytes + Math.Max(0, row.ContentBytes));
            }

            selected.Sort((left, right) =>
                left.SortOrder != right.SortOrder
                    ? left.SortOrder.CompareTo(right.SortOrder)
                    : left.CreatedAt.CompareTo(right.CreatedAt));

            var start = selected.Count == 0
                ? ResolveIndexStart(connection, sessionId, total, direction, anchorSortOrder)
                : ResolveIndexStart(connection, sessionId, total, direction, anchorSortOrder, selected.Count);
            var end = Math.Min(total, start + selected.Count);

            return WorkerResponse.Json(
                new MessageWindowIndexResult(
                    true,
                    selected,
                    start,
                    end,
                    total,
                    start > 0,
                    end < total,
                    loadedBytes,
                    null),
                WorkerJsonContext.Default.MessageWindowIndexResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageWindowIndexResult(false, new List<MessageIndexRow>(), 0, 0, 0, false, false, 0, ex.Message),
                WorkerJsonContext.Default.MessageWindowIndexResult);
        }
    }

    public static WorkerResponse Range(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var requestedStart = Math.Max(0, JsonHelpers.GetInt(parameters, "start", 0));
            var requestedEnd = Math.Max(requestedStart, JsonHelpers.GetInt(parameters, "end", requestedStart));
            var oversizedBytes = Math.Clamp(
                JsonHelpers.GetInt(parameters, "oversizedBytes", 512 * 1024),
                1,
                16 * 1024 * 1024);
            var includeLargeContent = JsonHelpers.GetBool(parameters, "includeLargeContent", false);

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var total = GetSessionMessageCount(connection, sessionId);
            var start = Math.Min(requestedStart, total);
            var end = Math.Min(Math.Max(start, requestedEnd), total);
            var rows = ReadMessageRangeRows(connection, sessionId, start, Math.Max(0, end - start), oversizedBytes, includeLargeContent);
            var loadedBytes = rows.Aggregate(0, (sum, row) => Math.Min(int.MaxValue, sum + Math.Max(0, row.ContentBytes)));

            return WorkerResponse.Json(
                new MessageRangeResult(true, rows, start, end, total, start > 0, end < total, loadedBytes, null),
                WorkerJsonContext.Default.MessageRangeResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageRangeResult(false, new List<MessageRangeRow>(), 0, 0, 0, false, false, 0, ex.Message),
                WorkerJsonContext.Default.MessageRangeResult);
        }
    }

    public static WorkerResponse Content(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var messageId = RequireString(parameters, "messageId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id, session_id, role, content, meta, created_at, usage, sort_order,
                       length(CAST(content AS BLOB)) AS content_bytes
                  FROM messages
                 WHERE session_id = $sessionId AND id = $messageId
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$messageId", messageId);
            using var reader = command.ExecuteReader();
            var row = reader.Read() ? ReadMessageRow(reader) : null;
            if (row is not null)
            {
                row.ContentBytes = reader.IsDBNull(8) ? 0 : Math.Max(0, reader.GetInt32(8));
            }
            return WorkerResponse.Json(
                new MessageContentResult(row is not null, row, row is null ? "Message not found" : null),
                WorkerJsonContext.Default.MessageContentResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageContentResult(false, null, ex.Message),
                WorkerJsonContext.Default.MessageContentResult);
        }
    }

    public static WorkerResponse RequestContext(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var maxMessages = Math.Clamp(JsonHelpers.GetInt(parameters, "maxMessages", 160), 1, 5000);
            var requestedHeadLimit = Math.Clamp(
                JsonHelpers.GetInt(parameters, "headLimit", DefaultRequestContextHeadLimit),
                0,
                maxMessages);

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);

            var total = GetSessionMessageCount(connection, sessionId);
            if (total <= 0)
            {
                return WorkerResponse.Json(new List<MessageRow>(), WorkerJsonContext.Default.ListMessageRow);
            }

            var headLimit = total > maxMessages
                ? Math.Min(requestedHeadLimit, Math.Max(0, maxMessages / 4))
                : 0;
            var tailLimit = Math.Min(Math.Max(1, maxMessages - headLimit), total);
            var tailOffset = Math.Max(0, total - tailLimit);
            var rows = new List<MessageRow>();

            if (headLimit > 0)
            {
                rows.AddRange(ReadRowsPage(connection, sessionId, headLimit, 0));
            }

            rows.AddRange(ReadCompactArtifactRows(connection, sessionId));
            rows.AddRange(ReadRowsPage(connection, sessionId, tailLimit, tailOffset));

            var deduped = rows
                .OrderBy(row => row.SortOrder)
                .ThenBy(row => row.CreatedAt)
                .GroupBy(row => row.Id, StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();

            return WorkerResponse.Json(deduped, WorkerJsonContext.Default.ListMessageRow);
        }
        catch
        {
            return WorkerResponse.Json(new List<MessageRow>(), WorkerJsonContext.Default.ListMessageRow);
        }
    }

    public static WorkerResponse WindowAround(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 30), 1, 5000);
            var requestedSortOrder = JsonHelpers.GetInt(parameters, "sortOrder", -1);
            var messageId = JsonHelpers.GetString(parameters, "messageId")?.Trim();

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);

            var total = GetSessionMessageCount(connection, sessionId);
            if (total <= 0)
            {
                return WorkerResponse.Json(
                    new MessageWindowResult(true, new List<MessageRow>(), 0, 0, 0, 0, null),
                    WorkerJsonContext.Default.MessageWindowResult);
            }

            var anchorSortOrder = ResolveAnchorSortOrder(
                connection,
                sessionId,
                messageId,
                requestedSortOrder,
                total);
            var start = Math.Clamp(anchorSortOrder - (limit / 2), 0, Math.Max(0, total - limit));
            var rows = ReadRowsPage(connection, sessionId, limit, start);
            var end = rows.Count == 0 ? start : start + rows.Count;

            return WorkerResponse.Json(
                new MessageWindowResult(true, rows, start, end, total, anchorSortOrder, null),
                WorkerJsonContext.Default.MessageWindowResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new MessageWindowResult(false, new List<MessageRow>(), 0, 0, 0, 0, ex.Message),
                WorkerJsonContext.Default.MessageWindowResult);
        }
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

    public static WorkerResponse InsertArtifacts(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            if (!parameters.TryGetProperty("messages", out var messagesElement) ||
                messagesElement.ValueKind != JsonValueKind.Array)
            {
                return InsertArtifactsResult(true, 0, 0, 0, 0, null);
            }

            var messages = messagesElement
                .EnumerateArray()
                .Where(message => message.ValueKind == JsonValueKind.Object)
                .Select(message => ReadMessageInput(message, sessionId))
                .Where(IsCompactArtifactInput)
                .ToList();

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DeleteExistingCompactArtifacts(connection, transaction, sessionId, messages);
            NormalizeSessionMessageSortOrders(connection, transaction, sessionId);

            var totalBeforeInsert = CountRows(
                connection,
                transaction,
                "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId",
                new SqlParam("$sessionId", sessionId));
            if (messages.Count == 0)
            {
                SetMessageCount(connection, transaction, sessionId, totalBeforeInsert);
                transaction.Commit();
                return InsertArtifactsResult(true, 0, 0, 0, totalBeforeInsert, null);
            }

            var insertSortOrder = ResolveInsertArtifactSortOrder(
                connection,
                transaction,
                sessionId,
                JsonHelpers.GetString(parameters, "insertBeforeMessageId")?.Trim(),
                JsonHelpers.GetInt(parameters, "insertSortOrder", totalBeforeInsert),
                totalBeforeInsert);

            ShiftSessionMessageSortOrders(
                connection,
                transaction,
                sessionId,
                insertSortOrder,
                messages.Count);

            var inserted = 0;
            for (var index = 0; index < messages.Count; index++)
            {
                var message = messages[index] with { SortOrder = insertSortOrder + index };
                inserted += InsertMessage(connection, transaction, message, "INSERT OR REPLACE");
            }

            var total = CountRows(
                connection,
                transaction,
                "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId",
                new SqlParam("$sessionId", sessionId));
            SetMessageCount(connection, transaction, sessionId, total);
            transaction.Commit();

            return InsertArtifactsResult(
                true,
                inserted,
                insertSortOrder,
                insertSortOrder + inserted,
                total,
                null);
        }
        catch (Exception ex)
        {
            return InsertArtifactsResult(false, 0, 0, 0, 0, ex.Message);
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
            return Mutation(1, inserted: !exists);
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

    private static int GetSessionMessageCount(SqliteConnection connection, string sessionId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        return Convert.ToInt32(command.ExecuteScalar() ?? 0);
    }

    private static int ResolveAnchorSortOrder(
        SqliteConnection connection,
        string sessionId,
        string? messageId,
        int requestedSortOrder,
        int total)
    {
        if (!string.IsNullOrWhiteSpace(messageId))
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT sort_order
                  FROM messages
                 WHERE session_id = $sessionId AND id = $messageId
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$messageId", messageId);
            var value = command.ExecuteScalar();
            if (value is not null && value != DBNull.Value)
            {
                return Math.Clamp(Convert.ToInt32(value), 0, Math.Max(0, total - 1));
            }
        }

        if (requestedSortOrder >= 0)
        {
            return Math.Clamp(requestedSortOrder, 0, Math.Max(0, total - 1));
        }

        return Math.Max(0, total - 1);
    }

    private static List<MessageRow> ReadRowsPage(
        SqliteConnection connection,
        string sessionId,
        int limit,
        int offset)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, session_id, role, content, meta, created_at, usage, sort_order
              FROM messages
             WHERE session_id = $sessionId
             ORDER BY sort_order ASC, created_at ASC
             LIMIT $limit OFFSET $offset
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);

        var rows = new List<MessageRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(ReadMessageRow(reader));
        }
        return rows;
    }

    private static List<MessageIndexRow> ReadMessageIndexRows(
        SqliteConnection connection,
        string sessionId,
        string direction,
        int anchorSortOrder,
        int maxRows)
    {
        using var command = connection.CreateCommand();
        var effectiveDirection = direction is "older" or "newer" ? direction : "tail";
        var predicate = effectiveDirection switch
        {
            "older" => " AND sort_order < $anchorSortOrder",
            "newer" => " AND sort_order >= $anchorSortOrder",
            _ => string.Empty
        };
        var order = effectiveDirection == "older" || effectiveDirection == "tail"
            ? "DESC"
            : "ASC";
        command.CommandText = $"""
            SELECT id, session_id, role, meta, created_at, sort_order,
                   length(CAST(content AS BLOB)) AS content_bytes
              FROM messages
             WHERE session_id = $sessionId{predicate}
             ORDER BY sort_order {order}, created_at {order}
             LIMIT $limit
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        if (effectiveDirection is "older" or "newer")
        {
            command.Parameters.AddWithValue("$anchorSortOrder", Math.Max(0, anchorSortOrder));
        }
        command.Parameters.AddWithValue("$limit", maxRows);

        var rows = new List<MessageIndexRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(new MessageIndexRow
            {
                Id = reader.GetString(0),
                SessionId = reader.GetString(1),
                Role = reader.GetString(2),
                Meta = reader.IsDBNull(3) ? null : reader.GetString(3),
                CreatedAt = reader.GetInt64(4),
                SortOrder = reader.GetInt32(5),
                ContentBytes = reader.IsDBNull(6) ? 0 : Math.Max(0, reader.GetInt32(6))
            });
        }
        return rows;
    }

    private static List<MessageRangeRow> ReadMessageRangeRows(
        SqliteConnection connection,
        string sessionId,
        int start,
        int limit,
        int oversizedBytes,
        bool includeLargeContent)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, session_id, role,
                   CASE
                     WHEN $includeLargeContent = 1
                       OR length(CAST(content AS BLOB)) <= $oversizedBytes
                     THEN content
                     ELSE substr(content, 1, $previewChars)
                   END AS content,
                   meta, created_at, usage, sort_order,
                   length(CAST(content AS BLOB)) AS content_bytes
              FROM messages
             WHERE session_id = $sessionId
             ORDER BY sort_order ASC, created_at ASC
             LIMIT $limit OFFSET $offset
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", start);
        command.Parameters.AddWithValue("$oversizedBytes", oversizedBytes);
        command.Parameters.AddWithValue("$includeLargeContent", includeLargeContent ? 1 : 0);
        command.Parameters.AddWithValue(
            "$previewChars",
            Math.Max(1024, Math.Min(16 * 1024, oversizedBytes / 2)));

        var rows = new List<MessageRangeRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var content = reader.GetString(3);
            var contentBytes = reader.IsDBNull(8) ? 0 : Math.Max(0, reader.GetInt32(8));
            var isOversized = !includeLargeContent && contentBytes > oversizedBytes;
            rows.Add(new MessageRangeRow
            {
                Id = reader.GetString(0),
                SessionId = reader.GetString(1),
                Role = reader.GetString(2),
                Content = isOversized ? null : content,
                Preview = isOversized ? BuildLocatorContent(content) : null,
                Meta = reader.IsDBNull(4) ? null : reader.GetString(4),
                CreatedAt = reader.GetInt64(5),
                Usage = reader.IsDBNull(6) ? null : reader.GetString(6),
                SortOrder = reader.GetInt32(7),
                ContentBytes = contentBytes,
                ContentState = isOversized ? "preview" : "full"
            });
        }
        return rows;
    }

    private static int ResolveIndexStart(
        SqliteConnection connection,
        string sessionId,
        int total,
        string direction,
        int anchorSortOrder,
        int selectedCount = 0)
    {
        if (direction == "tail") return Math.Max(0, total - selectedCount);

        using var command = connection.CreateCommand();
        command.CommandText = direction == "older"
            ? "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId AND sort_order < $anchorSortOrder"
            : "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId AND sort_order < $anchorSortOrder";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$anchorSortOrder", Math.Max(0, anchorSortOrder));
        var rowsBeforeAnchor = Convert.ToInt32(command.ExecuteScalar() ?? 0);
        return direction == "older"
            ? Math.Max(0, rowsBeforeAnchor - selectedCount)
            : Math.Clamp(rowsBeforeAnchor, 0, total);
    }

    private static List<MessageRow> ReadCompactArtifactRows(SqliteConnection connection, string sessionId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, session_id, role, content, meta, created_at, usage, sort_order
              FROM messages
             WHERE session_id = $sessionId
               AND (
                 meta LIKE '%compactBoundary%' OR
                 meta LIKE '%compactSummary%' OR
                 content LIKE '%[Context Memory Compressed Summary]%'
               )
             ORDER BY sort_order ASC, created_at ASC
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);

        var rows = new List<MessageRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(ReadMessageRow(reader));
        }
        return rows;
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

    private static void NormalizeSessionMessageSortOrders(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId)
    {
        var rows = new List<MessageOrderRow>();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                SELECT id, role, created_at, sort_order, meta
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
                    reader.GetInt32(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4)));
            }
        }

        if (!HasSortOrderAnomaly(rows))
        {
            return;
        }

        var ordered = rows
            .OrderBy(row => row.CreatedAt)
            .ThenBy(GetCompactArtifactOrderRank)
            .ThenBy(row => RoleOrder.GetValueOrDefault(row.Role, 10))
            .ThenBy(row => row.SortOrder)
            .ToList();

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
    }

    // Boundary must sort before its summary; both are written within the same
    // millisecond, so createdAt alone cannot order the pair.
    private static int GetCompactArtifactOrderRank(MessageOrderRow row)
    {
        if (row.Meta?.Contains("compactBoundary", StringComparison.Ordinal) == true)
        {
            return 0;
        }
        if (row.Meta?.Contains("compactSummary", StringComparison.Ordinal) == true)
        {
            return 1;
        }
        return 2;
    }

    private static bool HasSortOrderAnomaly(IReadOnlyList<MessageOrderRow> rows)    {
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

    private static void DeleteExistingCompactArtifacts(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        IReadOnlyList<MessageInput> incomingArtifacts)
    {
        ExecuteNonQuery(
            connection,
            transaction,
            """
            DELETE FROM messages
             WHERE session_id = $sessionId
               AND (
                 meta LIKE '%compactBoundary%' OR
                 meta LIKE '%compactSummary%' OR
                 content LIKE '%[Context Memory Compressed Summary]%'
               )
            """,
            new SqlParam("$sessionId", sessionId));

        foreach (var artifact in incomingArtifacts)
        {
            ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId AND id = $id",
                new("$sessionId", sessionId),
                new("$id", artifact.Id));
        }
    }

    private static int ResolveInsertArtifactSortOrder(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        string? insertBeforeMessageId,
        int requestedSortOrder,
        int total)
    {
        if (!string.IsNullOrWhiteSpace(insertBeforeMessageId))
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                SELECT sort_order
                  FROM messages
                 WHERE session_id = $sessionId AND id = $messageId
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$messageId", insertBeforeMessageId);
            var value = command.ExecuteScalar();
            if (value is not null && value != DBNull.Value)
            {
                return Math.Clamp(Convert.ToInt32(value), 0, total);
            }
        }

        if (requestedSortOrder < 0)
        {
            return total;
        }

        return Math.Clamp(requestedSortOrder, 0, total);
    }

    private static void ShiftSessionMessageSortOrders(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        int startSortOrder,
        int delta)
    {
        if (delta <= 0)
        {
            return;
        }

        ExecuteNonQuery(
            connection,
            transaction,
            """
            UPDATE messages
               SET sort_order = sort_order + $delta
             WHERE session_id = $sessionId AND sort_order >= $startSortOrder
            """,
            new("$delta", delta),
            new("$sessionId", sessionId),
            new("$startSortOrder", startSortOrder));
    }

    private static bool IsCompactArtifactInput(MessageInput message)
    {
        if (message.Meta?.Contains("compactBoundary", StringComparison.Ordinal) == true ||
            message.Meta?.Contains("compactSummary", StringComparison.Ordinal) == true)
        {
            return true;
        }

        return message.Content.Contains(
            "[Context Memory Compressed Summary]",
            StringComparison.Ordinal);
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

    private static string BuildLocatorContent(string content)
    {
        try
        {
            using var document = JsonDocument.Parse(content);
            var root = document.RootElement;
            var buffer = new ArrayBufferWriter<byte>();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                if (root.ValueKind == JsonValueKind.String)
                {
                    writer.WriteStringValue(TruncateLocatorText(root.GetString() ?? string.Empty));
                }
                else if (root.ValueKind == JsonValueKind.Array)
                {
                    writer.WriteStartArray();
                    foreach (var block in root.EnumerateArray())
                    {
                        WriteLocatorContentBlock(writer, block);
                    }
                    writer.WriteEndArray();
                }
                else
                {
                    root.WriteTo(writer);
                }
            }

            return Encoding.UTF8.GetString(buffer.WrittenSpan);
        }
        catch
        {
            return TruncateLocatorText(content);
        }
    }

    private static void WriteLocatorContentBlock(Utf8JsonWriter writer, JsonElement block)
    {
        if (block.ValueKind != JsonValueKind.Object)
        {
            block.WriteTo(writer);
            return;
        }

        var type = GetStringProperty(block, "type") ?? string.Empty;
        writer.WriteStartObject();
        writer.WriteString("type", type);

        switch (type)
        {
            case "text":
                writer.WriteString(
                    "text",
                    TruncateLocatorText(GetStringProperty(block, "text") ?? string.Empty));
                break;
            case "agent_error":
                WriteStringPropertyIfPresent(writer, block, "code");
                writer.WriteString(
                    "message",
                    TruncateLocatorText(GetStringProperty(block, "message") ?? string.Empty));
                break;
            case "tool_use":
                WriteStringPropertyIfPresent(writer, block, "id");
                WriteStringPropertyIfPresent(writer, block, "name");
                break;
            case "tool_result":
                WriteStringPropertyIfPresent(writer, block, "toolUseId");
                if (block.TryGetProperty("isError", out var isError) &&
                    isError.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    writer.WriteBoolean("isError", isError.GetBoolean());
                }
                writer.WriteString("content", "[Tool result omitted from locator]");
                break;
            case "image_error":
                WriteStringPropertyIfPresent(writer, block, "code");
                writer.WriteString(
                    "message",
                    TruncateLocatorText(GetStringProperty(block, "message") ?? string.Empty));
                break;
            default:
                break;
        }

        writer.WriteEndObject();
    }

    private static string TruncateLocatorText(string text)
    {
        if (text.Length <= LocatorTextCharLimit)
        {
            return text;
        }

        return string.Concat(
            text.AsSpan(0, Math.Max(0, LocatorTextCharLimit - LocatorTruncatedSuffix.Length)),
            LocatorTruncatedSuffix);
    }

    private static string? GetStringProperty(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }

    private static void WriteStringPropertyIfPresent(
        Utf8JsonWriter writer,
        JsonElement element,
        string propertyName)
    {
        var value = GetStringProperty(element, propertyName);
        if (!string.IsNullOrEmpty(value))
        {
            writer.WriteString(propertyName, value);
        }
    }

    private static MessageLocatorRow ReadMessageLocatorRow(SqliteDataReader reader)
    {
        return new MessageLocatorRow
        {
            Id = reader.GetString(0),
            SessionId = reader.GetString(1),
            Role = reader.GetString(2),
            Content = BuildLocatorContent(reader.GetString(3)),
            Meta = reader.IsDBNull(4) ? null : reader.GetString(4),
            CreatedAt = reader.GetInt64(5),
            SortOrder = reader.GetInt32(6)
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

    private static WorkerResponse Mutation(int changed, bool inserted = false)
    {
        return WorkerResponse.Json(
            new MessageMutationResult(true, changed, null, inserted),
            WorkerJsonContext.Default.MessageMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new MessageMutationResult(false, 0, error),
            WorkerJsonContext.Default.MessageMutationResult);
    }

    private static WorkerResponse InsertArtifactsResult(
        bool success,
        int inserted,
        int start,
        int end,
        int total,
        string? error)
    {
        return WorkerResponse.Json(
            new MessageInsertArtifactsResult(success, inserted, start, end, total, error),
            WorkerJsonContext.Default.MessageInsertArtifactsResult);
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

    private sealed record MessageOrderRow(string Id, string Role, long CreatedAt, int SortOrder, string? Meta);

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
