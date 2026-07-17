using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

// CodeGraphStore — search slice ≙ CodeGraph TS QueryBuilder search methods
// (queries.ts:987-1461) + the search/ scoring & parsing helpers
// (query-utils.ts, query-parser.ts). Ported behaviorally 1:1.
//
// Pipeline (searchNodes): parse field-qualifiers (kind:/lang:/path:/name:) ->
// FTS5 prefix (bm25(nodes_fts,0,20,5,1,2), 5x over-fetch) else LIKE substring
// else bounded-edit-distance fuzzy -> supplement exact-name matches (BM25 can
// bury short exact names) -> multi-signal rescore (kindBonus + pathRelevance +
// nameMatchBonus), stable sort, trim -> apply path:/name: hard filters last.
//
// Score is UNBOUNDED / non-normalized (analysis/05 R4): the FTS path returns a
// raw BM25 magnitude, the other paths ~0-1, and the rescore adds integer bonuses
// on top. The magnitudes are load-bearing for ranking parity with the TS engine.
internal sealed partial class CodeGraphStore
{
    // Project-name tokens (go.mod / package.json / repo dir), normalized. A query
    // word matching one is dropped from path-relevance scoring — it names the whole
    // project, not a symbol (#720). Empty by default (no down-weighting); set once
    // by the facade when the project opens.
    private HashSet<string> projectNameTokens = new();

    internal void SetProjectNameTokens(IEnumerable<string> tokens) =>
        projectNameTokens = new HashSet<string>(tokens);

    internal IReadOnlyCollection<string> ProjectNameTokens => projectNameTokens;

    // In-process working pair: a domain node plus its (mutable) running score. The
    // rescore path overwrites Score in place; projected to CodeGraphSearchResult
    // (which embeds a CodeGraphNodeView) only at the return boundary.
    private sealed class ScoredNode
    {
        public ScoredNode(CodeGraphNode node, double score)
        {
            Node = node;
            Score = score;
        }

        public CodeGraphNode Node { get; }

        public double Score { get; set; }
    }

    /// <summary>
    /// Search nodes by name using FTS with fallback to LIKE then fuzzy.
    /// (queries.ts:987 searchNodes)
    /// </summary>
    public List<CodeGraphSearchResult> SearchNodes(string query, CodeGraphSearchOptions? options = null)
    {
        var limit = options?.Limit ?? 100;
        var offset = options?.Offset ?? 0;

        // Field-qualified bits (kind:/lang:/path:/name:) split out; anything not
        // recognised stays in `text` and drives FTS/LIKE. Filters compose with the
        // SearchOptions arg (intersection-style).
        var parsed = CodeGraphSearchScoring.ParseQuery(query);
        var kinds = MergeFilters(options?.Kinds, parsed.Kinds);
        var languages = MergeFilters(options?.Languages, parsed.Languages);
        var pathFilters = parsed.PathFilters;
        var nameFilters = parsed.NameFilters;
        var text = parsed.Text;

        // First try FTS5 with prefix matching; if all the user typed was filters,
        // over-fetch by 5x from a match-everything path (path:/name: post-filters
        // can be very selective).
        var results = !string.IsNullOrEmpty(text)
            ? SearchNodesFts(text, kinds, languages, limit, offset)
            : SearchAllByFilters(kinds, languages, limit * 5);

        // No FTS results -> LIKE substring search.
        if (results.Count == 0 && text.Length >= 2)
        {
            results = SearchNodesLike(text, kinds, languages, limit, offset);
        }

        // Final fuzzy fallback: only when both FTS and LIKE returned nothing AND the
        // text is long enough to be worth fuzzing (1-2 char queries match too much).
        if (results.Count == 0 && text.Length >= 3)
        {
            results = SearchNodesFuzzy(text, kinds, languages, limit);
        }

        // Supplement: ensure exact name matches are always candidates. BM25 can bury
        // short exact-match names under hundreds of compound names before post-hoc
        // scoring can help. Base them at the max BM25 score so the nameMatchBonus
        // (exact=80 vs prefix) actually differentiates them after rescoring.
        if (results.Count > 0 && !string.IsNullOrEmpty(query))
        {
            var existingIds = new HashSet<string>(results.Select(r => r.Node.Id));
            var maxFtsScore = results.Max(r => r.Score);
            var terms = query
                .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Where(t => t.Length >= 2);
            foreach (var term in terms)
            {
                var sql = new StringBuilder("SELECT ");
                sql.Append(NodeColumns);
                sql.Append(" FROM nodes WHERE name = $term COLLATE NOCASE");
                using var command = connection.CreateCommand();
                command.Parameters.AddWithValue("$term", term);
                AppendInClause(sql, command, "kind", kinds, "k");
                AppendInClause(sql, command, "language", languages, "l");
                sql.Append(" LIMIT 20");
                command.CommandText = sql.ToString();
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var node = RowToNode(reader);
                    if (existingIds.Add(node.Id))
                    {
                        results.Add(new ScoredNode(node, maxFtsScore));
                    }
                }
            }
        }

