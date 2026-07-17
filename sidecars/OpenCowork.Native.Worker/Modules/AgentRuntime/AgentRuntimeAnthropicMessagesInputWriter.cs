using System.Buffers;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    // Claude Opus 4.6+/4.7/4.8, Sonnet 5, and Fable 5 reject assistant message prefill:
    // the Messages API requires the conversation to end with a user turn, otherwise it
    // returns HTTP 400 ("This model does not support assistant message prefill. The
    // conversation must end with a user message."). OpenCowork never intentionally
    // prefills, so a trailing assistant message is always an artifact of resuming or
    // continuing a persisted conversation. Append this minimal user turn to keep such
    // requests valid instead of failing the whole run.
    private const string AnthropicTrailingUserContinuationText = "Continue.";

    private static string BuildRequestBody(
        JsonElement parameters,
        JsonElement provider,
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        out AnthropicConversationValidationStats validationStats)
    {
        var sanitizedConversation = SanitizeAnthropicConversation(conversation, out validationStats);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            writer.WriteNumber("max_tokens", ResolveAnthropicMaxTokens(provider));
            var promptCacheEnabled = JsonHelpers.GetBool(provider, "enablePromptCache", true);
            var systemPromptCacheEnabled = JsonHelpers.GetBool(provider, "enableSystemPromptCache", true);
            var cacheBudget = new AnthropicCacheControlBudget(
                promptCacheEnabled || systemPromptCacheEnabled,
                JsonHelpers.GetString(provider, "cacheTtl") == "1h" ? "1h" : "5m");
            if (JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
            {
                writer.WritePropertyName("system");
                writer.WriteStartArray();
                writer.WriteStartObject();
                writer.WriteString("type", "text");
                writer.WriteString("text", systemPrompt);
                if (systemPromptCacheEnabled && !string.IsNullOrWhiteSpace(systemPrompt))
                {
                    WriteAnthropicCacheControl(writer, cacheBudget);
                }
                writer.WriteEndObject();
                writer.WriteEndArray();
            }
            writer.WritePropertyName("messages");
            WriteMessages(writer, sanitizedConversation, promptCacheEnabled, cacheBudget, validationStats);
            WriteTools(writer, parameters, provider, promptCacheEnabled, cacheBudget);
            writer.WriteBoolean("stream", true);
            var wroteThinkingTemperature = WriteAnthropicThinkingConfig(writer, provider);
            if (!wroteThinkingTemperature &&
                JsonHelpers.GetDoubleNullable(provider, "temperature") is { } temperature)
            {
                writer.WriteNumber("temperature", temperature);
            }
            WriteAnthropicEffort(writer, provider);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteMessages(
        Utf8JsonWriter writer,
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        bool promptCacheEnabled,
        AnthropicCacheControlBudget cacheBudget,
        AnthropicConversationValidationStats validationStats)
    {
        var cacheTargets = promptCacheEnabled
            ? CollectAnthropicMessageCacheTargets(conversation, cacheBudget.Remaining)
            : new HashSet<string>(StringComparer.Ordinal);
        var writeState = new AnthropicMessageWriteState(validationStats);
        writer.WriteStartArray();
        string? lastWrittenRole = null;
        for (var messageIndex = 0; messageIndex < conversation.Count; messageIndex++)
        {
            var message = conversation[messageIndex];
            if (message.Role == "system")
            {
                continue;
            }

            var role = message.Role == "assistant" ? "assistant" : "user";
            writeState.BeginMessage(role);
            if (!TryWriteAnthropicMessageContent(
                    message,
                    role,
                    messageIndex,
                    cacheTargets,
                    cacheBudget,
                    writeState,
                    out var contentBytes))
            {
                validationStats.WriterDroppedEmptyMessages++;
                continue;
            }

            writer.WriteStartObject();
            writer.WriteString("role", role);
            writer.WritePropertyName("content");
            writer.WriteRawValue(contentBytes, skipInputValidation: true);
            writer.WriteEndObject();
            validationStats.WrittenMessages++;
            writeState.EndMessage(role);
            lastWrittenRole = role;
        }

        // The Messages API requires the conversation to end with a user turn; a trailing
        // assistant message triggers a 400 on models that don't support prefill. Append a
        // continuation user turn when nothing user-role was written last (also covers the
        // degenerate case where every message was dropped, which the API also rejects).
        if (lastWrittenRole != "user")
        {
            WriteAnthropicTrailingUserMessage(writer);
            validationStats.WrittenMessages++;
        }
        writer.WriteEndArray();
    }

    private static void WriteAnthropicTrailingUserMessage(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("role", "user");
        writer.WritePropertyName("content");
        writer.WriteStartArray();
        writer.WriteStartObject();
        writer.WriteString("type", "text");
        writer.WriteString("text", AnthropicTrailingUserContinuationText);
        writer.WriteEndObject();
        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private static bool TryWriteAnthropicMessageContent(
        AgentRuntimeChatMessage message,
        string role,
        int messageIndex,
        HashSet<string> cacheTargets,
        AnthropicCacheControlBudget cacheBudget,
        AnthropicMessageWriteState writeState,
        out byte[] contentBytes)
    {
        var buffer = new ArrayBufferWriter<byte>();
        var wroteBlock = false;
        using (var contentWriter = new Utf8JsonWriter(buffer, WriterOptions))
        {
            contentWriter.WriteStartArray();
            if (message.ContentBlocks is { Count: > 0 } blocks)
            {
                wroteBlock = WriteAnthropicContentBlocks(
                    contentWriter,
                    blocks,
                    role,
                    messageIndex,
                    cacheTargets,
                    cacheBudget,
                    writeState);
            }
            else if (!string.IsNullOrWhiteSpace(message.Text) &&
                cacheTargets.Contains($"message:{messageIndex}"))
            {
                contentWriter.WriteStartObject();
                contentWriter.WriteString("type", "text");
                contentWriter.WriteString("text", message.Text);
                WriteAnthropicCacheControl(contentWriter, cacheBudget);
                contentWriter.WriteEndObject();
                wroteBlock = true;
            }
            else
            {
                wroteBlock = WriteAnthropicLegacyContent(
                    contentWriter,
                    message,
                    role,
                    cacheBudget,
                    writeState);
            }
            contentWriter.WriteEndArray();
        }

        contentBytes = wroteBlock ? buffer.WrittenMemory.ToArray() : [];
        return wroteBlock;
    }

    private static bool WriteAnthropicLegacyContent(
        Utf8JsonWriter writer,
        AgentRuntimeChatMessage message,
        string role,
        AnthropicCacheControlBudget cacheBudget,
        AnthropicMessageWriteState writeState)
    {
        var wroteBlock = false;
        if (role == "user")
        {
            foreach (var toolResult in message.ToolResults)
            {
                if (TryWriteAnthropicToolResult(writer, toolResult, false, cacheBudget, writeState))
                {
                    wroteBlock = true;
                }
            }
        }

        if (!string.IsNullOrWhiteSpace(message.Text))
        {
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString("text", message.Text);
            writer.WriteEndObject();
            wroteBlock = true;
        }

        if (role == "assistant")
        {
            foreach (var toolUse in message.ToolUses)
            {
                if (TryWriteAnthropicToolUse(writer, toolUse, writeState))
                {
                    wroteBlock = true;
                }
            }
        }
        else if (message.ToolUses.Count > 0)
        {
            writeState.DropInvalidRoleToolBlocks(message.ToolUses.Count);
        }

        return wroteBlock;
    }

    private static bool WriteAnthropicContentBlocks(
        Utf8JsonWriter writer,
        IReadOnlyList<JsonElement> blocks,
        string role,
        int messageIndex,
        HashSet<string> cacheTargets,
        AnthropicCacheControlBudget cacheBudget,
        AnthropicMessageWriteState writeState)
    {
        var wroteBlock = false;
        if (role == "user")
        {
            for (var blockIndex = 0; blockIndex < blocks.Count; blockIndex++)
            {
                var block = blocks[blockIndex];
                if (JsonHelpers.GetString(block, "type") != "tool_result")
                {
                    continue;
                }

                var shouldCache = cacheTargets.Contains($"block:{messageIndex}:{blockIndex}");
                if (TryWriteAnthropicToolResultBlock(
                        writer,
                        block,
                        shouldCache,
                        cacheBudget,
                        writeState))
                {
                    wroteBlock = true;
                }
            }

            for (var blockIndex = 0; blockIndex < blocks.Count; blockIndex++)
            {
                var block = blocks[blockIndex];
                var blockType = JsonHelpers.GetString(block, "type");
                if (blockType == "tool_result")
                {
                    continue;
                }
                if (blockType == "tool_use")
                {
                    writeState.DropInvalidRoleToolBlocks(1);
                    continue;
                }

                var shouldCache = cacheTargets.Contains($"block:{messageIndex}:{blockIndex}");
                if (TryWriteAnthropicNonToolBlock(writer, block, shouldCache, cacheBudget, role))
                {
                    wroteBlock = true;
                }
            }

            return wroteBlock;
        }

        for (var blockIndex = 0; blockIndex < blocks.Count; blockIndex++)
        {
            var block = blocks[blockIndex];
            var shouldCache = cacheTargets.Contains($"block:{messageIndex}:{blockIndex}");
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                case "thinking":
                case "image":
                    wroteBlock = TryWriteAnthropicNonToolBlock(writer, block, shouldCache, cacheBudget, role) ||
                        wroteBlock;
                    break;
                case "tool_result":
                    writeState.DropInvalidRoleToolBlocks(1);
                    break;
            }
        }

        for (var blockIndex = 0; blockIndex < blocks.Count; blockIndex++)
        {
            var block = blocks[blockIndex];
            if (JsonHelpers.GetString(block, "type") != "tool_use")
            {
                continue;
            }
            if (ReadAnthropicToolUse(block) is { } toolUse)
            {
                wroteBlock = TryWriteAnthropicToolUse(writer, toolUse, writeState) || wroteBlock;
            }
        }
        return wroteBlock;
    }

    private static bool TryWriteAnthropicNonToolBlock(
        Utf8JsonWriter writer,
        JsonElement block,
        bool shouldCache,
        AnthropicCacheControlBudget cacheBudget,
        string role)
    {
        switch (JsonHelpers.GetString(block, "type"))
        {
            case "thinking":
                if (role != "assistant")
                {
                    return false;
                }
                writer.WriteStartObject();
                writer.WriteString("type", "thinking");
                writer.WriteString("thinking", JsonHelpers.GetString(block, "thinking") ?? string.Empty);
                var encryptedProvider = JsonHelpers.GetString(block, "encryptedContentProvider");
                if (JsonHelpers.GetString(block, "encryptedContent") is { Length: > 0 } encrypted &&
                    (encryptedProvider is null or "anthropic"))
                {
                    writer.WriteString("signature", encrypted);
                }
                writer.WriteEndObject();
                return true;
            case "text":
                if (JsonHelpers.GetString(block, "text") is not { Length: > 0 } text)
                {
                    return false;
                }
                writer.WriteStartObject();
                writer.WriteString("type", "text");
                writer.WriteString("text", text);
                if (shouldCache)
                {
                    WriteAnthropicCacheControl(writer, cacheBudget);
                }
                writer.WriteEndObject();
                return true;
            case "image":
                return WriteAnthropicImageBlock(writer, block, shouldCache, cacheBudget);
            default:
                return false;
        }
    }

    private static bool TryWriteAnthropicToolUse(
        Utf8JsonWriter writer,
        AgentRuntimeChatToolUse toolUse,
        AnthropicMessageWriteState writeState)
    {
        if (!writeState.TryRecordToolUse(toolUse.Id))
        {
            return false;
        }

        WriteAnthropicToolUse(writer, toolUse);
        return true;
    }

    private static void WriteAnthropicToolUse(Utf8JsonWriter writer, AgentRuntimeChatToolUse toolUse)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "tool_use");
        writer.WriteString("id", toolUse.Id);
        writer.WriteString("name", toolUse.Name);
        writer.WritePropertyName("input");
        toolUse.Input.WriteTo(writer);
        writer.WriteEndObject();
    }

    private static AgentRuntimeChatToolUse? ReadAnthropicToolUse(JsonElement block)
    {
        if (JsonHelpers.GetString(block, "id") is not { Length: > 0 } id ||
            JsonHelpers.GetString(block, "name") is not { Length: > 0 } name)
        {
            return null;
        }
        var input = block.TryGetProperty("input", out var inputElement)
            ? inputElement.Clone()
            : AgentRuntimeProviderSupport.CreateEmptyObjectElement();
        return new AgentRuntimeChatToolUse(id, name, input);
    }

    private static bool TryWriteAnthropicToolResultBlock(
        Utf8JsonWriter writer,
        JsonElement block,
        bool shouldCache,
        AnthropicCacheControlBudget cacheBudget,
        AnthropicMessageWriteState writeState)
    {
        if (ReadAnthropicToolResultId(block) is not { Length: > 0 } toolUseId)
        {
            writeState.DropInvalidToolResult();
            return false;
        }

        var content = block.TryGetProperty("content", out var contentElement)
            ? contentElement.Clone()
            : AgentRuntimeProviderSupport.CreateStringElement(string.Empty);
        return TryWriteAnthropicToolResult(
            writer,
            new AgentRuntimeToolResult(
                toolUseId,
                content,
                JsonHelpers.GetBool(block, "isError", false) ? true : null),
            shouldCache,
            cacheBudget,
            writeState);
    }

    private static bool TryWriteAnthropicToolResult(
        Utf8JsonWriter writer,
        AgentRuntimeToolResult toolResult,
        bool shouldCache,
        AnthropicCacheControlBudget cacheBudget,
        AnthropicMessageWriteState writeState)
    {
        if (!writeState.TryRecordToolResult(toolResult.ToolUseId))
        {
            return false;
        }

        WriteAnthropicToolResult(writer, toolResult, shouldCache, cacheBudget);
        return true;
    }

    private static void WriteAnthropicToolResult(
        Utf8JsonWriter writer,
        AgentRuntimeToolResult toolResult,
        bool shouldCache,
        AnthropicCacheControlBudget cacheBudget)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "tool_result");
        writer.WriteString("tool_use_id", toolResult.ToolUseId);
        writer.WritePropertyName("content");
        WriteAnthropicToolResultContent(writer, toolResult.Content);
        if (toolResult.IsError == true)
        {
            writer.WriteBoolean("is_error", true);
        }
        if (shouldCache)
        {
            WriteAnthropicCacheControl(writer, cacheBudget);
        }
        writer.WriteEndObject();
    }

    private static void WriteAnthropicToolResultContent(Utf8JsonWriter writer, JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Array)
        {
            writer.WriteStringValue(ToolResultToString(content));
            return;
        }

        writer.WriteStartArray();
        foreach (var block in content.EnumerateArray())
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                    writer.WriteStartObject();
                    writer.WriteString("type", "text");
                    writer.WriteString("text", JsonHelpers.GetString(block, "text") ?? string.Empty);
                    writer.WriteEndObject();
                    break;
                case "image":
                    WriteAnthropicImageBlock(writer, block, false, null);
                    break;
            }
        }
        writer.WriteEndArray();
    }

    private static bool WriteAnthropicImageBlock(
        Utf8JsonWriter writer,
        JsonElement block,
        bool shouldCache,
        AnthropicCacheControlBudget? cacheBudget)
    {
        if (!block.TryGetProperty("source", out var source) ||
            source.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var data = JsonHelpers.GetString(source, "data");
        var url = JsonHelpers.GetString(source, "url");
        if (string.IsNullOrWhiteSpace(data) && string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "image");
        writer.WritePropertyName("source");
        writer.WriteStartObject();
        writer.WriteString("type", JsonHelpers.GetString(source, "type") ?? "base64");
        if (JsonHelpers.GetString(source, "mediaType") is { Length: > 0 } mediaType)
        {
            writer.WriteString("media_type", mediaType);
        }
        if (!string.IsNullOrWhiteSpace(data))
        {
            writer.WriteString("data", AgentRuntimeProviderSupport.StripDataUrlPrefix(data));
        }
        if (!string.IsNullOrWhiteSpace(url))
        {
            writer.WriteString("url", url);
        }
        writer.WriteEndObject();
        if (shouldCache && cacheBudget is not null)
        {
            WriteAnthropicCacheControl(writer, cacheBudget);
        }
        writer.WriteEndObject();
        return true;
    }

    private static void WriteTools(
        Utf8JsonWriter writer,
        JsonElement parameters,
        JsonElement provider,
        bool promptCacheEnabled,
        AnthropicCacheControlBudget cacheBudget)
    {
        JsonElement tools = default;
        var hasClientTools =
            parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("tools", out tools) &&
            tools.ValueKind == JsonValueKind.Array &&
            tools.GetArrayLength() > 0;
        var builtinSearchEnabled = JsonHelpers.GetBool(provider, "builtinSearchEnabled", false);
        if (!hasClientTools && !builtinSearchEnabled)
        {
            return;
        }

        writer.WritePropertyName("tools");
        writer.WriteStartArray();

        // Claude's server-side web search runs entirely on Anthropic's side: the model
        // emits server_tool_use/web_search_tool_result blocks and then continues with
        // text in the same turn, so the client never executes anything. Emitting it
        // first keeps the client tools' cache breakpoint (placed on the last tool)
        // exactly where it was before.
        if (builtinSearchEnabled)
        {
            writer.WriteStartObject();
            writer.WriteString("type", "web_search_20250305");
            writer.WriteString("name", "web_search");
            writer.WriteNumber("max_uses", 5);
            writer.WriteEndObject();
        }

        if (hasClientTools)
        {
            var toolIndex = 0;
            var toolCount = tools.GetArrayLength();
            foreach (var tool in tools.EnumerateArray())
            {
                var name = JsonHelpers.GetString(tool, "name");
                if (string.IsNullOrWhiteSpace(name))
                {
                    toolIndex++;
                    continue;
                }

                writer.WriteStartObject();
                writer.WriteString("name", name);
                writer.WriteString("description", JsonHelpers.GetString(tool, "description") ?? string.Empty);
                writer.WritePropertyName("input_schema");
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
                if (promptCacheEnabled && toolIndex == toolCount - 1)
                {
                    WriteAnthropicCacheControl(writer, cacheBudget);
                }
                writer.WriteEndObject();
                toolIndex++;
            }
        }

        writer.WriteEndArray();
        writer.WritePropertyName("tool_choice");
        writer.WriteStartObject();
        writer.WriteString("type", "auto");
        writer.WriteEndObject();
    }

    private static HashSet<string> CollectAnthropicMessageCacheTargets(
        IReadOnlyList<AgentRuntimeChatMessage> messages,
        int remaining)
    {
        var targets = new HashSet<string>(StringComparer.Ordinal);
        if (remaining <= 0)
        {
            return targets;
        }

        var cacheableIndexes = new List<int>();
        for (var index = 0; index < messages.Count; index++)
        {
            if (messages[index].Role == "system")
            {
                continue;
            }
            if (GetAnthropicMessageCacheTarget(messages[index], index) is not null)
            {
                cacheableIndexes.Add(index);
            }
        }
        if (cacheableIndexes.Count == 0)
        {
            return targets;
        }

        void AddTarget(int messageIndex)
        {
            if (remaining <= 0)
            {
                return;
            }
            var target = GetAnthropicMessageCacheTarget(messages[messageIndex], messageIndex);
            if (target is null || !targets.Add(target))
            {
                return;
            }
            remaining--;
        }

        var current = cacheableIndexes[^1];
        var reusable = cacheableIndexes.Count >= 2 ? cacheableIndexes[^2] : (int?)null;
        if (reusable.HasValue && remaining >= 2)
        {
            AddTarget(reusable.Value);
        }
        AddTarget(current);
        if (reusable.HasValue)
        {
            AddTarget(reusable.Value);
        }
        foreach (var index in cacheableIndexes)
        {
            if (remaining <= 0)
            {
                break;
            }
            AddTarget(index);
        }
        return targets;
    }

    private static string? GetAnthropicMessageCacheTarget(AgentRuntimeChatMessage message, int messageIndex)
    {
        if (message.ContentBlocks is not { Count: > 0 })
        {
            return string.IsNullOrWhiteSpace(message.Text) ? null : $"message:{messageIndex}";
        }

        for (var blockIndex = message.ContentBlocks.Count - 1; blockIndex >= 0; blockIndex--)
        {
            if (IsAnthropicCacheableBlock(message.ContentBlocks[blockIndex]))
            {
                return $"block:{messageIndex}:{blockIndex}";
            }
        }
        return null;
    }

    private static bool IsAnthropicCacheableBlock(JsonElement block)
    {
        return JsonHelpers.GetString(block, "type") switch
        {
            "text" => !string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "text")),
            "tool_result" or "image" => true,
            _ => false
        };
    }

    private static void WriteAnthropicCacheControl(
        Utf8JsonWriter writer,
        AnthropicCacheControlBudget cacheBudget)
    {
        if (!cacheBudget.TryUse(out var ttl))
        {
            return;
        }
        writer.WritePropertyName("cache_control");
        writer.WriteStartObject();
        writer.WriteString("type", "ephemeral");
        if (ttl == "1h")
        {
            writer.WriteString("ttl", "1h");
        }
        writer.WriteEndObject();
    }

    private static int ResolveAnthropicMaxTokens(JsonElement provider)
    {
        var configured = Math.Max(1, JsonHelpers.GetInt(provider, "maxTokens", 32000));
        var thinkingBudget = ReadAnthropicThinkingBudget(provider);
        return thinkingBudget.HasValue
            ? Math.Max(configured, thinkingBudget.Value + 1)
            : configured;
    }

    private static int? ReadAnthropicThinkingBudget(JsonElement provider)
    {
        if (!JsonHelpers.GetBool(provider, "thinkingEnabled", false) ||
            !provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object ||
            !thinkingConfig.TryGetProperty("bodyParams", out var bodyParams) ||
            bodyParams.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (bodyParams.TryGetProperty("thinking", out var thinking) &&
            thinking.ValueKind == JsonValueKind.Object &&
            JsonHelpers.GetIntNullable(thinking, "budget_tokens") is { } budget)
        {
            return budget;
        }
        return JsonHelpers.GetBool(bodyParams, "enable_thinking", false)
            ? MinAnthropicThinkingBudget
            : null;
    }

    private static bool WriteAnthropicThinkingConfig(Utf8JsonWriter writer, JsonElement provider)
    {
        if (!provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var thinkingEnabled = JsonHelpers.GetBool(provider, "thinkingEnabled", false);
        var propertyName = thinkingEnabled ? "bodyParams" : "disabledBodyParams";
        if (!thinkingConfig.TryGetProperty(propertyName, out var bodyParams) ||
            bodyParams.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var wroteTemperature = false;
        foreach (var property in bodyParams.EnumerateObject())
        {
            if (property.Name is "enable_thinking" or "thinking")
            {
                continue;
            }
            if (property.Name == "temperature")
            {
                wroteTemperature = true;
            }
            property.WriteTo(writer);
        }

        WriteNormalizedAnthropicThinking(writer, bodyParams);
        if (JsonHelpers.GetDoubleNullable(thinkingConfig, "forceTemperature") is { } forceTemperature)
        {
            writer.WriteNumber("temperature", forceTemperature);
            wroteTemperature = true;
        }
        return wroteTemperature;
    }

    private static void WriteNormalizedAnthropicThinking(Utf8JsonWriter writer, JsonElement bodyParams)
    {
        if (bodyParams.TryGetProperty("thinking", out var thinking) &&
            thinking.ValueKind == JsonValueKind.Object)
        {
            writer.WritePropertyName("thinking");
            writer.WriteStartObject();
            var wroteBudget = false;
            foreach (var property in thinking.EnumerateObject())
            {
                if (property.Name == "budget_tokens")
                {
                    wroteBudget = true;
                }
                property.WriteTo(writer);
            }
            if (!wroteBudget && JsonHelpers.GetString(thinking, "type") == "enabled")
            {
                writer.WriteNumber("budget_tokens", MinAnthropicThinkingBudget);
            }
            writer.WriteEndObject();
            return;
        }

        if (bodyParams.TryGetProperty("enable_thinking", out var enabled))
        {
            writer.WritePropertyName("thinking");
            writer.WriteStartObject();
            writer.WriteString("type", enabled.ValueKind == JsonValueKind.True ? "enabled" : "disabled");
            if (enabled.ValueKind == JsonValueKind.True)
            {
                writer.WriteNumber("budget_tokens", MinAnthropicThinkingBudget);
            }
            writer.WriteEndObject();
        }
    }

    private static void WriteAnthropicEffort(Utf8JsonWriter writer, JsonElement provider)
    {
        if (ResolveAnthropicEffort(provider) is not { Length: > 0 } effort)
        {
            return;
        }
        writer.WritePropertyName("output_config");
        writer.WriteStartObject();
        writer.WriteString("effort", effort);
        writer.WriteEndObject();
    }

    private static string? ResolveAnthropicEffort(JsonElement provider)
    {
        if (!provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object ||
            !thinkingConfig.TryGetProperty("reasoningEffortLevels", out var levels) ||
            levels.ValueKind != JsonValueKind.Array ||
            levels.GetArrayLength() == 0)
        {
            return null;
        }

        var selected = JsonHelpers.GetString(provider, "reasoningEffort") ??
            JsonHelpers.GetString(thinkingConfig, "defaultReasoningEffort");
        // "ultra" is a pseudo-tier mapped to the model's top real level before matching.
        selected = JsonHelpers.ResolveEffectiveReasoningEffort(selected, thinkingConfig);
        if (!string.IsNullOrWhiteSpace(selected) &&
            levels.EnumerateArray().Any(item => item.ValueKind == JsonValueKind.String && item.GetString() == selected))
        {
            return selected is "low" or "medium" or "high" or "xhigh" or "max" ? selected : null;
        }
        var first = levels.EnumerateArray().FirstOrDefault(item => item.ValueKind == JsonValueKind.String).GetString();
        return first is "low" or "medium" or "high" or "xhigh" or "max" ? first : null;
    }

}
