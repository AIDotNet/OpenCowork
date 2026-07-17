using Microsoft.Data.Sqlite;
using Xunit;

// =============================================================================
// WAL checkpoint deferral during bulk indexing (#1231) — C# port of
// __tests__/wal-deferral.test.ts. Pins:
//   (a) resolveWalValveMb env parsing;
//   (b) the CodeGraphConnectionFactory WAL helpers (autocheckpoint read/write,
//       WAL-size stat, off-thread PASSIVE checkpoint + its result row);
//   (c) the CodeGraphWalValve trigger / baseline / backpressure / foldNow / dedupe
//       logic; and
//   (d) the end-to-end indexAll invariant: an IDENTICAL graph is produced WITH and
//       WITHOUT wal-deferral, and the auto-checkpoint interval is restored after.
//
// (b)/(c) drive a raw SQLite file directly (no schema) exactly as the TS suite does:
// autocheckpoint off + committed writes make the WAL grow and nothing folds it back
// until a checkpoint fires.
// =============================================================================

public sealed class CodeGraphWalValveResolveTests
{
    [Theory]
    [InlineData("64", 64d)]
    [InlineData("64.9", 64d)]     // floored
    [InlineData(null, 256d)]      // default
    [InlineData("", 256d)]
    [InlineData("abc", 256d)]
    [InlineData("0", 256d)]       // non-positive → default
    [InlineData("-5", 256d)]
    public void ResolveWalValveMb_HonorsPositiveNumericOverrideElseDefault(string? env, double expected) =>
        Assert.Equal(expected, CodeGraphWalValve.ResolveWalValveMb(env));
}

// -----------------------------------------------------------------------------
// (b) Connection-factory WAL helpers.
// -----------------------------------------------------------------------------
public sealed class CodeGraphWalHelperTests
{
    [Fact]
    public void ReadsAndWritesWalAutocheckpointInterval()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            Assert.Equal(1000, CodeGraphConnectionFactory.GetWalAutocheckpoint(db)); // SQLite default
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            Assert.Equal(0, CodeGraphConnectionFactory.GetWalAutocheckpoint(db));
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 1000);
            Assert.Equal(1000, CodeGraphConnectionFactory.GetWalAutocheckpoint(db));
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public void ReportsWalSizeThatGrowsWithDeferredCommits()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            var before = CodeGraphConnectionFactory.GetWalSizeBytes(dbPath);
            WalTestDb.WriteRows(db, 200);
            Assert.True(CodeGraphConnectionFactory.GetWalSizeBytes(dbPath) > before);
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public async Task CheckpointWalPassive_BackfillsFromWorkerConnectionAndReportsResult()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 500);

            var mainBefore = new FileInfo(dbPath).Length;
            var res = await CodeGraphConnectionFactory.CheckpointWalPassiveAsync(dbPath);

            // Backfill moves committed pages into the main DB file…
            Assert.True(new FileInfo(dbPath).Length > mainBefore);
            // …and reports a full backfill (idle DB: every WAL frame checkpointed).
            Assert.NotNull(res);
            Assert.Equal(0, res!.Value.Busy);
            Assert.True(res.Value.Log > 0);
            Assert.Equal(res.Value.Log, res.Value.Checkpointed);
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }
}

