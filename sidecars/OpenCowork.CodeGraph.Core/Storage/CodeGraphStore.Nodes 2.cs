using System.Text;
using Microsoft.Data.Sqlite;

// CodeGraphStore — node CRUD + point/kind/name reads (≙ queries.ts Node Operations).
//
// Write paths use lazily-prepared, reused SqliteCommands (the analog of the TS
// `stmts` bag) because the bulk-index inner loop runs these millions of times;
// each call rebinds parameter VALUES on the already-compiled statement. Reads and
// one-off writes use fresh per-call commands (the DbProjectTools idiom) — SQLite's
// re-prepare on a simple SELECT is cheap and the code stays legible. Dynamic
// IN-list SQL (the N+1 killer) is always ad-hoc and chunked at ChunkSize (500).
internal sealed partial class CodeGraphStore
{
    private const string InsertNodeSql = """
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, return_type, updated_at
        ) VALUES (
          $id, $kind, $name, $qualifiedName, $filePath, $language,
          $startLine, $endLine, $startColumn, $endColumn,
          $docstring, $signature, $visibility,
          $isExported, $isAsync, $isStatic, $isAbstract,
          $decorators, $typeParameters, $returnType, $updatedAt
        )
        """;

    private const string UpdateNodeSql = """
        UPDATE nodes SET
          kind = $kind,
          name = $name,
          qualified_name = $qualifiedName,
          file_path = $filePath,
          language = $language,
          start_line = $startLine,
          end_line = $endLine,
          start_column = $startColumn,
          end_column = $endColumn,
          docstring = $docstring,
          signature = $signature,
          visibility = $visibility,
          is_exported = $isExported,
          is_async = $isAsync,
          is_static = $isStatic,
          is_abstract = $isAbstract,
          decorators = $decorators,
          type_parameters = $typeParameters,
          return_type = $returnType,
          updated_at = $updatedAt
        WHERE id = $id
        """;

    private SqliteCommand? insertNodeCommand;
    private SqliteCommand? updateNodeCommand;

    private SqliteCommand InsertNodeCommand =>
        insertNodeCommand ??= BuildPreparedCommand(InsertNodeSql, NodeParamSpecs);

    private SqliteCommand UpdateNodeCommand =>
        updateNodeCommand ??= BuildPreparedCommand(UpdateNodeSql, NodeParamSpecs);

    private static readonly (string Name, SqliteType Type)[] NodeParamSpecs =
    {
        ("$id", SqliteType.Text), ("$kind", SqliteType.Text), ("$name", SqliteType.Text),
        ("$qualifiedName", SqliteType.Text), ("$filePath", SqliteType.Text),
        ("$language", SqliteType.Text), ("$startLine", SqliteType.Integer),
        ("$endLine", SqliteType.Integer), ("$startColumn", SqliteType.Integer),
        ("$endColumn", SqliteType.Integer), ("$docstring", SqliteType.Text),
        ("$signature", SqliteType.Text), ("$visibility", SqliteType.Text),
        ("$isExported", SqliteType.Integer), ("$isAsync", SqliteType.Integer),
        ("$isStatic", SqliteType.Integer), ("$isAbstract", SqliteType.Integer),
        ("$decorators", SqliteType.Text), ("$typeParameters", SqliteType.Text),
        ("$returnType", SqliteType.Text), ("$updatedAt", SqliteType.Integer)
    };

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    // INSERT OR REPLACE (queries.ts:270). Validates the NOT-NULL keys first, then
    // invalidates the cache (a REPLACE may overwrite a cached row), then writes,
    // then materializes the segment vocabulary for segmentable kinds.
    public void InsertNode(CodeGraphNode node) => InsertNodeCore(node, null);

    // One implicit BEGIN..COMMIT around the whole batch (queries.ts:370).
    public void InsertNodes(IReadOnlyList<CodeGraphNode> nodes)
    {
        if (nodes.Count == 0)
        {
            return;
        }

        InTransaction(transaction =>
        {
            foreach (var node in nodes)
            {
                InsertNodeCore(node, transaction);
            }
        });
    }

