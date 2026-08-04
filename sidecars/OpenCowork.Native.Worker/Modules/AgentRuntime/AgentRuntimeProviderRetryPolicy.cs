using System.Diagnostics;
using System.Net;

internal sealed class AgentRuntimeProviderHttpException : InvalidOperationException
{
    public AgentRuntimeProviderHttpException(
        string providerName,
        HttpStatusCode statusCode,
        string responseBody,
        TimeSpan? retryAfter)
        : base($"{providerName} request failed HTTP {(int)statusCode}: {responseBody}")
    {
        StatusCode = (int)statusCode;
        RetryAfter = retryAfter;
    }

    public int StatusCode { get; }

    public TimeSpan? RetryAfter { get; }

    public static async Task<AgentRuntimeProviderHttpException> CreateAsync(
        string providerName,
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
        return new AgentRuntimeProviderHttpException(
            providerName,
            response.StatusCode,
            responseBody,
            response.Headers.RetryAfter?.Delta);
    }
}

/// <summary>
/// Raised when a provider request fails below the HTTP status layer: DNS, connect, TLS, or a
/// connection reset. Carries the classified fault plus whether the stream had already emitted
/// events, because that decides whether replaying the request is safe.
/// </summary>
internal sealed class AgentRuntimeProviderTransportException : InvalidOperationException
{
    public AgentRuntimeProviderTransportException(
        string providerName,
        WorkerHttpFault fault,
        bool anyEventsEmitted,
        Exception innerException)
        : base(BuildMessage(providerName, fault), innerException)
    {
        Fault = fault;
        AnyEventsEmitted = anyEventsEmitted;
    }

    public WorkerHttpFault Fault { get; }

    /// <summary>
    /// True when the provider had already streamed at least one event before failing. Replaying
    /// then would duplicate text and tool calls in the UI, since the renderer appends deltas and
    /// cannot roll them back.
    /// </summary>
    public bool AnyEventsEmitted { get; }

    private static string BuildMessage(string providerName, WorkerHttpFault fault)
    {
        var reason = fault.Kind switch
        {
            WorkerHttpFaultKind.Dns =>
                "the server address could not be resolved. Check the Base URL and your DNS or proxy settings.",
            WorkerHttpFaultKind.Connect =>
                "the connection could not be established. Check your network, the Base URL, and any proxy.",
            WorkerHttpFaultKind.TlsHandshake =>
                "the TLS handshake failed. This is often a proxy or firewall interfering with the connection.",
            WorkerHttpFaultKind.TlsCertificate => fault.Detail is { Length: > 0 } detail
                ? $"the server's TLS certificate was rejected ({detail}). Check the system clock, your proxy's root certificate, or enable the provider's insecure-TLS option if this is an internal server."
                : "the server's TLS certificate was rejected. Check the system clock or your proxy's root certificate.",
            WorkerHttpFaultKind.Reset => "the connection was reset.",
            WorkerHttpFaultKind.StreamEnded => "the response ended before it was complete.",
            WorkerHttpFaultKind.Proxy =>
                "the proxy tunnel could not be established. Check your proxy settings and credentials.",
            _ => "the request failed."
        };
        return $"{providerName} request failed: {reason}";
    }
}

internal static class AgentRuntimeProviderRetryPolicy
{
    public static async Task<AgentRuntimeProviderTurnResult> ExecuteAsync(
        Func<Task<AgentRuntimeProviderTurnResult>> execute,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var statusAttempts = 0;
        var transportAttempts = 0;
        var previousStatusDelayMs = 0;
        var startedAt = Stopwatch.GetTimestamp();

        while (true)
        {
            try
            {
                return await execute();
            }
            catch (AgentRuntimeProviderHttpException ex) when (
                IsRetryableStatus(ex.StatusCode) &&
                statusAttempts < WorkerHttpTuning.StatusRetryAttempts &&
                !state.IsCancellationRequested &&
                HasTimeRemaining(startedAt))
            {
                statusAttempts++;
                var delayMs = ComputeStatusDelayMs(statusAttempts, previousStatusDelayMs, ex.RetryAfter);
                previousStatusDelayMs = delayMs;

                WorkerLog.Warn(
                    $"provider request HTTP {ex.StatusCode}; retrying in {delayMs}ms " +
                    $"attempt={statusAttempts}/{WorkerHttpTuning.StatusRetryAttempts}");
                await EmitRetryAsync(
                    state,
                    context,
                    $"HTTP {ex.StatusCode}",
                    statusAttempts,
                    WorkerHttpTuning.StatusRetryAttempts,
                    delayMs,
                    ex.StatusCode);
                await Task.Delay(delayMs, state.CancellationToken);
            }
            catch (AgentRuntimeProviderTransportException ex) when (
                CanRetryTransport(ex, transportAttempts, state, startedAt))
            {
                transportAttempts++;
                var maxAttempts = WorkerHttpTuning.ResolveAttempts(ex.Fault.Budget);
                var delayMs = ComputeTransportDelayMs(transportAttempts);

                WorkerLog.Warn(
                    $"provider transport fault={ex.Fault.Code}; retrying in {delayMs}ms " +
                    $"attempt={transportAttempts}/{maxAttempts}");
                await EmitRetryAsync(
                    state,
                    context,
                    ex.Fault.Code,
                    transportAttempts,
                    maxAttempts,
                    delayMs,
                    statusCode: null);
                await Task.Delay(delayMs, state.CancellationToken);
            }
        }
    }

