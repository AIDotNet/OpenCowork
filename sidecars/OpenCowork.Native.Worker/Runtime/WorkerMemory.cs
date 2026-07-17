using System.Diagnostics;
using System.Globalization;
using System.Runtime;

internal static class WorkerMemory
{
    private const long DefaultTrimThresholdBytes = 4L * 1024 * 1024;
    private const int DefaultTrimDelayMs = 2_000;
    private const int DefaultTrimCooldownMs = 5_000;
    private static readonly object Gate = new();
    private static readonly bool TrimEnabled = ReadBooleanEnvironment("OPEN_COWORK_NATIVE_MEMORY_TRIM") ?? true;
    private static readonly long TrimThresholdBytes = ReadLongEnvironment(
        "OPEN_COWORK_NATIVE_MEMORY_TRIM_THRESHOLD_BYTES",
        DefaultTrimThresholdBytes);
    private static readonly int TrimDelayMs = ReadIntEnvironment(
        "OPEN_COWORK_NATIVE_MEMORY_TRIM_DELAY_MS",
        DefaultTrimDelayMs);
    private static readonly int TrimCooldownMs = ReadIntEnvironment(
        "OPEN_COWORK_NATIVE_MEMORY_TRIM_COOLDOWN_MS",
        DefaultTrimCooldownMs);

    private static long activeOperations;
    private static long lastWorkFinishedTicks;
    private static long lastTrimTicks;
    private static long pendingPressureBytes;
    private static string pendingReason = string.Empty;
    private static Timer? trimTimer;

    public static TimeSpan HttpConnectionIdleTimeout { get; } = TimeSpan.FromMilliseconds(
        ReadIntEnvironment("OPEN_COWORK_NATIVE_HTTP_IDLE_MS", 15_000));

    public static TimeSpan HttpConnectionLifetime { get; } = TimeSpan.FromMilliseconds(
        ReadIntEnvironment("OPEN_COWORK_NATIVE_HTTP_LIFETIME_MS", 300_000));

    public static int HttpMaxConnectionsPerServer { get; } = ReadIntEnvironment(
        "OPEN_COWORK_NATIVE_HTTP_MAX_CONNECTIONS",
        16);

    public static IDisposable TrackOperation(string name)
    {
        _ = name;
        Interlocked.Increment(ref activeOperations);
        return new OperationScope();
    }

    public static void ReportCompletedWork(string reason, long pressureBytes, bool forceTrim = false)
    {
        Interlocked.Exchange(ref lastWorkFinishedTicks, Stopwatch.GetTimestamp());
        if (!TrimEnabled)
        {
            return;
        }

        if (!forceTrim && pressureBytes < TrimThresholdBytes)
        {
            return;
        }

        lock (Gate)
        {
            pendingPressureBytes = Math.Max(
                pendingPressureBytes,
                forceTrim ? Math.Max(pressureBytes, TrimThresholdBytes) : pressureBytes);
            pendingReason = string.IsNullOrWhiteSpace(reason) ? pendingReason : reason;
            ArmTimerIfIdleLocked();
        }
    }

    private static void CompleteOperation()
    {
        Interlocked.Decrement(ref activeOperations);
        Interlocked.Exchange(ref lastWorkFinishedTicks, Stopwatch.GetTimestamp());
        if (!TrimEnabled)
        {
            return;
        }

        lock (Gate)
        {
            ArmTimerIfIdleLocked();
        }
    }

    private static void ArmTimerIfIdleLocked()
    {
        if (pendingPressureBytes <= 0 || Interlocked.Read(ref activeOperations) > 0)
        {
            return;
        }

        trimTimer ??= new Timer(static _ => TrimIfIdle(), null, Timeout.Infinite, Timeout.Infinite);
        trimTimer.Change(Math.Max(100, TrimDelayMs), Timeout.Infinite);
    }

    private static void TrimIfIdle()
    {
        if (Interlocked.Read(ref activeOperations) > 0)
        {
            lock (Gate)
            {
                ArmTimerIfIdleLocked();
            }
            return;
        }

        var now = Stopwatch.GetTimestamp();
        var lastWorkFinished = Interlocked.Read(ref lastWorkFinishedTicks);
        if (lastWorkFinished > 0 &&
            Stopwatch.GetElapsedTime(lastWorkFinished, now).TotalMilliseconds < TrimDelayMs)
        {
            lock (Gate)
            {
                ArmTimerIfIdleLocked();
            }
            return;
        }

        var lastTrim = Interlocked.Read(ref lastTrimTicks);
        if (lastTrim > 0 &&
            Stopwatch.GetElapsedTime(lastTrim, now).TotalMilliseconds < TrimCooldownMs)
        {
            lock (Gate)
            {
                ArmTimerIfIdleLocked();
            }
            return;
        }

        long pressureBytes;
        string reason;
        lock (Gate)
        {
            pressureBytes = pendingPressureBytes;
            reason = pendingReason;
            pendingPressureBytes = 0;
            pendingReason = string.Empty;
        }

        if (pressureBytes <= 0)
        {
            return;
        }

        Interlocked.Exchange(ref lastTrimTicks, Stopwatch.GetTimestamp());
        RunTrim(reason, pressureBytes);
    }

    private static void RunTrim(string reason, long pressureBytes)
    {
        var before = CaptureSnapshot();
        try
        {
            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"memory trim failed reason={reason} error={ex.GetType().Name}: {ex.Message}");
            return;
        }

        var after = CaptureSnapshot();
        WorkerLog.Debug(
            $"memory trim reason={FormatValue(reason)} pressureBytes={pressureBytes} " +
            $"managedBefore={before.ManagedBytes} managedAfter={after.ManagedBytes} " +
            $"heapBefore={before.HeapBytes} heapAfter={after.HeapBytes} " +
            $"fragmentedBefore={before.FragmentedBytes} fragmentedAfter={after.FragmentedBytes} " +
            $"workingSetBefore={before.WorkingSetBytes} workingSetAfter={after.WorkingSetBytes}");
    }

    private static MemorySnapshot CaptureSnapshot()
    {
        var gcInfo = GC.GetGCMemoryInfo();
        using var process = Process.GetCurrentProcess();
        return new MemorySnapshot(
            GC.GetTotalMemory(forceFullCollection: false),
            gcInfo.HeapSizeBytes,
            gcInfo.FragmentedBytes,
            process.WorkingSet64);
    }

    private static string FormatValue(string value)
    {
        return string.IsNullOrWhiteSpace(value) ? "<unknown>" : value;
    }

    private static long ReadLongEnvironment(string name, long defaultValue)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) &&
            value > 0
                ? value
                : defaultValue;
    }

    private static int ReadIntEnvironment(string name, int defaultValue)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) &&
            value > 0
                ? value
                : defaultValue;
    }

    private static bool? ReadBooleanEnvironment(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (raw is null)
        {
            return null;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => null
        };
    }

    private readonly record struct MemorySnapshot(
        long ManagedBytes,
        long HeapBytes,
        long FragmentedBytes,
        long WorkingSetBytes);

    private sealed class OperationScope : IDisposable
    {
        private int disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0)
            {
                CompleteOperation();
            }
        }
    }
}
