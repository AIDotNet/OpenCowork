using Xunit;

// =============================================================================
// M7-W2 parallel reference resolution. The fan-out computes per-ref candidates on
// worker resolvers (own read-only connections) and applies results in batch order
// on the writer thread — the graph must come out IDENTICAL to the sequential
// path. Seeds the same topology into two centralized project DBs and resolves one
// sequentially (CODEGRAPH_NO_PARALLEL_RESOLVE=1), one parallel
// (CODEGRAPH_PARALLEL_RESOLVE_MIN=1), then compares edges + surviving rows.
// In the CodeGraphHomeEnv collection: env vars are process-global.
// =============================================================================
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphParallelResolutionTests
{
    private static CodeGraphUnresolvedReference Ref(string fromNodeId, string name, string kind, string filePath, int line)
        => new(
            FromNodeId: fromNodeId,
            ReferenceName: name,
            ReferenceKind: kind,
            Line: line,
            Column: 0,
            FilePath: filePath,
            Language: CodeGraphLanguage.TypeScript,
            Candidates: null,
            RowId: null);

    // A topology with resolvable calls/imports, an unresolvable miss, and enough
    // rows to span several size-3 batches.
    private static void Seed(CodeGraphStore store)
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:a", "a.ts", CodeGraphNodeKind.File, "a.ts", 1),
            CodeGraphTestSupport.MakeNode("func:caller", "caller", CodeGraphNodeKind.Function, "a.ts", 2),
            CodeGraphTestSupport.MakeNode("file:b", "b.ts", CodeGraphNodeKind.File, "b.ts", 1),
            CodeGraphTestSupport.MakeNode("func:helper", "helper", CodeGraphNodeKind.Function, "b.ts", 2, isExported: true),
            CodeGraphTestSupport.MakeNode("func:format", "format", CodeGraphNodeKind.Function, "b.ts", 9, isExported: true),
            CodeGraphTestSupport.MakeNode("class:Widget", "Widget", CodeGraphNodeKind.Class, "b.ts", 20, isExported: true)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("func:caller", "helper", CodeGraphEdgeKind.Calls, "a.ts", 3),
            Ref("func:caller", "format", CodeGraphEdgeKind.Calls, "a.ts", 4),
            Ref("func:caller", "Widget", CodeGraphEdgeKind.Instantiates, "a.ts", 5),
            Ref("file:a", "b.ts", CodeGraphEdgeKind.Imports, "a.ts", 1),
            Ref("func:caller", "util.missingFn", CodeGraphEdgeKind.Calls, "a.ts", 6),
            Ref("func:caller", "helper", CodeGraphEdgeKind.Calls, "a.ts", 7),
            Ref("func:caller", "format", CodeGraphEdgeKind.Calls, "a.ts", 8)
        });
    }

    private static List<string> EdgeFingerprint(CodeGraphStore store, string sourceId)
    {
        var all = new List<string>();
        foreach (var kind in new[] { CodeGraphEdgeKind.Calls, CodeGraphEdgeKind.Imports, CodeGraphEdgeKind.Instantiates })
        {
            foreach (var e in store.GetOutgoingEdges(sourceId, new[] { kind }))
            {
                all.Add($"{e.Kind}:{e.Target}:{e.Line}");
            }
        }

        all.Sort(StringComparer.Ordinal);
        return all;
    }

    [Fact]
    public void ParallelResolution_ProducesIdenticalGraphToSequential()
    {
        var home = Path.Combine(Path.GetTempPath(), "codegraph-par-home-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(home);
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        var roots = new List<string>();

        try
        {
            var fingerprints = new List<List<string>>();
            var counts = new List<(int Total, int Resolved, int Unresolved)>();

            foreach (var mode in new[] { "sequential", "parallel" })
            {
                var root = Path.Combine(Path.GetTempPath(), "codegraph-par-root-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(root);
                roots.Add(root);

                Environment.SetEnvironmentVariable("CODEGRAPH_NO_PARALLEL_RESOLVE", mode == "sequential" ? "1" : null);
                Environment.SetEnvironmentVariable("CODEGRAPH_PARALLEL_RESOLVE_MIN", mode == "parallel" ? "1" : null);

                using var store = CodeGraphStoreFactory.Open(CodeGraphDataDir.GraphDbPath(Path.GetFullPath(root)));
                Seed(store);

                var resolver = CodeGraphReferenceResolver.Create(store, Path.GetFullPath(root));
                var result = resolver.ResolveAndPersistBatched(CancellationToken.None, batchSize: 3);

                // Guard against a silent fallback: the parallel leg must actually fan out.
                if (mode == "parallel")
                {
                    Assert.True(resolver.LastRunParallelWorkers >= 2);
                }
                else
                {
                    Assert.Equal(0, resolver.LastRunParallelWorkers);
                }

                counts.Add((result.Total, result.Resolved, result.Unresolved));
                var fp = EdgeFingerprint(store, "func:caller");
                fp.AddRange(EdgeFingerprint(store, "file:a"));
                fp.Add("pending:" + store.GetUnresolvedReferencesCount());
                fp.Add("rows:" + CodeGraphTestSupport.CountRows(store, "unresolved_refs"));
                fingerprints.Add(fp);
            }

            Assert.Equal(counts[0], counts[1]);
            Assert.Equal(fingerprints[0], fingerprints[1]);

            // Sanity: the run actually resolved things (6 of 7 rows; the miss parked).
            Assert.Equal(6, counts[0].Resolved);
            Assert.Equal(1, counts[0].Unresolved);
        }
        finally
        {
            Environment.SetEnvironmentVariable("CODEGRAPH_NO_PARALLEL_RESOLVE", null);
            Environment.SetEnvironmentVariable("CODEGRAPH_PARALLEL_RESOLVE_MIN", null);
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(home);
            foreach (var root in roots)
            {
                CodeGraphTestSupport.DeleteDir(root);
            }
        }
    }
}
