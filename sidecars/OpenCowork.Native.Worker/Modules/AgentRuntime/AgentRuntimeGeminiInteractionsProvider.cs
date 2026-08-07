using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

/// <summary>
/// Google Gemini Interactions API transport (POST {base}/interactions).
///
/// Interactions replaces generateContent as Google's forward-looking surface: a single
/// endpoint for models and agents whose response is a timeline of typed execution
/// "steps" (thought / model_output / function_call / function_result) instead of
/// candidates[].content.parts[].
///
/// This runs STATELESS: every turn re-sends the full conversation as input steps and
/// sets store=false, so no conversation data is retained server-side and
/// previous_interaction_id is never needed. That matches the runtime's own conversation
/// bookkeeping in <see cref="OpenAIChatRuntime"/>.
/// </summary>
internal static class AgentRuntimeGeminiInteractionsProvider
{
    // Infinite client timeout: the effective deadline is user-configurable and therefore
    // applied per request via AgentRuntimeRequestTimeout.
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: Timeout.InfiniteTimeSpan);
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<AgentRuntimeProviderTurnResult> ExecuteTurnAsync(
        JsonElement parameters,
        JsonElement provider,
        List<AgentRuntimeChatMessage> conversation,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        var url = BuildApiUrl(JsonHelpers.GetString(provider, "baseUrl"));
        var body = BuildRequestBody(parameters, provider, conversation);
        var debugBody = AgentRuntimeDebugPayload.PrepareBodyFile(body, parameters);

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "request_debug",
                DebugInfo: new AgentRuntimeRequestDebugInfo(
                    url,
                    "POST",
                    BuildDebugHeaders(provider),
                    AgentRuntimeDebugPayload.PrepareBody(body, parameters),
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    JsonHelpers.GetString(provider, "providerId"),
                    JsonHelpers.GetString(provider, "providerBuiltinId"),
                    model,
                    BodyRef: debugBody?.Ref,
                    BodyBytes: debugBody?.Bytes)));

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider);

        var startedAt = Stopwatch.GetTimestamp();
        var parseState = new InteractionsParseState();
        WorkerLog.Debug($"gemini interactions request start model={model} url={url}");

        using var response = await AgentRuntimeRequestTimeout.SendAsync(
            Http,
            request,
            provider,
            "Gemini Interactions",
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw await AgentRuntimeProviderHttpException.CreateAsync(
                "Gemini Interactions",
                response,
                state.CancellationToken);
        }

        await using var responseStream = await response.Content.ReadAsStreamAsync(state.CancellationToken);
        using var reader = new StreamReader(responseStream, Encoding.UTF8);
        var dataBuilder = new StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync(state.CancellationToken)) is not null)
        {
            if (line.Length == 0)
            {
                await FlushSseDataAsync(dataBuilder, parseState, state, context, startedAt);
                continue;
            }

            // `event:` lines duplicate the `event_type`/`type` field inside the JSON payload,
            // so the payload alone is enough to dispatch.
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (dataBuilder.Length > 0)
                {
                    dataBuilder.Append('\n');
                }
                dataBuilder.Append(line[5..].TrimStart());
                continue;
            }

            if (LooksLikeJson(line))
            {
                await ProcessEventAsync(line, parseState, state, context, startedAt);
            }
        }

        await FlushSseDataAsync(dataBuilder, parseState, state, context, startedAt);

        var totalMs = ElapsedMs(startedAt);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "message_end",
                StopReason: parseState.StopReason,
                Usage: parseState.Usage,
                Timing: new AgentRuntimeRequestTiming(
                    totalMs,
                    parseState.FirstTokenMs,
                    ComputeTps(
                        parseState.Usage?.OutputTokens ?? parseState.EstimatedOutputTokens,
                        parseState.FirstTokenMs,
                        totalMs))));

        return new AgentRuntimeProviderTurnResult(
            new AgentRuntimeChatMessage(
                "assistant",
                parseState.AssistantText.ToString(),
                parseState.ToolCalls
                    .Select(call => new AgentRuntimeChatToolUse(call.Id, call.Name, call.Input))
                    .ToList(),
                [],
                parseState.InteractionId),
            parseState.ToolCalls,
            parseState.StopReason,
            parseState.Usage);
    }

    private static async Task FlushSseDataAsync(
        StringBuilder dataBuilder,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (dataBuilder.Length == 0)
        {
            return;
        }

        var data = dataBuilder.ToString();
        dataBuilder.Clear();
        if (data != "[DONE]")
        {
            await ProcessEventAsync(data, parseState, state, context, startedAt);
        }
    }

    private static async Task ProcessEventAsync(
        string data,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(data);
        }
        catch (JsonException)
        {
            WorkerLog.Debug("gemini interactions skipped non-JSON stream chunk");
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            // A non-streaming response (or a `store=true` echo) is the full Interaction
            // resource rather than an SSE event: replay its steps through the same path.
            var eventType = JsonHelpers.GetString(root, "event_type") ??
                JsonHelpers.GetString(root, "type");
            if (string.IsNullOrEmpty(eventType))
            {
                await ProcessInteractionResourceAsync(root, parseState, state, context, startedAt);
                return;
            }

            switch (eventType)
            {
                case "interaction.created":
                case "interaction.in_progress":
                case "interaction.completed":
                case "interaction.requires_action":
                case "interaction.failed":
                case "interaction.cancelled":
                case "interaction.status_update":
                    ApplyInteractionEnvelope(root, parseState);
                    break;
                case "step.start":
                    await ProcessStepStartAsync(root, parseState, state, context, startedAt);
                    break;
                case "step.delta":
                    await ProcessStepDeltaAsync(root, parseState, state, context, startedAt);
                    break;
                case "step.stop":
                    await ProcessStepStopAsync(root, parseState, state, context, startedAt);
                    break;
                case "error":
                    throw new InvalidOperationException(
                        $"Gemini Interactions stream error: {ReadStreamErrorMessage(root)}");
            }
        }
    }

    /// <summary>
    /// Reads the interaction envelope shared by `interaction.*` events: id, terminal
    /// status (mapped to a stop reason) and usage totals when present.
    /// </summary>
    private static void ApplyInteractionEnvelope(JsonElement root, InteractionsParseState parseState)
    {
        var interaction = root.TryGetProperty("interaction", out var value) &&
            value.ValueKind == JsonValueKind.Object
                ? value
                : default;

        var id = JsonHelpers.GetString(interaction, "id") ??
            JsonHelpers.GetString(root, "interaction_id");
        if (!string.IsNullOrWhiteSpace(id))
        {
            parseState.InteractionId = id;
        }

        var status = JsonHelpers.GetString(interaction, "status") ??
            JsonHelpers.GetString(root, "status");
        if (MapStatusToStopReason(status) is { Length: > 0 } stopReason)
        {
            parseState.StopReason = stopReason;
        }

        if (interaction.ValueKind == JsonValueKind.Object &&
            interaction.TryGetProperty("usage", out var usage) &&
            usage.ValueKind == JsonValueKind.Object)
        {
            parseState.Usage = ReadUsage(usage);
        }
    }

    private static async Task ProcessInteractionResourceAsync(
        JsonElement interaction,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (JsonHelpers.GetString(interaction, "id") is { Length: > 0 } id)
        {
            parseState.InteractionId = id;
        }
        if (MapStatusToStopReason(JsonHelpers.GetString(interaction, "status")) is { Length: > 0 } stopReason)
        {
            parseState.StopReason = stopReason;
        }
        if (interaction.TryGetProperty("usage", out var usage) &&
            usage.ValueKind == JsonValueKind.Object)
        {
            parseState.Usage = ReadUsage(usage);
        }

        if (!interaction.TryGetProperty("steps", out var steps) ||
            steps.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var step in steps.EnumerateArray())
        {
            await ProcessCompleteStepAsync(step, parseState, state, context, startedAt);
        }
    }

    /// <summary>
    /// `step.start` carries the step shape. Terminal steps (function_call arguments that
    /// arrived whole, model_output text) may already be complete here, so emit whatever
    /// payload is present and let <see cref="ProcessStepDeltaAsync"/> handle the rest.
    /// </summary>
    private static async Task ProcessStepStartAsync(
        JsonElement root,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (!root.TryGetProperty("step", out var step) || step.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var index = JsonHelpers.GetIntNullable(root, "index");
        var stepType = JsonHelpers.GetString(step, "type") ?? string.Empty;
        if (index is { } stepIndex)
        {
            parseState.StepTypesByIndex[stepIndex] = stepType;
            if (stepType == "function_call")
            {
                parseState.PendingToolCalls[stepIndex] = new PendingToolCall(
                    JsonHelpers.GetString(step, "id"),
                    JsonHelpers.GetString(step, "name"));
            }
        }

        await ProcessCompleteStepAsync(step, parseState, state, context, startedAt);
    }

    /// <summary>
    /// Handles a step object that already holds its full payload: either replayed from a
    /// non-streaming Interaction resource, or inlined on `step.start`.
    /// </summary>
    private static async Task ProcessCompleteStepAsync(
        JsonElement step,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        switch (JsonHelpers.GetString(step, "type"))
        {
            case "thought":
                await EmitContentAsync(step, thinking: true, parseState, state, context, startedAt);
                break;
            case "model_output":
                await EmitContentAsync(step, thinking: false, parseState, state, context, startedAt);
                break;
            case "function_call":
                await TryEmitToolCallAsync(step, parseState, state, context, startedAt);
                break;
        }
    }

    private static async Task ProcessStepDeltaAsync(
        JsonElement root,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (!root.TryGetProperty("delta", out var delta) || delta.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var index = JsonHelpers.GetIntNullable(root, "index");
        var deltaType = JsonHelpers.GetString(delta, "type") ?? string.Empty;
        switch (deltaType)
        {
            case "thought":
                await EmitTextAsync(
                    JsonHelpers.GetString(delta, "text"),
                    thinking: true,
                    parseState,
                    state,
                    context,
                    startedAt);
                break;
            case "text":
                // A text delta inside a `thought` step is still reasoning, not output.
                await EmitTextAsync(
                    JsonHelpers.GetString(delta, "text"),
                    thinking: IsThoughtStep(parseState, index),
                    parseState,
                    state,
                    context,
                    startedAt);
                break;
            case "image":
                await EmitImageAsync(delta, parseState, state, context, startedAt);
                break;
            case "thought_signature":
                EmitThinkingEncrypted(
                    JsonHelpers.GetString(delta, "signature"),
                    parseState,
                    state,
                    context);
                break;
            case "arguments":
            case "arguments_delta":
                AccumulateToolArguments(delta, parseState, index);
                break;
        }
    }

    /// <summary>
    /// `step.stop` is the only reliable signal that a streamed function_call has all of
    /// its arguments, so the tool call is emitted here rather than on the last delta.
    /// </summary>
    private static async Task ProcessStepStopAsync(
        JsonElement root,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (JsonHelpers.GetIntNullable(root, "index") is not { } index)
        {
            return;
        }

        if (parseState.PendingToolCalls.Remove(index, out var pending))
        {
            parseState.FirstTokenMs ??= ElapsedMs(startedAt);
            await CommitToolCallAsync(pending, parseState, state, context);
        }
        parseState.StepTypesByIndex.Remove(index);
    }

    private static async Task EmitContentAsync(
        JsonElement step,
        bool thinking,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (!step.TryGetProperty("content", out var content))
        {
            return;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            await EmitTextAsync(content.GetString(), thinking, parseState, state, context, startedAt);
            return;
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var block in content.EnumerateArray())
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                    await EmitTextAsync(
                        JsonHelpers.GetString(block, "text"),
                        thinking,
                        parseState,
                        state,
                        context,
                        startedAt);
                    break;
                case "image":
                    await EmitImageAsync(block, parseState, state, context, startedAt);
                    break;
                case "thought_signature":
                    EmitThinkingEncrypted(
                        JsonHelpers.GetString(block, "signature"),
                        parseState,
                        state,
                        context);
                    break;
            }
        }
    }

    private static async Task EmitTextAsync(
        string? text,
        bool thinking,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        parseState.FirstTokenMs ??= ElapsedMs(startedAt);
        if (thinking)
        {
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent("thinking_delta", Thinking: text));
            return;
        }

        parseState.AssistantText.Append(text);
        parseState.EstimatedOutputTokens += EstimateTokens(text);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent("text_delta", Text: text));
    }

    private static async Task EmitImageAsync(
        JsonElement block,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        var data = JsonHelpers.GetString(block, "data");
        if (string.IsNullOrWhiteSpace(data) || !parseState.EmittedImages.Add(data))
        {
            return;
        }

        parseState.FirstTokenMs ??= ElapsedMs(startedAt);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "image_generated",
                ImageBlock: AgentRuntimeProviderSupport.CreateImageBlockElement(
                    data,
                    JsonHelpers.GetString(block, "mime_type"))));
    }

    private static void EmitThinkingEncrypted(
        string? signature,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        if (string.IsNullOrWhiteSpace(signature) ||
            !parseState.EmittedEncryptedReasoning.Add(signature))
        {
            return;
        }

        _ = AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "thinking_encrypted",
                Content: signature,
                Provider: "google"));
    }

    private static void AccumulateToolArguments(
        JsonElement delta,
        InteractionsParseState parseState,
        int? index)
    {
        if (index is not { } stepIndex)
        {
            return;
        }

        // Argument deltas are string fragments, but a delta may also carry the whole
        // argument object at once (same shape as `function_call.arguments`).
        var chunk = JsonHelpers.GetString(delta, "partial_arguments");
        if (string.IsNullOrEmpty(chunk) &&
            delta.TryGetProperty("arguments", out var arguments))
        {
            chunk = arguments.ValueKind switch
            {
                JsonValueKind.String => arguments.GetString(),
                JsonValueKind.Object => arguments.GetRawText(),
                _ => null
            };
        }
        if (string.IsNullOrEmpty(chunk))
        {
            return;
        }

        if (!parseState.PendingToolCalls.TryGetValue(stepIndex, out var pending))
        {
            pending = new PendingToolCall(null, null);
            parseState.PendingToolCalls[stepIndex] = pending;
        }
        pending.Arguments.Append(chunk);
    }

    private static async Task TryEmitToolCallAsync(
        JsonElement step,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        if (JsonHelpers.GetString(step, "name") is not { Length: > 0 } name)
        {
            return;
        }

        // Streaming shape: arguments arrive as deltas and are committed on step.stop.
        if (!step.TryGetProperty("arguments", out var arguments))
        {
            return;
        }

        var rawArguments = arguments.ValueKind == JsonValueKind.String
            ? arguments.GetString() ?? string.Empty
            : arguments.GetRawText();
        var parsedSuccessfully = arguments.ValueKind == JsonValueKind.Object ||
            (arguments.ValueKind == JsonValueKind.String &&
             TryParseJsonObject(rawArguments, out _));
        var input = arguments.ValueKind == JsonValueKind.Object
            ? arguments.Clone()
            : TryParseJsonObject(rawArguments, out var parsed)
                ? parsed
                : AgentRuntimeProviderSupport.CreateEmptyObjectElement();

        parseState.FirstTokenMs ??= ElapsedMs(startedAt);
        await EmitToolCallAsync(
            JsonHelpers.GetString(step, "id"),
            name,
            input,
            rawArguments,
            parsedSuccessfully ? null : "Expected a valid JSON object.",
            parseState,
            state,
            context);
    }

    private static async Task CommitToolCallAsync(
        PendingToolCall pending,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        if (pending.Name is not { Length: > 0 } name)
        {
            return;
        }

        var rawArguments = pending.Arguments.ToString();
        var parsedSuccessfully = TryParseJsonObject(rawArguments, out var parsed);
        var input = parsedSuccessfully
            ? parsed
            : AgentRuntimeProviderSupport.CreateEmptyObjectElement();
        await EmitToolCallAsync(
            pending.Id,
            name,
            input,
            rawArguments,
            parsedSuccessfully ? null : "Expected a valid JSON object.",
            parseState,
            state,
            context);
    }

    private static async Task EmitToolCallAsync(
        string? id,
        string name,
        JsonElement input,
        string? rawArguments,
        string? parseError,
        InteractionsParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var signature = $"{name}:{input.GetRawText()}";
        if (!parseState.EmittedToolSignatures.Add(signature))
        {
            return;
        }

        var callId = string.IsNullOrWhiteSpace(id)
            ? $"gemini_{name}_{parseState.ToolCalls.Count + 1}"
            : id;
        parseState.ToolCalls.Add(new AgentRuntimeNativeToolCall(
            callId,
            name,
            input,
            RawArguments: rawArguments,
            ParseError: parseError));

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_use_streaming_start",
                ToolCallId: callId,
                ToolName: name));
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_use_args_delta",
                ToolCallId: callId,
                PartialInput: input));
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

            if (!omitted.Contains("input"))
            {
                writer.WritePropertyName("input");
                WriteInputSteps(writer, conversation);
            }

            if (!omitted.Contains("system_instruction") &&
                JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
            {
                writer.WriteString("system_instruction", systemPrompt);
            }

            if (!omitted.Contains("tools"))
            {
                WriteTools(writer, parameters);
            }

            if (!omitted.Contains("generation_config"))
            {
                WriteGenerationConfig(writer, provider, omitted);
            }

            if (!omitted.Contains("stream"))
            {
                writer.WriteBoolean("stream", true);
            }

            // Stateless by design: the runtime owns conversation history, so nothing is
            // retained server-side and previous_interaction_id is never used.
            if (!omitted.Contains("store"))
            {
                writer.WriteBoolean("store", false);
            }

            ApplyBodyOverrides(writer, provider, omitted);

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    /// <summary>
    /// Projects the runtime conversation onto the Interactions input timeline:
    /// user text becomes `user_input`, assistant text becomes `model_output`, tool uses
    /// become `function_call`, and tool results become `function_result`.
    /// </summary>
    private static void WriteInputSteps(
        Utf8JsonWriter writer,
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var toolNameById = new Dictionary<string, string>(StringComparer.Ordinal);

        writer.WriteStartArray();
        foreach (var message in conversation)
        {
            if (message.Role == "system")
            {
                continue;
            }

            var isAssistant = message.Role == "assistant";
            if (!string.IsNullOrEmpty(message.Text))
            {
                writer.WriteStartObject();
                writer.WriteString("type", isAssistant ? "model_output" : "user_input");
                writer.WritePropertyName("content");
                writer.WriteStartArray();
                writer.WriteStartObject();
                writer.WriteString("type", "text");
                writer.WriteString("text", message.Text);
                writer.WriteEndObject();
                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            foreach (var toolUse in message.ToolUses)
            {
                toolNameById[toolUse.Id] = toolUse.Name;
                writer.WriteStartObject();
                writer.WriteString("type", "function_call");
                writer.WriteString("id", toolUse.Id);
                writer.WriteString("name", toolUse.Name);
                writer.WritePropertyName("arguments");
                toolUse.Input.WriteTo(writer);
                writer.WriteEndObject();
            }

            foreach (var result in message.ToolResults)
            {
                writer.WriteStartObject();
                writer.WriteString("type", "function_result");
                writer.WriteString("call_id", result.ToolUseId);
                if (toolNameById.TryGetValue(result.ToolUseId, out var toolName))
                {
                    writer.WriteString("name", toolName);
                }
                writer.WritePropertyName("result");
                WriteToolResultContent(writer, result.Content);
                writer.WriteEndObject();
            }
        }
        writer.WriteEndArray();
    }

    private static void WriteToolResultContent(Utf8JsonWriter writer, JsonElement content)
    {
        writer.WriteStartArray();
        writer.WriteStartObject();
        writer.WriteString("type", "text");
        writer.WriteString("text", AgentRuntimeProviderSupport.ToolResultToString(content));
        writer.WriteEndObject();
        writer.WriteEndArray();
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

            // Interactions flattens tool declarations: each entry is a discriminated
            // union keyed by `type` instead of generateContent's functionDeclarations.
            writer.WriteStartObject();
            writer.WriteString("type", "function");
            writer.WriteString("name", name);
            writer.WriteString("description", JsonHelpers.GetString(tool, "description") ?? string.Empty);
            writer.WritePropertyName("parameters");
            if (tool.TryGetProperty("inputSchema", out var schema))
            {
                WriteSanitizedSchema(writer, schema);
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
        }
        writer.WriteEndArray();
    }

    private static void WriteGenerationConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
    {
        var temperature = omitted.Contains("temperature")
            ? null
            : JsonHelpers.GetDoubleNullable(provider, "temperature");
        var maxTokens = omitted.Contains("max_output_tokens")
            ? null
            : JsonHelpers.GetIntNullable(provider, "maxTokens");
        var thinkingLevel = omitted.Contains("thinking_level")
            ? null
            : ResolveThinkingLevel(provider);

        if (temperature is null && maxTokens is null && thinkingLevel is null)
        {
            return;
        }

        writer.WritePropertyName("generation_config");
        writer.WriteStartObject();
        if (temperature is { } temperatureValue)
        {
            writer.WriteNumber("temperature", temperatureValue);
        }
        if (maxTokens is { } maxTokensValue && maxTokensValue > 0)
        {
            writer.WriteNumber("max_output_tokens", maxTokensValue);
        }
        if (thinkingLevel is { Length: > 0 } level)
        {
            writer.WriteString("thinking_level", level);
        }
        writer.WriteEndObject();
    }

    /// <summary>
    /// Maps the app's reasoning-effort selection onto Interactions' `thinking_level`
    /// enum (minimal/low/medium/high). Returns null when the model has thinking off.
    /// </summary>
    private static string? ResolveThinkingLevel(JsonElement provider)
    {
        if (!JsonHelpers.GetBool(provider, "thinkingEnabled", false) ||
            !provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var selected = JsonHelpers.GetString(provider, "reasoningEffort") ??
            JsonHelpers.GetString(thinkingConfig, "defaultReasoningEffort");
        // "ultra" is a pseudo-tier mapped to the model's top real level before matching.
        selected = JsonHelpers.ResolveEffectiveReasoningEffort(selected, thinkingConfig);
        return selected switch
        {
            "minimal" or "none" => "minimal",
            "low" => "low",
            "medium" => "medium",
            "high" or "xhigh" or "max" => "high",
            _ => "medium"
        };
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

    private static void WriteSanitizedSchema(Utf8JsonWriter writer, JsonElement schema)
    {
        if (schema.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            var wroteType = false;
            var wroteProperties = false;
            foreach (var property in schema.EnumerateObject())
            {
                if (IsUnsupportedSchemaKeyword(property.Name))
                {
                    continue;
                }
                if (property.NameEquals("type"))
                {
                    wroteType = true;
                }
                if (property.NameEquals("properties"))
                {
                    wroteProperties = true;
                }
                writer.WritePropertyName(property.Name);
                WriteSanitizedSchemaValue(writer, property.Value);
            }
            if (!wroteType)
            {
                writer.WriteString("type", "object");
            }
            if (!wroteProperties)
            {
                writer.WriteStartObject("properties");
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "object");
        writer.WriteStartObject("properties");
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteSanitizedSchemaValue(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject())
                {
                    if (IsUnsupportedSchemaKeyword(property.Name))
                    {
                        continue;
                    }
                    writer.WritePropertyName(property.Name);
                    WriteSanitizedSchemaValue(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray())
                {
                    WriteSanitizedSchemaValue(writer, item);
                }
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }

    private static bool IsUnsupportedSchemaKeyword(string name)
    {
        return name is
            "additionalProperties" or
            "const" or
            "oneOf" or
            "anyOf" or
            "allOf" or
            "$schema" or
            "$defs" or
            "definitions" or
            "patternProperties" or
            "unevaluatedProperties";
    }

    private static string BuildApiUrl(string? baseUrl)
    {
        var root = (baseUrl ?? "https://generativelanguage.googleapis.com/v1beta")
            .Trim()
            .TrimEnd('/');

        // Tolerate base URLs saved for the OpenAI-compatible or generateContent surfaces.
        if (root.EndsWith("/openai", StringComparison.OrdinalIgnoreCase))
        {
            root = root[..^"/openai".Length];
        }
        if (root.EndsWith("/interactions", StringComparison.OrdinalIgnoreCase))
        {
            return root;
        }

        return $"{root}/interactions";
    }

    private static void ApplyHeaders(HttpRequestMessage request, JsonElement provider)
    {
        var apiKey = JsonHelpers.GetString(provider, "apiKey") ?? string.Empty;
        request.Headers.TryAddWithoutValidation("x-goog-api-key", apiKey);
        ApiUserAgent.Apply(request, provider);
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
            var value = (property.Value.GetString() ?? string.Empty)
                .Replace("{{sessionId}}", sessionId, StringComparison.Ordinal)
                .Replace("{{ sessionId }}", sessionId, StringComparison.Ordinal)
                .Replace("{{model}}", model, StringComparison.Ordinal)
                .Replace("{{ model }}", model, StringComparison.Ordinal)
                .Trim();
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
            ["x-goog-api-key"] = "***"
        };
        ApiUserAgent.ApplyDebug(headers, provider);
        return headers;
    }

    private static AgentRuntimeTokenUsage ReadUsage(JsonElement usage)
    {
        var inputTokens = JsonHelpers.GetInt(usage, "total_input_tokens", 0);
        var outputTokens = JsonHelpers.GetInt(usage, "total_output_tokens", 0);
        if (outputTokens == 0)
        {
            outputTokens = Math.Max(0, JsonHelpers.GetInt(usage, "total_tokens", 0) - inputTokens);
        }
        var cachedTokens = JsonHelpers.GetIntNullable(usage, "total_cached_tokens");
        return new AgentRuntimeTokenUsage(
            inputTokens,
            outputTokens,
            CacheReadTokens: cachedTokens,
            ReasoningTokens: JsonHelpers.GetIntNullable(usage, "total_thought_tokens"),
            ContextTokens: inputTokens);
    }

    private static string? MapStatusToStopReason(string? status)
    {
        return status switch
        {
            "completed" => "stop",
            "requires_action" => "tool_use",
            "failed" => "error",
            "cancelled" => "aborted",
            _ => null
        };
    }

    private static string ReadStreamErrorMessage(JsonElement root)
    {
        if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            var message = JsonHelpers.GetString(error, "message");
            var code = JsonHelpers.GetString(error, "code");
            if (!string.IsNullOrWhiteSpace(message))
            {
                return string.IsNullOrWhiteSpace(code) ? message : $"{message} ({code})";
            }
        }
        return root.GetRawText();
    }

    private static bool IsThoughtStep(InteractionsParseState parseState, int? index)
    {
        return index is { } stepIndex &&
            parseState.StepTypesByIndex.TryGetValue(stepIndex, out var stepType) &&
            stepType == "thought";
    }

    private static bool TryParseJsonObject(string value, out JsonElement element)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            element = default;
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(value);
            element = document.RootElement.Clone();
            return element.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            element = default;
            return false;
        }
    }

    private static bool LooksLikeJson(string line)
    {
        var trimmed = line.TrimStart();
        return trimmed.StartsWith('{') || trimmed.StartsWith('[');
    }

    private static int EstimateTokens(string text)
    {
        return Math.Max(1, text.Length / 4);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenMs, long totalMs)
    {
        if (outputTokens <= 0 || firstTokenMs is null || totalMs <= firstTokenMs.Value)
        {
            return null;
        }
        var seconds = (totalMs - firstTokenMs.Value) / 1000.0;
        return seconds <= 0 ? null : Math.Round(outputTokens / seconds, 2);
    }

    private sealed class PendingToolCall(string? id, string? name)
    {
        public string? Id { get; } = id;
        public string? Name { get; } = name;
        public StringBuilder Arguments { get; } = new();
    }

    private sealed class InteractionsParseState
    {
        public StringBuilder AssistantText { get; } = new();
        public List<AgentRuntimeNativeToolCall> ToolCalls { get; } = [];
        public HashSet<string> EmittedToolSignatures { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedEncryptedReasoning { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedImages { get; } = new(StringComparer.Ordinal);
        public Dictionary<int, string> StepTypesByIndex { get; } = [];
        public Dictionary<int, PendingToolCall> PendingToolCalls { get; } = [];
        public long? FirstTokenMs { get; set; }
        public int EstimatedOutputTokens { get; set; }
        public AgentRuntimeTokenUsage? Usage { get; set; }
        public string StopReason { get; set; } = "stop";
        public string? InteractionId { get; set; }
    }
}
