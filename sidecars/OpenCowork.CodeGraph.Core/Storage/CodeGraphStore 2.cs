using System.Text.Json;
using Microsoft.Data.Sqlite;

// The CORE of the CodeGraph query layer ≙ CodeGraph TS QueryBuilder (queries.ts).
// This is a `partial` class: the CRUD / Search / Graph slices add
// `partial class CodeGraphStore` files (Nodes / Edges / Files / Refs / Search /
// Stats) that build on the shared state and helpers declared here.
//
// This file owns: the single long-lived SqliteConnection, the LRU node cache
// (max 1000, move-to-end eviction), a tracked-command registry for lazily-prepared
// reusable statements, the chunk-500 constant, the $param binder, the BY-ORDINAL
// row mappers, the string[] JSON-column codec, and Dispose.
//
// Concurrency: Microsoft.Data.Sqlite is not thread-safe per connection. This store
// assumes serialized access (the worker dispatches RPCs; an index run is the only
// concurrency, and it must be serialized by the owner). Do not touch a store from
// two threads.
internal sealed partial class CodeGraphStore : IDisposable
{
    // Guards every IN-list against SQLITE_MAX_VARIABLE_NUMBER. Backend-agnostic and
    // safe across better-sqlite3 (32766) and Microsoft.Data.Sqlite (compiled
    // default) — the N+1 killer's batching bound (queries.ts:51).
    internal const int ChunkSize = 500;

    // LRU node-cache capacity (queries.ts:202).
    internal const int MaxNodeCacheSize = 1000;

    // ------------------------------------------------------------------
    // Canonical column projections. The BY-ORDINAL row mappers below read these
    // exact orders, so every SELECT feeding a mapper MUST project these column
    // lists (e.g. `SELECT {NodeColumns} FROM nodes ...`). NodeColumns / FileColumns
    // happen to equal table-definition order (so `SELECT *` is equivalent for
    // those), but EdgeColumns deliberately OMITS the surrogate edges.id, so use the
    // constant rather than `SELECT *` for edges.
    // ------------------------------------------------------------------
    internal const string NodeColumns =
        "id, kind, name, qualified_name, file_path, language, " +
        "start_line, end_line, start_column, end_column, " +
        "docstring, signature, visibility, " +
        "is_exported, is_async, is_static, is_abstract, " +
        "decorators, type_parameters, return_type, updated_at";

    internal const string EdgeColumns =
        "source, target, kind, metadata, line, col, provenance";

    internal const string FileColumns =
        "path, content_hash, language, size, modified_at, indexed_at, node_count, errors";

    internal const string UnresolvedColumns =
        "id, from_node_id, reference_name, reference_kind, line, col, " +
        "candidates, file_path, language, status, name_tail";

    private readonly SqliteConnection connection;
    private readonly CodeGraphLruCache<string, CodeGraphNode> nodeCache;
    private readonly List<SqliteCommand> trackedCommands = new();
    private bool disposed;

    public CodeGraphStore(SqliteConnection connection)
    {
        this.connection = connection ?? throw new ArgumentNullException(nameof(connection));
        nodeCache = new CodeGraphLruCache<string, CodeGraphNode>(MaxNodeCacheSize);
    }

    // The live connection — for ad-hoc dynamic SQL (chunked IN-lists, optional
    // `kind IN (...)` clauses) the slices build per-call, and for transactions.
    internal SqliteConnection Connection => connection;

    // The LRU node cache. The Nodes slice serves getNodeById / getNodesByIds from it
    // (cache-first, LRU touch) and invalidates it on every write path.
    internal CodeGraphLruCache<string, CodeGraphNode> NodeCache => nodeCache;

    // ------------------------------------------------------------------
    // Prepared-statement / transaction plumbing
    // ------------------------------------------------------------------

    // Create a command bound to the connection and REGISTER it for disposal. Use
    // for the lazily-prepared reusable statements a slice caches in a field (the
    // analog of the TS `stmts` bag): call once, add params + Prepare(), then reuse.
    // For dynamic-arity SQL prefer `using var cmd = Connection.CreateCommand()`.
    internal SqliteCommand CreateTrackedCommand(string commandText)
    {
        var command = connection.CreateCommand();
        command.CommandText = commandText;
        trackedCommands.Add(command);
        return command;
    }

