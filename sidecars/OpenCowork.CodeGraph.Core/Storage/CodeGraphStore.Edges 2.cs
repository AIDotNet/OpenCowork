using Microsoft.Data.Sqlite;

// CodeGraphStore — edge CRUD + edge/file-dependency reads (≙ queries.ts Edge
// Operations). Every edge write is INSERT OR IGNORE against the UNIQUE
// idx_edges_identity (source, target, kind, IFNULL(line,-1), IFNULL(col,-1)):
// a second pass emitting the same logical edge conflicts and is dropped, so two
// passes never produce byte-identical duplicates (#1034). metadata differences do
// NOT mint a new edge; distinct line/col DO.
internal sealed partial class CodeGraphStore
{
    private const string InsertEdgeSql = """
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES ($source, $target, $kind, $metadata, $line, $col, $provenance)
        """;

    private SqliteCommand? insertEdgeCommand;

    private SqliteCommand InsertEdgeCommand =>
        insertEdgeCommand ??= BuildPreparedCommand(InsertEdgeSql, EdgeParamSpecs);

    private static readonly (string Name, SqliteType Type)[] EdgeParamSpecs =
    {
        ("$source", SqliteType.Text), ("$target", SqliteType.Text), ("$kind", SqliteType.Text),
        ("$metadata", SqliteType.Text), ("$line", SqliteType.Integer),
        ("$col", SqliteType.Integer), ("$provenance", SqliteType.Text)
    };

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    public void InsertEdge(CodeGraphEdge edge) => InsertEdgeCore(edge, null);

    // Batch insert in ONE transaction (queries.ts:1492). Both endpoints must exist
    // in the LIVE nodes table (chunked existence probe, NOT the LRU cache — a stale
    // cache would admit dangling edges); edges with a missing endpoint are skipped.
    public void InsertEdges(IReadOnlyList<CodeGraphEdge> edges)
    {
        if (edges.Count == 0)
        {
            return;
        }

        InTransaction(transaction =>
        {
            var endpointIds = new HashSet<string>();
            foreach (var edge in edges)
            {
                endpointIds.Add(edge.Source);
                endpointIds.Add(edge.Target);
            }

            var existing = GetExistingNodeIds(new List<string>(endpointIds), transaction);
            foreach (var edge in edges)
            {
                if (!existing.Contains(edge.Source) || !existing.Contains(edge.Target))
                {
                    continue;
                }

                InsertEdgeCore(edge, transaction);
            }
        });
    }

    private void InsertEdgeCore(CodeGraphEdge edge, SqliteTransaction? transaction)
    {
        var command = InsertEdgeCommand;
        command.Transaction = transaction;
        var p = command.Parameters;
        p["$source"].Value = edge.Source;
        p["$target"].Value = edge.Target;
        p["$kind"].Value = edge.Kind;
        p["$metadata"].Value = AsDbValue(edge.Metadata);
        p["$line"].Value = AsDbValue(edge.Line);
        p["$col"].Value = AsDbValue(edge.Column);
        p["$provenance"].Value = AsDbValue(edge.Provenance);
        command.ExecuteNonQuery();
    }

    // DELETE all edges out of a node (queries.ts:1515).
    public void DeleteEdgesBySource(string sourceId) =>
        ExecuteNonQuery(
            "DELETE FROM edges WHERE source = $source",
            new CodeGraphSqlParam("$source", sourceId));

    // ------------------------------------------------------------------
    // Edge reads
    // ------------------------------------------------------------------

    // Outgoing edges, optionally filtered by kind IN (...) and/or provenance
    // (queries.ts:1525). idx_edges_source_kind covers both the source-only and the
    // (source, kind) scans via SQLite's left-prefix rule.
    public List<CodeGraphEdge> GetOutgoingEdges(
        string sourceId,
        IReadOnlyList<string>? kinds = null,
        string? provenance = null)
    {
        using var command = Connection.CreateCommand();
        var sql = new System.Text.StringBuilder($"SELECT {EdgeColumns} FROM edges WHERE source = $source");
        command.Parameters.AddWithValue("$source", sourceId);
        AppendKindFilter(command, sql, kinds);
        if (!string.IsNullOrEmpty(provenance))
        {
            sql.Append(" AND provenance = $provenance");
            command.Parameters.AddWithValue("$provenance", provenance);
        }

        command.CommandText = sql.ToString();
        return ReadEdges(command);
    }

    // Incoming edges, optionally filtered by kind IN (...) (queries.ts:1554).
    // idx_edges_target_kind covers target-only and (target, kind) scans.
    public List<CodeGraphEdge> GetIncomingEdges(string targetId, IReadOnlyList<string>? kinds = null)
    {
        using var command = Connection.CreateCommand();
        var sql = new System.Text.StringBuilder($"SELECT {EdgeColumns} FROM edges WHERE target = $target");
        command.Parameters.AddWithValue("$target", targetId);
        AppendKindFilter(command, sql, kinds);
        command.CommandText = sql.ToString();
        return ReadEdges(command);
    }

