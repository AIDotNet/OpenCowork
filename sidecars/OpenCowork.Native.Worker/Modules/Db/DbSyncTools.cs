using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbSyncTools
{
    private const string KeySeparator = "\u0000";
    private const string DbDomainPrefix = "db:";
    private const int DefaultCapturePageSize = 500;
    private const int MaxCapturePageSize = 2_000;

    public static WorkerResponse CaptureLocal(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        try
        {
            var providerId = RequireString(parameters, "providerId");
            var limit = Math.Clamp(
                JsonHelpers.GetInt(parameters, "limit", DefaultCapturePageSize),
                1,
                MaxCapturePageSize);
            var cursor = ParseCaptureCursor(JsonHelpers.GetString(parameters, "cursor"));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var schemas = ListSyncTableSchemas(connection);
            var page = CapturePage(
                connection,
                schemas,
                providerId,
                cursor,
                limit,
                context.CancellationToken);
            return WriteCapturePage(page);
        }
        catch (Exception ex)
        {
            return WriteCapturePage(new DbSyncCapturePage(
                false,
                [],
                [],
                [],
                null,
                true,
                ex.Message));
        }
    }

    public static WorkerResponse GetTableOrder(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var schemas = ListSyncTableSchemas(connection).ToDictionary(
                schema => schema.Name,
                StringComparer.Ordinal);
            var tables = SortTablesForUpsert(schemas);
            return WorkerResponse.DirectMessagePack(writer =>
            {
                writer.WriteMapHeader(3);
                writer.WriteString("success");
                writer.WriteBoolean(true);
                writer.WriteString("tables");
                writer.WriteArrayHeader(tables.Count);
                foreach (var table in tables)
                {
                    writer.WriteString(table);
                }
                writer.WriteString("error");
                writer.WriteNil();
            });
        }
        catch (Exception ex)
        {
            return WorkerResponse.DirectMessagePack(writer =>
            {
                writer.WriteMapHeader(3);
                writer.WriteString("success");
                writer.WriteBoolean(false);
                writer.WriteString("tables");
                writer.WriteArrayHeader(0);
                writer.WriteString("error");
                writer.WriteString(ex.Message);
            });
        }
    }

    public static WorkerResponse ApplyDbMerge(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var schemas = ListSyncTableSchemas(connection).ToDictionary(
                schema => schema.Name,
                StringComparer.Ordinal);
            var tableOrder = SortTablesForUpsert(schemas);
            var recordsToApply = ReadRecordDrafts(parameters, "recordsToApply");
            var recordsToDelete = ReadTombstones(parameters, "recordsToDelete");
            var changed = 0;

            using var transaction = connection.BeginTransaction();
            foreach (var tombstone in OrderByTable(recordsToDelete, tableOrder, reverse: true))
            {
                var tableName = TableFromDomain(tombstone.Domain);
                if (tableName is null || !schemas.TryGetValue(tableName, out var schema))
                {
                    continue;
                }
                changed += DeleteDbRecord(connection, transaction, schema, tombstone.RecordId);
            }

            foreach (var record in OrderByTable(recordsToApply, tableOrder, reverse: false))
            {
                var tableName = TableFromDomain(record.Domain);
                if (tableName is null || !schemas.TryGetValue(tableName, out var schema))
                {
                    continue;
                }
                changed += UpsertDbRecord(connection, transaction, schema, record);
            }
            transaction.Commit();

            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse SaveMetadata(JsonElement parameters)
    {
        try
        {
            var providerId = RequireString(parameters, "providerId");
            var records = ReadMetadataRecords(parameters, "records");
            var tombstones = ReadTombstones(parameters, "tombstones");
            var reset = JsonHelpers.GetBool(parameters, "reset", true);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var changed = 0;

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            if (reset)
            {
                changed += DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    "DELETE FROM sync_record_state WHERE provider_id = $providerId",
                    new DbSql.SqlParam("$providerId", providerId));
                changed += DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    "DELETE FROM sync_tombstones WHERE provider_id = $providerId",
                    new DbSql.SqlParam("$providerId", providerId));
            }

            using var stateCommand = connection.CreateCommand();
            stateCommand.Transaction = transaction;
            stateCommand.CommandText = """
                INSERT INTO sync_record_state (provider_id, domain, record_id, content_hash, synced_at)
                VALUES ($providerId, $domain, $recordId, $contentHash, $syncedAt)
                """;
            var stateProvider = stateCommand.Parameters.Add("$providerId", SqliteType.Text);
            var stateDomain = stateCommand.Parameters.Add("$domain", SqliteType.Text);
            var stateRecordId = stateCommand.Parameters.Add("$recordId", SqliteType.Text);
            var stateHash = stateCommand.Parameters.Add("$contentHash", SqliteType.Text);
            var stateSyncedAt = stateCommand.Parameters.Add("$syncedAt", SqliteType.Integer);
            stateProvider.Value = providerId;
            stateSyncedAt.Value = now;
            foreach (var record in records)
            {
                stateDomain.Value = record.Domain;
                stateRecordId.Value = record.RecordId;
                stateHash.Value = record.ContentHash;
                changed += stateCommand.ExecuteNonQuery();
            }

            using var tombstoneCommand = connection.CreateCommand();
            tombstoneCommand.Transaction = transaction;
            tombstoneCommand.CommandText = """
                INSERT INTO sync_tombstones (provider_id, domain, record_id, deleted_at, origin_device_id)
                VALUES ($providerId, $domain, $recordId, $deletedAt, $originDeviceId)
                """;
            var tombstoneProvider = tombstoneCommand.Parameters.Add("$providerId", SqliteType.Text);
            var tombstoneDomain = tombstoneCommand.Parameters.Add("$domain", SqliteType.Text);
            var tombstoneRecordId = tombstoneCommand.Parameters.Add("$recordId", SqliteType.Text);
            var tombstoneDeletedAt = tombstoneCommand.Parameters.Add("$deletedAt", SqliteType.Integer);
            var tombstoneOriginDeviceId = tombstoneCommand.Parameters.Add("$originDeviceId", SqliteType.Text);
            tombstoneProvider.Value = providerId;
            foreach (var tombstone in tombstones)
            {
                tombstoneDomain.Value = tombstone.Domain;
                tombstoneRecordId.Value = tombstone.RecordId;
                tombstoneDeletedAt.Value = tombstone.DeletedAt;
                tombstoneOriginDeviceId.Value = tombstone.OriginDeviceId;
                changed += tombstoneCommand.ExecuteNonQuery();
            }

            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static List<DbSyncTableSchema> ListSyncTableSchemas(SqliteConnection connection)
    {
        var tableNames = new List<string>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT name FROM sqlite_master
                 WHERE type = 'table'
                   AND name NOT LIKE 'sqlite_%'
                   AND name NOT LIKE 'sync_%'
                 ORDER BY name ASC
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                tableNames.Add(reader.GetString(0));
            }
        }

        var schemas = new List<DbSyncTableSchema>();
        foreach (var tableName in tableNames)
        {
            var columns = ReadColumns(connection, tableName);
            var pkColumns = columns
                .Where(column => column.Pk > 0)
                .OrderBy(column => column.Pk)
                .Select(column => column.Name)
                .ToList();
            if (pkColumns.Count == 0)
            {
                continue;
            }

            schemas.Add(new DbSyncTableSchema
            {
                Name = tableName,
                Columns = columns.Select(column => column.Name).ToList(),
                PkColumns = pkColumns,
                Dependencies = ReadDependencies(connection, tableName)
            });
        }
        return schemas;
    }

    private static List<ColumnInfo> ReadColumns(SqliteConnection connection, string tableName)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({QuoteIdent(tableName)})";
        using var reader = command.ExecuteReader();
        var columns = new List<ColumnInfo>();
        while (reader.Read())
        {
            columns.Add(new ColumnInfo(reader.GetString(1), reader.GetInt32(5)));
        }
        return columns;
    }

    private static List<string> ReadDependencies(SqliteConnection connection, string tableName)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA foreign_key_list({QuoteIdent(tableName)})";
        using var reader = command.ExecuteReader();
        var dependencies = new HashSet<string>(StringComparer.Ordinal);
        while (reader.Read())
        {
            dependencies.Add(reader.GetString(2));
        }
        return dependencies.OrderBy(value => value, StringComparer.Ordinal).ToList();
    }

    private static List<string> SortTablesForUpsert(IReadOnlyDictionary<string, DbSyncTableSchema> schemas)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();

        void Visit(string tableName)
        {
            if (visited.Contains(tableName) || visiting.Contains(tableName))
            {
                return;
            }

            visiting.Add(tableName);
            if (schemas.TryGetValue(tableName, out var schema))
            {
                foreach (var dependency in schema.Dependencies)
                {
                    if (schemas.ContainsKey(dependency))
                    {
                        Visit(dependency);
                    }
                }
            }
            visiting.Remove(tableName);
            visited.Add(tableName);
            ordered.Add(tableName);
        }

        foreach (var tableName in schemas.Keys)
        {
            Visit(tableName);
        }
        return ordered;
    }

    private static DbSyncCapturePage CapturePage(
        SqliteConnection connection,
        IReadOnlyList<DbSyncTableSchema> schemas,
        string providerId,
        DbSyncCaptureCursor cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        if (cursor.Phase == DbSyncCapturePhase.Records)
        {
            var records = new List<DbSyncCapturedRecord>(limit);
            var tableIndex = Math.Clamp(cursor.TableIndex, 0, schemas.Count);
            var offset = Math.Max(0, cursor.Offset);
            while (tableIndex < schemas.Count && records.Count < limit)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var remaining = limit - records.Count;
                var tableRows = CaptureTablePage(
                    connection,
                    schemas[tableIndex],
                    offset,
                    remaining + 1,
                    cancellationToken);
                var take = Math.Min(remaining, tableRows.Count);
                for (var index = 0; index < take; index++)
                {
                    records.Add(tableRows[index]);
                }

                if (tableRows.Count > remaining)
                {
                    return new DbSyncCapturePage(
                        true,
                        records,
                        [],
                        [],
                        FormatCaptureCursor(DbSyncCapturePhase.Records, tableIndex, offset + take),
                        false,
                        null);
                }

                tableIndex++;
                offset = 0;
            }

            return new DbSyncCapturePage(
                true,
                records,
                [],
                [],
                tableIndex < schemas.Count
                    ? FormatCaptureCursor(DbSyncCapturePhase.Records, tableIndex, 0)
                    : FormatCaptureCursor(DbSyncCapturePhase.Baseline, 0, 0),
                false,
                null);
        }

        if (cursor.Phase == DbSyncCapturePhase.Baseline)
        {
            var rows = LoadBaselinePage(connection, providerId, cursor.Offset, limit + 1);
            var hasMore = rows.Count > limit;
            if (hasMore)
            {
                rows.RemoveAt(rows.Count - 1);
            }
            return new DbSyncCapturePage(
                true,
                [],
                rows,
                [],
                hasMore
                    ? FormatCaptureCursor(DbSyncCapturePhase.Baseline, 0, cursor.Offset + rows.Count)
                    : FormatCaptureCursor(DbSyncCapturePhase.Tombstones, 0, 0),
                false,
                null);
        }

        var tombstones = LoadTombstonesPage(connection, providerId, cursor.Offset, limit + 1);
        var moreTombstones = tombstones.Count > limit;
        if (moreTombstones)
        {
            tombstones.RemoveAt(tombstones.Count - 1);
        }
        return new DbSyncCapturePage(
            true,
            [],
            [],
            tombstones,
            moreTombstones
                ? FormatCaptureCursor(DbSyncCapturePhase.Tombstones, 0, cursor.Offset + tombstones.Count)
                : null,
            !moreTombstones,
            null);
    }

    private static List<DbSyncCapturedRecord> CaptureTablePage(
        SqliteConnection connection,
        DbSyncTableSchema schema,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            $"SELECT * FROM {QuoteIdent(schema.Name)} " +
            $"ORDER BY {string.Join(", ", schema.PkColumns.Select(QuoteIdent))} " +
            "LIMIT $limit OFFSET $offset";
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        using var reader = command.ExecuteReader();
        var rows = new List<DbSyncCapturedRecord>(limit);
        while (reader.Read())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var columns = new List<DbSyncCapturedColumn>(reader.FieldCount);
            var primaryKeyValues = new Dictionary<string, object?>(StringComparer.Ordinal);
            long? updatedAt = null;
            for (var index = 0; index < reader.FieldCount; index++)
            {
                var name = reader.GetName(index);
                var value = reader.IsDBNull(index) ? null : reader.GetValue(index);
                columns.Add(new DbSyncCapturedColumn(name, value));
                if (schema.PkColumns.Contains(name, StringComparer.Ordinal))
                {
                    primaryKeyValues[name] = value;
                }
                if (name == "updated_at" || (updatedAt is null && name == "created_at"))
                {
                    updatedAt = TryReadInt64(value, out var timestamp) ? timestamp : updatedAt;
                }
            }

            rows.Add(new DbSyncCapturedRecord(
                DbDomain(schema.Name),
                NormalizeRecordId(schema.PkColumns.Select(column => primaryKeyValues[column])),
                schema.Name,
                columns,
                updatedAt));
        }
        return rows;
    }

    private static List<DbSyncBaselineRecordState> LoadBaselinePage(
        SqliteConnection connection,
        string providerId,
        int offset,
        int limit)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT domain, record_id, content_hash
              FROM sync_record_state
             WHERE provider_id = $providerId
             ORDER BY domain ASC, record_id ASC
             LIMIT $limit OFFSET $offset
            """;
        command.Parameters.AddWithValue("$providerId", providerId);
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        using var reader = command.ExecuteReader();
        var rows = new List<DbSyncBaselineRecordState>(limit);
        while (reader.Read())
        {
            rows.Add(new DbSyncBaselineRecordState
            {
                Domain = reader.GetString(0),
                RecordId = reader.GetString(1),
                ContentHash = reader.GetString(2)
            });
        }
        return rows;
    }

    private static List<DbSyncTombstone> LoadTombstonesPage(
        SqliteConnection connection,
        string providerId,
        int offset,
        int limit)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT domain, record_id, deleted_at, origin_device_id
              FROM sync_tombstones
             WHERE provider_id = $providerId
             ORDER BY domain ASC, record_id ASC
             LIMIT $limit OFFSET $offset
            """;
        command.Parameters.AddWithValue("$providerId", providerId);
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        using var reader = command.ExecuteReader();
        var rows = new List<DbSyncTombstone>(limit);
        while (reader.Read())
        {
            rows.Add(new DbSyncTombstone
            {
                Domain = reader.GetString(0),
                RecordId = reader.GetString(1),
                DeletedAt = reader.GetInt64(2),
                OriginDeviceId = reader.GetString(3)
            });
        }
        return rows;
    }

    private static WorkerResponse WriteCapturePage(DbSyncCapturePage page)
    {
        return WorkerResponse.DirectMessagePack(writer =>
        {
            writer.WriteMapHeader(7);
            writer.WriteString("success");
            writer.WriteBoolean(page.Success);
            writer.WriteString("records");
            writer.WriteArrayHeader(page.Records.Count);
            foreach (var record in page.Records)
            {
                WriteCapturedRecord(writer, record);
            }
            writer.WriteString("baseline");
            writer.WriteArrayHeader(page.Baseline.Count);
            foreach (var baseline in page.Baseline)
            {
                writer.WriteMapHeader(3);
                writer.WriteString("domain");
                writer.WriteString(baseline.Domain);
                writer.WriteString("recordId");
                writer.WriteString(baseline.RecordId);
                writer.WriteString("contentHash");
                writer.WriteString(baseline.ContentHash);
            }
            writer.WriteString("tombstones");
            writer.WriteArrayHeader(page.Tombstones.Count);
            foreach (var tombstone in page.Tombstones)
            {
                writer.WriteMapHeader(4);
                writer.WriteString("domain");
                writer.WriteString(tombstone.Domain);
                writer.WriteString("recordId");
                writer.WriteString(tombstone.RecordId);
                writer.WriteString("deletedAt");
                writer.WriteInt64(tombstone.DeletedAt);
                writer.WriteString("originDeviceId");
                writer.WriteString(tombstone.OriginDeviceId);
            }
            writer.WriteString("nextCursor");
            if (page.NextCursor is { Length: > 0 })
            {
                writer.WriteString(page.NextCursor);
            }
            else
            {
                writer.WriteNil();
            }
            writer.WriteString("done");
            writer.WriteBoolean(page.Done);
            writer.WriteString("error");
            if (page.Error is { Length: > 0 })
            {
                writer.WriteString(page.Error);
            }
            else
            {
                writer.WriteNil();
            }
        });
    }

    private static void WriteCapturedRecord(
        WorkerMessagePackWriter writer,
        DbSyncCapturedRecord record)
    {
        writer.WriteMapHeader(4);
        writer.WriteString("domain");
        writer.WriteString(record.Domain);
        writer.WriteString("recordId");
        writer.WriteString(record.RecordId);
        writer.WriteString("value");
        writer.WriteMapHeader(2);
        writer.WriteString("table");
        writer.WriteString(record.TableName);
        writer.WriteString("row");
        writer.WriteMapHeader(record.Columns.Count);
        foreach (var column in record.Columns)
        {
            writer.WriteString(column.Name);
            WriteSqliteMessagePackValue(writer, column.Value);
        }
        writer.WriteString("updatedAt");
        if (record.UpdatedAt.HasValue)
        {
            writer.WriteInt64(record.UpdatedAt.Value);
        }
        else
        {
            writer.WriteNil();
        }
    }

    private static void WriteSqliteMessagePackValue(WorkerMessagePackWriter writer, object? value)
    {
        switch (value)
        {
            case null:
            case DBNull:
                writer.WriteNil();
                break;
            case long longValue:
                writer.WriteInt64(longValue);
                break;
            case int intValue:
                writer.WriteInt64(intValue);
                break;
            case short shortValue:
                writer.WriteInt64(shortValue);
                break;
            case byte byteValue:
                writer.WriteUInt64(byteValue);
                break;
            case double doubleValue:
                writer.WriteDouble(doubleValue);
                break;
            case float floatValue:
                writer.WriteDouble(floatValue);
                break;
            case byte[] bytes:
                writer.WriteString(Convert.ToBase64String(bytes));
                break;
            default:
                writer.WriteString(Convert.ToString(
                    value,
                    System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty);
                break;
        }
    }

    private static DbSyncCaptureCursor ParseCaptureCursor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return new DbSyncCaptureCursor(DbSyncCapturePhase.Records, 0, 0);
        }

        var parts = value.Split(':');
        if (parts.Length != 3 ||
            !int.TryParse(parts[1], out var tableIndex) ||
            !int.TryParse(parts[2], out var offset) ||
            tableIndex < 0 ||
            offset < 0)
        {
            throw new InvalidOperationException("Invalid DB sync capture cursor.");
        }

        var phase = parts[0] switch
        {
            "r" => DbSyncCapturePhase.Records,
            "b" => DbSyncCapturePhase.Baseline,
            "t" => DbSyncCapturePhase.Tombstones,
            _ => throw new InvalidOperationException("Invalid DB sync capture cursor phase.")
        };
        return new DbSyncCaptureCursor(phase, tableIndex, offset);
    }

    private static string FormatCaptureCursor(
        DbSyncCapturePhase phase,
        int tableIndex,
        int offset)
    {
        var prefix = phase switch
        {
            DbSyncCapturePhase.Records => "r",
            DbSyncCapturePhase.Baseline => "b",
            _ => "t"
        };
        return $"{prefix}:{tableIndex}:{offset}";
    }

    private static int UpsertDbRecord(
        SqliteConnection connection,
        SqliteTransaction transaction,
        DbSyncTableSchema schema,
        DbSyncRecordDraft record)
    {
        if (record.Value.ValueKind != JsonValueKind.Object
            || !record.Value.TryGetProperty("row", out var row)
            || row.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException($"Invalid DB sync record for {record.Domain}");
        }

        var conflictColumns = string.Join(", ", schema.PkColumns.Select(QuoteIdent));
        var updateColumns = schema.Columns
            .Where(column => !schema.PkColumns.Contains(column, StringComparer.Ordinal))
            .ToList();
        var sql =
            $"INSERT INTO {QuoteIdent(schema.Name)} ({string.Join(", ", schema.Columns.Select(QuoteIdent))}) " +
            $"VALUES ({string.Join(", ", schema.Columns.Select((_, index) => $"$v{index}"))}) " +
            $"ON CONFLICT({conflictColumns}) DO " +
            (updateColumns.Count > 0
                ? $"UPDATE SET {string.Join(", ", updateColumns.Select(column => $"{QuoteIdent(column)} = excluded.{QuoteIdent(column)}"))}"
                : "NOTHING");

        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        for (var index = 0; index < schema.Columns.Count; index++)
        {
            var column = schema.Columns[index];
            var value = row.TryGetProperty(column, out var property) ? ReadJsonValue(property) : null;
            command.Parameters.AddWithValue($"$v{index}", value ?? DBNull.Value);
        }
        return command.ExecuteNonQuery();
    }

    private static int DeleteDbRecord(
        SqliteConnection connection,
        SqliteTransaction transaction,
        DbSyncTableSchema schema,
        string recordId)
    {
        var pkValues = ParseRecordId(recordId);
        if (pkValues.Count != schema.PkColumns.Count)
        {
            throw new InvalidOperationException($"Invalid record id for {schema.Name}");
        }

        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            $"DELETE FROM {QuoteIdent(schema.Name)} WHERE {string.Join(" AND ", schema.PkColumns.Select((column, index) => $"{QuoteIdent(column)} = $pk{index}"))}";
        for (var index = 0; index < pkValues.Count; index++)
        {
            command.Parameters.AddWithValue($"$pk{index}", pkValues[index] ?? DBNull.Value);
        }
        return command.ExecuteNonQuery();
    }

    private static List<DbSyncRecordDraft> ReadRecordDrafts(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Array)
        {
            return new List<DbSyncRecordDraft>();
        }

        var records = new List<DbSyncRecordDraft>();
        foreach (var item in property.EnumerateArray())
        {
            records.Add(new DbSyncRecordDraft
            {
                Domain = RequireString(item, "domain"),
                RecordId = RequireString(item, "recordId"),
                Value = item.GetProperty("value").Clone(),
                UpdatedAt = JsonHelpers.GetLongNullable(item, "updatedAt")
            });
        }
        return records;
    }

    private static List<DbSyncTombstone> ReadTombstones(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Array)
        {
            return new List<DbSyncTombstone>();
        }

        var tombstones = new List<DbSyncTombstone>();
        foreach (var item in property.EnumerateArray())
        {
            tombstones.Add(new DbSyncTombstone
            {
                Domain = RequireString(item, "domain"),
                RecordId = RequireString(item, "recordId"),
                DeletedAt = JsonHelpers.GetLong(item, "deletedAt", 0),
                OriginDeviceId = JsonHelpers.GetString(item, "originDeviceId") ?? string.Empty
            });
        }
        return tombstones;
    }

    private static List<MetadataRecord> ReadMetadataRecords(JsonElement parameters, string name)
    {
        if (!parameters.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Array)
        {
            return new List<MetadataRecord>();
        }

        var records = new List<MetadataRecord>();
        foreach (var item in property.EnumerateArray())
        {
            records.Add(new MetadataRecord(
                RequireString(item, "domain"),
                RequireString(item, "recordId"),
                RequireString(item, "hash")));
        }
        return records;
    }

    private static IEnumerable<T> OrderByTable<T>(
        IEnumerable<T> items,
        IReadOnlyList<string> tableOrder,
        bool reverse) where T : DbSyncTableRecord
    {
        var order = reverse ? tableOrder.Reverse().ToList() : tableOrder.ToList();
        var orderIndex = order
            .Select((table, index) => (table, index))
            .ToDictionary(item => item.table, item => item.index, StringComparer.Ordinal);

        return items.OrderBy(item =>
            {
                var table = TableFromDomain(item.Domain);
                return table is not null && orderIndex.TryGetValue(table, out var index) ? index : 20_000;
            })
            .ThenBy(item => $"{item.Domain}{KeySeparator}{item.RecordId}", StringComparer.Ordinal);
    }

    private static string NormalizeRecordId(IEnumerable<object?> pkValues)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var value in pkValues)
            {
                WriteSqliteJsonValue(writer, value);
            }
            writer.WriteEndArray();
        }

        return System.Text.Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteSqliteJsonValue(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
            case DBNull:
                writer.WriteNullValue();
                break;
            case long longValue:
                writer.WriteNumberValue(longValue);
                break;
            case int intValue:
                writer.WriteNumberValue(intValue);
                break;
            case short shortValue:
                writer.WriteNumberValue(shortValue);
                break;
            case byte byteValue:
                writer.WriteNumberValue(byteValue);
                break;
            case double doubleValue:
                writer.WriteNumberValue(doubleValue);
                break;
            case float floatValue:
                writer.WriteNumberValue(floatValue);
                break;
            case byte[] bytes:
                writer.WriteBase64StringValue(bytes);
                break;
            default:
                writer.WriteStringValue(Convert.ToString(
                    value,
                    System.Globalization.CultureInfo.InvariantCulture));
                break;
        }
    }

    private static List<object?> ParseRecordId(string recordId)
    {
        using var document = JsonDocument.Parse(recordId);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            return new List<object?> { ReadJsonValue(document.RootElement) };
        }

        var values = new List<object?>();
        foreach (var item in document.RootElement.EnumerateArray())
        {
            values.Add(ReadJsonValue(item));
        }
        return values;
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

    private static bool TryReadInt64(object? value, out long result)
    {
        if (value is not null && long.TryParse(
            Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture),
            out result))
        {
            return true;
        }
        result = 0;
        return false;
    }

    private enum DbSyncCapturePhase
    {
        Records,
        Baseline,
        Tombstones
    }

    private sealed record DbSyncCaptureCursor(
        DbSyncCapturePhase Phase,
        int TableIndex,
        int Offset);

    private sealed record DbSyncCapturePage(
        bool Success,
        List<DbSyncCapturedRecord> Records,
        List<DbSyncBaselineRecordState> Baseline,
        List<DbSyncTombstone> Tombstones,
        string? NextCursor,
        bool Done,
        string? Error);

    private static string DbDomain(string tableName)
    {
        return $"{DbDomainPrefix}{tableName}";
    }

    private static string? TableFromDomain(string domain)
    {
        return domain.StartsWith(DbDomainPrefix, StringComparison.Ordinal)
            ? domain[DbDomainPrefix.Length..]
            : null;
    }

    private static string QuoteIdent(string value)
    {
        return $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new DbSyncMutationResult(true, changed, null),
            WorkerJsonContext.Default.DbSyncMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new DbSyncMutationResult(false, 0, error),
            WorkerJsonContext.Default.DbSyncMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        var value = JsonHelpers.GetString(parameters, name);
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException($"Missing required string parameter: {name}");
        }
        return value;
    }

    private sealed record ColumnInfo(string Name, int Pk);

    private sealed record MetadataRecord(
        string Domain,
        string RecordId,
        string ContentHash);
}
