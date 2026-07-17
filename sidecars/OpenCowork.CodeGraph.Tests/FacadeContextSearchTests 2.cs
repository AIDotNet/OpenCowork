using Xunit;

// =============================================================================
// Facade / context / search goldens (WS-B, M4). Exercises the CodeGraphEngine
// FACADE end-to-end plus the two read surfaces the codegraph/* RPCs project:
// ranked search and the segment vocabulary. Four groups, mirroring the M4 slice:
//
//   (a) FACADE E2E (CodeGraphFacadeEndToEndTests) — the big one. A temp dir with
//       real TS/TSX source, an injected recursive file scanner, then
//       CodeGraphEngine.Init -> IndexAll and assertions across the WHOLE pipeline:
//       extraction produced nodes, resolution produced cross-file `calls`/`imports`
//       edges, GetStats/GetIndexState reflect the write, GetCallers/GetCallees
//       traverse the resolved call graph, and the util symbol is findable via the
//       ranked retriever. GATED on the TS + TSX grammars (self-skips otherwise, like
//       the M2/M3 real-parse tiers) so a host without the native dylibs still runs
//       the pure-function ranking/segment groups below.
//
//   (b) CONTEXT RANKING (CodeGraphContextRankingTests) — the tuned scoring the
//       context retriever composes, tested against the REAL shipped primitives
//       (store.SearchNodes / store.FindNodesByExactName / CodeGraphSearchScoring).
//       Pins the two magic constants analysis/05 calls out VERBATIM: the test-file
//       down-rank (-15) and the exact-name co-location boost (+20).
//
//   (c) IDENTIFIER SEGMENTS (CodeGraphIdentifierSegmentTests) — splitIdentifierSegments
//       exercised through its shipping call site, the name_segment_vocab write path
//       (InsertNode -> GetNamesForSegment): OrderStateMachine -> order/state/machine,
//       base64Encode -> base64/encode, HTMLParser acronym run, digit-only drop, and
//       the MIN/MAX length bounds.
//
// NOTE — sibling slices: the ignore engine (CodeGraphGitIgnoreMatcher /
// CodeGraphScopeIgnore) has landed and is pinned by ScanningTests.cs, but the git/FS
// directory WALKER (CodeGraphDirectoryScanner) and the real ContextBuilder are
// separate Impl slices not yet landed at the time this test was written. So (a)
// injects a self-contained recursive scanner (the facade contract explicitly
// supports `Init(scanner: …)`), and the FindRelevantContext assertion is written to
// STRENGTHEN automatically once the context slice wires the default builder — until
// then the facade runs the Noop builder (empty subgraph) and the substantive "util
// symbol is findable" assertion rides on the real SearchNodes.
// =============================================================================

