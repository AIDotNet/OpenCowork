using System.Text;
using System.Text.Json;
using Xunit;

// =============================================================================
// M7-W1 read-connection pool (analysis/04 §5.1). Tool-shaped reads run on pooled
// READ-ONLY engines over their own WAL connections instead of serializing on the
// per-project writer gate. Pins:
//   (a) parallel tool reads all succeed (pool creation race + reuse);
//   (b) a WAL reader sees rows committed by a separate write connection AFTER the
//       pool was first populated (snapshot-per-query, no stale pinning);
//   (c) a read-only engine hard-refuses the write entrypoints.
// Seeds the graph DB directly through the store factory (no grammar needed);
// CODEGRAPH_HOME is redirected so the real ~/.open-cowork is never touched.
// =============================================================================
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphReadPoolTests
{
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

    // Seed a project's centralized graph DB with a couple of symbols, bypassing
    // extraction (the pool is storage/handler plumbing — grammar-free).
    private static void SeedProject(string root)
    {
        using var store = CodeGraphStoreFactory.Open(CodeGraphDataDir.GraphDbPath(Path.GetFullPath(root)));
        store.SetMetadata("project_root", Path.GetFullPath(root));
        store.SetMetadata("index_state", "complete");
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:a", "a.ts", CodeGraphNodeKind.File, "a.ts", 1),
            CodeGraphTestSupport.MakeNode("func:greet", "greet", CodeGraphNodeKind.Function, "a.ts", 2, isExported: true)
        });
    }

    private static (string Home, string Root, string? PreviousHome) Enter()
    {
        var home = Path.Combine(Path.GetTempPath(), "codegraph-pool-home-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(Path.GetTempPath(), "codegraph-pool-root-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(home);
        Directory.CreateDirectory(root);
        var previous = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        return (home, root, previous);
    }

    private static void Exit(string home, string root, string? previousHome)
    {
        CodeGraphToolHandler.ResetForTests();
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
        CodeGraphTestSupport.DeleteDir(home);
        CodeGraphTestSupport.DeleteDir(root);
    }

    [Fact]
    public void ParallelToolReads_AllSucceed_AndSeeLaterCommits()
    {
        var (home, root, prev) = Enter();
        try
        {
            SeedProject(root);

            // (a) 8 concurrent searches: exercises reader creation under race, slot
            // waiting (pool size 3), and reuse. All must succeed and find the symbol.
            var results = new CodeGraphToolResult[8];
            Parallel.For(0, results.Length, i =>
            {
                results[i] = CodeGraphToolHandler.Search(Args(("workingFolder", root), ("query", "greet")));
            });

            foreach (var r in results)
            {
                Assert.True(r.Success);
                Assert.False(r.IsError);
                Assert.Contains("greet", r.Text);
            }

            // (b) A separate WRITE connection commits a new symbol; a pooled reader's
            // next query must see it (WAL readers take a fresh snapshot per query).
            using (var writeStore = CodeGraphStoreFactory.OpenExisting(CodeGraphDataDir.GraphDbPath(Path.GetFullPath(root))))
            {
                writeStore.InsertNodes(new[]
                {
                    CodeGraphTestSupport.MakeNode("func:farewell", "farewell", CodeGraphNodeKind.Function, "a.ts", 9, isExported: true)
                });
            }

            var after = CodeGraphToolHandler.Search(Args(("workingFolder", root), ("query", "farewell")));
            Assert.True(after.Success);
            Assert.Contains("farewell", after.Text);
        }
        finally
        {
            Exit(home, root, prev);
        }
    }

    [Fact]
    public async Task ReadOnlyEngine_RefusesWrites()
    {
        var (home, root, prev) = Enter();
        try
        {
            SeedProject(root);

            using var reader = CodeGraphEngine.OpenReadOnly(root);

            // Queries work…
            var stats = reader.GetStats();
            Assert.True(stats.NodeCount >= 2);

            // …writes hard-refuse.
            await Assert.ThrowsAsync<InvalidOperationException>(() => reader.IndexAll());
            await Assert.ThrowsAsync<InvalidOperationException>(() => reader.Sync());
        }
        finally
        {
            Exit(home, root, prev);
        }
    }
}
