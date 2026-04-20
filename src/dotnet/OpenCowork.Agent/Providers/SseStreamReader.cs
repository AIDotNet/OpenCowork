using System.Collections.Concurrent;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

/// <summary>
/// Generic zero-copy SSE stream reader using .NET 10's SseParser.
/// The SseItemParser delegate receives ReadOnlySpan&lt;byte&gt; -- no heap allocation
/// for the raw event data. Combined with System.Text.Json source generators,
/// deserialization happens directly from UTF-8 bytes.
/// </summary>
public static class SseStreamReader
{
    private sealed record TransportCircuitState(DateTimeOffset ExpiresAt, string Reason);

    private sealed class TransportCircuitOpenException : HttpRequestException
    {
        public DateTimeOffset ExpiresAt { get; }
        public string CircuitKey { get; }
        public string Reason { get; }

        public TransportCircuitOpenException(
            string message,
            string circuitKey,
            DateTimeOffset expiresAt,
            string reason,
            Exception? innerException = null)
            : base(message, innerException)
        {
            CircuitKey = circuitKey;
            ExpiresAt = expiresAt;
            Reason = reason;
        }
    }

    private static readonly ConcurrentDictionary<string, TransportCircuitState> TransportCircuitBreakers = new(StringComparer.Ordinal);
    private static readonly TimeSpan TransportCircuitBreakDuration = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Read SSE events from an HTTP response stream, deserializing each event's
    /// data payload directly from the raw byte span using source-generated JSON.
    /// </summary>
    public static async IAsyncEnumerable<T> ReadAsync<T>(
        Stream stream,
        SseItemParser<T?> parser,
        [EnumeratorCancellation] CancellationToken ct = default) where T : class
    {
        var sseParser = SseParser.Create(stream, parser);

        await foreach (var item in sseParser.EnumerateAsync(ct))
        {
            if (item.Data is not null)
                yield return item.Data;
        }
    }

    /// <summary>
    /// Fast-path check for the [DONE] sentinel at the byte level.
    /// Avoids allocating a string to compare against "[DONE]".
    /// </summary>
    public static bool IsDoneSentinel(ReadOnlySpan<byte> data)
    {
        return data.Length == 6 &&
               data[0] == (byte)'[' &&
               data[1] == (byte)'D' &&
               data[2] == (byte)'O' &&
               data[3] == (byte)'N' &&
               data[4] == (byte)'E' &&
               data[5] == (byte)']';
    }

    /// <summary>
    /// Max number of retry attempts for retryable HTTP status failures
    /// (HTTP 429 and all 5xx responses).
    /// </summary>
    private const int MaxHttpStatusRetryAttempts = 10;

    /// <summary>
    /// Max number of retry attempts for retryable transport failures before
    /// opening a short-lived provider circuit for the same provider endpoint.
    /// </summary>
    private const int MaxTransportRetryAttempts = 3;

    private static readonly Random RetryJitter = new();

    public static string BuildTransportCircuitKey(string scope, string url)
    {
        var normalizedScope = string.IsNullOrWhiteSpace(scope) ? "unknown" : scope.Trim();

        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return $"{normalizedScope}::{uri.GetLeftPart(UriPartial.Authority)}";

        return $"{normalizedScope}::{url}";
    }

    public static StreamEventError CreateTransportError(HttpRequestException ex)
    {
        return new StreamEventError
        {
            Type = ex is TransportCircuitOpenException
                ? "transport_circuit_open"
                : "transport_error",
            Message = ex.Message
        };
    }

