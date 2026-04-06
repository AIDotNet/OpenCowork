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
    /// Create an HttpRequestMessage configured for SSE streaming.
    /// Uses ResponseHeadersRead to avoid buffering the response body.
    /// </summary>
    public static async Task<HttpResponseMessage> SendStreamingRequestAsync(
        HttpClient client,
        string url,
        string method,
        Dictionary<string, string> headers,
        byte[]? body,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(
            method == "POST" ? HttpMethod.Post : HttpMethod.Get,
            url);

        foreach (var (key, value) in headers)
            request.Headers.TryAddWithoutValidation(key, value);

        if (body is not null)
        {
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.TryAddWithoutValidation("Content-Type", "application/json");
        }

        try
        {
            return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (HttpRequestException ex)
        {
            throw new HttpRequestException($"Failed to send {method} {url}: {ex.Message}", ex, ex.StatusCode);
        }
    }
}
