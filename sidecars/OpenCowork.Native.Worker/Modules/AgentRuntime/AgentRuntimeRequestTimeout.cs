using System.Text.Json;

// Provider HTTP requests go through a shared static HttpClient, and HttpClient.Timeout can no
// longer be reassigned once that client has dispatched its first request. A user-configurable
// deadline therefore cannot live on the client: the provider clients are created with
// Timeout.InfiniteTimeSpan and the deadline is applied per request here instead.
//
// The deadline only needs to cover time-to-first-byte. Every provider sends with
// HttpCompletionOption.ResponseHeadersRead, so HttpClient.Timeout would equally have stopped
// applying once the response headers arrived; the countdown is dropped at that same point so a
// slow-but-healthy stream is never truncated.
//
// This is also where transport faults are classified. Everything raised here happens before any
// response body is read, so a failure at this point is always safe to replay — no events have
// reached the UI yet.
internal static class AgentRuntimeRequestTimeout
{
    // Mirrors HttpClient's historical default so behaviour is unchanged when unset.
    public const int DefaultTimeoutSeconds = 100;

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
