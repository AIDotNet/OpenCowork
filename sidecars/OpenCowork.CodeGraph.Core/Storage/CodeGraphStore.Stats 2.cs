using System.Text.RegularExpressions;

// CodeGraphStore — statistics, project-metadata, whole-DB clear, and the
// routing/dominant-file ranking heuristics ≙ CodeGraph TS QueryBuilder
// (queries.ts Statistics + Project Metadata sections, plus getDominantFile /
// getTopRouteFile / getRoutingManifest). Ported behaviorally 1:1.
internal sealed partial class CodeGraphStore
{
    // ===========================================================================
    // Statistics
    // ===========================================================================

    /// <summary>
    /// Lightweight (nodes, edges) count snapshot — used around an index/sync run to
    /// compute true additions across extraction + resolution + synthesis.
    /// (queries.ts:2146 getNodeAndEdgeCount)
    /// </summary>
    public (int Nodes, int Edges) GetNodeAndEdgeCount()
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges";
        using var reader = command.ExecuteReader();
        return reader.Read() ? (reader.GetInt32(0), reader.GetInt32(1)) : (0, 0);
    }

    /// <summary>Graph statistics: single-query counts + grouped breakdowns. (queries.ts:2155 getStats)</summary>
    public CodeGraphStats GetStats()
    {
        var nodeCount = 0;
        var edgeCount = 0;
        var fileCount = 0;

        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"SELECT
                (SELECT COUNT(*) FROM nodes) AS node_count,
                (SELECT COUNT(*) FROM edges) AS edge_count,
                (SELECT COUNT(*) FROM files) AS file_count";
            using var reader = command.ExecuteReader();
            if (reader.Read())
            {
                nodeCount = reader.GetInt32(0);
                edgeCount = reader.GetInt32(1);
                fileCount = reader.GetInt32(2);
            }
        }

        var nodesByKind = GroupCount("SELECT kind, COUNT(*) FROM nodes GROUP BY kind");
        var edgesByKind = GroupCount("SELECT kind, COUNT(*) FROM edges GROUP BY kind");
        var filesByLanguage = GroupCount("SELECT language, COUNT(*) FROM files GROUP BY language");

        return new CodeGraphStats(
            nodeCount,
            edgeCount,
            fileCount,
            nodesByKind,
            edgesByKind,
            filesByLanguage,
            DbSizeBytes: 0, // set by the caller from the on-disk file size
            LastUpdated: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    // A `SELECT <text-col>, COUNT(*)` group-by folded into a Dictionary.
    private Dictionary<string, int> GroupCount(string sql)
    {
        var result = new Dictionary<string, int>();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            result[reader.GetString(0)] = reader.GetInt32(1);
        }

        return result;
    }

    /// <summary>
    /// Most recent index timestamp (epoch ms) across all tracked files, or null when
    /// nothing is indexed yet. (queries.ts:1741 getLastIndexedAt)
    /// </summary>
    public long? GetLastIndexedAt()
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT MAX(indexed_at) AS last FROM files";
        using var reader = command.ExecuteReader();
        return reader.Read() && !reader.IsDBNull(0) ? reader.GetInt64(0) : null;
    }

    // ===========================================================================
    // Project Metadata
    // ===========================================================================

    /// <summary>Get a metadata value by key. (queries.ts:2207 getMetadata)</summary>
    public string? GetMetadata(string key) =>
        ExecuteScalarString(
            "SELECT value FROM project_metadata WHERE key = $key",
            new CodeGraphSqlParam("$key", key));

    /// <summary>Set a metadata key-value pair (upsert). (queries.ts:2215 setMetadata)</summary>
    public void SetMetadata(string key, string value) =>
        ExecuteNonQuery(
            "INSERT INTO project_metadata (key, value, updated_at) VALUES ($key, $value, $updatedAt) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            new CodeGraphSqlParam("$key", key),
            new CodeGraphSqlParam("$value", value),
            new CodeGraphSqlParam("$updatedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));

    /// <summary>Get all metadata as a key-value map. (queries.ts:2224 getAllMetadata)</summary>
    public Dictionary<string, string> GetAllMetadata()
    {
        var result = new Dictionary<string, string>();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT key, value FROM project_metadata";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            result[reader.GetString(0)] = reader.GetString(1);
        }

        return result;
    }

    /// <summary>
    /// Clear all graph data (unresolved_refs, edges, nodes, files) and the node
    /// cache, in one transaction. Leaves name_segment_vocab and project_metadata
    /// intact — matching the TS clear(). (queries.ts:2236)
    /// </summary>
    public void Clear()
    {
        NodeCache.Clear();
        InTransaction(transaction =>
        {
            ExecuteNonQuery(transaction, "DELETE FROM unresolved_refs");
            ExecuteNonQuery(transaction, "DELETE FROM edges");
            ExecuteNonQuery(transaction, "DELETE FROM nodes");
            ExecuteNonQuery(transaction, "DELETE FROM files");
        });
    }

    // ===========================================================================
    // Ranking heuristics (dominant / routing files)
    // ===========================================================================

    /// <summary>
    /// The file holding the densest concentration of the project's INTERNAL (same-
    /// file source and target) call graph — the "core" file. Null if no file has a
    /// meaningful concentration. Test/generated files are excluded from candidacy.
    /// (queries.ts:728 getDominantFile)
    /// </summary>
    public CodeGraphDominantFile? GetDominantFile()
    {
        // Pull the top 20 candidates; test/generated files are filtered in code
        // (regex-grade matching SQL LIKE can't express). The generated-file filter
        // is critical — without it a generated protobuf stub can outrank the real
        // source by 4x and push the agent toward generated code.
        var rows = new List<(string FilePath, int EdgeCount)>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"SELECT n.file_path AS file_path, COUNT(*) AS edge_count
                FROM edges e
                JOIN nodes n ON e.source = n.id
                JOIN nodes m ON e.target = m.id
                WHERE n.file_path = m.file_path
                GROUP BY n.file_path
                ORDER BY edge_count DESC
                LIMIT 20";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add((reader.GetString(0), reader.GetInt32(1)));
            }
        }

        var filtered = rows.Where(r => !IsLowValueFile(r.FilePath)).ToList();
        if (filtered.Count == 0 || filtered[0].EdgeCount < 20)
        {
            return null;
        }

        var nextEdgeCount = filtered.Count > 1 ? filtered[1].EdgeCount : 0;
        return new CodeGraphDominantFile(filtered[0].FilePath, filtered[0].EdgeCount, nextEdgeCount);
    }

    /// <summary>
    /// The file holding the densest concentration of the project's `route` nodes.
    /// Null if fewer than 3 non-test routes total, or if no file holds at least 30%
    /// of them (diffuse routing -> no single answer file). (queries.ts:770 getTopRouteFile)
    /// </summary>
    public CodeGraphTopRouteFile? GetTopRouteFile()
    {
        var rows = new List<(string FilePath, int Count)>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"SELECT file_path, COUNT(*) AS cnt
                FROM nodes
                WHERE kind = 'route'
                GROUP BY file_path
                ORDER BY cnt DESC
                LIMIT 20";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add((reader.GetString(0), reader.GetInt32(1)));
            }
        }

        var filtered = rows.Where(r => !IsLowValueFile(r.FilePath)).ToList();
        if (filtered.Count == 0)
        {
            return null;
        }

        var totalRoutes = filtered.Sum(r => r.Count);
        var top = filtered[0];
        if (totalRoutes < 3 || top.Count < 3)
        {
            return null;
        }

        if ((double)top.Count / totalRoutes < 0.30)
        {
            return null;
        }

        return new CodeGraphTopRouteFile(top.FilePath, top.Count, totalRoutes);
    }

    /// <summary>
    /// Build a URL -> handler manifest from the index: each route node's edge (of
    /// kind references/calls) into a function/method/class handler. Also returns the
    /// file with the most handler endpoints. Null if fewer than 3 non-test handlers.
    /// (queries.ts:802 getRoutingManifest)
    /// </summary>
    public CodeGraphRoutingManifest? GetRoutingManifest(int limit = 40)
    {
        // Edge kind varies across framework resolvers (Spring/Rails/Laravel emit
        // `references`, Express emits `calls`) — accept both.
        var rows = new List<(string Url, string Handler, string HandlerFile, int HandlerLine, string HandlerKind)>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"SELECT
                    r.name AS url,
                    h.name AS handler,
                    h.file_path AS handler_file,
                    h.start_line AS handler_line,
                    h.kind AS handler_kind
                FROM nodes r
                JOIN edges e ON e.source = r.id
                JOIN nodes h ON e.target = h.id
                WHERE r.kind = 'route'
                  AND e.kind IN ('references', 'calls')
                  AND h.kind IN ('function', 'method', 'class')
                ORDER BY r.file_path, r.start_line
                LIMIT $limit";
            command.Parameters.AddWithValue("$limit", limit);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add((
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetInt32(3),
                    reader.GetString(4)));
            }
        }

        // Drop test/generated handlers.
        var filtered = rows.Where(r => !IsLowValueFile(r.HandlerFile)).ToList();
        if (filtered.Count < 3)
        {
            return null;
        }

        // Identify the file holding the most handlers (first-appearance order wins
        // ties, matching the TS Map iteration).
        var fileCounts = new Dictionary<string, int>();
        var fileOrder = new List<string>();
        foreach (var r in filtered)
        {
            if (fileCounts.TryGetValue(r.HandlerFile, out var count))
            {
                fileCounts[r.HandlerFile] = count + 1;
            }
            else
            {
                fileCounts[r.HandlerFile] = 1;
                fileOrder.Add(r.HandlerFile);
            }
        }

        string? topHandlerFile = null;
        var topHandlerFileCount = 0;
        foreach (var file in fileOrder)
        {
            if (fileCounts[file] > topHandlerFileCount)
            {
                topHandlerFile = file;
                topHandlerFileCount = fileCounts[file];
            }
        }

        var entries = filtered
            .Select(r => new CodeGraphRouteHandlerEntry(r.Url, r.Handler, r.HandlerFile, r.HandlerLine, r.HandlerKind))
            .ToList();

        return new CodeGraphRoutingManifest(entries, topHandlerFile, topHandlerFileCount, filtered.Count);
    }

    // ---------------------------------------------------------------------------
    // Path-only candidacy heuristics (queries.ts:33 isLowValueFile,
    // generated-detection.ts:79 isGeneratedFile)
    // ---------------------------------------------------------------------------

    // Tested against the lowercased path.
    private static readonly Regex[] LowValuePatterns =
    {
        new(@"(?:^|/)(tests?|__tests?__|spec)/"),
        new(@"_test\.go$"),
        new(@"(?:^|/)test_[^/]+\.py$"),
        new(@"_test\.py$"),
        new(@"_spec\.rb$"),
        new(@"_test\.rb$"),
        new(@"\.(test|spec)\.[jt]sx?$"),
        new(@"(test|spec|tests)\.(java|kt|scala)$"),
        new(@"(tests?|spec)\.cs$"),
        new(@"tests?\.swift$"),
        new(@"_test\.dart$")
    };

    // Tested against the ORIGINAL-case path (several patterns are case-sensitive:
    // Grpc.cs, OuterClass.java, ^mock_...).
    private static readonly Regex[] GeneratedPatterns =
    {
        new(@"\.pb\.go$"),
        new(@"\.pulsar\.go$"),
        new(@"_grpc\.pb\.go$"),
        new(@"_mock\.go$"),
        new(@"_mocks\.go$"),
        new(@"^mock_[^/]+\.go$"),
        new(@"\.generated\.[jt]sx?$"),
        new(@"\.gen\.[jt]sx?$"),
        new(@"\.pb\.[jt]s$"),
        new(@"_pb\.[jt]s$"),
        new(@"_grpc_pb\.[jt]s$"),
        new(@"\.min\.m?js$"),
        new(@"_pb2(_grpc)?\.py$"),
        new(@"_pb2\.pyi$"),
        new(@"\.pb\.(cc|h)$"),
        new(@"\.g\.cs$"),
        new(@"Grpc\.cs$"),
        new(@"OuterClass\.java$"),
        new(@"Grpc\.java$"),
        new(@"\.pb\.swift$"),
        new(@"\.g\.dart$"),
        new(@"\.freezed\.dart$"),
        new(@"\.pb\.dart$"),
        new(@"\.pbgrpc\.dart$"),
        new(@"\.chopper\.dart$"),
        new(@"\.generated\.rs$")
    };

    // Files that must not be candidates for dominant/route detection: test/spec
    // files and tool-generated files (whose huge in-file edge counts dwarf real
    // source). (queries.ts:33)
    private static bool IsLowValueFile(string filePath)
    {
        var lp = filePath.ToLowerInvariant();
        foreach (var pattern in LowValuePatterns)
        {
            if (pattern.IsMatch(lp))
            {
                return true;
            }
        }

        return IsGeneratedFile(filePath);
    }

    // Whether a path looks tool-generated (path-only, suffix patterns).
    // (generated-detection.ts:79)
    private static bool IsGeneratedFile(string filePath)
    {
        foreach (var pattern in GeneratedPatterns)
        {
            if (pattern.IsMatch(filePath))
            {
                return true;
            }
        }

        return false;
    }
}

// ---------------------------------------------------------------------------
// Heuristic result records (in-process only — consumed by the context builder;
// not registered with CodeGraphJsonContext at M1).
// ---------------------------------------------------------------------------
internal sealed record CodeGraphDominantFile(string FilePath, int EdgeCount, int NextEdgeCount);

internal sealed record CodeGraphTopRouteFile(string FilePath, int RouteCount, int TotalRoutes);

internal sealed record CodeGraphRouteHandlerEntry(
    string Url,
    string Handler,
    string HandlerFile,
    int HandlerLine,
    string HandlerKind);

internal sealed record CodeGraphRoutingManifest(
    IReadOnlyList<CodeGraphRouteHandlerEntry> Entries,
    string? TopHandlerFile,
    int TopHandlerFileCount,
    int TotalRoutes);
