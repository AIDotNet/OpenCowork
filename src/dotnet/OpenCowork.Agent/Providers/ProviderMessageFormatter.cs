using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

internal static class ProviderMessageFormatter
{
    public static List<UnifiedMessage> NormalizeMessagesForToolReplay(List<UnifiedMessage> messages)
    {
        var normalized = new List<UnifiedMessage>(messages.Count);
        var validToolUseIds = new HashSet<string>(StringComparer.Ordinal);

        for (var index = 0; index < messages.Count; index++)
        {
            var message = messages[index];
            if (message.Role == "system")
            {
                normalized.Add(message);
                continue;
            }

            var blocks = message.GetBlockContent();
            if (blocks.Count == 0)
            {
                normalized.Add(message);
                continue;
            }

            var replayableToolUseIds = blocks
                .OfType<ToolUseBlock>()
                .Select(block => block.Id)
                .ToHashSet(StringComparer.Ordinal);
            var pairedToolUseIds = new HashSet<string>(StringComparer.Ordinal);

            if (replayableToolUseIds.Count > 0)
            {
                var nextMessage = index + 1 < messages.Count ? messages[index + 1] : null;
                var nextMessageBlocks = nextMessage?.GetBlockContent() ?? [];
                if (nextMessage?.Role == "user")
                {
                    foreach (var toolResult in nextMessageBlocks.OfType<ToolResultBlock>())
                    {
                        if (!replayableToolUseIds.Contains(toolResult.ToolUseId))
                            continue;

                        pairedToolUseIds.Add(toolResult.ToolUseId);
                        validToolUseIds.Add(toolResult.ToolUseId);
                    }
                }
            }

            var sanitizedBlocks = blocks.Where(block => block switch
            {
                ToolUseBlock toolUse => pairedToolUseIds.Contains(toolUse.Id),
                ToolResultBlock toolResult => validToolUseIds.Contains(toolResult.ToolUseId),
                _ => true
            }).ToList();

            if (sanitizedBlocks.Count == 0)
                continue;

            normalized.Add(new UnifiedMessage
            {
                Id = message.Id,
                Role = message.Role,
                Content = sanitizedBlocks,
                CreatedAt = message.CreatedAt,
                Usage = message.Usage,
                ProviderResponseId = message.ProviderResponseId,
                Source = message.Source,
                RawContent = message.RawContent
            });
        }

        return normalized;
    }

    public static JsonArray FormatAnthropicMessages(List<UnifiedMessage> messages, bool promptCacheEnabled = false)
    {
        var normalized = NormalizeMessagesForToolReplay(messages);
        var formatted = new JsonArray();

        foreach (var message in normalized)
        {
            if (message.Role == "system")
                continue;

            var blocks = message.GetBlockContent();
            if (blocks.Count == 0)
            {
                formatted.Add(new JsonObject
                {
                    ["role"] = message.Role,
                    ["content"] = message.GetTextContent()
                });
                continue;
            }

            var content = new JsonArray();
            foreach (var block in blocks)
            {
                if (TryFormatAnthropicBlock(block, out var node) && node is not null)
                    content.Add(node);
            }

            if (content.Count == 0)
                continue;

            formatted.Add(new JsonObject
            {
                ["role"] = message.Role == "tool" ? "user" : message.Role,
                ["content"] = content
            });
        }

        if (promptCacheEnabled)
            ApplyAnthropicMessageCacheBreakpoint(formatted);

        return formatted;
    }

