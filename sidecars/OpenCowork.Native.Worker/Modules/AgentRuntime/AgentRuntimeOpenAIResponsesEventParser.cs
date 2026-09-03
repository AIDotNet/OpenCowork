using System.Buffers;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static readonly HashSet<string> RetryableResponsesStreamErrorCodes = new(
        StringComparer.OrdinalIgnoreCase)
    {
        "internal_error",
        "overloaded_error",
        "rate_limit_error",
        "rate_limit_exceeded",
        "server_error",
        "server_is_overloaded",
        "service_unavailable",
        "service_unavailable_error",
        "temporarily_unavailable",
        "upstream_error"
    };

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
                if (JsonHelpers.GetString(root, "delta") is { Length: > 0 } rawDelta &&
                    AgentRuntimeStreamDeltaCoalescer.TakeIncrement(parseState.AssistantText, rawDelta)
                        is { Length: > 0 } delta)
                {
                    MarkFirstToken(parseState, startedAt);
                    parseState.EstimatedOutputTokens += EstimateTokenCount(delta);
                    DraftText(parseState, delta);
                    await AgentRuntimeTools.EmitProjectedAsync(
                        state,
                        context,
                        new AgentRuntimeStreamEvent("text_delta", Text: delta));
                }
                break;

            case "response.reasoning_summary_text.delta":
                if ((JsonHelpers.GetString(root, "delta") ?? JsonHelpers.GetString(root, "text"))
                        is { Length: > 0 } rawThinking &&
                    AgentRuntimeStreamDeltaCoalescer.TakeIncrement(parseState.StreamedThinking, rawThinking)
                        is { Length: > 0 } thinking)
                {
                    MarkFirstToken(parseState, startedAt);
                    parseState.EmittedThinkingDelta = true;
                    parseState.ReasoningStreamedLive = true;
                    DraftThinking(parseState, thinking, backfill: false);
                    await AgentRuntimeTools.EmitProjectedAsync(
                        state,
                        context,
                        new AgentRuntimeStreamEvent("thinking_delta", Thinking: thinking));
                }
                break;

            // Completed-part snapshots. Deltas already carried the text; treating
            // `text` as another increment appends the whole summary again.
            case "response.reasoning_summary_text.done":
                break;

            case "response.output_item.added":
                if (root.TryGetProperty("item", out var addedItem))
                {
                    await ProcessOutputItemAddedAsync(addedItem, parseState, state, context, startedAt);
                }
                break;

            case "response.function_call_arguments.delta":
                await ProcessFunctionArgumentsDeltaAsync(root, parseState, state, context, startedAt);
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

            // The render itself is silent, so these mark the stream as "waiting on an image" for
            // the idle deadline even on gateways that never send the output_item.added item.
            case "response.image_generation_call.in_progress":
            case "response.image_generation_call.generating":
                await TryEmitImageGenerationStartedAsync(root, parseState, state, context);
                break;

            case "response.image_generation_call.completed":
                await ProcessImageGenerationDoneAsync(root, parseState, state, context, startedAt);
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
                if (IsWebSocketTransportUnavailableEvent(root))
                {
                    throw new ResponsesWebSocketUnavailableException(
                        $"OpenAI Responses WebSocket transport unavailable: {root.GetRawText()}");
                }
                throw CreateResponsesStreamException(root);
        }

        return false;
    }

    private static AgentRuntimeProviderStreamException CreateResponsesStreamException(JsonElement root)
    {
        var error = root;
        if (root.TryGetProperty("error", out var nestedError) &&
            nestedError.ValueKind == JsonValueKind.Object)
        {
            error = nestedError;
        }
        else if (root.TryGetProperty("response", out var response) &&
            response.ValueKind == JsonValueKind.Object &&
            response.TryGetProperty("error", out var responseError) &&
            responseError.ValueKind == JsonValueKind.Object)
        {
            error = responseError;
        }
        var errorType = JsonHelpers.GetString(error, "type");
        var errorCode = JsonHelpers.GetString(error, "code");
        var code = errorCode ?? errorType ?? "stream_error";
        var message = JsonHelpers.GetString(error, "message") ?? root.GetRawText();
        var retryable =
            (errorType is { Length: > 0 } &&
                RetryableResponsesStreamErrorCodes.Contains(errorType)) ||
            (errorCode is { Length: > 0 } &&
                RetryableResponsesStreamErrorCodes.Contains(errorCode));

        return new AgentRuntimeProviderStreamException(
            "OpenAI Responses",
            code,
            message,
            retryable);
    }

    private static async Task ProcessOutputItemAddedAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
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
        if (itemType == "web_search_call")
        {
            // Surface the search the moment it starts so a live "searching" component
            // appears immediately — the query/sources only land on the completed item
            // (output_item.done), which can arrive seconds later mid-stream. The renderer
            // upserts by id, so the same block is updated in place when done fires.
            WorkerLog.Debug($"responses web_search_call added raw={item.GetRawText()}");
            await EmitWebSearchAsync(item, "searching", parseState, state, context);
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
        // A streaming function call is generated output: tool-only responses must
        // still produce a first-token mark for TTFT/TPS.
        MarkFirstToken(parseState, startedAt);
        if (!string.IsNullOrWhiteSpace(itemId))
        {
            parseState.CallIdAliases[itemId] = callId;
        }
        if (!parseState.ToolBuffers.ContainsKey(callId))
        {
            parseState.ToolBuffers[callId] = new ResponsesToolBuffer(callId, name);
        }

        await AgentRuntimeTools.EmitProjectedAsync(
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
        WorkerRequestContext context,
        long startedAt)
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

        if (JsonHelpers.GetString(root, "delta") is { Length: > 0 } delta)
        {
            MarkFirstToken(parseState, startedAt);
            parseState.EstimatedOutputTokens += EstimateTokenCount(delta);
            buffer.Arguments.Append(delta);
        }
        if (AgentRuntimeToolArgumentStreaming.TryGetInputForDelta(
            buffer.Arguments,
            buffer.ArgumentStream,
            out var partialInput))
        {
            await AgentRuntimeTools.EmitProjectedAsync(
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
            DraftReasoningIdentityFromItem(item, parseState, state, context);
            // The item is finished, so any further reasoning starts its own block rather
            // than growing this one — a turn can hold several reasoning items.
            CloseOpenThinkingDrafts(parseState);
            return;
        }
        if (itemType == "computer_call")
        {
            await ProcessComputerCallAsync(item, parseState, state, context);
            return;
        }
        if (itemType == "web_search_call")
        {
            await EmitWebSearchAsync(item, "completed", parseState, state, context);
            return;
        }
        if (itemType == "image_generation_call")
        {
            await ProcessImageGenerationDoneAsync(item, parseState, state, context, startedAt);
        }
    }

    // OpenAI Responses runs `web_search` server-side, streaming a web_search_call output
    // item (added -> done, then again in the final response.output). We surface it as a
    // display-only component: a live "searching" state on `added`, resolved to the query
    // + sources on `done`. The renderer correlates the two by id and updates in place;
    // the model's grounded answer streams as normal text alongside.
    private static async Task EmitWebSearchAsync(
        JsonElement item,
        string status,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var id = JsonHelpers.GetString(item, "id");
        // Some models/endpoints omit action.query — surface the search anyway so the
        // user at least sees that the model went to the web.
        var query = ExtractWebSearchQuery(item) ?? string.Empty;
        var dedupBase = !string.IsNullOrWhiteSpace(id)
            ? id
            : (!string.IsNullOrWhiteSpace(query) ? $"q:{query}" : "web_search");
        // Dedup per (call, status) so both the "searching" and "completed" emits go out
        // once each — `done` also replays inside the final response.output array.
        if (!parseState.EmittedWebSearchCallIds.Add($"{dedupBase}:{status}"))
        {
            return;
        }
        // action.sources / results are only present when the request asked for them via
        // include=["web_search_call.action.sources", "web_search_call.results"].
        var sources = ExtractWebSearchSources(item);
        WorkerLog.Debug(
            $"responses web_search {status} id={id ?? string.Empty} query='{query}' " +
            $"sources={(sources?.GetArrayLength() ?? 0)}");
        await AgentRuntimeTools.EmitProjectedAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "web_search",
                Content: query,
                Status: status,
                WebSearchId: id,
                WebSearchSources: sources));
    }

    private static string? ExtractWebSearchQuery(JsonElement item)
    {
        if (item.TryGetProperty("action", out var action) && action.ValueKind == JsonValueKind.Object)
        {
            // Some gateways batch several searches into one web_search_call and expose
            // them as action.queries[]; surface all of them (newline-joined) so the chip
            // reflects every query the model ran, not just the first.
            if (action.TryGetProperty("queries", out var queries) &&
                queries.ValueKind == JsonValueKind.Array &&
                queries.GetArrayLength() > 0)
            {
                var collected = new List<string>();
                foreach (var entry in queries.EnumerateArray())
                {
                    if (entry.ValueKind == JsonValueKind.String &&
                        entry.GetString() is { } text &&
                        !string.IsNullOrWhiteSpace(text))
                    {
                        collected.Add(text.Trim());
                    }
                }
                if (collected.Count > 0)
                {
                    return string.Join('\n', collected);
                }
            }
            var actionQuery = JsonHelpers.GetString(action, "query");
            if (!string.IsNullOrWhiteSpace(actionQuery))
            {
                return actionQuery;
            }
        }
        return JsonHelpers.GetString(item, "query");
    }

    private static JsonElement? ExtractWebSearchSources(JsonElement item)
    {
        var entries = new List<(string Url, string? Title)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // results[] (include=web_search_call.results) carries url + title, so read it
        // first — that gives the chips real page titles instead of bare hostnames.
        if (item.TryGetProperty("results", out var results) &&
            results.ValueKind == JsonValueKind.Array)
        {
            CollectWebSearchEntries(results, entries, seen);
        }
        // action.sources (include=web_search_call.action.sources) is usually url-only;
        // use it to backfill any URLs the results list did not already cover.
        if (item.TryGetProperty("action", out var action) &&
            action.ValueKind == JsonValueKind.Object &&
            action.TryGetProperty("sources", out var sources) &&
            sources.ValueKind == JsonValueKind.Array)
        {
            CollectWebSearchEntries(sources, entries, seen);
        }
        if (entries.Count == 0)
        {
            return null;
        }
        // Re-emit a trimmed {url,title} array: results[] entries also carry large snippet
        // blobs we must not clone onto the wire or into the persisted message.
        return BuildWebSearchSourcesElement(entries);
    }

    private static void CollectWebSearchEntries(
        JsonElement array,
        List<(string Url, string? Title)> entries,
        HashSet<string> seen)
    {
        foreach (var entry in array.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object)
            {
                continue;
            }
            var url = JsonHelpers.GetString(entry, "url");
            if (string.IsNullOrWhiteSpace(url) || !seen.Add(url))
            {
                continue;
            }
            var title = JsonHelpers.GetString(entry, "title");
            entries.Add((url, string.IsNullOrWhiteSpace(title) ? null : title));
        }
    }

    private static JsonElement BuildWebSearchSourcesElement(List<(string Url, string? Title)> entries)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            foreach (var (url, title) in entries)
            {
                writer.WriteStartObject();
                writer.WriteString("url", url);
                if (title is not null)
                {
                    writer.WriteString("title", title);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
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

        var rawArguments = buffer.Arguments.ToString();
        var parsedSuccessfully = TryParseJsonObject(rawArguments, out var parsed);
        var input = parsedSuccessfully
            ? parsed
            : CreateEmptyObjectElement();
        var call = new AgentRuntimeNativeToolCall(
            callId,
            buffer.Name,
            input,
            RawArguments: rawArguments,
            ParseError: parsedSuccessfully ? null : "Expected a valid JSON object.");
        if (!parseState.EmittedToolCallKeys.Add(BuildToolCallKey(call)))
        {
            return;
        }
        parseState.ToolCalls.Add(call);
        DraftToolCall(parseState, call);
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
            var rawArguments = buffer.Arguments.ToString();
            var parsedSuccessfully = TryParseJsonObject(rawArguments, out var parsed);
            var input = parsedSuccessfully
                ? parsed
                : CreateEmptyObjectElement();
            var call = new AgentRuntimeNativeToolCall(
                buffer.CallId,
                buffer.Name,
                input,
                RawArguments: rawArguments,
                ParseError: parsedSuccessfully ? null : "Expected a valid JSON object.");
            if (parseState.EmittedToolCallKeys.Add(BuildToolCallKey(call)))
            {
                parseState.ToolCalls.Add(call);
                DraftToolCall(parseState, call);
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
        _ = AgentRuntimeTools.EmitProjectedAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "thinking_encrypted",
                Content: encrypted,
                Provider: "openai-responses"));
    }

    /// <summary>
    /// Record how this reasoning item can be replayed on the next request. Only runs when
    /// the item is complete, so the summary text it belongs to has already been drafted.
    /// The id also goes to the host: this run's own drafts die with the run, and a later
    /// user turn replays history the host persisted, which needs the handle too.
    /// </summary>
    private static void DraftReasoningIdentityFromItem(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var reasoningItemId = JsonHelpers.GetString(item, "id");
        if (string.IsNullOrWhiteSpace(reasoningItemId) ||
            !parseState.DraftedReasoningItemIds.Add(reasoningItemId))
        {
            return;
        }
        var encrypted = JsonHelpers.GetString(item, "encrypted_content");
        DraftReasoningIdentity(
            parseState,
            string.IsNullOrWhiteSpace(encrypted) ? null : encrypted,
            reasoningItemId);
        _ = AgentRuntimeTools.EmitProjectedAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "thinking_reasoning_id",
                ReasoningItemId: reasoningItemId));
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
        var thinking = AgentRuntimeStreamDeltaCoalescer.TakeIncrement(
            parseState.StreamedThinking,
            ExtractReasoningSummaryText(item));
        if (string.IsNullOrWhiteSpace(thinking))
        {
            return;
        }
        parseState.EmittedThinkingDelta = true;
        MarkFirstToken(parseState, startedAt);
        // Gateways that never stream reasoning_summary_text.delta only disclose the
        // summary on the reasoning item, which for some of them arrives inside
        // response.completed — after the answer already streamed. Say so, or the host
        // appends the reasoning below the reply it produced.
        var backfill = parseState.AssistantText.Length > 0;
        DraftThinking(parseState, thinking, backfill);
        _ = AgentRuntimeTools.EmitProjectedAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                backfill ? "thinking_backfill" : "thinking_delta",
                Thinking: thinking));
    }

    private static bool IsWebSocketTransportUnavailableEvent(JsonElement payload)
    {
        if (IsWebSocketTransportUnavailableError(payload))
        {
            return true;
        }
        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("error", out var error) &&
            IsWebSocketTransportUnavailableError(error))
        {
            return true;
        }
        return payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("response", out var response) &&
            response.ValueKind == JsonValueKind.Object &&
            response.TryGetProperty("error", out var responseError) &&
            IsWebSocketTransportUnavailableError(responseError);
    }

    private static bool IsWebSocketTransportUnavailableError(JsonElement error)
    {
        if (error.ValueKind == JsonValueKind.String)
        {
            return IsWebSocketTransportUnavailableText(error.GetString());
        }
        if (error.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var code = JsonHelpers.GetString(error, "code");
        if (!string.IsNullOrWhiteSpace(code) &&
            code.Contains("websocket", StringComparison.OrdinalIgnoreCase) &&
            (code.Contains("unavailable", StringComparison.OrdinalIgnoreCase) ||
                code.Contains("unsupported", StringComparison.OrdinalIgnoreCase) ||
                code.Contains("upgrade", StringComparison.OrdinalIgnoreCase) ||
                code.Contains("handshake", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return IsWebSocketTransportUnavailableText(JsonHelpers.GetString(error, "message"));
    }

    private static bool IsWebSocketTransportUnavailableText(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        if (message.Contains("status code '101' was expected", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("status code \"101\" was expected", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return message.Contains("websocket", StringComparison.OrdinalIgnoreCase) &&
            (message.Contains("handshake", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("upgrade", StringComparison.OrdinalIgnoreCase)) &&
            (message.Contains("not found", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("unsupported", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("unavailable", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("404", StringComparison.OrdinalIgnoreCase));
    }

    private static AgentRuntimeTokenUsage ReadResponsesUsage(JsonElement usage)
    {
        var inputTokens = ReadFirstPositiveInt(usage, "input_tokens", "prompt_tokens");
        var outputTokens = ReadFirstPositiveInt(usage, "output_tokens", "completion_tokens");
        var cachedTokens = ReadResponsesCacheReadTokens(usage);
        var cacheWriteTokens = ReadResponsesCacheWriteTokens(usage);
        var reasoningTokens = ReadResponsesReasoningTokens(usage);
        var cacheReadRatio = inputTokens > 0 && cachedTokens > 0
            ? Math.Min(1, cachedTokens / (double)inputTokens)
            : (double?)null;
        var billableInputTokens = cachedTokens > 0 || cacheWriteTokens > 0
            ? Math.Max(0, inputTokens - cachedTokens - cacheWriteTokens)
            : (int?)null;
        return new AgentRuntimeTokenUsage(
            inputTokens,
            outputTokens,
            billableInputTokens,
            cachedTokens > 0 ? cachedTokens : null,
            reasoningTokens > 0 ? reasoningTokens : null,
            inputTokens,
            CacheCreationTokens: cacheWriteTokens > 0 ? cacheWriteTokens : null,
            CacheReadRatio: cacheReadRatio);
    }

    private static bool TryGetFinalResponseUsage(
        JsonElement root,
        JsonElement finalResponse,
        out JsonElement usage)
    {
        if (finalResponse.ValueKind == JsonValueKind.Object &&
            finalResponse.TryGetProperty("usage", out usage) &&
            usage.ValueKind == JsonValueKind.Object)
        {
            return true;
        }
        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("usage", out usage) &&
            usage.ValueKind == JsonValueKind.Object)
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
            "prompt_cache_hit_tokens",
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

        if (!usage.TryGetProperty("prompt_cache_miss_tokens", out var missProperty) ||
            (missProperty.ValueKind != JsonValueKind.Number &&
             missProperty.ValueKind != JsonValueKind.String))
        {
            return 0;
        }

        var missTokens = ReadInt(usage, "prompt_cache_miss_tokens");
        var promptTokens = ReadFirstPositiveInt(usage, "input_tokens", "prompt_tokens");
        return promptTokens > missTokens ? promptTokens - missTokens : 0;
    }

    private static int ReadResponsesCacheWriteTokens(JsonElement usage)
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
        foreach (var detailsName in new[] { "input_tokens_details", "prompt_tokens_details" })
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
