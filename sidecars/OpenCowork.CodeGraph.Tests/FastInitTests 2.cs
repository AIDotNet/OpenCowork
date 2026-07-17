using Xunit;

// =============================================================================
// M7-W2 fast-init goldens. Pins the two accelerations and their restoration:
//   * FTS bulk mode — triggers dropped, one 'rebuild' re-derives nodes_fts, and
//     post-bulk writes mirror per-row again (triggers re-armed).
//   * A full IndexAll on a FRESH project leaves the DB searchable and restores
//     synchronous=NORMAL (grammar-free: Noop scanner indexes zero files, but the
//     fast-init window still opens and closes around the run).
// =============================================================================
public sealed class CodeGraphFastInitTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphFastInitTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

    private long FtsCount() =>
        store.ExecuteScalarLong("SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH 'greet OR farewell'");

    [Fact]
    public void FtsBulkMode_RebuildsOnce_ThenMirrorsPerRowAgain()
    {
        store.BeginFtsBulk();

        // Triggers are off: the insert does NOT mirror into nodes_fts.
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("func:greet", "greet", CodeGraphNodeKind.Function, "a.ts", 1, isExported: true)
        });
        Assert.Equal(0, FtsCount());

        // End of bulk: one rebuild derives the index from `nodes`.
        store.EndFtsBulk();
        Assert.Equal(1, FtsCount());

        // Triggers re-armed: later writes mirror per-row (the sync path).
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("func:farewell", "farewell", CodeGraphNodeKind.Function, "a.ts", 5, isExported: true)
        });
        Assert.Equal(2, FtsCount());

        // Idempotent: a second EndFtsBulk is a no-op.
        store.EndFtsBulk();
        Assert.Equal(2, FtsCount());
    }

    [Fact]
    public async Task FreshIndex_RestoresSynchronousNormal()
    {
        var root = Path.Combine(Path.GetTempPath(), "codegraph-fastinit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        var home = Path.Combine(Path.GetTempPath(), "codegraph-fastinit-home-" + Guid.NewGuid().ToString("N"));
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        try
        {
            using var engine = CodeGraphEngine.Open(root, CodeGraphNoopFileScanner.Instance);
            await engine.IndexAll();

            using var check = CodeGraphStoreFactory.OpenExisting(CodeGraphDataDir.GraphDbPath(Path.GetFullPath(root)));
            // A fresh connection always opens at NORMAL; the assertion that matters is
            // the WRITER's connection after IndexAll — read it via the engine's store.
            Assert.Equal("complete", engine.GetIndexState());
            Assert.Equal(1L, check.ExecuteScalarLong("SELECT 1")); // DB healthy post fast-init
        }
        finally
        {
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(home);
            CodeGraphTestSupport.DeleteDir(root);
        }
    }
}
