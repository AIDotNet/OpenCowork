using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace OpenCowork.Agent.Providers;

/// <summary>
/// Generic zero-copy SSE stream reader using .NET 10's SseParser.
/// The SseItemParser delegate receives ReadOnlySpan&lt;byte&gt; -- no heap allocation
/// for the raw event data. Combined with System.Text.Json source generators,
/// deserialization happens directly from UTF-8 bytes.
/// </summary>
public static class SseStreamReader
{
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
    /// Max number of retry attempts for transient streaming request failures
    /// (HTTP 500/429 and retryable SSL/EOF transport errors).
    /// Total requests sent = 1 initial + up to MaxRetryAttempts retries.
    /// </summary>
    private const int MaxRetryAttempts = 10;

    private static readonly Random RetryJitter = new();

    /// <summary>
    /// Create an HttpRequestMessage configured for SSE streaming.
    /// Uses ResponseHeadersRead to avoid buffering the response body.
    /// Transparently retries on HTTP 429/500 and retryable SSL/EOF transport failures
    /// with exponential backoff + jitter, up to <see cref="MaxRetryAttempts"/> times.
    /// Honors the Retry-After header when present.
    /// </summary>
    public static async Task<HttpResponseMessage> SendStreamingRequestAsync(
        HttpClient client,
        string url,
        string method,
        Dictionary<string, string> headers,
        byte[]? body,
        CancellationToken ct)
    {
        var attempt = 0;
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
            catch (HttpRequestException ex) when (attempt < MaxRetryAttempts && IsRetryableTransportException(ex))
            {
                request.Dispose();
                var delay = ComputeRetryDelay(attempt);
                attempt++;
                await Task.Delay(delay, ct);
                continue;
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
            if ((status == 500 || status == 429) && attempt < MaxRetryAttempts)
            {
                var delay = ComputeRetryDelay(attempt, response);
                response.Dispose();
                request.Dispose();
                attempt++;
                await Task.Delay(delay, ct);
                continue;
            }

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

    private static bool IsRetryableTransportException(HttpRequestException ex)
    {
        if (ex.StatusCode is not null)
            return false;

        return EnumerateExceptionChain(ex).Any(static candidate =>
            candidate is IOException ioEx && HasTransientSslTransportMessage(ioEx.Message)
            || candidate is HttpRequestException httpEx && HasTransientSslTransportMessage(httpEx.Message));
    }

    private static bool HasTransientSslTransportMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
            return false;

        return message.Contains("The SSL connection could not be established", StringComparison.OrdinalIgnoreCase)
            || message.Contains("Received an unexpected EOF or 0 bytes from the transport stream", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<Exception> EnumerateExceptionChain(Exception ex)
    {
        for (Exception? current = ex; current is not null; current = current.InnerException)
            yield return current;
    }

    private static TimeSpan CapDelay(TimeSpan delay)
    {
        var max = TimeSpan.FromSeconds(60);
        return delay > max ? max : delay;
    }
}
