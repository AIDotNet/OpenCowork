using System.Text;
using Microsoft.Data.Sqlite;

// CodeGraphStore — name-segment vocabulary (≙ queries.ts Name-segment vocabulary
// + identifier-segments.ts). Powers the prompt-hook "does this prose word name a
// real symbol" gate. Segments are materialized on the node write path because
// FTS5's tokenizer keeps camelCase as one token and cannot serve it. Rows are
// PROPOSALS re-verified against `nodes` before use; deletes leave orphans on
// purpose; a full index clears the table at its start.
internal sealed partial class CodeGraphStore
{
    // Names whose segments were already written this session — a write-path fast
    // path (INSERT OR IGNORE is the correctness backstop). Bounded so a pathological
    // repo can't grow it forever (queries.ts:245).
    private const int MaxSegmentedNames = 65536;
    private readonly HashSet<string> segmentedNames = new();

    private SqliteCommand? insertNameSegmentCommand;

    private SqliteCommand InsertNameSegmentCommand =>
        insertNameSegmentCommand ??= BuildPreparedCommand(
            "INSERT OR IGNORE INTO name_segment_vocab (segment, name) VALUES ($segment, $name)",
            new[] { ("$segment", SqliteType.Text), ("$name", SqliteType.Text) });

    // Which node kinds contribute their name to the vocab (queries.ts:348). Files
    // are excluded (a basename duplicates the symbols inside it, double-counting
    // concepts); imports too (#1144 — named after module specifiers, never a real
    // definition that could be surfaced).
    private static bool IsSegmentableKind(string kind) =>
        kind != CodeGraphNodeKind.File && kind != CodeGraphNodeKind.Import;

    // Write `name`'s segments into name_segment_vocab, idempotently (queries.ts:353).
    // Rides the node write path's transaction so vocab can never drift ahead of the
    // nodes it describes.
    internal void InsertNameSegments(string name, SqliteTransaction? transaction)
    {
        if (segmentedNames.Contains(name))
        {
            return;
        }

        if (segmentedNames.Count >= MaxSegmentedNames)
        {
            segmentedNames.Clear();
        }

        segmentedNames.Add(name);

        var command = InsertNameSegmentCommand;
        command.Transaction = transaction;
        foreach (var segment in CodeGraphIdentifierSegments.SplitIdentifierSegments(name))
        {
            command.Parameters["$segment"].Value = segment;
            command.Parameters["$name"].Value = name;
            command.ExecuteNonQuery();
        }
    }

    // Wipe the vocab; a full index calls this at its start (queries.ts:488). Clears
    // the session fast-path set so the write path fully repopulates it.
    public void ClearNameSegmentVocab()
    {
        ExecuteNonQuery("DELETE FROM name_segment_vocab");
        segmentedNames.Clear();
    }

    // True when the vocab has no rows — an index built before the table existed;
    // sync uses this to heal such databases (queries.ts:495).
    public bool IsNameSegmentVocabEmpty()
    {
        using var command = Connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM name_segment_vocab LIMIT 1";
        using var reader = command.ExecuteReader();
        return !reader.Read();
    }

    // One page of distinct SEGMENTABLE node names, for batched vocab rebuilds. File
    // basenames and import specifiers are excluded (same gate as the write path —
    // IsSegmentableKind), so a rebuild reproduces exactly the write-path population.
    // (queries.ts:503 getDistinctNodeNames)
    public List<string> GetDistinctNodeNames(int limit, int offset)
    {
        using var command = Connection.CreateCommand();
        command.CommandText =
            "SELECT DISTINCT name FROM nodes WHERE kind NOT IN ('file', 'import') " +
            "ORDER BY name LIMIT $limit OFFSET $offset";
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        using var reader = command.ExecuteReader();
        var names = new List<string>();
        while (reader.Read())
        {
            names.Add(reader.GetString(0));
        }

        return names;
    }

    // Insert segments for a batch of names in one transaction (vocab heal path).
    // (queries.ts:511 insertNameSegmentsBatch)
    public void InsertNameSegmentsBatch(IReadOnlyList<string> names)
    {
        InTransaction(transaction =>
        {
            foreach (var name in names)
            {
                InsertNameSegments(name, transaction);
            }
        });
    }

