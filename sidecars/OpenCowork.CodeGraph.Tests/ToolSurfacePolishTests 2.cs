using System.Text;
using System.Text.Json;
using Xunit;

// =============================================================================
// M5 tool-surface polish (analysis/04 §3.2): the three tools-list transforms and the
// size-tiered explore budgets, ported from mcp/tools.ts.
//
//   * CODEGRAPH_MCP_TOOLS allowlist — REPLACES the default surface in tools-list AND
//     is enforced again at execute time (success-shaped guidance, never isError).
//   * Tiny-repo gating — under 500 indexed files only explore/search/node are LISTED
//     (everything stays executable).
//   * Require-projectPath — with no resolvable project, every exposed schema is a
//     CLONE with projectPath in `required`; the shared static defs never mutate.
//   * Explore budgets — the dynamic "Budget: make at most N calls…" description
//     suffix, and the tiered output cap with the trimmed/truncation notes.
//
// Grammar-free: the indexed-project cases seed the centralized store directly via
// CodeGraphTestSupport (real SQLite, no tree-sitter). Env-mutating (CODEGRAPH_HOME,
// CODEGRAPH_MCP_TOOLS), so the class joins the serialized CodeGraphHomeEnv
// collection and restores every variable in a finally.
// =============================================================================
[Collection("CodeGraphHomeEnv")]
public sealed class ToolSurfacePolishTests
{
    private const string AllowlistVar = "CODEGRAPH_MCP_TOOLS";

    private static readonly string[] AllShortNames =
    {
        "explore", "search", "node", "callers", "callees", "impact", "files", "status"
    };

    // ---------------------------------------------------------------------------
    // Allowlist: replaces the listed surface, and gates execution defensively.
    // ---------------------------------------------------------------------------
    [Fact]
    public void Allowlist_ReplacesSurface_AndIsEnforcedAtExecuteTime()
    {
        var previous = Environment.GetEnvironmentVariable(AllowlistVar);
        try
        {
            // Unset -> the default surface (explore alone).
            Environment.SetEnvironmentVariable(AllowlistVar, null);
            Assert.Equal(
                new[] { "codegraph_explore" },
                CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: null).Tools.Select(t => t.Name));

            // Set -> REPLACES the default entirely. Short and codegraph_-prefixed
            // spellings both work; whitespace is trimmed.
            Environment.SetEnvironmentVariable(AllowlistVar, " search , codegraph_node ");
            var listed = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: null).Tools;
            Assert.Equal(new[] { "codegraph_search", "codegraph_node" }, listed.Select(t => t.Name));

            // The static surface honors it too.
            Assert.Equal(
                new[] { "codegraph_search", "codegraph_node" },
                CodeGraphToolDefs.ListDefault().Tools.Select(t => t.Name));

            // Execute-time enforcement: explore is NOT allowlisted -> success-shaped
            // guidance (never isError), before any project resolution.
            var blocked = CodeGraphToolHandler.Explore(Args(("query", "greet")));
            Assert.True(blocked.Success);
            Assert.False(blocked.IsError);
            Assert.Contains("disabled via CODEGRAPH_MCP_TOOLS", blocked.Text, StringComparison.Ordinal);