    // Distinct file paths that DEPEND ON `filePath` (queries.ts:1604): a file
    // holding a symbol with a cross-file edge (ANY kind except `contains`) into a
    // symbol of this file. The blast-radius basis. NOT restricted to `imports`
    // (imports edges are always same-file here); `contains` excluded (a container
    // does not depend on its members).
    public List<string> GetDependentFilePaths(string filePath) =>
        QueryFilePaths(
            """
            SELECT DISTINCT src.file_path AS fp
              FROM edges e
              JOIN nodes tgt ON tgt.id = e.target
              JOIN nodes src ON src.id = e.source
             WHERE tgt.file_path = $filePath
               AND e.kind != 'contains'
               AND src.file_path != $filePath
            """,
            filePath);

    // Distinct file paths that `filePath` DEPENDS ON — inverse of the above
    // (queries.ts:1622). Same edge-kind rules (all kinds except `contains`).
    public List<string> GetDependencyFilePaths(string filePath) =>
        QueryFilePaths(
            """
            SELECT DISTINCT tgt.file_path AS fp
              FROM edges e
              JOIN nodes src ON src.id = e.source
              JOIN nodes tgt ON tgt.id = e.target
             WHERE src.file_path = $filePath
               AND e.kind != 'contains'
               AND tgt.file_path != $filePath
            """,
            filePath);

    // Cross-file edges whose TARGET is in `filePath` and whose SOURCE is in a
    // different file, paired with the target's (name, kind) and the source's
    // (file, language) so a re-index can re-resolve the edge to the callee's
    // line-shifted new id (node ids embed start_line, #899). Same edge-kind rules
    // as GetDependentFilePaths. queries.ts:1644.
    public List<CodeGraphCrossFileIncomingEdge> GetCrossFileIncomingEdgesWithTarget(string filePath)
    {
        using var command = Connection.CreateCommand();
        // EdgeColumns order (source, target, kind, metadata, line, col, provenance)
        // occupies ordinals 0-6 so RowToEdge maps it; the four extras follow at 7-10.
        command.CommandText = """
            SELECT e.source, e.target, e.kind, e.metadata, e.line, e.col, e.provenance,
                   tgt.name AS target_name, tgt.kind AS target_kind,
                   src.file_path AS source_file_path, src.language AS source_language
              FROM edges e
              JOIN nodes tgt ON tgt.id = e.target
              JOIN nodes src ON src.id = e.source
             WHERE tgt.file_path = $filePath
               AND e.kind != 'contains'
               AND src.file_path != $filePath
            """;
        command.Parameters.AddWithValue("$filePath", filePath);
        using var reader = command.ExecuteReader();
        var results = new List<CodeGraphCrossFileIncomingEdge>();
        while (reader.Read())
        {
            results.Add(new CodeGraphCrossFileIncomingEdge(
                Edge: RowToEdge(reader),
                TargetName: reader.GetString(7),
                TargetKind: reader.GetString(8),
                SourceFilePath: reader.GetString(9),
                SourceLanguage: reader.GetString(10)));
        }

        return results;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static void AppendKindFilter(
        SqliteCommand command,
        System.Text.StringBuilder sql,
        IReadOnlyList<string>? kinds)
    {
        if (kinds is null || kinds.Count == 0)
        {
            return;
        }

        sql.Append(" AND kind IN (");
        for (var i = 0; i < kinds.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            var name = "$kind" + i;
            sql.Append(name);
            command.Parameters.AddWithValue(name, kinds[i]);
        }

        sql.Append(')');
    }

    private static List<CodeGraphEdge> ReadEdges(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var edges = new List<CodeGraphEdge>();
        while (reader.Read())
        {
            edges.Add(RowToEdge(reader));
        }

        return edges;
    }

    private List<string> QueryFilePaths(string sql, string filePath)
    {
        using var command = Connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("$filePath", filePath);
        using var reader = command.ExecuteReader();
        var paths = new List<string>();
        while (reader.Read())
        {
            paths.Add(reader.GetString(0));
        }

        return paths;
    }
}

// In-process carrier for GetCrossFileIncomingEdgesWithTarget (≙ the TS
// `Edge & { targetName, targetKind, sourceFilePath, sourceLanguage }`). Not
// serialized — the re-index path consumes it to rebuild incoming edges (#899).
internal sealed record CodeGraphCrossFileIncomingEdge(
    CodeGraphEdge Edge,
    string TargetName,
    string TargetKind,
    string SourceFilePath,
    string SourceLanguage);
