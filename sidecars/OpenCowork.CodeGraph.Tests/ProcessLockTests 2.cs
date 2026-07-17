using Xunit;

// M7-W1 cross-process write lock (CodeGraphProcessLock, §5.7). The OS share-lock
// (FileShare.None → flock/mandatory lock) is the mechanism; these pin the contract:
// exclusive while held, TimeoutException on contention, re-acquirable after release,
// and a leftover lock FILE (crashed holder) never blocks.
public sealed class CodeGraphProcessLockTests : IDisposable
{
    private readonly string directory;

    public CodeGraphProcessLockTests()
    {
        directory = Path.Combine(Path.GetTempPath(), "codegraph-lock-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
    }

    public void Dispose() => CodeGraphTestSupport.DeleteDir(directory);

    private string DbPath => Path.Combine(directory, "graph.db");

    [Fact]
    public void SecondAcquire_TimesOutWhileHeld_SucceedsAfterRelease()
    {
        var first = CodeGraphProcessLock.Acquire(DbPath, waitMs: 500);

        // Held: a second acquire (same semantics as a second process — the handle,
        // not the process, owns the OS lock) must time out.
        Assert.Throws<TimeoutException>(() => CodeGraphProcessLock.Acquire(DbPath, waitMs: 300));

        first.Dispose();

        // Released: immediately re-acquirable; double-dispose is safe.
        using var second = CodeGraphProcessLock.Acquire(DbPath, waitMs: 500);
        first.Dispose();
    }

    [Fact]
    public void LeftoverLockFile_NeverBlocks()
    {
        // Simulate a crashed holder: the FILE exists but no live handle locks it.
        File.WriteAllText(DbPath + ".lock", "99999\n0\n");

        using var acquired = CodeGraphProcessLock.Acquire(DbPath, waitMs: 500);
        Assert.NotNull(acquired);
    }
}