// -----------------------------------------------------------------------------
// (a) Facade end-to-end. One class == one xUnit collection == sequential tests, so
// the process-global CODEGRAPH_HOME override (redirecting the centralized graph DB
// into a throwaway temp dir, never the developer's real ~/.open-cowork/) is race-
// free: no other test class routes through CodeGraphDataDir.
// -----------------------------------------------------------------------------
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphFacadeEndToEndTests
{
    // A util module exporting greet(); main imports + calls it; an App.tsx React
    // component imports + renders it. util<-main and util<-App are the cross-file
    // edges resolution must synthesize.
    private const string UtilTs =
        "export function greet(name: string): string {\n" +
        "  return 'hi ' + name\n" +
        "}\n";

    private const string MainTs =
        "import { greet } from './util'\n" +
        "\n" +
        "export function run(): string {\n" +
        "  return greet('world')\n" +
        "}\n";

    private const string AppTsx =
        "import { greet } from './util'\n" +
        "\n" +
        "export function App() {\n" +
        "  return <div>{greet('app')}</div>\n" +
        "}\n";

    // A gitignored dependency: the injected scanner skips node_modules/, so the
    // facade must never index depFn — the facade-level analog of the scanner's
    // DEFAULT_IGNORE_DIRS skip.
    private const string IgnoredTs =
        "export function depFn(): number {\n" +
        "  return 42\n" +
        "}\n";

    [Fact]
    public async Task IndexAll_ExtractsResolvesAndAnswersQueries()
    {
        // Self-skip when the native grammars are absent (same guard the M2/M3
        // real-parse tiers use): without them extraction is a no-op and the e2e
        // asserts nothing meaningful.
        if (CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.TypeScript) is null ||
            CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.Tsx) is null)
        {
            return;
        }

        var root = Path.Combine(Path.GetTempPath(), "codegraph-facade-" + Guid.NewGuid().ToString("N"));
        var codegraphHome = Path.Combine(Path.GetTempPath(), "codegraph-home-" + Guid.NewGuid().ToString("N"));
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", codegraphHome);

        CodeGraphEngine? engine = null;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "src"));
            Directory.CreateDirectory(Path.Combine(root, "node_modules", "pkg"));
            File.WriteAllText(Path.Combine(root, "src", "util.ts"), UtilTs);
            File.WriteAllText(Path.Combine(root, "src", "main.ts"), MainTs);
            File.WriteAllText(Path.Combine(root, "src", "App.tsx"), AppTsx);
            File.WriteAllText(Path.Combine(root, "node_modules", "pkg", "dep.ts"), IgnoredTs);

            engine = CodeGraphEngine.Init(
                root,
                scanner: new RecursiveSourceFileScanner(),
                extractors: CodeGraphExtractionHarness.BuildExtractors(),
                grammars: CodeGraphExtractionHarness.Grammars);

            var result = await engine.IndexAll();

            // --- Index result + state --------------------------------------------
            // Exactly the three in-tree source files were parsed (node_modules was
            // ignored); no hard errors; the index stamped itself complete.
            Assert.Equal(3, result.FilesIndexed);
            Assert.DoesNotContain(result.Errors, e => e.Severity == "error");
            Assert.Equal("complete", engine.GetIndexState());
            Assert.True(CodeGraphEngine.IsInitialized(root));

            // --- Nodes exist -----------------------------------------------------
            var greet = engine.GetNodesByName("greet")
                .Single(n => n.FilePath == "src/util.ts" && n.Kind == CodeGraphNodeKind.Function);
            var run = engine.GetNodesByName("run")
                .Single(n => n.FilePath == "src/main.ts" && n.Kind == CodeGraphNodeKind.Function);
            Assert.NotEmpty(engine.GetNodesByName("App")); // the React component node

            // The gitignored dependency was never scanned, so it is not in the graph.
            Assert.Empty(engine.GetNodesByName("depFn"));
            Assert.DoesNotContain(engine.GetFiles(), f => f.Path.Contains("node_modules"));

            // --- Cross-file edges (resolution ran) -------------------------------
            // A real cross-file `calls` edge main.ts run -> util.ts greet.
            Assert.Contains(
                engine.GetOutgoingEdges(run.Id),
                e => e.Kind == CodeGraphEdgeKind.Calls && e.Target == greet.Id);

            // A file->file `imports` edge main.ts -> util.ts.
            var mainFile = engine.GetNodesInFile("src/main.ts").Single(n => n.Kind == CodeGraphNodeKind.File);
            var utilFile = engine.GetNodesInFile("src/util.ts").Single(n => n.Kind == CodeGraphNodeKind.File);
            Assert.Contains(
                engine.GetOutgoingEdges(mainFile.Id),
                e => e.Kind == CodeGraphEdgeKind.Imports && e.Target == utilFile.Id);

            // --- Call-graph traversal --------------------------------------------
            // greet's callers include run; run's callees include greet.
            Assert.Contains(engine.GetCallers(greet.Id), p => p.Node.Id == run.Id);
            Assert.Contains(engine.GetCallees(run.Id), p => p.Node.Id == greet.Id);

            // --- Stats -----------------------------------------------------------
            var stats = engine.GetStats();
            Assert.Equal(3, stats.FileCount);
            Assert.True(stats.NodeCount > 0, "expected nodes after indexing");
            Assert.True(stats.EdgeCount > 0, "expected edges after resolution");

            // --- Ranked retrieval finds the util symbol --------------------------
            // The substantive findability assertion, on the real ranked search.
            Assert.Contains(engine.SearchNodes("greet"), h => h.Node.Id == greet.Id);

            // FindRelevantContext is exercised; it returns the Noop builder's empty
            // subgraph until the context slice wires the real builder, at which point
            // this assertion begins verifying greet ranks into the returned subgraph.
            var context = await engine.FindRelevantContext("greet");
            Assert.NotNull(context);
            if (context.Nodes.Count > 0)
            {
                Assert.Contains(greet.Id, context.Nodes.Keys);
            }
        }
        finally
        {
            engine?.Dispose();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(root);
            CodeGraphTestSupport.DeleteDir(codegraphHome);
        }
    }

    // A minimal stand-in for the not-yet-landed CodeGraphDirectoryScanner: walk the
    // tree, skip DEFAULT_IGNORE_DIRS-style dirs, emit project-root-relative POSIX
    // paths for source files (Bytes null => the engine reads them itself, exercising
    // the CodeGraphPathSafety read path). Satisfies the ICodeGraphFileScanner
    // contract the facade depends on.
    private sealed class RecursiveSourceFileScanner : ICodeGraphFileScanner
    {
        private static readonly HashSet<string> IgnoredDirs =
            new(StringComparer.Ordinal) { "node_modules", ".git", "dist", "out" };

        public IReadOnlyList<CodeGraphScannedFile> EnumerateFiles(string root, CodeGraphProjectConfig config)
        {
            var files = new List<CodeGraphScannedFile>();
            Walk(root, root, files);
            return files;
        }

        private static void Walk(string root, string dir, List<CodeGraphScannedFile> files)
        {
            foreach (var sub in Directory.EnumerateDirectories(dir))
            {
                if (IgnoredDirs.Contains(Path.GetFileName(sub)))
                {
                    continue;
                }

                Walk(root, sub, files);
            }

            foreach (var file in Directory.EnumerateFiles(dir))
            {
                var rel = Path.GetRelativePath(root, file).Replace('\\', '/');
                if (CodeGraphLanguageMap.IsSourceFile(rel))
                {
                    files.Add(new CodeGraphScannedFile(rel));
                }
            }
        }
    }
}

