using System.Buffers;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private const string ResponsesWebSocketBetaHeader = "OpenAI-Beta";
    private const string ResponsesWebSocketBetaValue = "responses_websockets=2026-02-06";
    private const string ResponsesWebSocketAgentMainScope = "agent-main";
    private const string ResponsesWebSocketSubAgentScopePrefix = "sub-agent";
    private static readonly string[] PreviousResponseRejectionMarkers =
    [
        "not found",
        "invalid",
        "expired",
        "does not exist",
        "doesn't exist",
        "no longer"
    ];
    // Infinite client timeout: the effective deadline is user-configurable and therefore
    // applied per request via AgentRuntimeRequestTimeout.
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: Timeout.InfiniteTimeSpan);
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
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        var baseUrl = (JsonHelpers.GetString(provider, "baseUrl") ?? "https://api.openai.com/v1")
            .Trim()
            .TrimEnd('/');
        var httpUrl = WithCodexClientVersion($"{baseUrl}/responses", provider);
        var websocketUrl = ResolveWebSocketUrl(provider, baseUrl);
        var useWebSocket = websocketUrl is not null;
        var body = BuildRequestBody(
            parameters,
            provider,
            conversation,
            allowPreviousResponseId: useWebSocket);
        var requestUrl = websocketUrl ?? httpUrl;
        var transport = useWebSocket ? "websocket" : "http";
        if (!useWebSocket && FindPreviousResponseAnchor(conversation) is { } previousResponse)
        {
            WorkerLog.Debug(
                $"responses previous_response_id suppressed transport=http responseId={previousResponse.ResponseId}");
        }

        await EmitRequestDebugAsync(
            parameters,
            provider,
            state,
            context,
            requestUrl,
            useWebSocket,
            body,
            model,
            transport);

        var startedAt = Stopwatch.GetTimestamp();
        var parseState = new ResponsesParseState();
        WorkerLog.Debug(
            $"responses provider request start model={model} transport={transport} url={requestUrl}");

        try
        {
            try
            {
                if (useWebSocket && websocketUrl is not null)
                {
                    await ExecuteWebSocketAsync(websocketUrl, body, provider, parseState, state, context, startedAt);
                }
                else
                {
                    await ExecuteHttpSseAsync(httpUrl, body, provider, parseState, state, context, startedAt);
                }
            }
            catch (InvalidOperationException ex) when (
                useWebSocket &&
                websocketUrl is not null &&
                IsMissingToolOutputError(ex))
            {
                WorkerLog.Warn(
                    "responses previous_response_id replay left a function call without its output; " +
                    "retrying with full sanitized input");
                body = BuildRequestBody(
                    parameters,
                    provider,
                    conversation,
                    allowPreviousResponseId: false);
                await EmitRequestDebugAsync(
                    parameters,
                    provider,
                    state,
                    context,
                    requestUrl,
                    useWebSocket,
                    body,
                    model,
                    transport);
                startedAt = Stopwatch.GetTimestamp();
                parseState = new ResponsesParseState();
                await ExecuteWebSocketAsync(websocketUrl, body, provider, parseState, state, context, startedAt);
            }
        }
        catch (Exception ex) when (
            useWebSocket &&
            websocketUrl is not null &&
            ShouldFallBackToHttpTransport(ex, state))
        {
            UnavailableWebSocketUrls.TryAdd(websocketUrl, 0);
            WorkerLog.Warn(
                "responses websocket route unusable before projected output; falling back to HTTP SSE " +
                $"url={websocketUrl} error={ex.GetType().Name}: {ex.Message}");
            body = BuildRequestBody(
                parameters,
                provider,
                conversation,
                allowPreviousResponseId: false);
            transport = "http";
            parseState = new ResponsesParseState();
            await EmitRequestDebugAsync(
                parameters,
                provider,
                state,
                context,
                httpUrl,
                useWebSocket: false,
                body,
                model,
                transport);
            startedAt = Stopwatch.GetTimestamp();
            await ExecuteHttpSseAsync(httpUrl, body, provider, parseState, state, context, startedAt);
        }
        catch (OperationCanceledException ex) when (
            !useWebSocket &&
            !state.IsCancellationRequested &&
            !parseState.ReceivedAnyMessage)
        {
            // Covers transport-level interruptions that surface as cancellation without the
            // run being cancelled. Configured response-header timeouts use a dedicated exception
            // and are retried by AgentRuntimeProviderRetryPolicy instead of this one-off path.
            // Retrying is safe only before the provider has emitted an event; otherwise a
            // replay could duplicate streamed text or tool execution.
            WorkerLog.Warn(
                "responses HTTP request interrupted before first event; retrying once " +
                $"url={httpUrl} error={ex.GetType().Name}: {ex.Message}");
            parseState = new ResponsesParseState();
            await EmitRequestDebugAsync(
                parameters,
                provider,
                state,
                context,
                httpUrl,
                useWebSocket: false,
                body,
                model,
                transport);
            startedAt = Stopwatch.GetTimestamp();
            await ExecuteHttpSseAsync(httpUrl, body, provider, parseState, state, context, startedAt);
        }

        FlushPendingToolCalls(parseState);
        var totalMs = ElapsedMs(startedAt);
        if (parseState.Usage is { } usage)
        {
            WorkerLog.Debug(
                "responses provider usage " +
                $"transport={transport} inputTokens={usage.InputTokens} outputTokens={usage.OutputTokens} " +
                $"cacheReadTokens={usage.CacheReadTokens ?? 0} cacheCreationTokens={usage.CacheCreationTokens ?? 0} " +
                $"billableInputTokens={usage.BillableInputTokens ?? usage.InputTokens} " +
                $"reasoningTokens={usage.ReasoningTokens ?? 0}");
        }
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
                    AgentRuntimeThroughput.ComputeTps(
                        parseState.Usage,
                        parseState.EstimatedOutputTokens,
                        parseState.ReasoningStreamedLive,
                        usageIncludesReasoning: true,
                        parseState.FirstTokenMs,
                        totalMs)),
                ProviderResponseId: parseState.ProviderResponseId));

        return new AgentRuntimeProviderTurnResult(
            new AgentRuntimeChatMessage(
                "assistant",
                parseState.AssistantText.ToString(),
            parseState.ToolCalls
                    .Select(call => new AgentRuntimeChatToolUse(call.Id, call.Name, call.Input, call.ExtraContent))
                    .ToList(),
                [],
                parseState.ProviderResponseId,
                BuildResponsesContentBlocks(parseState)),
            parseState.ToolCalls,
            parseState.StopReason,
            parseState.Usage);
    }

    private static async Task EmitRequestDebugAsync(
        JsonElement parameters,
        JsonElement provider,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string requestUrl,
        bool useWebSocket,
        string body,
        string model,
        string transport)
    {
        var debugBody = AgentRuntimeDebugPayload.PrepareBodyFile(body, parameters);

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "request_debug",
                DebugInfo: new AgentRuntimeRequestDebugInfo(
                    requestUrl,
                    useWebSocket ? "WS" : "POST",
                    BuildDebugHeaders(provider, useWebSocket),
                    AgentRuntimeDebugPayload.PrepareBody(body, parameters),
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    JsonHelpers.GetString(provider, "providerId"),
                    JsonHelpers.GetString(provider, "providerBuiltinId"),
                    model,
                    ExecutionPath: "sidecar",
                    Transport: transport,
                    PromptCacheKeyHash: ResolvePromptCacheKeyHash(provider),
                    BodyRef: debugBody?.Ref,
                    BodyBytes: debugBody?.Bytes)));
    }

    private static bool ShouldFallBackToHttpTransport(
        Exception ex,
        AgentRuntimeTools.AgentRuntimeRunState state)
    {
        // WebSocket control/error frames are not user-visible output. They may still prove that
        // the route is unavailable, so replay over HTTP remains safe until an event has actually
        // been projected to the UI or tool runtime. A rejected previous_response_id belongs here
        // too: only the WebSocket path chains on a stored response, so HTTP replays the same turn
        // as a self-contained request and the route stays skipped for later turns.
        if (state.IsCancellationRequested || state.ProviderOutputProjected)
        {
            return false;
        }
        return ex is WebSocketException or ResponsesWebSocketUnavailableException ||
            IsPreviousResponseIdRejectedError(ex);
    }

    private static bool IsMissingToolOutputError(Exception ex)
    {
        return ex.Message.Contains(
            "No tool output found for function call",
            StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A rejected `previous_response_id` means the route cannot serve stored responses back, which
    /// no amount of retrying changes. Gateways word it differently — OpenAI returns the
    /// `previous_response_not_found` code, relays that never persist a response just call the id
    /// invalid — so match the field name paired with any rejection wording.
    /// </summary>
    private static bool IsPreviousResponseIdRejectedError(Exception ex)
    {
        var message = ex.Message;
        if (message.Contains("previous_response_not_found", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        if (!message.Contains("previous_response_id", StringComparison.OrdinalIgnoreCase) &&
            !message.Contains("previous response", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        return PreviousResponseRejectionMarkers.Any(marker =>
            message.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

}