    private void InsertNodeCore(CodeGraphNode node, SqliteTransaction? transaction)
    {
        // Validate required fields BEFORE touching the cache (queries.ts:290) — a
        // malformed node is skipped, not written and not cache-invalidated.
        if (!HasRequiredNodeFields(node))
        {
            return;
        }

        NodeCache.Remove(node.Id);

        var command = InsertNodeCommand;
        command.Transaction = transaction;
        BindNodeParameters(command, node);
        command.ExecuteNonQuery();

        if (IsSegmentableKind(node.Kind))
        {
            InsertNameSegments(node.Name, transaction);
        }
    }

    // UPDATE ... WHERE id (queries.ts:381). A second real write path to `nodes`
    // (framework rename passes), so it also feeds the segment vocabulary (#1141).
    // Matches the TS ordering: invalidate cache BEFORE the required-field guard.
    public void UpdateNode(CodeGraphNode node) => UpdateNodeCore(node, null);

    private void UpdateNodeCore(CodeGraphNode node, SqliteTransaction? transaction)
    {
        NodeCache.Remove(node.Id);

        if (!HasRequiredNodeFields(node))
        {
            return;
        }

        var command = UpdateNodeCommand;
        command.Transaction = transaction;
        BindNodeParameters(command, node);
        command.ExecuteNonQuery();

        if (IsSegmentableKind(node.Kind))
        {
            InsertNameSegments(node.Name, transaction);
        }
    }

    // DELETE by id (+ cache invalidate). queries.ts:456.
    public void DeleteNode(string id)
    {
        NodeCache.Remove(id);
        ExecuteNonQuery("DELETE FROM nodes WHERE id = $id", new CodeGraphSqlParam("$id", id));
    }

    // DELETE all nodes for a file (+ sweep the cache of that file's nodes).
    // queries.ts:468. FK ON DELETE CASCADE reaps the file's edges/unresolved refs.
    public void DeleteNodesByFile(string filePath) => DeleteNodesByFileCore(filePath, null);

    internal void DeleteNodesByFileCore(string filePath, SqliteTransaction? transaction)
    {
        NodeCache.RemoveWhere((_, node) => node.FilePath == filePath);
        ExecuteNonQuery(
            transaction,
            "DELETE FROM nodes WHERE file_path = $filePath",
            new CodeGraphSqlParam("$filePath", filePath));
    }

    // ------------------------------------------------------------------
    // Point / batch reads
    // ------------------------------------------------------------------

    // Cache-first single lookup (queries.ts:582). A hit is LRU-touched by TryGet.
    public CodeGraphNode? GetNodeById(string id)
    {
        if (NodeCache.TryGet(id, out var cached))
        {
            return cached;
        }

        using var command = Connection.CreateCommand();
        command.CommandText = $"SELECT {NodeColumns} FROM nodes WHERE id = $id";
        command.Parameters.AddWithValue("$id", id);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        var node = RowToNode(reader);
        NodeCache.Set(node.Id, node);
        return node;
    }

