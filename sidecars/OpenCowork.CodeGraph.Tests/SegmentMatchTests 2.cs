using Xunit;

// =============================================================================
// Front-load prompt-hook CONSUMER goldens (WS-B): the graph-derived segment
// matcher (CodeGraphSegmentMatcher ≙ index.ts getSegmentMatches) and the
// structural-prompt heuristics (CodeGraphStructuralPrompt ≙ directory.ts). The
// producer side (name_segment_vocab write path + identifier segmentation) is
// pinned by FacadeContextSearchTests (c); here we exercise the query side over a
// real seeded store — never a mock.
// =============================================================================

// The EngineFacade test opens a real engine, which mutates the process-global
// CODEGRAPH_HOME to redirect the centralized graph DB into a throwaway temp dir.
// FacadeContextSearchTests / ToolSurfaceTests do the same, so this collection is
// marked DisableParallelization to serialize it against every other collection —
// no other class can observe a half-set CODEGRAPH_HOME mid-test.
[CollectionDefinition("CodeGraphHomeEnv", DisableParallelization = true)]
public sealed class CodeGraphHomeEnvCollection
{
}

// -----------------------------------------------------------------------------
// (a) Segment matcher. A fresh temp store per test; InsertNode materializes
// name_segment_vocab on the write path, so GetSegmentMatches reads the same
// vocabulary the shipping engine would.
// -----------------------------------------------------------------------------
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphSegmentMatchTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphSegmentMatchTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

    // Tier A (co-occurrence): two prompt words that are BOTH segments of the same
    // name outrank a name that carries only one. "order" + "state" ->
    // OrderStateMachine, not OrderRepository.
    [Fact]
    public void CoOccurrence_RanksTwoWordMatchFirst()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("fn:osm", "OrderStateMachine", CodeGraphNodeKind.Class, "src/order-state-machine.ts", 3),
            CodeGraphTestSupport.MakeNode("fn:repo", "OrderRepository", CodeGraphNodeKind.Class, "src/order-repository.ts", 1)
        });

        var matches = CodeGraphSegmentMatcher.GetSegmentMatches(store, new[] { "order", "state" });

        // OrderStateMachine matched two distinct prompt words, so it is the top hit.
        Assert.Equal("OrderStateMachine", matches[0].Name);
        Assert.Equal(new[] { "order", "state" }, matches[0].MatchedWords);
        // The representative definition carries its real kind / file / 1-based line.
        Assert.Equal(CodeGraphNodeKind.Class, matches[0].Kind);
        Assert.Equal("src/order-state-machine.ts", matches[0].FilePath);
        Assert.Equal(3, matches[0].StartLine);

        // The single-word name never qualifies alongside a two-word co-occurrence.
        Assert.DoesNotContain(matches, m => m.Name == "OrderRepository");
    }

    // Cross-lingual reach: prose in another Latin-script language whose technical
    // nouns are English identifiers still resolves via co-occurrence — no keyword
    // list. "machine à états des commandes" -> OrderStateMachine (order/state).
    [Fact]
    public void CoOccurrence_IsLanguageAgnostic()
    {
        store.InsertNode(CodeGraphTestSupport.MakeNode(
            "fn:osm", "OrderStateMachine", CodeGraphNodeKind.Class, "src/osm.ts", 1));

        var matches = CodeGraphSegmentMatcher.GetSegmentMatches(store, new[] { "state", "order", "commande" });

        Assert.Contains(matches, m => m.Name == "OrderStateMachine");
    }

    // Tier B (single rare word): one matched word qualifies only when its segment is
    // discriminative — present in >= 2 names (a concept the codebase clusters around)
    // and <= the rarity ceiling. "checkout" spans CheckoutService/CheckoutController.
    [Fact]
    public void SingleRareWord_QualifiesWhenClustered()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("c:svc", "CheckoutService", CodeGraphNodeKind.Class, "src/checkout-service.ts", 1),
            CodeGraphTestSupport.MakeNode("c:ctl", "CheckoutController", CodeGraphNodeKind.Class, "src/checkout-controller.ts", 1)
        });

        var matches = CodeGraphSegmentMatcher.GetSegmentMatches(store, new[] { "checkout" });

        Assert.Contains(matches, m => m.Name == "CheckoutService");
        Assert.Contains(matches, m => m.Name == "CheckoutController");
        // Single-word tier reports exactly the one matched word.
        Assert.All(matches, m => Assert.Equal(new[] { "checkout" }, m.MatchedWords));
    }

    // A segment that appears in only ONE name is a singleton — a prose coincidence,
    // not a concept — so the single-word tier rejects it (n >= 2 required).
    [Fact]
    public void SingleRareWord_RejectsSingletonSegment()
    {
        store.InsertNode(CodeGraphTestSupport.MakeNode(
            "fn:repo", "OrderRepository", CodeGraphNodeKind.Class, "src/repo.ts", 1));

        var matches = CodeGraphSegmentMatcher.GetSegmentMatches(store, new[] { "repository" });

        Assert.Empty(matches);
    }

    // The honesty gate: a vocab row whose backing node was deleted (an orphan) is
    // never surfaced — GetSegmentMatches re-verifies each candidate against `nodes`.
    [Fact]
    public void HonestyGate_SkipsOrphanedVocabRow()
    {
        var a = CodeGraphTestSupport.MakeNode("c:a", "CheckoutService", CodeGraphNodeKind.Class, "src/a.ts", 1);
        var b = CodeGraphTestSupport.MakeNode("c:b", "CheckoutController", CodeGraphNodeKind.Class, "src/b.ts", 1);
        store.InsertNodes(new[] { a, b });

        // Delete one node's row but leave its vocab entries (delete leaves orphans by
        // design), then confirm only the still-present name comes back.
        store.DeleteNode("c:a");

        var matches = CodeGraphSegmentMatcher.GetSegmentMatches(store, new[] { "checkout" });

        Assert.DoesNotContain(matches, m => m.Name == "CheckoutService");
        Assert.Contains(matches, m => m.Name == "CheckoutController");
    }

    // No words in, nothing out (the zero-cost guard).
    [Fact]
    public void EmptyInput_ReturnsEmpty()
    {
        Assert.Empty(CodeGraphSegmentMatcher.GetSegmentMatches(store, Array.Empty<string>()));
    }

    // The engine facade exposes GetSegmentMatches and delegates to the matcher without
    // throwing (index.ts getSegmentMatches surface). An empty graph returns nothing —
    // the substantive ranking is pinned by the store-level tests above.
    [Fact]
    public void EngineFacade_ExposesGetSegmentMatches()
    {
        var root = Path.Combine(Path.GetTempPath(), "codegraph-seg-" + Guid.NewGuid().ToString("N"));
        var home = Path.Combine(Path.GetTempPath(), "codegraph-seg-home-" + Guid.NewGuid().ToString("N"));
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        CodeGraphEngine? engine = null;
        try
        {
            Directory.CreateDirectory(root);
            engine = CodeGraphEngine.Open(root, scanner: CodeGraphNoopFileScanner.Instance);

            Assert.Empty(engine.GetSegmentMatches(new[] { "order", "state" }));
            // The upgrade-heal is a no-op on an empty graph (no nodes to rebuild from).
            Assert.False(engine.HealSegmentVocabIfEmpty());
        }
        finally
        {
            engine?.Dispose();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(root);
            CodeGraphTestSupport.DeleteDir(home);
        }
    }
}

