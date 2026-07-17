using System.Globalization;
using System.Threading;

// =============================================================================
// WAL checkpoint valve — bounds WAL growth while auto-checkpointing is deferred
// during a bulk index (#1231). Full port of db/wal-valve.ts (analysis/03 §2.5),
// not the §6.7 MVP.
//
// Why deferral: SQLite's default wal_autocheckpoint (1000 pages) re-writes hot
// B-tree/FTS pages into the main DB file over and over during a bulk index —
// measured at ~95% of ALL disk I/O, and the difference between 45s and 19+
// minutes on HDD-class storage. Deferring turns the store into pure sequential
// WAL appends. IndexAll sets wal_autocheckpoint=0 for the run.
//
// Why a valve: unbounded deferral is its own failure mode — the WAL duplicates
// hot pages per COMMIT and grows far faster than the DB, filling the disk and
// poisoning every read that must page through it. The valve watches WAL growth
// on a timer and, past a soft threshold, backfills with PRAGMA
// wal_checkpoint(PASSIVE) on a SECOND connection off-thread (PASSIVE never
// blocks the writer).
//
// The load-bearing subtlety: a WAL file's SIZE never shrinks. After a full
// backfill the writer's next commit RESTARTS the WAL from the top and the frames
// recycle inside the same file — so raw size says nothing about the un-backfilled
// backlog. The valve tracks sizeAtLastFullBackfill (refreshed only when a
// checkpoint reports log == checkpointed) and triggers on GROWTH past that
// baseline.
//
// Backpressure: past a hard cap (2× soft) the writer PAUSES between transactions
// until a FULL backfill lands (one in-flight pass is not enough on a saturated
// disk — every concurrent PASSIVE pass is already stale by the time it finishes).
//
// FoldNow: a phase-boundary fold that backfills the ENTIRE WAL now (off-thread,
// awaited) — called after parsing, before resolution's first reads, so the next
// phase never pages a bulk-write-sized WAL.
//
// Threading vs. the TS original: JS's single-threaded event loop needed none of
// this to be lock-guarded; here the timer fires Check() on a threadpool thread
// while the writer calls Backpressure()/FoldNow() on the index thread, so all
// shared state (inflight/pause tasks, the baseline) is guarded by `gate`. The
// actual checkpoints run OUTSIDE the lock (Task.Run + a second connection).
// =============================================================================
internal sealed class CodeGraphWalValve
{
    // Soft WAL-growth threshold (MB) that triggers an off-thread passive checkpoint.
    private const double DefaultWalValveMb = 256;

    // Hard cap = this × soft threshold; past it the writer pauses for a full backfill.
    private const int HardCapMultiplier = 2;

    // Passes attempted per writer pause before giving up (a pinned reader could stall forever).
    private const int MaxPausedBackfillPasses = 20;

    // How often the timer looks at the WAL file size.
    private const int CheckIntervalMs = 2000;

    private readonly string dbPath;
    private readonly long softBytes;
    private readonly long hardBytes;
    private readonly int intervalMs;
    private readonly Action<string> log;
    private readonly object gate = new();

    private Timer? timer;

    // The in-flight off-thread PASSIVE checkpoint (from Check/fire), if any.
    private Task? inflight;

    // The writer pause (hard cap breached / foldNow): loops passes until a full backfill.
    private Task? pause;

    // WAL size observed when a checkpoint last reported the ENTIRE WAL backfilled.
    // Growth is measured against this baseline — see the header for why absolute
    // size cannot be used.
    private long sizeAtLastFullBackfill;

    public CodeGraphWalValve(
        string dbPath,
        double softMb = DefaultWalValveMb,
        int intervalMs = CheckIntervalMs,
        Action<string>? log = null)
    {
        this.dbPath = dbPath;
        softBytes = (long)(softMb * 1024 * 1024);
        hardBytes = softBytes * HardCapMultiplier;
        this.intervalMs = intervalMs;
        this.log = log ?? (_ => { });
    }

