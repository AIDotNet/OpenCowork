using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class OpenAiChatProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    public string Name => "OpenAI Chat Completions";
    public string Type => "openai-chat";

    public OpenAiChatProvider(LlmHttpClientFactory httpFactory)
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
        long? firstTokenAt = null;
        var outputTokens = 0;
        var emittedMessageEnd = false;

        var baseUrl = (config.BaseUrl ?? "https://api.openai.com/v1").TrimEnd('/');
        var url = $"{baseUrl}/chat/completions";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["Authorization"] = $"Bearer {config.ApiKey}"
        };
        if (config.UserAgent is not null)
            headers["User-Agent"] = config.UserAgent;
        if (config.Organization is not null)
            headers["OpenAI-Organization"] = config.Organization;
        if (config.Project is not null)
            headers["OpenAI-Project"] = config.Project;
        if (config.ServiceTier is not null)
            headers["service_tier"] = config.ServiceTier;

        ProviderMessageFormatter.ApplyHeaderOverrides(headers, config);
        var bodyBytes = BuildRequestBody(messages, tools, config);

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

        // Tool call accumulators (by tool call key)
        var toolIds = new Dictionary<string, string>();
        var toolNames = new Dictionary<string, string>();
        var toolArgs = new Dictionary<string, StringBuilder>();
        var toolExtraContents = new Dictionary<string, ToolCallExtraContent>();
        var startedToolKeys = new HashSet<string>();
        string? lastGoogleThinkingSignature = null;

        static string GetToolKey(OpenAiToolCallDelta toolCall)
        {
            if (!string.IsNullOrWhiteSpace(toolCall.Id))
                return $"id:{toolCall.Id}";

            if (toolCall.Index.HasValue)
                return $"index:{toolCall.Index.Value}";

            return $"synthetic:{Guid.NewGuid():N}";
        }
        var isOpenAi = baseUrl.StartsWith("https://api.openai.com", StringComparison.OrdinalIgnoreCase)
            || baseUrl.StartsWith("http://api.openai.com", StringComparison.OrdinalIgnoreCase);
        using var streamCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Timer? compatTerminalTimer = null;
        var compatTerminalTimeoutTriggered = false;

        void ClearCompatTerminalTimer()
        {
            compatTerminalTimer?.Dispose();
            compatTerminalTimer = null;
            compatTerminalTimeoutTriggered = false;
        }

        void ScheduleCompatTerminalClose()
        {
            if (isOpenAi || compatTerminalTimer is not null)
                return;

            compatTerminalTimer = new Timer(_ =>
            {
                compatTerminalTimeoutTriggered = true;
                try
                {
                    streamCts.Cancel();
                }
                catch
                {
                }
            }, null, 1500, Timeout.Infinite);
        }

        await using var chunkEnumerator = SseStreamReader.ReadAsync<OpenAiChatChunk>(
            stream,
            static (eventType, data) =>
            {
                if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                    return null;

                return JsonSerializer.Deserialize(data,
                    AppJsonContext.Default.OpenAiChatChunk);
            },
            streamCts.Token).GetAsyncEnumerator();

        async Task<OpenAiChatChunk?> ReadNextChunkAsync()
        {
            try
            {
                if (!await chunkEnumerator.MoveNextAsync())
                    return null;

                return chunkEnumerator.Current;
            }
            catch (OperationCanceledException) when (compatTerminalTimeoutTriggered && !ct.IsCancellationRequested)
            {
                return null;
            }
        }

        try
        {
            while (true)
            {
                var chunk = await ReadNextChunkAsync();
                if (chunk is null)
                    break;

                ClearCompatTerminalTimer();

                if (chunk.Usage is not null)
                {
                    outputTokens = chunk.Usage.CompletionTokens ?? outputTokens;
                }

                if (chunk.Choices is null || chunk.Choices.Count == 0)
                {
                    if (chunk.Usage is not null && !emittedMessageEnd)
                    {
                        var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        emittedMessageEnd = true;
                        yield return new StreamEvent
                        {
                            Type = "message_end",
                            Usage = CreateTokenUsage(chunk.Usage),
                            Timing = CreateTiming(requestStartedAt, firstTokenAt, outputTokens, completedAt)
                        };
                    }
                    continue;
                }

                var choice = chunk.Choices[0];
                var delta = choice.Delta;

                if (delta is not null)
                {
                    if (delta.Content is not null)
                    {
                        firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        yield return new StreamEvent { Type = "text_delta", Text = delta.Content };
                    }

                    if (delta.ReasoningContent is not null)
                    {
                        firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        yield return new StreamEvent { Type = "thinking_delta", Thinking = delta.ReasoningContent };
                    }

                    if (!string.IsNullOrWhiteSpace(delta.ReasoningEncryptedContent)
                        && delta.ReasoningEncryptedContent != lastGoogleThinkingSignature)
                    {
                        lastGoogleThinkingSignature = delta.ReasoningEncryptedContent;
                        yield return new StreamEvent
                        {
                            Type = "thinking_encrypted",
                            ThinkingEncryptedContent = delta.ReasoningEncryptedContent,
                            ThinkingEncryptedProvider = "google"
                        };
                    }

                    if (delta.ToolCalls is not null)
                    {
                        foreach (var tc in delta.ToolCalls)
                        {
                            firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            var toolKey = GetToolKey(tc);

                            if (!toolArgs.ContainsKey(toolKey))
                                toolArgs[toolKey] = new StringBuilder();
                            if (!toolNames.ContainsKey(toolKey))
                                toolNames[toolKey] = string.Empty;

                            var extraContent = tc.ExtraContent ?? (tc.ExtraContent is null && !string.IsNullOrWhiteSpace(lastGoogleThinkingSignature)
                                ? new ToolCallExtraContent
                                {
                                    Google = new GoogleToolCallExtraContent
                                    {
                                        ThoughtSignature = lastGoogleThinkingSignature
                                    }
                                }
                                : null);

                            if (extraContent is not null)
                            {
                                toolExtraContents[toolKey] = extraContent;
                                if (extraContent.Google?.ThoughtSignature is { Length: > 0 } thoughtSignature
                                    && thoughtSignature != lastGoogleThinkingSignature)
                                {
                                    lastGoogleThinkingSignature = thoughtSignature;
                                    yield return new StreamEvent
                                    {
                                        Type = "thinking_encrypted",
                                        ThinkingEncryptedContent = thoughtSignature,
                                        ThinkingEncryptedProvider = "google"
                                    };
                                }
                            }

                            if (!string.IsNullOrWhiteSpace(tc.Function?.Name))
                                toolNames[toolKey] = tc.Function.Name;

                            if (!string.IsNullOrWhiteSpace(tc.Id))
                                toolIds[toolKey] = tc.Id;

                            if (toolIds.TryGetValue(toolKey, out var toolId)
                                && !startedToolKeys.Contains(toolKey))
                            {
                                startedToolKeys.Add(toolKey);
                                yield return new StreamEvent
                                {
                                    Type = "tool_call_start",
                                    ToolCallId = toolId,
                                    ToolName = toolNames.GetValueOrDefault(toolKey),
                                    ToolCallExtraContent = toolExtraContents.GetValueOrDefault(toolKey)
                                };
                            }

                            if (tc.Function?.Arguments is not null)
                            {
                                if (!toolIds.TryGetValue(toolKey, out toolId))
                                    continue;

                                toolArgs[toolKey].Append(tc.Function.Arguments);
                                yield return new StreamEvent
                                {
                                    Type = "tool_call_delta",
                                    ToolCallId = toolId,
                                    ArgumentsDelta = tc.Function.Arguments
                                };
                            }
                        }
                    }
                }

                var finishReason = choice.FinishReason;
                if (finishReason is null)
                    continue;

                if ((finishReason == "tool_calls" || finishReason == "function_call") && toolIds.Count > 0)
                {
                    foreach (var (toolKey, id) in toolIds)
                    {
                        yield return CreateToolCallEndEvent(toolKey, id, toolNames, toolArgs, toolExtraContents);
                    }
                    toolIds.Clear();
                    toolNames.Clear();
                    toolArgs.Clear();
                    toolExtraContents.Clear();
                    startedToolKeys.Clear();

                    if (chunk.Usage is null)
                        ScheduleCompatTerminalClose();
                    else
                        break;
                }
                else if (finishReason != "tool_calls" && finishReason != "function_call" && toolIds.Count > 0)
                {
                    foreach (var (toolKey, id) in toolIds)
                    {
                        yield return CreateToolCallEndEvent(toolKey, id, toolNames, toolArgs, toolExtraContents);
                    }
                    toolIds.Clear();
                    toolNames.Clear();
                    toolArgs.Clear();
                    toolExtraContents.Clear();
                    startedToolKeys.Clear();

                    if (!emittedMessageEnd)
                    {
                        var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        emittedMessageEnd = true;
                        yield return new StreamEvent
                        {
                            Type = "message_end",
                            StopReason = finishReason,
                            Usage = chunk.Usage is not null ? CreateTokenUsage(chunk.Usage) : null,
                            Timing = CreateTiming(requestStartedAt, firstTokenAt, outputTokens, completedAt)
                        };
                    }

                    if (!isOpenAi && chunk.Usage is null)
                        ScheduleCompatTerminalClose();
                    else if (!isOpenAi)
                        break;
                }
                else if (!emittedMessageEnd && finishReason == "stop")
                {
                    var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    emittedMessageEnd = true;
                    yield return new StreamEvent
                    {
                        Type = "message_end",
                        StopReason = finishReason,
                        Usage = chunk.Usage is not null ? CreateTokenUsage(chunk.Usage) : null,
                        Timing = CreateTiming(requestStartedAt, firstTokenAt, outputTokens, completedAt)
                    };

                    if (!isOpenAi && chunk.Usage is null)
                        ScheduleCompatTerminalClose();
                    else if (!isOpenAi)
                        break;
                }
                else if (!isOpenAi && (finishReason == "length" || finishReason == "content_filter"))
                {
                    if (chunk.Usage is null)
                        ScheduleCompatTerminalClose();
                    else
                        break;
                }
            }
        }
        finally
        {
            ClearCompatTerminalTimer();
        }

        if (toolIds.Count > 0)
        {
            foreach (var (toolKey, id) in toolIds)
            {
                yield return CreateToolCallEndEvent(toolKey, id, toolNames, toolArgs, toolExtraContents);
            }
        }
    }

    private static StreamEvent CreateToolCallEndEvent(
        string toolKey,
        string id,
        Dictionary<string, string> toolNames,
        Dictionary<string, StringBuilder> toolArgs,
        Dictionary<string, ToolCallExtraContent> toolExtraContents)
    {
        var raw = toolArgs.GetValueOrDefault(toolKey)?.ToString()?.Trim() ?? string.Empty;
        var input = ProviderMessageFormatter.ParseToolInputObject(raw);

        return new StreamEvent
        {
            Type = "tool_call_end",
            ToolCallId = id,
            ToolName = toolNames.GetValueOrDefault(toolKey),
            ToolCallInput = input,
            ToolCallExtraContent = toolExtraContents.GetValueOrDefault(toolKey)
        };
    }

    private static TokenUsage CreateTokenUsage(OpenAiUsage usage)
    {
        return new TokenUsage
        {
            InputTokens = usage.PromptTokens ?? 0,
            OutputTokens = usage.CompletionTokens ?? 0,
            ReasoningTokens = usage.CompletionTokensDetails?.ReasoningTokens
        };
    }

    private static RequestTiming CreateTiming(long requestStartedAt, long? firstTokenAt, int outputTokens, long completedAt)
    {
        return new RequestTiming
        {
            TotalMs = completedAt - requestStartedAt,
            TtftMs = firstTokenAt.HasValue ? firstTokenAt.Value - requestStartedAt : null,
            Tps = ComputeTps(outputTokens, firstTokenAt, completedAt)
        };
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenAt, long completedAt)
    {
        if (!firstTokenAt.HasValue || outputTokens <= 0)
            return null;

        var durationMs = completedAt - firstTokenAt.Value;
        if (durationMs <= 0)
            return null;

        return outputTokens / (durationMs / 1000.0);
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

    private static byte[] BuildRequestBody(
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        ProviderConfig config)
    {
        var body = new JsonObject
        {
            ["model"] = config.Model,
            ["messages"] = ProviderMessageFormatter.FormatOpenAiChatMessages(messages, config.SystemPrompt, config),
            ["stream"] = true,
            ["stream_options"] = new JsonObject { ["include_usage"] = true }
        };

        if (config.EnablePromptCache != false)
        {
            var cacheKey = !string.IsNullOrWhiteSpace(config.PromptCacheKey)
                ? config.PromptCacheKey
                : !string.IsNullOrWhiteSpace(config.SessionId)
                    ? config.SessionId
                    : "open-cowork";
            body["prompt_cache_key"] = cacheKey;
        }

        if (tools.Count > 0)
        {
            var toolsArr = new JsonArray();
            foreach (var t in tools)
            {
                toolsArr.Add(new JsonObject
                {
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = t.Name,
                        ["description"] = t.Description,
                        ["parameters"] = ProviderMessageFormatter.NormalizeToolSchema(t.InputSchema, sanitizeForGemini: false)
                    }
                });
            }
            body["tools"] = toolsArr;
            body["tool_choice"] = "auto";
        }

        if (config.Temperature is not null)
            body["temperature"] = config.Temperature;
        if (config.ServiceTier is not null)
            body["service_tier"] = config.ServiceTier;
        if (config.MaxTokens is not null)
        {
            var isReasoningModel = config.Model.StartsWith("o", StringComparison.OrdinalIgnoreCase)
                && config.Model.Length > 1
                && char.IsDigit(config.Model[1]);
            body[isReasoningModel ? "max_completion_tokens" : "max_tokens"] = config.MaxTokens;
        }

        if (config.ThinkingEnabled == true && config.ThinkingConfig is not null)
        {
            foreach (var (key, value) in config.ThinkingConfig.BodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());

            if (config.ThinkingConfig.ReasoningEffortLevels?.Count > 0 && !string.IsNullOrWhiteSpace(config.ReasoningEffort))
                body["reasoning_effort"] = config.ReasoningEffort;

            if (config.ThinkingConfig.ForceTemperature is not null)
                body["temperature"] = config.ThinkingConfig.ForceTemperature;
        }
        else if (config.ThinkingEnabled != true && config.ThinkingConfig?.DisabledBodyParams is { Count: > 0 } disabledBodyParams)
        {
            foreach (var (key, value) in disabledBodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());
        }

        ProviderMessageFormatter.ApplyRequestOverrides(body, config);
        using var ms = new System.IO.MemoryStream();
        using (var w = new System.Text.Json.Utf8JsonWriter(ms))
        { body.WriteTo(w); }
        return ms.ToArray();
    }
}
