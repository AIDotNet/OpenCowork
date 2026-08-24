using System.Buffers;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

internal static class RuntimeJobCoordinator
{
    private static readonly TimeSpan ScanInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan LeaseRenewInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan EventRetention = TimeSpan.FromHours(24);
    // The tool-result journal only has to survive "crash, restart, continue". Keeping
    // it longer than a few days would accumulate the full tool output of every run for
    // rows that are dead weight the moment the tool_result reaches the messages table.
    private static readonly TimeSpan ToolResultRetention = TimeSpan.FromDays(3);
    private static readonly TimeSpan MaintenanceInterval = TimeSpan.FromHours(1);
    private static readonly TimeSpan HostedSessionRetention = TimeSpan.FromDays(14);
    private const int HostedSessionMaxRows = 256;
    private static readonly int MaxConcurrentJobs = Math.Clamp(Environment.ProcessorCount, 4, 12);

    /// <summary>
    /// How many batches a consumer may fall behind before its cursor is written
    /// back to SQLite.
    ///
    /// The cursor used to be persisted once per batch, driven by an acknowledgement
    /// RPC from the consumer — thousands of round trips for a single run. Delivery
    /// no longer needs confirming: a consumer that misses frames resubscribes with
    /// the sequence it reached. The cursor only has to be durable enough that a
    /// worker restart does not replay an entire run.
    /// </summary>
    private const int CursorCheckpointBatches = 32;
    private static readonly SemaphoreSlim MediaSlots = new(4, 4);
    private static readonly SemaphoreSlim EventPumpGate = new(1, 1);
    private static readonly string WorkerInstanceId = Guid.NewGuid().ToString("N");
    private static readonly object Sync = new();
    private static readonly object EventSync = new();
    private static readonly HashSet<string> ActiveLanes = new(StringComparer.Ordinal);

