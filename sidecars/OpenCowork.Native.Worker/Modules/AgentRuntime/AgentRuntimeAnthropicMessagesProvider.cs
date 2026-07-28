using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private const int MaxAnthropicCacheControlBlocks = 4;
    private const int MinAnthropicThinkingBudget = 1024;
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
        var baseUrl = (JsonHelpers.GetString(provider, "baseUrl") ?? "https://api.anthropic.com")
            .Trim()
            .TrimEnd('/');
        var url = $"{baseUrl}/v1/messages";
        var body = BuildRequestBody(parameters, provider, conversation, out var validationStats);
        ValidateAnthropicRequestBodyToolReplay(body);
        LogAnthropicConversationValidation(validationStats, model);
        var debugBody = AgentRuntimeDebugPayload.PrepareBodyFile(body, parameters);

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
                    model,
                    BodyRef: debugBody?.Ref,
                    BodyBytes: debugBody?.Bytes)));

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider);

        var startedAt = Stopwatch.GetTimestamp();
        var parseState = new AnthropicParseState();
        WorkerLog.Debug($"anthropic messages request start model={model} url={url}");

        using var response = await AgentRuntimeRequestTimeout.SendAsync(
            Http,
            request,
            provider,
            "Anthropic Messages",
            state.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw await AgentRuntimeProviderHttpException.CreateAsync(
                "Anthropic Messages",
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
                    if (data != "[DONE]")
                    {
                        await ProcessJsonEventAsync(eventName, data, parseState, state, context, startedAt);
                    }
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

        FlushPendingToolCalls(parseState);
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

}
