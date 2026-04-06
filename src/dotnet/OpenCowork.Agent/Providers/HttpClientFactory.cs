using System.Net;

namespace OpenCowork.Agent.Providers;

/// <summary>
/// Singleton pooled HttpClient per provider configuration.
/// Uses SocketsHttpHandler for connection pooling and proxy support.
/// </summary>
public sealed class LlmHttpClientFactory : IDisposable
{
    private readonly Dictionary<string, HttpClient> _clients = new();
    private readonly object _lock = new();

    public HttpClient GetClient(string? proxyUrl = null)
    {
        var normalizedProxyUrl = string.IsNullOrWhiteSpace(proxyUrl) ? null : proxyUrl.Trim();
        var key = normalizedProxyUrl ?? "__system__";

        lock (_lock)
        {
            if (_clients.TryGetValue(key, out var existing))
                return existing;

            var handler = new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
                PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
                MaxConnectionsPerServer = 3,
                EnableMultipleHttp2Connections = true,
                UseProxy = true,
                Proxy = normalizedProxyUrl is null ? HttpClient.DefaultProxy : new WebProxy(normalizedProxyUrl),
                DefaultProxyCredentials = normalizedProxyUrl is null ? CredentialCache.DefaultCredentials : null,
            };

            var client = new HttpClient(handler)
            {
                Timeout = Timeout.InfiniteTimeSpan
            };

            _clients[key] = client;
            return client;
        }
    }

    public void Dispose()
    {
        foreach (var client in _clients.Values)
            client.Dispose();
        _clients.Clear();
    }
}
