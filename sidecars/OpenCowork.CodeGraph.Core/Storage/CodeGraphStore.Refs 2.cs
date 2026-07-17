using Microsoft.Data.Sqlite;

// CodeGraphStore — unresolved-reference lifecycle (≙ queries.ts Unresolved
// References). A ref is inserted 'pending'; a completed resolution pass either
// DELETEs it (resolved) or parks it 'failed' with name_tail = last dotted segment
// so a later sync can retry it when a changed file adds a matching symbol (#1240).
// The pending count/batch readers exclude 'failed' rows so drain loops terminate.
//
// Row-precise cleanup (DeleteReferencesByRowIds / MarkReferencesFailedByRowIds)
// exists because the key-tuple variants also touch SIBLING rows (same caller/callee
// at other call sites) a later batch has not attempted yet, which silently dropped
// their edges when a batch boundary split them (#1269).
internal sealed partial class CodeGraphStore
{
    private const string InsertUnresolvedSql = """
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES ($fromNodeId, $referenceName, $referenceKind, $line, $col, $candidates, $filePath, $language)
        """;

    private SqliteCommand? insertUnresolvedCommand;

    private SqliteCommand InsertUnresolvedCommand =>
        insertUnresolvedCommand ??= BuildPreparedCommand(InsertUnresolvedSql, UnresolvedParamSpecs);

    private static readonly (string Name, SqliteType Type)[] UnresolvedParamSpecs =
    {
        ("$fromNodeId", SqliteType.Text), ("$referenceName", SqliteType.Text),
        ("$referenceKind", SqliteType.Text), ("$line", SqliteType.Integer),
        ("$col", SqliteType.Integer), ("$candidates", SqliteType.Text),
        ("$filePath", SqliteType.Text), ("$language", SqliteType.Text)
    };

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    public void InsertUnresolvedRef(CodeGraphUnresolvedReference reference) =>
        InsertUnresolvedRefCore(reference, null);

    // Batch insert in one transaction (queries.ts:1789).
    public void InsertUnresolvedRefsBatch(IReadOnlyList<CodeGraphUnresolvedReference> references)
    {
        if (references.Count == 0)
        {
            return;
        }

        InTransaction(transaction =>
        {
            foreach (var reference in references)
            {
                InsertUnresolvedRefCore(reference, transaction);
            }
        });
    }

    private void InsertUnresolvedRefCore(
        CodeGraphUnresolvedReference reference,
        SqliteTransaction? transaction)
    {
        var command = InsertUnresolvedCommand;
        command.Transaction = transaction;
        var p = command.Parameters;
        p["$fromNodeId"].Value = reference.FromNodeId;
        p["$referenceName"].Value = reference.ReferenceName;
        p["$referenceKind"].Value = reference.ReferenceKind;
        p["$line"].Value = reference.Line;
        p["$col"].Value = reference.Column;
        p["$candidates"].Value = AsDbValue(SerializeStringList(reference.Candidates));
        // file_path / language are NOT NULL DEFAULT '' / 'unknown' (queries.ts:1781).
        p["$filePath"].Value = reference.FilePath ?? string.Empty;
        p["$language"].Value = reference.Language ?? CodeGraphLanguage.Unknown;
        command.ExecuteNonQuery();
    }

    // Wipe every unresolved ref (queries.ts:1967).
    public void ClearUnresolvedReferences() =>
        ExecuteNonQuery("DELETE FROM unresolved_refs");

