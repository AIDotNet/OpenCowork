using System.Text.Json;

internal static partial class AgentRuntimeSubAgentExecutor
{
    private static async Task<AgentRuntimeSubAgentConcurrencyLease> AcquireSubAgentConcurrencyLeaseAsync(
        string subAgentName,
        string toolUseId,
        JsonElement input,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState parentState,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            parentState.CancellationToken);
        var acquisition = AgentRuntimeSubAgentConcurrencyGate.BeginAcquire(
            parameters,
            linkedCancellation.Token);

        if (acquisition.WasQueued)
        {
            await EmitSubAgentQueueEventAsync(
                parentState,
                context,
                new AgentRuntimeStreamEvent(
                    "sub_agent_queued",
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId,
                    Input: input.Clone()));
        }

        try
        {
            return await acquisition.LeaseTask;
        }
        finally
        {
            if (acquisition.WasQueued)
            {
                await EmitSubAgentQueueEventAsync(
                    parentState,
                    context,
                    new AgentRuntimeStreamEvent(
                        "sub_agent_dequeued",
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
            }
        }
    }

    private static bool YieldSubAgentConcurrencyLease(
        AgentRuntimeTools.AgentRuntimeRunState state)
    {
        var lease = state.SubAgentConcurrencyLease;
        if (lease is null)
        {
            return false;
        }

        state.SubAgentConcurrencyLease = null;
        lease.Dispose();
        return true;
    }

    private static async Task RestoreSubAgentConcurrencyLeaseAsync(
        bool leaseWasYielded,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state)
    {
        if (!leaseWasYielded || state.IsCancellationRequested || state.IsStopRequested)
        {
            return;
        }

        try
        {
            var acquisition = AgentRuntimeSubAgentConcurrencyGate.BeginAcquire(
                parameters,
                state.CancellationToken);
            var lease = await acquisition.LeaseTask;
            if (state.IsCancellationRequested || state.IsStopRequested)
            {
                lease.Dispose();
                return;
            }

            state.SubAgentConcurrencyLease = lease;
        }
        catch (OperationCanceledException)
        {
            state.RequestStop("aborted");
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"sub-agent concurrency lease restore failed runId={state.RunId} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            state.RequestStop("error");
        }
    }

    private static async Task EmitSubAgentQueueEventAsync(
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        AgentRuntimeStreamEvent item)
    {
        try
        {
            await AgentRuntimeTools.EmitAsync(state, context, item);
        }
        catch (Exception ex)
        {
            // Queue telemetry must never strand an acquired slot if the renderer transport
            // disappears while a Task is waiting or being dequeued.
            WorkerLog.Warn(
                $"sub-agent queue event delivery failed runId={state.RunId} type={item.Type} " +
                $"error={ex.GetType().Name}: {ex.Message}");
        }
    }
}

internal static class AgentRuntimeSubAgentConcurrencyGate
{
    // A slot represents one actively executing sub-agent loop. Synchronous delegation yields
    // the parent's slot before the child queues, then reacquires a slot before the parent loop
    // resumes. That preserves a strict process-wide cap without nested-delegation deadlocks.
    private const int DefaultLimit = 2;
    private const int MinimumLimit = 1;
    private const int MaximumLimit = 8;

    private static readonly object Sync = new();
    private static readonly LinkedList<Waiter> Waiters = new();
    private static int activeCount;
    private static int limit = DefaultLimit;

    public static AgentRuntimeSubAgentConcurrencyAcquisition BeginAcquire(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var requestedLimit = JsonHelpers.GetInt(parameters, "maxConcurrentSubAgents", DefaultLimit);
        var normalizedLimit = Math.Clamp(requestedLimit, MinimumLimit, MaximumLimit);

        lock (Sync)
        {
            SetLimitLocked(normalizedLimit);

            if (cancellationToken.IsCancellationRequested)
            {
                return new AgentRuntimeSubAgentConcurrencyAcquisition(
                    false,
                    Task.FromCanceled<AgentRuntimeSubAgentConcurrencyLease>(cancellationToken));
            }

            if (activeCount < limit)
            {
                activeCount++;
                return new AgentRuntimeSubAgentConcurrencyAcquisition(
                    false,
                    Task.FromResult(CreateLease()));
            }

            var waiter = new Waiter(cancellationToken);
            waiter.Node = Waiters.AddLast(waiter);
            waiter.CancellationRegistration = cancellationToken.Register(
                static state => CancelWaiter((Waiter)state!),
                waiter);
            WorkerLog.Info(
                $"sub-agent concurrency queue enter active={activeCount} limit={limit} " +
                $"waiting={Waiters.Count} holders=[{AgentRuntimeSubAgentCancellationScope.DescribeActive()}]");
            return new AgentRuntimeSubAgentConcurrencyAcquisition(true, waiter.Completion.Task);
        }
    }

    private static void SetLimitLocked(int nextLimit)
    {
        if (limit == nextLimit)
        {
            return;
        }

        var previousLimit = limit;
        limit = nextLimit;
        WorkerLog.Info(
            $"sub-agent concurrency limit changed previous={previousLimit} next={limit} " +
            $"active={activeCount} queued={Waiters.Count}");
        DrainWaitersLocked();
    }

    private static void CancelWaiter(Waiter waiter)
    {
        lock (Sync)
        {
            if (waiter.Node is null)
            {
                return;
            }

            Waiters.Remove(waiter.Node);
            waiter.Node = null;
            waiter.Completion.TrySetCanceled(waiter.CancellationToken);
        }
    }

    private static AgentRuntimeSubAgentConcurrencyLease CreateLease()
    {
        return new AgentRuntimeSubAgentConcurrencyLease(ReleaseSlot);
    }

    private static void ReleaseSlot()
    {
        lock (Sync)
        {
            activeCount = Math.Max(0, activeCount - 1);
            DrainWaitersLocked();
        }
    }

    private static void DrainWaitersLocked()
    {
        while (activeCount < limit && Waiters.First is { } first)
        {
            var waiter = first.Value;
            Waiters.Remove(first);
            waiter.Node = null;
            waiter.CancellationRegistration.Unregister();
            if (waiter.Completion.Task.IsCompleted)
            {
                continue;
            }

            activeCount++;
            waiter.Completion.TrySetResult(CreateLease());
        }
    }

    private sealed class Waiter
    {
        public Waiter(CancellationToken cancellationToken)
        {
            CancellationToken = cancellationToken;
            Completion = new TaskCompletionSource<AgentRuntimeSubAgentConcurrencyLease>(
                TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public CancellationToken CancellationToken { get; }

        public TaskCompletionSource<AgentRuntimeSubAgentConcurrencyLease> Completion { get; }

        public LinkedListNode<Waiter>? Node { get; set; }

        public CancellationTokenRegistration CancellationRegistration { get; set; }
    }
}

internal sealed record AgentRuntimeSubAgentConcurrencyAcquisition(
    bool WasQueued,
    Task<AgentRuntimeSubAgentConcurrencyLease> LeaseTask);

internal sealed class AgentRuntimeSubAgentConcurrencyLease : IDisposable
{
    private readonly Action releaseSlot;
    private int disposed;

    public AgentRuntimeSubAgentConcurrencyLease(Action releaseSlot)
    {
        this.releaseSlot = releaseSlot;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0)
        {
            releaseSlot();
        }
    }
}
