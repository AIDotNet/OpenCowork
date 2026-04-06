using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class OpenAiResponsesProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    private const string DesktopScreenshotToolName = "DesktopScreenshot";
    private const string DesktopClickToolName = "DesktopClick";
    private const string DesktopTypeToolName = "DesktopType";
    private const string DesktopScrollToolName = "DesktopScroll";
    private const string DesktopWaitToolName = "DesktopWait";

    public string Name => "OpenAI Responses";
    public string Type => "openai-responses";

    public OpenAiResponsesProvider(LlmHttpClientFactory httpFactory)
    {
        _httpFactory = httpFactory;
    }

    public async IAsyncEnumerable<StreamEvent> SendMessageAsync(
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        ProviderConfig config,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var requestStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var state = new StreamingState();
        var outputTokens = 0;

        var baseUrl = (config.BaseUrl ?? "https://api.openai.com/v1").TrimEnd('/');
        var url = $"{baseUrl}/responses";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["Accept"] = "text/event-stream",
            ["Authorization"] = $"Bearer {config.ApiKey}"
        };
        if (!string.IsNullOrWhiteSpace(config.UserAgent))
            headers["User-Agent"] = config.UserAgent;
        if (!string.IsNullOrWhiteSpace(config.ServiceTier))
            headers["service_tier"] = config.ServiceTier;
        if (!string.IsNullOrWhiteSpace(config.Organization))
            headers["OpenAI-Organization"] = config.Organization;
        if (!string.IsNullOrWhiteSpace(config.Project))
            headers["OpenAI-Project"] = config.Project;
        if (!string.IsNullOrWhiteSpace(config.AccountId))
            headers["Chatgpt-Account-Id"] = config.AccountId;

        ProviderMessageFormatter.ApplyHeaderOverrides(headers, config);
        var bodyBytes = await BuildRequestBodyAsync(messages, tools, config, ct);

        yield return new StreamEvent
        {
            Type = "request_debug",
            DebugInfo = CreateRequestDebugInfo(url, "POST", headers, bodyBytes, config)
        };

        var client = _httpFactory.GetClient();
        using var response = await SseStreamReader.SendStreamingRequestAsync(
            client, url, "POST", headers, bodyBytes, ct);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct);
            yield return new StreamEvent
            {
                Type = "error",
                Error = new StreamEventError
                {
                    Type = $"http_{(int)response.StatusCode}",
                    Message = $"HTTP {(int)response.StatusCode}: {errorBody[..Math.Min(2000, errorBody.Length)]}"
                }
            };
            yield break;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct);

        await foreach (var item in SseStreamReader.ReadAsync<OpenAiResponsesSseItem>(
            stream,
            static (eventType, data) =>
            {
                if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                    return null;

                try
                {
                    return new OpenAiResponsesSseItem
                    {
                        EventType = string.IsNullOrEmpty(eventType) ? string.Empty : eventType,
                        Document = JsonDocument.Parse(data.ToArray())
                    };
                }
                catch
                {
                    return null;
                }
            },
            ct))
        {
            using var document = item.Document;
            var root = document.RootElement;

            switch (item.EventType)
            {
                case "response.output_text.delta":
                    {
                        var textDelta = GetStringOrDefault(root, "delta");
                        if (!string.IsNullOrEmpty(textDelta))
                        {
                            state.MarkFirstToken();
                            yield return new StreamEvent { Type = "text_delta", Text = textDelta };
                        }
                    }
                    break;

                case "response.reasoning_summary_text.delta":
                    {
                        var thinkingDelta = GetStringOrDefault(root, "delta");
                        if (!string.IsNullOrEmpty(thinkingDelta))
                        {
                            state.MarkFirstToken();
                            state.EmittedThinkingDelta = true;
                            yield return new StreamEvent { Type = "thinking_delta", Thinking = thinkingDelta };
                        }
                    }
                    break;

                case "response.reasoning_summary_text.done":
                    {
                        if (!state.EmittedThinkingDelta)
                        {
                            var thinkingDone = GetReasoningSummaryText(root);
                            if (!string.IsNullOrWhiteSpace(thinkingDone))
                            {
                                state.MarkFirstToken();
                                state.EmittedThinkingDelta = true;
                                yield return new StreamEvent { Type = "thinking_delta", Thinking = thinkingDone };
                            }
                        }
                    }
                    break;

                case "response.output_item.added":
                    if (root.TryGetProperty("item", out var addedItem))
                    {
                        foreach (var evt in HandleOutputItemAdded(addedItem, state))
                            yield return evt;
                    }
                    break;

                case "response.output_item.done":
                    if (root.TryGetProperty("item", out var doneItem))
                    {
                        foreach (var evt in HandleOutputItemDone(doneItem, state))
                            yield return evt;
                    }
                    break;

                case "response.function_call_arguments.delta":
                    {
                        var itemId = GetStringOrDefault(root, "item_id");
                        var callId = GetStringOrDefault(root, "call_id");
                        var delta = GetStringOrDefault(root, "delta");
                        if (!string.IsNullOrEmpty(itemId))
                        {
                            if (!state.ArgBuffers.TryGetValue(itemId, out var buffer))
                            {
                                buffer = new StringBuilder();
                                state.ArgBuffers[itemId] = buffer;
                            }
                            buffer.Append(delta);
                        }

                        if (!string.IsNullOrEmpty(callId) && !string.IsNullOrEmpty(delta))
                        {
                            yield return new StreamEvent
                            {
                                Type = "tool_call_delta",
                                ToolCallId = callId,
                                ArgumentsDelta = delta
                            };
                        }
                    }
                    break;

                case "response.function_call_arguments.done":
                    {
                        var itemId = GetStringOrDefault(root, "item_id");
                        var callId = GetStringOrDefault(root, "call_id");
                        var name = GetStringOrDefault(root, "name");
                        var arguments = GetStringOrDefault(root, "arguments");

                        var finalArguments = arguments;
                        if (!string.IsNullOrEmpty(itemId) && state.ArgBuffers.TryGetValue(itemId, out var buffer))
                        {
                            var bufferedArguments = buffer.ToString();
                            if (!string.IsNullOrWhiteSpace(bufferedArguments))
                                finalArguments = bufferedArguments;

                            state.ArgBuffers.Remove(itemId);
                        }

                        yield return new StreamEvent
                        {
                            Type = "tool_call_end",
                            ToolCallId = callId,
                            ToolName = name,
                            ToolCallInput = ParseArguments(finalArguments)
                        };
                    }
                    break;

                case "response.completed":
                    {
                        if (root.TryGetProperty("response", out var completedResponse))
                        {
                            if (completedResponse.TryGetProperty("output", out var output)
                                && output.ValueKind == JsonValueKind.Array)
                            {
                                foreach (var outputItem in output.EnumerateArray())
                                {
                                    foreach (var evt in HandleCompletedOutputItem(outputItem, state))
                                        yield return evt;
                                }
                            }

                            outputTokens = GetIntOrDefault(completedResponse, "usage", "output_tokens", outputTokens);
                            var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            var usage = BuildUsage(completedResponse);
                            if (usage is not null)
                                outputTokens = usage.OutputTokens;

                            yield return new StreamEvent
                            {
                                Type = "message_end",
                                StopReason = GetStringOrDefault(completedResponse, "status"),
                                ProviderResponseId = GetStringOrDefault(completedResponse, "id"),
                                Usage = usage,
                                Timing = new RequestTiming
                                {
                                    TotalMs = completedAt - requestStartedAt,
                                    TtftMs = state.FirstTokenAt.HasValue ? state.FirstTokenAt.Value - requestStartedAt : null,
                                    Tps = outputTokens > 1 && state.FirstTokenAt.HasValue
                                        ? (outputTokens - 1) / ((completedAt - state.FirstTokenAt.Value) / 1000.0)
                                        : null
                                }
                            };
                        }
                    }
                    break;

                case "response.failed":
                case "error":
                    yield return new StreamEvent
                    {
                        Type = "error",
                        Error = new StreamEventError
                        {
                            Type = "api_error",
                            Message = root.GetRawText()
                        }
                    };
                    break;
            }
        }
    }

    private static RequestDebugInfo CreateRequestDebugInfo(string url, string method, Dictionary<string, string> headers, byte[] bodyBytes, ProviderConfig config)
    {
        var maskedHeaders = headers.ToDictionary(
            static pair => pair.Key,
            pair => pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                ? "Bearer ***"
                : pair.Value);

        return new RequestDebugInfo
        {
            Url = url,
            Method = method,
            Headers = maskedHeaders,
            Body = Encoding.UTF8.GetString(bodyBytes),
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ProviderId = config.ProviderId,
            ProviderBuiltinId = config.ProviderBuiltinId,
            Model = config.Model,
            ExecutionPath = "sidecar"
        };
    }

    private static async Task<byte[]> BuildRequestBodyAsync(
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        ProviderConfig config,
        CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["model"] = config.Model,
            ["input"] = FormatResponsesInput(messages, config.SystemPrompt, config.ComputerUseEnabled == true),
            ["stream"] = true
        };

        if (config.EnablePromptCache != false)
        {
            var cacheKey = !string.IsNullOrWhiteSpace(config.PromptCacheKey)
                ? config.PromptCacheKey
                : !string.IsNullOrWhiteSpace(config.SessionId)
                    ? config.SessionId
                    : null;
            if (!string.IsNullOrWhiteSpace(cacheKey))
                body["prompt_cache_key"] = cacheKey;
        }

        var formattedTools = BuildToolsPayload(tools, config.ComputerUseEnabled == true);
        if (formattedTools.Count > 0)
            body["tools"] = formattedTools;

        if (config.Temperature is not null)
            body["temperature"] = config.Temperature;
        if (config.ServiceTier is not null)
            body["service_tier"] = config.ServiceTier;
        if (config.MaxTokens is not null)
            body["max_output_tokens"] = config.MaxTokens;

        if (config.ThinkingEnabled == true && config.ThinkingConfig is not null)
        {
            foreach (var (key, value) in config.ThinkingConfig.BodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());

            var reasoning = body["reasoning"] as JsonObject ?? new JsonObject();
            if (config.ThinkingConfig.ReasoningEffortLevels?.Count > 0 && !string.IsNullOrWhiteSpace(config.ReasoningEffort))
                reasoning["effort"] = config.ReasoningEffort;
            if (!string.Equals(config.Model, "gpt-5.3-codex-spark", StringComparison.OrdinalIgnoreCase))
                reasoning["summary"] = config.ResponseSummary ?? "auto";
            if (reasoning.Count > 0)
                body["reasoning"] = reasoning;

            var include = body["include"] as JsonArray ?? new JsonArray();
            if (!include.Any(node => string.Equals(node?.GetValue<string>(), "reasoning.encrypted_content", StringComparison.Ordinal)))
                include.Add(JsonNode.Parse(JsonSerializer.Serialize("reasoning.encrypted_content", AppJsonContext.Default.String)));
            body["include"] = include;

            if (config.ThinkingConfig.ForceTemperature is not null)
                body["temperature"] = config.ThinkingConfig.ForceTemperature;
        }
        else if (config.ThinkingEnabled != true && config.ThinkingConfig?.DisabledBodyParams is { Count: > 0 } disabledBodyParams)
        {
            foreach (var (key, value) in disabledBodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());
        }

        var overridesBody = config.RequestOverrides?.Body;
        var hasInstructionsOverride = overridesBody is not null && overridesBody.ContainsKey("instructions");
        if (!hasInstructionsOverride && !string.IsNullOrWhiteSpace(config.InstructionsPrompt))
        {
            var instructions = await LoadPromptContentAsync(config.InstructionsPrompt, ct);
            if (!string.IsNullOrWhiteSpace(instructions))
                body["instructions"] = instructions;
        }

        ProviderMessageFormatter.ApplyRequestOverrides(body, config);
        using var ms = new System.IO.MemoryStream();
        using (var w = new System.Text.Json.Utf8JsonWriter(ms))
        { body.WriteTo(w); }
        return ms.ToArray();
    }

    private static JsonArray BuildToolsPayload(List<ToolDefinition> tools, bool includeComputerTool)
    {
        var result = new JsonArray();
        if (includeComputerTool)
            result.Add(new JsonObject { ["type"] = "computer" });

        foreach (var tool in tools)
        {
            result.Add(new JsonObject
            {
                ["type"] = "function",
                ["name"] = tool.Name,
                ["description"] = tool.Description,
                ["parameters"] = ProviderMessageFormatter.NormalizeToolSchema(tool.InputSchema, sanitizeForGemini: false),
                ["strict"] = false
            });
        }

        return result;
    }

    private static JsonArray FormatResponsesInput(List<UnifiedMessage> messages, string? systemPrompt, bool includeEncryptedReasoning)
    {
        var input = new JsonArray();
        var normalized = ProviderMessageFormatter.NormalizeMessagesForToolReplay(messages);

        if (!string.IsNullOrWhiteSpace(systemPrompt))
        {
            input.Add(new JsonObject
            {
                ["type"] = "message",
                ["role"] = "developer",
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
                input.Add(new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = message.Role,
                    ["content"] = message.GetTextContent()
                });
                continue;
            }

            if (message.Role == "user")
            {
                var parts = new JsonArray();
                foreach (var block in blocks)
                {
                    switch (block)
                    {
                        case TextBlock textBlock:
                            parts.Add(new JsonObject
                            {
                                ["type"] = "input_text",
                                ["text"] = textBlock.Text
                            });
                            break;
                        case ImageBlock imageBlock:
                            var url = imageBlock.Source.Type == "base64"
                                ? $"data:{imageBlock.Source.MediaType ?? "image/png"};base64,{imageBlock.Source.Data}"
                                : imageBlock.Source.Url ?? string.Empty;
                            parts.Add(new JsonObject
                            {
                                ["type"] = "input_image",
                                ["image_url"] = url
                            });
                            break;
                    }
                }

                if (parts.Count > 0)
                {
                    input.Add(new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "user",
                        ["content"] = parts
                    });
                    continue;
                }
            }

            foreach (var block in blocks)
            {
                switch (block)
                {
                    case TextBlock textBlock:
                        input.Add(new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = message.Role,
                            ["content"] = textBlock.Text
                        });
                        break;
                    case ThinkingBlock thinkingBlock when includeEncryptedReasoning
                        && message.Role == "assistant"
                        && !string.IsNullOrWhiteSpace(thinkingBlock.EncryptedContent)
                        && (thinkingBlock.EncryptedContentProvider is null
                            || thinkingBlock.EncryptedContentProvider == "openai-responses"):
                        input.Add(new JsonObject
                        {
                            ["type"] = "reasoning",
                            ["summary"] = !string.IsNullOrWhiteSpace(thinkingBlock.Thinking)
                                ? new JsonArray
                                {
                                    new JsonObject
                                    {
                                        ["type"] = "summary_text",
                                        ["text"] = thinkingBlock.Thinking
                                    }
                                }
                                : new JsonArray(),
                            ["encrypted_content"] = thinkingBlock.EncryptedContent
                        });
                        break;
                    case ToolUseBlock toolUseBlock when toolUseBlock.ExtraContent?.OpenAiResponses?.ComputerUse?.Kind != "computer_use":
                        input.Add(new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = toolUseBlock.Id,
                            ["name"] = toolUseBlock.Name,
                            ["arguments"] = JsonSerializer.Serialize(toolUseBlock.Input, AppJsonContext.Default.DictionaryStringJsonElement),
                            ["status"] = "completed"
                        });
                        break;
                    case ToolResultBlock toolResultBlock when !IsComputerUseToolResultBlock(toolResultBlock, normalized, message.Id):
                        input.Add(new JsonObject
                        {
                            ["type"] = "function_call_output",
                            ["call_id"] = toolResultBlock.ToolUseId,
                            ["output"] = SerializeResponsesToolResultOutput(toolResultBlock.GetContentValue())
                        });
                        break;
                }
            }
        }

        return input;
    }

    private static string SerializeResponsesToolResultOutput(object? content)
    {
        return content switch
        {
            null => string.Empty,
            string text => text,
            IEnumerable<ContentBlock> blocks => string.Join("\n", blocks.Select(block => block switch
            {
                TextBlock textBlock => textBlock.Text,
                ImageBlock => "[Image attached]",
                _ => string.Empty
            }).Where(text => !string.IsNullOrWhiteSpace(text))),
            JsonElement element => element.ValueKind == JsonValueKind.String ? element.GetString() ?? string.Empty : element.GetRawText(),
            JsonNode node => node.ToJsonString(),
            _ => JsonSerializer.Serialize(content)
        };
    }

    private static List<StreamEvent> HandleOutputItemAdded(JsonElement item, StreamingState state)
    {
        var events = new List<StreamEvent>();
        var type = GetStringOrDefault(item, "type");
        switch (type)
        {
            case "function_call":
                {
                    var itemId = GetStringOrDefault(item, "id");
                    var callId = GetStringOrDefault(item, "call_id");
                    var name = GetStringOrDefault(item, "name");
                    if (!string.IsNullOrEmpty(itemId))
                    {
                        state.ArgBuffers[itemId] = new StringBuilder();
                        state.FunctionCallIdsByItemId[itemId] = callId;
                        state.FunctionNamesByItemId[itemId] = name;
                    }

                    state.MarkFirstToken();
                    events.Add(new StreamEvent
                    {
                        Type = "tool_call_start",
                        ToolCallId = callId,
                        ToolName = name
                    });
                    break;
                }
            case "computer_call":
                events.AddRange(BuildComputerUseToolEvents(item, state.EmittedComputerCallIds));
                break;
            case "reasoning":
                {
                    var encrypted = GetStringOrDefault(item, "encrypted_content");
                    if (!string.IsNullOrWhiteSpace(encrypted) && state.EmittedThinkingEncrypted.Add(encrypted))
                    {
                        events.Add(new StreamEvent
                        {
                            Type = "thinking_encrypted",
                            ThinkingEncryptedContent = encrypted,
                            ThinkingEncryptedProvider = "openai-responses"
                        });
                    }
                    break;
                }
        }
        return events;
    }

    private static List<StreamEvent> HandleOutputItemDone(JsonElement item, StreamingState state)
    {
        var events = new List<StreamEvent>();
        var type = GetStringOrDefault(item, "type");
        if (type == "computer_call")
            events.AddRange(BuildComputerUseToolEvents(item, state.EmittedComputerCallIds));

        if (!state.EmittedThinkingDelta)
        {
            var summary = GetReasoningSummaryText(item);
            if (!string.IsNullOrWhiteSpace(summary))
            {
                state.MarkFirstToken();
                state.EmittedThinkingDelta = true;
                events.Add(new StreamEvent { Type = "thinking_delta", Thinking = summary });
            }
        }

        var encrypted = GetStringOrDefault(item, "encrypted_content");
        if (string.IsNullOrWhiteSpace(encrypted) && item.TryGetProperty("reasoning", out var reasoning))
            encrypted = GetStringOrDefault(reasoning, "encrypted_content");

        if (!string.IsNullOrWhiteSpace(encrypted) && state.EmittedThinkingEncrypted.Add(encrypted))
        {
            events.Add(new StreamEvent
            {
                Type = "thinking_encrypted",
                ThinkingEncryptedContent = encrypted,
                ThinkingEncryptedProvider = "openai-responses"
            });
        }

        if (type == "function_call")
        {
            var itemId = GetStringOrDefault(item, "id");
            if (!string.IsNullOrWhiteSpace(itemId)
                && state.FunctionCallIdsByItemId.TryGetValue(itemId, out var callId)
                && state.FunctionNamesByItemId.TryGetValue(itemId, out var name)
                && item.TryGetProperty("arguments", out var arguments))
            {
                events.Add(new StreamEvent
                {
                    Type = "tool_call_end",
                    ToolCallId = callId,
                    ToolName = name,
                    ToolCallInput = ParseArguments(arguments.ValueKind == JsonValueKind.String ? arguments.GetString() : arguments.GetRawText())
                });
            }
        }

        return events;
    }

    private static List<StreamEvent> HandleCompletedOutputItem(JsonElement item, StreamingState state)
        => HandleOutputItemDone(item, state);

    private static TokenUsage? BuildUsage(JsonElement response)
    {
        if (!response.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object)
            return null;

        var inputTokens = GetIntOrDefault(usage, "input_tokens", 0);
        var outputTokens = GetIntOrDefault(usage, "output_tokens", 0);
        var cachedTokens = usage.TryGetProperty("input_tokens_details", out var inputDetails)
            ? GetIntOrDefault(inputDetails, "cached_tokens", 0)
            : 0;
        var reasoningTokens = usage.TryGetProperty("output_tokens_details", out var outputDetails)
            ? GetNullableInt(outputDetails, "reasoning_tokens")
            : null;

        return new TokenUsage
        {
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            BillableInputTokens = Math.Max(0, inputTokens - cachedTokens),
            ContextTokens = inputTokens,
            CacheReadTokens = cachedTokens > 0 ? cachedTokens : null,
            ReasoningTokens = reasoningTokens
        };
    }

    private static List<StreamEvent> BuildComputerUseToolEvents(JsonElement item, HashSet<string> emittedComputerCallIds)
    {
        var events = new List<StreamEvent>();
        var callId = GetStringOrDefault(item, "call_id");
        if (string.IsNullOrWhiteSpace(callId) || !emittedComputerCallIds.Add(callId))
            return events;

        if (!item.TryGetProperty("actions", out var actions) || actions.ValueKind != JsonValueKind.Array)
            return events;

        var actionElements = actions.EnumerateArray().ToList();
        var descriptors = new List<ComputerActionDescriptor>();
        var sawScreenshot = false;

        for (var index = 0; index < actionElements.Count; index++)
        {
            var action = actionElements[index];
            var actionType = GetStringOrDefault(action, "type");
            if (string.IsNullOrWhiteSpace(actionType))
                continue;

            if (actionType == "screenshot")
            {
                sawScreenshot = true;
                descriptors.Add(new ComputerActionDescriptor
                {
                    ToolName = DesktopScreenshotToolName,
                    Input = new Dictionary<string, object?>(),
                    ActionType = actionType,
                    ActionIndex = index,
                    AutoAddedScreenshot = false
                });
                continue;
            }

            descriptors.AddRange(MapComputerActionDescriptors(callId, actionType, action, index));
        }

        if (!sawScreenshot)
        {
            descriptors.Add(new ComputerActionDescriptor
            {
                ToolName = DesktopScreenshotToolName,
                Input = new Dictionary<string, object?>(),
                ActionType = "screenshot",
                ActionIndex = actionElements.Count,
                AutoAddedScreenshot = true
            });
        }

        for (var i = 0; i < descriptors.Count; i++)
        {
            var descriptor = descriptors[i];
            var toolCallId = BuildComputerToolUseId(callId, descriptor.ActionIndex, descriptor.ToolName, i);
            var extraContent = CreateComputerToolExtraContent(callId, descriptor.ActionType, descriptor.ActionIndex, descriptor.AutoAddedScreenshot);
            events.Add(new StreamEvent
            {
                Type = "tool_call_start",
                ToolCallId = toolCallId,
                ToolName = descriptor.ToolName,
                ToolCallExtraContent = extraContent
            });
            events.Add(new StreamEvent
            {
                Type = "tool_call_end",
                ToolCallId = toolCallId,
                ToolName = descriptor.ToolName,
                ToolCallInput = ToJsonElementDictionary(descriptor.Input),
                ToolCallExtraContent = extraContent
            });
        }

        return events;
    }

    private static Dictionary<string, JsonElement> ParseArguments(string? arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments))
            return new Dictionary<string, JsonElement>(StringComparer.Ordinal);

        try
        {
            return JsonSerializer.Deserialize(arguments, AppJsonContext.Default.DictionaryStringJsonElement)
                ?? new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [OpenAiResponses] ParseArguments failed: {ex.Message}; raw={arguments}");
            return new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        }
    }

    private static IEnumerable<ComputerActionDescriptor> MapComputerActionDescriptors(string callId, string actionType, JsonElement action, int index)
    {
        switch (actionType)
        {
            case "click":
            case "double_click":
                return
                [
                    new ComputerActionDescriptor
                    {
                        ToolName = DesktopClickToolName,
                        Input = new Dictionary<string, object?>
                        {
                            ["x"] = GetDoubleOrDefault(action, "x", 0),
                            ["y"] = GetDoubleOrDefault(action, "y", 0),
                            ["button"] = GetStringOrDefault(action, "button") is { Length: > 0 } button ? button : "left",
                            ["action"] = actionType == "double_click" ? "double_click" : "click"
                        },
                        ActionType = actionType,
                        ActionIndex = index
                    }
                ];
            case "scroll":
                {
                    var input = new Dictionary<string, object?>
                    {
                        ["scrollX"] = GetDoubleOrDefault(action, "scrollX", 0),
                        ["scrollY"] = GetDoubleOrDefault(action, "scrollY", 0)
                    };
                    if (TryGetDouble(action, "x", out var x)) input["x"] = x;
                    if (TryGetDouble(action, "y", out var y)) input["y"] = y;
                    return
                    [
                        new ComputerActionDescriptor
                        {
                            ToolName = DesktopScrollToolName,
                            Input = input,
                            ActionType = actionType,
                            ActionIndex = index
                        }
                    ];
                }
            case "type":
                return
                [
                    new ComputerActionDescriptor
                    {
                        ToolName = DesktopTypeToolName,
                        Input = new Dictionary<string, object?>
                        {
                            ["text"] = GetStringOrDefault(action, "text")
                        },
                        ActionType = actionType,
                        ActionIndex = index
                    }
                ];
            case "wait":
                return
                [
                    new ComputerActionDescriptor
                    {
                        ToolName = DesktopWaitToolName,
                        Input = new Dictionary<string, object?>
                        {
                            ["delayMs"] = 2000
                        },
                        ActionType = actionType,
                        ActionIndex = index
                    }
                ];
            case "keypress":
                return MapComputerKeypressDescriptors(callId, action, index);
            default:
                return [];
        }
    }

    private static IEnumerable<ComputerActionDescriptor> MapComputerKeypressDescriptors(string callId, JsonElement action, int index)
    {
        if (!action.TryGetProperty("keys", out var keysElement) || keysElement.ValueKind != JsonValueKind.Array)
            return [];

        var keys = keysElement.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => NormalizeComputerKey(item.GetString() ?? string.Empty))
            .Where(key => !string.IsNullOrWhiteSpace(key))
            .Cast<string>()
            .ToList();

        if (keys.Count == 0)
            return [];

        if (keys.Count == 1)
        {
            return
            [
                new ComputerActionDescriptor
                {
                    ToolName = DesktopTypeToolName,
                    Input = new Dictionary<string, object?>
                    {
                        ["key"] = keys[0]
                    },
                    ActionType = "keypress",
                    ActionIndex = index
                }
            ];
        }

        var modifiers = keys.Take(keys.Count - 1).ToList();
        var mainKey = keys[^1];
        var modifierSet = new HashSet<string>(StringComparer.Ordinal) { "Control", "Meta", "Alt", "Shift" };
        if (modifiers.All(modifier => modifierSet.Contains(modifier)))
        {
            return
            [
                new ComputerActionDescriptor
                {
                    ToolName = DesktopTypeToolName,
                    Input = new Dictionary<string, object?>
                    {
                        ["hotkey"] = modifiers.Concat([mainKey]).ToArray()
                    },
                    ActionType = "keypress",
                    ActionIndex = index
                }
            ];
        }

        return keys.Select((key, keyIndex) => new ComputerActionDescriptor
        {
            ToolName = DesktopTypeToolName,
            Input = new Dictionary<string, object?>
            {
                ["key"] = key
            },
            ActionType = "keypress",
            ActionIndex = index * 100 + keyIndex
        });
    }

    private static ToolCallExtraContent CreateComputerToolExtraContent(string callId, string actionType, int actionIndex, bool autoAddedScreenshot)
        => new()
        {
            OpenAiResponses = new OpenAiResponsesToolCallExtraContent
            {
                ComputerUse = new OpenAiComputerUseExtraContent
                {
                    ComputerCallId = callId,
                    ComputerActionType = actionType,
                    ComputerActionIndex = actionIndex,
                    AutoAddedScreenshot = autoAddedScreenshot
                }
            }
        };

    private static string BuildComputerToolUseId(string callId, int actionIndex, string toolName, int suffix)
    {
        var safeToolName = new string(toolName.Select(ch => char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : '_').ToArray());
        return $"{callId}__{actionIndex}__{safeToolName}__{suffix}";
    }

    private static Dictionary<string, JsonElement> ToJsonElementDictionary(Dictionary<string, object?> input)
    {
        var json = JsonSerializer.Serialize(input);
        return JsonSerializer.Deserialize(json, AppJsonContext.Default.DictionaryStringJsonElement)
            ?? new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    private static bool IsComputerUseToolResultBlock(ToolResultBlock block, List<UnifiedMessage> messages, string currentMessageId)
    {
        var currentIndex = messages.FindIndex(message => message.Id == currentMessageId);
        if (currentIndex <= 0)
            return false;

        var previousMessage = messages[currentIndex - 1];
        var previousBlocks = previousMessage.GetBlockContent();
        return previousBlocks.OfType<ToolUseBlock>().Any(candidate =>
            candidate.Id == block.ToolUseId &&
            candidate.ExtraContent?.OpenAiResponses?.ComputerUse?.Kind == "computer_use");
    }

    private static async Task<string?> LoadPromptContentAsync(string name, CancellationToken ct)
    {
        var fileName = NormalizePromptFileName(name);
        if (string.IsNullOrWhiteSpace(fileName))
            return null;

        foreach (var candidate in GetPromptCandidates(fileName))
        {
            if (!File.Exists(candidate))
                continue;

            try
            {
                return await File.ReadAllTextAsync(candidate, ct);
            }
            catch
            {
                // ignore
            }
        }

        return null;
    }

    private static IEnumerable<string> GetPromptCandidates(string fileName)
    {
        var userDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".open-cowork", "prompts");
        yield return Path.Combine(userDir, fileName);

        var baseDir = AppContext.BaseDirectory;
        yield return Path.Combine(baseDir, "resources", "prompts", fileName);
        yield return Path.Combine(baseDir, "..", "resources", "prompts", fileName);
        yield return Path.Combine(baseDir, "app.asar.unpacked", "resources", "prompts", fileName);
        yield return Path.Combine(baseDir, "..", "app.asar.unpacked", "resources", "prompts", fileName);
    }

    private static string NormalizePromptFileName(string name)
    {
        var trimmed = name.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
            return string.Empty;

        return trimmed.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ? trimmed : $"{trimmed}.md";
    }

    private static string? NormalizeComputerKey(string key)
    {
        var normalized = key.Trim().ToUpperInvariant();
        return normalized switch
        {
            "ENTER" => "Enter",
            "TAB" => "Tab",
            "ESCAPE" or "ESC" => "Escape",
            "BACKSPACE" => "Backspace",
            "DELETE" => "Delete",
            "UP" or "ARROWUP" => "ArrowUp",
            "DOWN" or "ARROWDOWN" => "ArrowDown",
            "LEFT" or "ARROWLEFT" => "ArrowLeft",
            "RIGHT" or "ARROWRIGHT" => "ArrowRight",
            "HOME" => "Home",
            "END" => "End",
            "PAGEUP" => "PageUp",
            "PAGEDOWN" => "PageDown",
            "SPACE" => "Space",
            "CTRL" or "CONTROL" => "Control",
            "CMD" or "COMMAND" or "META" => "Meta",
            "ALT" or "OPTION" => "Alt",
            "SHIFT" => "Shift",
            _ when normalized.Length == 1 && char.IsLetterOrDigit(normalized[0]) => normalized,
            _ when System.Text.RegularExpressions.Regex.IsMatch(normalized, "^F([1-9]|1[0-2])$") => normalized,
            _ => null
        };
    }

    private static bool TryGetDouble(JsonElement element, string propertyName, out double value)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.TryGetDouble(out value))
        {
            return true;
        }

        value = default;
        return false;
    }

    private static double GetDoubleOrDefault(JsonElement element, string propertyName, double defaultValue)
        => TryGetDouble(element, propertyName, out var value) ? value : defaultValue;

    private static string GetReasoningSummaryText(JsonElement element)
    {
        var text = GetStringOrDefault(element, "text");
        if (!string.IsNullOrWhiteSpace(text))
            return text;

        var delta = GetStringOrDefault(element, "delta");
        if (!string.IsNullOrWhiteSpace(delta))
            return delta;

        if (element.TryGetProperty("summary", out var summary))
            return ExtractSummaryText(summary);
        if (element.TryGetProperty("reasoning", out var reasoning) && reasoning.TryGetProperty("summary", out var reasoningSummary))
            return ExtractSummaryText(reasoningSummary);
        return string.Empty;
    }

    private static string ExtractSummaryText(JsonElement summary)
    {
        if (summary.ValueKind == JsonValueKind.String)
            return summary.GetString() ?? string.Empty;
        if (summary.ValueKind != JsonValueKind.Array)
            return string.Empty;

        var builder = new StringBuilder();
        foreach (var part in summary.EnumerateArray())
        {
            if (part.ValueKind == JsonValueKind.String)
            {
                builder.Append(part.GetString());
                continue;
            }

            if (part.ValueKind == JsonValueKind.Object)
            {
                var text = GetStringOrDefault(part, "text");
                if (!string.IsNullOrWhiteSpace(text))
                    builder.Append(text);
            }
        }
        return builder.ToString();
    }

    private static string GetStringOrDefault(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String)
        {
            return property.GetString() ?? string.Empty;
        }

        return string.Empty;
    }

    private static int GetIntOrDefault(JsonElement element, string propertyName, int defaultValue)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.TryGetInt32(out var value)
                ? value
                : defaultValue;

    private static int GetIntOrDefault(JsonElement element, string objectPropertyName, string propertyName, int defaultValue)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(objectPropertyName, out var nested)
            && nested.ValueKind == JsonValueKind.Object)
        {
            return GetIntOrDefault(nested, propertyName, defaultValue);
        }

        return defaultValue;
    }

    private static int? GetNullableInt(JsonElement element, string propertyName)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var property)
            && property.TryGetInt32(out var value)
                ? value
                : null;

    private sealed class OpenAiResponsesSseItem
    {
        public required string EventType { get; init; }
        public required JsonDocument Document { get; init; }
    }

    private sealed class ComputerActionDescriptor
    {
        public required string ToolName { get; init; }
        public required Dictionary<string, object?> Input { get; init; }
        public required string ActionType { get; init; }
        public required int ActionIndex { get; init; }
        public bool AutoAddedScreenshot { get; init; }
    }

    private sealed class StreamingState
    {
        public Dictionary<string, StringBuilder> ArgBuffers { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> FunctionCallIdsByItemId { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> FunctionNamesByItemId { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedThinkingEncrypted { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedComputerCallIds { get; } = new(StringComparer.Ordinal);
        public long? FirstTokenAt { get; private set; }
        public bool EmittedThinkingDelta { get; set; }

        public void MarkFirstToken()
        {
            FirstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }
}
