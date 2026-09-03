using System.Text;
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
            FlushOpenAnthropicText(parseState);
            FlushOpenAnthropicThinking(parseState);
            var id = JsonHelpers.GetString(block, "id") ?? $"toolu_{index}";
            var name = JsonHelpers.GetString(block, "name") ?? string.Empty;
            parseState.ToolBuffers[index] = new AnthropicToolBuffer(id, name);
            _ = AgentRuntimeTools.EmitProjectedAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_streaming_start",
                    ToolCallId: id,
                    ToolName: name));
            return;
        }

        if (blockType == "redacted_thinking")
        {
            FlushOpenAnthropicText(parseState);
            FlushOpenAnthropicThinking(parseState);
            var data = JsonHelpers.GetString(block, "data") ??
                JsonHelpers.GetString(block, "signature") ??
                JsonHelpers.GetString(block, "encrypted_content");
            parseState.ContentBlocks.Add(CreateAnthropicThinkingBlock(string.Empty, data, redacted: true));
            TryEmitThinkingEncrypted(block, parseState, state, context);
            return;
        }

        if (blockType == "thinking")
        {
            FlushOpenAnthropicText(parseState);
            FlushOpenAnthropicThinking(parseState);
            parseState.OpenThinking = new StringBuilder();
            if (JsonHelpers.GetString(block, "thinking") is { Length: > 0 } initialThinking)
            {
                parseState.OpenThinking.Append(initialThinking);
            }
            parseState.OpenThinkingEncrypted = JsonHelpers.GetString(block, "signature") ??
                JsonHelpers.GetString(block, "encrypted_content");
            parseState.OpenThinkingRedacted = false;
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
            FlushOpenAnthropicThinking(parseState);
            parseState.OpenText ??= new StringBuilder();
            parseState.OpenText.Append(text);
            parseState.AssistantText.Append(text);
            parseState.EstimatedOutputTokens += EstimateTokenCount(text);
            await AgentRuntimeTools.EmitProjectedAsync(
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
                FlushOpenAnthropicText(parseState);
                parseState.OpenThinking ??= new StringBuilder();
                parseState.OpenThinking.Append(thinking);
                parseState.OpenThinkingRedacted = false;
                parseState.ReasoningStreamed = true;
                parseState.EstimatedOutputTokens += EstimateTokenCount(thinking);
                await AgentRuntimeTools.EmitProjectedAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent("thinking_delta", Thinking: thinking));
            }
            return;
        }

        if (deltaType == "signature_delta")
        {
            if (JsonHelpers.GetString(delta, "signature") is { Length: > 0 } signature)
            {
                parseState.OpenThinkingEncrypted = signature;
            }
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
                parseState.EstimatedOutputTokens += EstimateTokenCount(partialJson);
                buffer.Arguments.Append(partialJson);
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
                        ToolCallId: buffer.Id,
                        PartialInput: partialInput));
            }
        }
    }

    private static void ProcessContentBlockStop(JsonElement root, AnthropicParseState parseState)
    {
        FlushOpenAnthropicThinking(parseState);
        FlushOpenAnthropicText(parseState);
        var index = JsonHelpers.GetInt(root, "index", -1);
        if (index < 0 || !parseState.ToolBuffers.TryGetValue(index, out var buffer))
        {
            return;
        }
        CompleteAnthropicToolBuffer(parseState, buffer);
        parseState.ToolBuffers.Remove(index);
    }

    private static void FlushPendingToolCalls(AnthropicParseState parseState)
    {
        FlushOpenAnthropicThinking(parseState);
        FlushOpenAnthropicText(parseState);
        foreach (var item in parseState.ToolBuffers.ToArray())
        {
            CompleteAnthropicToolBuffer(parseState, item.Value);
            parseState.ToolBuffers.Remove(item.Key);
        }
    }

    private static void CompleteAnthropicToolBuffer(
        AnthropicParseState parseState,
        AnthropicToolBuffer buffer)
    {
        var rawArguments = buffer.Arguments.ToString();
        var parsedSuccessfully = TryParseJsonObject(rawArguments, out var parsed);
        var input = parsedSuccessfully
            ? parsed
            : CreateEmptyObjectElement();
        parseState.ToolCalls.Add(new AgentRuntimeNativeToolCall(
            buffer.Id,
            buffer.Name,
            input,
            RawArguments: rawArguments,
            ParseError: parsedSuccessfully ? null : "Expected a valid JSON object."));
        parseState.ContentBlocks.Add(CreateAnthropicToolUseBlock(buffer.Id, buffer.Name, input));
    }

    private static void FlushOpenAnthropicThinking(AnthropicParseState parseState)
    {
        if (parseState.OpenThinking is null &&
            string.IsNullOrWhiteSpace(parseState.OpenThinkingEncrypted))
        {
            parseState.OpenThinkingRedacted = false;
            return;
        }

        var thinking = parseState.OpenThinking?.ToString() ?? string.Empty;
        var encrypted = parseState.OpenThinkingEncrypted;
        var redacted = parseState.OpenThinkingRedacted ||
            (string.IsNullOrWhiteSpace(thinking) && !string.IsNullOrWhiteSpace(encrypted));
        if (!string.IsNullOrWhiteSpace(thinking) || !string.IsNullOrWhiteSpace(encrypted))
        {
            parseState.ContentBlocks.Add(CreateAnthropicThinkingBlock(thinking, encrypted, redacted));
        }
        parseState.OpenThinking = null;
        parseState.OpenThinkingEncrypted = null;
        parseState.OpenThinkingRedacted = false;
    }

    private static void FlushOpenAnthropicText(AnthropicParseState parseState)
    {
        if (parseState.OpenText is null || parseState.OpenText.Length == 0)
        {
            parseState.OpenText = null;
            return;
        }

        var text = parseState.OpenText.ToString();
        parseState.ContentBlocks.Add(AgentRuntimeProviderSupport.CreateObjectElement(writer =>
        {
            writer.WriteString("type", "text");
            writer.WriteString("text", text);
        }));
        parseState.OpenText = null;
    }

    private static JsonElement CreateAnthropicThinkingBlock(
        string thinking,
        string? encrypted,
        bool redacted)
    {
        return AgentRuntimeProviderSupport.CreateObjectElement(writer =>
        {
            writer.WriteString("type", redacted ? "redacted_thinking" : "thinking");
            if (!redacted)
            {
                writer.WriteString("thinking", thinking);
            }
            if (!string.IsNullOrWhiteSpace(encrypted))
            {
                writer.WriteString("encryptedContent", encrypted);
                writer.WriteString("encryptedContentProvider", "anthropic");
            }
            if (redacted)
            {
                writer.WriteBoolean("redacted", true);
            }
        });
    }

    private static JsonElement CreateAnthropicToolUseBlock(string id, string name, JsonElement input)
    {
        return AgentRuntimeProviderSupport.CreateObjectElement(writer =>
        {
            writer.WriteString("type", "tool_use");
            writer.WriteString("id", id);
            writer.WriteString("name", name);
            writer.WritePropertyName("input");
            input.WriteTo(writer);
        });
    }

    private static void TryEmitThinkingEncrypted(
        JsonElement element,
        AnthropicParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var encrypted = JsonHelpers.GetString(element, "signature") ??
            JsonHelpers.GetString(element, "encrypted_content") ??
            JsonHelpers.GetString(element, "data");
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
                Provider: "anthropic"));
    }

}
