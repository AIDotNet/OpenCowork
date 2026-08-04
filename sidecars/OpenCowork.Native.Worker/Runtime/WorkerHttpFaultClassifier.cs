using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Authentication;

/// <summary>
/// Classifies a network failure into a retry verdict.
///
/// EVERY signal used here is a type or an enum. Nothing reads <see cref="Exception.Message"/>.
/// The worker publishes with UseSystemResourceKeys=true, which degrades framework exception
/// messages to resource keys (IO_FileNotFound_FileName and friends) in release builds, so any
/// message-matching classifier silently stops matching once shipped. Enum values stringify
/// normally, so they stay usable in both dev and published builds.
/// </summary>
internal enum WorkerHttpFaultKind
{
    /// <summary>Not a network fault, or a fault that will not improve on retry.</summary>
    Terminal,
    /// <summary>Name resolution failed.</summary>
    Dns,
    /// <summary>The connection could not be established.</summary>
    Connect,
    /// <summary>The TLS handshake broke before certificate validation ran.</summary>
    TlsHandshake,
    /// <summary>The peer's certificate was rejected. Retrying cannot fix this.</summary>
    TlsCertificate,
    /// <summary>An established connection was reset or aborted.</summary>
    Reset,
    /// <summary>The response body ended before the stream was complete.</summary>
    StreamEnded,
    /// <summary>The proxy tunnel could not be established.</summary>
    Proxy
}

internal readonly record struct WorkerHttpFault(
    WorkerHttpFaultKind Kind,
    bool Retryable,
    WorkerHttpRetryBudget Budget,
    string Code,
    string? Detail)
{
    public static readonly WorkerHttpFault Terminal =
        new(WorkerHttpFaultKind.Terminal, false, WorkerHttpRetryBudget.None, "terminal", null);
}

internal enum WorkerHttpRetryBudget
{
    None,
    /// <summary>Misconfiguration-shaped faults: fail fast so the real problem surfaces.</summary>
    Config,
    /// <summary>Transient link faults: worth a few quick attempts.</summary>
    Transport
}

/// <summary>
/// Remembers which hosts failed certificate validation, so a TLS failure can be split into
/// "the certificate is bad" (terminal) and "the handshake was interrupted" (transient).
///
/// AuthenticationException on its own cannot distinguish the two, and its message is a resource
/// key in published builds. Recording the SslPolicyErrors at validation time is the only way to
/// tell them apart without reading message text.
/// </summary>
internal static class WorkerTlsRejectionLedger
{
    private const int MaxEntries = 64;
    private static readonly TimeSpan EntryTtl = TimeSpan.FromSeconds(10);
    private static readonly ConcurrentDictionary<string, Entry> Entries =
        new(StringComparer.OrdinalIgnoreCase);

    public static void Record(string host, SslPolicyErrors errors)
    {
        if (string.IsNullOrWhiteSpace(host) || errors == SslPolicyErrors.None)
        {
            return;
        }

        if (Entries.Count >= MaxEntries)
        {
            PruneExpired();
            if (Entries.Count >= MaxEntries)
            {
                return;
            }
        }

        Entries[host] = new Entry(errors, DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Returns the recorded policy errors when this host failed validation recently. A miss means
    /// validation never rejected anything, so a TLS failure came from the handshake itself.
    /// </summary>
    public static bool TryGetRecent(string host, out SslPolicyErrors errors)
    {
        errors = SslPolicyErrors.None;
        if (string.IsNullOrWhiteSpace(host) || !Entries.TryGetValue(host, out var entry))
        {
            return false;
        }

        if (DateTimeOffset.UtcNow - entry.RecordedAt > EntryTtl)
        {
            Entries.TryRemove(host, out _);
            return false;
        }

        errors = entry.Errors;
        return true;
    }

    private static void PruneExpired()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var pair in Entries)
        {
            if (now - pair.Value.RecordedAt > EntryTtl)
            {
                Entries.TryRemove(pair.Key, out _);
            }
        }
    }

    private readonly record struct Entry(SslPolicyErrors Errors, DateTimeOffset RecordedAt);
}