    /// <summary>
    /// Durable event consumers, keyed by consumer id. There is more than one because
    /// each window subscribes to the worker directly while the host keeps its own
    /// subscription for background and scheduled runs. Each needs an independent
    /// cursor; sharing one would let a window's progress discard frames the host had
    /// not received.
    /// </summary>
    private static readonly Dictionary<string, EventConsumer> EventConsumers =
        new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, CancellationTokenSource> ActiveJobs =
        new(StringComparer.Ordinal);
    private static readonly Channel<bool> WakeChannel = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1024)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropWrite,
            AllowSynchronousContinuations = false
        });
    private static readonly CancellationTokenSource Lifetime = new();

    private static string? hostId;
    private static WorkerDispatcher? dispatcher;
    private static Task? schedulerTask;
    private static int activeCount;

    public static string HostId => hostId ?? throw new InvalidOperationException(
        "Runtime Job host has not been configured.");

    /// <summary>
    /// Durable jobs and events are scoped by host id alone; the transport's own
    /// addressing is not part of that identity.
    /// </summary>
    public static void Configure(string workerHostId)
    {
        hostId = workerHostId;
    }

    public static void BindDispatcher(WorkerDispatcher workerDispatcher)
    {
        dispatcher = workerDispatcher;
    }

    public static RuntimeJobSubmission Submit(
        string method,
        JsonElement parameters,
        string? requestedJobId = null,
        string? idempotencyKey = null,
        string? explicitLaneKey = null)
    {
        EnsureStarted();
        var currentDispatcher = dispatcher
            ?? throw new InvalidOperationException("Runtime Job dispatcher is unavailable.");
        if (!currentDispatcher.TryGetJobDescriptor(method, out _))
        {
            throw new InvalidOperationException($"Method is not registered as a background Job: {method}");
        }

        var sessionId = ReadString(parameters, "sessionId");
        var runId = ReadString(parameters, "runId");
        var assistantMessageId = ReadString(parameters, "assistantMessageId");
        if (string.Equals(method, "agent/session-send", StringComparison.Ordinal) &&
            !AgentRuntimeSessionHost.EnsureOpen(sessionId))
        {
            throw new RuntimeJobRejectedException(
                "session_evicted",
                $"agent session is not open: {sessionId ?? "(missing sessionId)"}");
        }
        var requestedId = NormalizeIdentifier(requestedJobId);
        string jobId;
        var storedParameters = parameters;
        if (string.Equals(method, "agent/run", StringComparison.Ordinal) ||
            string.Equals(method, "agent/session-send", StringComparison.Ordinal))
        {
            runId ??= AgentRuntimeIdentities.NewRunId();
            assistantMessageId ??= AgentRuntimeIdentities.AssistantMessageIdForRun(runId);
            if (requestedId is not null && !string.Equals(requestedId, runId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{method} requires jobId to match params.runId.");
            }
            jobId = runId;
            storedParameters = WithAgentJobIdentities(parameters, runId, assistantMessageId);
        }
        else if (string.Equals(method, "agent/compress-context", StringComparison.Ordinal))
        {
            // Stream events persist against jobId. Keep jobId == runId so the
            // summarizer can publish context_compression_* frames on this Job.
            runId ??= requestedId ?? AgentRuntimeIdentities.NewRunId();
            if (requestedId is not null && !string.Equals(requestedId, runId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{method} requires jobId to match params.runId.");
            }
            jobId = runId;
            storedParameters = WithCompressionJobIdentities(parameters, runId);
        }
        else
        {
            jobId = requestedId ?? Guid.NewGuid().ToString("N");
        }
        var key = NormalizeIdentifier(idempotencyKey) ?? jobId;
        var resolvedLaneKey = ResolveLaneKey(storedParameters, sessionId, jobId);
        var laneKey = sessionId is not null
            ? resolvedLaneKey
            : NormalizeIdentifier(explicitLaneKey) ?? resolvedLaneKey;
        var submission = RuntimeJobStore.Submit(
            jobId,
            HostId,
            key,
            method,
            storedParameters.ValueKind == JsonValueKind.Undefined ? "{}" : storedParameters.GetRawText(),
            sessionId,
            runId,
            laneKey,
            Now());
        Wake();
        return new RuntimeJobSubmission(
            submission.Accepted,
            submission.Duplicate,
            submission.Job,
            assistantMessageId);
    }

    public static RuntimeJobRecord? Get(string jobId)
    {
        EnsureStarted();
        return RuntimeJobStore.Get(HostId, jobId);
    }

    public static List<RuntimeJobRecord> List(int limit, string? state)
    {
        EnsureStarted();
        return RuntimeJobStore.List(HostId, limit, NormalizeIdentifier(state));
    }

    public static string? Cancel(string jobId)
    {
        EnsureStarted();
        var state = RuntimeJobStore.RequestCancellation(HostId, jobId, Now());
        if (state == "cancelling" && ActiveJobs.TryGetValue(jobId, out var cancellation))
        {
            cancellation.Cancel();
        }
        Wake();
        return state;
    }

    public static long AppendCommand(string jobId, string kind, JsonElement payload)
    {
        EnsureStarted();
        var job = RuntimeJobStore.Get(HostId, jobId)
            ?? throw new InvalidOperationException($"Unknown Job: {jobId}");
        if (job.State is "succeeded" or "failed" or "cancelled")
        {
            throw new InvalidOperationException($"Job is already terminal: {jobId}");
        }
        var seq = RuntimeJobStore.AppendCommand(
            jobId,
            kind,
            payload.ValueKind == JsonValueKind.Undefined ? "{}" : payload.GetRawText(),
            Now());
        Wake();
        return seq;
    }

    public static List<RuntimeJobCommand> ReadPendingCommands(string jobId)
    {
        return RuntimeJobStore.ReadPendingCommands(jobId);
    }

    public static bool TryConsumeCommand(long commandId)
    {
        return RuntimeJobStore.TryConsumeCommand(commandId, Now());
    }

    public static bool TryConsumeCommand(string jobId, long seq)
    {
        return RuntimeJobStore.TryConsumeCommand(jobId, seq, Now());
    }

    public static void PersistEvent(
        string jobId,
        long seq,
        ReadOnlyMemory<byte> payload,
        bool terminal)
    {
        RuntimeJobStore.AppendEvent(jobId, seq, payload, terminal, Now());
        Wake();
    }

    /// <summary>
    /// Journals a finished tool call. Unlike <see cref="PersistEvent"/> this needs no
    /// scheduler wake — nothing consumes the journal as a stream; it is read on demand
    /// when a tool_use has to be reconciled with a result that never got persisted.
    /// </summary>
    public static void PersistToolResult(
        string sessionId,
        string toolUseId,
        string runId,
        string toolName,
        string status,
        string contentJson,
        bool isError,
        long? startedAt,
        long? completedAt)
    {
        RuntimeJobStore.UpsertToolResult(
            sessionId,
            toolUseId,
            runId,
            toolName,
            status,
            contentJson,
            isError,
            startedAt,
            completedAt ?? Now());
    }

    /// <summary>
    /// Records how far a consumer has read, so a restart resumes there.
    /// </summary>
    /// <remarks>
    /// This is a checkpoint, not an acknowledgement: nothing is held back waiting
    /// for it, and a consumer that never calls it only risks re-reading events it
    /// already saw. Callers resubscribe with their own sequence when they reconnect.
    /// </remarks>
    public static void Checkpoint(string consumerId, string jobId, long throughSeq)
    {
        RuntimeJobStore.Ack(consumerId, jobId, throughSeq, Now());
    }

    public static async Task<int> ReplayAsync(
        string consumerId,
        string? jobId,
        long? sinceSeq,
        int limit,
        CancellationToken cancellationToken,
        bool fromLatest = false)
    {
        if (fromLatest)
        {
            RuntimeJobStore.SeedCursorsToLatest(HostId, consumerId, Now());
        }
        lock (EventSync)
        {
            if (!EventConsumers.TryGetValue(consumerId, out var consumer))
            {
                consumer = new EventConsumer();
                EventConsumers.Add(consumerId, consumer);
            }
            consumer.ReplayJobId = NormalizeIdentifier(jobId);
            consumer.ReplaySinceSeq = sinceSeq;
            consumer.ReplayLimit = Math.Clamp(limit, 1, 4096);
            // Subscribing is how a consumer states where it is. Clearing what we
            // believe it already has is what makes a reconnect resume rather than
            // silently skip the events it missed while it was away.
            consumer.PublishedThrough.Clear();
            consumer.SinceCheckpoint = 0;
        }
        EnsureStarted();
        var published = await PumpDurableEventsAsync(cancellationToken);
        Wake();
        return published;
    }

    private static void EnsureStarted()
    {
        if (schedulerTask is not null)
        {
            return;
        }

        lock (Sync)
        {
            if (schedulerTask is not null)
            {
                return;
            }
            if (hostId is null || dispatcher is null)
            {
                return;
            }

            var now = Now();
            RuntimeJobStore.AcquireLease(
                hostId,
                WorkerInstanceId,
                now,
                now + (long)LeaseDuration.TotalMilliseconds);
            var interrupted = RuntimeJobStore.FailInterruptedJobs(hostId, now);
            if (interrupted > 0)
            {
                WorkerLog.Warn(
                    $"runtime jobs marked interrupted hostId={hostId} count={interrupted}");
            }
            RuntimeJobStore.CleanupEvents(now - (long)EventRetention.TotalMilliseconds);
            RuntimeJobStore.CleanupToolResults(now - (long)ToolResultRetention.TotalMilliseconds);
            RuntimeJobStore.CleanupHostedSessions(
                now - (long)HostedSessionRetention.TotalMilliseconds,
                HostedSessionMaxRows);
            schedulerTask = Task.Run(() => SchedulerLoopAsync(Lifetime.Token), CancellationToken.None);
        }
    }

    private static async Task SchedulerLoopAsync(CancellationToken cancellationToken)
    {
        var nextLeaseRenewal = 0L;
        var nextMaintenance = Now() + (long)MaintenanceInterval.TotalMilliseconds;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var now = Now();
                if (now >= nextLeaseRenewal)
                {
                    RuntimeJobStore.RenewLease(
                        HostId,
                        WorkerInstanceId,
                        now,
                        now + (long)LeaseDuration.TotalMilliseconds);
                    nextLeaseRenewal = now + (long)LeaseRenewInterval.TotalMilliseconds;
                }

                if (now >= nextMaintenance)
                {
                    RuntimeJobStore.CleanupEvents(
                        now - (long)EventRetention.TotalMilliseconds);
                    RuntimeJobStore.CleanupToolResults(
                        now - (long)ToolResultRetention.TotalMilliseconds);
                    nextMaintenance = now + (long)MaintenanceInterval.TotalMilliseconds;
                }

                await PumpDurableEventsAsync(cancellationToken);
                var launched = LaunchAvailableJobs();
                if (launched)
                {
                    continue;
                }

                using var scanDelay = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                scanDelay.CancelAfter(ScanInterval);
                try
                {
                    await WakeChannel.Reader.ReadAsync(scanDelay.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // Periodic SQLite scan guarantees discovery when the bounded wake queue drops.
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"runtime job scheduler iteration failed error={ex.GetType().Name}: {ex.Message}");
                await Task.Delay(ScanInterval, cancellationToken);
            }
        }
    }

    /// <summary>
    /// Pumps the durable outbox for every subscribed consumer, independently, so a
    /// consumer that has stopped reading affects only its own delivery.
    /// </summary>
    private static async Task<int> PumpDurableEventsAsync(CancellationToken cancellationToken)
    {
        await EventPumpGate.WaitAsync(cancellationToken);
        try
        {
            KeyValuePair<string, EventConsumer>[] consumers;
            lock (EventSync)
            {
                consumers = [.. EventConsumers];
            }

            var published = 0;
            foreach (var (consumerId, consumer) in consumers)
            {
                cancellationToken.ThrowIfCancellationRequested();
                published += PumpConsumer(consumerId, consumer, cancellationToken);
            }
            return published;
        }
        finally
        {
            EventPumpGate.Release();
        }
    }

    private static int PumpConsumer(
        string consumerId,
        EventConsumer consumer,
        CancellationToken cancellationToken)
    {
        string? replayJobId;
        long? replaySinceSeq;
        int replayLimit;
        lock (EventSync)
        {
            replayJobId = consumer.ReplayJobId;
            replaySinceSeq = consumer.ReplaySinceSeq;
            replayLimit = consumer.ReplayLimit;
        }

        var batches = RuntimeJobStore.Replay(
            HostId,
            consumerId,
            replayJobId,
            replaySinceSeq,
            replayLimit);
        var published = 0;
        foreach (var batch in batches)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (EventSync)
            {
                if (!EventConsumers.TryGetValue(consumerId, out var current) ||
                    !ReferenceEquals(current, consumer))
                {
                    break;
                }
                // Nothing gates on delivery being confirmed; this only stops the
                // pump from re-sending what it already put on this consumer's lane
                // before its cursor was checkpointed.
                if (consumer.PublishedThrough.TryGetValue(batch.JobId, out var sent) &&
                    batch.Seq <= sent)
                {
                    continue;
                }
            }

            if (!WorkerEventRouter.TryPublishToConsumer(
                consumerId,
                new WorkerMessagePackEvent("agent/stream", batch.Payload)))
            {
                // The lane is saturated or detached. Leaving the cursor where it is
                // means the consumer picks these up when it resubscribes.
                break;
            }

            long checkpointSeq = 0;
            var shouldCheckpoint = false;
            lock (EventSync)
            {
                consumer.PublishedThrough[batch.JobId] = batch.Seq;
                consumer.SinceCheckpoint += 1;
                if (consumer.SinceCheckpoint >= CursorCheckpointBatches || batch.Terminal)
                {
                    consumer.SinceCheckpoint = 0;
                    checkpointSeq = batch.Seq;
                    shouldCheckpoint = true;
                }
            }
            if (shouldCheckpoint)
            {
                Checkpoint(consumerId, batch.JobId, checkpointSeq);
            }
            published++;
        }
        return published;
    }

    private sealed class EventConsumer
    {
        public string? ReplayJobId;
        public long? ReplaySinceSeq;
        public int ReplayLimit = 4096;

        /// <summary>Batches published since this consumer's cursor was last written.</summary>
        public int SinceCheckpoint;

        /// <summary>
        /// Highest sequence already placed on this consumer's lane, per job. Purely
        /// an in-memory de-duplicator between cursor checkpoints; it is not a record
        /// of what the consumer received.
        /// </summary>
        public readonly Dictionary<string, long> PublishedThrough = new(StringComparer.Ordinal);
    }

    private static bool LaunchAvailableJobs()
    {
        lock (Sync)
        {
            if (activeCount >= MaxConcurrentJobs)
            {
                return false;
            }
        }

        var launched = false;
        foreach (var job in RuntimeJobStore.ReadQueued(HostId, 128))
        {
            lock (Sync)
            {
                if (activeCount >= MaxConcurrentJobs)
                {
                    break;
                }
                if (!ActiveLanes.Add(job.LaneKey))
                {
                    continue;
                }
                activeCount++;
            }

            if (!RuntimeJobStore.TryClaim(HostId, job.JobId, WorkerInstanceId, Now()))
            {
                ReleaseLane(job.LaneKey);
                continue;
            }

            launched = true;
            _ = Task.Run(() => ExecuteJobAsync(job), CancellationToken.None);
        }
        return launched;
    }

    private static async Task ExecuteJobAsync(RuntimeJobRecord job)
    {
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(Lifetime.Token);
        var mediaSlotAcquired = false;
        if (!ActiveJobs.TryAdd(job.JobId, cancellation))
        {
            RuntimeJobStore.Finish(
                HostId,
                job.JobId,
                "failed",
                null,
                "duplicate_execution",
                "The Job was claimed more than once in this worker instance.",
                Now());
            ReleaseLane(job.LaneKey);
            return;
        }

        try
        {
            // Cancellation can commit after TryClaim changes queued -> running but before
            // this Job is visible in ActiveJobs. Close that registration window by
            // reconciling the durable state once the cancellation source is installed.
            if (RuntimeJobStore.Get(HostId, job.JobId)?.State == "cancelling")
            {
                cancellation.Cancel();
            }

            if (IsMediaJob(job.Method))
            {
                await MediaSlots.WaitAsync(cancellation.Token);
                mediaSlotAcquired = true;
            }
            using var parameters = JsonDocument.Parse(job.ParamsJson);
            var context = WorkerTransportHub.CreateBackgroundContext(cancellation.Token);
            var response = await (dispatcher
                ?? throw new InvalidOperationException("Runtime Job dispatcher is unavailable."))
                .DispatchJobAsync(job.Method, parameters.RootElement, context);
            var resultJson = System.Text.Encoding.UTF8.GetString(response.ToResultJsonBytes());
            var cancelled = cancellation.IsCancellationRequested ||
                RuntimeJobStore.Get(HostId, job.JobId)?.State == "cancelling";
            RuntimeJobStore.Finish(
                HostId,
                job.JobId,
                cancelled ? "cancelled" : "succeeded",
                cancelled ? null : resultJson,
                cancelled ? "cancelled" : null,
                cancelled ? "Job cancelled by the client." : null,
                Now());
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            RuntimeJobStore.Finish(
                HostId,
                job.JobId,
                "cancelled",
                null,
                "cancelled",
                "Job cancelled by the client.",
                Now());
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"runtime job failed jobId={job.JobId} method={job.Method} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            RuntimeJobStore.Finish(
                HostId,
                job.JobId,
                "failed",
                null,
                ResolveErrorCode(ex),
                ex.Message,
                Now());
        }
        finally
        {
            if (mediaSlotAcquired)
            {
                MediaSlots.Release();
            }
            ActiveJobs.TryRemove(job.JobId, out _);
            ReleaseLane(job.LaneKey);
            Wake();
        }
    }

    private static void ReleaseLane(string laneKey)
    {
        lock (Sync)
        {
            ActiveLanes.Remove(laneKey);
            activeCount = Math.Max(0, activeCount - 1);
        }
    }

    private static void Wake()
    {
        WakeChannel.Writer.TryWrite(true);
    }

    private static string ResolveLaneKey(
        JsonElement parameters,
        string? sessionId,
        string jobId)
    {
        if (!string.IsNullOrEmpty(sessionId))
        {
            return $"session:{sessionId}";
        }

        foreach (var propertyName in new[] { "projectPath", "workingFolder", "cwd" })
        {
            var value = ReadString(parameters, propertyName);
            if (string.IsNullOrEmpty(value))
            {
                continue;
            }
            try
            {
                return $"project:{Path.GetFullPath(value)}";
            }
            catch
            {
                return $"project:{value}";
            }
        }

        return $"job:{jobId}";
    }

    private static string ResolveErrorCode(Exception exception)
    {
        return exception switch
        {
            TimeoutException => "timeout",
            IOException => "io_error",
            _ => exception.GetType().Name
        };
    }

    private static bool IsMediaJob(string method)
    {
        return method.StartsWith("openai-images/", StringComparison.Ordinal) ||
            method.StartsWith("openai-audio/", StringComparison.Ordinal) ||
            method.StartsWith("openai-video/", StringComparison.Ordinal) ||
            method.StartsWith("seedance-video/", StringComparison.Ordinal) ||
            method.StartsWith("xai-video/", StringComparison.Ordinal) ||
            method.StartsWith("media/", StringComparison.Ordinal);
    }

    private static JsonElement WithCompressionJobIdentities(JsonElement parameters, string runId)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            if (parameters.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in parameters.EnumerateObject())
                {
                    if (property.NameEquals("runId"))
                    {
                        continue;
                    }
                    property.WriteTo(writer);
                }
            }
            writer.WriteString("runId", runId);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static JsonElement WithAgentJobIdentities(
        JsonElement parameters,
        string runId,
        string assistantMessageId)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            if (parameters.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in parameters.EnumerateObject())
                {
                    if (property.NameEquals("runId") || property.NameEquals("assistantMessageId"))
                    {
                        continue;
                    }
                    property.WriteTo(writer);
                }
            }
            writer.WriteString("runId", runId);
            writer.WriteString("assistantMessageId", assistantMessageId);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static string? ReadString(JsonElement parameters, string propertyName)
    {
        return NormalizeIdentifier(JsonHelpers.GetString(parameters, propertyName));
    }

    private static string? NormalizeIdentifier(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