    public static JsonArray FormatOpenAiChatMessages(List<UnifiedMessage> messages, string? systemPrompt, ProviderConfig? config)
    {
        var formatted = new JsonArray();
        var normalized = NormalizeMessagesForToolReplay(messages);
        var isGoogleCompatible = IsGoogleCompatible(config);

        if (!string.IsNullOrWhiteSpace(systemPrompt))
        {
            formatted.Add(new JsonObject
            {
                ["role"] = "system",
                ["content"] = systemPrompt
            });
        }

        foreach (var message in normalized)
        {
            if (message.Role == "system")
                continue;

            var blocks = message.GetBlockContent();
            if (blocks.Count == 0)
            {
                formatted.Add(new JsonObject
                {
                    ["role"] = message.Role,
                    ["content"] = message.GetTextContent()
                });
                continue;
            }

            if (message.Role == "user")
            {
                var hasImages = blocks.OfType<ImageBlock>().Any();
                if (hasImages)
                {
                    var parts = new JsonArray();
                    foreach (var block in blocks)
                    {
                        if (TryFormatOpenAiUserPart(block, out var part) && part is not null)
                            parts.Add(part);
                    }

                    if (parts.Count > 0)
                    {
                        formatted.Add(new JsonObject
                        {
                            ["role"] = "user",
                            ["content"] = parts
                        });
                        continue;
                    }
                }

                var userTextParts = new JsonArray();
                foreach (var textBlock in blocks.OfType<TextBlock>())
                {
                    userTextParts.Add(new JsonObject
                    {
                        ["type"] = "text",
                        ["text"] = textBlock.Text
                    });
                }

                if (userTextParts.Count > 0)
                {
                    formatted.Add(new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = userTextParts
                    });
                    continue;
                }
            }

            var toolResults = blocks.OfType<ToolResultBlock>().ToList();
            if (toolResults.Count > 0)
            {
                foreach (var toolResult in toolResults)
                {
                    formatted.Add(new JsonObject
                    {
                        ["role"] = "tool",
                        ["tool_call_id"] = toolResult.ToolUseId,
                        ["content"] = FormatOpenAiToolResultContent(toolResult.GetContentValue())
                    });
                }
                continue;
            }

            var toolUses = blocks.OfType<ToolUseBlock>().ToList();
            var textContent = string.Concat(blocks.OfType<TextBlock>().Select(block => block.Text));
            var reasoningContent = string.Concat(blocks.OfType<ThinkingBlock>().Select(block => block.Thinking));
            var googleThinkingSignature = isGoogleCompatible
                ? blocks.OfType<ThinkingBlock>()
                    .Reverse()
                    .FirstOrDefault(block => !string.IsNullOrWhiteSpace(block.EncryptedContent)
                        && (block.EncryptedContentProvider is null || block.EncryptedContentProvider == "google"))
                    ?.EncryptedContent
                : null;

            var assistantMessage = new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = string.IsNullOrEmpty(textContent) ? null : textContent
            };

            if (!string.IsNullOrEmpty(reasoningContent))
                assistantMessage["reasoning_content"] = reasoningContent;
            if (!string.IsNullOrEmpty(googleThinkingSignature))
                assistantMessage["reasoning_encrypted_content"] = googleThinkingSignature;

            if (toolUses.Count > 0)
            {
                var toolCalls = new JsonArray();
                foreach (var toolUse in toolUses)
                {
                    var toolCall = new JsonObject
                    {
                        ["id"] = toolUse.Id,
                        ["type"] = "function",
                        ["function"] = new JsonObject
                        {
                            ["name"] = toolUse.Name,
                            ["arguments"] = SerializeInput(toolUse.Input)
                        }
                    };

                    var extraContent = isGoogleCompatible
                        ? toolUse.ExtraContent ?? CreateGoogleThoughtExtraContent(googleThinkingSignature)
                        : null;
                    if (extraContent is not null)
                    {
                        toolCall["extra_content"] = JsonNode.Parse(JsonSerializer.Serialize(extraContent, AppJsonContext.Default.ToolCallExtraContent));
                    }

                    toolCalls.Add(toolCall);
                }

                if (toolCalls.Count > 0)
                    assistantMessage["tool_calls"] = toolCalls;
            }

