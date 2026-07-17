using System.Diagnostics;
using System.Text;

// =============================================================================
// Cross-process WRITE lock for a project's graph DB (M7-W1; the engine header's
// §5.7 deferral). The in-process CodeGraphIndexLock serializes writers inside ONE
// worker; a second OpenCowork instance (or an orphaned worker after a crash) runs
// its own process and could interleave index/sync writes into the same graph.db.
//
// Mechanism: `graph.db.lock` beside the DB, held open with FileShare.None for the
// duration of a write pass. .NET maps FileShare.None to a mandatory share lock on
// Windows and flock() on POSIX, so mutual exclusion is real on both — and a crashed
// holder's lock is released by the OS with its handle, which supersedes the
// PID-liveness probe the plan sketched (the PID/timestamp stamp inside the file is
// diagnostics only). The file is deliberately NEVER deleted: unlinking a lock file
// another process may just have opened re-creates the classic two-holders inode
// race on POSIX, and a leftover file never blocks anyone under flock semantics.
//
// Scope: write passes only (IndexAll/Sync). Reads — the read pool and a second
// instance's queries — never touch it.
// =============================================================================
internal static class CodeGraphProcessLock
{
    // Acquire the cross-process write lock for `dbPath`, waiting up to `waitMs` for
    // a concurrent holder. Throws TimeoutException when another process keeps it.
    public static IDisposable Acquire(string dbPath, int waitMs = 10_000)
    {
        var lockPath = dbPath + ".lock";
        var sw = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                var stream = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                try
                {
                    stream.SetLength(0);
                    var stamp = Encoding.UTF8.GetBytes(
                        Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n" +
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture) + "\n");
                    stream.Write(stamp, 0, stamp.Length);
                    stream.Flush();
                }
                catch
                {
                    // The stamp is diagnostics only — holding the handle IS the lock.
                }

                return new Holder(stream);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                if (sw.ElapsedMilliseconds >= waitMs)
                {
                    throw new TimeoutException(
                        $"Another process is writing this project's code graph (lock file: {lockPath}). " +
                        "Retry after the other index/sync completes.");
                }

                Thread.Sleep(150);
            }
        }
    }

    private sealed class Holder : IDisposable
    {
        private readonly FileStream stream;
        private bool disposed;

        public Holder(FileStream stream) => this.stream = stream;

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            try
            {
                stream.Dispose();
            }
            catch
            {
                // handle close releases the OS lock even if flush fails
            }
        }
    }
}
