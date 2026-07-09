using System.Collections.Concurrent;
using System.Text.Json;

internal static class AgentRuntimeTools
{
    private const int ProtocolVersion = 1;
    private static readonly ConcurrentDictionary<string, AgentRuntimeRunState> ActiveRuns = new(StringComparer.Ordinal);
    private static long generatedRunId;

    public static WorkerResponse Initialize(JsonElement parameters)
    {
        _ = parameters;
        WorkerLog.Info("agent runtime initialized runtime=native-aot");
        return WorkerResponse.Json(
            new AgentRuntimeInitializeResult(true, "native-aot", "0.1"),
            WorkerJsonContext.Default.AgentRuntimeInitializeResult);
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
        WorkerLog.Info("agent runtime shutdown");
        return WorkerResponse.Json(
            new AgentRuntimeInitializeResult(true, "native-aot", "0.1"),
            WorkerJsonContext.Default.AgentRuntimeInitializeResult);
    }

    public static WorkerResponse CheckCapability(JsonElement parameters)
    {
        var capability = JsonHelpers.GetString(parameters, "capability") ?? string.Empty;
        var supported = capability is
            "agent.run" or
            "desktop.input" or
            "provider.openai-chat" or
            "provider.openai-responses" or
            "provider.openai-images" or
            "provider.anthropic" or
            "provider.gemini" or
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

    public static Task<WorkerResponse> RunAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var runId = NormalizeRunId(JsonHelpers.GetString(parameters, "runId"));
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim() ?? string.Empty;
        var initialMessageCount = CountArray(parameters, "messages");
        var state = new AgentRuntimeRunState(runId, sessionId);
        state.ReplaceParameters(parameters.Clone());

        if (!ActiveRuns.TryAdd(runId, state))
        {
            return Task.FromResult(WorkerResponse.Error($"Agent run already exists: {runId}"));
        }

        WorkerLog.Info(
            $"agent run accepted runtime=native-aot runId={runId} sessionId={FormatLogValue(sessionId)} " +
            $"messages={initialMessageCount}");

        _ = Task.Run(async () => await ExecuteRunAsync(state, context), CancellationToken.None);

        return Task.FromResult(WorkerResponse.Json(
            new AgentRuntimeRunResult(true, runId),
            WorkerJsonContext.Default.AgentRuntimeRunResult));
    }

