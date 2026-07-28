using System.Buffers;
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private const int WebSocketConnectTimeoutMs = 15_000;
    private const int WebSocketFirstMessageTimeoutMs = 30_000;
    private static readonly ConcurrentDictionary<string, byte> UnavailableWebSocketUrls =
        new(StringComparer.OrdinalIgnoreCase);

    private sealed class ResponsesWebSocketUnavailableException : Exception
    {
        public ResponsesWebSocketUnavailableException(string message, Exception? inner = null)
            : base(message, inner)
        {
        }
    }

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

        using var response = await AgentRuntimeRequestTimeout.SendAsync(
            Http,
            request,
            provider,
            "OpenAI Responses",
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw await AgentRuntimeProviderHttpException.CreateAsync(
                "OpenAI Responses",
                response,
                state.CancellationToken);
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
        using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(state.CancellationToken))
        {
            connectCts.CancelAfter(WebSocketConnectTimeoutMs);
            try
            {
                await socket.ConnectAsync(new Uri(websocketUrl), connectCts.Token);
            }
            catch (OperationCanceledException ex) when (!state.IsCancellationRequested)
            {
                throw new ResponsesWebSocketUnavailableException(
                    $"WebSocket connect timed out after {WebSocketConnectTimeoutMs}ms url={websocketUrl}",
                    ex);
            }
        }

        var payload = BuildWebSocketCreatePayload(body);
        var payloadBytes = Encoding.UTF8.GetBytes(payload);
        await socket.SendAsync(
            payloadBytes,
            WebSocketMessageType.Text,
            WebSocketMessageFlags.EndOfMessage,
            state.CancellationToken);

        // Some gateways complete the upgrade handshake but never emit response
        // events; bound the wait for the first message so the run cannot hang.
        using var firstMessageCts = CancellationTokenSource.CreateLinkedTokenSource(state.CancellationToken);
        firstMessageCts.CancelAfter(WebSocketFirstMessageTimeoutMs);

        var buffer = new byte[64 * 1024];
        while (socket.State == WebSocketState.Open && !state.CancellationToken.IsCancellationRequested)
        {
            using var message = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                var receiveToken = parseState.ReceivedAnyMessage
                    ? state.CancellationToken
                    : firstMessageCts.Token;
                try
                {
                    result = await socket.ReceiveAsync(buffer, receiveToken);
                }
                catch (OperationCanceledException ex) when (
                    !state.IsCancellationRequested &&
                    !parseState.ReceivedAnyMessage)
                {
                    throw new ResponsesWebSocketUnavailableException(
                        $"WebSocket produced no events within {WebSocketFirstMessageTimeoutMs}ms url={websocketUrl}",
                        ex);
                }
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
                    if (!parseState.ReceivedAnyMessage)
                    {
                        throw new ResponsesWebSocketUnavailableException(
                            $"WebSocket closed before any event was received url={websocketUrl}");
                    }
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
            parseState.ReceivedAnyMessage = true;
            var shouldStop = await ProcessJsonEventAsync(null, data, parseState, state, context, startedAt);
            if (shouldStop)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "completed", CancellationToken.None);
                return;
            }
        }

        if (!parseState.ReceivedAnyMessage && !state.IsCancellationRequested)
        {
            throw new ResponsesWebSocketUnavailableException(
                $"WebSocket ended before any event was received url={websocketUrl}");
        }
    }


    private static string? ResolveWebSocketUrl(JsonElement provider, string baseUrl)
    {
        // WebSocket transport is opt-in: many OpenAI-compatible gateways accept the
        // upgrade handshake but never emit response events, so HTTP SSE is the default.
        var mode = JsonHelpers.GetString(provider, "websocketMode");
        if (mode is not ("auto" or "enabled"))
        {
            return null;
        }
        if (!ShouldEnableResponsesWebSocketForScope(provider))
        {
            return null;
        }
        var url = JsonHelpers.GetString(provider, "websocketUrl") is { Length: > 0 } explicitUrl &&
            IsValidWebSocketUrl(explicitUrl)
                ? explicitUrl
                : DeriveResponsesWebSocketUrl(baseUrl);
        if (url is not null && UnavailableWebSocketUrls.ContainsKey(url))
        {
            WorkerLog.Debug(
                $"responses websocket skipped url={url} (marked unavailable after transport failure)");
            return null;
        }
        return url;
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