// -----------------------------------------------------------------------------
// (c) The valve.
// -----------------------------------------------------------------------------
public sealed class CodeGraphWalValveTests
{
    [Fact]
    public async Task Check_FiresOffThreadCheckpointOncePastSoftThreshold()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 500); // WAL well past a ~10-byte threshold

            var valve = new CodeGraphWalValve(dbPath, softMb: 0.00001); // ~10 bytes soft
            var mainBefore = new FileInfo(dbPath).Length;
            valve.Check();
            await valve.DrainAsync();
            Assert.True(new FileInfo(dbPath).Length > mainBefore);
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public async Task AdvancesBaselineOnFullBackfill_WrappedWalDoesNotRetrigger()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 500);

            var valve = new CodeGraphWalValve(dbPath, softMb: 0.00001);
            valve.Check();
            await valve.DrainAsync(); // full backfill on an idle DB → baseline = current file size

            // Growth is now 0: neither backpressure nor a fresh check may fire.
            Assert.Null(valve.Backpressure());
            valve.Check();
            await valve.DrainAsync(); // no-op drain — nothing in flight

            // New commits recycle wrapped frames — file size is flat, still no trigger.
            WalTestDb.WriteRows(db, 5);
            Assert.Null(valve.Backpressure());
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public async Task DoesNotFireBelowSoftThreshold()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 5);

            var valve = new CodeGraphWalValve(dbPath, softMb: 1024); // 1 GB soft — never reached
            var mainBefore = new FileInfo(dbPath).Length;
            valve.Check();
            await valve.DrainAsync();
            Assert.Equal(mainBefore, new FileInfo(dbPath).Length);
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public async Task Backpressure_NullUnderHardCap_TaskAboveIt()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 500);

            var relaxed = new CodeGraphWalValve(dbPath, softMb: 1024);
            Assert.Null(relaxed.Backpressure());

            var strict = new CodeGraphWalValve(dbPath, softMb: 0.0000001); // hard cap ~0 bytes
            var bp = strict.Backpressure();
            Assert.NotNull(bp);
            await bp!;
            await strict.DrainAsync();
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public async Task FoldNow_BackfillsEverythingAtPhaseBoundaryAndResetsGrowth()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 500);

            var valve = new CodeGraphWalValve(dbPath, softMb: 1024); // thresholds never reached on their own
            var mainBefore = new FileInfo(dbPath).Length;
            await valve.FoldNowAsync();
            Assert.True(new FileInfo(dbPath).Length > mainBefore); // pages backfilled
            Assert.Null(valve.Backpressure());                     // baseline advanced — growth is zero
            await valve.FoldNowAsync();                             // second fold is a no-op, must not spin
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }

    [Fact]
    public async Task DedupesConcurrentPausesIntoOneTask()
    {
        var dbPath = WalTestDb.New(out var dir);
        try
        {
            using var db = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
            CodeGraphConnectionFactory.SetWalAutocheckpoint(db, 0);
            WalTestDb.WriteRows(db, 500);

            var valve = new CodeGraphWalValve(dbPath, softMb: 0.00001);
            var first = valve.Backpressure();
            var second = valve.Backpressure();
            Assert.NotNull(first);
            Assert.Same(first, second); // same in-flight pause, not a second worker
            await first!;
            await valve.DrainAsync();
        }
        finally
        {
            WalTestDb.Cleanup(dir);
        }
    }
}

