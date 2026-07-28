using System.Net;

internal static class WorkerHttpClientFactory
{
    /// <summary>
    /// Creates a pooled HttpClient. When <paramref name="timeout"/> is omitted the client keeps
    /// HttpClient's 100s default; pass <see cref="Timeout.InfiniteTimeSpan"/> to opt out and bound
    /// each request with a linked CancellationTokenSource instead. A user-configurable deadline
    /// must take that route, because HttpClient.Timeout can no longer be reassigned once the
    /// client has dispatched its first request.
    /// </summary>
    public static HttpClient Create(
        TimeSpan? timeout = null,
        bool allowAutoRedirect = true,
        int maxAutomaticRedirections = 10)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = allowAutoRedirect,
            MaxAutomaticRedirections = maxAutomaticRedirections,
            PooledConnectionIdleTimeout = WorkerMemory.HttpConnectionIdleTimeout,
            PooledConnectionLifetime = WorkerMemory.HttpConnectionLifetime,
            MaxConnectionsPerServer = WorkerMemory.HttpMaxConnectionsPerServer,
            UseProxy = true,
            AutomaticDecompression = DecompressionMethods.None
        };
        var client = new HttpClient(handler, disposeHandler: true);
        if (timeout.HasValue)
        {
            client.Timeout = timeout.Value;
        }
        return client;
    }
}
