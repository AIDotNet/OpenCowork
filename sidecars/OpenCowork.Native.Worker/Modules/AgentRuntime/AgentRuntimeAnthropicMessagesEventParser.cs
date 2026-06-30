using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private static async Task ProcessJsonEventAsync(
        string? eventName,
        string data,
        AnthropicParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        using var document = JsonDocument.Parse(data);
        var root = document.RootElement;
        var type = string.IsNullOrWhiteSpace(eventName)
            ? JsonHelpers.GetString(root, "type")
            : eventName;
        if (string.IsNullOrWhiteSpace(type))
        {
            return;
        }

        if (root.TryGetProperty("message", out var message) &&
            message.TryGetProperty("usage", out var messageUsage))
        {
            parseState.Usage = MergeUsage(parseState.Usage, messageUsage);
        }
        if (root.TryGetProperty("usage", out var usage))
        {
            parseState.Usage = MergeUsage(parseState.Usage, usage);
        }

        switch (type)
        {
            case "content_block_start":
                ProcessContentBlockStart(root, parseState, state, context);
                break;

            case "content_block_delta":
                await ProcessContentBlockDeltaAsync(root, parseState, state, context, startedAt);
                break;

            case "content_block_stop":
                ProcessContentBlockStop(root, parseState);
                break;

            case "message_delta":
                if (root.TryGetProperty("delta", out var delta))
                {
                    parseState.StopReason = JsonHelpers.GetString(delta, "stop_reason") ?? parseState.StopReason;
                }
                break;

            case "message_stop":
                parseState.StopReason = JsonHelpers.GetString(root, "stop_reason") ?? parseState.StopReason;
                break;

            case "error":
                throw new InvalidOperationException($"Anthropic Messages stream error: {root.GetRawText()}");
        }
    }

    private static void ProcessContentBlockStart(
        JsonElement root,
        AnthropicParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var index = JsonHelpers.GetInt(root, "index", -1);
        if (index < 0 ||
            !root.TryGetProperty("content_block", out var block) ||
            block.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var blockType = JsonHelpers.GetString(block, "type");
        if (blockType == "tool_use")
        {
            var id = JsonHelpers.GetString(block, "id") ?? $"toolu_{index}";
            var name = JsonHelpers.GetString(block, "name") ?? string.Empty;
            parseState.ToolBuffers[index] = new AnthropicToolBuffer(id, name);
            _ = AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_streaming_start",
                    ToolCallId: id,
                    ToolName: name));
            return;
        }

        if (blockType == "thinking")
        {
            TryEmitThinkingEncrypted(block, parseState, state, context);
        }
    }

    private static async Task ProcessContentBlockDeltaAsync(
        JsonElement root,
        AnthropicParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        var index = JsonHelpers.GetInt(root, "index", -1);
        if (!root.TryGetProperty("delta", out var delta) ||
            delta.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        MarkFirstToken(parseState, startedAt);
        var deltaType = JsonHelpers.GetString(delta, "type");
        if (deltaType == "text_delta")
        {
            var text = JsonHelpers.GetString(delta, "text") ?? string.Empty;
            if (text.Length == 0)
            {
                return;
            }
            parseState.AssistantText.Append(text);
            parseState.EstimatedOutputTokens += EstimateTokenCount(text);
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent("text_delta", Text: text));
            return;
        }

        if (deltaType == "thinking_delta")
        {
            var thinking = JsonHelpers.GetString(delta, "thinking") ?? string.Empty;
            if (thinking.Length > 0)
            {
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("thinking_delta", Thinking: thinking));
            }
            return;
        }

        if (deltaType == "signature_delta")
        {
            TryEmitThinkingEncrypted(delta, parseState, state, context);
            return;
        }

        if (deltaType == "input_json_delta" && index >= 0)
        {
            if (!parseState.ToolBuffers.TryGetValue(index, out var buffer))
            {
                buffer = new AnthropicToolBuffer($"toolu_{index}", string.Empty);
                parseState.ToolBuffers[index] = buffer;
            }
            if (JsonHelpers.GetString(delta, "partial_json") is { } partialJson)
            {
                buffer.Arguments.Append(partialJson);
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
                        ToolCallId: buffer.Id,
                        PartialInput: partialInput));
            }
        }
    }

    private static void ProcessContentBlockStop(JsonElement root, AnthropicParseState parseState)
    {
        var index = JsonHelpers.GetInt(root, "index", -1);
        if (index < 0 || !parseState.ToolBuffers.TryGetValue(index, out var buffer))
        {
            return;
        }
        var input = TryParseJsonObject(buffer.Arguments.ToString(), out var parsed)
            ? parsed
            : CreateEmptyObjectElement();
        parseState.ToolCalls.Add(new AgentRuntimeNativeToolCall(buffer.Id, buffer.Name, input));
        parseState.ToolBuffers.Remove(index);
    }

    private static void FlushPendingToolCalls(AnthropicParseState parseState)
    {
        foreach (var item in parseState.ToolBuffers.ToArray())
        {
            var buffer = item.Value;
            var input = TryParseJsonObject(buffer.Arguments.ToString(), out var parsed)
                ? parsed
                : CreateEmptyObjectElement();
            parseState.ToolCalls.Add(new AgentRuntimeNativeToolCall(buffer.Id, buffer.Name, input));
            parseState.ToolBuffers.Remove(item.Key);
        }
    }


    private static void TryEmitThinkingEncrypted(
        JsonElement element,
        AnthropicParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var encrypted = JsonHelpers.GetString(element, "signature") ??
            JsonHelpers.GetString(element, "encrypted_content");
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
                Provider: "anthropic"));
    }

}
