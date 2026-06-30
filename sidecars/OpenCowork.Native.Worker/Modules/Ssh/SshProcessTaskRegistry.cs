using System.Collections.Concurrent;
using System.Diagnostics;

internal static class SshProcessTaskRegistry
{
    private static readonly ConcurrentDictionary<string, NativeSshProcessTask> Running =
        new(StringComparer.Ordinal);

    public static NativeSshProcessTask Start(string taskId, CancellationToken parentToken)
    {
        var task = new NativeSshProcessTask(parentToken);
        if (!Running.TryAdd(taskId, task))
        {
            task.Dispose();
            throw new InvalidOperationException($"SSH task already exists: {taskId}");
        }

        return task;
    }

    public static void Complete(string taskId, NativeSshProcessTask task)
    {
        Running.TryRemove(new KeyValuePair<string, NativeSshProcessTask>(taskId, task));
        task.Dispose();
    }

    public static bool Abort(string taskId)
    {
        if (!Running.TryGetValue(taskId, out var task))
        {
            return false;
        }

        task.Abort();
        return true;
    }
}

internal sealed class NativeSshProcessTask : IDisposable
{
    private readonly object gate = new();
    private readonly CancellationTokenSource cancellation;
    private readonly List<Process> processes = [];
    private bool disposed;

    public NativeSshProcessTask(CancellationToken parentToken)
    {
        cancellation = CancellationTokenSource.CreateLinkedTokenSource(parentToken);
    }

    public CancellationToken Token => cancellation.Token;

    public bool IsCanceled { get; private set; }

    public void TrackProcess(Process process)
    {
        var shouldKill = false;
        lock (gate)
        {
            ThrowIfDisposed();
            processes.Add(process);
            shouldKill = IsCanceled;
        }

        if (shouldKill)
        {
            KillProcess(process);
        }
    }

    public void ThrowIfCanceled()
    {
        if (Token.IsCancellationRequested || IsCanceled)
        {
            throw new OperationCanceledException("SSH task canceled", Token);
        }
    }

    public void Abort()
    {
        Process[] runningProcesses;
        lock (gate)
        {
            if (disposed)
            {
                return;
            }

            IsCanceled = true;
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                return;
            }

            runningProcesses = processes.ToArray();
        }

        foreach (var process in runningProcesses)
        {
            KillProcess(process);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            cancellation.Dispose();
            processes.Clear();
        }
    }

    private void ThrowIfDisposed()
    {
        if (disposed)
        {
            throw new ObjectDisposedException(nameof(NativeSshProcessTask));
        }
    }

    private static void KillProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Process may exit between HasExited and Kill.
        }
    }
}
