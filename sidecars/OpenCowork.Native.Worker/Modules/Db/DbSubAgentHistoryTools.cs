using System.Buffers;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbSubAgentHistoryTools
{
    private const string LegacyHistoryKey = "opencowork-agent-history";
    private const string LegacyAgentStoreKey = "opencowork-agent";

    public static WorkerResponse Index(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var sessions = new List<(string SessionId, int Count, long LatestStartedAt)>();
            var total = 0;
            using (var command = connection.CreateCommand())
            {
                command.CommandText = """
                    SELECT session_id, COUNT(*), MAX(started_at)
                      FROM sub_agent_history
                     WHERE session_id IS NOT NULL
                     GROUP BY session_id
                     ORDER BY session_id ASC
                    """;
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var count = reader.GetInt32(1);
                    sessions.Add((reader.GetString(0), count, reader.GetInt64(2)));
                    total += count;
                }
            }

            using (var command = connection.CreateCommand())
            {
                command.CommandText =
                    "SELECT COUNT(*) FROM sub_agent_history WHERE session_id IS NULL";
                total += Convert.ToInt32(command.ExecuteScalar() ?? 0);
            }

            return WorkerResponse.DirectMessagePack(writer =>
            {
                writer.WriteMapHeader(2);
                writer.WriteString("total");
                writer.WriteInt64(total);
                writer.WriteString("sessions");
                writer.WriteArrayHeader(sessions.Count);
                foreach (var session in sessions)
                {
                    writer.WriteMapHeader(3);
                    writer.WriteString("sessionId");
                    writer.WriteString(session.SessionId);
                    writer.WriteString("count");
                    writer.WriteInt64(session.Count);
                    writer.WriteString("latestStartedAt");
                    writer.WriteInt64(session.LatestStartedAt);
                }
            });
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
            var whereClause = string.IsNullOrWhiteSpace(sessionId)
                ? string.Empty
                : " WHERE session_id = $sessionId";
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var countCommand = connection.CreateCommand();
            countCommand.Transaction = transaction;
            countCommand.CommandText = $"""
                SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(state_json AS BLOB))), 0)
                  FROM sub_agent_history
                  {whereClause}
                """;
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                countCommand.Parameters.AddWithValue("$sessionId", sessionId);
            }
            using var countReader = countCommand.ExecuteReader();
            countReader.Read();
            var count = countReader.GetInt32(0);
            var stateBytes = countReader.GetInt64(1);
            countReader.Close();

            var response = WorkerResponse.DirectMessagePack(writer =>
            {
                writer.WriteArrayHeader(count);
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = $"""
                    SELECT state_json
                      FROM sub_agent_history
                      {whereClause}
                     ORDER BY sort_order ASC, started_at ASC, tool_use_id ASC
                    """;
                if (!string.IsNullOrWhiteSpace(sessionId))
                {
                    command.Parameters.AddWithValue("$sessionId", sessionId);
                }
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    using var document = JsonDocument.Parse(reader.GetString(0));
                    writer.WriteJsonElement(document.RootElement);
                }
            });
            transaction.Commit();
            WorkerMemory.ReportCompletedWork("sub-agent-history-read", stateBytes);
            return response;
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Apply(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();

            if (parameters.TryGetProperty("removeSessionIds", out var removeSessions) &&
                removeSessions.ValueKind == JsonValueKind.Array)
            {
                foreach (var sessionId in ReadStrings(removeSessions))
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        "DELETE FROM sub_agent_history WHERE session_id = $sessionId",
                        new DbSql.SqlParam("$sessionId", sessionId));
                }
            }

            if (parameters.TryGetProperty("removeIds", out var removeIds) &&
                removeIds.ValueKind == JsonValueKind.Array)
            {
                foreach (var id in ReadStrings(removeIds))
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        "DELETE FROM sub_agent_history WHERE tool_use_id = $id",
                        new DbSql.SqlParam("$id", id));
                }
            }

            var upserted = 0;
            if (parameters.TryGetProperty("upserts", out var upserts) &&
                upserts.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in upserts.EnumerateArray())
                {
                    if (UpsertEntry(connection, transaction, entry, null, null))
                    {
                        upserted++;
                    }
                }
            }

            transaction.Commit();
            WorkerLog.Debug($"sub-agent history apply upserted={upserted}");
            return MutationResponse(true, upserted, null);
        }
        catch (Exception ex)
        {
            return MutationResponse(false, 0, ex.Message);
        }
    }

    public static WorkerResponse Replace(JsonElement parameters)
    {
        try
        {
            if (!parameters.TryGetProperty("snapshot", out var snapshot))
            {
                return MutationResponse(false, 0, "Missing sub-agent history snapshot");
            }

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var imported = ReplaceSnapshot(connection, transaction, snapshot);
            transaction.Commit();
            WorkerLog.Info($"sub-agent history replace imported={imported}");
            return MutationResponse(true, imported, null);
        }
        catch (Exception ex)
        {
            return MutationResponse(false, 0, ex.Message);
        }
    }

    public static WorkerResponse MigrateLegacySettings(JsonElement parameters)
    {
        var settingsPath = GetSettingsPath();
        if (!File.Exists(settingsPath))
        {
            return MigrationResponse(true, false, 0, null);
        }

        try
        {
            var utf8 = File.ReadAllBytes(settingsPath);
            using var document = JsonDocument.Parse(utf8);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return MigrationResponse(false, false, 0, "Invalid settings root");
            }

            var root = document.RootElement;
            var hasPrimary = root.TryGetProperty(LegacyHistoryKey, out var primaryValue);
            var hasLegacyStore = root.TryGetProperty(LegacyAgentStoreKey, out var agentStoreValue);
            var legacySnapshot = hasPrimary && HasHistoryPayload(primaryValue)
                ? primaryValue
                : hasLegacyStore && HasHistoryPayload(agentStoreValue)
                    ? agentStoreValue
                    : default;

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var existingCount = CountEntries(connection);
            var imported = 0;
            if (existingCount == 0 && legacySnapshot.ValueKind != JsonValueKind.Undefined)
            {
                using var transaction = connection.BeginTransaction();
                imported = ReplaceSnapshot(connection, transaction, legacySnapshot);
                transaction.Commit();
                existingCount = imported;
            }

            var canRemoveLegacy = existingCount > 0 ||
                legacySnapshot.ValueKind != JsonValueKind.Undefined;
            if (!canRemoveLegacy || (!hasPrimary && !ContainsHistoryPayload(agentStoreValue)))
            {
                return MigrationResponse(true, false, imported, null);
            }

            var rewritten = RewriteSettingsWithoutHistory(root);
            WriteFileAtomic(settingsPath, rewritten);
            WorkerMemory.ReportCompletedWork("sub-agent-history-migration", utf8.Length);
            WorkerLog.Info($"sub-agent history settings migration imported={imported}");
            return MigrationResponse(true, true, imported, null);
        }
        catch (Exception ex)
        {
            return MigrationResponse(false, false, 0, ex.Message);
        }
    }

    private static int ReplaceSnapshot(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement snapshotValue)
    {
        var ownedDocument = ParseStringValue(snapshotValue);
        try
        {
            var snapshot = UnwrapSnapshot(ownedDocument?.RootElement ?? snapshotValue);
            DbSql.ExecuteNonQuery(connection, transaction, "DELETE FROM sub_agent_history");
            var importedIds = new HashSet<string>(StringComparer.Ordinal);
            var order = 0;

            if (snapshot.ValueKind == JsonValueKind.Object &&
                snapshot.TryGetProperty("subAgentHistory", out var history) &&
                history.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in history.EnumerateArray())
                {
                    if (UpsertEntry(connection, transaction, entry, null, order))
                    {
                        importedIds.Add(ReadToolUseId(entry)!);
                        order++;
                    }
                }
            }

            if (snapshot.ValueKind == JsonValueKind.Object &&
                snapshot.TryGetProperty("sessionSubAgentSummaries", out var summaries) &&
                summaries.ValueKind == JsonValueKind.Object)
            {
                foreach (var session in summaries.EnumerateObject())
                {
                    if (session.Value.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    foreach (var entry in session.Value.EnumerateArray())
                    {
                        var id = ReadToolUseId(entry);
                        if (string.IsNullOrWhiteSpace(id) || importedIds.Contains(id))
                        {
                            continue;
                        }
                        if (UpsertEntry(connection, transaction, entry, session.Name, order))
                        {
                            importedIds.Add(id);
                            order++;
                        }
                    }
                }
            }
            return importedIds.Count;
        }
        finally
        {
            ownedDocument?.Dispose();
        }
    }

    private static bool UpsertEntry(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement entry,
        string? fallbackSessionId,
        int? replacementOrder)
    {
        var id = ReadToolUseId(entry);
        if (string.IsNullOrWhiteSpace(id) || entry.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var sessionId = ReadString(entry, "sessionId") ?? fallbackSessionId;
        var startedAt = ReadInt64(entry, "startedAt") ?? 0;
        var updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = replacementOrder.HasValue
            ? """
                INSERT INTO sub_agent_history (
                  tool_use_id, session_id, state_json, sort_order, started_at, updated_at
                ) VALUES ($id, $sessionId, $stateJson, $sortOrder, $startedAt, $updatedAt)
                ON CONFLICT(tool_use_id) DO UPDATE SET
                  session_id = excluded.session_id,
                  state_json = excluded.state_json,
                  sort_order = excluded.sort_order,
                  started_at = excluded.started_at,
                  updated_at = excluded.updated_at
                """
            : """
                INSERT INTO sub_agent_history (
                  tool_use_id, session_id, state_json, sort_order, started_at, updated_at
                ) VALUES (
                  $id,
                  $sessionId,
                  $stateJson,
                  COALESCE(
                    (SELECT sort_order FROM sub_agent_history WHERE tool_use_id = $id),
                    (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sub_agent_history)
                  ),
                  $startedAt,
                  $updatedAt
                )
                ON CONFLICT(tool_use_id) DO UPDATE SET
                  session_id = excluded.session_id,
                  state_json = excluded.state_json,
                  started_at = excluded.started_at,
                  updated_at = excluded.updated_at
                """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$sessionId", (object?)sessionId ?? DBNull.Value);
        command.Parameters.AddWithValue("$stateJson", entry.GetRawText());
        if (replacementOrder.HasValue)
        {
            command.Parameters.AddWithValue("$sortOrder", replacementOrder.Value);
        }
        command.Parameters.AddWithValue("$startedAt", startedAt);
        command.Parameters.AddWithValue("$updatedAt", updatedAt);
        command.ExecuteNonQuery();
        return true;
    }

    private static int CountEntries(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM sub_agent_history";
        return Convert.ToInt32(command.ExecuteScalar() ?? 0);
    }

    private static string? ReadToolUseId(JsonElement entry) => ReadString(entry, "toolUseId");

    private static string? ReadString(JsonElement value, string propertyName)
    {
        return value.ValueKind == JsonValueKind.Object &&
            value.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String
                ? property.GetString()?.Trim()
                : null;
    }

    private static long? ReadInt64(JsonElement value, string propertyName)
    {
        return value.ValueKind == JsonValueKind.Object &&
            value.TryGetProperty(propertyName, out var property) &&
            property.TryGetInt64(out var result)
                ? result
                : null;
    }

    private static IEnumerable<string> ReadStrings(JsonElement values)
    {
        foreach (var value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var text = value.GetString()?.Trim();
            if (!string.IsNullOrWhiteSpace(text))
            {
                yield return text;
            }
        }
    }

    private static JsonElement UnwrapSnapshot(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.Object &&
            value.TryGetProperty("state", out var state) &&
            state.ValueKind == JsonValueKind.Object
                ? state
                : value;
    }

    private static JsonDocument? ParseStringValue(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        var json = value.GetString();
        return string.IsNullOrWhiteSpace(json) ? null : JsonDocument.Parse(json);
    }

    private static bool HasHistoryPayload(JsonElement value)
    {
        var ownedDocument = ParseStringValue(value);
        try
        {
            var snapshot = UnwrapSnapshot(ownedDocument?.RootElement ?? value);
            return ContainsHistoryPayload(snapshot);
        }
        catch (JsonException)
        {
            return false;
        }
        finally
        {
            ownedDocument?.Dispose();
        }
    }

    private static bool ContainsHistoryPayload(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Undefined)
        {
            return false;
        }

        var ownedDocument = ParseStringValue(value);
        try
        {
            var snapshot = UnwrapSnapshot(ownedDocument?.RootElement ?? value);
            return snapshot.ValueKind == JsonValueKind.Object &&
                (snapshot.TryGetProperty("subAgentHistory", out _) ||
                 snapshot.TryGetProperty("sessionSubAgentSummaries", out _));
        }
        catch (JsonException)
        {
            return false;
        }
        finally
        {
            ownedDocument?.Dispose();
        }
    }

    private static byte[] RewriteSettingsWithoutHistory(JsonElement root)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartObject();
            foreach (var property in root.EnumerateObject())
            {
                if (property.NameEquals(LegacyHistoryKey))
                {
                    continue;
                }

                writer.WritePropertyName(property.Name);
                if (property.NameEquals(LegacyAgentStoreKey))
                {
                    WriteAgentStoreWithoutHistory(writer, property.Value);
                }
                else
                {
                    property.Value.WriteTo(writer);
                }
            }
            writer.WriteEndObject();
        }
        return buffer.WrittenMemory.ToArray();
    }

    private static void WriteAgentStoreWithoutHistory(Utf8JsonWriter writer, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var json = value.GetString();
            if (string.IsNullOrWhiteSpace(json))
            {
                writer.WriteStringValue(json);
                return;
            }

            try
            {
                using var document = JsonDocument.Parse(json);
                var cleaned = SerializeAgentStoreWithoutHistory(document.RootElement);
                writer.WriteStringValue(Encoding.UTF8.GetString(cleaned));
                return;
            }
            catch (JsonException)
            {
                writer.WriteStringValue(json);
                return;
            }
        }

        WriteAgentStoreObjectWithoutHistory(writer, value);
    }

    private static byte[] SerializeAgentStoreWithoutHistory(JsonElement value)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            WriteAgentStoreObjectWithoutHistory(writer, value);
        }
        return buffer.WrittenMemory.ToArray();
    }

    private static void WriteAgentStoreObjectWithoutHistory(Utf8JsonWriter writer, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            value.WriteTo(writer);
            return;
        }

        writer.WriteStartObject();
        foreach (var property in value.EnumerateObject())
        {
            if (property.NameEquals("subAgentHistory") ||
                property.NameEquals("sessionSubAgentSummaries"))
            {
                continue;
            }

            writer.WritePropertyName(property.Name);
            if (property.NameEquals("state"))
            {
                WriteAgentStoreObjectWithoutHistory(writer, property.Value);
            }
            else
            {
                property.Value.WriteTo(writer);
            }
        }
        writer.WriteEndObject();
    }

    private static void WriteFileAtomic(string path, byte[] contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllBytes(tempPath, contents);
            File.Move(tempPath, path, true);
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
    }

    private static string GetSettingsPath()
    {
        var overridePath = Environment.GetEnvironmentVariable("OPEN_COWORK_NATIVE_SETTINGS_PATH");
        if (!string.IsNullOrWhiteSpace(overridePath))
        {
            var fullPath = Path.GetFullPath(overridePath);
            var tempRoot = Path.GetFullPath(Path.GetTempPath())
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var comparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            var tempPrefix = $"{tempRoot}{Path.DirectorySeparatorChar}";
            if (!fullPath.StartsWith(tempPrefix, comparison))
            {
                throw new InvalidOperationException(
                    "OPEN_COWORK_NATIVE_SETTINGS_PATH is restricted to the temporary directory.");
            }
            return fullPath;
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "settings.json");
    }

    private static WorkerResponse MutationResponse(bool success, int affected, string? error)
    {
        return WorkerResponse.DirectMessagePack(writer =>
        {
            writer.WriteMapHeader(string.IsNullOrWhiteSpace(error) ? 2 : 3);
            writer.WriteString("success");
            writer.WriteBoolean(success);
            writer.WriteString("affected");
            writer.WriteInt64(affected);
            if (!string.IsNullOrWhiteSpace(error))
            {
                writer.WriteString("error");
                writer.WriteString(error);
            }
        });
    }

    private static WorkerResponse MigrationResponse(
        bool success,
        bool migrated,
        int imported,
        string? error)
    {
        return WorkerResponse.DirectMessagePack(writer =>
        {
            writer.WriteMapHeader(string.IsNullOrWhiteSpace(error) ? 3 : 4);
            writer.WriteString("success");
            writer.WriteBoolean(success);
            writer.WriteString("migrated");
            writer.WriteBoolean(migrated);
            writer.WriteString("imported");
            writer.WriteInt64(imported);
            if (!string.IsNullOrWhiteSpace(error))
            {
                writer.WriteString("error");
                writer.WriteString(error);
            }
        });
    }
}
