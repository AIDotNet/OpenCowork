using System.Net.WebSockets;
using System.Text.Json;

/// <summary>
/// Raised only when a provider has not returned response headers before the configured deadline.
/// Unlike stream-idle timeouts, replaying this failure is safe because no response event can have
/// reached the caller yet.
/// </summary>
internal sealed class AgentRuntimeProviderRequestTimeoutException : TimeoutException
{
    public AgentRuntimeProviderRequestTimeoutException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Reusable stream-idle deadline for the lifetime of one stream.
///
/// The deadline applies per read, but one long answer is tens of thousands of SSE lines and a
/// linked CancellationTokenSource is not free: each one allocates, registers on the run token, and
/// creates a timer — for a deadline that, at its 30-minute default, never fires. Re-arming a single
/// source instead costs one Timer.Change per read.
///
/// Not thread-safe: one gate belongs to one read loop, which is how every provider uses it.
/// </summary>
internal sealed class AgentRuntimeStreamIdleGate : IDisposable
{
    private readonly CancellationToken cancellationToken;
    private CancellationTokenSource? source;

    public AgentRuntimeStreamIdleGate(CancellationToken cancellationToken)
    {
        this.cancellationToken = cancellationToken;
    }

    /// <summary>True when the deadline armed for the last read is what cancelled it.</summary>
    public bool Expired => source is { IsCancellationRequested: true };

    /// <summary>
    /// Returns a token that cancels after <paramref name="timeout"/>, or as soon as the run is
    /// cancelled. Verified: TryReset keeps the link to the run token intact and re-arms the timer,
    /// and returns false once the source has actually been cancelled — so a fresh source is only
    /// allocated when the previous one is genuinely spent.
    /// </summary>
    public CancellationToken Arm(TimeSpan timeout)
    {
        if (source is null || !source.TryReset())
        {
            source?.Dispose();
            source = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        }
        source.CancelAfter(timeout);
        return source.Token;
    }

    public void Dispose()
    {
        source?.Dispose();
        source = null;
    }
}

// Provider HTTP requests go through a shared static HttpClient, and HttpClient.Timeout can no
// longer be reassigned once that client has dispatched its first request. A user-configurable
// deadline therefore cannot live on the client: the provider clients are created with
// Timeout.InfiniteTimeSpan and the deadline is applied per request here instead.
//
// The request deadline covers response headers. Every provider sends with
// HttpCompletionOption.ResponseHeadersRead, so that countdown is dropped when headers arrive.
// Body reads then use a separate reset-on-line/frame stream-idle deadline: healthy streams can run
// indefinitely, while a provider that silently stalls cannot retain a Job slot forever. Reads taken
// while a server-side image call is rendering get a longer deadline, since that silence is expected.
//
// This is also where transport faults are classified. Everything raised here happens before any
// response body is read, so a failure at this point is always safe to replay — no events have
// reached the UI yet.
internal static class AgentRuntimeRequestTimeout
{
    // Mirrors HttpClient's historical default so behaviour is unchanged when unset.
    public const int DefaultTimeoutSeconds = 100;
    // Reasoning models (OpenAI Responses o-series / GPT-5, Anthropic extended thinking)
    // routinely stay silent for several minutes after headers arrive — they are thinking,
    // not stalled. 120s killed those healthy streams. 30 minutes is long enough for
    // high-effort reasoning while still releasing a Job slot if the provider truly hung.
    public const int DefaultStreamIdleTimeoutSeconds = 1800;

    // Server-side image generation renders the whole image before the provider emits anything,
    // so a stream carrying an in-flight image call is legitimately silent for minutes — longer
    // still when partial images are off. Applying the text deadline there kills healthy runs, so
    // idle reads taken while an image call is open get their own, much longer deadline.
    public const int DefaultImageStreamIdleTimeoutSeconds = 900;

