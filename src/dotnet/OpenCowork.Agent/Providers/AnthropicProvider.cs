using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class AnthropicProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    public string Name => "Anthropic Messages";
    public string Type => "anthropic";

    public AnthropicProvider(LlmHttpClientFactory httpFactory)
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
        var promptCacheEnabled = config.EnablePromptCache != false;
        var systemPromptCacheEnabled = promptCacheEnabled || config.EnableSystemPromptCache == true;

        var baseUrl = (config.BaseUrl ?? "https://api.anthropic.com").TrimEnd('/');
        var url = $"{baseUrl}/v1/messages";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["x-api-key"] = config.ApiKey,
            ["anthropic-version"] = "2023-06-01",
            ["anthropic-beta"] = "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14"
        };
        if (config.UserAgent is not null)
            headers["User-Agent"] = config.UserAgent;

        ProviderMessageFormatter.ApplyHeaderOverrides(headers, config);
        var bodyBytes = BuildRequestBody(messages, tools, config);

        yield return new StreamEvent
        {
            Type = "request_debug",
            DebugInfo = CreateRequestDebugInfo(url, "POST", headers, bodyBytes, config)
        };

        var client = _httpFactory.GetClient(allowInsecureTls: config.AllowInsecureTls ?? true);
        var circuitKey = SseStreamReader.BuildTransportCircuitKey(
            config.ProviderBuiltinId ?? config.Type,
            baseUrl);

        HttpRequestException? transportError = null;
        HttpResponseMessage? response = null;
        try
        {
            response = await SseStreamReader.SendStreamingRequestAsync(
                client,
                url,
                "POST",
                headers,
                bodyBytes,
                ct,
                circuitKey);
        }
        catch (HttpRequestException ex) when (!ct.IsCancellationRequested)
        {
            transportError = ex;
        }

        if (transportError is not null)
        {
            yield return new StreamEvent
            {
                Type = "error",
                Error = SseStreamReader.CreateTransportError(transportError)
            };
            yield break;
        }

        using var ownedResponse = response!;

        if (!ownedResponse.IsSuccessStatusCode)
        {
            var errorBody = await ownedResponse.Content.ReadAsStringAsync(ct);
            yield return new StreamEvent
            {
                Type = "error",
                Error = new StreamEventError
                {
                    Type = $"http_{(int)ownedResponse.StatusCode}",
                    Message = $"HTTP {(int)ownedResponse.StatusCode}: {errorBody[..Math.Min(2000, errorBody.Length)]}"
                }
            };
            yield break;
        }

        await using var stream = await ownedResponse.Content.ReadAsStreamAsync(ct);

        // Zero-copy SSE parsing: SseItemParser receives ReadOnlySpan<byte>
        var pendingUsage = new TokenUsage { InputTokens = 0, OutputTokens = 0 };
        var toolBuffers = new Dictionary<int, StringBuilder>();
        var toolCalls = new Dictionary<int, (string Id, string Name)>();
        var emittedThinkingEncrypted = new HashSet<string>(StringComparer.Ordinal);

        try
        {
            await foreach (var payload in SseStreamReader.ReadAsync<AnthropicSsePayload>(
                stream,
                static (eventType, data) =>
                {
                    if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                        return null;

                    return JsonSerializer.Deserialize(data,
                        AppJsonContext.Default.AnthropicSsePayload);
                },
                ct))
            {
                switch (payload.Type)
                {
                    case "message_start":
                        var msgUsage = payload.Message?.Usage;
                        if (msgUsage is not null)
                        {
                            pendingUsage.InputTokens = msgUsage.InputTokens ?? 0;
                            pendingUsage.ContextTokens = pendingUsage.InputTokens;

                            if (msgUsage.CacheCreation?.Ephemeral5mInputTokens is { } cacheCreation5mTokens
                                || msgUsage.CacheCreation?.Ephemeral1hInputTokens is { } cacheCreation1hTokens)
                            {
                                var totalCacheCreationTokens = (msgUsage.CacheCreation?.Ephemeral5mInputTokens ?? 0)
                                    + (msgUsage.CacheCreation?.Ephemeral1hInputTokens ?? 0);
                                pendingUsage.CacheCreationTokens = totalCacheCreationTokens > 0 ? totalCacheCreationTokens : null;
                            }
                            else if (msgUsage.CacheCreationInputTokens.HasValue)
                            {
                                pendingUsage.CacheCreationTokens = msgUsage.CacheCreationInputTokens;
                            }

                            if (msgUsage.CacheReadInputTokens.HasValue)
                                pendingUsage.CacheReadTokens = msgUsage.CacheReadInputTokens;

                            var billableInputTokens = pendingUsage.InputTokens - (pendingUsage.CacheReadTokens ?? 0);
                            pendingUsage.BillableInputTokens = billableInputTokens >= 0 ? billableInputTokens : 0;
                        }
                        break;

                    case "content_block_start":
                    {
                        var idx = payload.Index ?? -1;
                        var block = payload.ContentBlock;
                        if (block?.Type == "tool_use" && idx >= 0)
                        {
                            toolBuffers[idx] = new StringBuilder();
                            toolCalls[idx] = (block.Id ?? "", block.Name ?? "");
                            yield return new StreamEvent
                            {
                                Type = "tool_call_start",
                                ToolCallId = block.Id,
                                ToolName = block.Name
                            };
                        }
                        else if (block?.Type == "thinking")
                        {
                            var sig = (block.Signature ?? block.EncryptedContent)?.Trim();
                            if (!string.IsNullOrWhiteSpace(sig) && emittedThinkingEncrypted.Add(sig))
                            {
                                yield return new StreamEvent
                                {
                                    Type = "thinking_encrypted",
                                    ThinkingEncryptedContent = sig,
                                    ThinkingEncryptedProvider = "anthropic"
                                };
                            }
                        }
                        break;
                    }

                    case "content_block_delta":
                    {
                        firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        var idx = payload.Index ?? -1;
                        var delta = payload.Delta;

                        if (delta?.Type == "text_delta")
                        {
                            yield return new StreamEvent { Type = "text_delta", Text = delta.Text };
                        }
                        else if (delta?.Type == "thinking_delta")
                        {
                            yield return new StreamEvent { Type = "thinking_delta", Thinking = delta.Thinking };
                        }
                        else if (delta?.Type == "signature_delta")
                        {
                            var sig = (delta.Signature ?? delta.EncryptedContent)?.Trim();
                            if (!string.IsNullOrWhiteSpace(sig) && emittedThinkingEncrypted.Add(sig))
                            {
                                yield return new StreamEvent
                                {
                                    Type = "thinking_encrypted",
                                    ThinkingEncryptedContent = sig,
                                    ThinkingEncryptedProvider = "anthropic"
                                };
                            }
                        }
                        else if (delta?.Type == "input_json_delta" && idx >= 0)
                        {
                            if (toolBuffers.TryGetValue(idx, out var buf))
                            {
                                buf.Append(delta.PartialJson);

                                var tc = toolCalls.GetValueOrDefault(idx);
                                yield return new StreamEvent
                                {
                                    Type = "tool_call_delta",
                                    ToolCallId = tc.Id,
                                    ArgumentsDelta = delta.PartialJson
                                };
                            }
                        }
                        break;
                    }

                    case "content_block_stop":
                    {
                        var idx = payload.Index ?? -1;
                        if (toolCalls.TryGetValue(idx, out var tc))
                        {
                            var raw = toolBuffers.GetValueOrDefault(idx)?.ToString()?.Trim() ?? "";
                            var input = ProviderMessageFormatter.ParseToolInputObject(raw);

                            yield return new StreamEvent
                            {
                                Type = "tool_call_end",
                                ToolCallId = tc.Id,
                                ToolName = tc.Name,
                                ToolCallInput = input
                            };

                            toolBuffers.Remove(idx);
                            toolCalls.Remove(idx);
                        }
                        break;
                    }

                    case "message_delta":
                    {
                        var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        if (payload.Usage?.OutputTokens is { } outTok)
                        {
                            pendingUsage.OutputTokens = outTok;
                            outputTokens = outTok;
                        }

                        yield return new StreamEvent
                        {
                            Type = "message_end",
                            StopReason = payload.Delta?.StopReason,
                            Usage = new TokenUsage
                            {
                                InputTokens = pendingUsage.InputTokens,
                                OutputTokens = pendingUsage.OutputTokens,
                                BillableInputTokens = pendingUsage.BillableInputTokens,
                                CacheCreationTokens = pendingUsage.CacheCreationTokens,
                                CacheReadTokens = pendingUsage.CacheReadTokens,
                                ContextTokens = pendingUsage.ContextTokens
                            },
                            Timing = new RequestTiming
                            {
                                TotalMs = completedAt - requestStartedAt,
                                TtftMs = firstTokenAt.HasValue ? firstTokenAt.Value - requestStartedAt : null,
                                Tps = ComputeTps(outputTokens, firstTokenAt, completedAt)
                            }
                        };
                        break;
                    }

                    case "error":
                        yield return new StreamEvent
                        {
                            Type = "error",
                            Error = payload.Error is not null
                                ? new StreamEventError { Type = payload.Error.Type, Message = payload.Error.Message }
                                : null
                        };
                        break;
                }
            }
        }
        catch (Exception ex) when (!ct.IsCancellationRequested && SseStreamReader.IsRetryableTransportFailure(ex))
        {
            var transportReadError = SseStreamReader.RememberRetryableTransportFailure(circuitKey, ex);
            yield return new StreamEvent
            {
                Type = "error",
                Error = SseStreamReader.CreateTransportError(transportReadError)
            };
            yield break;
        }
    }

    private static RequestDebugInfo CreateRequestDebugInfo(string url, string method, Dictionary<string, string> headers, byte[] bodyBytes, ProviderConfig config)
    {
        var maskedHeaders = headers.ToDictionary(
            static pair => pair.Key,
            pair => pair.Key.Equals("x-api-key", StringComparison.OrdinalIgnoreCase)
                ? "***"
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
        var promptCacheEnabled = config.EnablePromptCache != false;
        var systemPromptCacheEnabled = promptCacheEnabled || config.EnableSystemPromptCache == true;
        var maxTokens = ResolveAnthropicMaxTokens(config);
        var body = new JsonObject
        {
            ["model"] = config.Model,
            ["max_tokens"] = maxTokens,
            ["stream"] = true,
            ["messages"] = ProviderMessageFormatter.FormatAnthropicMessages(messages, promptCacheEnabled)
        };

        if (promptCacheEnabled)
            body["cache_control"] = new JsonObject { ["type"] = "ephemeral" };

        if (config.SystemPrompt is not null)
        {
            body["system"] = new JsonArray
            {
                new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = config.SystemPrompt,
                    ["cache_control"] = systemPromptCacheEnabled
                        ? new JsonObject { ["type"] = "ephemeral" }
                        : null
                }
            };
        }

        if (config.Temperature.HasValue)
            body["temperature"] = config.Temperature.Value;

        if (config.ThinkingEnabled == true && config.ThinkingConfig is not null)
        {
            foreach (var (key, value) in config.ThinkingConfig.BodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());

            var effort = ResolveAnthropicEffort(config);
            if (!string.IsNullOrWhiteSpace(effort))
            {
                var outputConfig = body["output_config"] as JsonObject ?? new JsonObject();
                outputConfig["effort"] = effort;
                body["output_config"] = outputConfig;
            }

            if (config.ThinkingConfig.ForceTemperature is not null)
                body["temperature"] = config.ThinkingConfig.ForceTemperature;
        }
        else if (config.ThinkingEnabled != true && config.ThinkingConfig?.DisabledBodyParams is { Count: > 0 } disabledBodyParams)
        {
            foreach (var (key, value) in disabledBodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());
        }

        if (tools.Count > 0)
        {
            var toolsArr = new JsonArray();
            for (var index = 0; index < tools.Count; index++)
            {
                var t = tools[index];
                toolsArr.Add(new JsonObject
                {
                    ["name"] = t.Name,
                    ["description"] = t.Description,
                    ["input_schema"] = ProviderMessageFormatter.NormalizeToolSchema(t.InputSchema, sanitizeForGemini: false),
                    ["cache_control"] = promptCacheEnabled && index == tools.Count - 1
                        ? new JsonObject { ["type"] = "ephemeral" }
                        : null
                });
            }
            body["tools"] = toolsArr;
            body["tool_choice"] = new JsonObject { ["type"] = "auto" };
        }

        ProviderMessageFormatter.ApplyRequestOverrides(body, config);
        NormalizeAnthropicThinkingRequest(body);

        // Serialize directly to pooled buffer — avoids intermediate string from ToJsonString()
        using var bufferWriter = new System.IO.MemoryStream();
        using (var writer = new Utf8JsonWriter(bufferWriter))
        {
            body.WriteTo(writer);
        }
        return bufferWriter.ToArray();
    }

    private static int ResolveAnthropicMaxTokens(ProviderConfig config)
    {
        var configuredMaxTokens = config.MaxTokens ?? 32000;
        if (config.ThinkingEnabled != true || config.ThinkingConfig is null)
            return configuredMaxTokens;

        if (!TryGetThinkingBudgetTokens(config.ThinkingConfig, out var budgetTokens))
            return configuredMaxTokens;

        return Math.Max(configuredMaxTokens, budgetTokens + 1);
    }

    private static bool TryGetThinkingBudgetTokens(ThinkingConfig config, out int budgetTokens)
    {
        budgetTokens = 0;

        if (!config.BodyParams.TryGetValue("thinking", out var thinkingNode)
            || thinkingNode.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!thinkingNode.TryGetProperty("budget_tokens", out var budgetNode))
            return false;

        return budgetNode.ValueKind switch
        {
            JsonValueKind.Number => budgetNode.TryGetInt32(out budgetTokens),
            JsonValueKind.String => int.TryParse(budgetNode.GetString(), out budgetTokens),
            _ => false
        };
    }

    private static void NormalizeAnthropicThinkingRequest(JsonObject body)
    {
        if (body["thinking"] is not JsonObject thinking)
            return;

        if (!TryReadBudgetTokens(thinking["budget_tokens"], out var budgetTokens))
            return;

        var configuredMaxTokens = body["max_tokens"] switch
        {
            JsonValue value when value.TryGetValue<int>(out var intValue) => intValue,
            JsonValue value when value.TryGetValue<string>(out var strValue) && int.TryParse(strValue, out var parsed) => parsed,
            _ => 0
        };

        var normalizedMaxTokens = Math.Max(Math.Max(configuredMaxTokens, 1), budgetTokens + 1);
        body["max_tokens"] = normalizedMaxTokens;
    }

    private static bool TryReadBudgetTokens(JsonNode? node, out int budgetTokens)
    {
        budgetTokens = 0;
        return node switch
        {
            JsonValue value when value.TryGetValue<int>(out budgetTokens) => true,
            JsonValue value when value.TryGetValue<string>(out var strValue) && int.TryParse(strValue, out budgetTokens) => true,
            _ => false
        };
    }

    private static string? ResolveAnthropicEffort(ProviderConfig config)
    {
        var levels = config.ThinkingConfig?.ReasoningEffortLevels;
        if (levels is null || levels.Count == 0)
            return null;

        var selected = !string.IsNullOrWhiteSpace(config.ReasoningEffort) && levels.Contains(config.ReasoningEffort)
            ? config.ReasoningEffort
            : config.ThinkingConfig?.DefaultReasoningEffort ?? levels[0];

        return selected switch
        {
            "low" => "low",
            "medium" => "medium",
            "high" => "high",
            "max" => "max",
            "xhigh" => "max",
            _ => null
        };
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenAt, long completedAt)
    {
        if (firstTokenAt is null || outputTokens <= 0)
            return null;

        var durationMs = completedAt - firstTokenAt.Value;
        if (durationMs <= 0)
            return null;

        return outputTokens / (durationMs / 1000.0);
    }
}