    // Delete resolved refs by source-node id, chunked under the parameter limit
    // (queries.ts:1974). The internal resolution path prefers the row-id / tuple
    // variants; this is the public bulk form.
    public void DeleteResolvedReferences(IReadOnlyList<string> fromNodeIds)
    {
        if (fromNodeIds.Count == 0)
        {
            return;
        }

        for (var i = 0; i < fromNodeIds.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, fromNodeIds.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, fromNodeIds, i, length);
            command.CommandText = $"DELETE FROM unresolved_refs WHERE from_node_id IN ({placeholders})";
            command.ExecuteNonQuery();
        }
    }

    // Delete specific resolved refs by (fromNodeId, referenceName, referenceKind)
    // tuple, one transaction (queries.ts:1992). More precise than by-node, but
    // still deletes same-key sibling rows — prefer DeleteReferencesByRowIds where a
    // batch boundary may have split a caller's same-named call sites (#1269).
    public void DeleteSpecificResolvedReferences(
        IReadOnlyList<(string FromNodeId, string ReferenceName, string ReferenceKind)> references)
    {
        if (references.Count == 0)
        {
            return;
        }

        InTransaction(transaction =>
        {
            foreach (var reference in references)
            {
                ExecuteNonQuery(
                    transaction,
                    "DELETE FROM unresolved_refs WHERE from_node_id = $fromNodeId AND reference_name = $referenceName AND reference_kind = $referenceKind",
                    new CodeGraphSqlParam("$fromNodeId", reference.FromNodeId),
                    new CodeGraphSqlParam("$referenceName", reference.ReferenceName),
                    new CodeGraphSqlParam("$referenceKind", reference.ReferenceKind));
            }
        });
    }

    // Delete refs by row id — the precise cleanup for exactly the rows a pass
    // processed, chunked (queries.ts:2013).
    public void DeleteReferencesByRowIds(IReadOnlyList<long> rowIds)
    {
        if (rowIds.Count == 0)
        {
            return;
        }

        for (var i = 0; i < rowIds.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, rowIds.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, rowIds, i, length);
            command.CommandText = $"DELETE FROM unresolved_refs WHERE id IN ({placeholders})";
            command.ExecuteNonQuery();
        }
    }

    // Park refs a completed pass could not resolve as status='failed' by tuple,
    // writing name_tail so the #1240 retry sweep can find them (queries.ts:2031).
    public void MarkReferencesFailed(
        IReadOnlyList<(string FromNodeId, string ReferenceName, string ReferenceKind)> references)
    {
        if (references.Count == 0)
        {
            return;
        }

        InTransaction(transaction =>
        {
            foreach (var reference in references)
            {
                ExecuteNonQuery(
                    transaction,
                    "UPDATE unresolved_refs SET status = 'failed', name_tail = $nameTail WHERE from_node_id = $fromNodeId AND reference_name = $referenceName AND reference_kind = $referenceKind",
                    new CodeGraphSqlParam("$nameTail", ReferenceNameTail(reference.ReferenceName)),
                    new CodeGraphSqlParam("$fromNodeId", reference.FromNodeId),
                    new CodeGraphSqlParam("$referenceName", reference.ReferenceName),
                    new CodeGraphSqlParam("$referenceKind", reference.ReferenceKind));
            }
        });
    }

    // Park refs 'failed' by row id — the precise counterpart of MarkReferencesFailed
    // (queries.ts:2052). Resolution outcome can differ per call site, so a sibling
    // must not inherit this row's failure.
    public void MarkReferencesFailedByRowIds(
        IReadOnlyList<(long RowId, string ReferenceName)> references)
    {
        if (references.Count == 0)
        {
            return;
        }

        InTransaction(transaction =>
        {
            foreach (var reference in references)
            {
                ExecuteNonQuery(
                    transaction,
                    "UPDATE unresolved_refs SET status = 'failed', name_tail = $nameTail WHERE id = $rowId",
                    new CodeGraphSqlParam("$nameTail", ReferenceNameTail(reference.ReferenceName)),
                    new CodeGraphSqlParam("$rowId", reference.RowId));
            }
        });
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    // Count of PENDING (never-attempted) refs — excludes 'failed' so drain loops
    // and the #1187 orphan sweep terminate (queries.ts:1859).
    public int GetUnresolvedReferencesCount() =>
        (int)ExecuteScalarLong("SELECT COUNT(*) FROM unresolved_refs WHERE status = 'pending'");

    // One page of PENDING refs by LIMIT/OFFSET (queries.ts:1875).
    public List<CodeGraphUnresolvedReference> GetUnresolvedReferencesBatch(int offset, int limit)
    {
        using var command = Connection.CreateCommand();
        command.CommandText =
            $"SELECT {UnresolvedColumns} FROM unresolved_refs WHERE status = 'pending' LIMIT $limit OFFSET $offset";
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        return ReadUnresolvedRefs(command);
    }

    // PENDING refs scoped to specific files, chunked (queries.ts:1934).
    public List<CodeGraphUnresolvedReference> GetUnresolvedReferencesByFiles(
        IReadOnlyList<string> filePaths)
    {
        var refs = new List<CodeGraphUnresolvedReference>();
        if (filePaths.Count == 0)
        {
            return refs;
        }

        for (var i = 0; i < filePaths.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, filePaths.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, filePaths, i, length);
            command.CommandText =
                $"SELECT {UnresolvedColumns} FROM unresolved_refs WHERE status = 'pending' AND file_path IN ({placeholders})";
            refs.AddRange(ReadUnresolvedRefs(command));
        }

        return refs;
    }

    // Failed refs whose name_tail matches one of `names` — the retry candidates for
    // a sync after files carrying those names changed (queries.ts:2074). A tail
    // matching more than `perNameCeiling` failed refs is external/builtin noise
    // (`get`, `map`, ...) that one new definition can't resolve — skip it whole.
    public List<CodeGraphUnresolvedReference> GetRetryableFailedReferences(
        IReadOnlyList<string> names,
        int perNameCeiling = 500)
    {
        var results = new List<CodeGraphUnresolvedReference>();
        if (names.Count == 0)
        {
            return results;
        }

        // Pass 1: per-tail failed counts, chunked; keep tails under the ceiling.
        var retryNames = new List<string>();
        for (var i = 0; i < names.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, names.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, names, i, length);
            command.CommandText =
                $"SELECT name_tail, COUNT(*) AS count FROM unresolved_refs WHERE status = 'failed' AND name_tail IN ({placeholders}) GROUP BY name_tail";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                if (reader.GetInt64(1) <= perNameCeiling)
                {
                    retryNames.Add(reader.GetString(0));
                }
            }
        }

        if (retryNames.Count == 0)
        {
            return results;
        }

        // Pass 2: load the surviving failed rows.
        for (var i = 0; i < retryNames.Count; i += ChunkSize)
        {
            var length = Math.Min(ChunkSize, retryNames.Count - i);
            using var command = Connection.CreateCommand();
            var placeholders = BindInList(command, retryNames, i, length);
            command.CommandText =
                $"SELECT {UnresolvedColumns} FROM unresolved_refs WHERE status = 'failed' AND name_tail IN ({placeholders})";
            results.AddRange(ReadUnresolvedRefs(command));
        }

        return results;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    // Last dotted/qualified segment of a reference name — the part a new symbol's
    // plain node name could match ('util.greet' → 'greet', 'mod::fn' → 'fn').
    // queries.ts:123.
    private static string ReferenceNameTail(string referenceName)
    {
        var index = Math.Max(referenceName.LastIndexOf('.'), referenceName.LastIndexOf(':'));
        return index >= 0 ? referenceName[(index + 1)..] : referenceName;
    }

    private static List<CodeGraphUnresolvedReference> ReadUnresolvedRefs(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var refs = new List<CodeGraphUnresolvedReference>();
        while (reader.Read())
        {
            refs.Add(RowToUnresolvedRef(reader));
        }

        return refs;
    }
}