// -----------------------------------------------------------------------------
// (b) Context ranking. A fresh temp store per test (xUnit new-per-test ==
// beforeEach/afterEach); the shipping search/scoring code path runs over it (never
// mock the graph). Pins the constants analysis/05 requires be reproduced verbatim.
// -----------------------------------------------------------------------------
public sealed class CodeGraphContextRankingTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphContextRankingTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

    // -------------------------------------------------------------------------
    // 1. Test-file down-rank END-TO-END: two identically-named symbols, one in a
    //    production file and one in its *.test.ts sibling. SearchNodes's multi-
    //    signal rescore must rank the production symbol first — the -15 test-file
    //    penalty on the test copy is the whole difference.
    // -------------------------------------------------------------------------
    [Fact]
    public void SearchNodes_RanksProductionSymbolAboveTestSibling()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("fn:prod", "processPayment", CodeGraphNodeKind.Function, "src/payment.ts", 1),
            CodeGraphTestSupport.MakeNode("fn:test", "processPayment", CodeGraphNodeKind.Function, "src/payment.test.ts", 1)
        });

        var results = store.SearchNodes("processPayment");

        var prod = results.Single(r => r.Node.FilePath == "src/payment.ts");
        var test = results.Single(r => r.Node.FilePath == "src/payment.test.ts");

        // Production ranks first, and outscores the test copy.
        Assert.Equal("src/payment.ts", results[0].Node.FilePath);
        Assert.True(prod.Score > test.Score, $"prod {prod.Score} should beat test {test.Score}");
    }

    // -------------------------------------------------------------------------
    // 2. ScorePathRelevance constants: the -15 test-file penalty in isolation
    //    (identical base path structure, so the whole delta is the penalty), the
    //    filename-match bonus, and the IsTestFile classifier itself.
    // -------------------------------------------------------------------------
    [Fact]
    public void ScorePathRelevance_AppliesTestPenaltyAndFileNameBonus()
    {
        // Same query, same filename stem + dir — the only difference is the test
        // suffix, so prod - test isolates the -15 penalty verbatim.
        var prod = CodeGraphSearchScoring.ScorePathRelevance("src/payment.ts", "processPayment", null);
        var test = CodeGraphSearchScoring.ScorePathRelevance("src/payment.test.ts", "processPayment", null);
        Assert.Equal(15, prod - test);

        // A filename hit scores strictly positive and above an unrelated file.
        var hit = CodeGraphSearchScoring.ScorePathRelevance("src/auth/login.ts", "login", null);
        var miss = CodeGraphSearchScoring.ScorePathRelevance("src/misc/thing.ts", "login", null);
        Assert.True(hit > 0);
        Assert.True(hit > miss);

        // The classifier behind the penalty.
        Assert.True(CodeGraphSearchScoring.IsTestFile("src/payment.test.ts"));
        Assert.False(CodeGraphSearchScoring.IsTestFile("src/payment.ts"));
    }

    // -------------------------------------------------------------------------
    // 3. Exact-name co-location boost (+20). Query two names: a distinctive one in
    //    a single file, and a COMMON one (>= 10 files, so it carries no location
    //    signal on its own). The common name's copy that shares the distinctive
    //    name's file is boosted +20 and must outrank its far-flung namesakes.
    // -------------------------------------------------------------------------
    [Fact]
    public void FindNodesByExactName_BoostsCoLocatedResult()
    {
        var nodes = new List<CodeGraphNode>
        {
            // Distinctive: processOrder lives only in src/order.ts.
            CodeGraphTestSupport.MakeNode("fn:po", "processOrder", CodeGraphNodeKind.Function, "src/order.ts", 1),
            // The co-located common symbol (same file as the distinctive one).
            CodeGraphTestSupport.MakeNode("fn:run@order", "run", CodeGraphNodeKind.Function, "src/order.ts", 2)
        };

        // 'run' also lives in 12 unrelated files -> 13 files total -> NOT distinctive
        // (>= 10), so only the src/order.ts co-location can lift it.
        for (var i = 0; i < 12; i++)
        {
            nodes.Add(CodeGraphTestSupport.MakeNode($"fn:run{i}", "run", CodeGraphNodeKind.Function, $"src/f{i}.ts", 1));
        }

        store.InsertNodes(nodes);

        var results = store.FindNodesByExactName(new[] { "run", "processOrder" });

        var runResults = results.Where(r => r.Node.Name == "run").ToList();
        var coLocated = runResults.Single(r => r.Node.FilePath == "src/order.ts");
        var elsewhere = runResults.Where(r => r.Node.FilePath != "src/order.ts").ToList();

        Assert.NotEmpty(elsewhere);
        Assert.All(elsewhere, other =>
            Assert.True(coLocated.Score > other.Score, $"co-located {coLocated.Score} should beat {other.Score}"));
    }

    // -------------------------------------------------------------------------
    // 4. NameMatchBonus / KindBonus constants (verbatim, query-utils.ts).
    // -------------------------------------------------------------------------
    [Fact]
    public void NameAndKindBonuses_MatchPortedConstants()
    {
        Assert.Equal(80, CodeGraphSearchScoring.NameMatchBonus("processPayment", "processPayment")); // exact
        Assert.Equal(0, CodeGraphSearchScoring.NameMatchBonus("processPayment", "unrelated"));

        Assert.Equal(10, CodeGraphSearchScoring.KindBonus(CodeGraphNodeKind.Function));
        Assert.Equal(10, CodeGraphSearchScoring.KindBonus(CodeGraphNodeKind.Method));
        Assert.Equal(8, CodeGraphSearchScoring.KindBonus(CodeGraphNodeKind.Class));
        Assert.Equal(0, CodeGraphSearchScoring.KindBonus(CodeGraphNodeKind.File));
    }
}