            formatted.Add(assistantMessage);
        }

        return formatted;
    }

    public static JsonArray FormatGeminiMessages(List<UnifiedMessage> messages)
    {
        var formatted = new JsonArray();
        var toolCallNameById = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var message in messages)
        {
            if (message.Role == "system")
                continue;

            var blocks = message.GetBlockContent();
            if (blocks.Count == 0)
            {
                var text = message.GetTextContent();
                if (string.IsNullOrWhiteSpace(text))
                    continue;

                formatted.Add(new JsonObject
                {
                    ["role"] = message.Role == "assistant" ? "model" : "user",
                    ["parts"] = new JsonArray
                    {
                        new JsonObject { ["text"] = text }
                    }
                });
                continue;
            }

            var parts = new JsonArray();
            foreach (var block in blocks)
            {
                if (block is ToolUseBlock toolUse)
                    toolCallNameById[toolUse.Id] = toolUse.Name;

                if (TryFormatGeminiPart(block, toolCallNameById, out var part) && part is not null)
                    parts.Add(part);
            }

            if (parts.Count == 0)
                continue;

            formatted.Add(new JsonObject
            {
                ["role"] = message.Role == "assistant" ? "model" : "user",
                ["parts"] = parts
            });
        }

        return formatted;
    }

    public static JsonNode? NormalizeToolSchema(JsonElement schema, bool sanitizeForGemini)
    {
        JsonObject root;
        if (schema.ValueKind == JsonValueKind.Object && schema.TryGetProperty("properties", out _))
        {
            root = JsonNode.Parse(schema.GetRawText())?.AsObject() ?? new JsonObject();
        }
        else if (schema.ValueKind == JsonValueKind.Object && schema.TryGetProperty("oneOf", out var oneOf)
            && oneOf.ValueKind == JsonValueKind.Array)
        {
            var mergedProperties = new JsonObject();
            List<string>? requiredIntersection = null;

            foreach (var variant in oneOf.EnumerateArray())
            {
                if (variant.ValueKind != JsonValueKind.Object)
                    continue;

                if (variant.TryGetProperty("properties", out var properties) && properties.ValueKind == JsonValueKind.Object)
                {
                    foreach (var property in properties.EnumerateObject())
                    {
                        if (!mergedProperties.ContainsKey(property.Name))
                            mergedProperties[property.Name] = JsonNode.Parse(property.Value.GetRawText());
                    }
                }

                var required = variant.TryGetProperty("required", out var requiredElement)
                    && requiredElement.ValueKind == JsonValueKind.Array
                    ? requiredElement.EnumerateArray().Select(item => item.GetString()).Where(static item => !string.IsNullOrWhiteSpace(item)).Cast<string>().ToList()
                    : [];

                requiredIntersection = requiredIntersection is null
                    ? required
                    : requiredIntersection.Intersect(required, StringComparer.Ordinal).ToList();
            }

            root = new JsonObject
            {
                ["type"] = ParseJsonString("object"),
                ["properties"] = mergedProperties,
                ["additionalProperties"] = ParseJsonLiteral("false")
            };

            if (requiredIntersection is { Count: > 0 })
            {
                var requiredArray = new JsonArray();
                foreach (var item in requiredIntersection)
                    requiredArray.Add(ParseJsonString(item));
                root["required"] = requiredArray;
            }
        }
        else
        {
            root = new JsonObject { ["type"] = ParseJsonString("object"), ["properties"] = new JsonObject() };
        }

        if (sanitizeForGemini)
            return SanitizeGeminiSchemaNode(root);

        return root;
    }

    public static void ApplyRequestOverrides(JsonObject body, ProviderConfig config)
    {
        if (config.RequestOverrides?.Body is not null)
        {
            foreach (var (key, value) in config.RequestOverrides.Body)
            {
                body[key] = JsonNode.Parse(value.GetRawText());
            }
        }

        if (config.RequestOverrides?.OmitBodyKeys is not null)
        {
            foreach (var key in config.RequestOverrides.OmitBodyKeys)
            {
                body.Remove(key);
            }
        }
    }

    public static void ApplyHeaderOverrides(Dictionary<string, string> headers, ProviderConfig config)
    {
        if (config.RequestOverrides?.Headers is null)
            return;

        foreach (var (key, rawValue) in config.RequestOverrides.Headers)
        {
            var value = rawValue
                .Replace("{{sessionId}}", config.SessionId ?? string.Empty, StringComparison.Ordinal)
                .Replace("{{ model }}", config.Model ?? string.Empty, StringComparison.Ordinal)
                .Replace("{{model}}", config.Model ?? string.Empty, StringComparison.Ordinal)
                .Trim();
            if (!string.IsNullOrWhiteSpace(value))
                headers[key] = value;
        }
    }

    private static void ApplyAnthropicMessageCacheBreakpoint(JsonArray messages)
    {
        for (var messageIndex = messages.Count - 1; messageIndex >= 0; messageIndex--)
        {
            if (messages[messageIndex] is not JsonObject message)
                continue;

            var content = message["content"];
            if (content is JsonValue textValue)
            {
                var text = textValue.ToJsonString().Trim('"');
                if (string.IsNullOrWhiteSpace(text))
                    continue;

                message["content"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["type"] = "text",
                        ["text"] = text,
                        ["cache_control"] = new JsonObject { ["type"] = "ephemeral" }
                    }
                };
                return;
            }

            if (content is not JsonArray blocks)
                continue;

            for (var blockIndex = blocks.Count - 1; blockIndex >= 0; blockIndex--)
            {
                if (blocks[blockIndex] is not JsonObject block)
                    continue;

                var blockType = block["type"]?.GetValue<string>();
                if (blockType is not ("text" or "image" or "tool_result"))
                    continue;

                block["cache_control"] = new JsonObject { ["type"] = "ephemeral" };
                return;
            }
        }
    }

    private static bool TryFormatAnthropicBlock(ContentBlock block, out JsonNode? node)
    {
        switch (block)
        {
            case ThinkingBlock thinking:
                node = new JsonObject
                {
                    ["type"] = "thinking",
                    ["thinking"] = thinking.Thinking,
                    ["signature"] = !string.IsNullOrWhiteSpace(thinking.EncryptedContent)
                        && (thinking.EncryptedContentProvider is null || thinking.EncryptedContentProvider == "anthropic")
                        ? thinking.EncryptedContent
                        : null
                };
                return true;
            case TextBlock text:
                node = new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = text.Text
                };
                return true;
            case ToolUseBlock toolUse:
                node = new JsonObject
                {
                    ["type"] = "tool_use",
                    ["id"] = toolUse.Id,
                    ["name"] = toolUse.Name,
                    ["input"] = JsonNode.Parse(SerializeInput(toolUse.Input))
                };
                return true;
            case ToolResultBlock toolResult:
                node = new JsonObject
                {
                    ["type"] = "tool_result",
                    ["tool_use_id"] = toolResult.ToolUseId,
                    ["content"] = FormatAnthropicToolResultContent(toolResult.GetContentValue())
                };
                return true;
            case ImageBlock image:
                node = new JsonObject
                {
                    ["type"] = "image",
                    ["source"] = BuildAnthropicImageSource(image)
                };
                return true;
            default:
                node = new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = "[unsupported block]"
                };
                return true;
        }
    }

    private static bool TryFormatOpenAiUserPart(ContentBlock block, out JsonNode? node)
    {
        switch (block)
        {
            case ImageBlock image:
            {
                var url = image.Source.Type == "base64"
                    ? $"data:{image.Source.MediaType ?? "image/png"};base64,{image.Source.Data}"
                    : image.Source.Url ?? string.Empty;
                node = new JsonObject
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JsonObject
                    {
                        ["url"] = url
                    }
                };
                return true;
            }
            case TextBlock text:
                node = new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = text.Text
                };
                return true;
            default:
                node = null;
                return false;
        }
    }

    private static JsonNode FormatOpenAiToolResultContent(object? content)
    {
        return ToJsonNode(content) ?? JsonValue.Create(string.Empty)!;
    }

    private static JsonNode FormatAnthropicToolResultContent(object? content)
    {
        return content switch
        {
            null => JsonValue.Create(string.Empty)!,
            string text => ParseJsonString(text),
            JsonElement element => FormatAnthropicToolResultContent(element),
            JsonNode node => FormatAnthropicToolResultContent(node),
            IEnumerable<ContentBlock> blocks => FormatAnthropicToolResultContent(blocks.ToList()),
            _ => ParseJsonString(JsonSerializer.Serialize(content))
        };
    }

    private static JsonNode FormatAnthropicToolResultContent(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
            return ParseJsonString(element.GetString() ?? string.Empty);

        if (element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return JsonValue.Create(string.Empty)!;

        if (element.ValueKind == JsonValueKind.Array)
        {
            try
            {
                var blocks = ContentBlockJson.DeserializeList(element);
                if (blocks.Count == element.GetArrayLength()
                    && TryFormatAnthropicToolResultBlocks(blocks, out var array))
                {
                    return array;
                }
            }
            catch
            {
            }
        }

        return ParseJsonString(element.GetRawText());
    }

    private static JsonNode FormatAnthropicToolResultContent(JsonNode node)
    {
        if (node is null)
            return JsonValue.Create(string.Empty)!;

        if (node is JsonValue value && TryReadJsonString(value, out var text))
            return ParseJsonString(text);

        try
        {
            var element = JsonSerializer.Deserialize(node.ToJsonString(), AppJsonContext.Default.JsonElement);
            return FormatAnthropicToolResultContent(element);
        }
        catch
        {
            return ParseJsonString(node.ToJsonString());
        }
    }

    private static JsonNode FormatAnthropicToolResultContent(List<ContentBlock> blocks)
    {
        return TryFormatAnthropicToolResultBlocks(blocks, out var array)
            ? array
            : ParseJsonString(SerializeToolResultContent(blocks));
    }

    private static bool TryFormatAnthropicToolResultBlocks(
        IEnumerable<ContentBlock> blocks,
        out JsonArray array)
    {
        array = new JsonArray();
        foreach (var block in blocks)
        {
            if (!TryFormatAnthropicToolResultBlock(block, out var node) || node is null)
            {
                array = new JsonArray();
                return false;
            }

            array.Add(node);
        }

        return true;
    }

    private static bool TryFormatAnthropicToolResultBlock(ContentBlock block, out JsonNode? node)
    {
        switch (block)
        {
            case TextBlock text:
                node = new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = text.Text
                };
                return true;
            case ImageBlock image when (image.Source.Type == "base64" && !string.IsNullOrWhiteSpace(image.Source.Data))
                || (image.Source.Type == "url" && !string.IsNullOrWhiteSpace(image.Source.Url)):
                node = new JsonObject
                {
                    ["type"] = "image",
                    ["source"] = BuildAnthropicImageSource(image)
                };
                return true;
            default:
                node = null;
                return false;
        }
    }

    private static JsonObject BuildAnthropicImageSource(ImageBlock image)
    {
        var source = new JsonObject
        {
            ["type"] = image.Source.Type
        };

        if (!string.IsNullOrWhiteSpace(image.Source.MediaType))
            source["media_type"] = image.Source.MediaType;

        if (image.Source.Type == "base64")
            source["data"] = image.Source.Data;
        else if (image.Source.Type == "url")
            source["url"] = image.Source.Url;

        return source;
    }

    private static bool TryReadJsonString(JsonValue value, out string text)
    {
        if (value.TryGetValue<string>(out var stringValue))
        {
            text = stringValue;
            return true;
        }

        text = string.Empty;
        return false;
    }

    private static bool TryFormatGeminiPart(
        ContentBlock block,
        IReadOnlyDictionary<string, string> toolCallNameById,
        out JsonNode? part)
    {
        switch (block)
        {
            case TextBlock text when !string.IsNullOrWhiteSpace(text.Text):
                part = new JsonObject { ["text"] = text.Text };
                return true;
            case ThinkingBlock thinking when !string.IsNullOrWhiteSpace(thinking.Thinking):
                part = new JsonObject
                {
                    ["text"] = thinking.Thinking,
                    ["thought"] = true,
                    ["thoughtSignature"] = !string.IsNullOrWhiteSpace(thinking.EncryptedContent)
                        && (thinking.EncryptedContentProvider is null || thinking.EncryptedContentProvider == "google")
                        ? thinking.EncryptedContent
                        : null
                };
                return true;
            case ImageBlock image when image.Source.Type == "base64" && !string.IsNullOrWhiteSpace(image.Source.Data):
                part = new JsonObject
                {
                    ["inlineData"] = new JsonObject
                    {
                        ["mimeType"] = image.Source.MediaType ?? "image/png",
                        ["data"] = image.Source.Data
                    }
                };
                return true;
            case ImageBlock image when image.Source.Type == "url" && !string.IsNullOrWhiteSpace(image.Source.Url):
                part = new JsonObject
                {
                    ["fileData"] = new JsonObject
                    {
                        ["mimeType"] = image.Source.MediaType ?? "image/png",
                        ["fileUri"] = image.Source.Url
                    }
                };
                return true;
            case ToolUseBlock toolUse:
                part = new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["name"] = toolUse.Name,
                        ["args"] = JsonNode.Parse(SerializeInput(toolUse.Input))
                    },
                    ["thoughtSignature"] = toolUse.ExtraContent?.Google?.ThoughtSignature
                };
                return true;
            case ToolResultBlock toolResult:
            {
                var toolName = toolCallNameById.TryGetValue(toolResult.ToolUseId, out var resolvedName)
                    ? resolvedName
                    : toolResult.ToolUseId;
                part = new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["name"] = toolName,
                        ["response"] = new JsonObject
                        {
                            ["name"] = toolName,
                            ["content"] = ToJsonNode(toolResult.GetContentValue())
                        }
                    }
                };
                return true;
            }
            default:
                part = null;
                return false;
        }
    }

    private static JsonNode? SanitizeGeminiSchemaNode(JsonNode? value)
    {
        switch (value)
        {
            case JsonArray array:
            {
                var next = new JsonArray();
                foreach (var item in array)
                {
                    var sanitizedItem = SanitizeGeminiSchemaNode(item);
                    if (sanitizedItem is not null)
                        next.Add(sanitizedItem);
                }
                return next;
            }
            case JsonObject obj:
            {
                var next = new JsonObject();
                foreach (var (key, child) in obj)
                {
                    if (key is "additionalProperties" or "const" or "oneOf" or "anyOf" or "allOf"
                        or "$schema" or "$defs" or "definitions" or "patternProperties" or "unevaluatedProperties")
                    {
                        continue;
                    }

                    var sanitizedChild = SanitizeGeminiSchemaNode(child);
                    if (sanitizedChild is not null)
                        next[key] = sanitizedChild;
                }

                if (next["type"]?.GetValue<string>() == "object" && next["properties"] is null)
                    next["properties"] = new JsonObject();

                return next;
            }
            default:
                return value?.DeepClone();
        }
    }

    private static bool IsGoogleCompatible(ProviderConfig? config)
    {
        if (config?.ProviderBuiltinId == "google")
            return true;

        var baseUrl = config?.BaseUrl?.Trim() ?? string.Empty;
        return baseUrl.Contains("generativelanguage.googleapis.com", StringComparison.OrdinalIgnoreCase);
    }

    private static ToolCallExtraContent? CreateGoogleThoughtExtraContent(string? signature)
    {
        return string.IsNullOrWhiteSpace(signature)
            ? null
            : new ToolCallExtraContent
            {
                Google = new GoogleToolCallExtraContent
                {
                    ThoughtSignature = signature
                }
            };
    }

    public static Dictionary<string, JsonElement> ParseToolInputObject(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return new Dictionary<string, JsonElement>();

        try
        {
            var trimmed = raw.Trim();
            var element = JsonSerializer.Deserialize(trimmed, AppJsonContext.Default.JsonElement);

            if (element.ValueKind == JsonValueKind.Object)
            {
                return NormalizeToolInputObject(
                    JsonSerializer.Deserialize(trimmed, AppJsonContext.Default.DictionaryStringJsonElement)
                    ?? new Dictionary<string, JsonElement>());
            }

            if (element.ValueKind == JsonValueKind.String)
            {
                var nested = element.GetString();
                if (!string.IsNullOrWhiteSpace(nested))
                {
                    var nestedTrimmed = nested.Trim();
                    var nestedElement = JsonSerializer.Deserialize(nestedTrimmed, AppJsonContext.Default.JsonElement);
                    if (nestedElement.ValueKind == JsonValueKind.Object)
                    {
                        return NormalizeToolInputObject(
                            JsonSerializer.Deserialize(nestedTrimmed, AppJsonContext.Default.DictionaryStringJsonElement)
                            ?? new Dictionary<string, JsonElement>());
                    }
                }
            }
        }
        catch
        {
        }

        return new Dictionary<string, JsonElement>();
    }

    public static Dictionary<string, JsonElement> NormalizeToolInputObject(Dictionary<string, JsonElement>? input)
    {
        if (input is null || input.Count == 0)
            return new Dictionary<string, JsonElement>();

        var current = input;
        for (var depth = 0; depth < 4; depth++)
        {
            if (!TryUnwrapToolInputObject(current, out var unwrapped))
                break;

            current = unwrapped;
            if (current.Count == 0)
                break;
        }

        return current;
    }

    private static bool TryUnwrapToolInputObject(
        Dictionary<string, JsonElement> input,
        out Dictionary<string, JsonElement> unwrapped)
    {
        unwrapped = input;
        if (input.Count != 1)
            return false;

        var entry = input.First();
        if (!IsWrappedToolInputProperty(entry.Key))
            return false;

        var value = entry.Value;
        if (value.ValueKind == JsonValueKind.Object)
        {
            unwrapped = JsonSerializer.Deserialize(value.GetRawText(), AppJsonContext.Default.DictionaryStringJsonElement)
                ?? new Dictionary<string, JsonElement>();
            return true;
        }

        if (value.ValueKind != JsonValueKind.String)
            return false;

        var nested = value.GetString();
        if (string.IsNullOrWhiteSpace(nested))
            return false;

        try
        {
            var nestedTrimmed = nested.Trim();
            var nestedElement = JsonSerializer.Deserialize(nestedTrimmed, AppJsonContext.Default.JsonElement);
            if (nestedElement.ValueKind != JsonValueKind.Object)
                return false;

            unwrapped = JsonSerializer.Deserialize(nestedTrimmed, AppJsonContext.Default.DictionaryStringJsonElement)
                ?? new Dictionary<string, JsonElement>();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsWrappedToolInputProperty(string key)
    {
        return key is "args" or "arguments" or "input";
    }

    private static string SerializeInput(Dictionary<string, JsonElement> input)
    {
        return JsonSerializer.Serialize(input, AppJsonContext.Default.DictionaryStringJsonElement);
    }

    private static string SerializeToolResultContent(object? content)
    {
        return content switch
        {
            null => string.Empty,
            string text => text,
            JsonElement element => element.GetRawText(),
            JsonNode node => node.ToJsonString(),
            IEnumerable<ContentBlock> blocks => JsonSerializer.Serialize(blocks.ToList(), AppJsonContext.Default.ListContentBlock),
            _ => JsonSerializer.Serialize(content)
        };
    }

    private static JsonNode? ToJsonNode(object? value)
    {
        return value switch
        {
            null => null,
            JsonNode node => node.DeepClone(),
            string text => ParseJsonString(text),
            JsonElement element => JsonNode.Parse(element.GetRawText()),
            IEnumerable<ContentBlock> blocks => JsonNode.Parse(JsonSerializer.Serialize(blocks.ToList(), AppJsonContext.Default.ListContentBlock)),
            _ => JsonNode.Parse(JsonSerializer.Serialize(value))
        };
    }

    private static JsonNode ParseJsonString(string value)
    {
        return JsonNode.Parse(JsonSerializer.Serialize(value, AppJsonContext.Default.String))!;
    }

    private static JsonNode ParseJsonLiteral(string rawJson)
    {
        return JsonNode.Parse(rawJson)!;
    }
}
