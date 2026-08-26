using System.Collections.Concurrent;
using System.Linq;
using System.Text.Json;
using OpenCowork.Contracts.Generated;

internal static class AgentRuntimeTools
{
    private const int StreamProtocolVersion =
        OpenCowork.Contracts.Generated.WorkerContractConstants.AgentStreamProtocolVersion;
    private const int RuntimeProtocolVersion = 2;
    private const string CoreManifestHash =
        "cba1df437a6c37e73b0c151ebbcfb1045ebef6a232652f52a077ecaf7eab778a";
    private const int MaxConcurrentRuns = 8;
    private static readonly string WorkerInstanceId = Guid.NewGuid().ToString("N");
    private static readonly ConcurrentDictionary<string, AgentRuntimeRunState> ActiveRuns = new(StringComparer.Ordinal);
    private static readonly SemaphoreSlim RunSlots = new(MaxConcurrentRuns, MaxConcurrentRuns);
    private static long generatedRunId;

    public static WorkerResponse Initialize(JsonElement parameters)
    {
        _ = parameters;
        WorkerLog.Info("agent runtime initialized runtime=native-aot");
        return WorkerResponse.Json(
            CreateInitializeResult(),
            AgentRuntimeContractsJsonContext.Default.WorkerInitializeResult);
    }

    public static WorkerResponse Ping(JsonElement parameters)
    {
        _ = parameters;
        return WorkerResponse.Json(
            new StatusResult(true, Environment.ProcessId),
            WorkerJsonContext.Default.StatusResult);
    }

    public static WorkerResponse Shutdown(JsonElement parameters)
    {
        _ = parameters;
        foreach (var run in ActiveRuns.Values)
        {
            run.Cancel("shutdown");
        }
        ActiveRuns.Clear();
        AgentRuntimeSessionHost.Clear();
        // Background sub-agent/team children are not in ActiveRuns; cancel them through
        // the sub-agent registry so their global concurrency slots drain on shutdown.
        AgentRuntimeSubAgentCancellationScope.CancelAll("shutdown");
        WorkerLog.Info("agent runtime shutdown");
        return WorkerResponse.Json(
            CreateInitializeResult(),
            AgentRuntimeContractsJsonContext.Default.WorkerInitializeResult);
    }

    public static WorkerResponse CheckCapability(JsonElement parameters)
    {
        var capability = JsonHelpers.GetString(parameters, "capability") ?? string.Empty;
        var supported = capability is
            "agent.run" or
            "agent.session-host" or
            "desktop.input" or
            "provider.openai-chat" or
            "provider.openai-responses" or
            "provider.openai-images" or
            "provider.anthropic" or
            "provider.gemini-interactions" or
            "provider.vertex-ai" or
            "agent.stream.msgpack" or
            "sidecar.reverse.msgpack" or
            "db.messages.msgpack" or
            "tool.Task" or
            "tool.Todo" or
            "tool.Fs" or
            "tool.Search" or
            "tool.Skill" or
            "tool.Widget" or
            "tool.Goal" or
            "tool.Memory" or
            "tool.CodeCompatible" or
            "tool.Notify" or
            "tool.Cron" or
            "tool.AskUser" or
            "tool.Plan" or
            "tool.Translation" or
            "tool.Plugin" or
            "tool.Team" or
            "tool.ChannelPlugin" or
            "tool.ImageGenerate" or
            "tool.Desktop" or
            "tool.Browser" or
            "tool.Mcp" or
            "tool.Extension" or
            "tool.WebSearch" or
            "tool.WebFetch";
        return WorkerResponse.Json(
            new AgentRuntimeCapabilityResult(supported),
            WorkerJsonContext.Default.AgentRuntimeCapabilityResult);
    }

    public static async Task<WorkerResponse> ExecuteJobAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        await RunSlots.WaitAsync(context.CancellationToken);

