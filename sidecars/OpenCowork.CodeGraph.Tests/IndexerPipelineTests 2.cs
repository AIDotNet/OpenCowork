using System.Text;
using Xunit;

// =============================================================================
// Indexer pipeline tests — the three R5/#899 indexer upgrades:
//
//   (a) PARALLEL PARSE — IndexFilesAsync's ordered parallel-parse pipeline (up to
//       ParseParallelism pure parses on dedicated LongRunning threads, single
//       sequential writer flow) must produce the IDENTICAL graph a sequential
//       per-file IndexFile loop produces: same node ids, same edges, same
//       unresolved-ref counts, same file records.
//
//   (b) #899 EDGE PRESERVATION — a cross-file caller→callee `calls` edge (built by
//       the resolver) must SURVIVE re-indexing the callee file after a pure line
//       shift: node ids embed the start line, so the callee's id changes and the
//       delete-cascade reaps the old edge; the snapshot + (kind, name) re-bind in
//       StoreResult re-inserts it against the new id.
//
//   (c) PARSE TIMEOUT — the per-parse budget formula (base 10s + 10s per full
//       100KB, in micros: parse-pool.ts:330) is pinned as a pure function, and a
//       normal file still parses cleanly with the timeout armed.
//
// Real-parse tests self-guard on TS-grammar availability like every other suite
// (see ExtractionTests.cs — the .csproj copies the osx-arm64 dylibs beside the
// bin); the formula test always runs.
// =============================================================================
public sealed class CodeGraphIndexerPipelineTests
{
    // ------------------------------------------------------------------
    // (c) timeout budget formula — pure, always runs.
    // ------------------------------------------------------------------
    [Theory]
    [InlineData(0, 10_000_000UL)]           // empty file → base 10s
    [InlineData(99_999, 10_000_000UL)]      // just under 100KB → still base
    [InlineData(100_000, 20_000_000UL)]     // first full 100KB step → +10s
    [InlineData(250_000, 30_000_000UL)]     // two full steps → 30s
    [InlineData(1_000_000, 110_000_000UL)]  // MaxFileSize-ish → 110s
    public void ParseTimeoutBudget_ScalesWithSourceSize(int bytes, ulong expectedMicros) =>
        Assert.Equal(expectedMicros, CodeGraphExtractor.ComputeParseTimeoutMicros(bytes));

