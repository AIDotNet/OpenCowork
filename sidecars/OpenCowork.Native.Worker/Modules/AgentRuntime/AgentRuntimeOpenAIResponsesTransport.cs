using System.Buffers;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static async Task ExecuteHttpSseAsync(
        string url,
        string body,
        JsonElement provider,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyOpenAIHeaders(request, provider, websocket: false);

        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(state.CancellationToken);
            throw new InvalidOperationException(
                $"OpenAI Responses request failed HTTP {(int)response.StatusCode}: {errorBody}");
        }

        await using var responseStream = await response.Content.ReadAsStreamAsync(state.CancellationToken);
        using var reader = new StreamReader(responseStream, Encoding.UTF8);
        var dataBuilder = new StringBuilder();
        string? eventName = null;
        string? line;
        while ((line = await reader.ReadLineAsync(state.CancellationToken)) is not null)
        {
            if (line.Length == 0)
            {
                if (dataBuilder.Length > 0)
                {
                    var data = dataBuilder.ToString();
                    dataBuilder.Clear();
                    if (data == "[DONE]")
                    {
                        break;
                    }
                    await ProcessJsonEventAsync(eventName, data, parseState, state, context, startedAt);
                    eventName = null;
                }
                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line[6..].TrimStart();
                continue;
            }
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (dataBuilder.Length > 0)
                {
                    dataBuilder.Append('\n');
                }
                dataBuilder.Append(line[5..].TrimStart());
            }
        }
    }

    private static async Task ExecuteWebSocketAsync(
        string websocketUrl,
        string body,
        JsonElement provider,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        long startedAt)
    {
        using var socket = new ClientWebSocket();
        ApplyOpenAIWebSocketHeaders(socket, provider);
        await socket.ConnectAsync(new Uri(websocketUrl), state.CancellationToken);

        var payload = BuildWebSocketCreatePayload(body);
        var payloadBytes = Encoding.UTF8.GetBytes(payload);
        await socket.SendAsync(
            payloadBytes,
            WebSocketMessageType.Text,
            WebSocketMessageFlags.EndOfMessage,
            state.CancellationToken);

        var buffer = new byte[64 * 1024];
        while (socket.State == WebSocketState.Open && !state.CancellationToken.IsCancellationRequested)
        {
            using var message = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, state.CancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
                    return;
                }
                message.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Text)
            {
                continue;
            }

            var data = Encoding.UTF8.GetString(message.ToArray());
            var shouldStop = await ProcessJsonEventAsync(null, data, parseState, state, context, startedAt);
            if (shouldStop)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "completed", CancellationToken.None);
                return;
            }
        }
    }


    private static string? ResolveWebSocketUrl(JsonElement provider, string baseUrl)
    {
        if (JsonHelpers.GetString(provider, "websocketMode") == "disabled")
        {
            return null;
        }
        if (!ShouldEnableResponsesWebSocketForScope(provider))
        {
            return null;
        }
        if (JsonHelpers.GetString(provider, "websocketUrl") is { Length: > 0 } explicitUrl &&
            IsValidWebSocketUrl(explicitUrl))
        {
            return explicitUrl;
        }
        return DeriveResponsesWebSocketUrl(baseUrl);
    }

    private static bool ShouldEnableResponsesWebSocketForScope(JsonElement provider)
    {
        var scope = JsonHelpers.GetString(provider, "responsesSessionScope")?.Trim();
        if (string.IsNullOrWhiteSpace(scope))
        {
            scope = "main";
        }

        return scope == ResponsesWebSocketAgentMainScope ||
            scope == ResponsesWebSocketSubAgentScopePrefix ||
            scope.StartsWith($"{ResponsesWebSocketSubAgentScopePrefix}:", StringComparison.Ordinal);
    }

    private static string? DeriveResponsesWebSocketUrl(string baseUrl)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https"))
        {
            return null;
        }

        var scheme = uri.Scheme == "https" ? "wss" : "ws";
        var path = uri.AbsolutePath.TrimEnd('/');
        path = path.EndsWith("/responses", StringComparison.OrdinalIgnoreCase)
            ? path
            : $"{path}/responses";
        var builder = new UriBuilder(uri)
        {
            Scheme = scheme,
            Port = uri.IsDefaultPort ? -1 : uri.Port,
            Path = path
        };
        return builder.Uri.ToString();
    }

    private static bool IsValidWebSocketUrl(string value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            uri.Scheme is "ws" or "wss";
    }

    private static string BuildWebSocketCreatePayload(string body)
    {
        using var document = JsonDocument.Parse(body);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("type", "response.create");
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Name is "stream" or "background")
                {
                    continue;
                }
                property.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void ApplyOpenAIHeaders(HttpRequestMessage request, JsonElement provider, bool websocket)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);
        ApiUserAgent.Apply(request, provider);
        if (JsonHelpers.GetString(provider, "organization") is { Length: > 0 } organization)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Organization", organization);
        }
        if (JsonHelpers.GetString(provider, "project") is { Length: > 0 } project)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Project", project);
        }
        if (JsonHelpers.GetString(provider, "accountId") is { Length: > 0 } accountId)
        {
            request.Headers.TryAddWithoutValidation("Chatgpt-Account-Id", accountId);
        }
        if (websocket)
        {
            request.Headers.TryAddWithoutValidation(ResponsesWebSocketBetaHeader, ResponsesWebSocketBetaValue);
        }
        if (JsonHelpers.GetString(provider, "serviceTier") is { Length: > 0 } serviceTier)
        {
            request.Headers.TryAddWithoutValidation("service_tier", serviceTier);
        }
        AgentRuntimeProviderSupport.ApplyHttpHeaderOverrides(
            request,
            provider,
            header => ShouldSkipCodexOAuthHeader(provider, header));
        ApiUserAgent.Ensure(request, provider);
    }

    private static void ApplyOpenAIWebSocketHeaders(ClientWebSocket socket, JsonElement provider)
    {
        socket.Options.SetRequestHeader("Authorization", $"Bearer {JsonHelpers.GetString(provider, "apiKey") ?? string.Empty}");
        socket.Options.SetRequestHeader(ResponsesWebSocketBetaHeader, ResponsesWebSocketBetaValue);
        ApiUserAgent.Apply(socket, provider);
        if (JsonHelpers.GetString(provider, "organization") is { Length: > 0 } organization)
        {
            socket.Options.SetRequestHeader("OpenAI-Organization", organization);
        }
        if (JsonHelpers.GetString(provider, "project") is { Length: > 0 } project)
        {
            socket.Options.SetRequestHeader("OpenAI-Project", project);
        }
        if (JsonHelpers.GetString(provider, "accountId") is { Length: > 0 } accountId)
        {
            socket.Options.SetRequestHeader("Chatgpt-Account-Id", accountId);
        }
        if (JsonHelpers.GetString(provider, "serviceTier") is { Length: > 0 } serviceTier)
        {
            socket.Options.SetRequestHeader("service_tier", serviceTier);
        }
        ApplyOpenAIWebSocketHeaderOverrides(socket, provider);
    }

    private static IReadOnlyDictionary<string, string> BuildDebugHeaders(JsonElement provider, bool websocket)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = "application/json",
            ["Authorization"] = "Bearer ***"
        };
        if (websocket)
        {
            headers[ResponsesWebSocketBetaHeader] = ResponsesWebSocketBetaValue;
        }
        ApiUserAgent.ApplyDebug(headers, provider);
        if (JsonHelpers.GetString(provider, "serviceTier") is { Length: > 0 } serviceTier)
        {
            headers["service_tier"] = serviceTier;
        }
        AgentRuntimeProviderSupport.ApplyDebugHeaderOverrides(
            headers,
            provider,
            header => ShouldSkipCodexOAuthHeader(provider, header));
        ApiUserAgent.EnsureDebug(headers, provider);
        return headers;
    }

    private static void ApplyOpenAIWebSocketHeaderOverrides(ClientWebSocket socket, JsonElement provider)
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
            if (property.Value.ValueKind != JsonValueKind.String ||
                ShouldSkipCodexOAuthHeader(provider, property.Name))
            {
                continue;
            }
            var value = AgentRuntimeProviderSupport.ResolveHeaderTemplate(
                property.Value.GetString() ?? string.Empty,
                sessionId,
                model);
            if (value.Length > 0)
            {
                if (property.Name.Equals("User-Agent", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ApiUserAgent.IsUsable(value))
                    {
                        continue;
                    }
                    socket.Options.SetRequestHeader(property.Name, ApiUserAgent.Resolve(value));
                }
                else
                {
                    socket.Options.SetRequestHeader(property.Name, value);
                }
            }
        }
    }

    private static bool ShouldSkipCodexOAuthHeader(JsonElement provider, string headerName)
    {
        if (JsonHelpers.GetString(provider, "providerBuiltinId") != "codex-oauth" ||
            IsChatGptCodexBackend(JsonHelpers.GetString(provider, "baseUrl")))
        {
            return false;
        }
        return headerName.Equals("session_id", StringComparison.OrdinalIgnoreCase) ||
            headerName.Equals("conversation_id", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsChatGptCodexBackend(string? baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) ||
            !Uri.TryCreate(baseUrl.Trim(), UriKind.Absolute, out var uri))
        {
            return false;
        }
        return uri.Host.Equals("chatgpt.com", StringComparison.OrdinalIgnoreCase) &&
            uri.AbsolutePath.TrimEnd('/').Equals("/backend-api/codex", StringComparison.OrdinalIgnoreCase);
    }

}
