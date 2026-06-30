using System.Globalization;

internal static class WorkerLog
{
    private const int DefaultSlowRequestMs = 750;

    public static bool DebugEnabled { get; } = ResolveDebugEnabled();

    public static int SlowRequestMs { get; } = ResolveSlowRequestMs();

    public static void Info(string message)
    {
        Write("INFO", message);
    }

    public static void Warn(string message)
    {
        Write("WARN", message);
    }

    public static void Debug(string message)
    {
        if (DebugEnabled)
        {
            Write("DEBUG", message);
        }
    }

    public static void RequestCompleted(
        string method,
        string id,
        long elapsedMs,
        int requestBytes,
        int responseBytes,
        Exception? error)
    {
        if (error is not null)
        {
            Warn(
                $"request failed id={id} method={method} elapsedMs={elapsedMs} " +
                $"requestBytes={requestBytes} responseBytes={responseBytes} " +
                $"error={error.GetType().Name}: {error.Message}");
            return;
        }

        var message =
            $"request ok id={id} method={method} elapsedMs={elapsedMs} " +
            $"requestBytes={requestBytes} responseBytes={responseBytes}";

        if (elapsedMs >= SlowRequestMs)
        {
            Warn($"slow {message}");
            return;
        }

        Debug(message);
    }

    private static void Write(string level, string message)
    {
        Console.Error.WriteLine(
            $"[NativeWorker][{DateTimeOffset.Now.ToString("O", CultureInfo.InvariantCulture)}][{level}] {message}");
    }

    private static bool ResolveDebugEnabled()
    {
        return ReadBooleanEnvironment("OPEN_COWORK_NATIVE_DEBUG") ?? false;
    }

    private static int ResolveSlowRequestMs()
    {
        var raw = Environment.GetEnvironmentVariable("OPEN_COWORK_NATIVE_SLOW_MS");
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) &&
            value > 0
                ? value
                : DefaultSlowRequestMs;
    }

    private static bool? ReadBooleanEnvironment(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (raw is null)
        {
            return null;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => null
        };
    }
}