internal static class WorkerHttpFaultClassifier
{
    private const int MaxInnerExceptionDepth = 8;

    /// <summary>
    /// Classifies an exception raised while sending a request or reading a response.
    /// </summary>
    /// <param name="host">
    /// Request host, used to consult the TLS rejection ledger. Pass null when unknown; a TLS
    /// failure then classifies as a transient handshake fault rather than a bad certificate.
    /// </param>
    public static WorkerHttpFault Classify(Exception exception, string? host)
    {
        // A SocketException anywhere in the chain is the most specific signal available, so it is
        // resolved first. This matters most for TLS: an AuthenticationException wrapping a
        // connection reset is a link fault worth retrying, even when that host also has a
        // certificate rejection on record from an earlier request.
        foreach (var candidate in EnumerateChain(exception))
        {
            if (candidate is SocketException socketException)
            {
                var socketFault = ClassifySocketError(socketException.SocketErrorCode);
                if (socketFault.Kind != WorkerHttpFaultKind.Terminal)
                {
                    return socketFault;
                }
            }
        }

        foreach (var candidate in EnumerateChain(exception))
        {
            var fault = ClassifySingle(candidate, host);
            if (fault.Kind != WorkerHttpFaultKind.Terminal)
            {
                return fault;
            }
        }

        return WorkerHttpFault.Terminal;
    }

    public static bool IsRetryable(Exception exception, string? host)
    {
        return Classify(exception, host).Retryable;
    }

    /// <summary>
    /// Extracts the host from a URL for ledger lookups, without throwing on a malformed URL.
    /// </summary>
    public static string? ResolveHost(string? url)
    {
        return Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Host : null;
    }

    private static WorkerHttpFault ClassifySingle(Exception exception, string? host)
    {
        return exception switch
        {
            // A socket error carries the most specific signal available, so it is checked before
            // the HttpRequestException that usually wraps it.
            SocketException socketException => ClassifySocketError(socketException.SocketErrorCode),
            AuthenticationException => ClassifyTlsFailure(host),
            HttpRequestException httpException => ClassifyHttpRequestError(httpException, host),
            // HttpIOException derives from IOException and reports why the body stopped.
            HttpIOException httpIoException => ClassifyHttpRequestError(httpIoException.HttpRequestError, host),
            // A bare IOException on a network stream means the connection died mid-read.
            IOException => Retryable(
                WorkerHttpFaultKind.StreamEnded,
                WorkerHttpRetryBudget.Transport,
                "stream_ended"),
            WebSocketException webSocketException => ClassifyWebSocketError(webSocketException),
            _ => WorkerHttpFault.Terminal
        };
    }

    private static WorkerHttpFault ClassifyHttpRequestError(HttpRequestException exception, string? host)
    {
        // A response-status failure is not a transport fault; the status-code retry path owns it.
        return exception.StatusCode.HasValue
            ? WorkerHttpFault.Terminal
            : ClassifyHttpRequestError(exception.HttpRequestError, host);
    }

    private static WorkerHttpFault ClassifyHttpRequestError(HttpRequestError error, string? host)
    {
        return error switch
        {
            HttpRequestError.NameResolutionError => Retryable(
                WorkerHttpFaultKind.Dns,
                // A misspelled base URL is far more common than flaky DNS, so fail fast.
                WorkerHttpRetryBudget.Config,
                "dns"),
            HttpRequestError.ConnectionError => Retryable(
                WorkerHttpFaultKind.Connect,
                WorkerHttpRetryBudget.Transport,
                "connect"),
            HttpRequestError.SecureConnectionError => ClassifyTlsFailure(host),
            HttpRequestError.ProxyTunnelError => Retryable(
                WorkerHttpFaultKind.Proxy,
                WorkerHttpRetryBudget.Config,
                "proxy"),
            HttpRequestError.ResponseEnded => Retryable(
                WorkerHttpFaultKind.StreamEnded,
                WorkerHttpRetryBudget.Transport,
                "stream_ended"),
            HttpRequestError.InvalidResponse => Retryable(
                WorkerHttpFaultKind.StreamEnded,
                WorkerHttpRetryBudget.Config,
                "invalid_response"),
            _ => WorkerHttpFault.Terminal
        };
    }

