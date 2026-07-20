using System.Text;
using Xunit;

// =============================================================================
// Resolution goldens (WS-B, M3a). Verifies the cross-file reference resolver
// (CodeGraphReferenceResolver + CodeGraphNameMatcher + CodeGraphImportResolver)
// turns unresolved_refs into real cross-file edges and drives the status
// lifecycle exactly as analysis/02 §2.1-2.5 specifies:
//
//   INSERT 'pending' (extraction)
//      ├── resolved      -> DELETE row (edge created)
//      └── attempted/miss -> UPDATE status='failed', name_tail=<last segment>
//
// Two tiers:
//   (a) SEEDED — insert nodes across 2 files + unresolved_refs directly into a
//       real temp store, run ResolveAndPersistBatched, and assert the emitted
//       edges (GetOutgoingEdges), the row cleanup (delete/fail + name_tail), the
//       rowId-precise cleanup (#1269), same-name disambiguation (preferCallSiteFile),
//       and batch-loop termination. No grammar needed — always run.
//   (b) END-TO-END — parse two real TS sources with tree-sitter via CodeGraphIndexer
//       (nodes + unresolved_refs into the store), then resolve, and assert a real
//       cross-file `calls` edge main.ts -> util.ts. GATED on grammar availability
//       (the dylibs are copied beside the test bin by the .csproj); if the TS grammar
//       can't load, ONLY the e2e self-skips — the seeded tier still pins the resolver.
// =============================================================================