    public static WorkerResponse Cancel(JsonElement parameters)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            return WorkerResponse.Json(
                new AgentRuntimeCancelResult(false, null),
                WorkerJsonContext.Default.AgentRuntimeCancelResult);
        }

        if (!ActiveRuns.TryGetValue(runId, out var state))
        {
            return WorkerResponse.Json(
                new AgentRuntimeCancelResult(false, runId),
                WorkerJsonContext.Default.AgentRuntimeCancelResult);
        }

        state.Cancel("user");
        WorkerLog.Info($"agent run cancel requested runId={runId}");
        return WorkerResponse.Json(
            new AgentRuntimeCancelResult(true, runId),
            WorkerJsonContext.Default.AgentRuntimeCancelResult);
    }

    public static WorkerResponse RequestStop(JsonElement parameters)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            return WorkerResponse.Json(
                new AgentRuntimeStopResult(false, null),
                WorkerJsonContext.Default.AgentRuntimeStopResult);
        }

        if (!ActiveRuns.TryGetValue(runId, out var state))
        {
            return WorkerResponse.Json(
                new AgentRuntimeStopResult(false, runId),
                WorkerJsonContext.Default.AgentRuntimeStopResult);
        }

        state.RequestStop("user");
        WorkerLog.Info($"agent run stop requested runId={runId}");
        return WorkerResponse.Json(
            new AgentRuntimeStopResult(true, runId),
            WorkerJsonContext.Default.AgentRuntimeStopResult);
    }

    public static WorkerResponse AppendMessages(JsonElement parameters)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (string.IsNullOrEmpty(runId))
        {
            return WorkerResponse.Json(
                new AgentRuntimeAppendMessagesResult(false, null, 0),
                WorkerJsonContext.Default.AgentRuntimeAppendMessagesResult);
        }

        if (!ActiveRuns.TryGetValue(runId, out var state))
        {
            return WorkerResponse.Json(
                new AgentRuntimeAppendMessagesResult(false, runId, 0),
                WorkerJsonContext.Default.AgentRuntimeAppendMessagesResult);
        }

        var count = state.EnqueueMessages(parameters);
        WorkerLog.Debug($"agent run append messages runId={runId} count={count}");
        return WorkerResponse.Json(
            new AgentRuntimeAppendMessagesResult(true, runId, count),
            WorkerJsonContext.Default.AgentRuntimeAppendMessagesResult);
    }

    public static WorkerResponse ReverseResponse(JsonElement parameters)
    {
        return AgentRuntimeReverseRequests.Complete(parameters);
    }

    public static WorkerResponse SessionVisibility(JsonElement parameters)
    {
        _ = parameters;
        return WorkerResponse.Json(
            new AgentRuntimeReverseResponseResult(true),
            WorkerJsonContext.Default.AgentRuntimeReverseResponseResult);
    }

    private static async Task ExecuteRunAsync(AgentRuntimeRunState state, WorkerRequestContext context)
    {
        using var operation = WorkerMemory.TrackOperation("agent-run");
        try
        {
            await EmitAsync(state, context, new AgentRuntimeStreamEvent("loop_start"));

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
                    ErrorType: ex.GetType().Name,
                    Details: ex.Message,
                    StackTrace: ex.StackTrace));
            await OpenAIChatRuntime.EmitLoopEndFromOuterAsync(
                state.Parameters,
                state,
                context,
                "error");
        }
        finally
        {
            ActiveRuns.TryRemove(state.RunId, out _);
            AgentRuntimeNativeToolExecutor.ClearRun(state.RunId);
            state.Dispose();
            WorkerLog.Info($"agent run finalized runtime=native-aot runId={state.RunId}");
            WorkerMemory.ReportCompletedWork("agent-run", pressureBytes: 0, forceTrim: true);
        }
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

        var envelope = new AgentRuntimeStreamEnvelope(
            ProtocolVersion,
            state.RunId,
            state.SessionId,
            state.NextSeq(),
            events);
        if (state.EventObserver is not null)
        {
            await state.EventObserver(events);
        }
        if (state.SuppressTransportEvents)
        {
            return;
        }

        var messagePackEvent = AgentStreamMessagePackEmitter.Encode(envelope);
        await context.EmitMessagePackEventAsync(messagePackEvent);
        if (AgentStreamMessagePackEmitter.TraceEnabled)
        {
            WorkerLog.Debug(
                $"agent stream emitted transport=msgpack runId={state.RunId} seq={envelope.Seq} " +
                $"events={events.Length} bytes={messagePackEvent.Payload.Length}");
        }
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

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrEmpty(value) ? "<empty>" : value;
    }

    internal sealed class AgentRuntimeRunState : IDisposable
    {
        private readonly CancellationTokenSource cancellation = new();
        private readonly ConcurrentQueue<JsonElement> queuedMessages = new();
        private long seq;
        private int queuedMessageCount;
        private int stopRequested;

        public AgentRuntimeRunState(string runId, string sessionId)
        {
            RunId = runId;
            SessionId = sessionId;
            StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        public string RunId { get; }

        public string SessionId { get; }

        public long StartedAt { get; }

        public JsonElement Parameters { get; private set; }

        public CancellationToken CancellationToken => cancellation.Token;

        public int QueuedMessageCount => Volatile.Read(ref queuedMessageCount);

        public bool IsCancellationRequested => cancellation.IsCancellationRequested;

        public bool IsStopRequested => Volatile.Read(ref stopRequested) != 0;

        public string? StopReason { get; private set; }

        public string? SubmittedReport { get; private set; }

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

        public int EnqueueMessages(JsonElement parameters)
        {
            if (parameters.ValueKind != JsonValueKind.Object ||
                !parameters.TryGetProperty("messages", out var messages) ||
                messages.ValueKind != JsonValueKind.Array)
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

        public List<JsonElement> DrainQueuedMessages()
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

        public void Cancel(string reason)
        {
            _ = reason;
            cancellation.Cancel();
        }

        public void RequestStop(string reason)
        {
            StopReason = string.IsNullOrWhiteSpace(reason) ? "completed" : reason;
            Interlocked.Exchange(ref stopRequested, 1);
        }

        public bool TrySubmitReport(string report)
        {
            if (string.IsNullOrWhiteSpace(report))
            {
                return false;
            }

            if (SubmittedReport is null)
            {
                SubmittedReport = report.Trim();
            }
            RequestStop("completed");
            return true;
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
            cancellation.Dispose();
        }
    }

    internal sealed record AgentRuntimeTaskInvocation(string Key, string Output, string ToolUseId);
}