        // Multi-signal rescore, stable sort, trim to the requested limit.
        if (results.Count > 0 && (!string.IsNullOrEmpty(text) || !string.IsNullOrEmpty(query)))
        {
            var scoringQuery = !string.IsNullOrEmpty(text) ? text : query;
            foreach (var r in results)
            {
                r.Score = r.Score
                    + CodeGraphSearchScoring.KindBonus(r.Node.Kind)
                    + CodeGraphSearchScoring.ScorePathRelevance(r.Node.FilePath, scoringQuery, projectNameTokens)
                    + CodeGraphSearchScoring.NameMatchBonus(r.Node.Name, scoringQuery);
            }

            results = results.OrderByDescending(r => r.Score).ToList();
            if (results.Count > limit)
            {
                results = results.GetRange(0, limit);
            }
        }

        // Apply path: + name: filters AFTER scoring — scoring uses them as a soft
        // signal, these are the hard gate, done last so FTS fetched plenty to narrow.
        if (pathFilters.Count > 0)
        {
            var lowered = pathFilters.Select(p => p.ToLowerInvariant()).ToList();
            results = results
                .Where(r =>
                {
                    var fp = r.Node.FilePath.ToLowerInvariant();
                    return lowered.Any(p => fp.Contains(p));
                })
                .ToList();
        }

        if (nameFilters.Count > 0)
        {
            var lowered = nameFilters.Select(n => n.ToLowerInvariant()).ToList();
            results = results
                .Where(r =>
                {
                    var nm = r.Node.Name.ToLowerInvariant();
                    return lowered.Any(n => nm.Contains(n));
                })
                .ToList();
        }

