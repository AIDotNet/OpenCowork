using System.Buffers;
using System.Security.Cryptography;
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
        var sanitizedConversation = SanitizeConversationForReplay(conversation);
        var requestConversation = sanitizedConversation.Messages;
        var promptCacheState = AgentRuntimeOpenAIPromptCache.CreateState(
            provider,
            enabledByDefault: true);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = AgentRuntimeProviderSupport.GetOmittedBodyKeys(provider);
            AgentRuntimeOpenAIPromptCache.SuppressWireCacheMarkers(omitted);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            if (sanitizedConversation.Changed)
            {
                WorkerLog.Debug(
                    "responses replay sanitized " +
                    $"messages={conversation.Count}->{requestConversation.Count} " +
                    $"toolUses={CountToolUses(conversation)}->{CountToolUses(requestConversation)} " +
                    $"toolResults={CountToolResults(conversation)}->{CountToolResults(requestConversation)}");
            }
            var previousResponse = allowPreviousResponseId && !sanitizedConversation.Changed
                ? FindPreviousResponseAnchor(requestConversation)
                : null;
            var inputStartIndex = 0;
            var includeSystemPrompt = true;
            if (previousResponse is not null && !omitted.Contains("previous_response_id"))
            {
                writer.WriteString("previous_response_id", previousResponse.Value.ResponseId);
                inputStartIndex = previousResponse.Value.NextMessageIndex;
                includeSystemPrompt = false;
            }
            else if (allowPreviousResponseId && sanitizedConversation.Changed)
            {
                WorkerLog.Debug("responses previous_response_id suppressed due to sanitized replay");
            }
            if (!omitted.Contains("input"))
            {
                writer.WritePropertyName("input");
                WriteResponsesInput(
                    writer,
                    provider,
                    requestConversation,
                    inputStartIndex,
                    includeSystemPrompt,
                    promptCacheState);
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

            // Built-in web search: request the sources list so we can surface where the
            // model looked. OpenAI only returns web_search_call.action.sources when it is
            // explicitly asked for via `include`.
            var includeWebSearchSources =
                JsonHelpers.GetBool(provider, "builtinSearchEnabled", false) &&
                !omitted.Contains("include");
            var wroteInclude = WriteResponsesThinkingConfig(
                writer, provider, omitted, includeWebSearchSources);
            if (includeWebSearchSources && !wroteInclude)
            {
                writer.WritePropertyName("include");
                writer.WriteStartArray();
                WriteWebSearchIncludeValues(writer);
                writer.WriteEndArray();
            }
            if (!omitted.Contains("prompt_cache_key"))
            {
                WritePromptCacheKey(writer, provider);
                omitted.Add("prompt_cache_key");
            }
            AgentRuntimeOpenAIPromptCache.WriteRequestControls(
                writer,
                provider,
                omitted,
                promptCacheState);
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
        bool includeSystemPrompt,
        AgentRuntimeOpenAIPromptCacheState promptCacheState)
    {
        writer.WriteStartArray();
        if (includeSystemPrompt &&
            JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
        {
            writer.WriteStartObject();
            writer.WriteString("type", "message");
            writer.WriteString("role", "developer");
            writer.WritePropertyName("content");
            if (promptCacheState.TryUseExplicitBreakpoint())
            {
                writer.WriteStartArray();
                WriteResponsesInputTextPart(writer, systemPrompt, includePromptCacheBreakpoint: true);
                writer.WriteEndArray();
            }
            else
            {
                writer.WriteStringValue(systemPrompt);
            }
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
                WriteResponsesContentBlocks(
                    writer,
                    provider,
                    conversation,
                    index,
                    message,
                    blocks,
                    promptCacheState);
                continue;
            }

            foreach (var toolResult in message.ToolResults)
            {
                WriteResponsesToolResult(writer, toolResult);
            }

            if (!string.IsNullOrWhiteSpace(message.Text))
            {
                var role = message.Role == "assistant" ? "assistant" : "user";
                WriteResponsesTextMessage(
                    writer,
                    role,
                    message.Text,
                    role == "user" &&
                    message.Role == "user" &&
                    index < conversation.Count - 1 &&
                    promptCacheState.TryUseExplicitBreakpoint());
            }

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
        IReadOnlyList<JsonElement> blocks,
        AgentRuntimeOpenAIPromptCacheState promptCacheState)
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

            WriteResponsesUserPartsMessage(
                writer,
                blocks,
                message.Role == "user" && messageIndex < conversation.Count - 1,
                promptCacheState);
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

    private static void WriteResponsesUserPartsMessage(
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
                case "image":
                    if (CanWriteResponsesUserPart(block))
                    {
                        parts.Add(block);
                    }
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
        var breakpointPartIndex = allowPromptCacheBreakpoint ? parts.Count - 1 : -1;
        for (var index = 0; index < parts.Count; index++)
        {
            var part = parts[index];
            var includeBreakpoint =
                index == breakpointPartIndex &&
                promptCacheState.TryUseExplicitBreakpoint();
            if (JsonHelpers.GetString(part, "type") == "text")
            {
                WriteResponsesInputTextPart(
                    writer,
                    JsonHelpers.GetString(part, "text") ?? string.Empty,
                    includeBreakpoint);
                continue;
            }
            WriteResponsesImagePart(writer, part, includeBreakpoint);
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private static bool CanWriteResponsesUserPart(JsonElement block)
    {
        return JsonHelpers.GetString(block, "type") == "text" ||
            (JsonHelpers.GetString(block, "type") == "image" &&
                block.TryGetProperty("source", out var source) &&
                source.ValueKind == JsonValueKind.Object);
    }

    private static void WriteResponsesInputTextPart(
        Utf8JsonWriter writer,
        string text,
        bool includePromptCacheBreakpoint)
    {
        writer.WriteStartObject();
        writer.WriteString("type", "input_text");
        writer.WriteString("text", text);
        if (includePromptCacheBreakpoint)
        {
            AgentRuntimeOpenAIPromptCache.WriteExplicitBreakpoint(writer);
        }
        writer.WriteEndObject();
    }

    private static void WriteResponsesImagePart(
        Utf8JsonWriter writer,
        JsonElement block,
        bool includePromptCacheBreakpoint)
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
            if (includePromptCacheBreakpoint)
            {
                AgentRuntimeOpenAIPromptCache.WriteExplicitBreakpoint(writer);
            }
            writer.WriteEndObject();
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "input_image");
        writer.WriteString("image_url", imageUrl);
        if (includePromptCacheBreakpoint)
        {
            AgentRuntimeOpenAIPromptCache.WriteExplicitBreakpoint(writer);
        }
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

    private static void WriteResponsesTextMessage(
        Utf8JsonWriter writer,
        string role,
        string? text,
        bool includePromptCacheBreakpoint = false)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }
        writer.WriteStartObject();
        writer.WriteString("type", "message");
        writer.WriteString("role", role);
        writer.WritePropertyName("content");
        if (includePromptCacheBreakpoint && role == "user")
        {
            writer.WriteStartArray();
            WriteResponsesInputTextPart(writer, text, includePromptCacheBreakpoint: true);
            writer.WriteEndArray();
        }
        else
        {
            writer.WriteStringValue(text);
        }
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
        if (encryptedProvider is { Length: > 0 } && encryptedProvider != "openai-responses")
        {
            // A signature minted by a different provider is not a handle this endpoint
            // can resolve, so it must not be replayed as one.
            encrypted = null;
        }
        // `encrypted_content` only comes back from endpoints that honour
        // include=reasoning.encrypted_content. The rest identify reasoning by the item id
        // instead, which is the form the Responses schema asks for on input; without
        // either handle there is nothing the endpoint could match, so the block is
        // dropped rather than sent as an unanchored reasoning item.
        var reasoningItemId = JsonHelpers.GetString(block, "reasoningItemId");
        if (string.IsNullOrWhiteSpace(encrypted) && string.IsNullOrWhiteSpace(reasoningItemId))
        {
            WorkerLog.Debug("responses reasoning replay skipped: block carries no id or encrypted_content");
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "reasoning");
        if (reasoningItemId is { Length: > 0 })
        {
            writer.WriteString("id", reasoningItemId);
        }
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
        if (encrypted is { Length: > 0 })
        {
            writer.WriteString("encrypted_content", encrypted);
        }
        writer.WriteEndObject();
    }

    // Returns true when an `include` array was written (so the caller does not emit a
    // second one for the web-search sources).
    private static bool WriteResponsesThinkingConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted,
        bool includeWebSearchSources)
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
                return WriteResponsesReasoningConfig(
                    writer, provider, thinkingConfig, omitted, includeWebSearchSources);
            }
            return false;
        }

        if (!omitted.Contains("reasoning") &&
            JsonHelpers.GetString(provider, "responseSummary") is { Length: > 0 } summary)
        {
            writer.WritePropertyName("reasoning");
            writer.WriteStartObject();
            writer.WriteString("summary", summary);
            writer.WriteEndObject();
        }
        return false;
    }

    // Returns true when an `include` array was written.
    private static bool WriteResponsesReasoningConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        JsonElement thinkingConfig,
        HashSet<string> omitted,
        bool includeWebSearchSources)
    {
        if (omitted.Contains("reasoning"))
        {
            return false;
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
            return false;
        }

        if (JsonHelpers.GetString(provider, "reasoningEffort") is { Length: > 0 } reasoningEffort &&
            JsonHelpers.ResolveEffectiveReasoningEffort(reasoningEffort, thinkingConfig)
                is { Length: > 0 } effectiveEffort)
        {
            // "ultra" is a pseudo-tier mapped to the model's top real level; every other
            // value passes through unchanged. See JsonHelpers.ResolveEffectiveReasoningEffort.
            writer.WriteString("effort", effectiveEffort);
        }
        if (JsonHelpers.GetString(provider, "responseSummary") is { Length: > 0 } summary)
        {
            writer.WriteString("summary", summary);
        }
        writer.WriteEndObject();

        if (omitted.Contains("include"))
        {
            return false;
        }
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
                    includeItem != "reasoning.encrypted_content" &&
                    !IsWebSearchIncludeValue(includeItem))
                {
                    writer.WriteStringValue(includeItem);
                }
            }
        }
        writer.WriteStringValue("reasoning.encrypted_content");
        if (includeWebSearchSources)
        {
            WriteWebSearchIncludeValues(writer);
        }
        writer.WriteEndArray();
        return true;
    }

    // The `include` values that surface the built-in web search's sources and raw
    // results. Both must be requested explicitly or the web_search_call item comes
    // back without them.
    private static void WriteWebSearchIncludeValues(Utf8JsonWriter writer)
    {
        writer.WriteStringValue("web_search_call.action.sources");
        writer.WriteStringValue("web_search_call.results");
    }

    private static bool IsWebSearchIncludeValue(string value)
    {
        return value is "web_search_call.action.sources" or "web_search_call.results";
    }

    private static void WritePromptCacheKey(Utf8JsonWriter writer, JsonElement provider)
    {
        if (ResolvePromptCacheKey(provider) is { Length: > 0 } value)
        {
            writer.WriteString("prompt_cache_key", value);
        }
    }

    private static string? ResolvePromptCacheKey(JsonElement provider)
    {
        if (provider.TryGetProperty("requestOverrides", out var overrides) &&
            overrides.ValueKind == JsonValueKind.Object &&
            overrides.TryGetProperty("body", out var body) &&
            body.ValueKind == JsonValueKind.Object &&
            body.TryGetProperty("prompt_cache_key", out var promptCacheKey) &&
            promptCacheKey.ValueKind == JsonValueKind.String &&
            promptCacheKey.GetString() is { } overrideValue &&
            !string.IsNullOrWhiteSpace(overrideValue))
        {
            return AgentRuntimeOpenAIPromptCache.ClampPromptCacheKey(overrideValue);
        }

        var configured = JsonHelpers.GetString(provider, "promptCacheKey");
        var value = !string.IsNullOrWhiteSpace(configured)
            ? configured
            : NativeGlobalPromptCacheKey.Value;
        return AgentRuntimeOpenAIPromptCache.ClampPromptCacheKey(value);
    }

    private static string? ResolvePromptCacheKeyHash(JsonElement provider)
    {
        if (!AgentRuntimeOpenAIPromptCache.WireCacheMarkersEnabled)
        {
            return null;
        }

        var value = ResolvePromptCacheKey(provider);
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(hash).ToLowerInvariant()[..16];
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
                if (!HasCompleteToolReplayTail(conversation, index))
                {
                    WorkerLog.Debug(
                        $"responses previous_response_id skipped incomplete tool replay " +
                        $"responseId={responseId} messageIndex={index}");
                    continue;
                }
                return new ResponsesPreviousResponseAnchor(responseId, index + 1);
            }
        }
        return null;
    }

    private static bool HasCompleteToolReplayTail(
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        int assistantIndex)
    {
        if ((uint)assistantIndex >= (uint)conversation.Count)
        {
            return false;
        }

        var toolUseIds = new HashSet<string>(StringComparer.Ordinal);
        AddFunctionToolUseIds(conversation[assistantIndex], toolUseIds);

        if (toolUseIds.Count == 0)
        {
            return true;
        }

        var pairedToolUseIds = new HashSet<string>(StringComparer.Ordinal);
        for (var index = assistantIndex + 1; index < conversation.Count; index++)
        {
            var message = conversation[index];
            if (!string.Equals(message.Role, "user", StringComparison.Ordinal))
            {
                break;
            }

            if (!HasToolResultIds(message))
            {
                break;
            }

            foreach (var toolResultId in EnumerateToolResultIds(message))
            {
                if (toolUseIds.Contains(toolResultId))
                {
                    pairedToolUseIds.Add(toolResultId);
                }
            }

            if (pairedToolUseIds.Count == toolUseIds.Count)
            {
                return true;
            }
        }

        return false;
    }

    private static ResponsesConversationSanitization SanitizeConversationForReplay(
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        if (conversation.Count == 0)
        {
            return new ResponsesConversationSanitization(conversation, false);
        }

        var validToolUseIds = new HashSet<string>(StringComparer.Ordinal);
        var pairedToolUseIdsByAssistantIndex = new Dictionary<int, HashSet<string>>();

        for (var index = 0; index < conversation.Count; index++)
        {
            var message = conversation[index];
            if (!string.Equals(message.Role, "assistant", StringComparison.Ordinal))
            {
                continue;
            }

            var toolUseIds = new HashSet<string>(StringComparer.Ordinal);
            AddFunctionToolUseIds(message, toolUseIds);
            if (toolUseIds.Count == 0)
            {
                continue;
            }

            var pairedToolUseIds = new HashSet<string>(StringComparer.Ordinal);
            for (var candidateIndex = index + 1; candidateIndex < conversation.Count; candidateIndex++)
            {
                var candidateMessage = conversation[candidateIndex];
                if (!string.Equals(candidateMessage.Role, "user", StringComparison.Ordinal))
                {
                    break;
                }

                if (!HasToolResultIds(candidateMessage))
                {
                    break;
                }

                foreach (var toolResultId in EnumerateToolResultIds(candidateMessage))
                {
                    if (toolUseIds.Contains(toolResultId))
                    {
                        pairedToolUseIds.Add(toolResultId);
                        validToolUseIds.Add(toolResultId);
                    }
                }
            }

            pairedToolUseIdsByAssistantIndex[index] = pairedToolUseIds;
        }

        var changed = false;
        var sanitizedMessages = new List<AgentRuntimeChatMessage>(conversation.Count);
        for (var index = 0; index < conversation.Count; index++)
        {
            var message = conversation[index];
            pairedToolUseIdsByAssistantIndex.TryGetValue(index, out var pairedToolUseIds);

            var filteredToolUses = message.ToolUses;
            if (message.ToolUses.Count > 0 && pairedToolUseIds is not null)
            {
                filteredToolUses = message.ToolUses
                    .Where(toolUse => !string.IsNullOrWhiteSpace(toolUse.Id) && pairedToolUseIds.Contains(toolUse.Id))
                    .ToList();
                if (filteredToolUses.Count != message.ToolUses.Count)
                {
                    changed = true;
                }
            }

            var filteredToolResults = message.ToolResults;
            if (message.ToolResults.Count > 0)
            {
                filteredToolResults = message.ToolResults
                    .Where(toolResult =>
                        !string.IsNullOrWhiteSpace(toolResult.ToolUseId) &&
                        validToolUseIds.Contains(toolResult.ToolUseId))
                    .ToList();
                if (filteredToolResults.Count != message.ToolResults.Count)
                {
                    changed = true;
                }
            }

            List<JsonElement>? filteredBlocks = null;
            if (message.ContentBlocks is { Count: > 0 } contentBlocks)
            {
                filteredBlocks = new List<JsonElement>(contentBlocks.Count);
                foreach (var block in contentBlocks)
                {
                    switch (JsonHelpers.GetString(block, "type"))
                    {
                        case "tool_use":
                            var toolUseId = JsonHelpers.GetString(block, "id");
                            if (pairedToolUseIds is not null &&
                                !string.IsNullOrWhiteSpace(toolUseId) &&
                                pairedToolUseIds.Contains(toolUseId))
                            {
                                filteredBlocks.Add(block);
                            }
                            else if (pairedToolUseIds is null)
                            {
                                filteredBlocks.Add(block);
                            }
                            else
                            {
                                changed = true;
                            }
                            break;
                        case "tool_result":
                            var toolResultId = JsonHelpers.GetString(block, "toolUseId");
                            if (!string.IsNullOrWhiteSpace(toolResultId) && validToolUseIds.Contains(toolResultId))
                            {
                                filteredBlocks.Add(block);
                            }
                            else
                            {
                                changed = true;
                            }
                            break;
                        default:
                            filteredBlocks.Add(block);
                            break;
                    }
                }
            }

            var effectiveBlocks = filteredBlocks ?? message.ContentBlocks;
            if (!HasMeaningfulReplayContent(message, filteredToolUses, filteredToolResults, effectiveBlocks))
            {
                changed = true;
                continue;
            }

            if (ReferenceEquals(filteredToolUses, message.ToolUses) &&
                ReferenceEquals(filteredToolResults, message.ToolResults) &&
                ReferenceEquals(effectiveBlocks, message.ContentBlocks))
            {
                sanitizedMessages.Add(message);
                continue;
            }

            sanitizedMessages.Add(new AgentRuntimeChatMessage(
                message.Role,
                message.Text,
                filteredToolUses,
                filteredToolResults,
                message.ProviderResponseId,
                effectiveBlocks));
        }

        return changed
            ? new ResponsesConversationSanitization(sanitizedMessages, true)
            : new ResponsesConversationSanitization(conversation, false);
    }

    private static bool HasMeaningfulReplayContent(
        AgentRuntimeChatMessage message,
        List<AgentRuntimeChatToolUse> toolUses,
        List<AgentRuntimeToolResult> toolResults,
        List<JsonElement>? contentBlocks)
    {
        if (contentBlocks is { Count: > 0 })
        {
            foreach (var block in contentBlocks)
            {
                switch (JsonHelpers.GetString(block, "type"))
                {
                    case "text":
                        if (!string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "text")))
                        {
                            return true;
                        }
                        break;
                    case "thinking":
                        if (!string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "thinking")) ||
                            !string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "encryptedContent")) ||
                            !string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "reasoningItemId")))
                        {
                            return true;
                        }
                        break;
                    case "image":
                    case "tool_use":
                    case "tool_result":
                        return true;
                }
            }
        }

        return !string.IsNullOrWhiteSpace(message.Text) || toolUses.Count > 0 || toolResults.Count > 0;
    }

    private static void AddFunctionToolUseIds(
        AgentRuntimeChatMessage message,
        HashSet<string> toolUseIds)
    {
        foreach (var toolUse in message.ToolUses)
        {
            if (!string.IsNullOrWhiteSpace(toolUse.Id) &&
                !IsOpenAIResponsesComputerUseToolUse(toolUse.ExtraContent))
            {
                toolUseIds.Add(toolUse.Id);
            }
        }

        if (message.ContentBlocks is null)
        {
            return;
        }

        foreach (var block in message.ContentBlocks)
        {
            if (JsonHelpers.GetString(block, "type") != "tool_use" ||
                ReadToolUse(block) is not { } toolUse ||
                IsOpenAIResponsesComputerUseToolUse(toolUse.ExtraContent))
            {
                continue;
            }

            toolUseIds.Add(toolUse.Id);
        }
    }

    private static IEnumerable<string> EnumerateToolResultIds(AgentRuntimeChatMessage message)
    {
        foreach (var toolResult in message.ToolResults)
        {
            if (!string.IsNullOrWhiteSpace(toolResult.ToolUseId))
            {
                yield return toolResult.ToolUseId;
            }
        }

        if (message.ContentBlocks is null)
        {
            yield break;
        }

        foreach (var block in message.ContentBlocks)
        {
            if (JsonHelpers.GetString(block, "type") == "tool_result" &&
                JsonHelpers.GetString(block, "toolUseId") is { Length: > 0 } toolUseId)
            {
                yield return toolUseId;
            }
        }
    }

    private static bool HasToolResultIds(AgentRuntimeChatMessage message)
    {
        return EnumerateToolResultIds(message).Any();
    }

    private static int CountToolUses(IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var count = 0;
        foreach (var message in conversation)
        {
            count += message.ToolUses.Count;
        }
        return count;
    }

    private static int CountToolResults(IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var count = 0;
        foreach (var message in conversation)
        {
            count += message.ToolResults.Count;
        }
        return count;
    }

    private static void WriteResponsesTools(Utf8JsonWriter writer, JsonElement parameters, JsonElement provider)
    {
        var hasTools = TryGetTools(parameters, out var tools);
        var hasComputerTool = JsonHelpers.GetBool(provider, "computerUseEnabled", false);
        var hasImageGenerationTool = ShouldEnableResponsesImageGeneration(provider);
        var hasBuiltinSearchTool = JsonHelpers.GetBool(provider, "builtinSearchEnabled", false);
        if (!hasTools && !hasComputerTool && !hasImageGenerationTool && !hasBuiltinSearchTool) return;
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
        // OpenAI Responses runs the `web_search` tool server-side and streams a
        // web_search_call output item followed by the model's grounded answer, so no
        // client execution is required.
        if (hasBuiltinSearchTool)
        {
            WorkerLog.Debug("responses request injecting built-in web_search tool");
            writer.WriteStartObject();
            writer.WriteString("type", "web_search");
            writer.WriteEndObject();
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

    private readonly record struct ResponsesConversationSanitization(
        IReadOnlyList<AgentRuntimeChatMessage> Messages,
        bool Changed);

    private static void WriteToolSchema(Utf8JsonWriter writer, JsonElement tool)
    {
        if (tool.TryGetProperty("inputSchema", out var schema))
        {
            AgentRuntimeProviderSupport.WriteProviderCompatibleToolSchema(writer, schema);
            return;
        }
        writer.WriteStartObject();
        writer.WriteString("type", "object");
        writer.WriteStartObject("properties");
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

}
