using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeGeminiProvider
{
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create();
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<AgentRuntimeProviderTurnResult> ExecuteTurnAsync(
        JsonElement parameters,
        JsonElement provider,
        List<AgentRuntimeChatMessage> conversation,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var providerType = JsonHelpers.GetString(provider, "type") ?? "gemini";
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        var url = BuildApiUrl(providerType, JsonHelpers.GetString(provider, "baseUrl"), model, stream: true);
        var body = BuildRequestBody(parameters, provider, conversation);

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "request_debug",
                DebugInfo: new AgentRuntimeRequestDebugInfo(
                    url,
                    "POST",
                    BuildDebugHeaders(provider),
                    AgentRuntimeDebugPayload.PrepareBody(body, parameters),
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    JsonHelpers.GetString(provider, "providerId"),
                    JsonHelpers.GetString(provider, "providerBuiltinId"),
                    model)));

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider);

        var startedAt = Stopwatch.GetTimestamp();
        var parseState = new GeminiParseState();
        WorkerLog.Debug($"gemini request start provider={providerType} model={model} url={url}");

        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(state.CancellationToken);
            throw new InvalidOperationException(
                $"Gemini request failed HTTP {(int)response.StatusCode}: {errorBody}");
        }

        await using var responseStream = await response.Content.ReadAsStreamAsync(state.CancellationToken);
        using var reader = new StreamReader(responseStream, Encoding.UTF8);
        var dataBuilder = new StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync(state.CancellationToken)) is not null)
        {
            if (line.Length == 0)
            {
                if (dataBuilder.Length > 0)
                {
                    var data = dataBuilder.ToString();
                    dataBuilder.Clear();
                    if (data != "[DONE]")
                    {
                        await ProcessJsonEventAsync(data, parseState, state, context, startedAt);
                    }
                }
                continue;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (dataBuilder.Length > 0)
                {
                    dataBuilder.Append('\n');
                }
                dataBuilder.Append(line[5..].TrimStart());
                continue;
            }

            if (LooksLikeJson(line))
            {
                await ProcessJsonEventAsync(line, parseState, state, context, startedAt);
            }
        }

        if (dataBuilder.Length > 0)
        {
            await ProcessJsonEventAsync(dataBuilder.ToString(), parseState, state, context, startedAt);
        }

        var totalMs = ElapsedMs(startedAt);
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "message_end",
                StopReason: parseState.StopReason,
                Usage: parseState.Usage,
                Timing: new AgentRuntimeRequestTiming(
                    totalMs,
                    parseState.FirstTokenMs,
                    ComputeTps(parseState.Usage?.OutputTokens ?? parseState.EstimatedOutputTokens, parseState.FirstTokenMs, totalMs))));

        return new AgentRuntimeProviderTurnResult(
            new AgentRuntimeChatMessage(
                "assistant",
                parseState.AssistantText.ToString(),
                parseState.ToolCalls
                    .Select(call => new AgentRuntimeChatToolUse(call.Id, call.Name, call.Input))
                    .ToList(),
                []),
            parseState.ToolCalls,
            parseState.StopReason,
            parseState.Usage);
    }

    private static async Task ProcessJsonEventAsync(
        string data,
        GeminiParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        using var document = JsonDocument.Parse(data);
        var root = document.RootElement;

        if (root.TryGetProperty("usageMetadata", out var usage))
        {
            parseState.Usage = ReadUsage(usage);
        }

        if (!root.TryGetProperty("candidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var candidate in candidates.EnumerateArray())
        {
            parseState.StopReason = JsonHelpers.GetString(candidate, "finishReason") ??
                JsonHelpers.GetString(candidate, "finish_reason") ??
                parseState.StopReason;

            if (!candidate.TryGetProperty("content", out var content) ||
                !content.TryGetProperty("parts", out var parts) ||
                parts.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var part in parts.EnumerateArray())
            {
                TryEmitThinkingEncrypted(part, parseState, state, context);

                if (JsonHelpers.GetString(part, "text") is { Length: > 0 } text)
                {
                    parseState.FirstTokenMs ??= ElapsedMs(startedAt);
                    if (JsonHelpers.GetBool(part, "thought", false))
                    {
                        await AgentRuntimeTools.EmitAsync(
                            state,
                            context,
                            new AgentRuntimeStreamEvent("thinking_delta", Thinking: text));
                    }
                    else
                    {
                        parseState.AssistantText.Append(text);
                        parseState.EstimatedOutputTokens += EstimateTokens(text);
                        await AgentRuntimeTools.EmitAsync(
                            state,
                            context,
                            new AgentRuntimeStreamEvent("text_delta", Text: text));
                    }
                }

                if (TryGetObject(part, "functionCall", out var functionCall) ||
                    TryGetObject(part, "function_call", out functionCall))
                {
                    await EmitToolCallAsync(functionCall, part, parseState, state, context, startedAt);
                }
            }
        }
    }

    private static async Task EmitToolCallAsync(
        JsonElement functionCall,
        JsonElement part,
        GeminiParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        var name = JsonHelpers.GetString(functionCall, "name") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var args = functionCall.TryGetProperty("args", out var argsElement)
            ? argsElement.Clone()
            : JsonDocument.Parse("{}").RootElement.Clone();
        var argsJson = args.GetRawText();
        var id = $"gemini_{name}_{parseState.ToolCalls.Count + 1}";
        var signature = $"{name}:{argsJson}";
        if (!parseState.EmittedToolSignatures.Add(signature))
        {
            return;
        }

        parseState.FirstTokenMs ??= ElapsedMs(startedAt);

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_use_streaming_start",
                ToolCallId: id,
                ToolName: name));

        if (TryParseJsonObject(argsJson, out var partialInput))
        {
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_args_delta",
                    ToolCallId: id,
                    PartialInput: partialInput));
        }

        var call = new AgentRuntimeNativeToolCall(id, name, args);
        parseState.ToolCalls.Add(call);
    }

    private static string BuildRequestBody(
        JsonElement parameters,
        JsonElement provider,
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = GetOmittedBodyKeys(provider);
            writer.WriteStartObject();

            if (!omitted.Contains("contents"))
            {
                writer.WritePropertyName("contents");
                WriteContents(writer, conversation);
            }

            if (!omitted.Contains("tools"))
            {
                WriteTools(writer, parameters);
            }

            if (!omitted.Contains("generationConfig"))
            {
                WriteGenerationConfig(writer, provider);
            }

            if (!omitted.Contains("systemInstruction") &&
                JsonHelpers.GetString(provider, "systemPrompt") is { Length: > 0 } systemPrompt)
            {
                writer.WritePropertyName("systemInstruction");
                writer.WriteStartObject();
                writer.WritePropertyName("parts");
                writer.WriteStartArray();
                writer.WriteStartObject();
                writer.WriteString("text", systemPrompt);
                writer.WriteEndObject();
                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            WriteThinkingConfig(writer, provider, omitted);
            ApplyBodyOverrides(writer, provider, omitted);

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteContents(
        Utf8JsonWriter writer,
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var toolNameById = new Dictionary<string, string>(StringComparer.Ordinal);

        writer.WriteStartArray();
        foreach (var message in conversation)
        {
            if (message.Role == "system")
            {
                continue;
            }

            var wroteContent = false;
            writer.WriteStartObject();
            writer.WriteString("role", message.Role == "assistant" ? "model" : "user");
            writer.WritePropertyName("parts");
            writer.WriteStartArray();

            if (!string.IsNullOrEmpty(message.Text))
            {
                writer.WriteStartObject();
                writer.WriteString("text", message.Text);
                writer.WriteEndObject();
                wroteContent = true;
            }

            foreach (var toolUse in message.ToolUses)
            {
                toolNameById[toolUse.Id] = toolUse.Name;
                writer.WriteStartObject();
                writer.WritePropertyName("functionCall");
                writer.WriteStartObject();
                writer.WriteString("name", toolUse.Name);
                writer.WritePropertyName("args");
                toolUse.Input.WriteTo(writer);
                writer.WriteEndObject();
                writer.WriteEndObject();
                wroteContent = true;
            }

            foreach (var result in message.ToolResults)
            {
                var toolName = toolNameById.TryGetValue(result.ToolUseId, out var knownName)
                    ? knownName
                    : result.ToolUseId;
                writer.WriteStartObject();
                writer.WritePropertyName("functionResponse");
                writer.WriteStartObject();
                writer.WriteString("name", toolName);
                writer.WritePropertyName("response");
                writer.WriteStartObject();
                writer.WriteString("name", toolName);
                writer.WritePropertyName("content");
                WriteToolResultContent(writer, result.Content);
                writer.WriteEndObject();
                writer.WriteEndObject();
                writer.WriteEndObject();
                wroteContent = true;
            }

            if (!wroteContent)
            {
                writer.WriteStartObject();
                writer.WriteString("text", string.Empty);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    private static void WriteToolResultContent(Utf8JsonWriter writer, JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            writer.WriteStartObject();
            writer.WriteString("text", content.GetString() ?? string.Empty);
            writer.WriteEndObject();
            return;
        }

        content.WriteTo(writer);
    }

    private static void WriteTools(Utf8JsonWriter writer, JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("tools", out var tools) ||
            tools.ValueKind != JsonValueKind.Array ||
            tools.GetArrayLength() == 0)
        {
            return;
        }

        writer.WritePropertyName("tools");
        writer.WriteStartArray();
        writer.WriteStartObject();
        writer.WritePropertyName("functionDeclarations");
        writer.WriteStartArray();
        foreach (var tool in tools.EnumerateArray())
        {
            var name = JsonHelpers.GetString(tool, "name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            writer.WriteStartObject();
            writer.WriteString("name", name);
            writer.WriteString("description", JsonHelpers.GetString(tool, "description") ?? string.Empty);
            writer.WritePropertyName("parameters");
            if (tool.TryGetProperty("inputSchema", out var schema))
            {
                WriteSanitizedSchema(writer, schema);
            }
            else
            {
                writer.WriteStartObject();
                writer.WriteString("type", "object");
                writer.WriteStartObject("properties");
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
        writer.WriteEndArray();
    }

    private static void WriteGenerationConfig(Utf8JsonWriter writer, JsonElement provider)
    {
        var hasConfig = JsonHelpers.GetDoubleNullable(provider, "temperature") is not null ||
            JsonHelpers.GetIntNullable(provider, "maxTokens") is not null;
        if (!hasConfig)
        {
            return;
        }

        writer.WritePropertyName("generationConfig");
        writer.WriteStartObject();
        if (JsonHelpers.GetDoubleNullable(provider, "temperature") is { } temperature)
        {
            writer.WriteNumber("temperature", temperature);
        }
        if (JsonHelpers.GetIntNullable(provider, "maxTokens") is { } maxTokens && maxTokens > 0)
        {
            writer.WriteNumber("maxOutputTokens", maxTokens);
        }
        writer.WriteEndObject();
    }

    private static void WriteThinkingConfig(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
    {
        var thinkingEnabled = JsonHelpers.GetBool(provider, "thinkingEnabled", false);
        if (!provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var propertyName = thinkingEnabled ? "bodyParams" : "disabledBodyParams";
        if (!thinkingConfig.TryGetProperty(propertyName, out var bodyParams) ||
            bodyParams.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in bodyParams.EnumerateObject())
        {
            if (omitted.Contains(property.Name))
            {
                continue;
            }
            property.WriteTo(writer);
        }
    }

    private static void ApplyBodyOverrides(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("body", out var body) ||
            body.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in body.EnumerateObject())
        {
            if (omitted.Contains(property.Name))
            {
                continue;
            }
            property.WriteTo(writer);
        }
    }

    private static HashSet<string> GetOmittedBodyKeys(JsonElement provider)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("omitBodyKeys", out var keys) ||
            keys.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var key in keys.EnumerateArray())
        {
            if (key.ValueKind == JsonValueKind.String && key.GetString() is { Length: > 0 } value)
            {
                result.Add(value);
            }
        }
        return result;
    }

    private static void WriteSanitizedSchema(Utf8JsonWriter writer, JsonElement schema)
    {
        if (schema.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            var wroteType = false;
            var wroteProperties = false;
            foreach (var property in schema.EnumerateObject())
            {
                if (IsUnsupportedSchemaKeyword(property.Name))
                {
                    continue;
                }
                if (property.NameEquals("type"))
                {
                    wroteType = true;
                }
                if (property.NameEquals("properties"))
                {
                    wroteProperties = true;
                }
                writer.WritePropertyName(property.Name);
                WriteSanitizedSchemaValue(writer, property.Value);
            }
            if (!wroteType)
            {
                writer.WriteString("type", "object");
            }
            if (!wroteProperties)
            {
                writer.WriteStartObject("properties");
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", "object");
        writer.WriteStartObject("properties");
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteSanitizedSchemaValue(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject())
                {
                    if (IsUnsupportedSchemaKeyword(property.Name))
                    {
                        continue;
                    }
                    writer.WritePropertyName(property.Name);
                    WriteSanitizedSchemaValue(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray())
                {
                    WriteSanitizedSchemaValue(writer, item);
                }
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }

    private static bool IsUnsupportedSchemaKeyword(string name)
    {
        return name is
            "additionalProperties" or
            "const" or
            "oneOf" or
            "anyOf" or
            "allOf" or
            "$schema" or
            "$defs" or
            "definitions" or
            "patternProperties" or
            "unevaluatedProperties";
    }

    private static string BuildApiUrl(string providerType, string? baseUrl, string model, bool stream)
    {
        var action = stream ? "streamGenerateContent" : "generateContent";
        var root = (baseUrl ?? (providerType == "vertex-ai"
                ? "https://aiplatform.googleapis.com/v1"
                : "https://generativelanguage.googleapis.com/v1beta"))
            .Trim()
            .TrimEnd('/');

        if (root.EndsWith("/openai", StringComparison.OrdinalIgnoreCase))
        {
            root = root[..^"/openai".Length];
        }

        if (providerType == "vertex-ai")
        {
            var versionIndex = root.IndexOf("/v", StringComparison.OrdinalIgnoreCase);
            if (versionIndex < 0)
            {
                throw new InvalidOperationException(
                    "Vertex AI Base URL must include an API version and projects/PROJECT/locations/LOCATION.");
            }
            var nextSlash = root.IndexOf('/', versionIndex + 1);
            if (nextSlash < 0 || nextSlash == root.Length - 1)
            {
                throw new InvalidOperationException(
                    "Vertex AI Base URL must include projects/PROJECT/locations/LOCATION.");
            }

            var versionRoot = root[..nextSlash];
            var resourcePath = root[(nextSlash + 1)..].Trim('/');
            if (!resourcePath.EndsWith("/publishers/google", StringComparison.OrdinalIgnoreCase))
            {
                resourcePath = $"{resourcePath}/publishers/google";
            }
            return $"{versionRoot}/{resourcePath}/models/{Uri.EscapeDataString(model)}:{action}";
        }

        return $"{root}/models/{Uri.EscapeDataString(model)}:{action}";
    }

    private static void ApplyHeaders(HttpRequestMessage request, JsonElement provider)
    {
        var apiKey = JsonHelpers.GetString(provider, "apiKey") ?? string.Empty;
        request.Headers.TryAddWithoutValidation("x-goog-api-key", apiKey);
        if (JsonHelpers.GetString(provider, "userAgent") is { Length: > 0 } userAgent)
        {
            request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        }
        ApplyHeaderOverrides(request, provider);
    }

    private static void ApplyHeaderOverrides(HttpRequestMessage request, JsonElement provider)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("headers", out var headers) ||
            headers.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var sessionId = JsonHelpers.GetString(provider, "sessionId") ?? string.Empty;
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        foreach (var property in headers.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var value = (property.Value.GetString() ?? string.Empty)
                .Replace("{{sessionId}}", sessionId, StringComparison.Ordinal)
                .Replace("{{ sessionId }}", sessionId, StringComparison.Ordinal)
                .Replace("{{model}}", model, StringComparison.Ordinal)
                .Replace("{{ model }}", model, StringComparison.Ordinal)
                .Trim();
            if (value.Length == 0)
            {
                continue;
            }
            request.Headers.Remove(property.Name);
            request.Headers.TryAddWithoutValidation(property.Name, value);
        }
    }

    private static IReadOnlyDictionary<string, string> BuildDebugHeaders(JsonElement provider)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = "application/json",
            ["x-goog-api-key"] = "***"
        };
        if (JsonHelpers.GetString(provider, "userAgent") is { Length: > 0 } userAgent)
        {
            headers["User-Agent"] = userAgent;
        }
        return headers;
    }

    private static void TryEmitThinkingEncrypted(
        JsonElement part,
        GeminiParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var encrypted = JsonHelpers.GetString(part, "thoughtSignature") ??
            JsonHelpers.GetString(part, "thought_signature");
        if (string.IsNullOrWhiteSpace(encrypted) || !parseState.EmittedEncryptedReasoning.Add(encrypted))
        {
            return;
        }
        _ = AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "thinking_encrypted",
                Content: encrypted,
                Provider: "google"));
    }

    private static AgentRuntimeTokenUsage ReadUsage(JsonElement usage)
    {
        var inputTokens = JsonHelpers.GetInt(usage, "promptTokenCount", 0);
        var outputTokens = JsonHelpers.GetInt(usage, "candidatesTokenCount", 0);
        if (outputTokens == 0)
        {
            outputTokens = Math.Max(0, JsonHelpers.GetInt(usage, "totalTokenCount", 0) - inputTokens);
        }
        var reasoningTokens = JsonHelpers.GetIntNullable(usage, "thoughtsTokenCount");
        return new AgentRuntimeTokenUsage(
            inputTokens,
            outputTokens,
            ReasoningTokens: reasoningTokens,
            ContextTokens: inputTokens);
    }

    private static bool TryGetObject(JsonElement element, string name, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out value) &&
            value.ValueKind == JsonValueKind.Object)
        {
            return true;
        }
        value = default;
        return false;
    }

    private static bool TryParseJsonObject(string value, out JsonElement element)
    {
        try
        {
            var document = JsonDocument.Parse(value);
            element = document.RootElement.Clone();
            document.Dispose();
            return element.ValueKind == JsonValueKind.Object;
        }
        catch
        {
            element = default;
            return false;
        }
    }

    private static bool LooksLikeJson(string line)
    {
        var trimmed = line.TrimStart();
        return trimmed.StartsWith('{') || trimmed.StartsWith('[');
    }

    private static int EstimateTokens(string text)
    {
        return Math.Max(1, text.Length / 4);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenMs, long totalMs)
    {
        if (outputTokens <= 0 || firstTokenMs is null || totalMs <= firstTokenMs.Value)
        {
            return null;
        }
        var seconds = (totalMs - firstTokenMs.Value) / 1000.0;
        return seconds <= 0 ? null : Math.Round(outputTokens / seconds, 2);
    }

    private sealed class GeminiParseState
    {
        public StringBuilder AssistantText { get; } = new();
        public List<AgentRuntimeNativeToolCall> ToolCalls { get; } = [];
        public HashSet<string> EmittedToolSignatures { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedEncryptedReasoning { get; } = new(StringComparer.Ordinal);
        public long? FirstTokenMs { get; set; }
        public int EstimatedOutputTokens { get; set; }
        public AgentRuntimeTokenUsage? Usage { get; set; }
        public string StopReason { get; set; } = "stop";
    }
}
