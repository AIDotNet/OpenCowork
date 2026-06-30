using System.Net;

internal static class WorkerHttpClientFactory
{
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
