using System.Net;

/// <summary>
/// Proxy resolution for every outbound worker request.
///
/// On macOS and Linux .NET builds <see cref="HttpClient.DefaultProxy"/> from environment variables
/// alone; it never reads the OS proxy settings that Electron's `mode: 'system'` honours. Since
/// every provider request is sent from this worker, a system-wide proxy (Clash, Surge, a corporate
/// PAC) would apply to the renderer while provider traffic went out direct — which on a restricted
/// network surfaces as resets and truncated SSE streams rather than as an obvious proxy error.
///
/// The host resolves the effective proxy with Chromium's resolver and pushes it here over
/// `network/set-proxy`. Until it does, DefaultProxy applies unchanged, so an environment-configured
/// proxy (and its no_proxy handling) behaves exactly as before. Resolution runs per request, so a
/// pushed change takes effect on the next request without recreating clients or restarting the
/// worker — which matters because neither HttpClient.DefaultProxy nor SocketsHttpHandler.Proxy can
/// be reassigned once a client has dispatched its first request.
/// </summary>
internal sealed class WorkerHttpProxy : IWebProxy
{
    public static WorkerHttpProxy Instance { get; } = new();

    private static volatile ProxyOverride? active;

    private WorkerHttpProxy()
    {
    }

    /// <summary>
    /// Unused: proxy credentials travel in the pushed URL's userinfo, which <see cref="WebProxy"/>
    /// semantics already cover. Present only to satisfy <see cref="IWebProxy"/>.
    /// </summary>
    public ICredentials? Credentials { get; set; }

    public Uri? GetProxy(Uri destination)
    {
        return active is { } o
            ? o.GetProxy(destination)
            : HttpClient.DefaultProxy.GetProxy(destination);
    }

    public bool IsBypassed(Uri host)
    {
        return active is { } o
            ? o.IsBypassed(host)
            : HttpClient.DefaultProxy.IsBypassed(host);
    }

    /// <summary>
    /// Installs a host-pushed proxy, replacing any previous one. A blank <paramref name="url"/>
    /// drops the override and hands resolution back to DefaultProxy. Returns a description of what
    /// is now in effect, for the host to log.
    /// </summary>
    public static string Configure(string? url, IReadOnlyList<string> bypass)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            active = null;
            return "default";
        }

        if (!TryParseProxyUri(url, out var proxyUri))
        {
            active = null;
            return "default (unparseable proxy url)";
        }

        active = new ProxyOverride(proxyUri, bypass);
        // Userinfo may carry credentials, so only the scheme and authority are reported back.
        return bypass.Count > 0
            ? $"{proxyUri.Scheme}://{proxyUri.Authority} bypass={bypass.Count}"
            : $"{proxyUri.Scheme}://{proxyUri.Authority}";
    }

    /// <summary>
    /// Accepts both a bare authority ("127.0.0.1:7890", which is how proxy UIs usually present
    /// themselves) and a full URL. A bare authority is assumed to be an HTTP proxy, matching how
    /// Chromium reads the same value.
    /// </summary>
    private static bool TryParseProxyUri(string value, out Uri proxyUri)
    {
        var trimmed = value.Trim();
        var candidate = trimmed.Contains("://", StringComparison.Ordinal)
            ? trimmed
            : $"http://{trimmed}";
        return Uri.TryCreate(candidate, UriKind.Absolute, out proxyUri!) &&
            proxyUri.Scheme is "http" or "https" or "socks4" or "socks4a" or "socks5";
    }

    private sealed class ProxyOverride
    {
        private readonly Uri proxy;
        private readonly string[] bypass;
        private readonly bool bypassEverything;

        public ProxyOverride(Uri proxy, IReadOnlyList<string> bypass)
        {
            this.proxy = proxy;
            this.bypass = [.. bypass
                .Select(entry => entry.Trim().TrimStart('.').ToLowerInvariant())
                .Where(entry => entry.Length > 0)];
            bypassEverything = this.bypass.Contains("*");
        }

        public Uri? GetProxy(Uri destination) => IsBypassed(destination) ? null : proxy;

        public bool IsBypassed(Uri host)
        {
            if (bypassEverything)
            {
                return true;
            }

            // Loopback never benefits from a proxy and routing it through one breaks local
            // gateways (Ollama, LM Studio, an MCP server on 127.0.0.1). Every proxy client
            // excludes it by default; matching that avoids a surprising regression.
            if (host.IsLoopback)
            {
                return true;
            }

            var target = host.Host;
            foreach (var entry in bypass)
            {
                // no_proxy semantics: an entry matches the host itself or any subdomain of it,
                // never an unrelated host that merely ends with the same characters.
                if (target.Equals(entry, StringComparison.OrdinalIgnoreCase) ||
                    (target.Length > entry.Length &&
                        target.EndsWith(entry, StringComparison.OrdinalIgnoreCase) &&
                        target[target.Length - entry.Length - 1] == '.'))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