// -----------------------------------------------------------------------------
// (b) Structural-prompt heuristics — the graph-free candidate gate (multilingual
// keyword tables + identifier-token shapes). Pure functions; no store needed.
// -----------------------------------------------------------------------------
public sealed class CodeGraphStructuralPromptTests
{
    // The canonical English "how … flow work" question fires on the keyword path.
    [Fact]
    public void HasStructuralKeyword_EnglishFlowQuestion()
    {
        Assert.True(CodeGraphStructuralPrompt.HasStructuralKeyword("how does the auth flow work"));
    }

    // Stem prefixes match derived forms: "architecture" via the "architect" stem,
    // "dependencies" via "depend".
    [Fact]
    public void HasStructuralKeyword_StemPrefixes()
    {
        Assert.True(CodeGraphStructuralPrompt.HasStructuralKeyword("explain the architecture"));
        Assert.True(CodeGraphStructuralPrompt.HasStructuralKeyword("what are the dependencies here"));
    }

    // Multilingual coverage: a CJK "how does it work" (unsegmented substring path)
    // and a French "comment" (Latin exact-word path).
    [Fact]
    public void HasStructuralKeyword_NonEnglishScripts()
    {
        Assert.True(CodeGraphStructuralPrompt.HasStructuralKeyword("这个功能如何实现"));
        Assert.True(CodeGraphStructuralPrompt.HasStructuralKeyword("comment fonctionne ce module"));
    }

    // Ordinary prose with no structural keyword and no identifier shape is a no-op —
    // the whole point of the cheap gate.
    [Fact]
    public void HasStructuralKeyword_PlainProseIsNoOp()
    {
        Assert.False(CodeGraphStructuralPrompt.HasStructuralKeyword("fix this typo please"));
        Assert.False(CodeGraphStructuralPrompt.IsStructuralPrompt("fix this typo please"));
    }

    // Identifier-shaped tokens: camelCase, snake_case, call form, and member access;
    // a bare lowercase word is NOT a token, and a doc filename is excluded.
    [Fact]
    public void ExtractCodeTokens_IdentifierShapes()
    {
        Assert.Contains("getUserId", CodeGraphStructuralPrompt.ExtractCodeTokens("where is getUserId defined"));
        Assert.Contains("get_user", CodeGraphStructuralPrompt.ExtractCodeTokens("call get_user then"));

        var call = CodeGraphStructuralPrompt.ExtractCodeTokens("does parseToken() run first");
        Assert.Contains("parseToken", call);

        var member = CodeGraphStructuralPrompt.ExtractCodeTokens("trace user.login flow");
        Assert.Contains("user", member);
        Assert.Contains("login", member);

        // A bare lowercase word is prose, not a symbol shape.
        Assert.DoesNotContain("flower", CodeGraphStructuralPrompt.ExtractCodeTokens("water the flower"));
        // A doc/data filename is a file reference, not a member access.
        Assert.Empty(CodeGraphStructuralPrompt.ExtractCodeTokens("see README.md"));
    }

    // isStructuralPrompt fires on a token even with no keyword (and stays a no-op on
    // plain prose).
    [Fact]
    public void IsStructuralPrompt_TokenOnly()
    {
        Assert.True(CodeGraphStructuralPrompt.IsStructuralPrompt("UserService"));
        Assert.False(CodeGraphStructuralPrompt.IsStructuralPrompt("please tidy up"));
    }
}
