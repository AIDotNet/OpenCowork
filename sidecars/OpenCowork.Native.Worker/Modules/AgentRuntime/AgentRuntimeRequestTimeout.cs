using System.Net.WebSockets;
using System.Text.Json;

// Provider HTTP requests go through a shared static HttpClient, and HttpClient.Timeout can no
// longer be reassigned once that client has dispatched its first request. A user-configurable
// deadline therefore cannot live on the client: the provider clients are created with
// Timeout.InfiniteTimeSpan and the deadline is applied per request here instead.
//
// The request deadline covers response headers. Every provider sends with
// HttpCompletionOption.ResponseHeadersRead, so that countdown is dropped when headers arrive.
// Body reads then use a separate reset-on-line/frame stream-idle deadline: healthy streams can run
// indefinitely, while a provider that silently stalls cannot retain a Job slot forever.
//
// This is also where transport faults are classified. Everything raised here happens before any
// response body is read, so a failure at this point is always safe to replay — no events have
// reached the UI yet.
internal static class AgentRuntimeRequestTimeout
{
    // Mirrors HttpClient's historical default so behaviour is unchanged when unset.
    public const int DefaultTimeoutSeconds = 100;
    public const int DefaultStreamIdleTimeoutSeconds = 120;

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

    public static TimeSpan? ResolveStreamIdle(JsonElement provider)
    {
        var seconds = JsonHelpers.GetIntNullable(provider, "streamIdleTimeoutSeconds")
            ?? ReadEnvironmentStreamIdleTimeout()
            ?? DefaultStreamIdleTimeoutSeconds;
        return seconds > 0 ? TimeSpan.FromSeconds(seconds) : null;
    }

    private static int? ReadEnvironmentStreamIdleTimeout()
    {
        var raw = Environment.GetEnvironmentVariable(
            "OPEN_COWORK_AGENT_STREAM_IDLE_TIMEOUT_SECONDS");
        return int.TryParse(raw, out var value) ? value : null;
    }

    public static async ValueTask<string?> ReadLineAsync(
        StreamReader reader,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken)
    {
        var configured = ResolveStreamIdle(provider);
        if (configured is not { } timeout)
        {
            return await reader.ReadLineAsync(cancellationToken);
        }

        using var idle = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        idle.CancelAfter(timeout);
        try
        {
            return await reader.ReadLineAsync(idle.Token);
        }
        catch (OperationCanceledException ex)
            when (idle.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"{providerLabel} stream produced no data for {timeout.TotalSeconds:0}s. " +
                "Set streamIdleTimeoutSeconds to 0 to disable the stream-idle deadline.",
                ex);
        }
    }

    public static async Task<WebSocketReceiveResult> ReceiveWebSocketAsync(
        ClientWebSocket socket,
        ArraySegment<byte> buffer,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken)
    {
        var configured = ResolveStreamIdle(provider);
        if (configured is not { } timeout)
        {
            return await socket.ReceiveAsync(buffer, cancellationToken);
        }

        using var idle = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        idle.CancelAfter(timeout);
        try
        {
            return await socket.ReceiveAsync(buffer, idle.Token);
        }
        catch (OperationCanceledException ex)
            when (idle.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"{providerLabel} WebSocket produced no frame for {timeout.TotalSeconds:0}s. " +
                "Set streamIdleTimeoutSeconds to 0 to disable the stream-idle deadline.",
                ex);
        }
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
                // otherwise both surface as an indistinguishable OperationCanceledException.
                // This is deliberately NOT retried: the user's chosen deadline is honoured once
                // rather than being silently multiplied by the retry count.
                throw new TimeoutException(
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
}