    /// <summary>
    /// Create an HttpRequestMessage configured for SSE streaming.
    /// Uses ResponseHeadersRead to avoid buffering the response body.
    /// Transparently retries on HTTP 429/500 and retryable transport failures
    /// with exponential backoff + jitter, then opens a short-lived circuit.
    /// Honors the Retry-After header when present.
    /// </summary>
    public static async Task<HttpResponseMessage> SendStreamingRequestAsync(
        HttpClient client,
        string url,
        string method,
        Dictionary<string, string> headers,
        byte[]? body,
        CancellationToken ct,
        string? circuitKey = null)
    {
        var normalizedCircuitKey = string.IsNullOrWhiteSpace(circuitKey)
            ? BuildTransportCircuitKey("default", url)
            : circuitKey.Trim();

        if (TryGetTransportCircuitState(normalizedCircuitKey, out var openCircuit))
        {
            throw new TransportCircuitOpenException(
                BuildOpenCircuitMessage(method, url, openCircuit),
                normalizedCircuitKey,
                openCircuit.ExpiresAt,
                openCircuit.Reason);
        }

        var httpStatusAttempt = 0;
        var transportAttempt = 0;
        while (true)
        {
            var request = new HttpRequestMessage(
                method == "POST" ? HttpMethod.Post : HttpMethod.Get,
                url);

            foreach (var (key, value) in headers)
                request.Headers.TryAddWithoutValidation(key, value);

            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.TryAddWithoutValidation("Content-Type", "application/json");
            }

            HttpResponseMessage response;
            try
            {
                response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            }
            catch (HttpRequestException ex) when (IsRetryableTransportFailure(ex))
            {
                request.Dispose();
                if (transportAttempt < MaxTransportRetryAttempts)
                {
                    var delay = ComputeRetryDelay(transportAttempt);
                    transportAttempt++;
                    await Task.Delay(delay, ct);
                    continue;
                }

                var state = OpenTransportCircuit(normalizedCircuitKey, ex);
                throw new TransportCircuitOpenException(
                    BuildOpenCircuitMessage(method, url, state),
                    normalizedCircuitKey,
                    state.ExpiresAt,
                    state.Reason,
                    ex);
            }
            catch (HttpRequestException ex)
            {
                request.Dispose();
                throw new HttpRequestException($"Failed to send {method} {url}: {ex.Message}", ex, ex.StatusCode);
            }
            catch
            {
                request.Dispose();
                throw;
            }

            var status = (int)response.StatusCode;
            if (IsRetryableHttpStatus(status) && httpStatusAttempt < MaxHttpStatusRetryAttempts)
            {
                var delay = ComputeRetryDelay(httpStatusAttempt, response);
                response.Dispose();
                request.Dispose();
                httpStatusAttempt++;
                await Task.Delay(delay, ct);
                continue;
            }

            if (ShouldOpenCircuitForStatus(status))
            {
                OpenProviderCircuit(normalizedCircuitKey, $"HTTP {status}");
                return response;
            }

            ResetTransportCircuit(normalizedCircuitKey);

            // Caller owns the response from here on. The request message must
            // live as long as the response stream, so we deliberately do not
            // dispose it here -- the framework will clean it up when the
            // response is disposed.
            return response;
        }
    }

    private static TimeSpan ComputeRetryDelay(int attempt, HttpResponseMessage response)
    {
        // Honor Retry-After first (seconds or HTTP date).
        var retryAfter = response.Headers.RetryAfter;
        if (retryAfter is not null)
        {
            if (retryAfter.Delta is { } delta && delta > TimeSpan.Zero)
                return CapDelay(delta);
            if (retryAfter.Date is { } date)
            {
                var diff = date - DateTimeOffset.UtcNow;
                if (diff > TimeSpan.Zero)
                    return CapDelay(diff);
            }
        }

        return ComputeRetryDelay(attempt);
    }

    private static TimeSpan ComputeRetryDelay(int attempt)
    {
        // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s, with +/-25% jitter.
        var baseMs = Math.Min(30_000d, 1000d * Math.Pow(2, attempt));
        double jitter;
        lock (RetryJitter)
        {
            jitter = (RetryJitter.NextDouble() * 0.5) - 0.25; // [-0.25, +0.25)
        }
        var jittered = baseMs * (1.0 + jitter);
        return TimeSpan.FromMilliseconds(Math.Max(100, jittered));
    }

    public static bool IsRetryableTransportFailure(Exception ex)
    {
        return EnumerateExceptionChain(ex).Any(static candidate =>
            candidate is IOException ioEx && HasRetryableTransportMessage(ioEx.Message)
            || candidate is HttpRequestException httpEx
                && httpEx.StatusCode is null
                && HasRetryableTransportMessage(httpEx.Message));
    }

    public static HttpRequestException RememberRetryableTransportFailure(string circuitKey, Exception ex)
    {
        var wrapped = ex as HttpRequestException ?? new HttpRequestException(ex.Message, ex);
        if (IsRetryableTransportFailure(wrapped))
            OpenTransportCircuit(circuitKey, wrapped);
        return wrapped;
    }

    private static bool HasRetryableTransportMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
            return false;

        return message.Contains("The SSL connection could not be established", StringComparison.OrdinalIgnoreCase)
            || message.Contains("Received an unexpected EOF or 0 bytes from the transport stream", StringComparison.OrdinalIgnoreCase)
            || message.Contains("The response ended prematurely", StringComparison.OrdinalIgnoreCase)
            || message.Contains("ResponseEnded", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<Exception> EnumerateExceptionChain(Exception ex)
    {
        for (Exception? current = ex; current is not null; current = current.InnerException)
            yield return current;
    }

    private static bool TryGetTransportCircuitState(string circuitKey, out TransportCircuitState state)
    {
        if (TransportCircuitBreakers.TryGetValue(circuitKey, out state!))
        {
            if (state.ExpiresAt > DateTimeOffset.UtcNow)
                return true;

            TransportCircuitBreakers.TryRemove(circuitKey, out _);
        }

        state = null!;
        return false;
    }

    private static TransportCircuitState OpenTransportCircuit(string circuitKey, HttpRequestException ex)
    {
        var state = new TransportCircuitState(
            DateTimeOffset.UtcNow.Add(TransportCircuitBreakDuration),
            NormalizeTransportFailureReason(ex));
        return OpenProviderCircuit(circuitKey, state);
    }

    private static TransportCircuitState OpenProviderCircuit(string circuitKey, string reason)
    {
        var state = new TransportCircuitState(
            DateTimeOffset.UtcNow.Add(TransportCircuitBreakDuration),
            reason.Trim());
        return OpenProviderCircuit(circuitKey, state);
    }

    private static TransportCircuitState OpenProviderCircuit(string circuitKey, TransportCircuitState state)
    {
        TransportCircuitBreakers[circuitKey] = state;
        return state;
    }

    private static void ResetTransportCircuit(string circuitKey)
    {
        TransportCircuitBreakers.TryRemove(circuitKey, out _);
    }

    private static string NormalizeTransportFailureReason(HttpRequestException ex)
    {
        foreach (var candidate in EnumerateExceptionChain(ex))
        {
            if (string.IsNullOrWhiteSpace(candidate.Message))
                continue;

            if (HasRetryableTransportMessage(candidate.Message))
                return candidate.Message.Trim();
        }

        return string.IsNullOrWhiteSpace(ex.Message)
            ? ex.GetType().Name
            : ex.Message.Trim();
    }

    private static string BuildOpenCircuitMessage(
        string method,
        string url,
        TransportCircuitState state)
    {
        var remaining = state.ExpiresAt - DateTimeOffset.UtcNow;
        var remainingSeconds = Math.Max(1, (int)Math.Ceiling(remaining.TotalSeconds));
        return $"Failed to send {method} {url}: provider circuit is open for {remainingSeconds}s after repeated upstream failures. Last error: {state.Reason}";
    }

    private static bool IsRetryableHttpStatus(int status)
        => status == 429 || status >= 500;

    private static bool ShouldOpenCircuitForStatus(int status)
        => status >= 500;

    private static TimeSpan CapDelay(TimeSpan delay)
    {
        var max = TimeSpan.FromSeconds(60);
        return delay > max ? max : delay;
    }
}