    // The N+1 killer (queries.ts:620): one IN-list round-trip per 500-id chunk,
    // cache hits served from memory (and LRU-touched), the SQL only touching the
    // misses. Returns a Dictionary keyed by id (insertion-ordered, add-only) so
    // callers keep their own edge ordering; absent ids are simply missing.
    public Dictionary<string, CodeGraphNode> GetNodesByIds(IReadOnlyList<string> ids)
    {
        var output = new Dictionary<string, CodeGraphNode>();
        if (ids.Count == 0)
        {
            return output;
        }

        var misses = new List<string>();
        foreach (var id in ids)
        {
            if (NodeCache.TryGet(id, out var cached))
            {
                output[id] = cached;
            }
            else
            {
                misses.Add(id);
            }
        }

        if (misses.Count == 0)
        {
            return output;
        }

        for (var i = 0; i < misses.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, misses.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, misses, i, length);
            command.CommandText = $"SELECT {NodeColumns} FROM nodes WHERE id IN ({placeholders})";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var node = RowToNode(reader);
                output[node.Id] = node;
                NodeCache.Set(node.Id, node);
            }
        }

        return output;
    }

    // Existence probe against the LIVE nodes table (NOT the LRU cache — a stale
    // cache would admit dangling edges). Chunked at 500. queries.ts:657.
    private HashSet<string> GetExistingNodeIds(
        IReadOnlyList<string> ids,
        SqliteTransaction? transaction)
    {
        var output = new HashSet<string>();
        if (ids.Count == 0)
        {
            return output;
        }

        var unique = new List<string>(new HashSet<string>(ids));
        for (var i = 0; i < unique.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, unique.Count - i);
            using var command = Connection.CreateCommand();
            command.Transaction = transaction;
            var placeholders = BindInList(command, unique, i, length);
            command.CommandText = $"SELECT id FROM nodes WHERE id IN ({placeholders})";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                output.Add(reader.GetString(0));
            }
        }

        return output;
    }

    // ------------------------------------------------------------------
    // Kind / name / file reads
    // ------------------------------------------------------------------

    public List<CodeGraphNode> GetNodesByFile(string filePath) =>
        QueryNodes(
            $"SELECT {NodeColumns} FROM nodes WHERE file_path = $filePath ORDER BY start_line",
            new CodeGraphSqlParam("$filePath", filePath));

    public List<CodeGraphNode> GetNodesByKind(string kind) =>
        QueryNodes(
            $"SELECT {NodeColumns} FROM nodes WHERE kind = $kind",
            new CodeGraphSqlParam("$kind", kind));

    // TRUE streaming (queries.ts:880): a fresh command/reader per call so the open
    // cursor never clashes with another query, and memory stays O(1) in node count.
    public IEnumerable<CodeGraphNode> IterateNodesByKind(string kind)
    {
        using var command = Connection.CreateCommand();
        command.CommandText = $"SELECT {NodeColumns} FROM nodes WHERE kind = $kind";
        command.Parameters.AddWithValue("$kind", kind);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            yield return RowToNode(reader);
        }
    }

    public List<CodeGraphNode> GetNodesByName(string name) =>
        QueryNodes(
            $"SELECT {NodeColumns} FROM nodes WHERE name = $name",
            new CodeGraphSqlParam("$name", name));

    // Prefix match by index RANGE SCAN (queries.ts:943): `name >= p AND name < p+'￿'`
    // keeps idx_nodes_name usable, which SQLite's default case-insensitive LIKE would not.
    public List<CodeGraphNode> GetNodesByNamePrefix(string prefix, int limit = 20) =>
        QueryNodes(
            $"SELECT {NodeColumns} FROM nodes WHERE name >= $prefix AND name < $upper ORDER BY name LIMIT $limit",
            new CodeGraphSqlParam("$prefix", prefix),
            new CodeGraphSqlParam("$upper", prefix + '￿'),
            new CodeGraphSqlParam("$limit", limit));

    public List<CodeGraphNode> GetNodesByQualifiedNameExact(string qualifiedName) =>
        QueryNodes(
            $"SELECT {NodeColumns} FROM nodes WHERE qualified_name = $qualifiedName",
            new CodeGraphSqlParam("$qualifiedName", qualifiedName));

    // Case-insensitive lookup via the idx_nodes_lower_name expression index
    // (queries.ts:969). SQLite lower() is ASCII-only — keep the work in SQL, do
    // not substitute .NET ToLower, so behavior matches the TS.
    public List<CodeGraphNode> GetNodesByLowerName(string lowerName) =>
        QueryNodes(
            $"SELECT {NodeColumns} FROM nodes WHERE lower(name) = $lowerName",
            new CodeGraphSqlParam("$lowerName", lowerName));

    // Distinct symbol-name set (queries.ts:1909) — lightweight name strings for
    // fuzzy/pre-filter passes.
    public List<string> GetAllNodeNames()
    {
        using var command = Connection.CreateCommand();
        command.CommandText = "SELECT DISTINCT name FROM nodes";
        using var reader = command.ExecuteReader();
        var names = new List<string>();
        while (reader.Read())
        {
            names.Add(reader.GetString(0));
        }

        return names;
    }

    // Distinct symbol names defined in the given files (queries.ts getNodeNamesByFiles).
    // The #1240 failed-ref retry feeds these into GetRetryableFailedReferences: when a
    // synced file gains a symbol, refs in UNCHANGED files that failed against the old
    // graph and carry a matching name_tail become retryable. Chunked IN-list; empty in
    // → empty out.
    public List<string> GetNodeNamesByFiles(IReadOnlyList<string> filePaths)
    {
        var names = new List<string>();
        if (filePaths.Count == 0)
        {
            return names;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < filePaths.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, filePaths.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, filePaths, i, length);
            command.CommandText = $"SELECT DISTINCT name FROM nodes WHERE file_path IN ({placeholders})";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0);
                if (seen.Add(name))
                {
                    names.Add(name);
                }
            }
        }

        return names;
    }

    // Streamed counterpart of GetAllNodeNames (queries.ts:1923) — fresh cursor.
    public IEnumerable<string> IterateNodeNames()
    {
        using var command = Connection.CreateCommand();
        command.CommandText = "SELECT DISTINCT name FROM nodes";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            yield return reader.GetString(0);
        }
    }

    // Distinct languages present in the files table (queries.ts:923) — lets the
    // dynamic-edge synthesizers skip passes for absent languages.
    public HashSet<string> GetDistinctFileLanguages()
    {
        using var command = Connection.CreateCommand();
        command.CommandText = "SELECT DISTINCT language FROM files";
        using var reader = command.ExecuteReader();
        var languages = new HashSet<string>();
        while (reader.Read())
        {
            languages.Add(reader.GetString(0));
        }

        return languages;
    }

    // ------------------------------------------------------------------
    // Shared helpers (private static → visible to every CodeGraphStore partial)
    // ------------------------------------------------------------------

    private List<CodeGraphNode> QueryNodes(string sql, params CodeGraphSqlParam[] parameters)
    {
        using var command = Connection.CreateCommand();
        command.CommandText = sql;
        BindParameters(command, parameters);
        using var reader = command.ExecuteReader();
        var nodes = new List<CodeGraphNode>();
        while (reader.Read())
        {
            nodes.Add(RowToNode(reader));
        }

        return nodes;
    }

    private static bool HasRequiredNodeFields(CodeGraphNode node) =>
        !string.IsNullOrEmpty(node.Id) &&
        !string.IsNullOrEmpty(node.Kind) &&
        !string.IsNullOrEmpty(node.Name) &&
        !string.IsNullOrEmpty(node.FilePath) &&
        !string.IsNullOrEmpty(node.Language);

    private static void BindNodeParameters(SqliteCommand command, CodeGraphNode node)
    {
        var p = command.Parameters;
        p["$id"].Value = node.Id;
        p["$kind"].Value = node.Kind;
        p["$name"].Value = node.Name;
        p["$qualifiedName"].Value = node.QualifiedName;
        p["$filePath"].Value = node.FilePath;
        p["$language"].Value = node.Language;
        p["$startLine"].Value = node.StartLine;
        p["$endLine"].Value = node.EndLine;
        p["$startColumn"].Value = node.StartColumn;
        p["$endColumn"].Value = node.EndColumn;
        p["$docstring"].Value = AsDbValue(node.Docstring);
        p["$signature"].Value = AsDbValue(node.Signature);
        p["$visibility"].Value = AsDbValue(node.Visibility);
        p["$isExported"].Value = node.IsExported ? 1 : 0;
        p["$isAsync"].Value = node.IsAsync ? 1 : 0;
        p["$isStatic"].Value = node.IsStatic ? 1 : 0;
        p["$isAbstract"].Value = node.IsAbstract ? 1 : 0;
        p["$decorators"].Value = AsDbValue(SerializeStringList(node.Decorators));
        p["$typeParameters"].Value = AsDbValue(SerializeStringList(node.TypeParameters));
        p["$returnType"].Value = AsDbValue(node.ReturnType);
        p["$updatedAt"].Value = node.UpdatedAt;
    }

    // Build a tracked (store-disposed) command, add its named parameters, and
    // Prepare() it once so the compiled statement is reused across rebinds.
    private SqliteCommand BuildPreparedCommand(
        string sql,
        (string Name, SqliteType Type)[] parameters)
    {
        var command = CreateTrackedCommand(sql);
        foreach (var (name, type) in parameters)
        {
            command.Parameters.Add(name, type);
        }

        command.Prepare();
        return command;
    }

    // null → DBNull so a nullable column stores NULL, not "".
    private static object AsDbValue(object? value) => value ?? DBNull.Value;

    // Append `$in{k}` placeholders for items[offset .. offset+length) to `command`
    // and return the comma-joined placeholder list for an `IN (...)` clause. The
    // per-command name space is fresh, so chunks never collide.
    private static string BindInList<T>(
        SqliteCommand command,
        IReadOnlyList<T> items,
        int offset,
        int length)
        where T : notnull
    {
        var builder = new StringBuilder(length * 6);
        for (var i = 0; i < length; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            var name = "$in" + i;
            builder.Append(name);
            command.Parameters.AddWithValue(name, items[offset + i]);
        }

        return builder.ToString();
    }
}
