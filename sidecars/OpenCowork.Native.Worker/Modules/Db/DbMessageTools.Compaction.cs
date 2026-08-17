using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

/// <summary>
/// Durable store for the per-session compaction cut.
///
/// Context compression folds an arbitrary prefix of a session into one summary
/// message. The transcript keeps every row, so request assembly needs to know
/// which rows the summary already accounts for. Recording that once at commit
/// time — instead of re-deriving it from the position of marker rows on every
/// request — is what stops summarized turns from re-entering the context
/// window.
/// </summary>
internal static partial class DbMessageTools
{
    public static WorkerResponse CompactionGet(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var compaction = ReadCompaction(connection, transaction, sessionId);

            // A summary row can disappear when the user truncates or retries from a
            // point at or before the compaction. The record is then meaningless: drop
            // it so the session falls back to its (now shorter) full history instead
            // of cutting against a summary nobody can read.
            if (compaction is not null &&
                !MessageExists(connection, transaction, compaction.SummaryMessageId))
            {
                DeleteCompaction(connection, transaction, sessionId);
                compaction = null;
            }

            transaction.Commit();
            return CompactionResult(true, compaction, null);
        }
        catch (Exception ex)
        {
            return CompactionResult(false, null, ex.Message);
        }
    }

    /// <summary>
    /// Persists the summary message and the cut it represents in one
    /// transaction, so a session can never hold a summary without a cut (the old
    /// history would come back) or a cut without a summary (the memory would be
    /// gone).
    /// </summary>
    public static WorkerResponse CompactionCommit(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            if (!parameters.TryGetProperty("summaryMessage", out var summaryElement) ||
                summaryElement.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException("Missing required field: summaryMessage");
            }

            var summary = ReadMessageInput(summaryElement, sessionId);
            var compactedIds = ReadIdSet(parameters, "compactedMessageIds");
            var keepIds = ReadIdSet(parameters, "keepMessageIds");
            var trigger = string.Equals(
                JsonHelpers.GetString(parameters, "trigger"),
                "manual",
                StringComparison.Ordinal)
                ? "manual"
                : "auto";
            var preTokens = Math.Max(0, JsonHelpers.GetInt(parameters, "preTokens", 0));
            var compactedMessageCount = Math.Max(
                0,
                JsonHelpers.GetInt(parameters, "compactedMessageCount", compactedIds.Count));

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();

            var existing = ReadCompaction(connection, transaction, sessionId);

            // The event outbox delivers at least once, so the same compaction can be
            // reported twice. Re-recording it would bump the generation and force a
            // pointless hosted-session reopen, so a repeat is a no-op.
            if (existing is not null &&
                string.Equals(existing.SummaryMessageId, summary.Id, StringComparison.Ordinal))
            {
                var currentTotal = CountRows(
                    connection,
                    transaction,
                    "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId",
                    new SqlParam("$sessionId", sessionId));
                transaction.Rollback();
                return WorkerResponse.Json(
                    new SessionCompactionCommitResult(true, existing, -1, currentTotal, null),
                    WorkerJsonContext.Default.SessionCompactionCommitResult);
            }

            DeleteSupersededSummaryRows(connection, transaction, sessionId, existing, summary.Id);

            var cut = ResolveCompactionCut(connection, transaction, sessionId, compactedIds, keepIds);
            var total = CountRows(
                connection,
                transaction,
                "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId",
                new SqlParam("$sessionId", sessionId));

            // The summary lands at the tail so it reads as the newest turn and can
            // never be mistaken for part of the range it replaces.
            var summarySortOrder = total;
            InsertSummaryRow(connection, transaction, summary with { SortOrder = summarySortOrder });

            var committed = new SessionCompactionRow(
                sessionId,
                (existing?.Generation ?? 0) + 1,
                summary.Id,
                cut.ThroughMessageId,
                // Monotonic guard: a later compaction can only ever fold more of the
                // session, so an out-of-order or partially-resolved report must not
                // walk the cut backwards and re-expose earlier turns.
                Math.Max(existing?.ThroughSortOrder ?? int.MinValue, cut.ThroughSortOrder),
                keepIds.ToList(),
                compactedMessageCount,
                trigger,
                preTokens,
                JsonHelpers.GetLong(parameters, "createdAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));

            UpsertCompaction(connection, transaction, committed);

            var newTotal = CountRows(
                connection,
                transaction,
                "SELECT COUNT(*) FROM messages WHERE session_id = $sessionId",
                new SqlParam("$sessionId", sessionId));
            SetMessageCount(connection, transaction, sessionId, newTotal);
            transaction.Commit();

            WorkerLog.Info(
                $"db session compaction commit sessionId={sessionId} generation={committed.Generation} " +
                $"summaryId={committed.SummaryMessageId} through={committed.ThroughSortOrder} " +
                $"throughId={committed.ThroughMessageId ?? "-"} keep={committed.KeepMessageIds.Count} total={newTotal}");

            return WorkerResponse.Json(
                new SessionCompactionCommitResult(true, committed, summarySortOrder, newTotal, null),
                WorkerJsonContext.Default.SessionCompactionCommitResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new SessionCompactionCommitResult(false, null, 0, 0, ex.Message),
                WorkerJsonContext.Default.SessionCompactionCommitResult);
        }
    }

    internal static SessionCompactionRow? ReadCompaction(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string sessionId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        // Resolve the boundary row's current position so the cut tracks the
        // transcript even if sort orders are renumbered after the commit; the
        // stored number stays as the fallback when the row is gone.
        command.CommandText = """
            SELECT c.generation,
                   c.summary_message_id,
                   c.through_message_id,
                   COALESCE(m.sort_order, c.through_sort_order) AS through_sort_order,
                   c.keep_message_ids,
                   c.compacted_message_count,
                   c.trigger_kind,
                   c.pre_tokens,
                   c.created_at
              FROM session_compactions c
              LEFT JOIN messages m
                     ON m.id = c.through_message_id
                    AND m.session_id = c.session_id
             WHERE c.session_id = $sessionId
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return new SessionCompactionRow(
            sessionId,
            reader.GetInt32(0),
            reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.GetInt32(3),
            ParseIdList(reader.IsDBNull(4) ? null : reader.GetString(4)),
            reader.GetInt32(5),
            reader.GetString(6),
            reader.GetInt32(7),
            reader.GetInt64(8));
    }

    /// <summary>
    /// The cut is the furthest-along row the summarizer consumed. Rows the caller
    /// asked to keep are excluded because they outlive the compaction.
    /// </summary>
    private static CompactionCut ResolveCompactionCut(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        IReadOnlyCollection<string> compactedIds,
        IReadOnlyCollection<string> keepIds)
    {
        var candidates = compactedIds.Where(id => !keepIds.Contains(id)).ToList();
        if (candidates.Count > 0)
        {
            var resolved = ReadHighestSortOrder(connection, transaction, sessionId, candidates);
            if (resolved is not null)
            {
                return resolved;
            }
        }

        // Nothing reported resolved to a stored row — the loop had folded only
        // messages it created itself. Fall back to the newest persisted row that is
        // not explicitly kept, which is exactly what the model had already seen.
        return ReadHighestSortOrderExcluding(connection, transaction, sessionId, keepIds)
            ?? new CompactionCut(null, -1);
    }

    private static CompactionCut? ReadHighestSortOrder(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        IReadOnlyList<string> ids)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        var placeholders = new StringBuilder();
        for (var index = 0; index < ids.Count; index++)
        {
            if (index > 0)
            {
                placeholders.Append(", ");
            }
            placeholders.Append("$id").Append(index);
            command.Parameters.AddWithValue($"$id{index}", ids[index]);
        }

        command.CommandText = $"""
            SELECT id, sort_order
              FROM messages
             WHERE session_id = $sessionId
               AND id IN ({placeholders})
             ORDER BY sort_order DESC
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);

        using var reader = command.ExecuteReader();
        return reader.Read() ? new CompactionCut(reader.GetString(0), reader.GetInt32(1)) : null;
    }

    private static CompactionCut? ReadHighestSortOrderExcluding(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        IReadOnlyCollection<string> excludedIds)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        var filter = new StringBuilder();
        var index = 0;
        foreach (var excludedId in excludedIds)
        {
            filter.Append(index == 0 ? " AND id NOT IN (" : ", ");
            filter.Append("$skip").Append(index);
            command.Parameters.AddWithValue($"$skip{index}", excludedId);
            index++;
        }
        if (index > 0)
        {
            filter.Append(')');
        }

        command.CommandText = $"""
            SELECT id, sort_order
              FROM messages
             WHERE session_id = $sessionId{filter}
             ORDER BY sort_order DESC
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);

        using var reader = command.ExecuteReader();
        return reader.Read() ? new CompactionCut(reader.GetString(0), reader.GetInt32(1)) : null;
    }

    private static void InsertSummaryRow(
        SqliteConnection connection,
        SqliteTransaction transaction,
        MessageInput summary)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO messages (id, session_id, role, content, meta, created_at, usage, sort_order)
            VALUES ($id, $sessionId, $role, $content, $meta, $createdAt, $usage, $sortOrder)
            ON CONFLICT(id) DO UPDATE SET
              role = excluded.role,
              content = excluded.content,
              meta = excluded.meta,
              sort_order = excluded.sort_order
            """;
        AddMessageParameters(command, summary);
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// Removes the summary this commit replaces, plus any marker rows left by
    /// builds that predate the watermark, so a compacted session carries exactly
    /// one summary.
    /// </summary>
    private static void DeleteSupersededSummaryRows(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId,
        SessionCompactionRow? existing,
        string incomingSummaryId)
    {
        if (existing is not null &&
            !string.Equals(existing.SummaryMessageId, incomingSummaryId, StringComparison.Ordinal))
        {
            ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM messages WHERE session_id = $sessionId AND id = $id",
                new("$sessionId", sessionId),
                new("$id", existing.SummaryMessageId));
        }

        ExecuteNonQuery(
            connection,
            transaction,
            """
            DELETE FROM messages
             WHERE session_id = $sessionId
               AND id <> $incomingId
               AND meta IS NOT NULL
               AND (meta LIKE '%"compactBoundary"%' OR meta LIKE '%"compactSummary"%')
            """,
            new("$sessionId", sessionId),
            new("$incomingId", incomingSummaryId));
    }

    private static void UpsertCompaction(
        SqliteConnection connection,
        SqliteTransaction transaction,
        SessionCompactionRow row)
    {
        ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO session_compactions (
              session_id, generation, summary_message_id, through_message_id, through_sort_order,
              keep_message_ids, compacted_message_count, trigger_kind, pre_tokens, created_at
            ) VALUES (
              $sessionId, $generation, $summaryMessageId, $throughMessageId, $throughSortOrder,
              $keepMessageIds, $compactedMessageCount, $triggerKind, $preTokens, $createdAt
            )
            ON CONFLICT(session_id) DO UPDATE SET
              generation = excluded.generation,
              summary_message_id = excluded.summary_message_id,
              through_message_id = excluded.through_message_id,
              through_sort_order = excluded.through_sort_order,
              keep_message_ids = excluded.keep_message_ids,
              compacted_message_count = excluded.compacted_message_count,
              trigger_kind = excluded.trigger_kind,
              pre_tokens = excluded.pre_tokens,
              created_at = excluded.created_at
            """,
            new("$sessionId", row.SessionId),
            new("$generation", row.Generation),
            new("$summaryMessageId", row.SummaryMessageId),
            new("$throughMessageId", row.ThroughMessageId),
            new("$throughSortOrder", row.ThroughSortOrder),
            new("$keepMessageIds", SerializeIdList(row.KeepMessageIds)),
            new("$compactedMessageCount", row.CompactedMessageCount),
            new("$triggerKind", row.Trigger),
            new("$preTokens", row.PreTokens),
            new("$createdAt", row.CreatedAt));
    }

    private static void DeleteCompaction(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId)
    {
        ExecuteNonQuery(
            connection,
            transaction,
            "DELETE FROM session_compactions WHERE session_id = $sessionId",
            new SqlParam("$sessionId", sessionId));
    }

    private static HashSet<string> ReadIdSet(JsonElement parameters, string propertyName)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (!parameters.TryGetProperty(propertyName, out var element) ||
            element.ValueKind != JsonValueKind.Array)
        {
            return ids;
        }

        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } id)
            {
                ids.Add(id);
            }
        }
        return ids;
    }

    private static List<string> ParseIdList(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return new List<string>();
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return new List<string>();
            }
            return document.RootElement
                .EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString()!)
                .Where(id => id.Length > 0)
                .ToList();
        }
        catch
        {
            return new List<string>();
        }
    }

    private static string SerializeIdList(IReadOnlyList<string> ids)
    {
        return JsonSerializer.Serialize(ids, WorkerJsonContext.Default.ListString);
    }

    private static WorkerResponse CompactionResult(
        bool success,
        SessionCompactionRow? compaction,
        string? error)
    {
        return WorkerResponse.Json(
            new SessionCompactionResult(success, compaction, error),
            WorkerJsonContext.Default.SessionCompactionResult);
    }

    private sealed record CompactionCut(string? ThroughMessageId, int ThroughSortOrder);
}