// -----------------------------------------------------------------------------
// (d) End-to-end: identical graph with and without deferral + interval restored.
// One class == one collection == sequential, so the process-global
// CODEGRAPH_HOME / CODEGRAPH_NO_WAL_DEFER overrides are race-free.
// -----------------------------------------------------------------------------
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphWalDeferralEndToEndTests
{
    [Fact]
    public async Task IndexAll_SameGraphWithAndWithoutDefer_AndRestoresAutocheckpoint()
    {
        // Self-skip when the TS grammar is absent (same guard the facade e2e uses).
        if (CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.TypeScript) is null)
        {
            return;
        }

        // Two identical source trees indexed under two SEPARATE graph homes, so each
        // pass builds a fresh graph DB from scratch (no cross-pass content-hash skip,
        // and no reliance on deleting a still-pooled DB file). The relative structure
        // and content are byte-identical, so the node/edge deltas must match exactly.
        var root1 = Path.Combine(Path.GetTempPath(), "codegraph-waldefer1-" + Guid.NewGuid().ToString("N"));
        var root2 = Path.Combine(Path.GetTempPath(), "codegraph-waldefer2-" + Guid.NewGuid().ToString("N"));
        var home1 = Path.Combine(Path.GetTempPath(), "codegraph-home1-" + Guid.NewGuid().ToString("N"));
        var home2 = Path.Combine(Path.GetTempPath(), "codegraph-home2-" + Guid.NewGuid().ToString("N"));
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        var previousNoDefer = Environment.GetEnvironmentVariable("CODEGRAPH_NO_WAL_DEFER");

        try
        {
            WriteFixture(root1);
            WriteFixture(root2);

            // Pass 1 — with WAL deferral (the default path).
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home1);
            Environment.SetEnvironmentVariable("CODEGRAPH_NO_WAL_DEFER", null);
            int nodes1, edges1;
            using (var engine = CodeGraphEngine.Init(
                       root1,
                       scanner: new WalFixtureScanner(),
                       extractors: CodeGraphExtractionHarness.BuildExtractors(),
                       grammars: CodeGraphExtractionHarness.Grammars))
            {
                var r1 = await engine.IndexAll();
                Assert.Equal(8, r1.FilesIndexed);
                Assert.DoesNotContain(r1.Errors, e => e.Severity == "error");
                // Deferral is scoped to the run: the writer connection is back on the default.
                Assert.Equal(1000, engine.WalAutocheckpointForTest);
                nodes1 = r1.NodesCreated;
                edges1 = r1.EdgesCreated;
            }

            // Pass 2 — deferral disabled via the kill switch.
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home2);
            Environment.SetEnvironmentVariable("CODEGRAPH_NO_WAL_DEFER", "1");
            using (var engine = CodeGraphEngine.Init(
                       root2,
                       scanner: new WalFixtureScanner(),
                       extractors: CodeGraphExtractionHarness.BuildExtractors(),
                       grammars: CodeGraphExtractionHarness.Grammars))
            {
                var r2 = await engine.IndexAll();
                Assert.Equal(8, r2.FilesIndexed);
                Assert.Equal(nodes1, r2.NodesCreated);
                Assert.Equal(edges1, r2.EdgesCreated);
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            Environment.SetEnvironmentVariable("CODEGRAPH_NO_WAL_DEFER", previousNoDefer);
            SqliteConnection.ClearAllPools();
            CodeGraphTestSupport.DeleteDir(root1);
            CodeGraphTestSupport.DeleteDir(root2);
            CodeGraphTestSupport.DeleteDir(home1);
            CodeGraphTestSupport.DeleteDir(home2);
        }
    }

    private static void WriteFixture(string root)
    {
        Directory.CreateDirectory(Path.Combine(root, "src"));
        for (var i = 0; i < 8; i++)
        {
            File.WriteAllText(
                Path.Combine(root, "src", $"mod{i}.ts"),
                $"export function fn{i}(x: number): number {{ return helper{i}(x) + {i} }}\n" +
                $"function helper{i}(x: number): number {{ return x * {i} }}\n");
        }
    }

    // Minimal recursive source-file scanner for the fixture tree.
    private sealed class WalFixtureScanner : ICodeGraphFileScanner
    {
        public IReadOnlyList<CodeGraphScannedFile> EnumerateFiles(string root, CodeGraphProjectConfig config)
        {
            var files = new List<CodeGraphScannedFile>();
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(root, file).Replace('\\', '/');
                if (CodeGraphLanguageMap.IsSourceFile(rel))
                {
                    files.Add(new CodeGraphScannedFile(rel));
                }
            }

            return files;
        }
    }
}

// Shared raw-SQLite fixture for the helper/valve suites (≙ the TS openDb + writeRows).
internal static class WalTestDb
{
    internal static string New(out string dir)
    {
        dir = Path.Combine(Path.GetTempPath(), "cg-wal-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "test.db");
    }

    // Grow the WAL: with autocheckpoint off, every commit appends and nothing folds back.
    internal static void WriteRows(SqliteConnection db, int rows)
    {
        using (var create = db.CreateCommand())
        {
            create.CommandText = "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)";
            create.ExecuteNonQuery();
        }

        using var tx = db.BeginTransaction();
        using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO t (blob) VALUES ($b)";
        var p = cmd.CreateParameter();
        p.ParameterName = "$b";
        p.Value = new string('x', 4096);
        cmd.Parameters.Add(p);
        for (var i = 0; i < rows; i++)
        {
            cmd.ExecuteNonQuery();
        }

        tx.Commit();
    }

    internal static void Cleanup(string dir)
    {
        SqliteConnection.ClearAllPools(); // release pooled file handles before deleting
        CodeGraphTestSupport.DeleteDir(dir);
    }
}
