using System.Buffers;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static string BuildRequestBody(
        JsonElement parameters,
        JsonElement provider,
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        bool allowPreviousResponseId)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = AgentRuntimeProviderSupport.GetOmittedBodyKeys(provider);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            var previousResponse = allowPreviousResponseId
                ? FindPreviousResponseAnchor(conversation)
                : null;
            var inputStartIndex = 0;
            var includeSystemPrompt = true;
            if (previousResponse is not null && !omitted.Contains("previous_response_id"))
            {
                writer.WriteString("previous_response_id", previousResponse.Value.ResponseId);
                inputStartIndex = previousResponse.Value.NextMessageIndex;
                includeSystemPrompt = false;
            }
            if (!omitted.Contains("input"))
            {
                writer.WritePropertyName("input");
                WriteResponsesInput(writer, provider, conversation, inputStartIndex, includeSystemPrompt);
            }
            if (!omitted.Contains("stream"))
            {
                writer.WriteBoolean("stream", true);
            }
            if (!omitted.Contains("tools"))
            {
                WriteResponsesTools(writer, parameters, provider);
            }

            if (!omitted.Contains("temperature") &&
                JsonHelpers.GetDoubleNullable(provider, "temperature") is { } temperature)
            {
                writer.WriteNumber("temperature", temperature);
            }
            if (!omitted.Contains("max_output_tokens") &&
                JsonHelpers.GetIntNullable(provider, "maxTokens") is { } maxTokens && maxTokens > 0)
            {
                writer.WriteNumber("max_output_tokens", maxTokens);
            }
            if (!omitted.Contains("service_tier") &&
                JsonHelpers.GetString(provider, "serviceTier") is { Length: > 0 } serviceTier)
            {
                writer.WriteString("service_tier", serviceTier);
            }

            WriteResponsesThinkingConfig(writer, provider, omitted);
            if (!omitted.Contains("prompt_cache_key"))
            {
                WritePromptCacheKey(writer, provider);
            }
            AgentRuntimeProviderSupport.WriteBodyOverrides(writer, provider, omitted);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteResponsesInput(
        Utf8JsonWriter writer,
        JsonElement provider,
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        int startIndex,
        bool includeSystemPrompt)
    {
        writer.WriteStartArray();
        if (includeSystemPrompt &&
            JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
        {
            writer.WriteStartObject();
            writer.WriteString("type", "message");
            writer.WriteString("role", "developer");
            writer.WriteString("content", systemPrompt);
            writer.WriteEndObject();
        }

        for (var index = Math.Max(0, startIndex); index < conversation.Count; index++)
        {
            var message = conversation[index];
            if (message.Role == "system")
            {
                continue;
            }

            if (message.ContentBlocks is { Count: > 0 } blocks)
            {
                WriteResponsesContentBlocks(writer, provider, conversation, index, message, blocks);
                continue;
            }

            foreach (var toolResult in message.ToolResults)
            {
                WriteResponsesToolResult(writer, toolResult);
            }

            WriteResponsesTextMessage(writer, message.Role == "assistant" ? "assistant" : "user", message.Text);

            foreach (var toolUse in message.ToolUses)
            {
                if (!IsOpenAIResponsesComputerUseToolUse(toolUse.ExtraContent))
                {
                    WriteResponsesToolUse(writer, toolUse);
                }
            }
        }
        writer.WriteEndArray();
    }

    private static void WriteResponsesContentBlocks(
        Utf8JsonWriter writer,
        JsonElement provider,
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        int messageIndex,
        AgentRuntimeChatMessage message,
        IReadOnlyList<JsonElement> blocks)
    {
        if (message.Role == "user" || message.Role == "tool")
        {
            foreach (var block in blocks)
            {
                if (JsonHelpers.GetString(block, "type") == "tool_result" &&
                    !IsOpenAIResponsesComputerUseToolResult(conversation, messageIndex, block) &&
                    JsonHelpers.GetString(block, "toolUseId") is { Length: > 0 } toolUseId)
                {
                    var content = block.TryGetProperty("content", out var contentElement)
                        ? contentElement
                        : default;
                    WriteResponsesToolResult(
                        writer,
                        new AgentRuntimeToolResult(
                            toolUseId,
                            content.ValueKind == JsonValueKind.Undefined
                                ? AgentRuntimeProviderSupport.CreateStringElement(string.Empty)
                                : content.Clone(),
                            JsonHelpers.GetBool(block, "isError", false) ? true : null));
                }
            }

            WriteResponsesUserPartsMessage(writer, blocks);
            return;
        }

        foreach (var block in blocks)
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                    WriteResponsesTextMessage(writer, "assistant", JsonHelpers.GetString(block, "text") ?? string.Empty);
                    break;
                case "thinking":
                    WriteResponsesThinkingReplay(writer, provider, block);
                    break;
                case "tool_use":
                    if (ReadToolUse(block) is { } toolUse &&
                        !IsOpenAIResponsesComputerUseToolUse(toolUse.ExtraContent))
                    {
                        WriteResponsesToolUse(writer, toolUse);
                    }
                    break;
            }
        }
    }

    private static void WriteResponsesUserPartsMessage(Utf8JsonWriter writer, IReadOnlyList<JsonElement> blocks)
    {
        var parts = new List<JsonElement>();
        foreach (var block in blocks)
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                case "image":
                    parts.Add(block);
                    break;
            }
        }
        if (parts.Count == 0)
        {
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "message");
        writer.WriteString("role", "user");
        writer.WritePropertyName("content");
        writer.WriteStartArray();
        foreach (var part in parts)
        {
            if (JsonHelpers.GetString(part, "type") == "text")
            {
                writer.WriteStartObject();
                writer.WriteString("type", "input_text");
                writer.WriteString("text", JsonHelpers.GetString(part, "text") ?? string.Empty);
                writer.WriteEndObject();
                continue;
            }
            WriteResponsesImagePart(writer, part);
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private static void WriteResponsesImagePart(Utf8JsonWriter writer, JsonElement block)
    {
        if (!block.TryGetProperty("source", out var source) ||
            source.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var imageUrl = BuildResponsesImageUrl(source);
        if (string.IsNullOrWhiteSpace(imageUrl))
        {
            imageUrl = JsonHelpers.GetString(source, "filePath") is { Length: > 0 } filePath
                ? $"[image] {filePath}"
                : "[image]";
            writer.WriteStartObject();
            writer.WriteString("type", "input_text");
            writer.WriteString("text", imageUrl);
            writer.WriteEndObject();
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "input_image");
        writer.WriteString("image_url", imageUrl);
        writer.WriteEndObject();
    }

    private static string BuildResponsesImageUrl(JsonElement source)
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

    private static void WriteResponsesTextMessage(Utf8JsonWriter writer, string role, string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }
        writer.WriteStartObject();
        writer.WriteString("type", "message");
        writer.WriteString("role", role);
        writer.WriteString("content", text);
        writer.WriteEndObject();
    }

    private static void WriteResponsesToolResult(Utf8JsonWriter writer, AgentRuntimeToolResult toolResult)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "function_call_output");
        writer.WriteString("call_id", toolResult.ToolUseId);
        writer.WriteString("output", AgentRuntimeProviderSupport.ToolResultToString(toolResult.Content));
        writer.WriteEndObject();
    }

    private static void WriteResponsesToolUse(Utf8JsonWriter writer, AgentRuntimeChatToolUse toolUse)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "function_call");
        writer.WriteString("call_id", toolUse.Id);
        writer.WriteString("name", toolUse.Name);
        writer.WriteString("arguments", toolUse.Input.GetRawText());
        writer.WriteString("status", "completed");
        writer.WriteEndObject();
    }

    private static void WriteResponsesThinkingReplay(
        Utf8JsonWriter writer,
        JsonElement provider,
        JsonElement block)
    {
        if (!JsonHelpers.GetBool(provider, "thinkingEnabled", false))
        {
            return;
        }
        var encrypted = JsonHelpers.GetString(block, "encryptedContent");
        var encryptedProvider = JsonHelpers.GetString(block, "encryptedContentProvider");
        if (string.IsNullOrWhiteSpace(encrypted) ||
            (encryptedProvider is { Length: > 0 } && encryptedProvider != "openai-responses"))
        {
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "reasoning");
        writer.WritePropertyName("summary");
        writer.WriteStartArray();
        if (JsonHelpers.GetString(block, "thinking") is { Length: > 0 } thinking)
        {
            writer.WriteStartObject();
            writer.WriteString("type", "summary_text");
            writer.WriteString("text", thinking);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        writer.WriteString("encrypted_content", encrypted);
        writer.WriteEndObject();
    }

    private static void WriteResponsesThinkingConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
    {
        if (provider.TryGetProperty("thinkingConfig", out var thinkingConfig) &&
            thinkingConfig.ValueKind == JsonValueKind.Object)
        {
            var thinkingEnabled = JsonHelpers.GetBool(provider, "thinkingEnabled", false);
            var propertyName = thinkingEnabled ? "bodyParams" : "disabledBodyParams";
            if (thinkingConfig.TryGetProperty(propertyName, out var bodyParams) &&
                bodyParams.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in bodyParams.EnumerateObject())
                {
                    if (!omitted.Contains(property.Name) &&
                        property.Name is not ("reasoning" or "include"))
                    {
                        property.WriteTo(writer);
                    }
                }
            }

            if (thinkingEnabled)
            {
                WriteResponsesReasoningConfig(writer, provider, thinkingConfig, omitted);
            }
            return;
        }

        if (!omitted.Contains("reasoning") &&
            JsonHelpers.GetString(provider, "responseSummary") is { Length: > 0 } summary)
        {
            writer.WritePropertyName("reasoning");
            writer.WriteStartObject();
            writer.WriteString("summary", summary);
            writer.WriteEndObject();
        }
    }

    private static void WriteResponsesReasoningConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        JsonElement thinkingConfig,
        HashSet<string> omitted)
    {
        if (omitted.Contains("reasoning"))
        {
            return;
        }

        var hasReasoning = false;
        if (thinkingConfig.TryGetProperty("bodyParams", out var bodyParams) &&
            bodyParams.ValueKind == JsonValueKind.Object &&
            bodyParams.TryGetProperty("reasoning", out var existingReasoning) &&
            existingReasoning.ValueKind == JsonValueKind.Object)
        {
            hasReasoning = true;
            writer.WritePropertyName("reasoning");
            writer.WriteStartObject();
            foreach (var property in existingReasoning.EnumerateObject())
            {
                property.WriteTo(writer);
            }
        }
        else if (JsonHelpers.GetString(provider, "responseSummary") is { Length: > 0 } ||
            JsonHelpers.GetString(provider, "reasoningEffort") is { Length: > 0 })
        {
            hasReasoning = true;
            writer.WritePropertyName("reasoning");
            writer.WriteStartObject();
        }

        if (!hasReasoning)
        {
            return;
        }

        if (JsonHelpers.GetString(provider, "reasoningEffort") is { Length: > 0 } reasoningEffort)
        {
            writer.WriteString("effort", reasoningEffort);
        }
        if (JsonHelpers.GetString(provider, "responseSummary") is { Length: > 0 } summary)
        {
            writer.WriteString("summary", summary);
        }
        writer.WriteEndObject();

        if (!omitted.Contains("include"))
        {
            writer.WritePropertyName("include");
            writer.WriteStartArray();
            if (thinkingConfig.TryGetProperty("bodyParams", out var includeBodyParams) &&
                includeBodyParams.ValueKind == JsonValueKind.Object &&
                includeBodyParams.TryGetProperty("include", out var include) &&
                include.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in include.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String &&
                        item.GetString() is { Length: > 0 } includeItem &&
                        includeItem != "reasoning.encrypted_content")
                    {
                        writer.WriteStringValue(includeItem);
                    }
                }
            }
            writer.WriteStringValue("reasoning.encrypted_content");
            writer.WriteEndArray();
        }
    }

    private static void WritePromptCacheKey(Utf8JsonWriter writer, JsonElement provider)
    {
        if (provider.TryGetProperty("requestOverrides", out var overrides) &&
            overrides.ValueKind == JsonValueKind.Object &&
            overrides.TryGetProperty("body", out var body) &&
            body.ValueKind == JsonValueKind.Object &&
            body.TryGetProperty("prompt_cache_key", out var promptCacheKey) &&
            promptCacheKey.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(promptCacheKey.GetString()))
        {
            return;
        }

        var configured = JsonHelpers.GetString(provider, "promptCacheKey");
        var sessionId = JsonHelpers.GetString(provider, "sessionId");
        var value = !string.IsNullOrWhiteSpace(configured)
            ? configured
            : !string.IsNullOrWhiteSpace(sessionId)
                ? $"opencowork-{sessionId}"
                : NativeGlobalPromptCacheKey.Value;
        writer.WriteString("prompt_cache_key", value);
    }

    private static AgentRuntimeChatToolUse? ReadToolUse(JsonElement block)
    {
        if (JsonHelpers.GetString(block, "id") is not { Length: > 0 } id ||
            JsonHelpers.GetString(block, "name") is not { Length: > 0 } name)
        {
            return null;
        }
        var input = block.TryGetProperty("input", out var inputElement)
            ? inputElement.Clone()
            : AgentRuntimeProviderSupport.CreateEmptyObjectElement();
        var extraContent = block.TryGetProperty("extraContent", out var extraElement) &&
            extraElement.ValueKind == JsonValueKind.Object
                ? extraElement.Clone()
                : (JsonElement?)null;
        return new AgentRuntimeChatToolUse(id, name, input, extraContent);
    }

    private static bool IsOpenAIResponsesComputerUseToolUse(JsonElement? extraContent)
    {
        return extraContent.HasValue &&
            extraContent.Value.ValueKind == JsonValueKind.Object &&
            extraContent.Value.TryGetProperty("openaiResponses", out var openaiResponses) &&
            openaiResponses.ValueKind == JsonValueKind.Object &&
            openaiResponses.TryGetProperty("computerUse", out var computerUse) &&
            computerUse.ValueKind == JsonValueKind.Object &&
            JsonHelpers.GetString(computerUse, "kind") == "computer_use";
    }

    private static bool IsOpenAIResponsesComputerUseToolResult(
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        int messageIndex,
        JsonElement block)
    {
        var toolUseId = JsonHelpers.GetString(block, "toolUseId");
        if (string.IsNullOrWhiteSpace(toolUseId) || messageIndex <= 0)
        {
            return false;
        }

        var previous = conversation[messageIndex - 1];
        if (previous.ContentBlocks is null)
        {
            return previous.ToolUses.Any(toolUse =>
                toolUse.Id == toolUseId &&
                IsOpenAIResponsesComputerUseToolUse(toolUse.ExtraContent));
        }

        foreach (var previousBlock in previous.ContentBlocks)
        {
            if (JsonHelpers.GetString(previousBlock, "type") != "tool_use" ||
                JsonHelpers.GetString(previousBlock, "id") != toolUseId ||
                !previousBlock.TryGetProperty("extraContent", out var extraContent))
            {
                continue;
            }
            if (IsOpenAIResponsesComputerUseToolUse(extraContent))
            {
                return true;
            }
        }
        return false;
    }


    private static ResponsesPreviousResponseAnchor? FindPreviousResponseAnchor(
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        for (var index = conversation.Count - 1; index >= 0; index--)
        {
            var responseId = conversation[index].ProviderResponseId;
            if (!string.IsNullOrWhiteSpace(responseId) && index + 1 < conversation.Count)
            {
                return new ResponsesPreviousResponseAnchor(responseId, index + 1);
            }
        }
        return null;
    }

    private static void WriteResponsesTools(Utf8JsonWriter writer, JsonElement parameters, JsonElement provider)
    {
        var hasTools = TryGetTools(parameters, out var tools);
        var hasComputerTool = JsonHelpers.GetBool(provider, "computerUseEnabled", false);
        var hasImageGenerationTool = ShouldEnableResponsesImageGeneration(provider);
        if (!hasTools && !hasComputerTool && !hasImageGenerationTool) return;
        writer.WritePropertyName("tools");
        writer.WriteStartArray();
        if (hasComputerTool)
        {
            writer.WriteStartObject();
            writer.WriteString("type", "computer");
            writer.WriteEndObject();
        }
        if (hasImageGenerationTool)
        {
            WriteResponsesImageGenerationTool(writer, provider);
        }
        if (hasTools)
        {
            foreach (var tool in tools.EnumerateArray())
            {
                var name = JsonHelpers.GetString(tool, "name");
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                writer.WriteStartObject();
                writer.WriteString("type", "function");
                writer.WriteString("name", name);
                writer.WriteString("description", JsonHelpers.GetString(tool, "description") ?? string.Empty);
                writer.WritePropertyName("parameters");
                WriteToolSchema(writer, tool);
                writer.WriteBoolean("strict", false);
                writer.WriteEndObject();
            }
        }
        writer.WriteEndArray();
    }

    private static bool TryGetTools(JsonElement parameters, out JsonElement tools)
    {
        if (parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("tools", out tools) &&
            tools.ValueKind == JsonValueKind.Array &&
            tools.GetArrayLength() > 0)
        {
            return true;
        }
        tools = default;
        return false;
    }

    private static void WriteToolSchema(Utf8JsonWriter writer, JsonElement tool)
    {
        if (tool.TryGetProperty("inputSchema", out var schema))
        {
            schema.WriteTo(writer);
            return;
        }
        writer.WriteStartObject();
        writer.WriteString("type", "object");
        writer.WriteStartObject("properties");
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

}