    /// <summary>
    /// Splits a TLS failure using the rejection ledger: a recorded validation failure means the
    /// certificate itself is unacceptable and no number of retries will change that, while no
    /// record means the handshake broke before validation and is worth retrying.
    /// </summary>
    private static WorkerHttpFault ClassifyTlsFailure(string? host)
    {
        if (host is not null && WorkerTlsRejectionLedger.TryGetRecent(host, out var policyErrors))
        {
            return new WorkerHttpFault(
                WorkerHttpFaultKind.TlsCertificate,
                Retryable: false,
                WorkerHttpRetryBudget.None,
                "tls_cert",
                DescribePolicyErrors(policyErrors));
        }

        return Retryable(
            WorkerHttpFaultKind.TlsHandshake,
            WorkerHttpRetryBudget.Config,
            "tls_handshake");
    }

    private static WorkerHttpFault ClassifySocketError(SocketError error)
    {
        return error switch
        {
            SocketError.ConnectionReset or
            SocketError.ConnectionAborted or
            SocketError.NetworkReset or
            SocketError.Interrupted => Retryable(
                WorkerHttpFaultKind.Reset,
                WorkerHttpRetryBudget.Transport,
                "reset"),

            SocketError.ConnectionRefused or
            SocketError.HostUnreachable or
            SocketError.NetworkUnreachable or
            SocketError.NetworkDown or
            SocketError.TimedOut or
            SocketError.AddressNotAvailable or
            SocketError.NoData => Retryable(
                WorkerHttpFaultKind.Connect,
                WorkerHttpRetryBudget.Transport,
                "connect"),

            SocketError.HostNotFound or
            SocketError.TryAgain => Retryable(
                WorkerHttpFaultKind.Dns,
                WorkerHttpRetryBudget.Config,
                "dns"),

            // AccessDenied, AddressFamilyNotSupported, ProtocolNotSupported, InvalidArgument and
            // friends are configuration or environment problems; retrying only hides them.
            _ => WorkerHttpFault.Terminal
        };
    }

    private static WorkerHttpFault ClassifyWebSocketError(WebSocketException exception)
    {
        return exception.WebSocketErrorCode switch
        {
            WebSocketError.ConnectionClosedPrematurely or
            WebSocketError.Faulted or
            WebSocketError.HeaderError or
            WebSocketError.InvalidState => Retryable(
                WorkerHttpFaultKind.Reset,
                WorkerHttpRetryBudget.Transport,
                "ws_closed"),

            // NotAWebSocket / UnsupportedProtocol / UnsupportedVersion mean this endpoint does not
            // speak WebSocket. The Responses provider already falls back to HTTP SSE for those.
            _ => WorkerHttpFault.Terminal
        };
    }

    private static WorkerHttpFault Retryable(
        WorkerHttpFaultKind kind,
        WorkerHttpRetryBudget budget,
        string code)
    {
        return new WorkerHttpFault(kind, Retryable: true, budget, code, null);
    }

    private static string DescribePolicyErrors(SslPolicyErrors errors)
    {
        var parts = new List<string>(3);
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable))
        {
            parts.Add("certificate not provided");
        }
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch))
        {
            parts.Add("hostname mismatch");
        }
        if (errors.HasFlag(SslPolicyErrors.RemoteCertificateChainErrors))
        {
            parts.Add("untrusted or expired certificate chain");
        }
        return parts.Count > 0 ? string.Join(", ", parts) : errors.ToString();
    }

    private static IEnumerable<Exception> EnumerateChain(Exception exception)
    {
        var current = exception;
        for (var depth = 0; current is not null && depth < MaxInnerExceptionDepth; depth++)
        {
            if (current is AggregateException aggregate)
            {
                foreach (var inner in aggregate.InnerExceptions)
                {
                    yield return inner;
                }
            }
            else
            {
                yield return current;
            }

            current = current.InnerException;
        }
    }
}