            // An allowlisted tool passes the gate (and proceeds to the normal
            // no-default-project guidance).
            var allowed = CodeGraphToolHandler.Search(Args(("query", "greet")));
            Assert.True(allowed.Success);
            Assert.DoesNotContain("disabled via CODEGRAPH_MCP_TOOLS", allowed.Text, StringComparison.Ordinal);
            Assert.Equal(CodeGraphErrorKind.NotIndexed, allowed.ErrorKind);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AllowlistVar, previous);
        }
    }

    // ---------------------------------------------------------------------------
    // Tiny-repo gating: <500 indexed files -> only the core trio is LISTED.
    // ---------------------------------------------------------------------------
    [Fact]
    public void TinyRepo_ListsOnlyCoreTrio_ButOthersStayExecutable()
    {
        var previous = Environment.GetEnvironmentVariable(AllowlistVar);
        try
        {
            // Expose all 8 so the gating (not the allowlist) does the trimming.
            Environment.SetEnvironmentVariable(AllowlistVar, string.Join(",", AllShortNames));

            var tiny = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: 100).Tools;
            Assert.Equal(
                new[] { "codegraph_explore", "codegraph_search", "codegraph_node" },
                tiny.Select(t => t.Name));

            // At/above the threshold the full allowlisted surface returns.
            var big = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: 5_000).Tools;
            Assert.Equal(8, big.Length);

            // A gated-out tool is only unlisted — it still executes (here: passes the
            // allowlist gate and reaches the no-default-project guidance).
            var callers = CodeGraphToolHandler.Callers(Args(("symbol", "greet")));
            Assert.True(callers.Success);
            Assert.Equal(CodeGraphErrorKind.NotIndexed, callers.ErrorKind);
            Assert.DoesNotContain("disabled via CODEGRAPH_MCP_TOOLS", callers.Text, StringComparison.Ordinal);

            // With the default (explore-only) surface, tiny gating leaves explore.
            Environment.SetEnvironmentVariable(AllowlistVar, null);
            var defaultTiny = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: 100).Tools;
            Assert.Single(defaultTiny);
            Assert.Equal("codegraph_explore", defaultTiny[0].Name);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AllowlistVar, previous);
        }
    }

    // ---------------------------------------------------------------------------
    // Require-projectPath (#993): no default project -> every exposed schema clones
    // with projectPath required; the shared static defs never mutate.
    // ---------------------------------------------------------------------------
    [Fact]
    public void NoDefaultProject_MarksProjectPathRequired_WithoutMutatingStaticDefs()
    {
        var previous = Environment.GetEnvironmentVariable(AllowlistVar);
        try
        {
            Environment.SetEnvironmentVariable(AllowlistVar, string.Join(",", AllShortNames));

            var noRoot = CodeGraphToolDefs.ListFor(hasDefaultProject: false, indexedFileCount: null).Tools;
            Assert.Equal(8, noRoot.Length);
            foreach (var tool in noRoot)
            {
                Assert.NotNull(tool.InputSchema.Required);
                Assert.Contains("projectPath", tool.InputSchema.Required!);
            }

            // explore: ["query"] -> ["query","projectPath"]; status (no required list)
            // gains ["projectPath"].
            var explore = noRoot.Single(t => t.Name == "codegraph_explore");
            Assert.Equal(new[] { "query", "projectPath" }, explore.InputSchema.Required);
            var status = noRoot.Single(t => t.Name == "codegraph_status");
            Assert.Equal(new[] { "projectPath" }, status.InputSchema.Required);

            // Annotations survive the clone (Cursor Ask mode requirement, #1018).
            Assert.All(noRoot, t => Assert.True(t.Annotations.ReadOnlyHint));

            // The shared static definitions were cloned, never mutated.
            var master = CodeGraphToolDefs.All();
            Assert.Equal(new[] { "query" }, master.Single(t => t.Name == "codegraph_explore").InputSchema.Required);
            Assert.Null(master.Single(t => t.Name == "codegraph_status").InputSchema.Required);

            // With a default project the schemas stay untouched.
            var withRoot = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: null).Tools;
            Assert.Equal(new[] { "query" }, withRoot.Single(t => t.Name == "codegraph_explore").InputSchema.Required);
        }
        finally
        {
            Environment.SetEnvironmentVariable(AllowlistVar, previous);
        }
    }

    // ---------------------------------------------------------------------------
    // Explore budgets: the call-budget tiers and the description suffix.
    // ---------------------------------------------------------------------------
    [Fact]
    public void ExploreBudget_TiersAndDescriptionSuffix()
    {
        // getExploreBudget breakpoints (tools.ts:134).
        Assert.Equal(1, CodeGraphExploreBudget.GetCallBudget(499));
        Assert.Equal(2, CodeGraphExploreBudget.GetCallBudget(500));
        Assert.Equal(2, CodeGraphExploreBudget.GetCallBudget(4_999));
        Assert.Equal(3, CodeGraphExploreBudget.GetCallBudget(5_000));
        Assert.Equal(4, CodeGraphExploreBudget.GetCallBudget(15_000));
        Assert.Equal(5, CodeGraphExploreBudget.GetCallBudget(25_000));

        // getExploreOutputBudget tiers (tools.ts:192): total caps, and the meta-text
        // toggles flip on at the ≥500 tier; MaxCharsPerFile is monotonic.
        var tiny = CodeGraphExploreBudget.GetOutputBudget(100);
        var small = CodeGraphExploreBudget.GetOutputBudget(300);
        var mid = CodeGraphExploreBudget.GetOutputBudget(1_000);
        var large = CodeGraphExploreBudget.GetOutputBudget(200_000);
        Assert.Equal(13_000, tiny.MaxOutputChars);
        Assert.Equal(4, tiny.DefaultMaxFiles);
        Assert.False(tiny.IncludeBudgetNote);
        Assert.True(tiny.ExcludeLowValueFiles);
        Assert.Equal(18_000, small.MaxOutputChars);
        Assert.Equal(24_000, mid.MaxOutputChars);
        Assert.True(mid.IncludeBudgetNote);
        Assert.True(mid.IncludeCompletenessSignal);
        Assert.Equal(24_000, large.MaxOutputChars);
        Assert.True(tiny.MaxCharsPerFile <= small.MaxCharsPerFile);
        Assert.True(small.MaxCharsPerFile <= mid.MaxCharsPerFile);
        Assert.True(mid.MaxCharsPerFile <= large.MaxCharsPerFile);

        // The tools-list explore description gains the dynamic budget suffix.
        var listed = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: 800).Tools;
        var explore = listed.Single(t => t.Name == "codegraph_explore");
        Assert.EndsWith(
            "Budget: make at most 2 calls for this project (800 files indexed).",
            explore.Description);

        // Thousands separator (invariant) + a bigger tier.
        var big = CodeGraphToolDefs.ListFor(hasDefaultProject: true, indexedFileCount: 20_000).Tools
            .Single(t => t.Name == "codegraph_explore");
        Assert.EndsWith(
            "Budget: make at most 4 calls for this project (20,000 files indexed).",
            big.Description);

        // The shared static def carries no suffix (clone, not mutation).
        Assert.DoesNotContain(
            "Budget:",
            CodeGraphToolDefs.All().Single(t => t.Name == "codegraph_explore").Description,
            StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------------------
    // ToolsList threads workingFolder through to the shaping (seeded store, no
    // grammar), and degrades to the require-projectPath surface with no root.
    // ---------------------------------------------------------------------------
    [Fact]
    public void ToolsList_UsesWorkingFolderStats_AndDegradesWithoutRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "codegraph-polish-" + Guid.NewGuid().ToString("N"));
        var home = Path.Combine(Path.GetTempPath(), "codegraph-home-" + Guid.NewGuid().ToString("N"));
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        try
        {
            Directory.CreateDirectory(root);
            SeedStore(root, store =>
            {
                for (var i = 0; i < 3; i++)
                {
                    UpsertSeedFile(store, $"src/f{i}.ts");
                }
            });

            // Project known + indexed (3 files -> tiny tier): the default surface
            // (explore) with the budget suffix; projectPath stays optional.
            var listed = CodeGraphToolHandler.ToolsList(Args(("workingFolder", root)));
            Assert.True(listed.Success);
            Assert.Single(listed.Tools);
            var explore = listed.Tools[0];
            Assert.Equal("codegraph_explore", explore.Name);
            Assert.EndsWith(
                "Budget: make at most 1 calls for this project (3 files indexed).",
                explore.Description);
            Assert.Equal(new[] { "query" }, explore.InputSchema.Required);

            // No root at all -> the require-projectPath surface, no budget suffix.
            var noRoot = CodeGraphToolHandler.ToolsList(Args());
            Assert.Single(noRoot.Tools);
            Assert.Contains("projectPath", noRoot.Tools[0].InputSchema.Required!);
            Assert.DoesNotContain("Budget:", noRoot.Tools[0].Description, StringComparison.Ordinal);

            // Root known but never indexed -> the plain default surface (graceful
            // degradation: no gating, no suffix, no required transform). Listing
            // must NOT auto-index.
            var unindexed = Path.Combine(root, "sub-never-indexed");
            Directory.CreateDirectory(unindexed);
            var plain = CodeGraphToolHandler.ToolsList(Args(("workingFolder", unindexed)));
            Assert.Single(plain.Tools);
            Assert.Equal(new[] { "query" }, plain.Tools[0].InputSchema.Required);
            Assert.DoesNotContain("Budget:", plain.Tools[0].Description, StringComparison.Ordinal);
            Assert.False(CodeGraphEngine.IsInitialized(unindexed));
        }
        finally
        {
            CodeGraphToolHandler.ResetForTests();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(root);
            CodeGraphTestSupport.DeleteDir(home);
        }
    }

    // ---------------------------------------------------------------------------
    // Explore output budget: an oversized result is trimmed to the tier cap with the
    // completeness/budget note.
    // ---------------------------------------------------------------------------
    [Fact]
    public void Explore_OversizedOutput_IsTrimmedToTierBudget_WithNote()
    {
        var root = Path.Combine(Path.GetTempPath(), "codegraph-polish-" + Guid.NewGuid().ToString("N"));
        var home = Path.Combine(Path.GetTempPath(), "codegraph-home-" + Guid.NewGuid().ToString("N"));
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        try
        {
            // Five real files (~6.6K chars each) so every code block saturates the
            // tiny tier's 3,800-char per-file cap; a root symbol calling one function
            // in each sibling file so the subgraph gathers all five.
            Directory.CreateDirectory(Path.Combine(root, "src"));
            var bigBody = BuildBigSource(lines: 120);
            string[] names = { "renderPipeline", "stageOne", "stageTwo", "stageThree", "stageFour" };
            for (var i = 0; i < names.Length; i++)
            {
                File.WriteAllText(Path.Combine(root, "src", $"f{i}.ts"), bigBody);
            }

            SeedStore(root, store =>
            {
                for (var i = 0; i < names.Length; i++)
                {
                    UpsertSeedFile(store, $"src/f{i}.ts");
                    store.InsertNode(CodeGraphTestSupport.MakeNode(
                        names[i],
                        filePath: $"src/f{i}.ts",
                        startLine: 1,
                        endLine: 120,
                        isExported: true));
                }

                for (var i = 1; i < names.Length; i++)
                {
                    store.InsertEdge(CodeGraphTestSupport.MakeEdge(
                        names[0], names[i], CodeGraphEdgeKind.Calls, line: i));
                }
            });

            var result = CodeGraphToolHandler.Explore(Args(("workingFolder", root), ("query", "renderPipeline")));
            Assert.True(result.Success);
            Assert.False(result.IsError);
            Assert.Contains("renderPipeline", result.Text, StringComparison.Ordinal);

            // 5 indexed files -> the <150 tier: 13,000-char cap. The rendered blocks
            // (4 × ~3.8K + scaffolding) overflow it, so whole sections are dropped
            // (or the line-boundary cut fires) and the note is appended. Allow slack
            // for the note itself — it is appended after the cap is satisfied.
            var budget = CodeGraphExploreBudget.GetOutputBudget(5);
            Assert.True(
                result.Text.Length <= budget.MaxOutputChars + 400,
                $"explore output not budgeted: {result.Text.Length} chars");
            var trimmedNote = result.Text.Contains("Some file sections were trimmed for size", StringComparison.Ordinal);
            var truncatedNote = result.Text.Contains("output truncated to budget", StringComparison.Ordinal);
            Assert.True(trimmedNote || truncatedNote, "expected a completeness/budget note in trimmed explore output");
        }
        finally
        {
            CodeGraphToolHandler.ResetForTests();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(root);
            CodeGraphTestSupport.DeleteDir(home);
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    // Seed the centralized graph DB for `root` directly (grammar-free), then close it
    // so the tool handler opens its own engine over the same DB.
    private static void SeedStore(string root, Action<CodeGraphStore> seed)
    {
        using var store = CodeGraphStoreFactory.Open(CodeGraphDataDir.GraphDbPath(Path.GetFullPath(root)));
        seed(store);
    }

    private static void UpsertSeedFile(CodeGraphStore store, string path) =>
        store.UpsertFile(new CodeGraphFileRecord(
            Path: path,
            ContentHash: "hash-" + path,
            Language: CodeGraphLanguage.TypeScript,
            Size: 1,
            ModifiedAt: CodeGraphTestSupport.FixedClock,
            IndexedAt: CodeGraphTestSupport.FixedClock,
            NodeCount: 1,
            Errors: null));

    // ~55 chars per line so 120 lines is ~6.6K — comfortably past the tiny tier's
    // 3,800-char per-file cap.
    private static string BuildBigSource(int lines)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < lines; i++)
        {
            sb.Append("const filler_").Append(i).Append(" = 'abcdefghijklmnopqrstuvwxyz0123456789'\n");
        }

        return sb.ToString();
    }

    // Build a JsonElement args object from string key/value pairs (the wire shape the
    // handlers read via JsonHelpers). Clone() detaches it from the parsed document.
    private static JsonElement Args(params (string Key, string Value)[] pairs)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var (key, value) in pairs)
            {
                writer.WriteString(key, value);
            }

            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(Encoding.UTF8.GetString(stream.ToArray()));
        return document.RootElement.Clone();
    }
}