    internal SqliteTransaction BeginTransaction() => connection.BeginTransaction();

    // Wrap a batch writer in one implicit BEGIN...COMMIT (the TS db.transaction(fn)()
    // idiom). Rolls back automatically if `body` throws (the using-scope disposes an
    // uncommitted transaction).
    internal void InTransaction(Action<SqliteTransaction> body)
    {
        using var transaction = connection.BeginTransaction();
        body(transaction);
        transaction.Commit();
    }

    internal T InTransaction<T>(Func<SqliteTransaction, T> body)
    {
        using var transaction = connection.BeginTransaction();
        var result = body(transaction);
        transaction.Commit();
        return result;
    }

    // One-off parameterized non-query (mirrors the worker's DbSql.ExecuteNonQuery).
    internal int ExecuteNonQuery(string sql, params CodeGraphSqlParam[] parameters) =>
        ExecuteNonQuery(null, sql, parameters);

    // ------------------------------------------------------------------
    // Fast-init FTS bulk mode (M7-W2, upstream fast-init)
    // ------------------------------------------------------------------

    private bool ftsBulkActive;

    // Drop the FTS mirror triggers for a FRESH bulk index: per-row FTS maintenance is
    // a large share of bulk insert cost, and the external-content index can be
    // re-derived from `nodes` in one 'rebuild' pass at the end. ONLY correct when the
    // nodes table starts empty under the caller (fresh DB) — an existing FTS index
    // would go stale for rows written outside the bulk window.
    internal void BeginFtsBulk()
    {
        ExecuteNonQuery("DROP TRIGGER IF EXISTS nodes_ai");
        ExecuteNonQuery("DROP TRIGGER IF EXISTS nodes_ad");
        ExecuteNonQuery("DROP TRIGGER IF EXISTS nodes_au");
        ftsBulkActive = true;
    }

    // Rebuild nodes_fts from `nodes` once and re-arm the triggers (schema fold is
    // idempotent). Safe to call unconditionally — a no-op unless BeginFtsBulk ran.
    internal void EndFtsBulk()
    {
        if (!ftsBulkActive)
        {
            return;
        }

        ftsBulkActive = false;
        ExecuteNonQuery("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
        CodeGraphSchema.Initialize(connection);
    }

    internal int ExecuteNonQuery(
        SqliteTransaction? transaction,
        string sql,
        params CodeGraphSqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        if (transaction is not null)
        {
            command.Transaction = transaction;
        }

        command.CommandText = sql;
        BindParameters(command, parameters);
        return command.ExecuteNonQuery();
    }

    internal long ExecuteScalarLong(string sql, params CodeGraphSqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        BindParameters(command, parameters);
        var value = command.ExecuteScalar();
        return value is null || value == DBNull.Value ? 0 : Convert.ToInt64(value);
    }

    internal string? ExecuteScalarString(string sql, params CodeGraphSqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        BindParameters(command, parameters);
        return command.ExecuteScalar() as string;
    }

    // The shared $param binder. Named params (`$name` / `@name`) bind by name; a
    // null Value becomes DBNull so nullable columns store NULL, not "".
    internal static void BindParameters(SqliteCommand command, CodeGraphSqlParam[] parameters)
    {
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }
    }

    // ------------------------------------------------------------------
    // BY-ORDINAL row mappers (never reflection). Each expects its matching column
    // projection constant above. Nullable columns go through the Read* helpers;
    // booleans read the is_* INTEGER(0/1) columns; string[] columns go through the
    // JSON codec. TS→DB name drift is bridged here (edges.col → Column,
    // unresolved_refs.col → Column).
    // ------------------------------------------------------------------
    internal static CodeGraphNode RowToNode(SqliteDataReader reader) => new(
        Id: reader.GetString(0),
        Kind: reader.GetString(1),
        Name: reader.GetString(2),
        QualifiedName: reader.GetString(3),
        FilePath: reader.GetString(4),
        Language: reader.GetString(5),
        StartLine: reader.GetInt32(6),
        EndLine: reader.GetInt32(7),
        StartColumn: reader.GetInt32(8),
        EndColumn: reader.GetInt32(9),
        Docstring: ReadNullableString(reader, 10),
        Signature: ReadNullableString(reader, 11),
        Visibility: ReadNullableString(reader, 12),
        IsExported: ReadBool(reader, 13),
        IsAsync: ReadBool(reader, 14),
        IsStatic: ReadBool(reader, 15),
        IsAbstract: ReadBool(reader, 16),
        Decorators: DeserializeStringList(ReadNullableString(reader, 17)),
        TypeParameters: DeserializeStringList(ReadNullableString(reader, 18)),
        ReturnType: ReadNullableString(reader, 19),
        UpdatedAt: reader.GetInt64(20));

