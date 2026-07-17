using System.Collections.Concurrent;

/// <summary>
/// Process-wide registry of every live sub-agent run (synchronous Task children,
/// standalone background sub-agents, and team teammates). Each run registers a scope
/// keyed by its Task tool_use id so the renderer can cancel it individually via the
/// agent/cancel-subagent RPC — background children are not in ActiveRuns, so without
/// this they are unreachable and a hung one pins a global concurrency slot forever.
/// </summary>
internal sealed class AgentRuntimeSubAgentCancellationScope : IDisposable
{
    private static readonly ConcurrentDictionary<string, AgentRuntimeSubAgentCancellationScope> Scopes =
        new(StringComparer.Ordinal);

    private readonly CancellationTokenSource cancellation = new();
    private readonly string key;
    private CancellationTokenRegistration runStateRegistration;
    private int disposed;

    private AgentRuntimeSubAgentCancellationScope(string key, string toolUseId, string sessionId, string kind)
    {
        this.key = key;
        ToolUseId = toolUseId;
        SessionId = sessionId;
        Kind = kind;
    }

    public string ToolUseId { get; }

    public string SessionId { get; }

    public string Kind { get; }

    /// <summary>Fires when this sub-agent run is cancelled through the registry.</summary>
    public CancellationToken Token => cancellation.Token;

    public static AgentRuntimeSubAgentCancellationScope Register(
        string toolUseId,
        string sessionId,
        string kind)
    {
        var normalizedToolUseId = toolUseId.Trim();
        var scope = new AgentRuntimeSubAgentCancellationScope(
            $"{normalizedToolUseId}:{Guid.NewGuid():N}",
            normalizedToolUseId,
            sessionId.Trim(),
            kind);
        Scopes[scope.key] = scope;
        return scope;
    }

    /// <summary>
    /// Route registry cancellation into the child run's own state once it exists.
    /// Before this point a cancel still aborts the run because the scope token is
    /// linked into the concurrency-gate acquire wait.
    /// </summary>
    public void AttachRunState(AgentRuntimeTools.AgentRuntimeRunState state)
    {
        runStateRegistration = cancellation.Token.Register(
            static s => ((AgentRuntimeTools.AgentRuntimeRunState)s!).Cancel("user"),
            state);
    }

    public static int Cancel(string? toolUseId, string? sessionId, string reason)
    {
        var normalizedToolUseId = toolUseId?.Trim();
        var normalizedSessionId = sessionId?.Trim();
        if (string.IsNullOrEmpty(normalizedToolUseId) && string.IsNullOrEmpty(normalizedSessionId))
        {
            return 0;
        }

        var count = 0;
        foreach (var scope in Scopes.Values)
        {
            if (!string.IsNullOrEmpty(normalizedToolUseId) &&
                !string.Equals(scope.ToolUseId, normalizedToolUseId, StringComparison.Ordinal))
            {
                continue;
            }

            if (!string.IsNullOrEmpty(normalizedSessionId) &&
                !string.Equals(scope.SessionId, normalizedSessionId, StringComparison.Ordinal))
            {
                continue;
            }

            scope.CancelSelf(reason);
            count++;
        }

        return count;
    }

    public static int CancelAll(string reason)
    {
        var count = 0;
        foreach (var scope in Scopes.Values)
        {
            scope.CancelSelf(reason);
            count++;
        }

        return count;
    }

    public static string DescribeActive()
    {
        var scopes = Scopes.Values.ToArray();
        return scopes.Length == 0
            ? "<none>"
            : string.Join(", ", scopes.Select(scope => $"{scope.Kind}:{scope.ToolUseId}"));
    }

    private void CancelSelf(string reason)
    {
        if (Volatile.Read(ref disposed) != 0)
        {
            return;
        }

        try
        {
            cancellation.Cancel();
            WorkerLog.Info(
                $"sub-agent cancel signalled toolUseId={ToolUseId} kind={Kind} reason={reason}");
        }
        catch (ObjectDisposedException)
        {
            // Raced with Dispose — the run already finished.
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        Scopes.TryRemove(key, out _);
        runStateRegistration.Dispose();
        cancellation.Dispose();
    }
}