    // Resolve the soft threshold from the CODEGRAPH_WAL_VALVE_MB override; non-numeric
    // / non-positive values fall back to the default. ≙ resolveWalValveMb.
    public static double ResolveWalValveMb(string? envVal)
    {
        if (!string.IsNullOrEmpty(envVal)
            && double.TryParse(envVal, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
            && double.IsFinite(n)
            && n > 0)
        {
            return Math.Floor(n);
        }

        return DefaultWalValveMb;
    }

    // Begin watching the WAL. Idempotent.
    public void Start()
    {
        lock (gate)
        {
            if (timer is not null)
            {
                return;
            }

            timer = new Timer(_ => Check(), null, intervalMs, intervalMs);
        }
    }

    // Stop watching. Any in-flight checkpoint keeps running — await DrainAsync().
    public void Stop()
    {
        lock (gate)
        {
            timer?.Dispose();
            timer = null;
        }
    }

    // One poll: fire an off-thread passive checkpoint when growth passes the soft
    // threshold and nothing is already in flight. ≙ check().
    public void Check()
    {
        lock (gate)
        {
            if (!PauseActive && !InflightActive && GrowthBytesLocked() > softBytes)
            {
                FireLocked();
            }
        }
    }

    // Writer-side backstop, called at a between-transactions boundary. Returns null
    // (no wait) while growth is under the hard cap; past it, a Task that resolves only
    // once a FULL backfill has landed. ≙ backpressure().
    public Task? Backpressure()
    {
        lock (gate)
        {
            if (PauseActive)
            {
                return pause;
            }

            if (GrowthBytesLocked() <= hardBytes)
            {
                return null;
            }

            log($"backpressure: wal={Mb(CodeGraphConnectionFactory.GetWalSizeBytes(dbPath))} baseline={Mb(sizeAtLastFullBackfill)} — pausing writer for full backfill");
            pause = BackfillFullyAsync();
            return pause;
        }
    }

    // Await any in-flight checkpoint and writer pause. ≙ drain().
    public async Task DrainAsync()
    {
        while (true)
        {
            Task? p;
            Task? inf;
            lock (gate)
            {
                p = PauseActive ? pause : null;
                inf = InflightActive ? inflight : null;
            }

            if (p is null && inf is null)
            {
                return;
            }

            if (p is not null)
            {
                await AwaitQuietly(p).ConfigureAwait(false);
            }

            if (inf is not null)
            {
                await AwaitQuietly(inf).ConfigureAwait(false);
            }
        }
    }

    // Phase-boundary fold: backfill the ENTIRE WAL now (off-thread, awaited). Called
    // between bulk phases so the next phase never pages a bulk-write-sized WAL. ≙ foldNow().
    public async Task FoldNowAsync()
    {
        await DrainAsync().ConfigureAwait(false);
        if (GrowthBytes() <= 0)
        {
            return;
        }

        log($"foldNow: wal={Mb(CodeGraphConnectionFactory.GetWalSizeBytes(dbPath))} baseline={Mb(sizeAtLastFullBackfill)}");
        Task p;
        lock (gate)
        {
            pause = BackfillFullyAsync();
            p = pause;
        }

        await p.ConfigureAwait(false);
    }

    // --- internals -----------------------------------------------------------

    private bool InflightActive => inflight is { IsCompleted: false };

    private bool PauseActive => pause is { IsCompleted: false };

    private long GrowthBytes()
    {
        lock (gate)
        {
            return GrowthBytesLocked();
        }
    }

    // Un-backfilled growth estimate: bytes the WAL has grown past the last full backfill.
    private long GrowthBytesLocked() =>
        CodeGraphConnectionFactory.GetWalSizeBytes(dbPath) - sizeAtLastFullBackfill;

    // Fire one off-thread passive checkpoint (caller holds gate). A full backfill
    // (busy 0, every log frame checkpointed) advances the growth baseline so the
    // writer's next commit — which wraps the WAL — doesn't retrigger the valve. ≙ fire().
    private void FireLocked()
    {
        inflight = Task.Run(async () =>
        {
            var res = await CodeGraphConnectionFactory.CheckpointWalPassiveAsync(dbPath).ConfigureAwait(false);
            if (res is { } r && r.Busy == 0 && r.Log == r.Checkpointed)
            {
                lock (gate)
                {
                    sizeAtLastFullBackfill = CodeGraphConnectionFactory.GetWalSizeBytes(dbPath);
                }
            }
        });
    }

    // With the writer parked on the returned Task, loop passive passes until one
    // reports the entire WAL backfilled (typically the second: the first drains the
    // pass that was already running against a stale snapshot). Bounded — a pinned
    // reader must not wedge the writer forever. ≙ backfillFully().
    private async Task BackfillFullyAsync()
    {
        for (var i = 0; i < MaxPausedBackfillPasses; i++)
        {
            Task? snapshot;
            lock (gate)
            {
                snapshot = InflightActive ? inflight : null;
            }

            if (snapshot is not null)
            {
                await AwaitQuietly(snapshot).ConfigureAwait(false); // fold in the stale in-flight pass first
            }

            var res = await CodeGraphConnectionFactory.CheckpointWalPassiveAsync(dbPath).ConfigureAwait(false);
            if (res is not { } r)
            {
                return; // checkpoint machinery unavailable — don't spin
            }

            log($"backfill pass {i + 1}: busy={r.Busy} log={r.Log} checkpointed={r.Checkpointed} wal={Mb(CodeGraphConnectionFactory.GetWalSizeBytes(dbPath))}");
            if (r.Busy == 0 && r.Log == r.Checkpointed)
            {
                lock (gate)
                {
                    sizeAtLastFullBackfill = CodeGraphConnectionFactory.GetWalSizeBytes(dbPath);
                }

                return;
            }
        }

        log($"backfill gave up after {MaxPausedBackfillPasses} passes — WAL stays unbounded this cycle");
    }

    private static async Task AwaitQuietly(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch
        {
            // best-effort: a checkpoint failure never propagates through the valve
        }
    }

    private static string Mb(long n) =>
        (n / 1024 / 1024).ToString(CultureInfo.InvariantCulture) + "MB";
}

// SQLite's `PRAGMA wal_checkpoint` result row. busy==0 && log==checkpointed means
// the entire WAL was backfilled. In non-WAL mode SQLite reports log = checkpointed
// = -1 (harmless — the equality holds but the writer never wraps).
internal readonly record struct CodeGraphWalCheckpointResult(int Busy, int Log, int Checkpointed);
