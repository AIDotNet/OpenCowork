using Microsoft.Data.Sqlite;

// Shared WS-B harness (analysis/03 §"in-memory stub" = a REAL temp-dir store).
//
// CodeGraph's tests never mock the graph: db-perf.test.ts / graph.test.ts seed a
// real SQLite DB via a `makeNode()` factory and exercise the shipping query/traversal
// code. These helpers reproduce that: `MakeNode`/`MakeEdge` are the C# builders, and
// `OpenTempStore` opens a real graph DB (WAL + FTS5 + the idx_edges_identity UNIQUE
// index) on a fresh temp path through the Core factory.
internal static class CodeGraphTestSupport
{
    // Fixed clock so seeded nodes are byte-deterministic across a run (the actual
    // value is irrelevant to every assertion; only INSERT-OR-REPLACE tests vary it).
    internal const long FixedClock = 1_700_000_000_000L;

    // ≙ db-perf.test.ts makeNode(id, name=id): a 'function' node, name defaulting to
    // the id, in a.ts / typescript on line 1. Every field the graph-traversal seed
    // needs to override (kind/name/filePath/language/startLine) is a named optional.
    internal static CodeGraphNode MakeNode(
        string id,
        string? name = null,
        string kind = CodeGraphNodeKind.Function,
        string filePath = "a.ts",
        int startLine = 1,
        int endLine = 1,
        string language = CodeGraphLanguage.TypeScript,
        bool isExported = false,
        long updatedAt = FixedClock,
        string? qualifiedName = null)
        => new(
            Id: id,
            Kind: kind,
            Name: name ?? id,
            QualifiedName: qualifiedName ?? name ?? id,
            FilePath: filePath,
            Language: language,
            StartLine: startLine,
            EndLine: endLine,
            StartColumn: 0,
            EndColumn: 0,
            Docstring: null,
            Signature: null,
            Visibility: null,
            IsExported: isExported,
            IsAsync: false,
            IsStatic: false,
            IsAbstract: false,
            Decorators: null,
            TypeParameters: null,
            ReturnType: null,
            UpdatedAt: updatedAt);

    // ≙ the { source, target, kind, line?, column?, metadata? } edge literals the
    // suites build. Metadata is the RAW JSON string carried verbatim on the domain
    // type (never modeled — reference/01 §3).
    internal static CodeGraphEdge MakeEdge(
        string source,
        string target,
        string kind,
        int? line = null,
        int? column = null,
        string? metadata = null,
        string? provenance = null)
        => new(source, target, kind, metadata, line, column, provenance);

    // A real on-disk SQLite graph store on a fresh temp directory. The caller owns
    // both the store (Dispose) and the directory (DeleteDir) — mirrors the
    // mkdtempSync + rmSync beforeEach/afterEach pair.
    internal static CodeGraphStore OpenTempStore(out string directory)
    {
        directory = Path.Combine(
            Path.GetTempPath(),
            "codegraph-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return CodeGraphStoreFactory.Open(Path.Combine(directory, "graph.db"));
    }

    // Best-effort recursive temp cleanup (WAL leaves -wal/-shm siblings).
    internal static void DeleteDir(string? directory)
    {
        if (string.IsNullOrEmpty(directory))
        {
            return;
        }

        try
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch (IOException)
        {
            // A still-open WAL handle can briefly hold the dir on some platforms;
            // temp cleanup is best-effort and never fails a test.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    // count(*) over an arbitrary table — the raw-SQL assertion helper the edge
    // identity suite uses ("SELECT count(*) FROM edges").
    internal static long CountRows(CodeGraphStore store, string table)
        => store.ExecuteScalarLong($"SELECT count(*) FROM {table}");
}
