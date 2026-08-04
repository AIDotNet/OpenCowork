using System.Globalization;

/// <summary>
/// HTTP retry and connection knobs.
///
/// These live in the main repo rather than WorkerMemory (which is source-linked from the
/// CodeGraph submodule) so tuning them stays a one-repo change. The existing
/// OPEN_COWORK_NATIVE_HTTP_* variables read by WorkerMemory keep working — the values here
/// default to them where they overlap.
/// </summary>
internal static class WorkerHttpTuning
{
    /// <summary>Attempts for HTTP 429/5xx responses. Rate limits genuinely need this depth.</summary>
    public static int StatusRetryAttempts { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_STATUS_ATTEMPTS", 10, min: 0, max: 50);

    /// <summary>
    /// Attempts for transient link faults. Transport faults resolve within seconds or not at all,
    /// so a deep exponential ladder just freezes the UI for minutes on a dropped wifi link.
    /// </summary>
    public static int TransportRetryAttempts { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_TRANSPORT_ATTEMPTS", 4, min: 0, max: 20);

    /// <summary>
    /// Attempts for misconfiguration-shaped faults (DNS, proxy, TLS handshake). These are usually
    /// a wrong base URL or proxy setting, so failing fast surfaces the real problem.
    /// </summary>
    public static int ConfigRetryAttempts { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_CONFIG_ATTEMPTS", 2, min: 0, max: 10);

    /// <summary>
    /// Wall-clock ceiling across all retries of one provider turn. Without it, ten responses
    /// carrying Retry-After: 60 would stall a turn for ten minutes with no output.
    /// </summary>
    public static TimeSpan MaxRetryElapsed { get; } = TimeSpan.FromMilliseconds(ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_MAX_ELAPSED_MS", 300_000, min: 1_000, max: 3_600_000));

    public static int StatusBaseDelayMs { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_STATUS_BASE_MS", 1_000, min: 50, max: 60_000);

    public static int StatusMaxDelayMs { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_STATUS_MAX_MS", 30_000, min: 100, max: 300_000);

    public static int TransportBaseDelayMs { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_TRANSPORT_BASE_MS", 250, min: 50, max: 60_000);

    public static int TransportMaxDelayMs { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_TRANSPORT_MAX_MS", 8_000, min: 100, max: 300_000);

    /// <summary>Upper bound applied to a server-provided Retry-After.</summary>
    public static int MaxRetryAfterMs { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_RETRY_MAX_RETRY_AFTER_MS", 60_000, min: 0, max: 600_000);

    /// <summary>Escape hatch: set to 0 to restore the previous status-code-only behaviour.</summary>
    public static bool TransportRetryEnabled { get; } = ReadBool(
        "OPEN_COWORK_NATIVE_RETRY_TRANSPORT", true);

    /// <summary>
    /// TCP connect deadline. The OS default (~75s on macOS) means a black-holed route burns most
    /// of the request timeout before failing, and the user then sees a message about the model
    /// being slow — which is the wrong diagnosis.
    /// </summary>
    public static TimeSpan ConnectTimeout { get; } = TimeSpan.FromMilliseconds(ReadInt(
        "OPEN_COWORK_NATIVE_HTTP_CONNECT_MS", 10_000, min: 500, max: 120_000));

    /// <summary>
    /// TCP keepalive on provider sockets. HTTP/2's KeepAlivePing settings do nothing on HTTP/1.1,
    /// which is what every provider uses today, so this is the only thing that turns a silently
    /// dead SSE socket into an IOException instead of an indefinite hang.
    /// </summary>
    public static bool TcpKeepAliveEnabled { get; } = ReadBool(
        "OPEN_COWORK_NATIVE_HTTP_TCP_KEEPALIVE", true);

    public static int TcpKeepAliveTimeSeconds { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_HTTP_TCP_KEEPALIVE_TIME_S", 30, min: 1, max: 7_200);

    public static int TcpKeepAliveIntervalSeconds { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_HTTP_TCP_KEEPALIVE_INTERVAL_S", 10, min: 1, max: 600);

    public static int TcpKeepAliveRetryCount { get; } = ReadInt(
        "OPEN_COWORK_NATIVE_HTTP_TCP_KEEPALIVE_RETRIES", 5, min: 1, max: 50);

    public static int ResolveAttempts(WorkerHttpRetryBudget budget)
    {
        return budget switch
        {
            WorkerHttpRetryBudget.Transport => TransportRetryAttempts,
            WorkerHttpRetryBudget.Config => ConfigRetryAttempts,
            _ => 0
        };
    }

    private static int ReadInt(string name, int defaultValue, int min, int max)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
        {
            return defaultValue;
        }
        return Math.Clamp(value, min, max);
    }

    private static bool ReadBool(string name, bool defaultValue)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (raw is null)
        {
            return defaultValue;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => defaultValue
        };
    }
}
