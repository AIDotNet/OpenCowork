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
                    Transport: transport)));

        var startedAt = Stopwatch.GetTimestamp();
        var parseState = new ResponsesParseState();
        WorkerLog.Debug(
            $"responses provider request start model={model} transport={transport} url={requestUrl}");

        if (useWebSocket && websocketUrl is not null)
        {
            await ExecuteWebSocketAsync(websocketUrl, body, provider, parseState, state, context, startedAt);
        }
        else
        {
            await ExecuteHttpSseAsync(httpUrl, body, provider, parseState, state, context, startedAt);
        }

        FlushPendingToolCalls(parseState);
        var totalMs = ElapsedMs(startedAt);
        if (parseState.Usage is { } usage)
        {
            WorkerLog.Debug(
                "responses provider usage " +
                $"transport={transport} inputTokens={usage.InputTokens} outputTokens={usage.OutputTokens} " +
                $"cacheReadTokens={usage.CacheReadTokens ?? 0} billableInputTokens={usage.BillableInputTokens ?? usage.InputTokens} " +
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

}