        var runId = NormalizeRunId(JsonHelpers.GetString(parameters, "runId"));
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim() ?? string.Empty;
        var assistantMessageId = JsonHelpers.GetString(parameters, "assistantMessageId")?.Trim();
        if (string.IsNullOrEmpty(assistantMessageId))
        {
            assistantMessageId = AgentRuntimeIdentities.AssistantMessageIdForRun(runId);
        }
        var initialMessageCount = CountArray(parameters, "messages");
        var state = new AgentRuntimeRunState(runId, sessionId, context.CancellationToken);
        state.AssistantMessageId = assistantMessageId;
        try
        {
            state.ReplaceParameters(parameters.Clone());
        }
        catch
        {
            RunSlots.Release();
            state.Dispose();
            throw;
        }

        if (!ActiveRuns.TryAdd(runId, state))
        {
            RunSlots.Release();
            state.Dispose();
            throw new InvalidOperationException($"Agent run already exists: {runId}");
        }

        WorkerLog.Info(
            $"agent run accepted runtime=native-aot runId={runId} sessionId={FormatLogValue(sessionId)} " +
            $"messages={initialMessageCount}");

        await ExecuteRunAsync(state, context);
        return WorkerResponse.Json(
            new AgentRuntimeRunResult(true, runId, state.AssistantMessageId),
            WorkerJsonContext.Default.AgentRuntimeRunResult);
    }

    public static WorkerResponse Cancel(JsonElement parameters)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            return WorkerResponse.Json(
                new CancelRunResult(false, null),
                AgentRuntimeContractsJsonContext.Default.CancelRunResult);
        }

        var durableState = RuntimeJobCoordinator.Cancel(runId);
        if (!ActiveRuns.TryGetValue(runId, out var state))
        {
            return WorkerResponse.Json(
                new CancelRunResult(
                    durableState is "cancelled" or "cancelling",
                    runId),
                AgentRuntimeContractsJsonContext.Default.CancelRunResult);
        }

        state.Cancel("user");
        WorkerLog.Info($"agent run cancel requested runId={runId}");
        return WorkerResponse.Json(
            new CancelRunResult(true, runId),
            AgentRuntimeContractsJsonContext.Default.CancelRunResult);
    }

    public static WorkerResponse RequestStop(JsonElement parameters)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            return WorkerResponse.Json(
                new RequestStopRunResult(false, null),
                AgentRuntimeContractsJsonContext.Default.RequestStopRunResult);
        }

        long? commandSeq = null;
        try
        {
            commandSeq = RuntimeJobCoordinator.AppendCommand(runId, "request_stop", parameters);
        }
        catch (InvalidOperationException)
        {
            // Preserve the historical false result for unknown or terminal runs.
        }

        if (!ActiveRuns.TryGetValue(runId, out var state))
        {
            var queued = RuntimeJobCoordinator.Get(runId)?.State == "queued";
            return WorkerResponse.Json(
                new RequestStopRunResult(queued, runId),
                AgentRuntimeContractsJsonContext.Default.RequestStopRunResult);
        }

        // The startup path and this live path can observe the same command while
        // a Job transitions queued -> running. Claim before applying so exactly
        // one of them mutates the run state.
        if (!commandSeq.HasValue || RuntimeJobCoordinator.TryConsumeCommand(runId, commandSeq.Value))
        {
            state.RequestStop("user");
        }
        WorkerLog.Info($"agent run stop requested runId={runId}");
        return WorkerResponse.Json(
            new RequestStopRunResult(true, runId),
            AgentRuntimeContractsJsonContext.Default.RequestStopRunResult);
    }

    public static WorkerResponse CancelSubAgent(JsonElement parameters)
    {
        var toolUseId = JsonHelpers.GetString(parameters, "toolUseId")?.Trim();
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        var count = AgentRuntimeSubAgentCancellationScope.Cancel(toolUseId, sessionId, "user");
        WorkerLog.Info(
            $"sub-agent cancel requested toolUseId={FormatLogValue(toolUseId ?? string.Empty)} " +
            $"sessionId={FormatLogValue(sessionId ?? string.Empty)} cancelled={count}");
        return WorkerResponse.Json(
            new AgentRuntimeSubAgentCancelResult(count > 0, count),
            WorkerJsonContext.Default.AgentRuntimeSubAgentCancelResult);
    }

    public static WorkerResponse AppendMessages(JsonElement parameters)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            return WorkerResponse.Json(
                new AppendRunMessagesResult(false, null, 0),
                AgentRuntimeContractsJsonContext.Default.AppendRunMessagesResult);
        }

        var requestedCount = CountArray(parameters, "messages");
        long? commandSeq = null;
        try
        {
            commandSeq = RuntimeJobCoordinator.AppendCommand(runId, "append_messages", parameters);
        }
        catch (InvalidOperationException)
        {
            // Unknown/terminal runs retain the existing appended=false contract.
        }

        if (!ActiveRuns.TryGetValue(runId, out var state))
        {
            var queued = RuntimeJobCoordinator.Get(runId)?.State == "queued";
            return WorkerResponse.Json(
                new AppendRunMessagesResult(queued && requestedCount > 0, runId,
                    queued ? requestedCount : 0),
                AgentRuntimeContractsJsonContext.Default.AppendRunMessagesResult);
        }

        var count = requestedCount;
        if (!commandSeq.HasValue || RuntimeJobCoordinator.TryConsumeCommand(runId, commandSeq.Value))
        {
            count = state.EnqueueMessages(parameters);
        }
        WorkerLog.Debug($"agent run append messages runId={runId} count={count}");
        return WorkerResponse.Json(
            new AppendRunMessagesResult(count > 0, runId, count),
            AgentRuntimeContractsJsonContext.Default.AppendRunMessagesResult);
    }

    public static WorkerResponse ReverseResponse(JsonElement parameters)
    {
        return AgentRuntimeReverseRequests.Complete(parameters);
    }

    public static WorkerResponse SessionVisibility(JsonElement parameters)
    {
        _ = parameters;
        return WorkerResponse.Json(
            new ReverseResponseResult(true),
            AgentRuntimeContractsJsonContext.Default.ReverseResponseResult);
    }

    private static async Task ExecuteRunAsync(AgentRuntimeRunState state, WorkerRequestContext context)
    {
        using var operation = WorkerMemory.TrackOperation("agent-run");
        try
        {
            var capabilityError = AgentRuntimeCapabilityPolicy.ValidateRunRequest(state.Parameters);
            if (capabilityError is not null)
            {
                WorkerLog.Warn($"agent run rejected reason={FormatLogValue(capabilityError)}");
                throw new InvalidOperationException(capabilityError);
            }

            ApplyQueuedCommands(state);
            await EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent("loop_start", AssistantMessageId: state.AssistantMessageId));

            if (state.IsCancellationRequested)
            {
                await OpenAIChatRuntime.EmitLoopEndFromOuterAsync(
                    state.Parameters,
                    state,
                    context,
                    "aborted");
                return;
            }

            await OpenAIChatRuntime.ExecuteLoopAsync(state.Parameters, state, context);
        }
        catch (OperationCanceledException) when (state.IsCancellationRequested)
        {
            await OpenAIChatRuntime.EmitLoopEndFromOuterAsync(
                state.Parameters,
                state,
                context,
                "aborted");
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"agent run failed runId={state.RunId} error={ex.GetType().Name}: {ex.Message}");
            await EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "error",
                    Message: ex.Message,
                    // A stable code where we have one, so the renderer can categorise the error
                    // without pattern-matching on message text. Falls back to the CLR type name.
                    ErrorType: ResolveErrorType(ex),
                    Details: ex.Message,
                    StackTrace: ex.StackTrace));
            await OpenAIChatRuntime.EmitLoopEndFromOuterAsync(
                state.Parameters,
                state,
                context,
                "error");
            throw;
        }
        finally
        {
            ActiveRuns.TryRemove(state.RunId, out _);
            RunSlots.Release();
            AgentRuntimeNativeToolExecutor.ClearRun(state.RunId);
            state.Dispose();
            WorkerLog.Info($"agent run finalized runtime=native-aot runId={state.RunId}");
            WorkerMemory.ReportCompletedWork("agent-run", pressureBytes: 0);
        }
    }

    /// <summary>
    /// Maps an exception to a stable, machine-readable error code where one applies. The renderer
    /// categorises errors from this value; without it, it is left matching on message text, which
    /// is unreliable both across locales and under UseSystemResourceKeys in published builds.
    /// </summary>
    private static string ResolveErrorType(Exception exception)
    {
        return exception switch
        {
            AgentRuntimeProviderTransportException transport => transport.Fault.Kind switch
            {
                WorkerHttpFaultKind.TlsCertificate or
                WorkerHttpFaultKind.TlsHandshake => "network_tls",
                WorkerHttpFaultKind.Proxy => "network_proxy",
                _ => "network_transport"
            },
            TimeoutException => "network_timeout",
            _ => exception.GetType().Name
        };
    }

    internal static async Task EmitAsync(
        AgentRuntimeRunState state,
        WorkerRequestContext context,
        params AgentRuntimeStreamEvent[] events)
    {
        if (events.Length == 0)
        {
            return;
        }

        if (state.EventObserver is not null)
        {
            await state.EventObserver(events);
        }
        if (state.SuppressTransportEvents)
        {
            return;
        }

        // Draft tokens are UI-only. Persisting them would fill the durable outbox
        // and punch holes in the per-run sequence on replay. The completed
        // context_compressed / text event still goes through PersistEvent below.
        if (IsLiveOnlyProgress(events))
        {
            PublishLive(state, events);
            return;
        }

        // Allocate the sequence and persist under one lock. Parallel tool batches
        // call EmitAsync concurrently; if seq N+1 hits disk before seq N, the
        // outbox pump can deliver the later envelope first and then skip N
        // (PublishedThrough moves past the hole). The renderer then freezes
        // remaining tool cards on "receiving parameters".
        state.CommitDurableEnvelope(() =>
        {
            JournalToolResults(state, events);
            var envelope = new AgentRuntimeStreamEnvelope(
                StreamProtocolVersion,
                state.RunId,
                state.SessionId,
                state.NextSeq(),
                events);
            var messagePackEvent = AgentStreamMessagePackEmitter.Encode(envelope);
            var terminal = events.Any(static streamEvent =>
                streamEvent.Type is "loop_end" or "error");
            RuntimeJobCoordinator.PersistEvent(
                state.RunId,
                envelope.Seq,
                messagePackEvent.Payload,
                terminal);
            if (AgentStreamMessagePackEmitter.TraceEnabled)
            {
                WorkerLog.Debug(
                    $"agent stream committed transport=durable-outbox runId={state.RunId} seq={envelope.Seq} " +
                    $"events={events.Length} bytes={messagePackEvent.Payload.Length}");
            }
        });
    }

    private static bool IsLiveOnlyProgress(AgentRuntimeStreamEvent[] events)
    {
        return events.Length > 0 &&
            events.All(static streamEvent => streamEvent.Type is "context_compression_delta");
    }

    private static void PublishLive(
        AgentRuntimeRunState state,
        AgentRuntimeStreamEvent[] events)
    {
        if (string.IsNullOrEmpty(state.SessionId))
        {
            return;
        }

        var envelope = new AgentRuntimeStreamEnvelope(
            StreamProtocolVersion,
            state.RunId,
            state.SessionId,
            0,
            events,
            Live: true);
        WorkerTransportHub.TryPublishEvent(AgentStreamMessagePackEmitter.Encode(envelope));
    }

    /// <summary>
    /// Writes every finished tool call to the durable journal on the emit path, so the
    /// result is on disk the moment the tool completes — before the loop appends it to
    /// the in-memory conversation and long before the renderer persists the paired
    /// tool_result message. A crash anywhere after this point can recover the real
    /// output instead of telling the model the call was interrupted.
    /// Journaling failures must never break the run: the stream event is still emitted.
    /// </summary>
    private static void JournalToolResults(
        AgentRuntimeRunState state,
        AgentRuntimeStreamEvent[] events)
    {
        if (string.IsNullOrEmpty(state.SessionId))
        {
            return;
        }

        foreach (var streamEvent in events)
        {
            if (streamEvent.Type is not "tool_call_result" || streamEvent.ToolCall is null)
            {
                continue;
            }

            var toolCall = streamEvent.ToolCall;
            if (string.IsNullOrEmpty(toolCall.Id))
            {
                continue;
            }

            try
            {
                RuntimeJobCoordinator.PersistToolResult(
                    state.SessionId,
                    toolCall.Id,
                    state.RunId,
                    toolCall.Name,
                    toolCall.Status,
                    toolCall.Output?.GetRawText() ?? "null",
                    string.Equals(toolCall.Status, "error", StringComparison.Ordinal),
                    toolCall.StartedAt,
                    toolCall.CompletedAt);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"tool result journal failed sessionId={state.SessionId} " +
                    $"toolUseId={toolCall.Id} error={ex.Message}");
            }
        }
    }

    private static WorkerInitializeResult CreateInitializeResult()
    {
        return new WorkerInitializeResult(
            true,
            "native-aot",
            "0.2",
            RuntimeProtocolVersion,
            [2],
            CoreManifestHash,
            WorkerInstanceId,
            new WorkerFeatureSet(
                CapabilitySnapshot: true,
                StrictToolValidation: true,
                DurableEvents: true,
                DurableInbox: true,
                CheckpointRecovery: false,
                ToolReconciliation: true,
                LaneScheduler: true),
            new WorkerCompatibility(
                AcceptsV1RunRequest: false,
                CanRecoverV2Run: true,
                MinimumRendererVersion: "1.2.8",
                MinimumMainVersion: "1.2.8"));
    }

    private static string NormalizeRunId(string? runId)
    {
        var trimmed = runId?.Trim();
        if (!string.IsNullOrEmpty(trimmed))
        {
            return trimmed;
        }

        var next = Interlocked.Increment(ref generatedRunId);
        return $"native-agent-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{next}";
    }

    private static int CountArray(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(propertyName, out var property) ||
            property.ValueKind != JsonValueKind.Array)
        {
            return 0;
        }

        return property.GetArrayLength();
    }

    private static void ApplyQueuedCommands(AgentRuntimeRunState state)
    {
        foreach (var command in RuntimeJobCoordinator.ReadPendingCommands(state.RunId))
        {
            using var payload = JsonDocument.Parse(command.PayloadJson);
            if (!RuntimeJobCoordinator.TryConsumeCommand(command.CommandId))
            {
                continue;
            }

            switch (command.Kind)
            {
                case "append_messages":
                    state.EnqueueMessages(payload.RootElement);
                    break;
                case "request_stop":
                    state.RequestStop("queued_command");
                    break;
                case "cancel":
                    state.Cancel("queued_command");
                    break;
            }
        }
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrEmpty(value) ? "<empty>" : value;
    }

    internal sealed class AgentRuntimeRunState : IDisposable
    {
        private readonly CancellationTokenSource cancellation = new();
        private readonly ConcurrentQueue<JsonElement> queuedMessages = new();
        private readonly object messageQueueSync = new();
        private readonly object emitSync = new();
        private long seq;
        private int queuedMessageCount;
        private int stopRequested;
        private bool messageQueueClosed;
        private readonly CancellationTokenRegistration externalCancellationRegistration;

        public AgentRuntimeRunState(
            string runId,
            string sessionId,
            CancellationToken externalCancellationToken = default)
        {
            RunId = runId;
            SessionId = sessionId;
            StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            externalCancellationRegistration = externalCancellationToken.CanBeCanceled
                ? externalCancellationToken.Register(
                    static value => ((AgentRuntimeRunState)value!).Cancel("job"),
                    this)
                : default;
        }

        public string RunId { get; }

        public string SessionId { get; }

        public string AssistantMessageId { get; set; } = string.Empty;

        public long StartedAt { get; }

        public JsonElement Parameters { get; private set; }

        public CancellationToken CancellationToken => cancellation.Token;

        public int QueuedMessageCount => Volatile.Read(ref queuedMessageCount);

        public bool IsCancellationRequested => cancellation.IsCancellationRequested;

        public bool IsStopRequested => Volatile.Read(ref stopRequested) != 0;

        public string? StopReason { get; private set; }

        public string? CancellationReason { get; private set; }

        public AgentRuntimeSubAgentConcurrencyLease? SubAgentConcurrencyLease { get; set; }

        public AgentRuntimeTaskInvocation? LastTaskInvocation { get; private set; }

        public bool SuppressTransportEvents { get; set; }

        public Func<AgentRuntimeStreamEvent[], ValueTask>? EventObserver { get; set; }

        public void ReplaceParameters(JsonElement parameters)
        {
            Parameters = parameters;
        }

        public long NextSeq()
        {
            return Interlocked.Increment(ref seq);
        }

        /// <summary>
        /// Serializes sequence allocation and outbox persist for this run so a
        /// parallel tool batch cannot persist seq N+1 before seq N.
        /// </summary>
        public void CommitDurableEnvelope(Action commit)
        {
            lock (emitSync)
            {
                commit();
            }
        }

        public int EnqueueMessages(JsonElement parameters)
        {
            if (parameters.ValueKind != JsonValueKind.Object ||
                !parameters.TryGetProperty("messages", out var messages) ||
                messages.ValueKind != JsonValueKind.Array)
            {
                return 0;
            }

            lock (messageQueueSync)
            {
                if (messageQueueClosed)
                {
                    return 0;
                }

                var count = 0;
                foreach (var message in messages.EnumerateArray())
                {
                    if (message.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }
                    queuedMessages.Enqueue(message.Clone());
                    count++;
                }

                if (count > 0)
                {
                    Interlocked.Add(ref queuedMessageCount, count);
                }
                return count;
            }
        }

        public List<JsonElement> DrainQueuedMessages()
        {
            lock (messageQueueSync)
            {
                var messages = new List<JsonElement>();
                while (queuedMessages.TryDequeue(out var message))
                {
                    messages.Add(message);
                }
                if (messages.Count > 0)
                {
                    Interlocked.Add(ref queuedMessageCount, -messages.Count);
                }
                return messages;
            }
        }

        public bool TryCloseMessageQueueIfEmpty()
        {
            lock (messageQueueSync)
            {
                if (QueuedMessageCount > 0)
                {
                    return false;
                }

                messageQueueClosed = true;
                return true;
            }
        }

        public void Cancel(string reason)
        {
            CancellationReason = string.IsNullOrWhiteSpace(reason) ? "unknown" : reason;
            cancellation.Cancel();
        }

        public void RequestStop(string reason)
        {
            StopReason = string.IsNullOrWhiteSpace(reason) ? "completed" : reason;
            Interlocked.Exchange(ref stopRequested, 1);
        }

        public bool TryGetDuplicateTaskInvocation(
            string key,
            string toolUseId,
            out AgentRuntimeTaskInvocation? invocation)
        {
            invocation = LastTaskInvocation;
            return invocation is not null &&
                invocation.Key == key &&
                invocation.ToolUseId != toolUseId;
        }

        public void RememberTaskInvocation(string key, string output, string toolUseId)
        {
            LastTaskInvocation = new AgentRuntimeTaskInvocation(key, output, toolUseId);
        }

        public void Dispose()
        {
            lock (messageQueueSync)
            {
                messageQueueClosed = true;
            }
            // Last-resort release: every executor path disposes the lease explicitly,
            // but a leaked lease pins a process-wide sub-agent concurrency slot forever.
            SubAgentConcurrencyLease?.Dispose();
            SubAgentConcurrencyLease = null;
            externalCancellationRegistration.Dispose();
            cancellation.Dispose();
        }
    }

    internal sealed record AgentRuntimeTaskInvocation(string Key, string Output, string ToolUseId);
}