// -----------------------------------------------------------------------------
// (a) Seeded resolution tests. Each test gets a fresh EMPTY temp store (xUnit
// new-per-test == Vitest beforeEach/afterEach) and seeds its own tiny 2-file
// topology; the resolver runs over the real store + query code path (WS-B: never
// mock the graph). projectRoot = the temp dir; with no source files on disk,
// import-path resolution is a no-op and name-matching drives the seeded cases.
// -----------------------------------------------------------------------------
public sealed class CodeGraphResolutionSeededTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphResolutionSeededTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

    // A pending unresolved_ref as extraction would seed it: RowId null (the DB
    // assigns it on insert; the resolver re-reads it for rowId-precise cleanup),
    // status defaults 'pending'.
    private static CodeGraphUnresolvedReference Ref(
        string fromNodeId,
        string name,
        string kind,
        string filePath = "a.ts",
        int line = 1,
        string language = CodeGraphLanguage.TypeScript)
        => new(
            FromNodeId: fromNodeId,
            ReferenceName: name,
            ReferenceKind: kind,
            Line: line,
            Column: 0,
            FilePath: filePath,
            Language: language,
            Candidates: null,
            RowId: null);

    private CodeGraphResolutionResult Resolve(int batchSize = 5000)
        => CodeGraphReferenceResolver.Create(store, directory)
            .ResolveAndPersistBatched(CancellationToken.None, batchSize);

    // -------------------------------------------------------------------------
    // 1. Cross-file calls + imports edges; resolved rows deleted; miss -> failed.
    // -------------------------------------------------------------------------
    [Fact]
    public void ResolvesCrossFileCallsAndImports_DeletesResolvedRows_FailsMissWithNameTail()
    {
        // file A (a.ts): a caller function; file B (b.ts): the callee + file node.
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:a", "a.ts", CodeGraphNodeKind.File, "a.ts", 1),
            CodeGraphTestSupport.MakeNode("func:caller", "caller", CodeGraphNodeKind.Function, "a.ts", 2),
            CodeGraphTestSupport.MakeNode("file:b", "b.ts", CodeGraphNodeKind.File, "b.ts", 1),
            CodeGraphTestSupport.MakeNode("func:helper", "helper", CodeGraphNodeKind.Function, "b.ts", 2, isExported: true)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            // caller() calls helper() in b.ts  -> exact-name match -> `calls` edge.
            Ref("func:caller", "helper", CodeGraphEdgeKind.Calls, line: 4),
            // a.ts imports the b.ts module     -> matchByFilePath -> file->file `imports` edge.
            Ref("file:a", "b.ts", CodeGraphEdgeKind.Imports, line: 1),
            // an unbindable call               -> no match -> parked 'failed' with name_tail.
            Ref("func:caller", "util.missingFn", CodeGraphEdgeKind.Calls, line: 5)
        });

        var result = Resolve();

        // Cross-file `calls` edge caller -> helper.
        var callEdges = store.GetOutgoingEdges("func:caller", new[] { CodeGraphEdgeKind.Calls });
        Assert.Contains(callEdges, e => e.Target == "func:helper");

        // Cross-file `imports` edge a.ts -> b.ts.
        var importEdges = store.GetOutgoingEdges("file:a", new[] { CodeGraphEdgeKind.Imports });
        Assert.Contains(importEdges, e => e.Target == "file:b");

        // The two resolved rows are DELETED; only the failed row survives.
        Assert.Equal(0, store.GetUnresolvedReferencesCount()); // no pending left
        Assert.Equal(1, CodeGraphTestSupport.CountRows(store, "unresolved_refs"));

        // The miss is parked 'failed' with name_tail = last dotted segment (#1240).
        var failed = store.GetRetryableFailedReferences(new[] { "missingFn" });
        Assert.Single(failed);
        Assert.Equal("util.missingFn", failed[0].ReferenceName);
        Assert.Equal("failed", failed[0].Status);
        Assert.Equal("missingFn", failed[0].NameTail);

        Assert.Equal(3, result.Total);
        Assert.Equal(2, result.Resolved);
        Assert.Equal(1, result.Unresolved);
    }

    // -------------------------------------------------------------------------
    // 2. rowId-precise cleanup (#1269): two refs from the SAME caller with the
    //    SAME name at DIFFERENT lines. Resolving one must not clobber the other's
    //    row — each is deleted by exact id, so both edges get built. Driven with
    //    batchSize=1 so the first row is cleaned BEFORE the second is read; a
    //    key-tuple delete would drop the sibling and only one edge would survive.
    // -------------------------------------------------------------------------
    [Fact]
    public void RowIdPreciseCleanup_KeepsSiblingRefAtDifferentLine_1269()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("func:caller", "caller", CodeGraphNodeKind.Function, "a.ts", 1),
            CodeGraphTestSupport.MakeNode("func:helper", "helper", CodeGraphNodeKind.Function, "b.ts", 1, isExported: true)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("func:caller", "helper", CodeGraphEdgeKind.Calls, line: 3),
            Ref("func:caller", "helper", CodeGraphEdgeKind.Calls, line: 7)
        });

        Resolve(batchSize: 1);

        // BOTH call sites produced an edge (distinct by line) — the sibling was not
        // clobbered when the first row was cleaned up.
        var edges = store.GetOutgoingEdges("func:caller", new[] { CodeGraphEdgeKind.Calls })
            .Where(e => e.Target == "func:helper")
            .ToList();
        Assert.Equal(2, edges.Count);
        Assert.Contains(edges, e => e.Line == 3);
        Assert.Contains(edges, e => e.Line == 7);

        // Both rows cleaned by exact id — none left pending, none orphaned.
        Assert.Equal(0, store.GetUnresolvedReferencesCount());
        Assert.Equal(0, CodeGraphTestSupport.CountRows(store, "unresolved_refs"));
    }

    // -------------------------------------------------------------------------
    // 3. Same-name disambiguation: two functions named `run` in different files;
    //    a call in file A's OWN file binds to A's `run` (preferCallSiteFile /
    //    findBestMatch same-file +100), never B's.
    // -------------------------------------------------------------------------
    [Fact]
    public void SameNameDisambiguation_PrefersCallSiteFile()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("func:runA", "run", CodeGraphNodeKind.Function, "a.ts", 2),
            CodeGraphTestSupport.MakeNode("func:callerA", "caller", CodeGraphNodeKind.Function, "a.ts", 6),
            CodeGraphTestSupport.MakeNode("func:runB", "run", CodeGraphNodeKind.Function, "b.ts", 2)
        });

        // The call site lives in a.ts.
        store.InsertUnresolvedRef(Ref("func:callerA", "run", CodeGraphEdgeKind.Calls, filePath: "a.ts", line: 7));

        Resolve();

        var callEdges = store.GetOutgoingEdges("func:callerA", new[] { CodeGraphEdgeKind.Calls });
        Assert.Single(callEdges);
        Assert.Equal("func:runA", callEdges[0].Target); // A's own run
        Assert.NotEqual("func:runB", callEdges[0].Target);
    }

    // -------------------------------------------------------------------------
    // 4. Non-progress guard: the batch loop must TERMINATE and fully drain the
    //    pending set (resolved rows deleted, misses parked 'failed') across several
    //    small batches — the pending population strictly shrinks each pass, so the
    //    `remaining >= prevRemaining -> break` guard never runs away. A second run
    //    over an all-failed set reads an empty first batch and returns immediately.
    // -------------------------------------------------------------------------
    [Fact]
    public void BatchLoopTerminates_DrainsPendingAcrossBatches()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("func:caller", "caller", CodeGraphNodeKind.Function, "a.ts", 1),
            CodeGraphTestSupport.MakeNode("func:t1", "target1", CodeGraphNodeKind.Function, "b.ts", 1, isExported: true),
            CodeGraphTestSupport.MakeNode("func:t2", "target2", CodeGraphNodeKind.Function, "b.ts", 2, isExported: true),
            CodeGraphTestSupport.MakeNode("func:t3", "target3", CodeGraphNodeKind.Function, "b.ts", 3, isExported: true)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("func:caller", "target1", CodeGraphEdgeKind.Calls, line: 1),
            Ref("func:caller", "target2", CodeGraphEdgeKind.Calls, line: 2),
            Ref("func:caller", "target3", CodeGraphEdgeKind.Calls, line: 3),
            Ref("func:caller", "noSuchThing1", CodeGraphEdgeKind.Calls, line: 4),
            Ref("func:caller", "noSuchThing2", CodeGraphEdgeKind.Calls, line: 5),
            Ref("func:caller", "noSuchThing3", CodeGraphEdgeKind.Calls, line: 6)
        });

        // Small batch => multiple iterations (6 refs / batch 2 => 3 work passes + a
        // final empty read that breaks). Returning at all proves termination.
        var result = Resolve(batchSize: 2);

        Assert.Equal(6, result.Total);
        Assert.Equal(3, result.Resolved);
        Assert.Equal(3, result.Unresolved);

        // Fully drained: 3 resolved rows deleted, 3 parked 'failed' (retryable, not
        // pending). No pending row can re-enter the batch reader, so no infinite loop.
        Assert.Equal(0, store.GetUnresolvedReferencesCount());
        Assert.Equal(3, CodeGraphTestSupport.CountRows(store, "unresolved_refs"));

        var calls = store.GetOutgoingEdges("func:caller", new[] { CodeGraphEdgeKind.Calls });
        Assert.Equal(3, calls.Count);

        // Re-running over an all-'failed' pending set is an immediate, terminating no-op.
        var second = Resolve(batchSize: 2);
        Assert.Equal(0, second.Total);
    }

    // -------------------------------------------------------------------------
    // 5. C/C++ #include -> file→file `imports` edge (import-resolver.ts:1218). A
    //    quoted include resolves against the INCLUDING file's own directory first,
    //    so `#include "foo.h"` in src/main.c binds to src/foo.h — a file-to-file
    //    edge, never a name-matched symbol. COBOL COPY / PHP include/require mirror
    //    the same file-edge branch (and never fall back to the name-matcher).
    // -------------------------------------------------------------------------
    [Fact]
    public void ResolvesCInclude_ToFileEdge_QuotedRelativeToIncludingDir()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:main.c", "main.c", CodeGraphNodeKind.File, "src/main.c", 1, language: CodeGraphLanguage.C),
            CodeGraphTestSupport.MakeNode("file:foo.h", "foo.h", CodeGraphNodeKind.File, "src/foo.h", 1, language: CodeGraphLanguage.C)
        });

        // The extractor emits an #include as an `imports` ref FROM the file node,
        // carrying the raw include path as the reference name.
        store.InsertUnresolvedRef(
            Ref("file:main.c", "foo.h", CodeGraphEdgeKind.Imports, filePath: "src/main.c", language: CodeGraphLanguage.C));

        var result = Resolve();

        // A file→file `imports` edge src/main.c -> src/foo.h now exists.
        var importEdges = store.GetOutgoingEdges("file:main.c", new[] { CodeGraphEdgeKind.Imports });
        Assert.Contains(importEdges, e => e.Target == "file:foo.h");

        Assert.Equal(1, result.Resolved);
        Assert.Equal(0, store.GetUnresolvedReferencesCount());
    }

    // -------------------------------------------------------------------------
    // 6. Deferred pass 2 — chained call resolved via conformance (#750). A Kotlin
    //    `Foo().bar()` whose `bar` is declared on Foo's SUPERTYPE can't bind in the
    //    first pass (the extends edge isn't built yet), so it defers; once the main
    //    pass builds Foo -> Base, resolveChainedCallsViaConformance walks
    //    getSupertypes(Foo) -> Base and resolves bar on Base.
    // -------------------------------------------------------------------------
    [Fact]
    public void ChainedCall_ResolvedViaConformance_AfterSupertypeEdgeExists_750()
    {
        store.InsertNodes(new[]
        {
            // Subclass Foo + the caller (a.kt); Base + its bar() method (b.kt).
            CodeGraphTestSupport.MakeNode("class:Foo", "Foo", CodeGraphNodeKind.Class, "a.kt", 1, language: CodeGraphLanguage.Kotlin),
            CodeGraphTestSupport.MakeNode("func:caller", "caller", CodeGraphNodeKind.Function, "a.kt", 5, language: CodeGraphLanguage.Kotlin),
            CodeGraphTestSupport.MakeNode("class:Base", "Base", CodeGraphNodeKind.Class, "b.kt", 1, language: CodeGraphLanguage.Kotlin, isExported: true),
            CodeGraphTestSupport.MakeNode("method:bar", "bar", CodeGraphNodeKind.Method, "b.kt", 2, language: CodeGraphLanguage.Kotlin, isExported: true, qualifiedName: "Base::bar")
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            // Foo extends Base -> the main pass builds the extends edge.
            Ref("class:Foo", "Base", CodeGraphEdgeKind.Extends, filePath: "a.kt", line: 1, language: CodeGraphLanguage.Kotlin),
            // caller() does Foo().bar() -> chain-shaped; bar is on Base, not Foo, so
            // the first pass DEFERS it (no supertype edge exists yet in that pass).
            Ref("func:caller", "Foo().bar", CodeGraphEdgeKind.Calls, filePath: "a.kt", line: 6, language: CodeGraphLanguage.Kotlin)
        });

        var result = Resolve();

        // The main pass built Foo -> Base ...
        var extendsEdges = store.GetOutgoingEdges("class:Foo", new[] { CodeGraphEdgeKind.Extends });
        Assert.Contains(extendsEdges, e => e.Target == "class:Base");

        // ... and the deferred conformance pass then bound caller -> Base::bar.
        var callEdges = store.GetOutgoingEdges("func:caller", new[] { CodeGraphEdgeKind.Calls });
        Assert.Contains(callEdges, e => e.Target == "method:bar");

        // The edge came from deferred pass 2 specifically, not the main loop.
        Assert.True(result.ByMethod.TryGetValue("conformance-pass", out var conformanceCount) && conformanceCount == 1);
    }
}

