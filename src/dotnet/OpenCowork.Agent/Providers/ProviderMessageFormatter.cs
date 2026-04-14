using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

internal static class ProviderMessageFormatter
{
    private const int EditPreviewChars = 800;
    private const int WritePreviewChars = 1200;
    private const int WriteInlineLimitChars = 32 * 1024;
    private const int EditInlineLimitChars = 16 * 1024;
    private const int HistoryPreviewHeadChars = 800;
    private const int HistoryPreviewTailChars = 320;

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
                for (var j = index + 1; j < messages.Count; j++)
                {
                    var candidateMessage = messages[j];
                    if (candidateMessage.Role != "user")
                        break;

                    var candidateBlocks = candidateMessage.GetBlockContent();
                    if (!candidateBlocks.OfType<ToolResultBlock>().Any())
                        break;

                    foreach (var toolResult in candidateBlocks.OfType<ToolResultBlock>())
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
            }).Select(block => block switch
            {
                ToolUseBlock toolUse => new ToolUseBlock
                {
                    Id = toolUse.Id,
                    Name = toolUse.Name,
                    Input = SummarizeToolInputForHistory(toolUse.Name, toolUse.Input),
                    ExtraContent = toolUse.ExtraContent
                },
                _ => block
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
                var text = message.GetTextContent();
                if (string.IsNullOrWhiteSpace(text))
                    continue;

                formatted.Add(new JsonObject
                {
                    ["role"] = message.Role,
                    ["content"] = text
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
                var text = message.GetTextContent();
                if (string.IsNullOrWhiteSpace(text))
                    continue;

                formatted.Add(new JsonObject
                {
                    ["role"] = message.Role,
                    ["content"] = text
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
            var hasAssistantText = !string.IsNullOrWhiteSpace(textContent);
            var hasAssistantPayload = hasAssistantText
                || !string.IsNullOrWhiteSpace(reasoningContent)
                || !string.IsNullOrWhiteSpace(googleThinkingSignature)
                || toolUses.Count > 0;

            if (!hasAssistantPayload)
                continue;

            var assistantMessage = new JsonObject
            {
                ["role"] = "assistant"
            };

            if (hasAssistantText)
                assistantMessage["content"] = textContent;

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
                            ["arguments"] = SerializeInput(toolUse.Name, toolUse.Input)
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
                    ["input"] = JsonNode.Parse(SerializeInput(toolUse.Name, toolUse.Input))
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
        return ParseJsonString(SerializeToolResultContent(content));
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
            // Fallback: stringify unknown content types. Reflection-based serialization is
            // disabled in this app, so unknown objects fall back to ToString().
            _ => ParseJsonString(content.ToString() ?? string.Empty)
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
                        ["args"] = JsonNode.Parse(SerializeInput(toolUse.Name, toolUse.Input))
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

    private static Dictionary<string, JsonElement> SummarizeToolInputForHistory(
        string? toolName,
        Dictionary<string, JsonElement> input)
    {
        if (input.Count == 0 || string.IsNullOrWhiteSpace(toolName))
            return input;

        if (toolName == "Write" && TryGetString(input, "content", out var content) && content is not null)
        {
            if (content.Length <= WriteInlineLimitChars)
                return input;

            var compact = CompactStreamingToolInput(input);
            compact["content_omitted"] = CreateBoolElement(true);
            compact["content_hash"] = CreateStringElement(HashText(content));
            compact["content_bytes"] = CreateIntElement(Encoding.UTF8.GetByteCount(content));
            compact["content_lines"] = CreateIntElement(LineCount(content));
            compact["content_preview"] = CreateStringElement(content[..Math.Min(content.Length, HistoryPreviewHeadChars)]);
            if (content.Length > HistoryPreviewTailChars)
                compact["content_preview_tail"] = CreateStringElement(content[^Math.Min(content.Length, HistoryPreviewTailChars)..]);
            compact["content_truncated"] = CreateBoolElement(true);
            compact["full_content_available_in_history"] = CreateBoolElement(false);
            return compact;
        }

        if (toolName == "Edit")
        {
            var hasOld = TryGetString(input, "old_string", out var oldString);
            var hasNew = TryGetString(input, "new_string", out var newString);
            if (!hasOld && !hasNew)
                return input;

            if ((oldString?.Length ?? 0) <= EditInlineLimitChars && (newString?.Length ?? 0) <= EditInlineLimitChars)
                return input;

            var compact = CompactStreamingToolInput(input);
            if (hasOld && oldString is not null && oldString.Length > EditInlineLimitChars)
            {
                compact["old_string_omitted"] = CreateBoolElement(true);
                compact["old_string_hash"] = CreateStringElement(HashText(oldString));
                compact["old_string_bytes"] = CreateIntElement(Encoding.UTF8.GetByteCount(oldString));
                compact["old_string_lines"] = CreateIntElement(LineCount(oldString));
                compact["old_string_preview"] = CreateStringElement(BuildEditPreviewPair(oldString, newString ?? string.Empty).oldPreview);
                if (oldString.Length > HistoryPreviewTailChars)
                    compact["old_string_preview_tail"] = CreateStringElement(oldString[^Math.Min(oldString.Length, HistoryPreviewTailChars)..]);
                compact["old_string_truncated"] = CreateBoolElement(true);
            }
            if (hasNew && newString is not null && newString.Length > EditInlineLimitChars)
            {
                compact["new_string_omitted"] = CreateBoolElement(true);
                compact["new_string_hash"] = CreateStringElement(HashText(newString));
                compact["new_string_bytes"] = CreateIntElement(Encoding.UTF8.GetByteCount(newString));
                compact["new_string_lines"] = CreateIntElement(LineCount(newString));
                compact["new_string_preview"] = CreateStringElement(BuildEditPreviewPair(oldString ?? string.Empty, newString).newPreview);
                if (newString.Length > HistoryPreviewTailChars)
                    compact["new_string_preview_tail"] = CreateStringElement(newString[^Math.Min(newString.Length, HistoryPreviewTailChars)..]);
                compact["new_string_truncated"] = CreateBoolElement(true);
            }
            compact["full_content_available_in_history"] = CreateBoolElement(false);
            return compact;
        }

        return input;
    }

    private static Dictionary<string, JsonElement> CompactStreamingToolInput(Dictionary<string, JsonElement> input)
    {
        var compact = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (input.TryGetValue("file_path", out var filePath)) compact["file_path"] = filePath.Clone();
        if (input.TryGetValue("path", out var path)) compact["path"] = path.Clone();
        if (input.TryGetValue("explanation", out var explanation)) compact["explanation"] = explanation.Clone();
        if (input.TryGetValue("replace_all", out var replaceAll)) compact["replace_all"] = replaceAll.Clone();
        if (input.TryGetValue("title", out var title)) compact["title"] = title.Clone();
        if (input.TryGetValue("loading_messages", out var loadingMessages)) compact["loading_messages"] = loadingMessages.Clone();

        var hasOld = TryGetString(input, "old_string", out var oldString);
        var hasNew = TryGetString(input, "new_string", out var newString);
        if (hasOld || hasNew)
        {
            var pair = BuildEditPreviewPair(oldString ?? string.Empty, newString ?? string.Empty);
            if (oldString is not null)
            {
                compact["old_string_preview"] = CreateStringElement(pair.oldPreview);
                compact["old_string_chars"] = CreateIntElement(oldString.Length);
                if (oldString.Length > EditPreviewChars) compact["old_string_truncated"] = CreateBoolElement(true);
            }
            if (newString is not null)
            {
                compact["new_string_preview"] = CreateStringElement(pair.newPreview);
                compact["new_string_chars"] = CreateIntElement(newString.Length);
                if (newString.Length > EditPreviewChars) compact["new_string_truncated"] = CreateBoolElement(true);
            }
        }

        if (TryGetString(input, "content", out var content) && content is not null)
        {
            compact["content_preview"] = CreateStringElement(content[..Math.Min(content.Length, WritePreviewChars)]);
            compact["content_lines"] = CreateIntElement(LineCount(content));
            compact["content_chars"] = CreateIntElement(content.Length);
            if (content.Length > WritePreviewChars) compact["content_truncated"] = CreateBoolElement(true);
        }

        if (TryGetString(input, "widget_code", out var widgetCode) && widgetCode is not null)
        {
            compact["widget_code_preview"] = CreateStringElement(widgetCode[..Math.Min(widgetCode.Length, WritePreviewChars)]);
            compact["widget_code_chars"] = CreateIntElement(widgetCode.Length);
            compact["widget_kind"] = CreateStringElement(widgetCode.TrimStart().StartsWith("<svg", StringComparison.OrdinalIgnoreCase) ? "svg" : "html");
            if (widgetCode.Length > WritePreviewChars) compact["widget_code_truncated"] = CreateBoolElement(true);
        }

        return compact.Count == 0 ? input : compact;
    }

    private static (string oldPreview, string newPreview) BuildEditPreviewPair(string oldString, string newString)
    {
        if (oldString == newString)
        {
            var preview = ExcerptAroundRange(oldString, 0, Math.Min(oldString.Length, EditPreviewChars), EditPreviewChars);
            return (preview, preview);
        }

        var prefixLength = SharedPrefixLength(oldString, newString);
        var suffixLength = SharedSuffixLength(oldString, newString, prefixLength);
        var oldEnd = Math.Max(prefixLength, oldString.Length - suffixLength);
        var newEnd = Math.Max(prefixLength, newString.Length - suffixLength);
        return (
            ExcerptAroundRange(oldString, prefixLength, oldEnd, EditPreviewChars),
            ExcerptAroundRange(newString, prefixLength, newEnd, EditPreviewChars));
    }

    private static string ExcerptAroundRange(string text, int start, int end, int maxChars)
    {
        if (text.Length <= maxChars)
            return text;

        var safeStart = Math.Max(0, Math.Min(start, text.Length));
        var safeEnd = Math.Max(safeStart, Math.Min(end, text.Length));
        var span = Math.Max(1, safeEnd - safeStart);
        if (span >= maxChars - 6)
        {
            var budget = Math.Max(1, maxChars - 6);
            var head = (int)Math.Ceiling(budget / 2d);
            var tail = Math.Max(0, budget - head);
            var builder = new StringBuilder();
            if (safeStart > 0) builder.Append("…\n");
            builder.Append(text[safeStart..Math.Min(safeStart + head, safeEnd)]);
            if (tail > 0 && safeEnd - safeStart > head)
            {
                builder.Append("\n…\n");
                builder.Append(text[Math.Max(safeEnd - tail, safeStart + head)..safeEnd]);
            }
            if (safeEnd < text.Length) builder.Append("\n…");
            return builder.ToString();
        }

        var remaining = maxChars - span;
        var before = Math.Min(safeStart, remaining / 2);
        var after = Math.Min(text.Length - safeEnd, remaining - before);
        var leftover = remaining - before - after;
        if (leftover > 0)
        {
            var extraBefore = Math.Min(safeStart - before, (int)Math.Ceiling(leftover / 2d));
            before += extraBefore;
            after += Math.Min(text.Length - safeEnd - after, leftover - extraBefore);
        }

        var from = safeStart - before;
        var to = safeEnd + after;
        var excerpt = text[from..to];
        if (from > 0) excerpt = $"…\n{excerpt}";
        if (to < text.Length) excerpt = $"{excerpt}\n…";
        return excerpt;
    }

    private static int SharedPrefixLength(string a, string b)
    {
        var limit = Math.Min(a.Length, b.Length);
        var index = 0;
        while (index < limit && a[index] == b[index])
            index += 1;
        return index;
    }

    private static int SharedSuffixLength(string a, string b, int prefixLength)
    {
        var limit = Math.Min(a.Length, b.Length) - prefixLength;
        var count = 0;
        while (count < limit && a[a.Length - 1 - count] == b[b.Length - 1 - count])
            count += 1;
        return count;
    }

    private static int LineCount(string text)
    {
        if (string.IsNullOrEmpty(text))
            return 0;
        return text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Length;
    }

    private static string HashText(string text)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    }

    private static string SerializeInput(string? toolName, Dictionary<string, JsonElement> input)
    {
        return JsonSerializer.Serialize(
            SummarizeToolInputForHistory(toolName, input),
            AppJsonContext.Default.DictionaryStringJsonElement);
    }

    private static string SerializeInput(Dictionary<string, JsonElement> input)
    {
        return JsonSerializer.Serialize(input, AppJsonContext.Default.DictionaryStringJsonElement);
    }

    private static bool TryGetString(Dictionary<string, JsonElement> input, string key, out string? value)
    {
        if (input.TryGetValue(key, out var element) && element.ValueKind == JsonValueKind.String)
        {
            value = element.GetString();
            return value is not null;
        }

        value = null;
        return false;
    }

    private static JsonElement CreateStringElement(string value)
    {
        return JsonDocument.Parse(JsonSerializer.Serialize(value, AppJsonContext.Default.String)).RootElement.Clone();
    }

    private static JsonElement CreateIntElement(int value)
    {
        return JsonDocument.Parse(value.ToString(System.Globalization.CultureInfo.InvariantCulture)).RootElement.Clone();
    }

    private static JsonElement CreateBoolElement(bool value)
    {
        return JsonDocument.Parse(value ? "true" : "false").RootElement.Clone();
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

    private static string SerializeToolResultContent(object? content)
    {
        return content switch
        {
            null => string.Empty,
            string text => text,
            JsonElement element => element.GetRawText(),
            JsonNode node => node.ToJsonString(),
            IEnumerable<ContentBlock> blocks => JsonSerializer.Serialize(blocks.ToList(), AppJsonContext.Default.ListContentBlock),
            // Fallback: reflection serialization is disabled; use ToString() for unknown types.
            _ => content.ToString() ?? string.Empty
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
            // Fallback: stringify unknown content types (reflection serialization is disabled).
            _ => JsonValue.Create(value.ToString() ?? string.Empty)
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