    /// <summary>
    /// Reads the configured request timeout from the provider payload. Returns null when the
    /// timeout is disabled (0 or negative), meaning the request waits until the provider responds
    /// or the user cancels the run.
    /// </summary>
    public static TimeSpan? Resolve(JsonElement provider)
    {
        var seconds = JsonHelpers.GetIntNullable(provider, "requestTimeoutSeconds")
            ?? DefaultTimeoutSeconds;
        return seconds > 0 ? TimeSpan.FromSeconds(seconds) : null;
    }

    public static TimeSpan? ResolveStreamIdle(
        JsonElement provider,
        bool imageGenerationInFlight = false)
    {
        var seconds = imageGenerationInFlight
            ? ResolveImageStreamIdleSeconds(provider)
            : ResolveTextStreamIdleSeconds(provider);
        return seconds > 0 ? TimeSpan.FromSeconds(seconds) : null;
    }

    private static int ResolveTextStreamIdleSeconds(JsonElement provider)
    {
        return JsonHelpers.GetIntNullable(provider, "streamIdleTimeoutSeconds")
            ?? ReadEnvironmentInt("OPEN_COWORK_AGENT_STREAM_IDLE_TIMEOUT_SECONDS")
            ?? DefaultStreamIdleTimeoutSeconds;
    }

    private static int ResolveImageStreamIdleSeconds(JsonElement provider)
    {
        var configured = JsonHelpers.GetIntNullable(provider, "imageStreamIdleTimeoutSeconds")
            ?? ReadEnvironmentInt("OPEN_COWORK_AGENT_IMAGE_STREAM_IDLE_TIMEOUT_SECONDS");
        if (configured is { } explicitSeconds)
        {
            return explicitSeconds;
        }
        var text = ResolveTextStreamIdleSeconds(provider);
        // A disabled text deadline stays disabled; otherwise an image call never gets less
        // headroom than plain text, whatever the user raised the text deadline to.
        return text > 0 ? Math.Max(text, DefaultImageStreamIdleTimeoutSeconds) : 0;
    }

    private static int? ReadEnvironmentInt(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) ? value : null;
    }

