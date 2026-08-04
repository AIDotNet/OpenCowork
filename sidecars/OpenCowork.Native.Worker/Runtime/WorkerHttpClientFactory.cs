using System.Net;
using System.Net.Security;
using System.Net.Sockets;

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
            // Without this the OS default applies (~75s on macOS), so a black-holed route burns
            // most of the request deadline before failing and the user is told the model is slow.
            ConnectTimeout = WorkerHttpTuning.ConnectTimeout,
            UseProxy = true,
            AutomaticDecompression = DecompressionMethods.None,
            SslOptions = new SslClientAuthenticationOptions
            {
                RemoteCertificateValidationCallback = ValidateRemoteCertificate
            }
        };

        if (WorkerHttpTuning.TcpKeepAliveEnabled)
        {
            handler.ConnectCallback = ConnectWithKeepAliveAsync;
        }

        var client = new HttpClient(handler, disposeHandler: true);
        if (timeout.HasValue)
        {
            client.Timeout = timeout.Value;
        }
        return client;
    }

    /// <summary>
    /// Reproduces .NET's default accept policy exactly — chain building is unchanged and only
    /// an error-free chain is accepted. The single added effect is recording the policy errors,
    /// which lets <see cref="WorkerHttpFaultClassifier"/> tell a rejected certificate (terminal)
    /// apart from an interrupted handshake (transient). AuthenticationException alone cannot
    /// distinguish them, and its message is a resource key in published builds.
    /// </summary>
    private static bool ValidateRemoteCertificate(
        object sender,
        System.Security.Cryptography.X509Certificates.X509Certificate? certificate,
        System.Security.Cryptography.X509Certificates.X509Chain? chain,
        SslPolicyErrors sslPolicyErrors)
    {
        if (sslPolicyErrors == SslPolicyErrors.None)
        {
            return true;
        }

        WorkerTlsRejectionLedger.Record(ResolveValidationHost(sender), sslPolicyErrors);
        return false;
    }

    private static string ResolveValidationHost(object sender)
    {
        return sender switch
        {
            SslStream { TargetHostName: { Length: > 0 } targetHost } => targetHost,
            string host => host,
            _ => string.Empty
        };
    }

    /// <summary>
    /// Enables TCP keepalive on provider sockets. SocketsHttpHandler's KeepAlivePing settings are
    /// HTTP/2-only and do nothing on HTTP/1.1, which is what every provider negotiates today, so
    /// this is the only mechanism that turns a silently dead SSE socket into an IOException
    /// instead of a stream that hangs until the user gives up.
    /// </summary>
    private static async ValueTask<Stream> ConnectWithKeepAliveAsync(
        SocketsHttpConnectionContext context,
        CancellationToken cancellationToken)
    {
        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
            TrySetKeepAliveOption(
                socket,
                SocketOptionName.TcpKeepAliveTime,
                WorkerHttpTuning.TcpKeepAliveTimeSeconds);
            TrySetKeepAliveOption(
                socket,
                SocketOptionName.TcpKeepAliveInterval,
                WorkerHttpTuning.TcpKeepAliveIntervalSeconds);
            TrySetKeepAliveOption(
                socket,
                SocketOptionName.TcpKeepAliveRetryCount,
                WorkerHttpTuning.TcpKeepAliveRetryCount);

            await socket.ConnectAsync(context.DnsEndPoint, cancellationToken);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static void TrySetKeepAliveOption(Socket socket, SocketOptionName option, int value)
    {
        try
        {
            socket.SetSocketOption(SocketOptionLevel.Tcp, option, value);
        }
        catch (Exception ex) when (ex is SocketException or PlatformNotSupportedException)
        {
            // Individual keepalive tunables are not portable across every platform; the base
            // SO_KEEPALIVE above still applies with OS defaults.
        }
    }
}
