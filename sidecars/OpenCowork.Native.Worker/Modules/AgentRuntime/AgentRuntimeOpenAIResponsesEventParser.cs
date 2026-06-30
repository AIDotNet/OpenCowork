using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static async Task<bool> ProcessJsonEventAsync(
        string? eventName,
        string data,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        using var document = JsonDocument.Parse(data);
        var root = document.RootElement;
        var type = eventName;
        if (string.IsNullOrWhiteSpace(type))
        {
            type = JsonHelpers.GetString(root, "type");
        }
        if (string.IsNullOrWhiteSpace(type))
        {
            return false;
        }

        switch (type)
        {
            case "response.output_text.delta":
                if (JsonHelpers.GetString(root, "delta") is { Length: > 0 } delta)
                {
                    MarkFirstToken(parseState, startedAt);
                    parseState.AssistantText.Append(delta);
                    parseState.EstimatedOutputTokens += EstimateTokenCount(delta);
                    await AgentRuntimeTools.EmitAsync(
                        state,
                        context,
                        new AgentRuntimeStreamEvent("text_delta", Text: delta));
                }
                break;

            case "response.reasoning_summary_text.delta":
            case "response.reasoning_summary_text.done":
                if ((JsonHelpers.GetString(root, "delta") ?? JsonHelpers.GetString(root, "text")) is { Length: > 0 } thinking)
                {
                    MarkFirstToken(parseState, startedAt);
                    parseState.EmittedThinkingDelta = true;
                    await AgentRuntimeTools.EmitAsync(
                        state,
                        context,
                        new AgentRuntimeStreamEvent("thinking_delta", Thinking: thinking));
                }
                break;

            case "response.output_item.added":
                if (root.TryGetProperty("item", out var addedItem))
                {
                    await ProcessOutputItemAddedAsync(addedItem, parseState, state, context);
                }
                break;

            case "response.function_call_arguments.delta":
                await ProcessFunctionArgumentsDeltaAsync(root, parseState, state, context);
                break;

            case "response.function_call_arguments.done":
                FinalizeFunctionCall(root, parseState);
                break;

            case "response.output_item.done":
                if (root.TryGetProperty("item", out var doneItem))
                {
                    await ProcessOutputItemDoneAsync(doneItem, parseState, state, context, startedAt);
                }
                break;

            case "response.image_generation_call.partial_image":
                await ProcessPartialImageAsync(root, parseState, state, context, startedAt);
                break;

            case "response.completed":
            case "response.done":
                var finalResponse = root.TryGetProperty("response", out var response)
                    ? response
                    : root;
                if (finalResponse.ValueKind == JsonValueKind.Object)
                {
                    parseState.ProviderResponseId = JsonHelpers.GetString(finalResponse, "id") ?? parseState.ProviderResponseId;
                    parseState.StopReason = JsonHelpers.GetString(finalResponse, "status") ?? parseState.StopReason;
                    if (TryGetFinalResponseUsage(root, finalResponse, out var usage))
                    {
                        parseState.Usage = ReadResponsesUsage(usage);
                    }
                    WorkerLog.Debug(
                        $"responses final event type={type} hasUsage={parseState.Usage is not null} " +
                        $"providerResponseId={parseState.ProviderResponseId ?? string.Empty}");
                    if (finalResponse.TryGetProperty("output", out var output) &&
                        output.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in output.EnumerateArray())
                        {
                            await ProcessOutputItemDoneAsync(item, parseState, state, context, startedAt);
                        }
                    }
                }
                return true;

            case "response.failed":
            case "error":
                await TryEmitTerminalImageErrorAsync(root, parseState, state, context, startedAt);
                throw new InvalidOperationException($"OpenAI Responses stream error: {root.GetRawText()}");
        }

        return false;
    }

    private static async Task ProcessOutputItemAddedAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var itemType = JsonHelpers.GetString(item, "type");
        if (itemType == "reasoning")
        {
            TryEmitThinkingEncrypted(item, parseState, state, context);
            return;
        }
        if (itemType == "image_generation_call")
        {
            await TryEmitImageGenerationStartedAsync(item, parseState, state, context);
            return;
        }
        if (itemType == "computer_call")
        {
            await ProcessComputerCallAsync(item, parseState, state, context);
            return;
        }
        if (itemType != "function_call")
        {
            return;
        }

        var itemId = JsonHelpers.GetString(item, "id");
        var callId = JsonHelpers.GetString(item, "call_id") ?? itemId;
        var name = JsonHelpers.GetString(item, "name") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(callId) || string.IsNullOrWhiteSpace(name))
        {
            return;
        }
        if (!string.IsNullOrWhiteSpace(itemId))
        {
            parseState.CallIdAliases[itemId] = callId;
        }
        if (!parseState.ToolBuffers.ContainsKey(callId))
        {
            parseState.ToolBuffers[callId] = new ResponsesToolBuffer(callId, name);
        }

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_use_streaming_start",
                ToolCallId: callId,
                ToolName: name));
    }

    private static async Task ProcessFunctionArgumentsDeltaAsync(
        JsonElement root,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var callId = ResolveCallId(root, parseState);
        if (string.IsNullOrWhiteSpace(callId))
        {
            return;
        }
        if (!parseState.ToolBuffers.TryGetValue(callId, out var buffer))
        {
            buffer = new ResponsesToolBuffer(callId, JsonHelpers.GetString(root, "name") ?? string.Empty);
            parseState.ToolBuffers[callId] = buffer;
        }

        if (JsonHelpers.GetString(root, "delta") is { } delta)
        {
            buffer.Arguments.Append(delta);
        }
        if (AgentRuntimeToolArgumentStreaming.TryGetInputForDelta(
            buffer.Arguments.ToString(),
            buffer.ArgumentStream,
            out var partialInput))
        {
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_args_delta",
                    ToolCallId: callId,
                    PartialInput: partialInput));
        }
    }

    private static async Task ProcessOutputItemDoneAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        var itemType = JsonHelpers.GetString(item, "type");
        if (itemType == "function_call")
        {
            FinalizeFunctionCall(item, parseState);
            return;
        }
        if (itemType == "reasoning")
        {
            TryEmitThinkingSummary(item, parseState, state, context, startedAt);
            TryEmitThinkingEncrypted(item, parseState, state, context);
            return;
        }
        if (itemType == "computer_call")
        {
            await ProcessComputerCallAsync(item, parseState, state, context);
            return;
        }
        if (itemType == "image_generation_call")
        {
            await ProcessImageGenerationDoneAsync(item, parseState, state, context, startedAt);
        }
    }


    private static void FinalizeFunctionCall(JsonElement payload, ResponsesParseState parseState)
    {
        var callId = ResolveCallId(payload, parseState);
        var name = JsonHelpers.GetString(payload, "name");
        var argsText = JsonHelpers.GetString(payload, "arguments");
        if (payload.TryGetProperty("item", out var item))
        {
            callId ??= ResolveCallId(item, parseState);
            name ??= JsonHelpers.GetString(item, "name");
            argsText ??= JsonHelpers.GetString(item, "arguments");
        }
        if (string.IsNullOrWhiteSpace(callId))
        {
            return;
        }

        if (!parseState.ToolBuffers.TryGetValue(callId, out var buffer))
        {
            buffer = new ResponsesToolBuffer(callId, name ?? string.Empty);
        }
        if (!string.IsNullOrWhiteSpace(name))
        {
            buffer.Name = name;
        }
        if (!string.IsNullOrWhiteSpace(argsText))
        {
            buffer.Arguments.Clear();
            buffer.Arguments.Append(argsText);
        }
        if (string.IsNullOrWhiteSpace(buffer.Name))
        {
            return;
        }

        var input = TryParseJsonObject(buffer.Arguments.ToString(), out var parsed)
            ? parsed
            : CreateEmptyObjectElement();
        var call = new AgentRuntimeNativeToolCall(callId, buffer.Name, input);
        if (!parseState.EmittedToolCallKeys.Add(BuildToolCallKey(call)))
        {
            return;
        }
        parseState.ToolCalls.Add(call);
        parseState.ToolBuffers.Remove(callId);
    }

    private static void FlushPendingToolCalls(ResponsesParseState parseState)
    {
        foreach (var buffer in parseState.ToolBuffers.Values.ToArray())
        {
            if (string.IsNullOrWhiteSpace(buffer.Name))
            {
                continue;
            }
            var input = TryParseJsonObject(buffer.Arguments.ToString(), out var parsed)
                ? parsed
                : CreateEmptyObjectElement();
            var call = new AgentRuntimeNativeToolCall(buffer.CallId, buffer.Name, input);
            if (parseState.EmittedToolCallKeys.Add(BuildToolCallKey(call)))
            {
                parseState.ToolCalls.Add(call);
            }
        }
        parseState.ToolBuffers.Clear();
    }

    private static void TryEmitThinkingEncrypted(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var encrypted = JsonHelpers.GetString(item, "encrypted_content");
        if (string.IsNullOrWhiteSpace(encrypted) || !parseState.EmittedEncryptedReasoning.Add(encrypted))
        {
            return;
        }
        _ = AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "thinking_encrypted",
                Content: encrypted,
                Provider: "openai-responses"));
    }

    private static void TryEmitThinkingSummary(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (parseState.EmittedThinkingDelta)
        {
            return;
        }
        var thinking = ExtractReasoningSummaryText(item);
        if (string.IsNullOrWhiteSpace(thinking))
        {
            return;
        }
        parseState.EmittedThinkingDelta = true;
        MarkFirstToken(parseState, startedAt);
        _ = AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent("thinking_delta", Thinking: thinking));
    }


    private static AgentRuntimeTokenUsage ReadResponsesUsage(JsonElement usage)
    {
        var inputTokens = ReadFirstPositiveInt(usage, "input_tokens", "prompt_tokens");
        var outputTokens = ReadFirstPositiveInt(usage, "output_tokens", "completion_tokens");
        var cachedTokens = ReadResponsesCacheReadTokens(usage);
        var reasoningTokens = ReadResponsesReasoningTokens(usage);
        var cacheReadRatio = inputTokens > 0 && cachedTokens > 0
            ? Math.Min(1, cachedTokens / (double)inputTokens)
            : (double?)null;
        return new AgentRuntimeTokenUsage(
            inputTokens,
            outputTokens,
            cachedTokens > 0 ? Math.Max(0, inputTokens - cachedTokens) : null,
            cachedTokens > 0 ? cachedTokens : null,
            reasoningTokens > 0 ? reasoningTokens : null,
            inputTokens,
            CacheReadRatio: cacheReadRatio);
    }

    private static bool TryGetFinalResponseUsage(
        JsonElement root,
        JsonElement finalResponse,
        out JsonElement usage)
    {
        if (finalResponse.ValueKind == JsonValueKind.Object &&
            finalResponse.TryGetProperty("usage", out usage))
        {
            return true;
        }
        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("usage", out usage))
        {
            return true;
        }
        usage = default;
        return false;
    }

    private static int ReadResponsesCacheReadTokens(JsonElement usage)
    {
        var cachedTokens = ReadFirstPositiveInt(
            usage,
            "cached_tokens",
            "cache_read_tokens",
            "cache_read_input_tokens",
            "cached_input_tokens");
        if (cachedTokens > 0)
        {
            return cachedTokens;
        }
        foreach (var detailsName in new[] { "input_tokens_details", "prompt_tokens_details" })
        {
            if (usage.TryGetProperty(detailsName, out var details))
            {
                cachedTokens = ReadFirstPositiveInt(
                    details,
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
        return 0;
    }

    private static int ReadResponsesReasoningTokens(JsonElement usage)
    {
        var reasoningTokens = ReadFirstPositiveInt(usage, "reasoning_tokens");
        if (reasoningTokens > 0)
        {
            return reasoningTokens;
        }
        foreach (var detailsName in new[] { "output_tokens_details", "completion_tokens_details" })
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

    private static string? ResolveCallId(JsonElement payload, ResponsesParseState parseState)
    {
        var callId = JsonHelpers.GetString(payload, "call_id");
        if (!string.IsNullOrWhiteSpace(callId))
        {
            return callId;
        }
        var itemId = JsonHelpers.GetString(payload, "item_id") ?? JsonHelpers.GetString(payload, "id");
        if (!string.IsNullOrWhiteSpace(itemId) &&
            parseState.CallIdAliases.TryGetValue(itemId, out var alias))
        {
            return alias;
        }
        return itemId;
    }

}