        return results
            .Select(r => new CodeGraphSearchResult(CodeGraphNodeView.From(r.Node), r.Score))
            .ToList();
    }

    /// <summary>
    /// Find nodes by exact name match, two-pass with a co-location boost.
    /// (queries.ts:1336 findNodesByExactName)
    /// </summary>
    public List<CodeGraphSearchResult> FindNodesByExactName(
        IReadOnlyList<string> names,
        CodeGraphSearchOptions? options = null)
    {
        if (names.Count == 0)
        {
            return new List<CodeGraphSearchResult>();
        }

        var kinds = options?.Kinds;
        var languages = options?.Languages;
        var limit = options?.Limit ?? 50;

        // Pass 1: find files containing each queried name; identify distinctive
        // (rare) names. Common names ("run" has 40+ matches) carry no location
        // signal; names in fewer than 10 files do.
        var nameToFiles = new Dictionary<string, HashSet<string>>();
        foreach (var name in names)
        {
            var sql = new StringBuilder(
                "SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = $name");
            using var command = connection.CreateCommand();
            command.Parameters.AddWithValue("$name", name);
            AppendInClause(sql, command, "kind", kinds, "k");
            sql.Append(" LIMIT 100");
            command.CommandText = sql.ToString();

            var files = new HashSet<string>();
            using (var reader = command.ExecuteReader())
            {
                while (reader.Read())
                {
                    files.Add(reader.GetString(0));
                }
            }

            nameToFiles[name.ToLowerInvariant()] = files;
        }

        var distinctiveFiles = new HashSet<string>();
        foreach (var files in nameToFiles.Values)
        {
            if (files.Count > 0 && files.Count < 10)
            {
                foreach (var f in files)
                {
                    distinctiveFiles.Add(f);
                }
            }
        }

        // Pass 2: query each name with a per-name limit, scoring by co-location.
        var perNameLimit = Math.Max(8, (int)Math.Ceiling((double)limit / names.Count));
        var allResults = new List<ScoredNode>();
        var seenIds = new HashSet<string>();

        foreach (var name in names)
        {
            var sql = new StringBuilder("SELECT ");
            sql.Append(NodeColumns);
            sql.Append(", 1.0 as score FROM nodes WHERE name COLLATE NOCASE = $name");
            using var command = connection.CreateCommand();
            command.Parameters.AddWithValue("$name", name);
            AppendInClause(sql, command, "kind", kinds, "k");
            AppendInClause(sql, command, "language", languages, "l");
            // Fetch enough to find co-located results among common names.
            sql.Append(" LIMIT $limit");
            command.Parameters.AddWithValue("$limit", Math.Max(perNameLimit * 3, 50));
            command.CommandText = sql.ToString();

            var nameResults = new List<ScoredNode>();
            using (var reader = command.ExecuteReader())
            {
                while (reader.Read())
                {
                    var node = RowToNode(reader);
                    if (seenIds.Contains(node.Id))
                    {
                        continue;
                    }

                    var baseScore = reader.GetDouble(21);
                    var coLocationBoost = distinctiveFiles.Contains(node.FilePath) ? 20 : 0;
                    nameResults.Add(new ScoredNode(node, baseScore + coLocationBoost));
                }
            }

            foreach (var r in nameResults.OrderByDescending(r => r.Score).Take(perNameLimit))
            {
                seenIds.Add(r.Node.Id);
                allResults.Add(r);
            }
        }

        return allResults
            .OrderByDescending(r => r.Score)
            .Take(limit)
            .Select(r => new CodeGraphSearchResult(CodeGraphNodeView.From(r.Node), r.Score))
            .ToList();
    }

    // Match-everything path used when only field filters were supplied (no text).
    // Ordered by name; the caller's post-filter narrows further. (queries.ts:1112)
    private List<ScoredNode> SearchAllByFilters(
        IReadOnlyList<string>? kinds,
        IReadOnlyList<string>? languages,
        int limit)
    {
        var sql = new StringBuilder("SELECT ");
        sql.Append(NodeColumns);
        sql.Append(" FROM nodes WHERE 1=1");
        using var command = connection.CreateCommand();
        AppendInClause(sql, command, "kind", kinds, "k");
        AppendInClause(sql, command, "language", languages, "l");
        sql.Append(" ORDER BY name LIMIT $limit");
        command.Parameters.AddWithValue("$limit", limit);
        command.CommandText = sql.ToString();

        var results = new List<ScoredNode>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new ScoredNode(RowToNode(reader), 1.0));
        }

        return results;
    }

    // FTS5 search with prefix matching (queries.ts:1201 searchNodesFTS).
    private List<ScoredNode> SearchNodesFts(
        string query,
        IReadOnlyList<string>? kinds,
        IReadOnlyList<string>? languages,
        int limit,
        int offset)
    {
        var match = CodeGraphSearchScoring.BuildFtsMatchQuery(query);
        if (string.IsNullOrEmpty(match))
        {
            return new List<ScoredNode>();
        }

        // Over-fetch 5x so post-hoc rescoring can promote results BM25 undervalues.
        var ftsLimit = Math.Max(limit * 5, 100);

        // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1,
        // signature=2. Heavy name weight ranks exact/prefix name matches above
        // incidental mentions in long docstrings or nested qualified names.
        var sql = new StringBuilder(
            "SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score " +
            "FROM nodes_fts JOIN nodes ON nodes_fts.id = nodes.id " +
            "WHERE nodes_fts MATCH $match");
        using var command = connection.CreateCommand();
        command.Parameters.AddWithValue("$match", match);
        AppendInClause(sql, command, "nodes.kind", kinds, "k");
        AppendInClause(sql, command, "nodes.language", languages, "l");
        sql.Append(" ORDER BY score LIMIT $limit OFFSET $offset");
        command.Parameters.AddWithValue("$limit", ftsLimit);
        command.Parameters.AddWithValue("$offset", offset);
        command.CommandText = sql.ToString();

        var results = new List<ScoredNode>();
        try
        {
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var node = RowToNode(reader);
                // bm25 returns negative scores; take the magnitude.
                var score = Math.Abs(reader.GetDouble(21));
                results.Add(new ScoredNode(node, score));
            }
        }
        catch (SqliteException)
        {
            // FTS query failed (malformed MATCH); return empty like the TS try/catch.
            return new List<ScoredNode>();
        }

        return results;
    }

    // LIKE-based substring search — camelCase-part matching FTS misses, e.g.
    // "signIn" finds "signInWithGoogle". (queries.ts:1270 searchNodesLike)
    private List<ScoredNode> SearchNodesLike(
        string query,
        IReadOnlyList<string>? kinds,
        IReadOnlyList<string>? languages,
        int limit,
        int offset)
    {
        var sql = new StringBuilder();
        sql.Append("SELECT nodes.*, CASE ");
        sql.Append("WHEN name = $exact THEN 1.0 ");
        sql.Append("WHEN name LIKE $startsWith THEN 0.9 ");
        sql.Append("WHEN name LIKE $contains THEN 0.8 ");
        sql.Append("WHEN qualified_name LIKE $contains THEN 0.7 ");
        sql.Append("ELSE 0.5 END as score FROM nodes ");
        sql.Append("WHERE (name LIKE $contains OR qualified_name LIKE $contains OR name LIKE $startsWith)");

        using var command = connection.CreateCommand();
        command.Parameters.AddWithValue("$exact", query);
        command.Parameters.AddWithValue("$startsWith", query + "%");
        command.Parameters.AddWithValue("$contains", "%" + query + "%");
        AppendInClause(sql, command, "kind", kinds, "k");
        AppendInClause(sql, command, "language", languages, "l");
        sql.Append(" ORDER BY score DESC, length(name) ASC LIMIT $limit OFFSET $offset");
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        command.CommandText = sql.ToString();

        var results = new List<ScoredNode>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new ScoredNode(RowToNode(reader), reader.GetDouble(21)));
        }

        return results;
    }

    // Fuzzy fallback: bounded edit-distance sweep over the distinct symbol-name set
    // when FTS + LIKE returned nothing. (queries.ts:1142 searchNodesFuzzy)
    private List<ScoredNode> SearchNodesFuzzy(
        string text,
        IReadOnlyList<string>? kinds,
        IReadOnlyList<string>? languages,
        int limit)
    {
        var lowered = text.ToLowerInvariant();
        // Cap maxDist at 2 so "getUssr" finds "getUser" but "process" != "prosody".
        var maxDist = lowered.Length <= 4 ? 1 : 2;

        var candidates = new List<(string Name, int Dist)>();
        foreach (var name in GetDistinctNodeNamesForFuzzy())
        {
            var dist = CodeGraphSearchScoring.BoundedEditDistance(name.ToLowerInvariant(), lowered, maxDist);
            if (dist <= maxDist)
            {
                candidates.Add((name, dist));
            }
        }

        var ordered = candidates.OrderBy(c => c.Dist).ToList();

        // Cap the per-name follow-up queries; each survivor triggers its own SELECT.
        var followupCap = Math.Max(limit * 2, 50);
        var capped = ordered.Count > followupCap ? ordered.GetRange(0, followupCap) : ordered;

        var results = new List<ScoredNode>();
        var seen = new HashSet<string>();
        foreach (var c in capped)
        {
            if (results.Count >= limit)
            {
                break;
            }

            var sql = new StringBuilder("SELECT ");
            sql.Append(NodeColumns);
            sql.Append(" FROM nodes WHERE name = $name");
            using var command = connection.CreateCommand();
            command.Parameters.AddWithValue("$name", c.Name);
            AppendInClause(sql, command, "kind", kinds, "k");
            AppendInClause(sql, command, "language", languages, "l");
            sql.Append(" LIMIT 5");
            command.CommandText = sql.ToString();

            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var node = RowToNode(reader);
                if (!seen.Add(node.Id))
                {
                    continue;
                }

                // Lower the score per edit step so dist-0 fallbacks outrank dist-2.
                results.Add(new ScoredNode(node, 1.0 / (1 + c.Dist)));
                if (results.Count >= limit)
                {
                    break;
                }
            }
        }

        return results;
    }

    // Distinct symbol-name set for the fuzzy sweep (queries.ts getAllNodeNames);
    // inlined here so the search slice is self-contained.
    private List<string> GetDistinctNodeNamesForFuzzy()
    {
        var names = new List<string>();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT DISTINCT name FROM nodes";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            names.Add(reader.GetString(0));
        }

        return names;
    }

    // parsed-filters ∪ options-filters, deduped, insertion-ordered — the analog of
    // `Array.from(new Set([...options, ...parsed]))`. Returns options unchanged when
    // the query carried no filter of that kind.
    private static IReadOnlyList<string>? MergeFilters(
        IReadOnlyList<string>? optionValues,
        List<string> parsedValues)
    {
        if (parsedValues.Count == 0)
        {
            return optionValues;
        }

        var seen = new HashSet<string>();
        var merged = new List<string>();
        if (optionValues is not null)
        {
            foreach (var v in optionValues)
            {
                if (seen.Add(v))
                {
                    merged.Add(v);
                }
            }
        }

        foreach (var v in parsedValues)
        {
            if (seen.Add(v))
            {
                merged.Add(v);
            }
        }

        return merged;
    }

    // Append ` AND {column} IN ($prefix0, $prefix1, ...)` and bind each value. No-op
    // for a null/empty list. The prefix must be unique within one command (use "k"
    // for kinds, "l" for languages).
    private static void AppendInClause(
        StringBuilder sql,
        SqliteCommand command,
        string column,
        IReadOnlyList<string>? values,
        string prefix)
    {
        if (values is null || values.Count == 0)
        {
            return;
        }

        sql.Append(" AND ").Append(column).Append(" IN (");
        for (var i = 0; i < values.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            var name = "$" + prefix + i.ToString(System.Globalization.CultureInfo.InvariantCulture);
            sql.Append(name);
            command.Parameters.AddWithValue(name, values[i]);
        }

        sql.Append(')');
    }
}