    // ------------------------------------------------------------------
    // (c) a normal file still parses with the timeout armed.
    // ------------------------------------------------------------------
    [Fact]
    public void NormalFile_StillParses_WithTimeoutArmed()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript))
        {
            return;
        }

        var result = CodeGraphExtractionHarness.Extract(
            CodeGraphLanguage.TypeScript,
            "src/ok.ts",
            "export function one(): number {\n  return 1\n}\n");

        Assert.Empty(result.Errors);
        Assert.True(CodeGraphExtractionHarness.HasNode(result, CodeGraphNodeKind.Function, "one"));
    }

    // ------------------------------------------------------------------
    // (c) the guard really cancels: an already-expired budget makes the parse
    //     return no tree (CodeGraphParseException) instead of completing.
    // ------------------------------------------------------------------
    [Fact]
    public void ExpiredTimeoutBudget_CancelsTheParse()
    {
        var grammar = CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.TypeScript);
        if (grammar is not { } handle)
        {
            return;
        }

        // Big enough that tree-sitter hits its periodic progress check mid-parse.
        var source = new StringBuilder(220_000);
        for (var i = 0; source.Length < 200_000; i++)
        {
            source.Append($"export function fn{i}(a: number, b: number): number {{ return a + b + {i} }}\n");
        }

        using var parser = new CodeGraphTsParser();
        parser.SetLanguage(handle);
        parser.SetTimeoutMicros(1); // deadline is in the past by the first check
        Assert.Throws<CodeGraphParseException>(
            () => parser.Parse(Encoding.UTF8.GetBytes(source.ToString())));

        // The parser recovers (Reset ran) and the same source parses with a sane budget.
        parser.SetTimeoutMicros(CodeGraphExtractor.ComputeParseTimeoutMicros(source.Length));
        using var tree = parser.Parse(Encoding.UTF8.GetBytes(source.ToString()));
    }

    // ------------------------------------------------------------------
    // (a) parallel IndexFilesAsync ≡ sequential IndexFile, node/edge-set identical.
    // ------------------------------------------------------------------
    [Fact]
    public async Task ParallelIndexFilesAsync_ProducesIdenticalGraph_ToSequentialIndexFile()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript))
        {
            return;
        }

        var extractors = CodeGraphExtractionHarness.BuildExtractors();
        var grammars = CodeGraphExtractionHarness.Grammars;

        // ~20 small TS files, each with a function, a class+method, an import and a
        // cross-file call ref — enough shape that any ordering / thread-affinity bug
        // in the pipeline would skew ids, edges, or ref counts.
        var files = new List<(string Path, byte[] Utf8)>();
        for (var i = 0; i < 20; i++)
        {
            var next = (i + 1) % 20;
            var source =
                $"import {{ helper{next} }} from './f{next}'\n" +
                "\n" +
                $"export function helper{i}(x: number): number {{\n" +
                $"  return helper{next}(x) + {i}\n" +
                "}\n" +
                "\n" +
                $"export class Box{i} {{\n" +
                $"  value(): number {{ return {i} }}\n" +
                "}\n";
            files.Add(($"src/f{i}.ts", Encoding.UTF8.GetBytes(source)));
        }

        var seqStore = CodeGraphTestSupport.OpenTempStore(out var seqDir);
        var parStore = CodeGraphTestSupport.OpenTempStore(out var parDir);
        try
        {
            foreach (var (path, utf8) in files)
            {
                CodeGraphIndexer.IndexFile(seqStore, path, utf8, extractors, grammars);
            }

            var result = await CodeGraphIndexer.IndexFilesAsync(
                parStore, files, extractors, grammars, backpressure: null);

            Assert.Equal(20, result.FilesIndexed);
            Assert.Empty(result.Errors);

            // Whole-table counts first (cheap disagreement signal)...
            Assert.Equal(
                CodeGraphTestSupport.CountRows(seqStore, "nodes"),
                CodeGraphTestSupport.CountRows(parStore, "nodes"));
            Assert.Equal(
                CodeGraphTestSupport.CountRows(seqStore, "edges"),
                CodeGraphTestSupport.CountRows(parStore, "edges"));
            Assert.Equal(
                CodeGraphTestSupport.CountRows(seqStore, "unresolved_refs"),
                CodeGraphTestSupport.CountRows(parStore, "unresolved_refs"));

            // ...then the exact per-file node-id sets and per-node outgoing edge sets
            // (ids are content-derived, so equality means the graphs are identical).
            foreach (var (path, _) in files)
            {
                var seqNodes = seqStore.GetNodesByFile(path).OrderBy(n => n.Id, StringComparer.Ordinal).ToList();
                var parNodes = parStore.GetNodesByFile(path).OrderBy(n => n.Id, StringComparer.Ordinal).ToList();
                Assert.True(seqNodes.Count > 0, $"no nodes extracted for {path}");
                Assert.Equal(seqNodes.Select(n => n.Id), parNodes.Select(n => n.Id));

                foreach (var node in seqNodes)
                {
                    Assert.Equal(
                        seqStore.GetOutgoingEdges(node.Id).Select(EdgeKey).OrderBy(k => k, StringComparer.Ordinal),
                        parStore.GetOutgoingEdges(node.Id).Select(EdgeKey).OrderBy(k => k, StringComparer.Ordinal));
                }
            }
        }
        finally
        {
            seqStore.Dispose();
            parStore.Dispose();
            CodeGraphTestSupport.DeleteDir(seqDir);
            CodeGraphTestSupport.DeleteDir(parDir);
        }
    }

    private static string EdgeKey(CodeGraphEdge e) =>
        $"{e.Source}|{e.Target}|{e.Kind}|{e.Line?.ToString() ?? "-"}|{e.Column?.ToString() ?? "-"}";

    // ------------------------------------------------------------------
    // (b) #899: cross-file incoming edge survives re-index of the target file.
    // ------------------------------------------------------------------
    [Fact]
    public void CrossFileCallEdge_SurvivesTargetReindex_AfterLineShift()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript))
        {
            return;
        }

        const string utilTs =
            "export function greet(name: string): string {\n" +
            "  return 'hi ' + name\n" +
            "}\n";
        const string mainTs =
            "import { greet } from './util'\n" +
            "\n" +
            "export function run(): string {\n" +
            "  return greet('world')\n" +
            "}\n";

        var extractors = CodeGraphExtractionHarness.BuildExtractors();
        var grammars = CodeGraphExtractionHarness.Grammars;
        var store = CodeGraphTestSupport.OpenTempStore(out var directory);
        try
        {
            // Real sources on disk so the resolver's import-path resolution works
            // (same setup as CodeGraphResolutionEndToEndTests).
            File.WriteAllText(Path.Combine(directory, "util.ts"), utilTs);
            File.WriteAllText(Path.Combine(directory, "main.ts"), mainTs);

            CodeGraphIndexer.IndexFile(store, "util.ts", Encoding.UTF8.GetBytes(utilTs), extractors, grammars);
            CodeGraphIndexer.IndexFile(store, "main.ts", Encoding.UTF8.GetBytes(mainTs), extractors, grammars);
            CodeGraphReferenceResolver.Create(store, directory).ResolveAndPersistBatched(CancellationToken.None);

            var oldGreet = store.GetNodesByName("greet")
                .Single(n => n.FilePath == "util.ts" && n.Kind == CodeGraphNodeKind.Function);
            var run = store.GetNodesByName("run")
                .Single(n => n.FilePath == "main.ts" && n.Kind == CodeGraphNodeKind.Function);

            // Precondition: the resolver built the cross-file calls edge run → greet.
            Assert.Contains(
                store.GetOutgoingEdges(run.Id, new[] { CodeGraphEdgeKind.Calls }),
                e => e.Target == oldGreet.Id);

            // Re-index util.ts with greet shifted 3 lines down (comment-only edit
            // above the symbol). Node ids embed the start line, so greet gets a NEW
            // id and the delete-cascade reaps the old edge — before #899 this
            // silently severed the caller's edge.
            var shifted = "// shifted\n// three\n// lines\n" + utilTs;
            File.WriteAllText(Path.Combine(directory, "util.ts"), shifted);
            CodeGraphIndexer.IndexFile(store, "util.ts", Encoding.UTF8.GetBytes(shifted), extractors, grammars);

            var newGreet = store.GetNodesByName("greet")
                .Single(n => n.FilePath == "util.ts" && n.Kind == CodeGraphNodeKind.Function);
            Assert.NotEqual(oldGreet.Id, newGreet.Id); // the id really shifted

            // The snapshotted incoming edge was re-bound by (kind, name) to the new
            // id — run → greet survives the re-index without a resolver rerun.
            var callEdges = store.GetOutgoingEdges(run.Id, new[] { CodeGraphEdgeKind.Calls });
            Assert.Contains(callEdges, e => e.Target == newGreet.Id);
            Assert.DoesNotContain(callEdges, e => e.Target == oldGreet.Id);
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(directory);
        }
    }
}
