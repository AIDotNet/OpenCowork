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
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        var baseUrl = (JsonHelpers.GetString(provider, "baseUrl") ?? "https://api.openai.com/v1")
            .Trim()
            .TrimEnd('/');
        var httpUrl = $"{baseUrl}/responses";
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
                IsRecoverablePreviousResponseReplayError(ex))
            {
                WorkerLog.Warn(
                    "responses previous_response_id replay failed with a recoverable error; " +
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
            ShouldFallBackToHttpTransport(ex, parseState, state))
        {
            UnavailableWebSocketUrls.TryAdd(websocketUrl, 0);
            WorkerLog.Warn(
                "responses websocket transport failed before any event; falling back to HTTP SSE " +
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
            // HttpClient reports request timeouts as OperationCanceledException. Retrying is
            // safe only before the provider has emitted an event; otherwise a replay could
            // duplicate streamed text or tool execution.
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
                    ComputeTps(parseState.Usage?.OutputTokens ?? parseState.EstimatedOutputTokens, parseState.FirstTokenMs, totalMs)),
                ProviderResponseId: parseState.ProviderResponseId));

        return new AgentRuntimeProviderTurnResult(
            new AgentRuntimeChatMessage(
                "assistant",
                parseState.AssistantText.ToString(),
            parseState.ToolCalls
                    .Select(call => new AgentRuntimeChatToolUse(call.Id, call.Name, call.Input, call.ExtraContent))
                    .ToList(),
                [],
                parseState.ProviderResponseId),
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

    private static bool IsRecoverablePreviousResponseReplayError(Exception ex)
    {
        return IsMissingToolOutputError(ex) || IsPreviousResponseNotFoundError(ex);
    }

    private static bool ShouldFallBackToHttpTransport(
        Exception ex,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state)
    {
        // Only retry over HTTP when the WebSocket produced no events at all:
        // once deltas have streamed to the UI a silent re-run would duplicate them.
        if (state.IsCancellationRequested || parseState.ReceivedAnyMessage)
        {
            return false;
        }
        return ex is WebSocketException or ResponsesWebSocketUnavailableException;
    }

    private static bool IsMissingToolOutputError(Exception ex)
    {
        return ex.Message.Contains(
            "No tool output found for function call",
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsPreviousResponseNotFoundError(Exception ex)
    {
        var message = ex.Message;
        return message.Contains("previous_response_not_found", StringComparison.OrdinalIgnoreCase) ||
            (message.Contains("previous_response_id", StringComparison.OrdinalIgnoreCase) &&
                message.Contains("not found", StringComparison.OrdinalIgnoreCase));
    }

}