    // Rebuild the segment vocabulary from the current graph, page by page — the
    // upgrade-heal path for indexes built before the vocab table existed (callers
    // that open the graph WITHOUT syncing, concretely the prompt hook, #1142). The
    // .NET port folds the TS index.ts rebuildNameSegmentVocab loop into the store
    // (no cooperative yielder — the batched transactions bound each unit of work).
    // (index.ts:1260 rebuildNameSegmentVocab)
    public void RebuildNameSegmentVocab()
    {
        const int batch = 2000;
        for (var offset = 0; ; offset += batch)
        {
            var names = GetDistinctNodeNames(batch, offset);
            if (names.Count == 0)
            {
                break;
            }

            InsertNameSegmentsBatch(names);
        }
    }

    // Names containing `segment`, shortest first (rare-single-word tier,
    // queries.ts:572).
    public List<string> GetNamesForSegment(string segment, int limit)
    {
        using var command = Connection.CreateCommand();
        command.CommandText =
            "SELECT name FROM name_segment_vocab WHERE segment = $segment ORDER BY length(name) ASC LIMIT $limit";
        command.Parameters.AddWithValue("$segment", segment);
        command.Parameters.AddWithValue("$limit", limit);
        using var reader = command.ExecuteReader();
        var names = new List<string>();
        while (reader.Read())
        {
            names.Add(reader.GetString(0));
        }

        return names;
    }

    // How many distinct names each segment appears in — the rarity signal that
    // separates a discriminative word ("checkout") from a ubiquitous one ("state").
    // queries.ts:559. Input is prompt-bounded, so no chunking (matches TS).
    public Dictionary<string, int> GetSegmentNameCounts(IReadOnlyList<string> segments)
    {
        var counts = new Dictionary<string, int>();
        if (segments.Count == 0)
        {
            return counts;
        }

        using var command = Connection.CreateCommand();
        var placeholders = BindInList(command, segments, 0, segments.Count);
        command.CommandText =
            $"SELECT segment, COUNT(*) AS n FROM name_segment_vocab WHERE segment IN ({placeholders}) GROUP BY segment";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            counts[reader.GetString(0)] = (int)reader.GetInt64(1);
        }

        return counts;
    }

    // Names whose segments cover at least `minWords` distinct PROMPT WORDS — the
    // co-occurrence probe behind the medium tier (queries.ts:530). Takes
    // (segment-variant → original word) pairs and folds variants back to their word
    // INSIDE the SQL (a name matching both `service` and `services` counts ONE
    // word, not two) so plural-variant pairs can't tie genuine two-word matches and
    // crowd a real match past the LIMIT on vocab-heavy repos (#1146). Each `$s{i}`
    // is referenced twice (CASE arm + IN-list); named params bind to both.
    public List<(string Name, int Matches)> GetSegmentCoOccurrence(
        IReadOnlyList<(string Segment, string Word)> variants,
        int minWords,
        int limit)
    {
        var results = new List<(string Name, int Matches)>();
        if (variants.Count == 0)
        {
            return results;
        }

        using var command = Connection.CreateCommand();
        var whens = new StringBuilder();
        var inList = new StringBuilder();
        for (var i = 0; i < variants.Count; i++)
        {
            var segmentName = "$s" + i;
            var wordName = "$w" + i;
            whens.Append(" WHEN ").Append(segmentName).Append(" THEN ").Append(wordName);
            if (i > 0)
            {
                inList.Append(',');
            }

            inList.Append(segmentName);
            command.Parameters.AddWithValue(segmentName, variants[i].Segment);
            command.Parameters.AddWithValue(wordName, variants[i].Word);
        }

        command.Parameters.AddWithValue("$minWords", minWords);
        command.Parameters.AddWithValue("$limit", limit);
        command.CommandText =
            $"SELECT name, COUNT(DISTINCT CASE segment{whens} END) AS matches " +
            "FROM name_segment_vocab " +
            $"WHERE segment IN ({inList}) " +
            "GROUP BY name HAVING matches >= $minWords " +
            "ORDER BY matches DESC, length(name) ASC LIMIT $limit";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            results.Add((reader.GetString(0), (int)reader.GetInt64(1)));
        }

        return results;
    }

    // Identifier-segment splitting itself lives in CodeGraphIdentifierSegments
    // (Search/), the single home for that algorithm — InsertNameSegments above feeds
    // it into name_segment_vocab; getSegmentMatches reuses it on the query side.
}
