using System.Buffers;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class OpenAIChatRuntime
{
    private const int ToolResultMaxChars = 16 * 1024;
    private const int ToolResultTextBlockMaxChars = 12 * 1024;
    private const int ToolResultImageDataMaxChars = 4 * 1024;
    private const double DefaultContextCompressionThreshold = 0.8;
    private const int DefaultContextCompressionReservedOutputTokens = 20_000;
    private const int ContextCompressionAutoBufferTokens = 13_000;
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create();
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
        if (providerType is not ("openai-chat" or "openai-responses" or "anthropic" or "gemini" or "vertex-ai"))
        {
            throw new InvalidOperationException($"Native AgentRuntime provider is not migrated yet: {providerType}");
        }

        ValidateProvider(provider);

        var wireConversation = ReadWireConversation(parameters);
        var conversation = ReadConversation(wireConversation);
        var runtimeParameters = CreateRuntimeParametersWithoutMessages(parameters);
        state.ReplaceParameters(runtimeParameters);
        parameters = runtimeParameters;
        provider = GetObject(parameters, "provider");
        var compressionConfig = ReadLoopCompressionConfig(parameters);
        var lastInputTokens = compressionConfig is null ? 0 : FindRecentContextUsage(wireConversation);
        var requestedMaxIterations = JsonHelpers.GetInt(parameters, "maxIterations", 1);
        var hasIterationLimit = requestedMaxIterations > 0;
        var providerTurnOnly = JsonHelpers.GetBool(parameters, "providerTurnOnly", false);
        var captureFinalMessages = JsonHelpers.GetBool(parameters, "captureFinalMessages", false);
        var completed = false;
        var fullCompressionApplied = false;

        WorkerLog.Debug(
            $"agent loop start provider={providerType} maxIterations=" +
            $"{(hasIterationLimit ? requestedMaxIterations.ToString() : "unlimited")} " +
            $"providerTurnOnly={providerTurnOnly} compression={(compressionConfig is null ? "disabled" : "enabled")}");

        for (var iteration = 1; !hasIterationLimit || iteration <= requestedMaxIterations; iteration++)
        {
            if (state.IsCancellationRequested)
            {
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    BuildLoopEndEvent(
                        "aborted",
                        fullCompressionApplied || captureFinalMessages,
                        wireConversation));
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
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("context_compression_start"));

                if (state.IsCancellationRequested)
                {
                    await AgentRuntimeTools.EmitAsync(
                        state,
                        context,
                        BuildLoopEndEvent(
                            "aborted",
                            fullCompressionApplied || captureFinalMessages,
                            wireConversation));
                    return;
                }

                try
                {
                    var originalCount = wireConversation.Count;
                    var preserveCount = iteration == 1 ? GetInitialCompressionPreserveCount(wireConversation) : 0;
                    WorkerLog.Info(
                        $"agent context compression start runId={state.RunId} tokens={lastInputTokens} " +
                        $"messages={originalCount} preserveCount={preserveCount}");
                    var compressed = await AgentRuntimeContextCompression.CompressMessagesAsync(
                        wireConversation,
                        provider,
                        context,
                        focusPrompt: null,
                        preTokens: lastInputTokens,
                        preserveCount,
                        trigger: "auto");
                    if (compressed.Result.Compressed)
                    {
                        wireConversation = compressed.Messages.Select(message => message.Clone()).ToList();
                        conversation = ReadConversation(wireConversation);
                        fullCompressionApplied = true;
                        var summarized = compressed.Result.MessagesSummarized ??
                            Math.Max(0, originalCount - Math.Max(0, compressed.Messages.Length - 2));
                        await AgentRuntimeTools.EmitAsync(
                            state,
                            context,
                            new AgentRuntimeStreamEvent(
                                "context_compressed",
                                OriginalCount: originalCount,
                                NewCount: compressed.Messages.Length,
                                KeptMessageCount: summarized,
                                Messages: compressed.Messages));
                        WorkerLog.Info(
                            $"agent context compression ok runId={state.RunId} original={originalCount} " +
                            $"compressed={compressed.Messages.Length} summarized={summarized}");
                        lastInputTokens = 0;
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    WorkerLog.Warn(
                        $"agent context compression failed runId={state.RunId} error={ex.GetType().Name}: {ex.Message}");
                }
            }

            var injectedMessages = state.DrainQueuedMessages();
            if (injectedMessages.Count > 0)
            {
                wireConversation.AddRange(injectedMessages.Select(message => message.Clone()));
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
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    BuildLoopEndEvent(
                        "aborted",
                        fullCompressionApplied || captureFinalMessages,
                        wireConversation));
                return;
            }

            var turn = await ExecuteTurnAsync(parameters, provider, conversation, state, context);
            conversation.Add(turn.AssistantMessage);
            wireConversation.Add(CreateAssistantWireMessage(turn.AssistantMessage, turn.Usage));
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

            var toolResults = await ExecuteToolCallsAsync(
                parameters,
                turn.ToolCalls,
                state,
                context);

            conversation.Add(AgentRuntimeChatMessage.UserToolResults(toolResults));
            wireConversation.Add(CreateToolResultsWireMessage(toolResults));
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

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            BuildLoopEndEvent(
                state.StopReason ?? (completed ? "completed" : "max_iterations"),
                fullCompressionApplied || captureFinalMessages,
                wireConversation));
    }

    internal static async Task<AgentRuntimeProviderTurnResult> ExecuteProviderTurnAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider");
        var providerType = JsonHelpers.GetString(provider, "type") ?? string.Empty;
        if (providerType is not ("openai-chat" or "openai-responses" or "anthropic" or "gemini" or "vertex-ai"))
        {
            throw new InvalidOperationException($"Native AgentRuntime provider is not migrated yet: {providerType}");
        }

        ValidateProvider(provider);
        var conversation = ReadConversation(parameters);
        return await ExecuteTurnAsync(parameters, provider, conversation, state, context);
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
                if (property.NameEquals("messages"))
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

    private static int GetInitialCompressionPreserveCount(IReadOnlyList<JsonElement> messages)
    {
        return ShouldPreserveInitialUserMessage(messages.Count > 0 ? messages[^1] : default) ? 1 : 0;
    }

    private static bool ShouldPreserveInitialUserMessage(JsonElement message)
    {
        if (message.ValueKind != JsonValueKind.Object ||
            JsonHelpers.GetString(message, "role") != "user" ||
            IsCompactSummaryLikeMessage(message))
        {
            return false;
        }

        if (!message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array ||
            content.GetArrayLength() == 0)
        {
            return true;
        }

        return !content.EnumerateArray().All(block => JsonHelpers.GetString(block, "type") == "tool_result");
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
        if (providerType is "gemini" or "vertex-ai")
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
                    model)));

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider, JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);

        var startedAt = Stopwatch.GetTimestamp();
        long? firstTokenMs = null;
        var estimatedOutputTokens = 0;
        AgentRuntimeTokenUsage? finalUsage = null;
        var finalStopReason = "stop";
        var assistantText = new StringBuilder();
        var toolBuffers = new Dictionary<int, ToolCallBuffer>();
        var toolCalls = new List<AgentRuntimeNativeToolCall>();

        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(state.CancellationToken);
            throw new InvalidOperationException(
                $"OpenAI-compatible chat request failed HTTP {(int)response.StatusCode}: {errorBody}");
        }

        await using var responseStream = await response.Content.ReadAsStreamAsync(state.CancellationToken);
        using var reader = new StreamReader(responseStream, Encoding.UTF8);
        var dataBuilder = new StringBuilder();
        var rawResponseBuilder = new StringBuilder();
        var sawSsePayload = false;
        string? line;
        while ((line = await reader.ReadLineAsync(state.CancellationToken)) is not null)
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
                        state,
                        context,
                        startedAt,
                        value => firstTokenMs ??= value,
                        value => estimatedOutputTokens += value,
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
                state,
                context,
                startedAt,
                value => firstTokenMs ??= value,
                value => estimatedOutputTokens += value,
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
                    ComputeTps(finalUsage?.OutputTokens ?? estimatedOutputTokens, firstTokenMs, totalMs))));

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
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt,
        Action<long> markFirstTokenMs,
        Action<int> addEstimatedOutputTokens,
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
            var reasoning = ReadString(delta, "reasoning_content") ??
                ReadString(delta, "reasoning");
            if (!string.IsNullOrEmpty(reasoning))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("thinking_delta", Thinking: reasoning));
            }

            var text = ReadString(delta, "content");
            if (!string.IsNullOrEmpty(text))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                addEstimatedOutputTokens(EstimateTokenCount(text));
                assistantText.Append(text);
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("text_delta", Text: text));
            }

            if (delta.TryGetProperty("tool_calls", out var toolCalls) &&
                toolCalls.ValueKind == JsonValueKind.Array)
            {
                foreach (var fragment in toolCalls.EnumerateArray())
                {
                    await ProcessToolCallFragmentAsync(fragment, toolBuffers, state, context);
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
            return true;
        }

        if (toolBuffers.Count > 0)
        {
            FlushRemainingToolBuffers(toolBuffers, completedToolCalls);
        }

        return finishReason is "stop" or "length" or "content_filter";
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
            var reasoning = ReadString(message, "reasoning_content") ??
                ReadString(message, "reasoning");
            if (!string.IsNullOrEmpty(reasoning))
            {
                markFirstTokenMs(ElapsedMs(startedAt));
                await AgentRuntimeTools.EmitAsync(
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
                await AgentRuntimeTools.EmitAsync(
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
        WorkerRequestContext context)
    {
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
                buffer.Arguments.Append(argumentsDelta);
            }
        }

        if (!buffer.Started && !string.IsNullOrEmpty(buffer.Id) && !string.IsNullOrEmpty(buffer.Name))
        {
            buffer.Started = true;
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_streaming_start",
                    ToolCallId: buffer.Id,
                    ToolName: buffer.Name));
        }

        if (buffer.Started &&
            AgentRuntimeToolArgumentStreaming.TryGetInputForDelta(
                buffer.Arguments.ToString(),
                buffer.ArgumentStream,
                out var partialInput))
        {
            await AgentRuntimeTools.EmitAsync(
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
            var input = TryParseJsonObject(buffer.Arguments.ToString(), out var parsedInput)
                ? parsedInput
                : CreateEmptyObjectElement();
            completedToolCalls.Add(new AgentRuntimeNativeToolCall(id, name, input));
        }
        toolBuffers.Clear();
    }

    private static async Task<List<AgentRuntimeToolResult>> ExecuteToolCallsAsync(
        JsonElement parameters,
        IReadOnlyList<AgentRuntimeNativeToolCall> toolCalls,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var toolResults = new List<AgentRuntimeToolResult>(toolCalls.Count);
        foreach (var call in toolCalls)
        {
            var nativeTool = AgentRuntimeNativeToolExecutor.CanExecute(call.Name, parameters);
            WorkerLog.Debug(
                $"agent tool dispatch runId={state.RunId} tool={call.Name} id={call.Id} " +
                $"executionPath={(nativeTool ? "native-aot" : "native-missing")}");
            var requiresApproval = JsonHelpers.GetBool(parameters, "forceApproval", false) ||
                (nativeTool && AgentRuntimeNativeToolExecutor.RequiresApproval(call.Name, call.Input, parameters));
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

            if (requiresApproval)
            {
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("tool_call_approval_needed", ToolCall: pendingCall));

                var approved = await RequestApprovalAsync(parameters, pendingCall, state, context);
                if (!approved)
                {
                    var deniedContent = CreateStringElement("Permission denied by user");
                    var deniedAt = NowMs();
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
                                deniedContent,
                                "User denied permission",
                                true,
                                deniedAt,
                                deniedAt)));
                    toolResults.Add(new AgentRuntimeToolResult(call.Id, deniedContent, true));
                    continue;
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

            var result = nativeTool
                ? await AgentRuntimeNativeToolExecutor.ExecuteAsync(
                    new NativeToolCallView(call.Id, call.Name, call.Input),
                    parameters,
                    state,
                    context,
                    state.CancellationToken)
                : CreateMissingNativeToolResult(call.Name);
            var completedAt = NowMs();
            var status = result.IsError ? "error" : "completed";
            var boundedContent = LimitToolResultContent(result.Content);
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
            toolResults.Add(new AgentRuntimeToolResult(
                call.Id,
                boundedContent,
                result.IsError ? true : null));
        }

        return toolResults;
    }

    private static async Task<bool> RequestApprovalAsync(
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
        return JsonHelpers.GetBool(result, "approved", false);
    }

    private static RendererToolResult CreateMissingNativeToolResult(string toolName)
    {
        var message = $"Native tool not registered: {toolName}";
        return new RendererToolResult(CreateStringElement(message), true, message);
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
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = GetOmittedBodyKeys(provider);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            if (!omitted.Contains("messages"))
            {
                writer.WritePropertyName("messages");
                WriteMessages(writer, conversation, provider);
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

            WriteThinkingConfig(writer, provider, omitted);
            ApplyBodyOverrides(writer, provider, omitted);

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteMessages(
        Utf8JsonWriter writer,
        IReadOnlyList<AgentRuntimeChatMessage> messages,
        JsonElement provider)
    {
        writer.WriteStartArray();
        if (JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
        {
            writer.WriteStartObject();
            writer.WriteString("role", "system");
            writer.WriteString("content", systemPrompt);
            writer.WriteEndObject();
        }

        foreach (var message in messages)
        {
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
                if (!string.IsNullOrWhiteSpace(message.Text))
                {
                    writer.WriteStartObject();
                    writer.WriteString("role", "user");
                    writer.WriteString("content", message.Text);
                    writer.WriteEndObject();
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
                schema.WriteTo(writer);
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
        if (!thinkingConfig.TryGetProperty(propertyName, out var bodyParams) ||
            bodyParams.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in bodyParams.EnumerateObject())
        {
            if (omitted.Contains(property.Name))
            {
                continue;
            }
            property.WriteTo(writer);
        }

        if (thinkingEnabled &&
            !omitted.Contains("reasoning_effort") &&
            JsonHelpers.GetString(provider, "reasoningEffort") is { Length: > 0 } reasoningEffort)
        {
            writer.WriteString("reasoning_effort", reasoningEffort);
        }
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
        var result = new List<JsonElement>();
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("messages", out var messages) ||
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

    private static List<AgentRuntimeChatMessage> ReadConversation(JsonElement parameters)
    {
        return ReadConversation(ReadWireConversation(parameters));
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
        if (JsonHelpers.GetString(provider, "userAgent") is { Length: > 0 } userAgent)
        {
            request.Headers.UserAgent.ParseAdd(userAgent);
        }
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
        if (JsonHelpers.GetString(provider, "userAgent") is { Length: > 0 } userAgent)
        {
            headers["User-Agent"] = userAgent;
        }
        ApplyDebugHeaderOverrides(headers, provider);
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

        var arguments = ReadString(function, "arguments");
        var input = TryParseJsonObject(arguments ?? string.Empty, out var parsedInput)
            ? parsedInput
            : CreateEmptyObjectElement();
        toolCall = new AgentRuntimeNativeToolCall(
            string.IsNullOrWhiteSpace(id)
                ? $"call_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}"
                : id,
            name,
            input);
        return true;
    }

    private static bool TryReadUsage(JsonElement usage, out AgentRuntimeTokenUsage tokenUsage)
    {
        var inputTokens = ReadInt(usage, "prompt_tokens");
        var outputTokens = ReadInt(usage, "completion_tokens");
        var cachedTokens = 0;
        var reasoningTokens = 0;
        if (usage.TryGetProperty("prompt_tokens_details", out var promptDetails))
        {
            cachedTokens = ReadInt(promptDetails, "cached_tokens");
        }
        if (usage.TryGetProperty("completion_tokens_details", out var completionDetails))
        {
            reasoningTokens = ReadInt(completionDetails, "reasoning_tokens");
        }
        tokenUsage = new AgentRuntimeTokenUsage(
            inputTokens,
            outputTokens,
            cachedTokens > 0 ? Math.Max(0, inputTokens - cachedTokens) : null,
            cachedTokens > 0 ? cachedTokens : null,
            reasoningTokens > 0 ? reasoningTokens : null,
            inputTokens);
        return inputTokens > 0 || outputTokens > 0;
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
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Number &&
            property.TryGetInt32(out var value))
        {
            return value;
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
        return string.IsNullOrWhiteSpace(text) ? 0 : Math.Max(1, text.Length / 4);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenMs, long completedMs)
    {
        if (!firstTokenMs.HasValue || outputTokens <= 0)
        {
            return null;
        }
        var durationMs = completedMs - firstTokenMs.Value;
        return durationMs <= 0 ? null : outputTokens / (durationMs / 1000.0);
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

}