    private static bool CanRetryTransport(
        AgentRuntimeProviderTransportException exception,
        int transportAttempts,
        AgentRuntimeTools.AgentRuntimeRunState state,
        long startedAt)
    {
        if (!WorkerHttpTuning.TransportRetryEnabled ||
            !exception.Fault.Retryable ||
            state.IsCancellationRequested ||
            !HasTimeRemaining(startedAt))
        {
            return false;
        }

        // Replaying after the provider has streamed events would duplicate text and tool calls,
        // because the renderer appends deltas and has no way to discard a partial message.
        if (exception.AnyEventsEmitted)
        {
            return false;
        }

        return transportAttempts < WorkerHttpTuning.ResolveAttempts(exception.Fault.Budget);
    }

    private static Task EmitRetryAsync(
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string reason,
        int attempt,
        int maxAttempts,
        int delayMs,
        int? statusCode)
    {
        return AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "request_retry",
                Reason: reason,
                Attempt: attempt,
                MaxAttempts: maxAttempts,
                DelayMs: delayMs,
                StatusCode: statusCode));
    }

    private static bool HasTimeRemaining(long startedAt)
    {
        return Stopwatch.GetElapsedTime(startedAt) < WorkerHttpTuning.MaxRetryElapsed;
    }

    private static bool IsRetryableStatus(int statusCode)
    {
        return statusCode == 429 || statusCode >= 500;
    }

    private static int ComputeStatusDelayMs(int attempt, int previousDelayMs, TimeSpan? retryAfter)
    {
        // A server-provided Retry-After is an instruction, not a suggestion: honour it as a floor
        // and only add jitter on top so concurrent runs do not resume in lockstep.
        if (retryAfter.HasValue)
        {
            var retryAfterMs = (int)Math.Clamp(
                retryAfter.Value.TotalMilliseconds,
                0,
                WorkerHttpTuning.MaxRetryAfterMs);
            return retryAfterMs + Random.Shared.Next(0, Math.Max(1, retryAfterMs / 5));
        }

        var delayMs = FullJitter(
            attempt,
            WorkerHttpTuning.StatusBaseDelayMs,
            WorkerHttpTuning.StatusMaxDelayMs);

        // Keep the previous floor-growth behaviour so a provider that keeps failing backs off
        // monotonically rather than bouncing back to a very short delay.
        return Math.Max(delayMs, Math.Min(previousDelayMs, WorkerHttpTuning.StatusMaxDelayMs));
    }

    private static int ComputeTransportDelayMs(int attempt)
    {
        return FullJitter(
            attempt,
            WorkerHttpTuning.TransportBaseDelayMs,
            WorkerHttpTuning.TransportMaxDelayMs);
    }

    /// <summary>
    /// Exponential backoff with full jitter: a uniform pick from [base/2, base]. Parallel
    /// sub-agents hammering one provider are exactly the thundering-herd case this avoids, which
    /// the previous fixed linear ladder did not.
    /// </summary>
    private static int FullJitter(int attempt, int baseDelayMs, int maxDelayMs)
    {
        var exponent = Math.Min(attempt - 1, 16);
        var ceiling = (int)Math.Min(maxDelayMs, (long)baseDelayMs << exponent);
        var floor = Math.Max(1, ceiling / 2);
        return Random.Shared.Next(floor, ceiling + 1);
    }
}
