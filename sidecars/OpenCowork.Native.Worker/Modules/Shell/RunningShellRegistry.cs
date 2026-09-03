using System.Collections.Concurrent;
using System.Diagnostics;

internal static class RunningShellRegistry
{
    private static readonly ConcurrentDictionary<string, TrackedShellProcess> Running = new(StringComparer.Ordinal);

    public static TrackedShellProcess Track(string execId, Process process)
    {
        var tracked = new TrackedShellProcess(process);
        Running[execId] = tracked;
        return tracked;
    }

    public static void Untrack(string execId)
    {
        if (string.IsNullOrEmpty(execId))
        {
            return;
        }

        Running.TryRemove(execId, out _);
    }

    public static bool TryAbort(string execId, string reason)
    {
        if (!Running.TryGetValue(execId, out var tracked))
        {
            return false;
        }

        tracked.Abort(reason);
        return true;
    }
}

internal sealed class TrackedShellProcess
{
    private readonly Process process;

    public TrackedShellProcess(Process process)
    {
        this.process = process;
    }

    public string? AbortReason { get; private set; }

    public void Abort(string reason)
    {
        AbortReason ??= reason;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // The process may have exited between the check and Kill().
        }
    }
}