// Pure, reflection-free search scoring & query-parsing helpers ≙ CodeGraph
// src/search/query-utils.ts + query-parser.ts. Stateless (projectNameTokens is
// passed in), so they are shared statics rather than instance methods.
internal static class CodeGraphSearchScoring
{
    // Common stop words filtered from search queries: generic English + code noise.
    // Deliberately excludes common symbol names (get/set/add/build/find/list).
    private static readonly HashSet<string> StopWords = new()
    {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "is", "it", "that", "this", "are", "was",
        "be", "has", "had", "have", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "can", "shall", "not", "no", "all", "each",
        "every", "how", "what", "where", "when", "who", "which", "why",
        "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
        "show", "give", "tell",
        "been", "done", "made", "used", "using", "work", "works", "found",
        "also", "into", "then", "than", "just", "more", "some", "such",
        "over", "only", "out", "its", "so", "up", "as", "if",
        "look", "need", "needs", "want", "happen", "happens",
        "affect", "affected", "break", "breaks", "failing",
        "implemented", "implement",
        "code", "file", "files", "function", "method", "class", "type",
        "fix", "bug", "called"
    };

    private static readonly string[] NonProductionDirs =
    {
        "integration", "sample", "samples", "example", "examples",
        "fixture", "fixtures", "benchmark", "benchmarks", "demo", "demos"
    };

