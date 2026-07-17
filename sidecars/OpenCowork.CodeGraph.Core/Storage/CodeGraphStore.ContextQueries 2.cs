using System.Globalization;
using System.Text;

// CodeGraphStore — context-ranking query helpers (≙ queries.ts findNodesByNameSubstring
// :1424 + findEdgesBetweenNodes:1572). These back the ContextBuilder's CamelCase-boundary
// / compound retrieval channels and its post-trim edge recovery. They live with the store
// (not the Context slice) because the ContextBuilder ranks over the store's read surface
// but has no direct SQL access — the same reason findNodesByExactName / searchNodes live
// here. Ported behaviorally 1:1; scores are the raw placeholder 1.0 the callers recompute.
internal sealed partial class CodeGraphStore
{
    /// <summary>
    /// LIKE '%substring%' match over node names, shortest-name-first, with an optional
    /// prefix exclusion (the CamelCase channel wants ONLY interior boundary matches —
    /// leading-prefix matches are already covered by the definition-prefix FTS channel).
    /// (queries.ts:1424 findNodesByNameSubstring)
    /// </summary>
    public List<CodeGraphSearchResult> FindNodesByNameSubstring(
        string substring,
        int limit = 30,
        IReadOnlyList<string>? kinds = null,
        IReadOnlyList<string>? languages = null,
        bool excludePrefix = false)
    {
        var sql = new StringBuilder("SELECT ");
        sql.Append(NodeColumns);
        sql.Append(" FROM nodes WHERE name LIKE $contains");
        using var command = Connection.CreateCommand();
        command.Parameters.AddWithValue("$contains", "%" + substring + "%");

        // Exclude prefix matches (handled by the FTS-based prefix search in step 2b).
        if (excludePrefix)
        {
            sql.Append(" AND name NOT LIKE $prefix");
            command.Parameters.AddWithValue("$prefix", substring + "%");
        }

        AppendInClause(sql, command, "kind", kinds, "k");
        AppendInClause(sql, command, "language", languages, "l");
        sql.Append(" ORDER BY length(name) ASC LIMIT $limit");
        command.Parameters.AddWithValue("$limit", limit);
        command.CommandText = sql.ToString();

        var results = new List<CodeGraphSearchResult>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new CodeGraphSearchResult(CodeGraphNodeView.From(RowToNode(reader)), 1.0));
        }

        return results;
    }

    /// <summary>
    /// Edges whose BOTH endpoints are in <paramref name="nodeIds"/>, optionally filtered
    /// by kind — the post-BFS connectivity recovery (queries.ts:1572 findEdgesBetweenNodes).
    /// Uses a bound IN-list over the deduped id set (each id bound once, reused in both the
    /// source and target clauses) rather than the TS json_each(?), which is result-identical
    /// for the bounded context node budget and avoids JSON round-tripping node ids.
    /// </summary>
    public List<CodeGraphEdge> FindEdgesBetweenNodes(
        IReadOnlyList<string> nodeIds,
        IReadOnlyList<string>? kinds = null)
    {
        if (nodeIds.Count == 0)
        {
            return new List<CodeGraphEdge>();
        }

        var unique = new List<string>(new HashSet<string>(nodeIds));
        using var command = Connection.CreateCommand();
        var sql = new StringBuilder("SELECT ");
        sql.Append(EdgeColumns);
        sql.Append(" FROM edges WHERE source IN (");
        for (var i = 0; i < unique.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            var name = "$n" + i.ToString(CultureInfo.InvariantCulture);
            sql.Append(name);
            command.Parameters.AddWithValue(name, unique[i]);
        }

        sql.Append(") AND target IN (");
        for (var i = 0; i < unique.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            sql.Append("$n").Append(i.ToString(CultureInfo.InvariantCulture));
        }

        sql.Append(')');
        AppendKindFilter(command, sql, kinds);
        command.CommandText = sql.ToString();

        return ReadEdges(command);
    }
}
