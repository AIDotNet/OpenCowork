using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class GeminiProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    public string Name => "Google Gemini";
    public string Type => "gemini";

    public GeminiProvider(LlmHttpClientFactory httpFactory)
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
        var emittedMessageEnd = false;

        var baseUrl = ResolveGeminiApiRoot(config.BaseUrl);
        var url = $"{baseUrl}/models/{Uri.EscapeDataString(config.Model)}:streamGenerateContent";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["x-goog-api-key"] = config.ApiKey
        };

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

        yield return new StreamEvent { Type = "message_start" };

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
        var outputTokens = 0;
        GeminiUsageMetadata? usageMetadata = null;
        string? pendingStopReason = null;
        var emittedThinkingEncrypted = new HashSet<string>(StringComparer.Ordinal);
        var emittedToolCalls = new HashSet<string>(StringComparer.Ordinal);

        try
        {
            await foreach (var chunk in SseStreamReader.ReadAsync<GeminiStreamChunk>(
                stream,
                static (eventType, data) =>
                {
                    if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                        return null;

                    return JsonSerializer.Deserialize(data,
                        AppJsonContext.Default.GeminiStreamChunk);
                },
                ct))
            {
                usageMetadata = chunk.UsageMetadata ?? usageMetadata;

                foreach (var candidate in chunk.Candidates ?? [])
                {
                    pendingStopReason = candidate.FinishReason ?? candidate.FinishReasonCompat ?? pendingStopReason;
                    var parts = candidate.Content?.Parts;
                    if (parts is null)
                        continue;

                    foreach (var part in parts)
                    {
                        var thoughtSignature = (part.ThoughtSignature ?? part.ThoughtSignatureCompat)?.Trim();
                        if (!string.IsNullOrWhiteSpace(thoughtSignature) && emittedThinkingEncrypted.Add(thoughtSignature))
                        {
                            yield return new StreamEvent
                            {
                                Type = "thinking_encrypted",
                                ThinkingEncryptedContent = thoughtSignature,
                                ThinkingEncryptedProvider = "google"
                            };
                        }

                        if (part.Text is not null)
                        {
                            firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                            if (part.Thought == true)
                            {
                                yield return new StreamEvent
                                {
                                    Type = "thinking_delta",
                                    Thinking = part.Text
                                };
                            }
                            else
                            {
                                yield return new StreamEvent
                                {
                                    Type = "text_delta",
                                    Text = part.Text
                                };
                            }
                        }

                        var functionCall = part.FunctionCall ?? part.FunctionCallCompat;
                        if (functionCall is not null && !string.IsNullOrWhiteSpace(functionCall.Name))
                        {
                            firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                            var args = functionCall.Args ?? new Dictionary<string, JsonElement>();
                            var callId = $"{functionCall.Name}:{JsonSerializer.Serialize(args, AppJsonContext.Default.DictionaryStringJsonElement)}";
                            if (!emittedToolCalls.Add(callId))
                                continue;

                            var extraContent = !string.IsNullOrWhiteSpace(thoughtSignature)
                                ? new ToolCallExtraContent
                                {
                                    Google = new GoogleToolCallExtraContent
                                    {
                                        ThoughtSignature = thoughtSignature
                                    }
                                }
                                : null;
                            var argumentsDelta = JsonSerializer.Serialize(args, AppJsonContext.Default.DictionaryStringJsonElement);

                            yield return new StreamEvent
                            {
                                Type = "tool_call_start",
                                ToolCallId = callId,
                                ToolName = functionCall.Name,
                                ToolCallExtraContent = extraContent
                            };

                            yield return new StreamEvent
                            {
                                Type = "tool_call_delta",
                                ToolCallId = callId,
                                ArgumentsDelta = argumentsDelta
                            };

                            yield return new StreamEvent
                            {
                                Type = "tool_call_end",
                                ToolCallId = callId,
                                ToolName = functionCall.Name,
                                ToolCallInput = args,
                                ToolCallExtraContent = extraContent
                            };
                        }
                    }
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

        if (!emittedMessageEnd)
        {
            var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var promptTokenCount = usageMetadata?.PromptTokenCount ?? 0;
            outputTokens = usageMetadata?.CandidatesTokenCount
                ?? Math.Max((usageMetadata?.TotalTokenCount ?? 0) - promptTokenCount, 0);

            yield return new StreamEvent
            {
                Type = "message_end",
                StopReason = pendingStopReason ?? "stop",
                Usage = usageMetadata is not null
                    ? new TokenUsage
                    {
                        InputTokens = promptTokenCount,
                        OutputTokens = outputTokens,
                        ReasoningTokens = usageMetadata.ThoughtsTokenCount
                    }
                    : null,
                Timing = new RequestTiming
                {
                    TotalMs = completedAt - requestStartedAt,
                    TtftMs = firstTokenAt.HasValue ? firstTokenAt.Value - requestStartedAt : null,
                    Tps = ComputeTps(outputTokens, firstTokenAt, completedAt)
                }
            };
        }
    }

    private static RequestDebugInfo CreateRequestDebugInfo(string url, string method, Dictionary<string, string> headers, byte[] bodyBytes, ProviderConfig config)
    {
        return new RequestDebugInfo
        {
            Url = url,
            Method = method,
            Headers = new Dictionary<string, string>(headers),
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
            ["contents"] = ProviderMessageFormatter.FormatGeminiMessages(messages)
        };

        var systemPrompt = config.SystemPrompt ?? messages.FirstOrDefault(m => m.Role == "system")?.GetTextContent();
        if (!string.IsNullOrWhiteSpace(systemPrompt))
        {
            body["systemInstruction"] = new JsonObject
            {
                ["parts"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["text"] = systemPrompt.Trim()
                    }
                }
            };
        }

        if (tools.Count > 0)
        {
            var funcDecls = new JsonArray();
            foreach (var t in tools)
            {
                funcDecls.Add(new JsonObject
                {
                    ["name"] = t.Name,
                    ["description"] = t.Description,
                    ["parameters"] = ProviderMessageFormatter.NormalizeToolSchema(t.InputSchema, sanitizeForGemini: true)
                });
            }
            body["tools"] = new JsonArray
            {
                new JsonObject { ["functionDeclarations"] = funcDecls }
            };
        }

        var generationConfig = new JsonObject();
        if (config.Temperature.HasValue)
            generationConfig["temperature"] = config.Temperature.Value;
        if (config.MaxTokens is not null)
            generationConfig["maxOutputTokens"] = config.MaxTokens.Value;
        if (generationConfig.Count > 0)
            body["generationConfig"] = generationConfig;

        if (config.ThinkingEnabled == true && config.ThinkingConfig is not null)
        {
            foreach (var (key, value) in config.ThinkingConfig.BodyParams)
                body[key] = JsonNode.Parse(value.GetRawText());
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

    private static string ResolveGeminiApiRoot(string? baseUrl)
    {
        return (baseUrl ?? "https://generativelanguage.googleapis.com/v1beta")
            .Trim()
            .TrimEnd('/')
            .Replace("/openai", string.Empty, StringComparison.OrdinalIgnoreCase);
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