    internal static CodeGraphEdge RowToEdge(SqliteDataReader reader) => new(
        Source: reader.GetString(0),
        Target: reader.GetString(1),
        Kind: reader.GetString(2),
        Metadata: ReadNullableString(reader, 3), // RAW JSON string, kept verbatim
        Line: ReadNullableInt(reader, 4),
        Column: ReadNullableInt(reader, 5), // edges.col
        Provenance: ReadNullableString(reader, 6));

    internal static CodeGraphFileRecord RowToFileRecord(SqliteDataReader reader) => new(
        Path: reader.GetString(0),
        ContentHash: reader.GetString(1),
        Language: reader.GetString(2),
        Size: reader.GetInt64(3),
        ModifiedAt: reader.GetInt64(4),
        IndexedAt: reader.GetInt64(5),
        NodeCount: reader.GetInt32(6),
        Errors: ReadNullableString(reader, 7)); // RAW JSON string, kept verbatim

    internal static CodeGraphUnresolvedReference RowToUnresolvedRef(SqliteDataReader reader) => new(
        FromNodeId: reader.GetString(1),
        ReferenceName: reader.GetString(2),
        ReferenceKind: reader.GetString(3),
        Line: reader.GetInt32(4),
        Column: reader.GetInt32(5), // unresolved_refs.col
        FilePath: ReadNullableString(reader, 7),
        Language: ReadNullableString(reader, 8),
        Candidates: DeserializeStringList(ReadNullableString(reader, 6)),
        RowId: reader.GetInt64(0), // unresolved_refs.id — precise-cleanup target
        Status: reader.GetString(9),
        NameTail: reader.GetString(10));

    // ------------------------------------------------------------------
    // BY-ORDINAL null-safe column readers (reusable by partial slices for their own
    // narrow projections).
    // ------------------------------------------------------------------
    internal static string? ReadNullableString(SqliteDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    internal static int? ReadNullableInt(SqliteDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);

    internal static long? ReadNullableLong(SqliteDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal);

    // is_* columns are INTEGER DEFAULT 0; treat NULL as false defensively.
    internal static bool ReadBool(SqliteDataReader reader, int ordinal) =>
        !reader.IsDBNull(ordinal) && reader.GetInt64(ordinal) != 0;

    // ------------------------------------------------------------------
    // string[] JSON-column codec (reflection-free via CodeGraphJsonContext source-
    // gen). Covers nodes.decorators / nodes.type_parameters / unresolved_refs.
    // candidates. Opaque metadata / errors are NOT handled here — they are kept as
    // raw strings on the domain types.
    // ------------------------------------------------------------------
    internal static IReadOnlyList<string>? DeserializeStringList(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(json, CodeGraphJsonContext.Default.ListString);
        }
        catch (JsonException)
        {
            // Mirror safeJsonParse(row, undefined): a malformed column degrades to
            // "no value" — a row mapper must never throw on bad stored JSON.
            return null;
        }
    }

    // null -> null (column stays NULL); any list (even empty) -> its JSON text,
    // matching the TS `values ? JSON.stringify(values) : null`.
    internal static string? SerializeStringList(IReadOnlyList<string>? values)
    {
        if (values is null)
        {
            return null;
        }

        var list = values as List<string> ?? new List<string>(values);
        return JsonSerializer.Serialize(list, CodeGraphJsonContext.Default.ListString);
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;

        foreach (var command in trackedCommands)
        {
            command.Dispose();
        }

        trackedCommands.Clear();
        nodeCache.Clear();
        connection.Dispose();
    }
}

// The shared $param binder's value carrier (mirrors the worker's DbSql.SqlParam).
// A readonly record struct so batch writers can build param arrays cheaply.
internal readonly record struct CodeGraphSqlParam(string Name, object? Value);
