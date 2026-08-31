using System.Buffers;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class OpenAIChatRuntime
{
    // Matches the resultPolicy every Tool manifest advertises ('bounded-preview-64k') and the
    // per-tool budgets Glob/Grep already compact to, which a smaller global cap used to override.
    private const int ToolResultMaxChars = 64 * 1024;
    private const int ToolResultTextBlockMaxChars = 48 * 1024;
    private const int ToolResultImageDataMaxChars = 4 * 1024;
    // Upper bound for the host-supplied maxParallelTools; mirrors the renderer clamp in
    // src/main/ipc/agent-runtime/session-run-settings.ts.
    private const int MaxParallelToolsCeiling = 16;
    private const double DefaultContextCompressionThreshold = 0.8;
    private const int DefaultContextCompressionReservedOutputTokens = 20_000;
    private const int ContextCompressionAutoBufferTokens = 13_000;
    // How many times per run a provider "context window exceeded" rejection may trigger
    // reactive compression before the error is surfaced to the caller.
    private const int MaxOverflowCompressionAttemptsPerRun = 2;
    private const int ContextSourceHeadMessageLimit = 12;
    // Plan mode can be toggled from the UI, in which case the model never ran EnterPlanMode and
    // has no plan file path. Spell out the handoff so the plan still reaches the review panel
    // instead of being printed as ordinary assistant text.
    private const string PlanModeTurnContextText =
        "<turn-context>\n" +
        "<plan-mode>enabled; inspect and write plans only unless implementation is explicitly approved for this turn.\n" +
        "The user only sees a plan after ExitPlanMode succeeds, so never end the turn with the plan in ordinary reply text.\n" +
        "When the plan is ready, call ExitPlanMode and pass the complete plan markdown as the `plan` argument unless you already wrote the plan file.</plan-mode>\n" +
        "</turn-context>";
    private const string PlanRevisionInstruction =
        "Please revise the current plan file accordingly with Write/Edit, then call ExitPlanMode.";
    // Infinite client timeout: the effective deadline is user-configurable and therefore
    // applied per request via AgentRuntimeRequestTimeout.
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: Timeout.InfiniteTimeSpan);
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task ExecuteLoopAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider");
        var providerType = JsonHelpers.GetString(provider, "type") ?? string.Empty;
        if (providerType is not ("openai-chat" or "openai-responses" or "anthropic" or "gemini-interactions" or "vertex-ai"))
        {
            throw new InvalidOperationException($"Native AgentRuntime provider is not migrated yet: {providerType}");
        }

        ValidateProvider(provider);

        var wireConversation = ApplyRequestContexts(ReadWireConversation(parameters), parameters);
        var conversation = ReadConversation(wireConversation);
        AgentRuntimeSubAgentExecutor.OnMainLoopStart(parameters, wireConversation, state);
        var runtimeParameters = CreateRuntimeParametersWithoutMessages(parameters);
        state.ReplaceParameters(runtimeParameters);
        parameters = runtimeParameters;
        provider = GetObject(parameters, "provider");
        var compressionProvider = parameters.TryGetProperty("compressionProvider", out var configuredCompressionProvider) &&
            configuredCompressionProvider.ValueKind == JsonValueKind.Object
                ? configuredCompressionProvider
                : provider;
        ValidateProvider(compressionProvider);
        var compressionConfig = ReadLoopCompressionConfig(parameters);
        var lastInputTokens = compressionConfig is null ? 0 : FindRecentContextUsage(wireConversation);
        var requestedMaxIterations = JsonHelpers.GetInt(parameters, "maxIterations", 1);
        var hasIterationLimit = requestedMaxIterations > 0;
        var providerTurnOnly = JsonHelpers.GetBool(parameters, "providerTurnOnly", false);
        var captureFinalMessages = JsonHelpers.GetBool(parameters, "captureFinalMessages", false);
        var captureUncompressedFinalMessages = JsonHelpers.GetBool(
            parameters,
            "captureUncompressedFinalMessages",
            false);
        var uncompressedWireConversation = captureUncompressedFinalMessages
            ? wireConversation.Select(message => message.Clone()).ToList()
            : null;
        var completed = false;
        var fullCompressionApplied = false;
        var runtimePlanModeContextInjected = wireConversation.Any(MessageHasPlanModeContext);
        var iterationsSinceTaskTool = 0;
        // Error-driven compression guards: a provider "context window exceeded" rejection
        // triggers at most MaxOverflowCompressionAttemptsPerRun compressions per run, and an
        // overflow that recurs immediately after a successful compression is surfaced instead
        // of compressing again, so a misconfigured window can never loop forever.
        var overflowCompressionAttempts = 0;
        var overflowCompressionPendingVerification = false;

        WorkerLog.Debug(
            $"agent loop start provider={providerType} maxIterations=" +
            $"{(hasIterationLimit ? requestedMaxIterations.ToString() : "unlimited")} " +
            $"providerTurnOnly={providerTurnOnly} compression={(compressionConfig is null ? "disabled" : "enabled")}");

        for (var iteration = 1; !hasIterationLimit || iteration <= requestedMaxIterations; iteration++)
        {
            if (state.IsCancellationRequested)
            {
                await EmitLoopEndAsync(
                    parameters,
                    state,
                    context,
                    "aborted",
                    fullCompressionApplied || captureFinalMessages,
                    uncompressedWireConversation ?? wireConversation);
                return;
            }

            if (state.IsStopRequested)
            {
                completed = true;
                break;
            }

            if (lastInputTokens > 0 &&
                compressionConfig is not null &&
                ShouldCompress(lastInputTokens, compressionConfig))
            {
                var compression = await TryCompressLoopConversationAsync(
                    parameters,
                    wireConversation,
                    compressionProvider,
                    lastInputTokens,
                    state,
                    context);
                if (compression.Status == LoopCompressionStatus.Cancelled)
                {
                    await EmitLoopEndAsync(
                        parameters,
                        state,
                        context,
                        "aborted",
                        fullCompressionApplied || captureFinalMessages,
                        uncompressedWireConversation ?? wireConversation);
                    return;
                }
                if (compression.Status == LoopCompressionStatus.HookBlocked)
                {
                    lastInputTokens = 0;
                }
                else if (compression.Status == LoopCompressionStatus.Compressed)
                {
                    wireConversation = compression.Messages!;
                    conversation = ReadConversation(wireConversation);
                    fullCompressionApplied = true;
                    lastInputTokens = 0;
                }
            }

            var injectedMessages = state.DrainQueuedMessages();
            if (injectedMessages.Count > 0)
            {
                var injectedClones = injectedMessages.Select(message => message.Clone()).ToArray();
                wireConversation.AddRange(injectedClones);
                uncompressedWireConversation?.AddRange(
                    injectedClones.Select(message => message.Clone()));
                conversation.AddRange(ReadConversation(injectedMessages));
                WorkerLog.Debug(
                    $"agent loop injected queued messages runId={state.RunId} count={injectedMessages.Count}");
            }

            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent("iteration_start", Iteration: iteration));

            if (state.IsCancellationRequested)
            {
                await EmitLoopEndAsync(
                    parameters,
                    state,
                    context,
                    "aborted",
                    fullCompressionApplied || captureFinalMessages,
                    uncompressedWireConversation ?? wireConversation);
                return;
            }

            AgentRuntimeProviderTurnResult turn;
            try
            {
                turn = await AgentRuntimeProviderRetryPolicy.ExecuteAsync(
                    () => ExecuteTurnAsync(parameters, provider, conversation, state, context),
                    state,
                    context);
            }
            catch (Exception ex) when (
                ex is not OperationCanceledException &&
                compressionConfig is not null &&
                !overflowCompressionPendingVerification &&
                overflowCompressionAttempts < MaxOverflowCompressionAttemptsPerRun &&
                wireConversation.Count >= 2 &&
                AgentRuntimeContextCompression.IsContextWindowExceededError(ex))
            {
                overflowCompressionAttempts++;
                WorkerLog.Warn(
                    $"agent provider turn exceeded the model context window; attempting error-driven " +
                    $"compression runId={state.RunId} attempt={overflowCompressionAttempts}/" +
                    $"{MaxOverflowCompressionAttemptsPerRun} error={ex.GetType().Name}: {ex.Message}");
                var originalCount = wireConversation.Count;
                var compression = await TryCompressLoopConversationAsync(
                    parameters,
                    wireConversation,
                    compressionProvider,
                    lastInputTokens,
                    state,
                    context);
                if (compression.Status == LoopCompressionStatus.Cancelled)
                {
                    await EmitLoopEndAsync(
                        parameters,
                        state,
                        context,
                        "aborted",
                        fullCompressionApplied || captureFinalMessages,
                        uncompressedWireConversation ?? wireConversation);
                    return;
                }
                // Only retry when compression actually shrank the conversation; otherwise
                // surface the original provider error instead of looping on a hopeless request.
                if (compression.Status != LoopCompressionStatus.Compressed ||
                    compression.Messages is not { Count: > 0 } compressedMessages ||
                    compressedMessages.Count >= originalCount)
                {
                    throw;
                }
                wireConversation = compressedMessages;
                conversation = ReadConversation(wireConversation);
                fullCompressionApplied = true;
                lastInputTokens = 0;
                overflowCompressionPendingVerification = true;
                continue;
            }

            overflowCompressionPendingVerification = false;
            conversation.Add(turn.AssistantMessage);
            var assistantWireMessage = CreateAssistantWireMessage(turn.AssistantMessage, turn.Usage);
            wireConversation.Add(assistantWireMessage);
            uncompressedWireConversation?.Add(assistantWireMessage.Clone());
            if (turn.Usage?.ContextTokens is > 0)
            {
                lastInputTokens = turn.Usage.ContextTokens.Value;
            }

            if (turn.ToolCalls.Count == 0)
            {
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("iteration_end", StopReason: turn.StopReason));
                if (!state.TryCloseMessageQueueIfEmpty())
                {
                    continue;
                }
                completed = true;
                break;
            }

            if (providerTurnOnly)
            {
                await EmitProviderTurnToolCallsAsync(turn.ToolCalls, state, context);
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("iteration_end", StopReason: turn.StopReason));
                completed = true;
                break;
            }

            var toolExecution = await ExecuteToolCallsAsync(
                parameters,
                turn.ToolCalls,
                state,
                context);
            var toolResults = toolExecution.ToolResults;

            conversation.Add(AgentRuntimeChatMessage.UserToolResults(toolResults));
            var toolResultsWireMessage = CreateToolResultsWireMessage(toolResults);
            wireConversation.Add(toolResultsWireMessage);
            uncompressedWireConversation?.Add(toolResultsWireMessage.Clone());
            foreach (var hookContext in toolExecution.HookContextTexts)
            {
                conversation.Add(new AgentRuntimeChatMessage("user", hookContext, [], []));
                var hookContextWireMessage = CreateUserTextWireMessage(hookContext);
                wireConversation.Add(hookContextWireMessage);
                uncompressedWireConversation?.Add(hookContextWireMessage.Clone());
            }
            if (!runtimePlanModeContextInjected &&
                AgentRuntimePlanExecutor.IsPlanModeActiveForRun(state.RunId, parameters))
            {
                conversation.Add(new AgentRuntimeChatMessage("user", PlanModeTurnContextText, [], []));
                var planModeWireMessage = CreateUserTextWireMessage(PlanModeTurnContextText);
                wireConversation.Add(planModeWireMessage);
                uncompressedWireConversation?.Add(planModeWireMessage.Clone());
                runtimePlanModeContextInjected = true;
            }
            iterationsSinceTaskTool = turn.ToolCalls.Any(call => AgentRuntimeTaskExecutor.IsTaskTool(call.Name))
                ? 0
                : iterationsSinceTaskTool + 1;
            if (iterationsSinceTaskTool >= AgentRuntimeTaskExecutor.ReminderDriftIterations)
            {
                iterationsSinceTaskTool = 0;
                var driftReminder = AgentRuntimeTaskExecutor.BuildDriftReminder(parameters);
                if (driftReminder is not null)
                {
                    conversation.Add(new AgentRuntimeChatMessage("user", driftReminder, [], []));
                    var driftWireMessage = CreateUserTextWireMessage(driftReminder);
                    wireConversation.Add(driftWireMessage);
                    uncompressedWireConversation?.Add(driftWireMessage.Clone());
                }
            }
            // Checkpoint the hosted session now that the batch is fully answered, so a
            // crash before loop end cannot roll the history back past these tool calls.
            SnapshotHostedSession(state, uncompressedWireConversation ?? wireConversation);
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "iteration_end",
                    StopReason: "tool_use",
                    ToolResults: toolResults.ToArray()));

            if (state.IsStopRequested)
            {
                completed = true;
                break;
            }
        }

        await EmitLoopEndAsync(
            parameters,
            state,
            context,
            state.StopReason ?? (completed ? "completed" : "max_iterations"),
            fullCompressionApplied || captureFinalMessages,
            uncompressedWireConversation ?? wireConversation);
    }

    internal static async Task<AgentRuntimeProviderTurnResult> ExecuteProviderTurnAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider");
        var providerType = JsonHelpers.GetString(provider, "type") ?? string.Empty;
        if (providerType is not ("openai-chat" or "openai-responses" or "anthropic" or "gemini-interactions" or "vertex-ai"))
        {
            throw new InvalidOperationException($"Native AgentRuntime provider is not migrated yet: {providerType}");
        }

        ValidateProvider(provider);
        var conversation = ReadConversation(parameters);
        return await AgentRuntimeProviderRetryPolicy.ExecuteAsync(
            () => ExecuteTurnAsync(parameters, provider, conversation, state, context),
            state,
            context);
    }

    private static JsonElement CreateRuntimeParametersWithoutMessages(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            return parameters.Clone();
        }

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            foreach (var property in parameters.EnumerateObject())
            {
                if (property.NameEquals("messages") ||
                    property.NameEquals("liveOverlayMessages") ||
                    property.NameEquals("requestContextTexts") ||
                    property.NameEquals("slashCommand") ||
                    property.NameEquals("systemCommand") ||
                    property.NameEquals("pluginChannelContext"))
                {
                    continue;
                }
                property.WriteTo(writer);
            }
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static AgentRuntimeStreamEvent BuildLoopEndEvent(
        string reason,
        bool includeMessages,
        IReadOnlyList<JsonElement> wireConversation)
    {
        return includeMessages
            ? new AgentRuntimeStreamEvent(
                "loop_end",
                Reason: reason,
                Messages: wireConversation.Select(message => message.Clone()).ToArray())
            : new AgentRuntimeStreamEvent("loop_end", Reason: reason);
    }

    internal static Task EmitLoopEndFromOuterAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string reason)
    {
        return EmitLoopEndAsync(parameters, state, context, reason, false, []);
    }

    private static async Task EmitLoopEndAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string reason,
        bool includeMessages,
        IReadOnlyList<JsonElement> wireConversation)
    {
        AgentRuntimeHookResult? stopHook = null;
        try
        {
            stopHook = await AgentRuntimeHooks.RunStopAsync(
                parameters,
                state,
                context,
                NormalizeStopReason(reason),
                false,
                FindLastAssistantText(wireConversation));
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Warn($"stop hook canceled runId={state.RunId}; emitting loop_end");
        }
        if (stopHook?.Blocked == true)
        {
            WorkerLog.Warn(
                $"stop hook requested block runId={state.RunId} reason={stopHook.Reason}; emitting loop_end without recursive continuation");
        }
        SnapshotHostedSession(state, wireConversation);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            BuildLoopEndEvent(reason, includeMessages, wireConversation));
    }

    /// <summary>
    /// Persists the hosted session's canonical history. Child runs (sub-agents, context
    /// compression) borrow the parent's sessionId while owning a completely unrelated
    /// conversation, so their history must never replace the hosted one;
    /// SuppressTransportEvents is exactly that "internal child run" marker.
    /// </summary>
    private static void SnapshotHostedSession(
        AgentRuntimeTools.AgentRuntimeRunState state,
        IReadOnlyList<JsonElement> wireConversation)
    {
        if (state.SuppressTransportEvents)
        {
            return;
        }
        AgentRuntimeSessionHost.ReplaceHistory(state.SessionId, wireConversation);
    }

    private static string NormalizeStopReason(string reason)
    {
        return reason switch
        {
            "completed" => "completed",
            "max_iterations" => "max_iterations",
            "aborted" => "aborted",
            "cancelled" => "cancelled",
            "error" => "error",
            _ => "completed"
        };
    }

    private static string? FindLastAssistantText(IReadOnlyList<JsonElement> wireConversation)
    {
        for (var index = wireConversation.Count - 1; index >= 0; index--)
        {
            var message = wireConversation[index];
            if (message.ValueKind != JsonValueKind.Object ||
                JsonHelpers.GetString(message, "role") != "assistant" ||
                !message.TryGetProperty("content", out var content))
            {
                continue;
            }
            if (content.ValueKind == JsonValueKind.String)
            {
                return content.GetString();
            }
            if (content.ValueKind == JsonValueKind.Array)
            {
                var parts = new List<string>();
                foreach (var block in content.EnumerateArray())
                {
                    if (block.ValueKind == JsonValueKind.Object &&
                        JsonHelpers.GetString(block, "type") == "text" &&
                        JsonHelpers.GetString(block, "text") is { Length: > 0 } text)
                    {
                        parts.Add(text);
                    }
                }
                if (parts.Count > 0)
                {
                    return string.Join("\n", parts);
                }
            }
        }
        return null;
    }

    private static AgentLoopCompressionConfig? ReadLoopCompressionConfig(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("compression", out var compression) ||
            compression.ValueKind != JsonValueKind.Object ||
            !JsonHelpers.GetBool(compression, "enabled", false))
        {
            return null;
        }

        var contextLength = JsonHelpers.GetInt(compression, "contextLength", 0);
        if (contextLength <= 0)
        {
            return null;
        }

        var threshold = JsonHelpers.GetDoubleNullable(compression, "threshold") ??
            DefaultContextCompressionThreshold;
        threshold = Math.Clamp(threshold, 0.3, 0.9);
        var reservedOutputBudget = Math.Max(
            0,
            JsonHelpers.GetInt(
                compression,
                "reservedOutputBudget",
                DefaultContextCompressionReservedOutputTokens));
        return new AgentLoopCompressionConfig(contextLength, threshold, reservedOutputBudget);
    }

    private static bool ShouldCompress(int inputTokens, AgentLoopCompressionConfig config)
    {
        if (inputTokens <= 0 || config.ContextLength <= 0)
        {
            return false;
        }
        return inputTokens >= GetCompressionTriggerTokens(config);
    }

    private enum LoopCompressionStatus
    {
        HookBlocked,
        Cancelled,
        Compressed,
        Failed
    }

    private readonly record struct LoopCompressionAttempt(
        LoopCompressionStatus Status,
        List<JsonElement>? Messages);

    /// <summary>
    /// Runs one in-loop compression pass (PreCompact hook, summarizer, PostCompact hook,
    /// stream events). Shared by the proactive token-threshold trigger and the reactive
    /// context-window-exceeded recovery path.
    /// </summary>
    private static async Task<LoopCompressionAttempt> TryCompressLoopConversationAsync(
        JsonElement parameters,
        List<JsonElement> wireConversation,
        JsonElement compressionProvider,
        int preTokens,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var preCompactHook = await AgentRuntimeHooks.RunCompactAsync(
            parameters,
            state,
            context,
            "PreCompact",
            "auto",
            wireConversation.Count);
        if (preCompactHook.Blocked)
        {
            WorkerLog.Warn(
                $"agent context compression blocked by hook runId={state.RunId} reason={preCompactHook.Reason}");
            return new LoopCompressionAttempt(LoopCompressionStatus.HookBlocked, null);
        }

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent("context_compression_start"));

        if (state.IsCancellationRequested)
        {
            return new LoopCompressionAttempt(LoopCompressionStatus.Cancelled, null);
        }

        try
        {
            var originalCount = wireConversation.Count;
            // Zero-preserve: the compression summary replaces the whole prior context.
            const int preserveCount = 0;
            WorkerLog.Info(
                $"agent context compression start runId={state.RunId} tokens={preTokens} " +
                $"messages={originalCount} preserveCount={preserveCount}");
            var compressed = await AgentRuntimeContextCompression.CompressMessagesAsync(
                wireConversation,
                compressionProvider,
                context,
                focusPrompt: null,
                preTokens: preTokens,
                preserveCount,
                trigger: "auto",
                pinnedContext: null,
                progressState: state);
            if (compressed.Result.Compressed)
            {
                var compressedMessages = compressed.Messages
                    .Select(message => message.Clone())
                    .ToList();
                var summarized = compressed.Result.MessagesSummarized ??
                    Math.Max(0, originalCount - Math.Max(0, compressed.Messages.Length - 1));
                var postCompactHook = await AgentRuntimeHooks.RunCompactAsync(
                    parameters,
                    state,
                    context,
                    "PostCompact",
                    "auto",
                    originalCount,
                    compressed.Messages.Length);
                if (postCompactHook.Blocked)
                {
                    WorkerLog.Warn(
                        $"post compact hook requested block after auto compression runId={state.RunId} reason={postCompactHook.Reason}");
                }
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent(
                        "context_compressed",
                        // The host keeps this row out of the cut: it is the turn that was
                        // streaming when compression ran and it keeps producing output.
                        AssistantMessageId: state.AssistantMessageId,
                        OriginalCount: originalCount,
                        NewCount: compressed.Messages.Length,
                        KeptMessageCount: summarized,
                        SummarizerFailed: compressed.Result.SummarizerFailed,
                        CompactSummaryMessage: FindSummaryMessage(
                            compressed.Messages,
                            compressed.Result.SummaryMessageId),
                        CompactedMessageIds: compressed.Result.CompactedMessageIds,
                        PreTokens: preTokens));
                WorkerLog.Info(
                    $"agent context compression ok runId={state.RunId} original={originalCount} " +
                    $"compressed={compressed.Messages.Length} summarized={summarized}");
                return new LoopCompressionAttempt(LoopCompressionStatus.Compressed, compressedMessages);
            }

            if (compressed.Result.SummarizerFailed == true)
            {
                WorkerLog.Warn(
                    $"agent context compression preserved original context after summarizer failure " +
                    $"runId={state.RunId} error={compressed.Result.Error}");
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent(
                        "context_compressed",
                        Message: compressed.Result.Error,
                        OriginalCount: originalCount,
                        NewCount: originalCount,
                        KeptMessageCount: 0,
                        SummarizerFailed: true));
            }
            return new LoopCompressionAttempt(LoopCompressionStatus.Failed, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            WorkerLog.Warn(
                $"agent context compression failed runId={state.RunId} error={ex.GetType().Name}: {ex.Message}");
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "context_compressed",
                    Message: ex.Message,
                    OriginalCount: wireConversation.Count,
                    NewCount: wireConversation.Count,
                    KeptMessageCount: 0,
                    SummarizerFailed: true));
            return new LoopCompressionAttempt(LoopCompressionStatus.Failed, null);
        }
    }

    private static int GetCompressionTriggerTokens(AgentLoopCompressionConfig config)
    {
        var effectiveWindow = Math.Max(1, config.ContextLength - config.ReservedOutputBudget);
        var ratioThreshold = Math.Max(1, (int)Math.Floor(effectiveWindow * config.Threshold));
        var bufferedThreshold = effectiveWindow - ContextCompressionAutoBufferTokens;
        return Math.Max(
            1,
            Math.Min(ratioThreshold, bufferedThreshold > 0 ? bufferedThreshold : ratioThreshold));
    }

    private static int FindRecentContextUsage(IReadOnlyList<JsonElement> messages)
    {
        for (var index = messages.Count - 1; index >= 0; index--)
        {
            var message = messages[index];
            if (message.ValueKind != JsonValueKind.Object ||
                !message.TryGetProperty("usage", out var usage) ||
                usage.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var tokens = JsonHelpers.GetInt(usage, "contextTokens", 0);
            if (tokens > 0)
            {
                return tokens;
            }
        }
        return 0;
    }

    private static bool IsCompactSummaryLikeMessage(JsonElement message)
    {
        if (message.TryGetProperty("meta", out var meta) &&
            meta.ValueKind == JsonValueKind.Object &&
            meta.TryGetProperty("compactSummary", out _))
        {
            return true;
        }

        if (JsonHelpers.GetString(message, "role") != "user" ||
            !message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        return (content.GetString() ?? string.Empty)
            .TrimStart()
            .StartsWith("[Context Memory Compressed Summary", StringComparison.Ordinal);
    }

    private static JsonElement? FindSummaryMessage(
        IReadOnlyList<JsonElement> messages,
        string? summaryMessageId)
    {
        var summary = string.IsNullOrEmpty(summaryMessageId)
            ? messages.FirstOrDefault(IsCompactSummaryLikeMessage)
            : messages.FirstOrDefault(message =>
                string.Equals(GetWireMessageId(message), summaryMessageId, StringComparison.Ordinal));
        return summary.ValueKind == JsonValueKind.Undefined ? null : summary.Clone();
    }

    private static bool IsCompactBoundaryMessage(JsonElement message)
    {
        return message.ValueKind == JsonValueKind.Object &&
            message.TryGetProperty("meta", out var meta) &&
            meta.ValueKind == JsonValueKind.Object &&
            meta.TryGetProperty("compactBoundary", out _);
    }

    private static async Task EmitProviderTurnToolCallsAsync(
        IReadOnlyList<AgentRuntimeNativeToolCall> toolCalls,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        foreach (var call in toolCalls)
        {
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_generated",
                    ToolUseBlock: new AgentRuntimeToolUseBlock(
                        call.Id,
                        call.Name,
                        call.Input,
                        call.ExtraContent)));
        }
    }

    private static async Task<AgentRuntimeProviderTurnResult> ExecuteTurnAsync(
        JsonElement parameters,
        JsonElement provider,
        List<AgentRuntimeChatMessage> conversation,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var providerType = JsonHelpers.GetString(provider, "type") ?? string.Empty;
        if (providerType == "openai-responses")
        {
            return await AgentRuntimeOpenAIResponsesProvider.ExecuteTurnAsync(
                parameters,
                provider,
                conversation,
                state,
                context);
        }
        if (providerType == "anthropic")
        {
            return await AgentRuntimeAnthropicMessagesProvider.ExecuteTurnAsync(
                parameters,
                provider,
                conversation,
                state,
                context);
        }
        if (providerType == "gemini-interactions")
        {
            return await AgentRuntimeGeminiInteractionsProvider.ExecuteTurnAsync(
                parameters,
                provider,
                conversation,
                state,
                context);
        }
        // Vertex AI has no Interactions endpoint on aiplatform.googleapis.com, so it stays
        // on generateContent.
        if (providerType == "vertex-ai")
        {
            return await AgentRuntimeGeminiProvider.ExecuteTurnAsync(
                parameters,
                provider,
                conversation,
                state,
                context);
        }

        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        var baseUrl = (JsonHelpers.GetString(provider, "baseUrl") ?? "https://api.openai.com/v1")
            .Trim()
            .TrimEnd('/');
        var url = $"{baseUrl}/chat/completions";
        var body = BuildRequestBody(parameters, provider, conversation);
        var debugHeaders = BuildDebugHeaders(provider);
        var debugBody = AgentRuntimeDebugPayload.PrepareBodyFile(body, parameters);

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "request_debug",
                DebugInfo: new AgentRuntimeRequestDebugInfo(
                    url,
                    "POST",
                    debugHeaders,
                    AgentRuntimeDebugPayload.PrepareBody(body, parameters),
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    JsonHelpers.GetString(provider, "providerId"),
                    JsonHelpers.GetString(provider, "providerBuiltinId"),
                    model,
                    BodyRef: debugBody?.Ref,
                    BodyBytes: debugBody?.Bytes)));

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider, JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);

        var startedAt = Stopwatch.GetTimestamp();
        long? firstTokenMs = null;
        var estimatedOutputTokens = 0;
        var reasoningStreamed = false;
        AgentRuntimeTokenUsage? finalUsage = null;
        var finalStopReason = "stop";
        var assistantText = new StringBuilder();
        var reasoningText = new StringBuilder();
        var toolBuffers = new Dictionary<int, ToolCallBuffer>();
        var toolCalls = new List<AgentRuntimeNativeToolCall>();

        using var response = await AgentRuntimeRequestTimeout.SendAsync(
            Http,
            request,
            provider,
            "OpenAI-compatible chat",
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw await AgentRuntimeProviderHttpException.CreateAsync(
                "OpenAI-compatible chat",
                response,
                provider,
                state.CancellationToken);
        }

        await using var responseStream = await response.Content.ReadAsStreamAsync(state.CancellationToken);
        using var reader = new StreamReader(responseStream, Encoding.UTF8);
        var dataBuilder = new StringBuilder();
        var rawResponseBuilder = new StringBuilder();
        var sawSsePayload = false;
        string? line;
        while ((line = await AgentRuntimeRequestTimeout.ReadLineAsync(
            reader,
            provider,
            "OpenAI-compatible chat",
            url,
            state.CancellationToken)) is not null)
        {
            if (state.CancellationToken.IsCancellationRequested)
            {
                break;
            }

            if (line.Length == 0)
            {
                if (dataBuilder.Length > 0)
                {
                    var shouldStop = await ProcessSseDataAsync(
                        dataBuilder.ToString(),
                        toolBuffers,
                        toolCalls,
                        assistantText,
                        reasoningText,
                        state,
                        context,
                        startedAt,
                        value => firstTokenMs ??= value,
                        value => estimatedOutputTokens += value,
                        () => reasoningStreamed = true,
                        value => finalUsage = value,
                        value => finalStopReason = value);
                    dataBuilder.Clear();
                    sawSsePayload = true;
                    if (shouldStop)
                    {
                        break;
                    }
                }
                continue;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (dataBuilder.Length > 0)
                {
                    dataBuilder.Append('\n');
                }
                dataBuilder.Append(line[5..].TrimStart());
                sawSsePayload = true;
                continue;
            }

            if (!sawSsePayload && !line.StartsWith("event:", StringComparison.Ordinal))
            {
                if (rawResponseBuilder.Length > 0)
                {
                    rawResponseBuilder.Append('\n');
                }
                rawResponseBuilder.Append(line);
            }
        }

        if (dataBuilder.Length > 0)
        {
            await ProcessSseDataAsync(
                dataBuilder.ToString(),
                toolBuffers,
                toolCalls,
                assistantText,
                reasoningText,
                state,
                context,
                startedAt,
                value => firstTokenMs ??= value,
                value => estimatedOutputTokens += value,
                () => reasoningStreamed = true,
                value => finalUsage = value,
                value => finalStopReason = value);
        }
        else if (!sawSsePayload && rawResponseBuilder.Length > 0)
        {
            WorkerLog.Debug(
                $"openai-compatible chat received non-sse response model={model} url={url}");
            await ProcessJsonResponseAsync(
                rawResponseBuilder.ToString(),
                toolCalls,
                assistantText,
                state,
                context,
                startedAt,
                value => firstTokenMs ??= value,
                value => estimatedOutputTokens += value,
                () => reasoningStreamed = true,
                value => finalUsage = value,
                value => finalStopReason = value);
        }

        FlushRemainingToolBuffers(toolBuffers, toolCalls);

        var totalMs = ElapsedMs(startedAt);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "message_end",
                StopReason: finalStopReason,
                Usage: finalUsage,
                Timing: new AgentRuntimeRequestTiming(
                    totalMs,
                    firstTokenMs,
                    AgentRuntimeThroughput.ComputeTps(
                        finalUsage,
                        estimatedOutputTokens,
                        reasoningStreamed,
                        usageIncludesReasoning: true,
                        firstTokenMs,
                        totalMs))));

        var assistantToolUses = toolCalls
            .Select(call => new AgentRuntimeChatToolUse(call.Id, call.Name, call.Input, call.ExtraContent))
            .ToList();
        return new AgentRuntimeProviderTurnResult(
            new AgentRuntimeChatMessage("assistant", assistantText.ToString(), assistantToolUses, []),
            toolCalls,
            finalStopReason,
            finalUsage);
    }

    private static async Task<bool> ProcessSseDataAsync(
        string data,
        Dictionary<int, ToolCallBuffer> toolBuffers,
        List<AgentRuntimeNativeToolCall> completedToolCalls,
        StringBuilder assistantText,
        StringBuilder reasoningText,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt,
        Action<long> markFirstTokenMs,
        Action<int> addEstimatedOutputTokens,
        Action markReasoningStreamed,
        Action<AgentRuntimeTokenUsage> setUsage,
        Action<string> setStopReason)
    {
        if (data == "[DONE]")
        {
            return true;
        }

        using var document = JsonDocument.Parse(data);
        var root = document.RootElement;
        if (root.TryGetProperty("usage", out var usageElement) &&
            TryReadUsage(usageElement, out var usage))
        {
            setUsage(usage);
        }

        var choice = TryGetFirstChoice(root);
        if (!choice.HasValue)
        {
            return false;
        }

        var choiceValue = choice.Value;
        if (choiceValue.TryGetProperty("delta", out var delta))
        {
            var reasoning = AgentRuntimeStreamDeltaCoalescer.TakeIncrement(
                reasoningText,
                ReadReasoningText(delta));
            if (!string.IsNullOrEmpty(reasoning))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                markReasoningStreamed();
                addEstimatedOutputTokens(EstimateTokenCount(reasoning));
                await AgentRuntimeTools.EmitProjectedAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("thinking_delta", Thinking: reasoning));
            }

            var text = AgentRuntimeStreamDeltaCoalescer.TakeIncrement(
                assistantText,
                ReadString(delta, "content"));
            if (!string.IsNullOrEmpty(text))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                addEstimatedOutputTokens(EstimateTokenCount(text));
                await AgentRuntimeTools.EmitProjectedAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("text_delta", Text: text));
            }

            if (delta.TryGetProperty("tool_calls", out var toolCalls) &&
                toolCalls.ValueKind == JsonValueKind.Array)
            {
                foreach (var fragment in toolCalls.EnumerateArray())
                {
                    await ProcessToolCallFragmentAsync(
                        fragment,
                        toolBuffers,
                        state,
                        context,
                        startedAt,
                        markFirstTokenMs,
                        addEstimatedOutputTokens);
                }
            }
        }

        var finishReason = ReadString(choiceValue, "finish_reason");
        if (string.IsNullOrEmpty(finishReason))
        {
            return false;
        }

        setStopReason(finishReason);
        if (finishReason is "tool_calls" or "function_call")
        {
            FlushRemainingToolBuffers(toolBuffers, completedToolCalls);
        }

        if (toolBuffers.Count > 0)
        {
            FlushRemainingToolBuffers(toolBuffers, completedToolCalls);
        }

        // OpenAI-compatible APIs commonly emit usage in a separate terminal
        // chunk after the chunk carrying finish_reason. Keep consuming until
        // [DONE] (or EOF) so that an empty choices array cannot hide usage.
        return false;
    }

    private static async Task ProcessJsonResponseAsync(
        string payload,
        List<AgentRuntimeNativeToolCall> completedToolCalls,
        StringBuilder assistantText,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt,
        Action<long> markFirstTokenMs,
        Action<int> addEstimatedOutputTokens,
        Action markReasoningStreamed,
        Action<AgentRuntimeTokenUsage> setUsage,
        Action<string> setStopReason)
    {
        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        if (root.TryGetProperty("usage", out var usageElement) &&
            TryReadUsage(usageElement, out var usage))
        {
            setUsage(usage);
        }

        var choice = TryGetFirstChoice(root);
        if (!choice.HasValue)
        {
            return;
        }

        var choiceValue = choice.Value;
        if (choiceValue.TryGetProperty("message", out var message) &&
            message.ValueKind == JsonValueKind.Object)
        {
            var reasoning = ReadReasoningText(message);
            if (!string.IsNullOrEmpty(reasoning))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                markReasoningStreamed();
                await AgentRuntimeTools.EmitProjectedAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("thinking_delta", Thinking: reasoning));
            }

            var text = ReadMessageContentText(message);
            if (!string.IsNullOrEmpty(text))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                addEstimatedOutputTokens(EstimateTokenCount(text));
                assistantText.Append(text);
                await AgentRuntimeTools.EmitProjectedAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("text_delta", Text: text));
            }

            if (message.TryGetProperty("tool_calls", out var toolCallsElement) &&
                toolCallsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var toolCallElement in toolCallsElement.EnumerateArray())
                {
                    if (TryCreateCompletedToolCall(toolCallElement, out var toolCall))
                    {
                        completedToolCalls.Add(toolCall);
                    }
                }
            }
        }

        setStopReason(ReadString(choiceValue, "finish_reason") ?? "stop");
    }

    private static async Task ProcessToolCallFragmentAsync(
        JsonElement fragment,
        Dictionary<int, ToolCallBuffer> toolBuffers,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt,
        Action<long> markFirstTokenMs,
        Action<int> addEstimatedOutputTokens)
    {
        // Tool-call fragments are generated output too: without this, tool-only
        // responses never get a first-token mark and report no TTFT/TPS at all.
        markFirstTokenMs(ElapsedMs(startedAt));

        var index = JsonHelpers.GetInt(fragment, "index", toolBuffers.Count);
        if (!toolBuffers.TryGetValue(index, out var buffer))
        {
            buffer = new ToolCallBuffer(index);
            toolBuffers[index] = buffer;
        }

        if (JsonHelpers.GetString(fragment, "id") is { Length: > 0 } id && string.IsNullOrEmpty(buffer.Id))
        {
            buffer.Id = id;
        }

        if (fragment.TryGetProperty("function", out var function) &&
            function.ValueKind == JsonValueKind.Object)
        {
            if (JsonHelpers.GetString(function, "name") is { Length: > 0 } name)
            {
                buffer.Name = name;
            }
            if (JsonHelpers.GetString(function, "arguments") is { } argumentsDelta)
            {
                addEstimatedOutputTokens(EstimateTokenCount(argumentsDelta));
                buffer.Arguments.Append(argumentsDelta);
            }
        }

        if (!buffer.Started && !string.IsNullOrEmpty(buffer.Id) && !string.IsNullOrEmpty(buffer.Name))
        {
            buffer.Started = true;
            await AgentRuntimeTools.EmitProjectedAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_streaming_start",
                    ToolCallId: buffer.Id,
                    ToolName: buffer.Name));
        }

        if (buffer.Started &&
            AgentRuntimeToolArgumentStreaming.TryGetInputForDelta(
                buffer.Arguments,
                buffer.ArgumentStream,
                out var partialInput))
        {
            await AgentRuntimeTools.EmitProjectedAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_args_delta",
                    ToolCallId: buffer.Id,
                    PartialInput: partialInput));
        }
    }

    private static void FlushRemainingToolBuffers(
        Dictionary<int, ToolCallBuffer> toolBuffers,
        List<AgentRuntimeNativeToolCall> completedToolCalls)
    {
        foreach (var buffer in toolBuffers.Values.OrderBy(item => item.Index))
        {
            var id = string.IsNullOrEmpty(buffer.Id)
                ? $"call_{buffer.Index}_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}"
                : buffer.Id;
            var name = buffer.Name;
            var rawArguments = buffer.Arguments.ToString();
            var parsed = TryParseJsonObject(rawArguments, out var parsedInput);
            var input = parsed
                ? parsedInput
                : CreateEmptyObjectElement();
            completedToolCalls.Add(new AgentRuntimeNativeToolCall(
                id,
                name,
                input,
                RawArguments: rawArguments,
                ParseError: parsed ? null : "Expected a valid JSON object."));
        }
        toolBuffers.Clear();
    }

    private static async Task<AgentRuntimeToolExecutionResult> ExecuteToolCallsAsync(
        JsonElement parameters,
        IReadOnlyList<AgentRuntimeNativeToolCall> toolCalls,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var toolResults = new List<AgentRuntimeToolResult>(toolCalls.Count);
        var hookContextTexts = new List<string>();
        var permissionPolicy = AgentRuntimePermissionPolicy.Resolve(parameters);
        var maxParallelTools = ReadMaxParallelTools(parameters);
        for (var index = 0; index < toolCalls.Count;)
        {
            if (IsParallelSubAgentTaskCall(toolCalls[index], parameters))
            {
                var blockStart = index;
                while (index < toolCalls.Count && IsParallelSubAgentTaskCall(toolCalls[index], parameters))
                {
                    index++;
                }

                var blockLength = index - blockStart;
                if (blockLength > 1)
                {
                    var blockResult = await ExecuteParallelSubAgentTaskBlockAsync(
                        parameters,
                        toolCalls
                            .Skip(blockStart)
                            .Take(blockLength)
                            .ToArray(),
                        state,
                        context);
                    toolResults.AddRange(blockResult.ToolResults);
                    hookContextTexts.AddRange(blockResult.HookContextTexts);
                    if (blockResult.ShouldStop)
                    {
                        break;
                    }
                    continue;
                }

                index = blockStart;
            }

            if (maxParallelTools > 1 &&
                IsReadParallelCall(toolCalls[index], parameters, permissionPolicy))
            {
                var blockStart = index;
                while (index < toolCalls.Count &&
                    IsReadParallelCall(toolCalls[index], parameters, permissionPolicy))
                {
                    index++;
                }

                var blockLength = index - blockStart;
                if (blockLength > 1)
                {
                    var blockResult = await ExecuteReadParallelBlockAsync(
                        parameters,
                        toolCalls
                            .Skip(blockStart)
                            .Take(blockLength)
                            .ToArray(),
                        maxParallelTools,
                        state,
                        context);
                    toolResults.AddRange(blockResult.ToolResults);
                    hookContextTexts.AddRange(blockResult.HookContextTexts);
                    if (blockResult.ShouldStop)
                    {
                        break;
                    }
                    continue;
                }

                index = blockStart;
            }

            var singleResult = await ExecuteSingleToolCallAsync(
                parameters,
                toolCalls[index],
                state,
                context);
            toolResults.Add(singleResult.ToolResult);
            hookContextTexts.AddRange(singleResult.HookContextTexts);
            index++;
            if (singleResult.ShouldStop)
            {
                break;
            }
        }

        return new AgentRuntimeToolExecutionResult(toolResults, hookContextTexts);
    }

    private static bool IsParallelSubAgentTaskCall(
        AgentRuntimeNativeToolCall call,
        JsonElement parameters)
    {
        // A nested parent cooperatively yields and reacquires its current slot around each Task.
        // Keep those calls serial so concurrent children cannot race the same parent lease.
        return !JsonHelpers.GetBool(parameters, "forceApproval", false) &&
            !JsonHelpers.GetBool(parameters, "subAgentConcurrencySlotInherited", false) &&
            AgentRuntimeSubAgentExecutor.IsTaskTool(call.Name) &&
            !JsonHelpers.GetBool(call.Input, "run_in_background", false);
    }

    private static async Task<AgentRuntimeParallelToolExecutionResult> ExecuteParallelSubAgentTaskBlockAsync(
        JsonElement parameters,
        IReadOnlyList<AgentRuntimeNativeToolCall> calls,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        WorkerLog.Debug(
            $"agent sub-agent parallel block runId={state.RunId} count={calls.Count} " +
            $"toolUseIds={string.Join(',', calls.Select(call => call.Id))}");
        var tasks = calls
            .Select(call => ExecuteSingleToolCallAsync(parameters, call, state, context))
            .ToArray();
        var results = await Task.WhenAll(tasks);
        return new AgentRuntimeParallelToolExecutionResult(
            results.Select(result => result.ToolResult).ToList(),
            results.SelectMany(result => result.HookContextTexts).ToList(),
            results.Any(result => result.ShouldStop));
    }

    private static int ReadMaxParallelTools(JsonElement parameters)
    {
        // Default 1 keeps hosts that never send the field on the historical serial path.
        return Math.Clamp(
            JsonHelpers.GetInt(parameters, "maxParallelTools", 1),
            1,
            MaxParallelToolsCeiling);
    }

    /// <summary>
    /// A call is safe to run inside a read-parallel batch when the Capability Snapshot classifies
    /// it as readParallel and it needs no approval. Excluding approvals keeps a batch from opening
    /// several concurrent reverse requests, and it also covers forceApproval and SSH-routed reads,
    /// both of which ComputeRequiresApproval already accounts for.
    /// </summary>
    private static bool IsReadParallelCall(
        AgentRuntimeNativeToolCall call,
        JsonElement parameters,
        AgentRuntimePermissionPolicy permissionPolicy)
    {
        if (!string.Equals(
                AgentRuntimeCapabilityPolicy.ResolveParallelClass(parameters, call.Name),
                "readParallel",
                StringComparison.Ordinal))
        {
            return false;
        }

        var nativeTool = AgentRuntimeNativeToolExecutor.CanExecute(call.Name, parameters);
        return !ComputeRequiresApproval(parameters, call, nativeTool, permissionPolicy);
    }

    private static async Task<AgentRuntimeParallelToolExecutionResult> ExecuteReadParallelBlockAsync(
        JsonElement parameters,
        IReadOnlyList<AgentRuntimeNativeToolCall> calls,
        int maxParallelTools,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var degree = Math.Min(maxParallelTools, calls.Count);
        WorkerLog.Debug(
            $"agent read parallel block runId={state.RunId} count={calls.Count} degree={degree} " +
            $"toolUseIds={string.Join(',', calls.Select(call => call.Id))}");
        // Leave "receiving parameters" as soon as the provider turn is done. Waiting
        // tools otherwise stay on streaming until their semaphore slot starts, which
        // looks like a hang when several Reads are in flight.
        await AnnounceToolCallsAsync(calls, state, context);
        using var slots = new SemaphoreSlim(degree, degree);
        var tasks = calls
            .Select(async call =>
            {
                await slots.WaitAsync(state.CancellationToken);
                try
                {
                    return await ExecuteSingleToolCallAsync(parameters, call, state, context);
                }
                finally
                {
                    slots.Release();
                }
            })
            .ToArray();
        // WhenAll preserves input order, so tool results still line up with the Provider's
        // tool_call order regardless of which read finished first.
        var results = await Task.WhenAll(tasks);
        return new AgentRuntimeParallelToolExecutionResult(
            results.Select(result => result.ToolResult).ToList(),
            results.SelectMany(result => result.HookContextTexts).ToList(),
            results.Any(result => result.ShouldStop));
    }

    private static async Task AnnounceToolCallsAsync(
        IReadOnlyList<AgentRuntimeNativeToolCall> calls,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        foreach (var call in calls)
        {
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_generated",
                    ToolUseBlock: new AgentRuntimeToolUseBlock(
                        call.Id,
                        call.Name,
                        call.Input,
                        call.ExtraContent)));
        }
    }

    private static bool ComputeRequiresApproval(
        JsonElement parameters,
        AgentRuntimeNativeToolCall call,
        bool nativeTool,
        AgentRuntimePermissionPolicy permissionPolicy)
    {
        // forceApproval is an explicit per-run escalation and beats full access / the whitelist;
        // the deny branch in ExecuteSingleToolCallAsync beats every approval-skip mode.
        if (JsonHelpers.GetBool(parameters, "forceApproval", false))
        {
            return true;
        }
        if (string.Equals(
                JsonHelpers.GetString(parameters, "permissionMode"),
                "fullAccess",
                StringComparison.Ordinal))
        {
            return false;
        }
        if (!nativeTool)
        {
            return false;
        }
        if (!AgentRuntimeNativeToolExecutor.RequiresApproval(call.Name, call.Input, parameters))
        {
            return false;
        }
        return !permissionPolicy.SkipsApproval(call.Name, call.Input);
    }

    private static async Task<AgentRuntimeSingleToolExecutionResult> ExecuteSingleToolCallAsync(
        JsonElement parameters,
        AgentRuntimeNativeToolCall originalCall,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var hookContextTexts = new List<string>();
        var call = originalCall;
        var authorization = AgentRuntimeCapabilityPolicy.Resolve(parameters, call.Name);
        if (!authorization.Authorized || !authorization.Visible)
        {
            if (AgentRuntimeSubAgentExecutor.IsTaskTool(call.Name) &&
                AgentRuntimeSubAgentExecutor.IsSubAgentRun(parameters))
            {
                state.RequestStop("error");
            }
            return await RejectToolCallBeforeExecutionAsync(
                call,
                authorization.ErrorCode ?? "tool_not_authorized",
                authorization.ErrorMessage ?? $"Tool '{call.Name}' is not authorized.",
                state,
                context);
        }
        if (!string.IsNullOrWhiteSpace(call.ParseError))
        {
            WorkerLog.Warn(
                $"agent tool arguments rejected runId={state.RunId} tool={call.Name} id={call.Id} " +
                $"rawLength={call.RawArguments?.Length ?? 0}");
            return await RejectToolCallBeforeExecutionAsync(
                call,
                "invalid_tool_arguments",
                $"Tool '{call.Name}' arguments are not valid JSON: {call.ParseError}",
                state,
                context);
        }
        var inputSchema = authorization.InputSchema!.Value;
        call = call with
        {
            Input = AgentRuntimeToolInputNormalizer.Normalize(call.Name, inputSchema, call.Input)
        };
        var validation = AgentRuntimeToolSchemaValidator.Validate(inputSchema, call.Input);
        if (!validation.Valid)
        {
            return await RejectToolCallBeforeExecutionAsync(
                call,
                "invalid_tool_arguments",
                $"Tool '{call.Name}' arguments failed validation at {validation.Path}: " +
                    validation.Message,
                state,
                context);
        }
        var nativeTool = AgentRuntimeNativeToolExecutor.CanExecute(call.Name, parameters);
        WorkerLog.Debug(
            $"agent tool dispatch runId={state.RunId} tool={call.Name} id={call.Id} " +
            $"executionPath={(nativeTool ? "native-aot" : "native-missing")}");
        var permissionPolicy = AgentRuntimePermissionPolicy.Resolve(parameters);
        var requiresApproval = ComputeRequiresApproval(parameters, call, nativeTool, permissionPolicy);

        var preHook = await AgentRuntimeHooks.RunPreToolUseAsync(
            parameters,
            state,
            context,
            call,
            requiresApproval);
        AppendHookContextText(hookContextTexts, preHook);
        if (preHook.UpdatedInput.HasValue && preHook.UpdatedInput.Value.ValueKind == JsonValueKind.Object)
        {
            call = call with
            {
                Input = AgentRuntimeToolInputNormalizer.Normalize(
                    call.Name,
                    inputSchema,
                    preHook.UpdatedInput.Value)
            };
            validation = AgentRuntimeToolSchemaValidator.Validate(inputSchema, call.Input);
            if (!validation.Valid)
            {
                return await RejectToolCallBeforeExecutionAsync(
                    call,
                    "invalid_tool_arguments",
                    $"PreToolUse produced invalid arguments at {validation.Path}: {validation.Message}",
                    state,
                    context,
                    hookContextTexts);
            }
            nativeTool = AgentRuntimeNativeToolExecutor.CanExecute(call.Name, parameters);
            requiresApproval = ComputeRequiresApproval(parameters, call, nativeTool, permissionPolicy);
        }
        var pendingCall = new AgentRuntimeToolCallState(
            call.Id,
            call.Name,
            call.Input,
            requiresApproval ? "pending_approval" : "running",
            RequiresApproval: requiresApproval);

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_use_generated",
                ToolUseBlock: new AgentRuntimeToolUseBlock(
                    call.Id,
                    call.Name,
                    call.Input,
                    call.ExtraContent)));

        // Blacklist verdict is computed on the FINAL input (post PreToolUse UpdatedInput) and
        // takes precedence over everything, including forceApproval and renderer autoApprove.
        var permissionDenyReason = permissionPolicy.EvaluateDenyReason(call.Name, call.Input);
        if (permissionDenyReason is not null)
        {
            return await EmitFormattedToolErrorAsync(
                call,
                permissionDenyReason,
                requiresApproval,
                state,
                context,
                hookContextTexts,
                shouldStop: false);
        }

        if (preHook.Blocked)
        {
            return await EmitFormattedToolErrorAsync(
                call,
                preHook.Reason ?? "Blocked by PreToolUse hook",
                requiresApproval,
                state,
                context,
                hookContextTexts,
                shouldStop: true);
        }

        if (requiresApproval)
        {
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent("tool_call_approval_needed", ToolCall: pendingCall));

            var approval = await RequestApprovalAsync(parameters, pendingCall, state, context);
            if (!approval.Approved)
            {
                return await EmitFormattedToolErrorAsync(
                    call,
                    approval.Reason ?? "Permission denied by user",
                    true,
                    state,
                    context,
                    hookContextTexts,
                    shouldStop: false);
            }
        }

        var startedAt = NowMs();
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_call_start",
                ToolCall: new AgentRuntimeToolCallState(
                    call.Id,
                    call.Name,
                    call.Input,
                    "running",
                    RequiresApproval: requiresApproval,
                    StartedAt: startedAt)));

        var nestedSubAgentTask =
            AgentRuntimeSubAgentExecutor.IsTaskTool(call.Name) &&
            AgentRuntimeSubAgentExecutor.IsSubAgentRun(parameters);
        RendererToolResult result;
        if (nestedSubAgentTask)
        {
            var message = AgentRuntimeSubAgentExecutor.NestedTaskDeniedMessage;
            // A provider can still emit an unadvertised tool call. Stop the leaf run
            // immediately instead of returning a generic missing-tool error that may
            // cause the model to retry delegation for hundreds of iterations.
            state.RequestStop("error");
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "error",
                    Message: message,
                    ErrorType: "subagent_task_denied"));
            result = AgentRuntimeToolError.Failed(message, call.Name, AgentRuntimeToolError.TryGetPath(call.Input));
        }
        else
        {
            result = nativeTool
                ? await AgentRuntimeNativeToolExecutor.ExecuteAsync(
                    new NativeToolCallView(call.Id, call.Name, call.Input),
                    parameters,
                    state,
                    context,
                    state.CancellationToken)
                : CreateMissingNativeToolResult(call.Name);
        }
        var toolPath = AgentRuntimeToolError.TryGetPath(call.Input);
        var completedAt = NowMs();
        var status = result.IsError ? "error" : "completed";
        var boundedContent = LimitToolResultContent(result.Content);
        var hookToolResponse = RemoveImageDataForHookPayload(boundedContent);
        var postHook = await AgentRuntimeHooks.RunPostToolUseAsync(
            parameters,
            state,
            context,
            call,
            hookToolResponse,
            result.IsError);
        AppendHookContextText(hookContextTexts, postHook);
        if (postHook.ReplacementToolFeedback.HasValue)
        {
            boundedContent = LimitToolResultContent(postHook.ReplacementToolFeedback.Value);
            result = AgentRuntimeToolError.SanitizeLeakedKeys(
                result with { Content = boundedContent, IsError = false, Error = null },
                call.Name,
                toolPath);
            boundedContent = result.Content;
            status = "completed";
        }
        if (postHook.Blocked)
        {
            result = AgentRuntimeToolError.Failed(
                postHook.Reason ?? "Blocked by PostToolUse hook",
                call.Name,
                toolPath);
            boundedContent = result.Content;
            status = "error";
        }
        else if (!postHook.ReplacementToolFeedback.HasValue)
        {
            result = AgentRuntimeToolError.Normalize(
                result with { Content = boundedContent },
                call.Name,
                toolPath);
            boundedContent = result.Content;
            if (result.IsError)
            {
                status = "error";
            }
        }
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_call_result",
                ToolCall: new AgentRuntimeToolCallState(
                    call.Id,
                    call.Name,
                    call.Input,
                    status,
                    boundedContent,
                    result.Error,
                    requiresApproval,
                    startedAt,
                    completedAt)));
        return new AgentRuntimeSingleToolExecutionResult(
            new AgentRuntimeToolResult(
                call.Id,
                boundedContent,
                result.IsError ? true : null),
            hookContextTexts,
            nestedSubAgentTask || postHook.Blocked);
    }

    private static async Task<AgentRuntimeSingleToolExecutionResult> EmitFormattedToolErrorAsync(
        AgentRuntimeNativeToolCall call,
        string message,
        bool requiresApproval,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        List<string>? hookContextTexts,
        bool shouldStop)
    {
        var formatted = AgentRuntimeToolError.Format(
            message,
            call.Name,
            AgentRuntimeToolError.TryGetPath(call.Input));
        var content = CreateStringElement(formatted.Content);
        var failedAt = NowMs();
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_call_result",
                ToolCall: new AgentRuntimeToolCallState(
                    call.Id,
                    call.Name,
                    call.Input,
                    "error",
                    content,
                    formatted.Display,
                    requiresApproval,
                    failedAt,
                    failedAt)));
        return new AgentRuntimeSingleToolExecutionResult(
            new AgentRuntimeToolResult(call.Id, content, true),
            hookContextTexts ?? [],
            shouldStop);
    }

    private static async Task<AgentRuntimeSingleToolExecutionResult> RejectToolCallBeforeExecutionAsync(
        AgentRuntimeNativeToolCall call,
        string code,
        string message,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        List<string>? hookContextTexts = null)
    {
        var formatted = AgentRuntimeToolError.Format(
            $"{code}: {message}",
            call.Name,
            AgentRuntimeToolError.TryGetPath(call.Input));
        var content = CreateStringElement(formatted.Content);
        var rejectedAt = NowMs();
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_use_generated",
                ToolUseBlock: new AgentRuntimeToolUseBlock(
                    call.Id,
                    call.Name,
                    call.Input,
                    call.ExtraContent)),
            new AgentRuntimeStreamEvent(
                "tool_call_result",
                ToolCall: new AgentRuntimeToolCallState(
                    call.Id,
                    call.Name,
                    call.Input,
                    "error",
                    content,
                    formatted.Display,
                    false,
                    rejectedAt,
                    rejectedAt)));
        return new AgentRuntimeSingleToolExecutionResult(
            new AgentRuntimeToolResult(call.Id, content, true),
            hookContextTexts ?? [],
            false);
    }

    private static void AppendHookContextText(List<string> target, AgentRuntimeHookResult hookResult)
    {
        if (!hookResult.HasContext)
        {
            return;
        }

        var lines = new List<string> { "<hook-context>" };
        foreach (var systemMessage in hookResult.SystemMessages)
        {
            if (!string.IsNullOrWhiteSpace(systemMessage))
            {
                lines.Add("<system-message>");
                lines.Add(systemMessage.Trim());
                lines.Add("</system-message>");
            }
        }
        foreach (var additionalContext in hookResult.AdditionalContext)
        {
            if (!string.IsNullOrWhiteSpace(additionalContext))
            {
                lines.Add("<additional-context>");
                lines.Add(additionalContext.Trim());
                lines.Add("</additional-context>");
            }
        }
        lines.Add("</hook-context>");
        target.Add(string.Join("\n", lines));
    }

    private static async Task<ApprovalDecision> RequestApprovalAsync(
        JsonElement parameters,
        AgentRuntimeToolCallState toolCall,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        _ = parameters;
        var request = JsonSerializer.SerializeToElement(
            new AgentRuntimeApprovalRequest(state.RunId, state.SessionId, toolCall),
            WorkerJsonContext.Default.AgentRuntimeApprovalRequest);
        var result = await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "approval/request",
            request,
            state.CancellationToken);
        return new ApprovalDecision(
            JsonHelpers.GetBool(result, "approved", false),
            JsonHelpers.GetString(result, "reason"));
    }

    private sealed record ApprovalDecision(bool Approved, string? Reason);

    private sealed record AgentRuntimeToolExecutionResult(
        List<AgentRuntimeToolResult> ToolResults,
        List<string> HookContextTexts);

    private sealed record AgentRuntimeParallelToolExecutionResult(
        List<AgentRuntimeToolResult> ToolResults,
        List<string> HookContextTexts,
        bool ShouldStop);

    private sealed record AgentRuntimeSingleToolExecutionResult(
        AgentRuntimeToolResult ToolResult,
        List<string> HookContextTexts,
        bool ShouldStop);

    private static RendererToolResult CreateMissingNativeToolResult(string toolName)
    {
        return AgentRuntimeToolError.Failed($"Native tool not registered: {toolName}", toolName);
    }

    private static JsonElement CreateAssistantWireMessage(
        AgentRuntimeChatMessage message,
        AgentRuntimeTokenUsage? usage)
    {
        return CreateObjectElement(writer =>
        {
            writer.WriteString("id", NewMessageId());
            writer.WriteString("role", "assistant");
            writer.WritePropertyName("content");
            WriteAssistantWireContent(writer, message);
            writer.WriteNumber("createdAt", NowMs());
            if (!string.IsNullOrWhiteSpace(message.ProviderResponseId))
            {
                writer.WriteString("providerResponseId", message.ProviderResponseId);
            }
            if (usage is not null)
            {
                writer.WritePropertyName("usage");
                WriteUsage(writer, usage);
            }
        });
    }

    private static JsonElement CreateToolResultsWireMessage(IReadOnlyList<AgentRuntimeToolResult> toolResults)
    {
        return CreateObjectElement(writer =>
        {
            writer.WriteString("id", NewMessageId());
            writer.WriteString("role", "user");
            writer.WritePropertyName("content");
            writer.WriteStartArray();
            foreach (var result in toolResults)
            {
                writer.WriteStartObject();
                writer.WriteString("type", "tool_result");
                writer.WriteString("toolUseId", result.ToolUseId);
                writer.WritePropertyName("content");
                result.Content.WriteTo(writer);
                if (result.IsError.HasValue)
                {
                    writer.WriteBoolean("isError", result.IsError.Value);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteNumber("createdAt", NowMs());
        });
    }

    private static JsonElement CreateUserTextWireMessage(string text)
    {
        return CreateObjectElement(writer =>
        {
            writer.WriteString("id", NewMessageId());
            writer.WriteString("role", "user");
            writer.WriteString("content", text);
            writer.WriteNumber("createdAt", NowMs());
        });
    }

    private static void WriteAssistantWireContent(Utf8JsonWriter writer, AgentRuntimeChatMessage message)
    {
        if (message.ContentBlocks is { Count: > 0 } contentBlocks)
        {
            writer.WriteStartArray();
            foreach (var block in contentBlocks)
            {
                block.WriteTo(writer);
            }
            writer.WriteEndArray();
            return;
        }

        if (message.ToolUses.Count == 0)
        {
            writer.WriteStringValue(message.Text);
            return;
        }

        writer.WriteStartArray();
        if (!string.IsNullOrEmpty(message.Text))
        {
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString("text", message.Text);
            writer.WriteEndObject();
        }
        foreach (var toolUse in message.ToolUses)
        {
            writer.WriteStartObject();
            writer.WriteString("type", "tool_use");
            writer.WriteString("id", toolUse.Id);
            writer.WriteString("name", toolUse.Name);
            writer.WritePropertyName("input");
            toolUse.Input.WriteTo(writer);
            WriteOptionalJsonProperty(writer, "extraContent", toolUse.ExtraContent);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    private static void WriteUsage(Utf8JsonWriter writer, AgentRuntimeTokenUsage usage)
    {
        writer.WriteStartObject();
        writer.WriteNumber("inputTokens", usage.InputTokens);
        writer.WriteNumber("outputTokens", usage.OutputTokens);
        WriteOptionalNumber(writer, "billableInputTokens", usage.BillableInputTokens);
        WriteOptionalNumber(writer, "cacheReadTokens", usage.CacheReadTokens);
        WriteOptionalNumber(writer, "reasoningTokens", usage.ReasoningTokens);
        WriteOptionalNumber(writer, "contextTokens", usage.ContextTokens);
        WriteOptionalNumber(writer, "cacheCreationTokens", usage.CacheCreationTokens);
        WriteOptionalNumber(writer, "cacheCreation5mTokens", usage.CacheCreation5mTokens);
        WriteOptionalNumber(writer, "cacheCreation1hTokens", usage.CacheCreation1hTokens);
        if (usage.CacheReadRatio.HasValue)
        {
            writer.WriteNumber("cacheReadRatio", usage.CacheReadRatio.Value);
        }
        writer.WriteEndObject();
    }

    private static void WriteOptionalNumber(Utf8JsonWriter writer, string propertyName, int? value)
    {
        if (!value.HasValue) return;
        writer.WriteNumber(propertyName, value.Value);
    }

    private static void WriteOptionalJsonProperty(Utf8JsonWriter writer, string propertyName, JsonElement? value)
    {
        if (!value.HasValue || value.Value.ValueKind == JsonValueKind.Undefined) return;
        writer.WritePropertyName(propertyName);
        value.Value.WriteTo(writer);
    }

    private static string BuildRequestBody(
        JsonElement parameters,
        JsonElement provider,
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var buffer = new ArrayBufferWriter<byte>();
        var promptCacheState = AgentRuntimeOpenAIPromptCache.CreateState(
            provider,
            enabledByDefault: false);
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = GetOmittedBodyKeys(provider);
            AgentRuntimeOpenAIPromptCache.SuppressWireCacheMarkers(omitted);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            if (!omitted.Contains("messages"))
            {
                writer.WritePropertyName("messages");
                WriteMessages(writer, conversation, provider, promptCacheState);
            }
            if (!omitted.Contains("stream"))
            {
                writer.WriteBoolean("stream", true);
            }
            if (!omitted.Contains("stream_options"))
            {
                writer.WritePropertyName("stream_options");
                writer.WriteStartObject();
                writer.WriteBoolean("include_usage", true);
                writer.WriteEndObject();
            }
            if (!omitted.Contains("tools"))
            {
                WriteTools(writer, parameters);
            }

            if (!omitted.Contains("temperature") &&
                JsonHelpers.GetDoubleNullable(provider, "temperature") is { } temperature)
            {
                writer.WriteNumber("temperature", temperature);
            }

            if (JsonHelpers.GetIntNullable(provider, "maxTokens") is { } maxTokens && maxTokens > 0)
            {
                var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
                var maxTokensKey = IsReasoningModel(model) ? "max_completion_tokens" : "max_tokens";
                if (!omitted.Contains(maxTokensKey))
                {
                    writer.WriteNumber(maxTokensKey, maxTokens);
                }
            }

            if (!omitted.Contains("service_tier") &&
                JsonHelpers.GetString(provider, "serviceTier") is { Length: > 0 } serviceTier)
            {
                writer.WriteString("service_tier", serviceTier);
            }

            if (!omitted.Contains("prompt_cache_key") &&
                TryWritePromptCacheKey(writer, provider))
            {
                omitted.Add("prompt_cache_key");
            }
            AgentRuntimeOpenAIPromptCache.WriteRequestControls(
                writer,
                provider,
                omitted,
                promptCacheState);
            WriteThinkingConfig(writer, provider, omitted);
            ApplyBodyOverrides(writer, provider, omitted);

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteMessages(
        Utf8JsonWriter writer,
        IReadOnlyList<AgentRuntimeChatMessage> messages,
        JsonElement provider,
        AgentRuntimeOpenAIPromptCacheState promptCacheState)
    {
        writer.WriteStartArray();
        if (JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
        {
            writer.WriteStartObject();
            writer.WriteString("role", "system");
            writer.WritePropertyName("content");
            if (promptCacheState.TryUseExplicitBreakpoint())
            {
                writer.WriteStartArray();
                WriteChatTextPart(writer, systemPrompt, includePromptCacheBreakpoint: true);
                writer.WriteEndArray();
            }
            else
            {
                writer.WriteStringValue(systemPrompt);
            }
            writer.WriteEndObject();
        }

        for (var messageIndex = 0; messageIndex < messages.Count; messageIndex++)
        {
            var message = messages[messageIndex];
            if (message.Role == "system")
            {
                continue;
            }

            foreach (var toolResult in message.ToolResults)
            {
                writer.WriteStartObject();
                writer.WriteString("role", "tool");
                writer.WriteString("tool_call_id", toolResult.ToolUseId);
                writer.WritePropertyName("content");
                WriteToolResultContent(writer, toolResult.Content);
                writer.WriteEndObject();
            }

            if (message.Role == "user")
            {
                var allowPromptCacheBreakpoint = messageIndex < messages.Count - 1;
                // Array-form content is required to carry images, but some OpenAI-compatible
                // providers handle a plain string better, so text-only turns keep the string
                // form unless prompt-cache breakpoints need the parts shape anyway.
                if (message.ContentBlocks is { Count: > 0 } blocks &&
                    (promptCacheState.SupportsPromptCacheOptions ||
                        AgentRuntimeProviderSupport.HasImageBlock(blocks)) &&
                    WriteChatUserPartsMessage(
                        writer,
                        blocks,
                        allowPromptCacheBreakpoint,
                        promptCacheState))
                {
                    continue;
                }

                if (!string.IsNullOrWhiteSpace(message.Text))
                {
                    WriteChatTextMessage(
                        writer,
                        "user",
                        message.Text,
                        allowPromptCacheBreakpoint &&
                        promptCacheState.TryUseExplicitBreakpoint());
                }
                continue;
            }

            if (message.Role == "assistant")
            {
                if (string.IsNullOrWhiteSpace(message.Text) && message.ToolUses.Count == 0)
                {
                    continue;
                }

                writer.WriteStartObject();
                writer.WriteString("role", "assistant");
                if (string.IsNullOrWhiteSpace(message.Text))
                {
                    writer.WriteNull("content");
                }
                else
                {
                    writer.WriteString("content", message.Text);
                }

                if (message.ToolUses.Count > 0)
                {
                    writer.WritePropertyName("tool_calls");
                    writer.WriteStartArray();
                    foreach (var toolUse in message.ToolUses)
                    {
                        writer.WriteStartObject();
                        writer.WriteString("id", toolUse.Id);
                        writer.WriteString("type", "function");
                        writer.WritePropertyName("function");
                        writer.WriteStartObject();
                        writer.WriteString("name", toolUse.Name);
                        writer.WriteString("arguments", toolUse.Input.GetRawText());
                        writer.WriteEndObject();
                        writer.WriteEndObject();
                    }
                    writer.WriteEndArray();
                }

                writer.WriteEndObject();
            }
        }

        writer.WriteEndArray();
    }

    private static void WriteChatTextMessage(
        Utf8JsonWriter writer,
        string role,
        string text,
        bool includePromptCacheBreakpoint)
    {
        writer.WriteStartObject();
        writer.WriteString("role", role);
        writer.WritePropertyName("content");
        if (includePromptCacheBreakpoint && role == "user")
        {
            writer.WriteStartArray();
            WriteChatTextPart(writer, text, includePromptCacheBreakpoint: true);
            writer.WriteEndArray();
        }
        else
        {
            writer.WriteStringValue(text);
        }
        writer.WriteEndObject();
    }

    private static bool WriteChatUserPartsMessage(
        Utf8JsonWriter writer,
        IReadOnlyList<JsonElement> blocks,
        bool allowPromptCacheBreakpoint,
        AgentRuntimeOpenAIPromptCacheState promptCacheState)
    {
        var parts = new List<JsonElement>();
        foreach (var block in blocks)
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                    parts.Add(block);
                    break;
                case "image":
                    if (block.TryGetProperty("source", out var source) &&
                        source.ValueKind == JsonValueKind.Object)
                    {
                        parts.Add(block);
                    }
                    break;
            }
        }
        if (parts.Count == 0)
        {
            return false;
        }

        writer.WriteStartObject();
        writer.WriteString("role", "user");
        writer.WritePropertyName("content");
        writer.WriteStartArray();
        var breakpointPartIndex = allowPromptCacheBreakpoint ? parts.Count - 1 : -1;
        for (var index = 0; index < parts.Count; index++)
        {
            var part = parts[index];
            var includeBreakpoint =
                index == breakpointPartIndex &&
                promptCacheState.TryUseExplicitBreakpoint();
            if (JsonHelpers.GetString(part, "type") == "text")
            {
                WriteChatTextPart(
                    writer,
                    JsonHelpers.GetString(part, "text") ?? string.Empty,
                    includeBreakpoint);
                continue;
            }
            WriteChatImagePart(writer, part, includeBreakpoint);
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
        return true;
    }

    private static void WriteChatTextPart(
        Utf8JsonWriter writer,
        string text,
        bool includePromptCacheBreakpoint)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "text");
        writer.WriteString("text", text);
        if (includePromptCacheBreakpoint)
        {
            AgentRuntimeOpenAIPromptCache.WriteExplicitBreakpoint(writer);
        }
        writer.WriteEndObject();
    }

    private static void WriteChatImagePart(
        Utf8JsonWriter writer,
        JsonElement block,
        bool includePromptCacheBreakpoint)
    {
        if (!block.TryGetProperty("source", out var source) ||
            source.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var imageUrl = BuildChatImageUrl(source);
        if (string.IsNullOrWhiteSpace(imageUrl))
        {
            imageUrl = JsonHelpers.GetString(source, "filePath") is { Length: > 0 } filePath
                ? $"[image] {filePath}"
                : "[image]";
            WriteChatTextPart(writer, imageUrl, includePromptCacheBreakpoint);
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "image_url");
        writer.WritePropertyName("image_url");
        writer.WriteStartObject();
        writer.WriteString("url", imageUrl);
        writer.WriteEndObject();
        if (includePromptCacheBreakpoint)
        {
            AgentRuntimeOpenAIPromptCache.WriteExplicitBreakpoint(writer);
        }
        writer.WriteEndObject();
    }

    private static string BuildChatImageUrl(JsonElement source)
    {
        var sourceType = JsonHelpers.GetString(source, "type");
        if (sourceType == "url")
        {
            return JsonHelpers.GetString(source, "url") ?? string.Empty;
        }
        if (sourceType != "base64")
        {
            return string.Empty;
        }

        var data = JsonHelpers.GetString(source, "data");
        if (string.IsNullOrWhiteSpace(data))
        {
            return string.Empty;
        }
        var mediaType = JsonHelpers.GetString(source, "mediaType") ??
            AgentRuntimeProviderSupport.DetectImageMediaTypeFromBase64(data) ??
            "image/png";
        return $"data:{mediaType};base64,{AgentRuntimeProviderSupport.StripDataUrlPrefix(data)}";
    }

    private static void WriteToolResultContent(Utf8JsonWriter writer, JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            writer.WriteStringValue(content.GetString() ?? string.Empty);
            return;
        }

        writer.WriteStringValue(content.GetRawText());
    }

    private static JsonElement LimitToolResultContent(JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            var text = content.GetString() ?? string.Empty;
            return text.Length <= ToolResultMaxChars
                ? content.Clone()
                : CreateStringElement(TruncatePreservingEdges(text, ToolResultMaxChars));
        }

        if (content.ValueKind == JsonValueKind.Array)
        {
            return LimitArrayToolResultContent(content);
        }

        var raw = content.GetRawText();
        return raw.Length <= ToolResultMaxChars
            ? content.Clone()
            : CreateStringElement(TruncatePreservingEdges(raw, ToolResultMaxChars));
    }

    private static JsonElement LimitArrayToolResultContent(JsonElement content)
    {
        var raw = content.GetRawText();
        if (raw.Length <= ToolResultMaxChars)
        {
            return content.Clone();
        }

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            var writtenTextChars = 0;
            var truncated = false;

            foreach (var block in content.EnumerateArray())
            {
                if (writtenTextChars >= ToolResultMaxChars)
                {
                    truncated = true;
                    break;
                }

                if (TryWriteLimitedTextBlock(writer, block, ref writtenTextChars))
                {
                    continue;
                }

                if (TryWriteLimitedImageBlock(writer, block))
                {
                    continue;
                }

                var blockText = block.GetRawText();
                var remaining = Math.Max(0, ToolResultMaxChars - writtenTextChars);
                writer.WriteStartObject();
                writer.WriteString("type", "text");
                writer.WriteString("text", TruncatePreservingEdges(blockText, remaining));
                writer.WriteEndObject();
                writtenTextChars += Math.Min(blockText.Length, remaining);
                truncated = blockText.Length > remaining;
                if (truncated)
                {
                    break;
                }
            }

            if (truncated)
            {
                writer.WriteStartObject();
                writer.WriteString("type", "text");
                writer.WriteString("text", $"[tool result truncated, {raw.Length} JSON chars total]");
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static JsonElement RemoveImageDataForHookPayload(JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Array || !ArrayContainsImageData(content))
        {
            return content.Clone();
        }

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            foreach (var block in content.EnumerateArray())
            {
                if (TryWriteHookImageBlock(writer, block))
                {
                    continue;
                }
                block.WriteTo(writer);
            }
            writer.WriteEndArray();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static bool ArrayContainsImageData(JsonElement content)
    {
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind == JsonValueKind.Object &&
                JsonHelpers.GetString(block, "type") == "image" &&
                block.TryGetProperty("source", out var source) &&
                source.ValueKind == JsonValueKind.Object &&
                source.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.String)
            {
                return true;
            }
        }
        return false;
    }

    private static bool TryWriteHookImageBlock(Utf8JsonWriter writer, JsonElement block)
    {
        if (block.ValueKind != JsonValueKind.Object ||
            JsonHelpers.GetString(block, "type") != "image" ||
            !block.TryGetProperty("source", out var source) ||
            source.ValueKind != JsonValueKind.Object ||
            !source.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        var hasExternalLocator =
            (source.TryGetProperty("filePath", out var filePathElement) &&
                filePathElement.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(filePathElement.GetString())) ||
            (source.TryGetProperty("url", out var urlElement) &&
                urlElement.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(urlElement.GetString()));
        var persistedFilePath = hasExternalLocator ? null : TryPersistToolResultImage(source);

        writer.WriteStartObject();
        foreach (var property in block.EnumerateObject())
        {
            if (!property.NameEquals("source"))
            {
                property.WriteTo(writer);
                continue;
            }

            writer.WritePropertyName("source");
            writer.WriteStartObject();
            foreach (var sourceProperty in source.EnumerateObject())
            {
                if (sourceProperty.NameEquals("data"))
                {
                    continue;
                }
                sourceProperty.WriteTo(writer);
            }
            if (!string.IsNullOrWhiteSpace(persistedFilePath))
            {
                writer.WriteString("filePath", persistedFilePath);
            }
            writer.WriteBoolean("dataOmitted", true);
            writer.WriteEndObject();
        }
        writer.WriteEndObject();
        return true;
    }

    private static bool TryWriteLimitedTextBlock(
        Utf8JsonWriter writer,
        JsonElement block,
        ref int writtenTextChars)
    {
        if (block.ValueKind != JsonValueKind.Object ||
            !block.TryGetProperty("type", out var type) ||
            type.ValueKind != JsonValueKind.String ||
            type.GetString() != "text" ||
            !block.TryGetProperty("text", out var textElement) ||
            textElement.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        var text = textElement.GetString() ?? string.Empty;
        var remaining = Math.Max(0, ToolResultMaxChars - writtenTextChars);
        var maxBlockChars = Math.Min(ToolResultTextBlockMaxChars, remaining);
        writer.WriteStartObject();
        foreach (var property in block.EnumerateObject())
        {
            if (property.NameEquals("text"))
            {
                writer.WriteString("text", TruncatePreservingEdges(text, maxBlockChars));
                continue;
            }
            property.WriteTo(writer);
        }
        writer.WriteEndObject();
        writtenTextChars += Math.Min(text.Length, maxBlockChars);
        return true;
    }

    private static bool TryWriteLimitedImageBlock(Utf8JsonWriter writer, JsonElement block)
    {
        if (block.ValueKind != JsonValueKind.Object ||
            !block.TryGetProperty("type", out var type) ||
            type.ValueKind != JsonValueKind.String ||
            type.GetString() != "image" ||
            !block.TryGetProperty("source", out var source) ||
            source.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var dataChars = source.TryGetProperty("data", out var dataElement) &&
            dataElement.ValueKind == JsonValueKind.String
                ? dataElement.GetString()?.Length ?? 0
                : 0;
        var hasExternalLocator =
            (source.TryGetProperty("filePath", out var filePathElement) &&
                filePathElement.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(filePathElement.GetString())) ||
            (source.TryGetProperty("url", out var urlElement) &&
                urlElement.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(urlElement.GetString()));
        var persistedFilePath = dataChars > ToolResultImageDataMaxChars && !hasExternalLocator
            ? TryPersistToolResultImage(source)
            : null;

        writer.WriteStartObject();
        foreach (var property in block.EnumerateObject())
        {
            if (!property.NameEquals("source"))
            {
                property.WriteTo(writer);
                continue;
            }

            writer.WritePropertyName("source");
            writer.WriteStartObject();
            foreach (var sourceProperty in source.EnumerateObject())
            {
                if (sourceProperty.NameEquals("data") &&
                    sourceProperty.Value.ValueKind == JsonValueKind.String &&
                    (sourceProperty.Value.GetString()?.Length ?? 0) > ToolResultImageDataMaxChars)
                {
                    continue;
                }
                sourceProperty.WriteTo(writer);
            }
            if (!string.IsNullOrWhiteSpace(persistedFilePath))
            {
                writer.WriteString("filePath", persistedFilePath);
            }
            writer.WriteEndObject();
        }
        writer.WriteEndObject();
        return true;
    }

    private static string? TryPersistToolResultImage(JsonElement source)
    {
        if (!source.TryGetProperty("data", out var dataElement) ||
            dataElement.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var data = dataElement.GetString();
        if (string.IsNullOrWhiteSpace(data))
        {
            return null;
        }

        try
        {
            var mediaType = JsonHelpers.GetString(source, "mediaType") ?? "image/png";
            var base64 = StripDataUriPrefix(data);
            var bytes = Convert.FromBase64String(base64);
            var directory = Path.Combine(Path.GetTempPath(), "OpenCowork", "tool-result-images");
            Directory.CreateDirectory(directory);
            var filePath = Path.Combine(directory, $"{Guid.NewGuid():N}{ImageExtensionForMediaType(mediaType)}");
            File.WriteAllBytes(filePath, bytes);
            return filePath;
        }
        catch (Exception ex)
        {
            WorkerLog.Debug($"tool result image persist failed error={ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    private static string StripDataUriPrefix(string data)
    {
        var marker = ";base64,";
        var index = data.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return index >= 0 ? data[(index + marker.Length)..] : data;
    }

    private static string ImageExtensionForMediaType(string mediaType)
    {
        return mediaType.ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => ".jpg",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            "image/bmp" => ".bmp",
            "image/svg+xml" => ".svg",
            _ => ".png"
        };
    }

    private static string TruncatePreservingEdges(string value, int maxChars)
    {
        if (maxChars <= 0)
        {
            return $"... [truncated, {value.Length} chars total]";
        }
        if (value.Length <= maxChars)
        {
            return value;
        }

        var marker = $"\n... [truncated, {value.Length} chars total]\n";
        var budget = maxChars - marker.Length;
        if (budget <= 0)
        {
            return value[..Math.Min(value.Length, maxChars)];
        }

        var headChars = Math.Max(0, (int)Math.Floor(budget * 0.65));
        var tailChars = Math.Max(0, budget - headChars);
        return value[..headChars] + marker + (tailChars > 0 ? value[^tailChars..] : string.Empty);
    }

    private static void WriteTools(Utf8JsonWriter writer, JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("tools", out var tools) ||
            tools.ValueKind != JsonValueKind.Array ||
            tools.GetArrayLength() == 0)
        {
            return;
        }

        writer.WritePropertyName("tools");
        writer.WriteStartArray();
        foreach (var tool in tools.EnumerateArray())
        {
            var name = JsonHelpers.GetString(tool, "name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            writer.WriteStartObject();
            writer.WriteString("type", "function");
            writer.WritePropertyName("function");
            writer.WriteStartObject();
            writer.WriteString("name", name);
            writer.WriteString("description", JsonHelpers.GetString(tool, "description") ?? string.Empty);
            writer.WritePropertyName("parameters");
            if (tool.TryGetProperty("inputSchema", out var schema))
            {
                AgentRuntimeProviderSupport.WriteProviderCompatibleToolSchema(writer, schema);
            }
            else
            {
                writer.WriteStartObject();
                writer.WriteString("type", "object");
                writer.WriteStartObject("properties");
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    private static void WriteThinkingConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
    {
        if (!provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var thinkingEnabled = JsonHelpers.GetBool(provider, "thinkingEnabled", false);
        var propertyName = thinkingEnabled ? "bodyParams" : "disabledBodyParams";
        if (thinkingConfig.TryGetProperty(propertyName, out var bodyParams) &&
            bodyParams.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in bodyParams.EnumerateObject())
            {
                if (omitted.Contains(property.Name))
                {
                    continue;
                }
                property.WriteTo(writer);
            }
        }

        if (ShouldWriteReasoningEffort(thinkingEnabled, thinkingConfig) &&
            !omitted.Contains("reasoning_effort") &&
            JsonHelpers.GetString(provider, "reasoningEffort") is { Length: > 0 } reasoningEffort &&
            JsonHelpers.ResolveEffectiveReasoningEffort(reasoningEffort, thinkingConfig)
                is { Length: > 0 } effectiveEffort)
        {
            // "ultra" is a pseudo-tier mapped to the model's top real level; every other
            // value passes through unchanged. See JsonHelpers.ResolveEffectiveReasoningEffort.
            writer.WriteString("reasoning_effort", effectiveEffort);
        }
    }

    // Models such as GLM-5.3 / Ox Alpha always reason. They reject thinking.type=disabled
    // and only accept reasoning_effort=low|high|max. If the catalog cannot represent "off"
    // (no disabledBodyParams, no none/minimal effort), still emit the effort field.
    private static bool ShouldWriteReasoningEffort(bool thinkingEnabled, JsonElement thinkingConfig)
    {
        if (thinkingEnabled)
        {
            return true;
        }

        if (thinkingConfig.TryGetProperty("disabledBodyParams", out var disabled) &&
            disabled.ValueKind == JsonValueKind.Object)
        {
            return false;
        }

        if (!thinkingConfig.TryGetProperty("reasoningEffortLevels", out var levels) ||
            levels.ValueKind != JsonValueKind.Array ||
            levels.GetArrayLength() == 0)
        {
            return false;
        }

        foreach (var item in levels.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String &&
                item.GetString() is { Length: > 0 } level &&
                (level is "none" or "minimal"))
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryWritePromptCacheKey(Utf8JsonWriter writer, JsonElement provider)
    {
        var configured =
            AgentRuntimeOpenAIPromptCache.ResolveBodyOverrideString(provider, "prompt_cache_key") ??
            JsonHelpers.GetString(provider, "promptCacheKey");
        var value = AgentRuntimeOpenAIPromptCache.ClampPromptCacheKey(configured);
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        writer.WriteString("prompt_cache_key", value);
        return true;
    }

    private static void ApplyBodyOverrides(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("body", out var body) ||
            body.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in body.EnumerateObject())
        {
            if (omitted.Contains(property.Name))
            {
                continue;
            }
            property.WriteTo(writer);
        }
    }

    private static HashSet<string> GetOmittedBodyKeys(JsonElement provider)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("omitBodyKeys", out var keys) ||
            keys.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var key in keys.EnumerateArray())
        {
            if (key.ValueKind == JsonValueKind.String && key.GetString() is { Length: > 0 } value)
            {
                result.Add(value);
            }
        }
        return result;
    }

    private static List<JsonElement> ReadWireConversation(JsonElement parameters)
    {
        var directMessages = ReadMessageArrayProperty(parameters, "messages");
        if (directMessages.Count > 0)
        {
            var compactView = ApplyCompactRequestView(directMessages);
            if (compactView.Count != directMessages.Count)
            {
                WorkerLog.Info(
                    $"compact request view applied source=messages before={directMessages.Count} after={compactView.Count}");
            }
            return compactView;
        }

        var contextMessages = ReadContextSourceMessages(parameters);
        var overlayMessages = ReadMessageArrayProperty(parameters, "liveOverlayMessages");
        return MergeOverlayMessages(contextMessages, overlayMessages);
    }

    private static List<JsonElement> ApplyRequestContexts(List<JsonElement> messages, JsonElement parameters)
    {
        if (messages.Count == 0)
        {
            return messages;
        }

        var lastUserIndex = -1;
        for (var index = 0; index < messages.Count; index++)
        {
            if (JsonHelpers.GetString(messages[index], "role") == "user")
            {
                lastUserIndex = index;
            }
        }

        if (lastUserIndex < 0)
        {
            return messages;
        }

        var contextTexts = BuildRequestContextTexts(parameters, messages[lastUserIndex]);
        if (contextTexts.Count == 0)
        {
            return messages;
        }

        var result = messages.Select(message => message.Clone()).ToList();
        result[lastUserIndex] = PrependTextToWireMessage(
            result[lastUserIndex],
            string.Join("\n\n", contextTexts));
        return result;
    }

    private static List<string> BuildRequestContextTexts(JsonElement parameters, JsonElement userMessage)
    {
        var result = new List<string>();
        if (JsonHelpers.GetBool(parameters, "planMode", false) && !MessageHasPlanModeContext(userMessage))
        {
            result.Add(PlanModeTurnContextText);
        }

        var revisionText = BuildPlanRevisionText(parameters, userMessage);
        if (!string.IsNullOrWhiteSpace(revisionText))
        {
            result.Add(revisionText);
        }

        var executionText = BuildPlanExecutionText(parameters, userMessage);
        if (!string.IsNullOrWhiteSpace(executionText))
        {
            result.Add(executionText);
        }

        var pluginChannelText = BuildPluginChannelText(parameters, userMessage);
        if (!string.IsNullOrWhiteSpace(pluginChannelText))
        {
            result.Add(pluginChannelText);
        }

        AppendRequestContextTexts(result, parameters);

        var taskReminder = AgentRuntimeTaskExecutor.BuildTurnReminder(parameters);
        if (!string.IsNullOrWhiteSpace(taskReminder))
        {
            result.Add(taskReminder);
        }

        var slashCommandText = BuildSlashCommandText(parameters, userMessage);
        if (!string.IsNullOrWhiteSpace(slashCommandText))
        {
            result.Add(slashCommandText);
        }

        var systemCommandText = BuildSystemCommandText(parameters, userMessage);
        if (!string.IsNullOrWhiteSpace(systemCommandText))
        {
            result.Add(systemCommandText);
        }

        return result;
    }

    private static void AppendRequestContextTexts(List<string> result, JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("requestContextTexts", out var contexts) ||
            contexts.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var context in contexts.EnumerateArray())
        {
            if (context.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var text = context.GetString()?.Trim();
            if (!string.IsNullOrWhiteSpace(text))
            {
                result.Add(text);
            }
        }
    }

    private static bool MessageHasPlanModeContext(JsonElement message)
    {
        return MessageTextContains(message, "<plan-mode>");
    }

    private static string? BuildPlanRevisionText(JsonElement parameters, JsonElement userMessage)
    {
        if (MessageTextContains(userMessage, PlanRevisionInstruction) ||
            parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("planRevision", out var revision) ||
            revision.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var title = JsonHelpers.GetString(revision, "title")?.Trim();
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        var lines = new List<string>
        {
            $"The plan **{title}** was rejected."
        };

        var filePath = JsonHelpers.GetString(revision, "filePath")?.Trim();
        if (!string.IsNullOrWhiteSpace(filePath))
        {
            lines.Add($"Plan file: {filePath}");
        }

        var feedback = JsonHelpers.GetString(revision, "feedback")?.Trim();
        lines.Add(string.IsNullOrWhiteSpace(feedback)
            ? "Feedback:\nNo additional feedback provided."
            : $"Feedback:\n{feedback}");
        lines.Add(string.Empty);
        lines.Add(PlanRevisionInstruction);
        return string.Join('\n', lines);
    }

    private static string? BuildPlanExecutionText(JsonElement parameters, JsonElement userMessage)
    {
        if (MessageTextContains(userMessage, "Stay in ACP mode. Do not directly edit files") ||
            parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("planExecution", out var execution) ||
            execution.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var filePath = JsonHelpers.GetString(execution, "filePath")?.Trim();
        var lines = new List<string>
        {
            string.IsNullOrWhiteSpace(filePath)
                ? "Execute the approved plan"
                : $"Execute the approved plan from this file:\n{filePath}"
        };

        if (JsonHelpers.GetBool(execution, "acp", false))
        {
            lines.Add("Stay in ACP mode. Do not directly edit files or run implementation commands yourself.");
            lines.Add("Break the plan into concrete tasks, keep task tracking up to date, and delegate implementation through Task / sub-agents / teammates.");
            lines.Add("Review sub-agent outputs, continue delegation until the approved plan is completed, and report progress plus remaining risks after each wave.");
        }

        return string.Join('\n', lines);
    }

    private static string? BuildPluginChannelText(JsonElement parameters, JsonElement userMessage)
    {
        const string marker = "## Channel Auto-Reply Context";
        if (MessageTextContains(userMessage, marker) ||
            parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("pluginChannelContext", out var channelContext) ||
            channelContext.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var channelId = JsonHelpers.GetString(channelContext, "channelId")?.Trim();
        if (string.IsNullOrWhiteSpace(channelId))
        {
            return null;
        }

        var channelName = JsonHelpers.GetString(channelContext, "channelName")?.Trim();
        var chatId = JsonHelpers.GetString(channelContext, "chatId")?.Trim();
        var chatType = JsonHelpers.GetString(channelContext, "chatType")?.Trim();
        var senderId = JsonHelpers.GetString(channelContext, "senderId")?.Trim();
        var senderName = JsonHelpers.GetString(channelContext, "senderName")?.Trim();
        var senderLabel = string.IsNullOrWhiteSpace(senderName) ? senderId : senderName;
        var senderIdText = string.IsNullOrWhiteSpace(senderId) ? "unknown" : senderId;
        var senderLabelText = string.IsNullOrWhiteSpace(senderLabel) ? "unknown" : senderLabel;
        var availableTools = ReadStringArray(channelContext, "availableTools");
        var autoReply = JsonHelpers.GetBool(channelContext, "autoReply", false);

        var lines = new List<string>
        {
            "<system-reminder>",
            marker,
            $"Channel: {(string.IsNullOrWhiteSpace(channelName) ? channelId : channelName)} (channel_id: `{channelId}`)"
        };
        if (!string.IsNullOrWhiteSpace(chatId))
        {
            lines.Add($"Chat ID: `{chatId}`");
        }
        lines.Add($"Chat Type: {(string.IsNullOrWhiteSpace(chatType) ? "unknown" : chatType)}");
        lines.Add($"Sender: {senderLabelText} (id: {senderIdText})");
        if (availableTools.Count > 0)
        {
            lines.Add($"Available channel tools: {string.Join(", ", availableTools)}");
        }
        lines.Add(autoReply
            ? "Reply directly to this incoming message in a natural way."
            : "Reply naturally in this channel conversation.");
        lines.Add(string.IsNullOrWhiteSpace(chatId)
            ? $"If you need channel tools, use plugin_id=\"{channelId}\"."
            : $"If you need channel tools, use plugin_id=\"{channelId}\" and chat_id=\"{chatId}\".");
        lines.Add("</system-reminder>");
        return string.Join('\n', lines);
    }

    private static List<string> ReadStringArray(JsonElement value, string propertyName)
    {
        var result = new List<string>();
        if (value.ValueKind != JsonValueKind.Object ||
            !value.TryGetProperty(propertyName, out var array) ||
            array.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in array.EnumerateArray())
        {
            var text = item.ValueKind == JsonValueKind.String ? item.GetString()?.Trim() : null;
            if (!string.IsNullOrWhiteSpace(text) && !result.Contains(text))
            {
                result.Add(text);
            }
        }
        return result;
    }

    private static string? BuildSlashCommandText(JsonElement parameters, JsonElement userMessage)
    {
        const string marker = "The user invoked slash command /";
        if (MessageTextContains(userMessage, marker) ||
            parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("slashCommand", out var command) ||
            command.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var commandName = JsonHelpers.GetString(command, "commandName")?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(commandName))
        {
            return null;
        }

        var rawArguments = JsonHelpers.GetString(command, "rawArguments")?.Trim() ?? string.Empty;
        var parsedArguments = "[]";
        var hasParsedArguments = false;
        if (command.TryGetProperty("parsedArguments", out var parsed) &&
            parsed.ValueKind == JsonValueKind.Array)
        {
            parsedArguments = parsed.GetRawText();
            hasParsedArguments = parsed.GetArrayLength() > 0;
        }

        if (string.IsNullOrWhiteSpace(rawArguments) && !hasParsedArguments)
        {
            return null;
        }

        return
            "<system-reminder>\n" +
            $"The user invoked slash command /{commandName} with explicit arguments.\n" +
            $"Raw arguments: {rawArguments}\n" +
            $"Parsed arguments: {parsedArguments}\n" +
            "Treat these values as slash-command parameters.\n" +
            "</system-reminder>";
    }

    private static string? BuildSystemCommandText(JsonElement parameters, JsonElement userMessage)
    {
        if (MessageTextContains(userMessage, "<system-command") ||
            parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("systemCommand", out var command) ||
            command.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var name = JsonHelpers.GetString(command, "name")?.Trim();
        var content = JsonHelpers.GetString(command, "content")?.Trim();
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(content))
        {
            return null;
        }

        return $"<system-command name=\"{EncodeXmlAttribute(name)}\">{content}</system-command>";
    }

    private static string EncodeXmlAttribute(string value)
    {
        return value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&#39;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);
    }

    private static bool MessageTextContains(JsonElement message, string marker)
    {
        if (message.ValueKind != JsonValueKind.Object ||
            !message.TryGetProperty("content", out var content))
        {
            return false;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return ContentContains(content.GetString(), marker);
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind != JsonValueKind.Object ||
                JsonHelpers.GetString(block, "type") != "text")
            {
                continue;
            }

            if (ContentContains(JsonHelpers.GetString(block, "text"), marker))
            {
                return true;
            }
        }

        return false;
    }

    private static bool ContentContains(string? value, string marker)
    {
        return value?.Contains(marker, StringComparison.Ordinal) == true;
    }

    private static JsonElement PrependTextToWireMessage(JsonElement message, string contextText)
    {
        if (message.ValueKind != JsonValueKind.Object)
        {
            return message.Clone();
        }

        var wroteContent = false;
        return CreateObjectElement(writer =>
        {
            foreach (var property in message.EnumerateObject())
            {
                if (property.NameEquals("content"))
                {
                    wroteContent = true;
                    writer.WritePropertyName(property.Name);
                    WriteContentWithPrependedText(writer, property.Value, contextText);
                    continue;
                }

                property.WriteTo(writer);
            }

            if (!wroteContent)
            {
                writer.WriteString("content", contextText);
            }
        });
    }

    private static void WriteContentWithPrependedText(
        Utf8JsonWriter writer,
        JsonElement content,
        string contextText)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            writer.WriteStringValue($"{contextText}\n\n{content.GetString() ?? string.Empty}");
            return;
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            writer.WriteStringValue(contextText);
            return;
        }

        writer.WriteStartArray();
        writer.WriteStartObject();
        writer.WriteString("type", "text");
        writer.WriteString("text", contextText);
        writer.WriteEndObject();
        foreach (var block in content.EnumerateArray())
        {
            block.WriteTo(writer);
        }
        writer.WriteEndArray();
    }

    private static List<JsonElement> ReadMessageArrayProperty(JsonElement parameters, string propertyName)
    {
        var result = new List<JsonElement>();
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty(propertyName, out var messages) ||
            messages.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var message in messages.EnumerateArray())
        {
            if (message.ValueKind == JsonValueKind.Object)
            {
                result.Add(message.Clone());
            }
        }
        return result;
    }

    private static List<JsonElement> ReadContextSourceMessages(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("contextSource", out var contextSource) ||
            contextSource.ValueKind != JsonValueKind.Object)
        {
            return new List<JsonElement>();
        }

        var sessionId = JsonHelpers.GetString(contextSource, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId))
        {
            return new List<JsonElement>();
        }

        var maxMessages = Math.Clamp(JsonHelpers.GetInt(contextSource, "maxMessages", 160), 1, 1000);
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        var compaction = DbMessageTools.ReadCompaction(connection, null, sessionId);
        // A cut whose summary row is not on disk yet (or was deleted) must not
        // hide the compacted range: the model would then see only the tail.
        if (compaction is not null &&
            !DbMessageTools.MessageExists(connection, null, compaction.SummaryMessageId))
        {
            WorkerLog.Warn(
                $"context source compaction ignored; summary row missing sessionId={sessionId} " +
                $"summaryId={compaction.SummaryMessageId}");
            compaction = null;
        }
        var visibility = BuildContextVisibilityFilter(compaction);

        var count = CountVisibleContextMessages(connection, sessionId, visibility);
        if (count <= 0)
        {
            return new List<JsonElement>();
        }

        // Long uncompacted sessions still keep a slice of their opening turns so the
        // original task does not fall out of the window. A compacted session needs no
        // such sampling: the summary is the opening turns.
        var headLimit = count > maxMessages && compaction is null
            ? Math.Min(ContextSourceHeadMessageLimit, Math.Max(1, maxMessages / 4))
            : 0;
        var tailLimit = Math.Min(Math.Max(1, maxMessages - headLimit), count);
        var rows = new List<ContextSourceMessageRow>();

        if (headLimit > 0)
        {
            ReadVisibleContextRows(connection, sessionId, visibility, headLimit, 0, rows);
        }
        ReadVisibleContextRows(
            connection,
            sessionId,
            visibility,
            tailLimit,
            Math.Max(headLimit, count - tailLimit),
            rows);
        if (compaction is null)
        {
            // A session compacted by an older build has no recorded cut, so its
            // marker rows are ordinary history and can sit outside the window.
            // ApplyCompactRequestView below can only compact what it can see.
            ReadLegacyCompactArtifactRows(connection, sessionId, rows);
        }

        var result = new List<JsonElement>();
        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in rows.OrderBy(row => row.OrderKey).ThenBy(row => row.CreatedAt))
        {
            if (!seenIds.Add(row.Id))
            {
                continue;
            }
            result.Add(row.Message.Clone());
        }

        if (compaction is not null)
        {
            WorkerLog.Info(
                $"context source compaction cut sessionId={sessionId} generation={compaction.Generation} " +
                $"through={compaction.ThroughSortOrder} visible={count} loaded={result.Count}");
            return result;
        }
        return ApplyCompactRequestView(result);
    }

    /// <summary>
    /// SQL for the model-visible slice of a session. Without a compaction record
    /// that is the whole session; with one it is the summary, everything written
    /// after the recorded cut, and the rows the cut explicitly spares.
    ///
    /// `OrderKey` forces the summary ahead of the spared rows, which by definition
    /// started before the cut, so the model reads the condensed history first.
    /// </summary>
    private static ContextVisibilityFilter BuildContextVisibilityFilter(SessionCompactionRow? compaction)
    {
        if (compaction is null)
        {
            return new ContextVisibilityFilter(string.Empty, "sort_order", Array.Empty<SqlParameterValue>());
        }

        var parameterValues = new List<SqlParameterValue>
        {
            new("$compactThrough", compaction.ThroughSortOrder),
            new("$compactSummaryId", compaction.SummaryMessageId)
        };
        var keepPredicate = new StringBuilder();
        for (var index = 0; index < compaction.KeepMessageIds.Count; index++)
        {
            keepPredicate.Append(index == 0 ? " OR id IN (" : ", ");
            keepPredicate.Append("$compactKeep").Append(index);
            parameterValues.Add(new($"$compactKeep{index}", compaction.KeepMessageIds[index]));
        }
        if (compaction.KeepMessageIds.Count > 0)
        {
            keepPredicate.Append(')');
        }

        return new ContextVisibilityFilter(
            $" AND (sort_order > $compactThrough OR id = $compactSummaryId{keepPredicate})",
            "CASE WHEN id = $compactSummaryId THEN -1 ELSE sort_order END",
            parameterValues);
    }

    private static int CountVisibleContextMessages(
        SqliteConnection connection,
        string sessionId,
        ContextVisibilityFilter visibility)
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            $"SELECT COUNT(*) FROM messages WHERE session_id = $sessionId{visibility.Predicate}";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        visibility.Apply(command);
        return Convert.ToInt32(command.ExecuteScalar() ?? 0);
    }

    private static void ReadVisibleContextRows(
        SqliteConnection connection,
        string sessionId,
        ContextVisibilityFilter visibility,
        int limit,
        int offset,
        List<ContextSourceMessageRow> rows)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT id, role, content, meta, created_at, usage, sort_order, {visibility.OrderKey} AS order_key
              FROM messages
             WHERE session_id = $sessionId{visibility.Predicate}
             ORDER BY order_key ASC, created_at ASC
             LIMIT $limit OFFSET $offset
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$offset", offset);
        visibility.Apply(command);

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(ReadContextSourceMessageRow(reader));
        }
    }

    private static void ReadLegacyCompactArtifactRows(
        SqliteConnection connection,
        string sessionId,
        List<ContextSourceMessageRow> rows)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, role, content, meta, created_at, usage, sort_order, sort_order AS order_key
              FROM messages
             WHERE session_id = $sessionId
               AND (
                 meta LIKE '%compactBoundary%' OR
                 meta LIKE '%compactSummary%' OR
                 content LIKE '%[Context Memory Compressed Summary]%'
               )
             ORDER BY sort_order ASC, created_at ASC
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(ReadContextSourceMessageRow(reader));
        }
    }

    private sealed record SqlParameterValue(string Name, object Value);

    private sealed record ContextVisibilityFilter(
        string Predicate,
        string OrderKey,
        IReadOnlyList<SqlParameterValue> Parameters)
    {
        public void Apply(SqliteCommand command)
        {
            foreach (var parameter in Parameters)
            {
                command.Parameters.AddWithValue(parameter.Name, parameter.Value);
            }
        }
    }

    private static ContextSourceMessageRow ReadContextSourceMessageRow(SqliteDataReader reader)
    {
        var id = reader.GetString(0);
        var createdAt = reader.GetInt64(4);
        var sortOrder = reader.GetInt32(6);
        return new ContextSourceMessageRow(
            id,
            sortOrder,
            reader.FieldCount > 7 && !reader.IsDBNull(7) ? reader.GetInt64(7) : sortOrder,
            createdAt,
            BuildWireMessageElement(
                id,
                reader.GetString(1),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                createdAt,
                reader.IsDBNull(5) ? null : reader.GetString(5)));
    }

    private static JsonElement BuildWireMessageElement(
        string id,
        string role,
        string content,
        string? meta,
        long createdAt,
        string? usage)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("id", id);
            writer.WriteString("role", role);
            writer.WritePropertyName("content");
            WriteJsonValueOrString(writer, content);
            writer.WriteNumber("createdAt", createdAt);
            if (!string.IsNullOrWhiteSpace(usage))
            {
                writer.WritePropertyName("usage");
                WriteJsonValueOrString(writer, usage);
            }
            if (!string.IsNullOrWhiteSpace(meta))
            {
                writer.WritePropertyName("meta");
                WriteJsonValueOrString(writer, meta);
            }
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static void WriteJsonValueOrString(Utf8JsonWriter writer, string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            document.RootElement.WriteTo(writer);
        }
        catch
        {
            writer.WriteStringValue(raw);
        }
    }

    private static List<JsonElement> MergeOverlayMessages(
        List<JsonElement> messages,
        IReadOnlyList<JsonElement> overlayMessages)
    {
        if (overlayMessages.Count == 0)
        {
            return messages;
        }

        var result = new List<JsonElement>(messages);
        var indexById = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var index = 0; index < result.Count; index++)
        {
            var id = GetWireMessageId(result[index]);
            if (!string.IsNullOrEmpty(id))
            {
                indexById[id] = index;
            }
        }

        foreach (var overlay in overlayMessages)
        {
            var id = GetWireMessageId(overlay);
            if (!string.IsNullOrEmpty(id) && indexById.TryGetValue(id, out var existingIndex))
            {
                result[existingIndex] = overlay.Clone();
                continue;
            }
            result.Add(overlay.Clone());
        }

        return result;
    }

    private static string? GetWireMessageId(JsonElement message)
    {
        return message.ValueKind == JsonValueKind.Object &&
            message.TryGetProperty("id", out var idElement) &&
            idElement.ValueKind == JsonValueKind.String
            ? idElement.GetString()
            : null;
    }

    private sealed record ActiveCompactArtifacts(
        int BoundaryIndex,
        int SummaryIndex,
        string? BoundaryId,
        string? SummaryId);

    private static List<JsonElement> ApplyCompactRequestView(List<JsonElement> messages)
    {
        var active = ResolveActiveCompactArtifacts(messages);
        if (active is null)
        {
            return messages
                .Where(message => !IsCompactArtifactMessage(message) && !IsUiOnlyRequestMessage(message))
                .Select(message => message.Clone())
                .ToList();
        }

        if (active.BoundaryIndex < 0)
        {
            if (IsFailedCompactSummary(messages[active.SummaryIndex]))
            {
                return messages
                    .Where(message => !IsCompactArtifactMessage(message) && !IsUiOnlyRequestMessage(message))
                    .Select(message => message.Clone())
                    .ToList();
            }

            var tail = new List<JsonElement>();
            if (active.SummaryIndex >= 0 && active.SummaryIndex < messages.Count)
            {
                AppendCompactRequestMessage(
                    tail,
                    new HashSet<string>(StringComparer.Ordinal),
                    messages[active.SummaryIndex],
                    active.BoundaryId,
                    active.SummaryId);
            }
            var seenIds = new HashSet<string>(tail.Select(GetWireMessageId).OfType<string>(), StringComparer.Ordinal);
            for (var index = active.SummaryIndex + 1; index < messages.Count; index++)
            {
                if (IsCompactArtifactMessage(messages[index]) || IsUiOnlyRequestMessage(messages[index]))
                {
                    continue;
                }
                AppendCompactRequestMessage(tail, seenIds, messages[index], active.BoundaryId, active.SummaryId);
            }
            return tail;
        }

        if (active.SummaryIndex >= 0 &&
            active.SummaryIndex < messages.Count &&
            IsFailedCompactSummary(messages[active.SummaryIndex]))
        {
            return messages
                .Where(message => !IsCompactArtifactMessage(message) && !IsUiOnlyRequestMessage(message))
                .Select(message => message.Clone())
                .ToList();
        }

        var compactMessages = new List<JsonElement>();
        var compactSeenIds = new HashSet<string>(StringComparer.Ordinal);
        AppendCompactRequestMessage(
            compactMessages,
            compactSeenIds,
            messages[active.BoundaryIndex],
            active.BoundaryId,
            active.SummaryId);
        if (active.SummaryIndex >= 0)
        {
            AppendCompactRequestMessage(
                compactMessages,
                compactSeenIds,
                messages[active.SummaryIndex],
                active.BoundaryId,
                active.SummaryId);
        }

        if (TryGetCompactPreservedSegment(messages[active.BoundaryIndex], out var headId, out var tailId))
        {
            var headIndex = messages.FindIndex(message => GetWireMessageId(message) == headId);
            if (headIndex >= 0)
            {
                var tailIndex = -1;
                for (var index = headIndex; index < messages.Count; index++)
                {
                    if (GetWireMessageId(messages[index]) == tailId)
                    {
                        tailIndex = index;
                        break;
                    }
                }
                if (tailIndex >= headIndex)
                {
                    for (var index = headIndex; index <= tailIndex; index++)
                    {
                        AppendCompactRequestMessage(
                            compactMessages,
                            compactSeenIds,
                            messages[index],
                            active.BoundaryId,
                            active.SummaryId);
                    }
                }
            }
        }

        var trailingStartIndex = Math.Max(active.BoundaryIndex, active.SummaryIndex) + 1;
        for (var index = Math.Max(0, trailingStartIndex); index < messages.Count; index++)
        {
            AppendCompactRequestMessage(
                compactMessages,
                compactSeenIds,
                messages[index],
                active.BoundaryId,
                active.SummaryId);
        }

        return compactMessages;
    }

    private static ActiveCompactArtifacts? ResolveActiveCompactArtifacts(IReadOnlyList<JsonElement> messages)
    {
        ActiveCompactArtifacts? active = null;
        var activeScore = long.MinValue;

        for (var boundaryIndex = 0; boundaryIndex < messages.Count; boundaryIndex++)
        {
            if (!IsCompactBoundaryMessage(messages[boundaryIndex]))
            {
                continue;
            }

            var summaryIndex = FindCompactSummaryIndex(messages, boundaryIndex);
            if (summaryIndex < 0)
            {
                continue;
            }

            var score = Math.Max(
                JsonHelpers.GetLong(messages[boundaryIndex], "createdAt", 0),
                JsonHelpers.GetLong(messages[summaryIndex], "createdAt", 0));
            if (score < activeScore)
            {
                continue;
            }

            activeScore = score;
            active = new ActiveCompactArtifacts(
                boundaryIndex,
                summaryIndex,
                GetWireMessageId(messages[boundaryIndex]),
                GetWireMessageId(messages[summaryIndex]));
        }

        if (active is not null)
        {
            return active;
        }

        for (var summaryIndex = 0; summaryIndex < messages.Count; summaryIndex++)
        {
            if (!IsCompactSummaryLikeMessage(messages[summaryIndex]))
            {
                continue;
            }

            var score = JsonHelpers.GetLong(messages[summaryIndex], "createdAt", 0);
            if (score < activeScore)
            {
                continue;
            }

            activeScore = score;
            active = new ActiveCompactArtifacts(
                -1,
                summaryIndex,
                null,
                GetWireMessageId(messages[summaryIndex]));
        }

        return active;
    }

    private static bool IsFailedCompactSummary(JsonElement message)
    {
        return message.TryGetProperty("meta", out var meta) &&
            meta.ValueKind == JsonValueKind.Object &&
            meta.TryGetProperty("compactSummary", out var compactSummary) &&
            compactSummary.ValueKind == JsonValueKind.Object &&
            compactSummary.TryGetProperty("summarizerFailed", out var failed) &&
            failed.ValueKind == JsonValueKind.True;
    }

    private static int FindCompactSummaryIndex(IReadOnlyList<JsonElement> messages, int boundaryIndex)
    {
        // Prefer the id pairing recorded on the boundary so the pair survives
        // sort-order normalization that may move the summary before the boundary.
        var pairedSummaryId = GetBoundaryPairedSummaryId(messages[boundaryIndex]);
        if (!string.IsNullOrEmpty(pairedSummaryId))
        {
            for (var index = 0; index < messages.Count; index++)
            {
                if (GetWireMessageId(messages[index]) == pairedSummaryId &&
                    IsCompactSummaryLikeMessage(messages[index]))
                {
                    return index;
                }
            }
        }

        for (var index = boundaryIndex + 1; index < messages.Count; index++)
        {
            if (IsCompactBoundaryMessage(messages[index]))
            {
                return -1;
            }
            if (IsCompactSummaryLikeMessage(messages[index]))
            {
                return index;
            }
        }
        return -1;
    }

    private static string? GetBoundaryPairedSummaryId(JsonElement boundary)
    {
        if (boundary.ValueKind != JsonValueKind.Object ||
            !boundary.TryGetProperty("meta", out var meta) ||
            meta.ValueKind != JsonValueKind.Object ||
            !meta.TryGetProperty("compactBoundary", out var compactBoundary) ||
            compactBoundary.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var summaryId = JsonHelpers.GetString(compactBoundary, "summaryId");
        if (!string.IsNullOrEmpty(summaryId))
        {
            return summaryId;
        }

        // Legacy boundaries recorded the pairing on preservedSegment.anchorId.
        return compactBoundary.TryGetProperty("preservedSegment", out var segment) &&
            segment.ValueKind == JsonValueKind.Object
            ? JsonHelpers.GetString(segment, "anchorId")
            : null;
    }

    private static bool IsCompactArtifactMessage(JsonElement message)
    {
        return IsCompactBoundaryMessage(message) || IsCompactSummaryLikeMessage(message);
    }

    private static void AppendCompactRequestMessage(
        List<JsonElement> result,
        HashSet<string> seenIds,
        JsonElement message,
        string? boundaryId,
        string? summaryId)
    {
        var messageId = GetWireMessageId(message);
        if (string.IsNullOrEmpty(messageId) || !seenIds.Add(messageId) || IsUiOnlyRequestMessage(message))
        {
            return;
        }

        if (IsCompactArtifactMessage(message) && messageId != boundaryId && messageId != summaryId)
        {
            return;
        }

        result.Add(message.Clone());
    }

    private static bool IsUiOnlyRequestMessage(JsonElement message)
    {
        if (JsonHelpers.GetString(message, "role") != "system")
        {
            return false;
        }

        if (message.TryGetProperty("meta", out var meta) &&
            meta.ValueKind == JsonValueKind.Object)
        {
            if (meta.TryGetProperty("compressionStatus", out _))
            {
                return true;
            }
            if (meta.TryGetProperty("compactBoundary", out _))
            {
                return false;
            }
        }

        if (!message.TryGetProperty("content", out var content))
        {
            return true;
        }

        return content.ValueKind switch
        {
            JsonValueKind.String => string.IsNullOrWhiteSpace(content.GetString()),
            JsonValueKind.Array => content.GetArrayLength() == 0,
            _ => false
        };
    }

    private static bool TryGetCompactPreservedSegment(
        JsonElement boundary,
        out string headId,
        out string tailId)
    {
        headId = string.Empty;
        tailId = string.Empty;
        if (!boundary.TryGetProperty("meta", out var meta) ||
            meta.ValueKind != JsonValueKind.Object ||
            !meta.TryGetProperty("compactBoundary", out var compactBoundary) ||
            compactBoundary.ValueKind != JsonValueKind.Object ||
            !compactBoundary.TryGetProperty("preservedSegment", out var preservedSegment) ||
            preservedSegment.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        headId = JsonHelpers.GetString(preservedSegment, "headId")?.Trim() ?? string.Empty;
        tailId = JsonHelpers.GetString(preservedSegment, "tailId")?.Trim() ?? string.Empty;
        return headId.Length > 0 && tailId.Length > 0;
    }

    private static List<AgentRuntimeChatMessage> ReadConversation(JsonElement parameters)
    {
        return ReadConversation(ApplyRequestContexts(ReadWireConversation(parameters), parameters));
    }

    private static List<AgentRuntimeChatMessage> ReadConversation(IReadOnlyList<JsonElement> messages)
    {
        var result = new List<AgentRuntimeChatMessage>();

        foreach (var message in messages)
        {
            var role = JsonHelpers.GetString(message, "role");
            if (string.IsNullOrEmpty(role))
            {
                continue;
            }

            if (!message.TryGetProperty("content", out var content))
            {
                continue;
            }

            if (content.ValueKind == JsonValueKind.String)
            {
                result.Add(new AgentRuntimeChatMessage(
                    role,
                    content.GetString() ?? string.Empty,
                    [],
                    [],
                    JsonHelpers.GetString(message, "providerResponseId")));
                continue;
            }

            if (content.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var text = new StringBuilder();
            var toolUses = new List<AgentRuntimeChatToolUse>();
            var toolResults = new List<AgentRuntimeToolResult>();
            var contentBlocks = new List<JsonElement>();
            foreach (var block in content.EnumerateArray())
            {
                if (block.ValueKind == JsonValueKind.Object)
                {
                    contentBlocks.Add(block.Clone());
                }

                switch (JsonHelpers.GetString(block, "type"))
                {
                    case "text":
                        if (JsonHelpers.GetString(block, "text") is { Length: > 0 } blockText)
                        {
                            text.Append(blockText);
                        }
                        break;
                    case "tool_use":
                        if (JsonHelpers.GetString(block, "id") is { Length: > 0 } id &&
                            JsonHelpers.GetString(block, "name") is { Length: > 0 } name)
                        {
                            var input = block.TryGetProperty("input", out var inputElement)
                                ? inputElement.Clone()
                                : CreateEmptyObjectElement();
                            var extraContent = block.TryGetProperty("extraContent", out var extraContentElement) &&
                                extraContentElement.ValueKind == JsonValueKind.Object
                                    ? extraContentElement.Clone()
                                    : (JsonElement?)null;
                            toolUses.Add(new AgentRuntimeChatToolUse(id, name, input, extraContent));
                        }
                        break;
                    case "tool_result":
                        if (JsonHelpers.GetString(block, "toolUseId") is { Length: > 0 } toolUseId)
                        {
                            var resultContent = block.TryGetProperty("content", out var contentElement)
                                ? contentElement.Clone()
                                : CreateStringElement(string.Empty);
                            var isError = JsonHelpers.GetBool(block, "isError", false);
                            toolResults.Add(new AgentRuntimeToolResult(
                                toolUseId,
                                resultContent,
                                isError ? true : null));
                        }
                        break;
                }
            }

            result.Add(new AgentRuntimeChatMessage(
                role,
                text.ToString(),
                toolUses,
                toolResults,
                JsonHelpers.GetString(message, "providerResponseId"),
                contentBlocks));
        }

        return result;
    }

    private static void ValidateProvider(JsonElement provider)
    {
        var apiKey = JsonHelpers.GetString(provider, "apiKey") ?? string.Empty;
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new InvalidOperationException("OpenAI-compatible provider requires apiKey.");
        }
        if (string.IsNullOrWhiteSpace(model))
        {
            throw new InvalidOperationException("OpenAI-compatible provider requires model.");
        }
    }

    private static void ApplyHeaders(HttpRequestMessage request, JsonElement provider, string apiKey)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        ApiUserAgent.Apply(request, provider);
        if (JsonHelpers.GetString(provider, "organization") is { Length: > 0 } organization)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Organization", organization);
        }
        if (JsonHelpers.GetString(provider, "project") is { Length: > 0 } project)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Project", project);
        }
        if (JsonHelpers.GetString(provider, "accountId") is { Length: > 0 } accountId)
        {
            request.Headers.TryAddWithoutValidation("Chatgpt-Account-Id", accountId);
        }
        ApplyHeaderOverrides(request, provider);
        ApiUserAgent.Ensure(request, provider);
    }

    private static void ApplyHeaderOverrides(HttpRequestMessage request, JsonElement provider)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("headers", out var headers) ||
            headers.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var sessionId = JsonHelpers.GetString(provider, "sessionId") ?? string.Empty;
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        foreach (var property in headers.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var value = ResolveHeaderTemplate(property.Value.GetString() ?? string.Empty, sessionId, model);
            if (value.Length == 0)
            {
                continue;
            }
            request.Headers.Remove(property.Name);
            request.Headers.TryAddWithoutValidation(property.Name, value);
        }
    }

    private static IReadOnlyDictionary<string, string> BuildDebugHeaders(JsonElement provider)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer ***"
        };
        ApiUserAgent.ApplyDebug(headers, provider);
        ApplyDebugHeaderOverrides(headers, provider);
        ApiUserAgent.EnsureDebug(headers, provider);
        return headers;
    }

    private static void ApplyDebugHeaderOverrides(Dictionary<string, string> headers, JsonElement provider)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("headers", out var overrideHeaders) ||
            overrideHeaders.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var sessionId = JsonHelpers.GetString(provider, "sessionId") ?? string.Empty;
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        foreach (var property in overrideHeaders.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var value = ResolveHeaderTemplate(property.Value.GetString() ?? string.Empty, sessionId, model);
            if (value.Length == 0)
            {
                continue;
            }
            headers[property.Name] = IsSensitiveHeader(property.Name) ? "***" : value;
        }
    }

    private static string ResolveHeaderTemplate(string value, string sessionId, string model)
    {
        return value
            .Replace("{{sessionId}}", sessionId, StringComparison.Ordinal)
            .Replace("{{ sessionId }}", sessionId, StringComparison.Ordinal)
            .Replace("{{model}}", model, StringComparison.Ordinal)
            .Replace("{{ model }}", model, StringComparison.Ordinal)
            .Trim();
    }

    private static bool IsSensitiveHeader(string name)
    {
        return name.Contains("authorization", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("api-key", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("apikey", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("token", StringComparison.OrdinalIgnoreCase);
    }

    private static JsonElement GetObject(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Object)
        {
            return property;
        }
        return default;
    }

    private static JsonElement? TryGetFirstChoice(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices) ||
            choices.ValueKind != JsonValueKind.Array ||
            choices.GetArrayLength() == 0)
        {
            return null;
        }
        return choices[0];
    }

    private static string? ReadMessageContentText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content))
        {
            return null;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString();
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var builder = new StringBuilder();
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var text = ReadString(block, "text");
            if (string.IsNullOrEmpty(text))
            {
                continue;
            }

            if (builder.Length > 0)
            {
                builder.Append('\n');
            }
            builder.Append(text);
        }

        return builder.Length > 0 ? builder.ToString() : null;
    }

    private static string? ReadReasoningText(JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        // OpenAI-compatible providers expose reasoning under several aliases and
        // shapes. Prefer the first populated alias so a provider that mirrors the
        // same trace into multiple compatibility fields is not rendered twice.
        foreach (var propertyName in new[]
        {
            "reasoning_content",
            "reasoning",
            "reasoning_details",
            "thinking"
        })
        {
            if (!message.TryGetProperty(propertyName, out var value))
            {
                continue;
            }

            var text = ReadReasoningValue(value, 0);
            if (!string.IsNullOrEmpty(text))
            {
                return text;
            }
        }

        return null;
    }

    private static string? ReadReasoningValue(JsonElement value, int depth)
    {
        if (depth > 6)
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString();
        }

        if (value.ValueKind == JsonValueKind.Array)
        {
            var builder = new StringBuilder();
            foreach (var item in value.EnumerateArray())
            {
                var text = ReadReasoningValue(item, depth + 1);
                if (!string.IsNullOrEmpty(text))
                {
                    builder.Append(text);
                }
            }
            return builder.Length > 0 ? builder.ToString() : null;
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        // Only extract known textual fields. In particular, do not stringify
        // encrypted reasoning, signatures, provider metadata, or opaque payloads.
        foreach (var propertyName in new[]
        {
            "text",
            "reasoning_content",
            "reasoning",
            "summary_text",
            "summary",
            "content",
            "thinking"
        })
        {
            if (!value.TryGetProperty(propertyName, out var child))
            {
                continue;
            }

            var text = ReadReasoningValue(child, depth + 1);
            if (!string.IsNullOrEmpty(text))
            {
                return text;
            }
        }

        return null;
    }

    private static bool TryCreateCompletedToolCall(
        JsonElement toolCallElement,
        out AgentRuntimeNativeToolCall toolCall)
    {
        toolCall = default!;
        if (toolCallElement.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var id = ReadString(toolCallElement, "id");
        if (!toolCallElement.TryGetProperty("function", out var function) ||
            function.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var name = ReadString(function, "name");
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        var arguments = ReadString(function, "arguments") ?? string.Empty;
        var parsed = TryParseJsonObject(arguments, out var parsedInput);
        var input = parsed
            ? parsedInput
            : CreateEmptyObjectElement();
        toolCall = new AgentRuntimeNativeToolCall(
            string.IsNullOrWhiteSpace(id)
                ? $"call_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}"
                : id,
            name,
            input,
            RawArguments: arguments,
            ParseError: parsed ? null : "Expected a valid JSON object.");
        return true;
    }

    private static bool TryReadUsage(JsonElement usage, out AgentRuntimeTokenUsage tokenUsage)
    {
        if (usage.ValueKind != JsonValueKind.Object)
        {
            tokenUsage = default!;
            return false;
        }

        var inputTokens = ReadInt(usage, "prompt_tokens");
        var outputTokens = ReadInt(usage, "completion_tokens");
        var cachedTokens = ReadChatCacheReadTokens(usage);
        var cacheWriteTokens = ReadChatCacheWriteTokens(usage);
        var reasoningTokens = ReadChatReasoningTokens(usage);
        var billableInputTokens = cachedTokens > 0 || cacheWriteTokens > 0
            ? Math.Max(0, inputTokens - cachedTokens - cacheWriteTokens)
            : (int?)null;
        var cacheReadRatio = inputTokens > 0 && cachedTokens > 0
            ? Math.Min(1, cachedTokens / (double)inputTokens)
            : (double?)null;
        tokenUsage = new AgentRuntimeTokenUsage(
            inputTokens,
            outputTokens,
            billableInputTokens,
            cachedTokens > 0 ? cachedTokens : null,
            reasoningTokens > 0 ? reasoningTokens : null,
            inputTokens,
            CacheCreationTokens: cacheWriteTokens > 0 ? cacheWriteTokens : null,
            CacheReadRatio: cacheReadRatio);
        return inputTokens > 0 || outputTokens > 0;
    }

    private static int ReadChatCacheReadTokens(JsonElement usage)
    {
        // DeepSeek reports hits as prompt_cache_hit_tokens; OpenAI-compatible
        // gateways usually nest the same count under prompt_tokens_details.cached_tokens.
        var cachedTokens = ReadFirstPositiveInt(
            usage,
            "prompt_cache_hit_tokens",
            "cached_tokens",
            "cache_read_tokens",
            "cache_read_input_tokens",
            "cached_input_tokens");
        if (cachedTokens > 0)
        {
            return cachedTokens;
        }

        foreach (var detailsName in new[] { "prompt_tokens_details", "input_tokens_details" })
        {
            if (usage.TryGetProperty(detailsName, out var details))
            {
                cachedTokens = ReadFirstPositiveInt(
                    details,
                    "prompt_cache_hit_tokens",
                    "cached_tokens",
                    "cache_read_tokens",
                    "cache_read_input_tokens",
                    "cached_input_tokens");
                if (cachedTokens > 0)
                {
                    return cachedTokens;
                }
            }
        }

        return ReadCacheHitFromMissTokens(usage);
    }

    private static int ReadCacheHitFromMissTokens(JsonElement usage)
    {
        if (!HasIntProperty(usage, "prompt_cache_miss_tokens"))
        {
            return 0;
        }

        var missTokens = ReadInt(usage, "prompt_cache_miss_tokens");
        var promptTokens = ReadInt(usage, "prompt_tokens");
        return promptTokens > missTokens ? promptTokens - missTokens : 0;
    }

    private static bool HasIntProperty(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            (property.ValueKind == JsonValueKind.Number || property.ValueKind == JsonValueKind.String);
    }

    private static int ReadChatCacheWriteTokens(JsonElement usage)
    {
        var cacheWriteTokens = ReadFirstPositiveInt(
            usage,
            "cache_write_tokens",
            "cache_write_input_tokens",
            "cache_creation_tokens",
            "cache_creation_input_tokens");
        if (cacheWriteTokens > 0)
        {
            return cacheWriteTokens;
        }

        foreach (var detailsName in new[] { "prompt_tokens_details", "input_tokens_details" })
        {
            if (usage.TryGetProperty(detailsName, out var details))
            {
                cacheWriteTokens = ReadFirstPositiveInt(
                    details,
                    "cache_write_tokens",
                    "cache_write_input_tokens",
                    "cache_creation_tokens",
                    "cache_creation_input_tokens");
                if (cacheWriteTokens > 0)
                {
                    return cacheWriteTokens;
                }
            }
        }
        return 0;
    }

    private static int ReadChatReasoningTokens(JsonElement usage)
    {
        var reasoningTokens = ReadFirstPositiveInt(usage, "reasoning_tokens");
        if (reasoningTokens > 0)
        {
            return reasoningTokens;
        }

        foreach (var detailsName in new[] { "completion_tokens_details", "output_tokens_details" })
        {
            if (usage.TryGetProperty(detailsName, out var details))
            {
                reasoningTokens = ReadFirstPositiveInt(details, "reasoning_tokens");
                if (reasoningTokens > 0)
                {
                    return reasoningTokens;
                }
            }
        }
        return 0;
    }

    private static int ReadFirstPositiveInt(JsonElement element, params string[] propertyNames)
    {
        foreach (var propertyName in propertyNames)
        {
            var value = ReadInt(element, propertyName);
            if (value > 0)
            {
                return value;
            }
        }
        return 0;
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String)
        {
            return property.GetString();
        }
        return null;
    }

    private static int ReadInt(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(propertyName, out var property))
        {
            return 0;
        }
        if (property.ValueKind == JsonValueKind.Number &&
            property.TryGetInt64(out var longValue))
        {
            return longValue > int.MaxValue ? int.MaxValue : (int)Math.Max(0, longValue);
        }
        if (property.ValueKind == JsonValueKind.String &&
            long.TryParse(property.GetString(), out longValue))
        {
            return longValue > int.MaxValue ? int.MaxValue : (int)Math.Max(0, longValue);
        }
        return 0;
    }

    private static bool TryParseJsonObject(string value, out JsonElement element)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            element = CreateEmptyObjectElement();
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(value);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                element = CreateEmptyObjectElement();
                return false;
            }

            element = document.RootElement.Clone();
            return true;
        }
        catch (JsonException)
        {
            element = CreateEmptyObjectElement();
            return false;
        }
    }

    private static JsonElement CreateEmptyObjectElement()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private static JsonElement CreateObjectElement(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static JsonElement CreateStringElement(string value)
    {
        return JsonSerializer.SerializeToElement(value, WorkerJsonContext.Default.String);
    }

    private static string NewMessageId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static bool IsReasoningModel(string model)
    {
        return model.StartsWith("o1", StringComparison.OrdinalIgnoreCase) ||
            model.StartsWith("o2", StringComparison.OrdinalIgnoreCase) ||
            model.StartsWith("o3", StringComparison.OrdinalIgnoreCase) ||
            model.StartsWith("o4", StringComparison.OrdinalIgnoreCase);
    }

    private static int EstimateTokenCount(string text)
    {
        return AgentRuntimeThroughput.EstimateTokens(text);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private sealed class ToolCallBuffer
    {
        public ToolCallBuffer(int index)
        {
            Index = index;
        }

        public int Index { get; }

        public string Id { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public StringBuilder Arguments { get; } = new();

        public bool Started { get; set; }

        public AgentRuntimeToolArgumentStreamState ArgumentStream { get; } = new();
    }

    private sealed record AgentLoopCompressionConfig(
        int ContextLength,
        double Threshold,
        int ReservedOutputBudget);

    private sealed record ContextSourceMessageRow(
        string Id,
        int SortOrder,
        long OrderKey,
        long CreatedAt,
        JsonElement Message);

}