// -----------------------------------------------------------------------------
// (b) End-to-end: real tree-sitter parse of two TS files -> nodes + unresolved
// refs into the store -> resolve -> cross-file edge. Self-skips (only this class)
// when the TS grammar is unavailable on the host (see the .csproj dylib copy).
// -----------------------------------------------------------------------------
public sealed class CodeGraphResolutionEndToEndTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphResolutionEndToEndTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

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

    [Fact]
    public void ResolvesCrossFileCallAndImportEdges_FromRealTreeSitterParse()
    {
        // Guard: skip ONLY the e2e when the TS grammar can't load; the seeded tests
        // still pin the resolver.
        if (CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.TypeScript) is null)
        {
            return;
        }

        var extractors = CodeGraphExtractionHarness.BuildExtractors();
        var grammars = CodeGraphExtractionHarness.Grammars;

        // Real sources in the project root so import-path resolution can read them.
        Directory.CreateDirectory(Path.Combine(directory, "src"));
        File.WriteAllText(Path.Combine(directory, "src", "util.ts"), UtilTs);
        File.WriteAllText(Path.Combine(directory, "src", "main.ts"), MainTs);

        // Index BOTH files via the real extractor: nodes + `contains` edges +
        // unresolved_refs (the greet call + the ./util import) land in the store.
        CodeGraphIndexer.IndexFile(store, "src/util.ts", Encoding.UTF8.GetBytes(UtilTs), extractors, grammars);
        CodeGraphIndexer.IndexFile(store, "src/main.ts", Encoding.UTF8.GetBytes(MainTs), extractors, grammars);

        // Extraction emitted at least the greet() call as a pending ref to resolve.
        Assert.True(store.GetUnresolvedReferencesCount() > 0);

        var result = CodeGraphReferenceResolver.Create(store, directory)
            .ResolveAndPersistBatched(CancellationToken.None);

        // The exported greet in util.ts and the run function in main.ts.
        var greet = store.GetNodesByName("greet")
            .Single(n => n.FilePath == "src/util.ts" && n.Kind == CodeGraphNodeKind.Function);
        var run = store.GetNodesByName("run")
            .Single(n => n.FilePath == "src/main.ts" && n.Kind == CodeGraphNodeKind.Function);

        // A real cross-file `calls` edge main.ts run -> util.ts greet now exists.
        var callEdges = store.GetOutgoingEdges(run.Id, new[] { CodeGraphEdgeKind.Calls });
        Assert.Contains(callEdges, e => e.Target == greet.Id);

        // The module-source ref (`./util`) resolves to the imported FILE, not back
        // to the import node in main.ts.
        var mainFile = store.GetNodesByFile("src/main.ts").Single(n => n.Kind == CodeGraphNodeKind.File);
        var utilFile = store.GetNodesByFile("src/util.ts").Single(n => n.Kind == CodeGraphNodeKind.File);
        var importEdges = store.GetOutgoingEdges(mainFile.Id, new[] { CodeGraphEdgeKind.Imports });
        Assert.Contains(importEdges, e => e.Target == utilFile.Id);

        Assert.True(result.Resolved > 0);
    }
}