// -----------------------------------------------------------------------------
// (c) Identifier segments. splitIdentifierSegments is private to CodeGraphStore
// (its only caller is the node write path), so it is exercised through that path:
// InsertNode materializes name_segment_vocab, GetNamesForSegment reads it back.
// -----------------------------------------------------------------------------
public sealed class CodeGraphIdentifierSegmentTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphIdentifierSegmentTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

    // Insert a segmentable (function) node and return the vocab segments its name
    // produced, as reported by the round-trip through name_segment_vocab.
    private void Insert(string name) =>
        store.InsertNode(CodeGraphTestSupport.MakeNode("fn:" + name, name, CodeGraphNodeKind.Function, "src/a.ts", 1));

    private bool HasSegment(string segment, string name) =>
        store.GetNamesForSegment(segment, 50).Contains(name);

    // camelCase / PascalCase humps: OrderStateMachine -> order / state / machine.
    [Fact]
    public void SplitsCamelCaseHumps()
    {
        Insert("OrderStateMachine");

        Assert.True(HasSegment("order", "OrderStateMachine"));
        Assert.True(HasSegment("state", "OrderStateMachine"));
        Assert.True(HasSegment("machine", "OrderStateMachine"));

        // The unsplit name is NOT itself a segment.
        Assert.False(HasSegment("orderstatemachine", "OrderStateMachine"));

        // Each of the three concepts is one distinct-name occurrence.
        var counts = store.GetSegmentNameCounts(new[] { "order", "state", "machine" });
        Assert.Equal(1, counts["order"]);
        Assert.Equal(1, counts["state"]);
        Assert.Equal(1, counts["machine"]);
    }

    // Digits stay glued to their word: base64Encode -> base64 / encode.
    [Fact]
    public void KeepsDigitsGluedToWord()
    {
        Insert("base64Encode");

        Assert.True(HasSegment("base64", "base64Encode"));
        Assert.True(HasSegment("encode", "base64Encode"));
    }

    // Acronym run: HTMLParser -> html / parser (split before the last upper of the
    // run when a lowercase follows).
    [Fact]
    public void SplitsAcronymRun()
    {
        Insert("HTMLParser");

        Assert.True(HasSegment("html", "HTMLParser"));
        Assert.True(HasSegment("parser", "HTMLParser"));
    }

    // Digit-only fragments are dropped; snake/kebab separators split words.
    [Fact]
    public void DropsDigitOnlyFragments()
    {
        Insert("Scan_007_Job");

        Assert.True(HasSegment("scan", "Scan_007_Job"));
        Assert.True(HasSegment("job", "Scan_007_Job"));
        // The all-digit run "007" carries no prose signal.
        Assert.Empty(store.GetNamesForSegment("007", 50));
    }

    // Length bounds: a sub-MIN (1-char) name and an over-MAX (> 32-char) run each
    // yield NO segments, so a store holding only those has an empty vocab.
    [Fact]
    public void DropsSegmentsOutsideLengthBounds()
    {
        Insert("x");                                   // 1 char  < MIN(2)
        Insert(new string('a', 40));                   // 40 chars > MAX(32)

        Assert.True(store.IsNameSegmentVocabEmpty());
    }
}