    private static readonly Regex CompoundIdentifier =
        new(@"\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b");

    private static readonly Regex SnakeIdentifier =
        new(@"\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b");

    private static readonly Regex CamelBoundaryLower = new("([a-z])([A-Z])");
    private static readonly Regex CamelBoundaryAcronym = new("([A-Z]+)([A-Z][a-z])");
    private static readonly Regex UnderscoreDot = new("[_.]+");
    private static readonly Regex NonAlphaNum = new("[^a-zA-Z0-9]+");
    private static readonly Regex Whitespace = new(@"\s+");
    private static readonly Regex NameTermSplit = new(@"[\s_.-]+");
    private static readonly Regex FtsSpecialChars = new("['\"*():^]");
    private static readonly Regex FtsBooleanOp = new("^(AND|OR|NOT|NEAR)$", RegexOptions.IgnoreCase);

    private static readonly Regex TestFileNameSep = new(@"[._-](test|tests|spec|specs)\.[a-z0-9]+$");
    private static readonly Regex TestFileNameCamel = new(@"(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$");
    private static readonly Regex TestSourceSetDir = new(@"(?:^|/)[A-Za-z0-9]*(?:Test|Tests|Spec)/");

    // ---------------------------------------------------------------------------
    // Field-qualified query parsing (query-parser.ts)
    // ---------------------------------------------------------------------------

    private static readonly HashSet<string> KindValues = new(CodeGraphNodeKind.All);
    private static readonly HashSet<string> LanguageValues = new(CodeGraphLanguage.All);

    /// <summary>
    /// Parse a raw query into structured filters + remaining text. Never throws.
    /// (query-parser.ts:66 parseQuery)
    /// </summary>
    public static CodeGraphParsedQuery ParseQuery(string raw)
    {
        var kinds = new List<string>();
        var languages = new List<string>();
        var pathFilters = new List<string>();
        var nameFilters = new List<string>();
        var textParts = new List<string>();

        foreach (var token in TokenizeQuery(raw))
        {
            var colon = token.IndexOf(':');
            if (colon <= 0 || colon == token.Length - 1)
            {
                textParts.Add(token);
                continue;
            }

            var key = token.Substring(0, colon).ToLowerInvariant();
            var valueRaw = Unquote(token.Substring(colon + 1));
            if (valueRaw.Length == 0)
            {
                textParts.Add(token);
                continue;
            }

            switch (key)
            {
                case "kind":
                    if (KindValues.Contains(valueRaw))
                    {
                        kinds.Add(valueRaw);
                    }
                    else
                    {
                        textParts.Add(token);
                    }

                    break;
                case "lang":
                case "language":
                    var lower = valueRaw.ToLowerInvariant();
                    if (LanguageValues.Contains(lower))
                    {
                        languages.Add(lower);
                    }
                    else
                    {
                        textParts.Add(token);
                    }

                    break;
                case "path":
                    pathFilters.Add(valueRaw);
                    break;
                case "name":
                    nameFilters.Add(valueRaw);
                    break;
                default:
                    textParts.Add(token);
                    break;
            }
        }

        var text = string.Join(" ", textParts).Trim();
        return new CodeGraphParsedQuery(text, kinds, languages, pathFilters, nameFilters);
    }

    // Quote-aware whitespace tokenizer: a `"` (leading or mid-token) swallows to the
    // matching `"`, whitespace and all; an unterminated quote swallows the rest.
    private static List<string> TokenizeQuery(string raw)
    {
        var tokens = new List<string>();
        var i = 0;
        while (i < raw.Length)
        {
            while (i < raw.Length && char.IsWhiteSpace(raw[i]))
            {
                i++;
            }

            if (i >= raw.Length)
            {
                break;
            }

            var start = i;
            while (i < raw.Length && !char.IsWhiteSpace(raw[i]))
            {
                if (raw[i] == '"')
                {
                    var end = raw.IndexOf('"', i + 1);
                    if (end == -1)
                    {
                        i = raw.Length;
                        break;
                    }

                    i = end + 1;
                    continue;
                }

                i++;
            }

            tokens.Add(raw.Substring(start, i - start));
        }

        return tokens;
    }

    private static string Unquote(string s)
    {
        if (s.Length >= 2 && s[0] == '"' && s[^1] == '"')
        {
            return s.Substring(1, s.Length - 2);
        }

        return s;
    }

    // ---------------------------------------------------------------------------
    // FTS match-query construction (queries.ts:1211)
    // ---------------------------------------------------------------------------