    private static async ValueTask<string?> ReadLineCoreAsync(
        StreamReader reader,
        AgentRuntimeStreamIdleGate idleGate,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken,
        bool imageGenerationInFlight)
    {
        var configured = ResolveStreamIdle(provider, imageGenerationInFlight);
        if (configured is not { } timeout)
        {
            return await reader.ReadLineAsync(cancellationToken);
        }

        try
        {
            return await reader.ReadLineAsync(idleGate.Arm(timeout));
        }
        catch (OperationCanceledException ex)
            when (idleGate.Expired && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"{providerLabel} stream produced no data for {timeout.TotalSeconds:0}s" +
                $"{DescribeIdleStage(imageGenerationInFlight)}. " +
                DescribeIdleRemedy(imageGenerationInFlight),
                ex);
        }
    }

    public static async Task<WebSocketReceiveResult> ReceiveWebSocketAsync(
        ClientWebSocket socket,
        ArraySegment<byte> buffer,
        AgentRuntimeStreamIdleGate idleGate,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken,
        bool imageGenerationInFlight = false)
    {
        var configured = ResolveStreamIdle(provider, imageGenerationInFlight);
        if (configured is not { } timeout)
        {
            return await socket.ReceiveAsync(buffer, cancellationToken);
        }

        try
        {
            return await socket.ReceiveAsync(buffer, idleGate.Arm(timeout));
        }
        catch (OperationCanceledException ex)
            when (idleGate.Expired && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"{providerLabel} WebSocket produced no frame for {timeout.TotalSeconds:0}s" +
                $"{DescribeIdleStage(imageGenerationInFlight)}. " +
                DescribeIdleRemedy(imageGenerationInFlight),
                ex);
        }
    }

    private static string DescribeIdleStage(bool imageGenerationInFlight)
    {
        return imageGenerationInFlight ? " while generating an image" : string.Empty;
    }

    private static string DescribeIdleRemedy(bool imageGenerationInFlight)
    {
        return imageGenerationInFlight
            ? "Raise imageStreamIdleTimeoutSeconds (0 waits indefinitely), or enable partial " +
                "images so the provider reports progress while it renders."
            : "Set streamIdleTimeoutSeconds to 0 to disable the stream-idle deadline.";
    }

    public static async Task<string> ReadErrorBodyAsync(
        HttpContent content,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken)
    {
        var configured = ResolveStreamIdle(provider);
        if (configured is not { } timeout)
        {
            return await content.ReadAsStringAsync(cancellationToken);
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try
        {
            return await content.ReadAsStringAsync(deadline.Token);
        }
        catch (OperationCanceledException ex)
            when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"{providerLabel} error response body did not finish within " +
                $"{timeout.TotalSeconds:0}s. Set streamIdleTimeoutSeconds to 0 to disable " +
                "the response-body deadline.",
                ex);
        }
    }

    /// <summary>
    /// Sends a streaming provider request bounded by the configured timeout. The returned response
    /// is read headers-first and the deadline stops once the headers arrive, so the caller can
    /// stream for as long as the provider keeps producing events.
    /// </summary>
    public static async Task<HttpResponseMessage> SendAsync(
        HttpClient http,
        HttpRequestMessage request,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken)
    {
        var host = request.RequestUri?.Host;

        var configured = Resolve(provider);

        try
        {
            if (configured is not { } timeout)
            {
                return await http.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken);
            }

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(timeout);
            try
            {
                return await http.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    deadline.Token);
            }
            catch (OperationCanceledException ex)
                when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                // Distinguish "the deadline elapsed" from "the user cancelled the run", which would
                // otherwise both surface as an indistinguishable OperationCanceledException. The
                // dedicated type lets the outer policy retry this safe pre-stream failure without
                // replaying stream-idle timeouts that may have already emitted content or tools.
                throw new AgentRuntimeProviderRequestTimeoutException(
                    $"{providerLabel} did not return response headers within {timeout.TotalSeconds:0}s. " +
                    "Raise the API request timeout in Settings (0 waits indefinitely) if this model " +
                    "needs longer before it starts responding.",
                    ex);
            }
        }
        catch (Exception ex) when (
            ex is not OperationCanceledException and not TimeoutException &&
            !cancellationToken.IsCancellationRequested &&
            WorkerHttpFaultClassifier.Classify(ex, host) is { Retryable: true } fault)
        {
            // Nothing has been streamed yet, so replay is unconditionally safe here.
            throw new AgentRuntimeProviderTransportException(
                providerLabel,
                fault,
                anyEventsEmitted: false,
                ex);
        }
    }

    /// <summary>
    /// Reads one SSE line with the idle deadline applied, classifying any transport fault raised
    /// while the body was already streaming. Without this the raw HttpRequestException /
    /// HttpIOException escapes the retry policy entirely and kills a turn that minutes of healthy
    /// streaming had invested — the classic "the network is fine but the run died" failure.
    /// Whether the interrupted turn may be replayed is the retry policy's call, not this one's.
    /// </summary>
    public static async ValueTask<string?> ReadLineAsync(
        StreamReader reader,
        AgentRuntimeStreamIdleGate idleGate,
        JsonElement provider,
        string providerLabel,
        string requestUrl,
        CancellationToken cancellationToken,
        bool imageGenerationInFlight = false)
    {
        try
        {
            return await ReadLineCoreAsync(
                reader,
                idleGate,
                provider,
                providerLabel,
                cancellationToken,
                imageGenerationInFlight);
        }
        catch (Exception ex) when (
            ex is not OperationCanceledException and not TimeoutException &&
            !cancellationToken.IsCancellationRequested &&
            WorkerHttpFaultClassifier.Classify(
                ex,
                WorkerHttpFaultClassifier.ResolveHost(requestUrl)) is { Retryable: true } fault)
        {
            throw new AgentRuntimeProviderStreamTransportException(providerLabel, fault, ex);
        }
    }
}