    // `::` (Rust/C++/Ruby qualifier separator) -> whitespace before stripping FTS
    // special chars; each surviving term becomes a prefix match ("term"*), OR-joined.
    public static string BuildFtsMatchQuery(string query)
    {
        var cleaned = FtsSpecialChars.Replace(query.Replace("::", " "), string.Empty);
        var parts = new List<string>();
        foreach (var term in cleaned.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            if (FtsBooleanOp.IsMatch(term))
            {
                continue;
            }

            parts.Add("\"" + term + "\"*");
        }

        return string.Join(" OR ", parts);
    }

    // ---------------------------------------------------------------------------
    // Term extraction + stemming (query-utils.ts)
    // ---------------------------------------------------------------------------

    /// <summary>Normalize a name to a comparable token: lowercase, alphanumerics only.</summary>
    public static string NormalizeNameToken(string raw)
    {
        var sb = new StringBuilder(raw.Length);
        foreach (var ch in raw.ToLowerInvariant())
        {
            if (ch is >= 'a' and <= 'z' or >= '0' and <= '9')
            {
                sb.Append(ch);
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Extract meaningful search terms: split camel/Pascal/snake/dot, drop stop
    /// words, optionally add stem variants. (query-utils.ts:156 extractSearchTerms)
    /// </summary>
    public static List<string> ExtractSearchTerms(string query, bool includeStems = true)
    {
        var tokens = new List<string>();
        var seen = new HashSet<string>();

        void Add(string t)
        {
            if (seen.Add(t))
            {
                tokens.Add(t);
            }
        }

        // Preserve compound identifiers (scrapeLoop, UserService) before splitting.
        foreach (Match m in CompoundIdentifier.Matches(query))
        {
            var g = m.Groups[1].Value;
            if (g.Length >= 3)
            {
                Add(g.ToLowerInvariant());
            }
        }

        // snake_case (scrape_loop, user_service).
        foreach (Match m in SnakeIdentifier.Matches(query))
        {
            var g = m.Groups[1].Value;
            if (g.Length >= 3)
            {
                Add(g.ToLowerInvariant());
            }
        }

        // Split camelCase/PascalCase, then underscores/dots -> spaces.
        var camelSplit = CamelBoundaryAcronym.Replace(
            CamelBoundaryLower.Replace(query, "$1 $2"), "$1 $2");
        var normalised = UnderscoreDot.Replace(camelSplit, " ");

        foreach (var word in NonAlphaNum.Split(normalised))
        {
            if (word.Length == 0)
            {
                continue;
            }

            var lower = word.ToLowerInvariant();
            if (lower.Length < 3 || StopWords.Contains(lower))
            {
                continue;
            }

            Add(lower);
        }

        // Stem variants for broader FTS matching (caching -> cache, eviction -> evict).
        if (includeStems)
        {
            var stems = new List<string>();
            var stemSeen = new HashSet<string>();
            foreach (var token in tokens.ToList())
            {
                foreach (var variant in GetStemVariants(token))
                {
                    if (!seen.Contains(variant) && !StopWords.Contains(variant) && stemSeen.Add(variant))
                    {
                        stems.Add(variant);
                    }
                }
            }

            foreach (var stem in stems)
            {
                Add(stem);
            }
        }

        return tokens;
    }

    /// <summary>
    /// Stem variants by stripping common English suffixes (used as FTS prefixes, so
    /// they need not be perfect words). (query-utils.ts:85 getStemVariants)
    /// </summary>
    public static List<string> GetStemVariants(string term)
    {
        var variants = new HashSet<string>();
        var t = term.ToLowerInvariant();

        // -ing: caching -> cach/cache, running -> run
        if (t.EndsWith("ing", StringComparison.Ordinal) && t.Length > 5)
        {
            var baseTerm = t.Substring(0, t.Length - 3);
            variants.Add(baseTerm);
            variants.Add(baseTerm + "e");
            if (baseTerm.Length >= 2 && baseTerm[^1] == baseTerm[^2])
            {
                variants.Add(baseTerm.Substring(0, baseTerm.Length - 1));
            }
        }

        // -tion/-sion: eviction -> evict
        if ((t.EndsWith("tion", StringComparison.Ordinal) || t.EndsWith("sion", StringComparison.Ordinal)) && t.Length > 5)
        {
            variants.Add(t.Substring(0, t.Length - 3));
        }

        // -ment: management -> manage
        if (t.EndsWith("ment", StringComparison.Ordinal) && t.Length > 6)
        {
            variants.Add(t.Substring(0, t.Length - 4));
        }

        // -ies: entries -> entry
        if (t.EndsWith("ies", StringComparison.Ordinal) && t.Length > 4)
        {
            variants.Add(t.Substring(0, t.Length - 3) + "y");
        }

        // -es: processes -> process, classes -> class
        else if (t.EndsWith("es", StringComparison.Ordinal) && t.Length > 4)
        {
            variants.Add(t.Substring(0, t.Length - 2));
        }

        // -s: errors -> error (skip -ss like "class")
        else if (t.EndsWith("s", StringComparison.Ordinal) && !t.EndsWith("ss", StringComparison.Ordinal) && t.Length > 4)
        {
            variants.Add(t.Substring(0, t.Length - 1));
        }

        // -ed: handled -> handle, carried -> carry
        if (t.EndsWith("ed", StringComparison.Ordinal) && !t.EndsWith("eed", StringComparison.Ordinal) && t.Length > 4)
        {
            variants.Add(t.Substring(0, t.Length - 1));
            variants.Add(t.Substring(0, t.Length - 2));
            if (t.EndsWith("ied", StringComparison.Ordinal) && t.Length > 5)
            {
                variants.Add(t.Substring(0, t.Length - 3) + "y");
            }
        }

        // -er: builder -> build/builde, getter -> get
        if (t.EndsWith("er", StringComparison.Ordinal) && t.Length > 4)
        {
            var baseTerm = t.Substring(0, t.Length - 2);
            variants.Add(baseTerm);
            variants.Add(baseTerm + "e");
            if (baseTerm.Length >= 2 && baseTerm[^1] == baseTerm[^2])
            {
                variants.Add(baseTerm.Substring(0, baseTerm.Length - 1));
            }
        }

        return variants.Where(v => v.Length >= 3 && v != t).ToList();
    }

    // ---------------------------------------------------------------------------
    // Scoring signals (query-utils.ts)
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Score path relevance to a query (higher = more relevant). Scores per original
    /// query WORD, not per sub-token, so a compound word matching one path segment
    /// counts once. (query-utils.ts:221 scorePathRelevance)
    /// </summary>
    public static int ScorePathRelevance(string filePath, string query, IReadOnlySet<string>? projectNameTokens)
    {
        var pathLower = filePath.ToLowerInvariant();
        var fileName = BaseName(filePath).ToLowerInvariant();
        var dirName = DirName(filePath).ToLowerInvariant();
        var score = 0;

        var allWords = query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (allWords.Length == 0)
        {
            return 0;
        }

        // Drop query words that just name the PROJECT — no discriminative path signal
        // (#720) — but only when other words remain.
        string[] words;
        if (projectNameTokens is { Count: > 0 })
        {
            var filtered = allWords.Where(w => !projectNameTokens.Contains(NormalizeNameToken(w))).ToArray();
            words = filtered.Length > 0 ? filtered : allWords;
        }
        else
        {
            words = allWords;
        }

        foreach (var word in words)
        {
            // Base terms only — stem variants inflate path scores.
            var subtokens = ExtractSearchTerms(word, includeStems: false);
            if (subtokens.Count == 0)
            {
                continue;
            }

            if (subtokens.Any(t => fileName.Contains(t)))
            {
                score += 10;
            }

            if (subtokens.Any(t => dirName.Contains(t)))
            {
                score += 5;
            }
            else if (subtokens.Any(t => pathLower.Contains(t)))
            {
                score += 3;
            }
        }

        // Deprioritize test files unless the query is explicitly about tests.
        var queryLower = query.ToLowerInvariant();
        var isTestQuery = queryLower.Contains("test") || queryLower.Contains("spec");
        if (!isTestQuery && IsTestFile(filePath))
        {
            score -= 15;
        }

        return score;
    }

    /// <summary>Whether a file path looks like a test file. (query-utils.ts:280 isTestFile)</summary>
    public static bool IsTestFile(string filePath)
    {
        var lower = filePath.ToLowerInvariant();
        var fileName = BaseName(filePath); // original case — needed for camelCase boundaries
        var lowerName = fileName.ToLowerInvariant();

        if (lowerName.StartsWith("test_", StringComparison.Ordinal) ||
            lowerName.StartsWith("test.", StringComparison.Ordinal) ||
            TestFileNameSep.IsMatch(lowerName) ||
            TestFileNameCamel.IsMatch(fileName))
        {
            return true;
        }

        if (lower.Contains("/tests/") || lower.Contains("/test/") ||
            lower.Contains("/__tests__/") || lower.Contains("/spec/") ||
            lower.Contains("/specs/") || lower.Contains("/testlib/") ||
            lower.Contains("/testing/") ||
            lower.StartsWith("test/", StringComparison.Ordinal) || lower.StartsWith("tests/", StringComparison.Ordinal) ||
            lower.StartsWith("spec/", StringComparison.Ordinal) || lower.StartsWith("specs/", StringComparison.Ordinal) ||
            TestSourceSetDir.IsMatch(filePath))
        {
            return true;
        }

        return MatchesNonProductionDir(lower);
    }

    private static bool MatchesNonProductionDir(string lowerPath)
    {
        foreach (var dir in NonProductionDirs)
        {
            if (lowerPath.Contains("/" + dir + "/") ||
                lowerPath.StartsWith(dir + "/", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Bonus when a node's name matches the query — exact largest, prefix scaled by
    /// length ratio. (query-utils.ts:343 nameMatchBonus)
    /// </summary>
    public static int NameMatchBonus(string nodeName, string query)
    {
        var nameLower = nodeName.ToLowerInvariant();

        // camelCase-split word-level terms ("CacheBuilder build" -> cache/builder/build).
        var rawTerms = NameTermSplit
            .Split(CamelBoundaryLower.Replace(query, "$1 $2"))
            .Select(t => t.ToLowerInvariant())
            .Where(t => t.Length >= 2)
            .ToList();

        // Original space-separated tokens for exact-term matching.
        var queryTokens = query
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Select(t => t.ToLowerInvariant())
            .Where(t => t.Length >= 2)
            .ToList();

        // Full query as a single token (compound identifiers like "CacheBuilder").
        var queryLower = Whitespace.Replace(query, string.Empty).ToLowerInvariant();

        if (nameLower == queryLower)
        {
            return 80;
        }

        if (queryTokens.Count > 1 && queryTokens.Contains(nameLower))
        {
            return 60;
        }

        if (nameLower.StartsWith(queryLower, StringComparison.Ordinal))
        {
            var ratio = nameLower.Length == 0 ? 0.0 : (double)queryLower.Length / nameLower.Length;
            // JS Math.round (half up) — value is always positive here.
            return (int)Math.Floor((10 + 30 * ratio) + 0.5);
        }

        if (rawTerms.Count > 1 && rawTerms.All(t => nameLower.Contains(t)))
        {
            return 15;
        }

        if (nameLower.Contains(queryLower))
        {
            return 10;
        }

        return 0;
    }

    /// <summary>Kind-based bonus for search ranking. (query-utils.ts:388 kindBonus)</summary>
    public static int KindBonus(string kind) => kind switch
    {
        CodeGraphNodeKind.Function => 10,
        CodeGraphNodeKind.Method => 10,
        CodeGraphNodeKind.Class => 8,
        CodeGraphNodeKind.Interface => 9,
        CodeGraphNodeKind.TypeAlias => 6,
        CodeGraphNodeKind.Struct => 6,
        CodeGraphNodeKind.Trait => 9,
        CodeGraphNodeKind.Enum => 5,
        CodeGraphNodeKind.Component => 8,
        CodeGraphNodeKind.Route => 9,
        CodeGraphNodeKind.Module => 4,
        CodeGraphNodeKind.Property => 3,
        CodeGraphNodeKind.Field => 3,
        CodeGraphNodeKind.Variable => 2,
        CodeGraphNodeKind.Constant => 3,
        CodeGraphNodeKind.Import => 1,
        CodeGraphNodeKind.Export => 1,
        CodeGraphNodeKind.Parameter => 0,
        CodeGraphNodeKind.Namespace => 4,
        CodeGraphNodeKind.File => 0,
        CodeGraphNodeKind.Protocol => 9,
        CodeGraphNodeKind.EnumMember => 3,
        _ => 0
    };

    // ---------------------------------------------------------------------------
    // Bounded edit distance (query-parser.ts:157)
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Bounded Levenshtein distance; returns maxDist + 1 as soon as the distance is
    /// known to exceed maxDist. Compares case-folded inputs (callers pass lowercase).
    /// </summary>
    public static int BoundedEditDistance(string a, string b, int maxDist)
    {
        if (a == b)
        {
            return 0;
        }

        var al = a.Length;
        var bl = b.Length;
        if (Math.Abs(al - bl) > maxDist)
        {
            return maxDist + 1;
        }

        if (al == 0)
        {
            return bl;
        }

        if (bl == 0)
        {
            return al;
        }

        var prev = new int[bl + 1];
        var cur = new int[bl + 1];
        for (var j = 0; j <= bl; j++)
        {
            prev[j] = j;
        }

        for (var i = 1; i <= al; i++)
        {
            cur[0] = i;
            var rowMin = cur[0];
            for (var j = 1; j <= bl; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                var insertion = cur[j - 1] + 1;
                var deletion = prev[j] + 1;
                var substitution = prev[j - 1] + cost;
                cur[j] = Math.Min(Math.Min(insertion, deletion), substitution);
                if (cur[j] < rowMin)
                {
                    rowMin = cur[j];
                }
            }

            if (rowMin > maxDist)
            {
                return maxDist + 1;
            }

            (prev, cur) = (cur, prev);
        }

        return prev[bl];
    }

    // Node's path.basename over '/'-separated (normalized) graph paths.
    private static string BaseName(string p)
    {
        var idx = p.LastIndexOf('/');
        return idx >= 0 ? p.Substring(idx + 1) : p;
    }

    // Node's path.dirname over '/'-separated paths ('a/b'->'a', 'a'->'.', '/a'->'/').
    private static string DirName(string p)
    {
        var idx = p.LastIndexOf('/');
        if (idx < 0)
        {
            return ".";
        }

        return idx == 0 ? "/" : p.Substring(0, idx);
    }
}

// parseQuery result (query-parser.ts ParsedQuery). In-process only.
internal sealed record CodeGraphParsedQuery(
    string Text,
    List<string> Kinds,
    List<string> Languages,
    List<string> PathFilters,
    List<string> NameFilters);
