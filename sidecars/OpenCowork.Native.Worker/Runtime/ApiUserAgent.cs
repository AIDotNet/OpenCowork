using System.Collections.Generic;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text.Json;

internal static class ApiUserAgent
{
    private const string AppName = "OpenCowork";
    private const string AppVersionEnv = "OPEN_COWORK_APP_VERSION";
    private const string HeaderName = "User-Agent";

    public static string Resolve(JsonElement provider)
    {
        return Resolve(JsonHelpers.GetString(provider, "userAgent"));
    }

    public static string Resolve(string? configured)
    {
        var trimmed = configured?.Trim();
        return IsResolved(trimmed)
            ? trimmed!
            : GetDefault();
    }

    public static void Apply(HttpRequestMessage request, JsonElement provider)
    {
        request.Headers.Remove(HeaderName);
        request.Headers.TryAddWithoutValidation(HeaderName, Resolve(provider));
    }

    public static void Ensure(HttpRequestMessage request, JsonElement provider)
    {
        if (!request.Headers.TryGetValues(HeaderName, out var values))
        {
            Apply(request, provider);
            return;
        }

        foreach (var value in values)
        {
            if (IsResolved(value))
            {
                return;
            }
        }

        Apply(request, provider);
    }

    public static void Apply(ClientWebSocket socket, JsonElement provider)
    {
        socket.Options.SetRequestHeader(HeaderName, Resolve(provider));
    }

    public static void ApplyDebug(IDictionary<string, string> headers, JsonElement provider)
    {
        headers[HeaderName] = Resolve(provider);
    }

    public static void EnsureDebug(IDictionary<string, string> headers, JsonElement provider)
    {
        string? existingKey = null;
        foreach (var key in headers.Keys)
        {
            if (key.Equals(HeaderName, StringComparison.OrdinalIgnoreCase))
            {
                existingKey = key;
                break;
            }
        }

        if (existingKey is null)
        {
            headers[HeaderName] = Resolve(provider);
            return;
        }

        if (!IsResolved(headers[existingKey]))
        {
            headers[existingKey] = Resolve(provider);
        }
    }

    private static string GetDefault()
    {
        var version = Environment.GetEnvironmentVariable(AppVersionEnv)?.Trim();
        return string.IsNullOrWhiteSpace(version) ? AppName : $"{AppName}/{version}";
    }

    private static bool IsDefaultPlaceholder(string value)
    {
        return value.Equals(AppName, StringComparison.Ordinal) ||
            value.Equals($"{AppName}/", StringComparison.Ordinal);
    }

    public static bool IsUsable(string? value)
    {
        return !string.IsNullOrWhiteSpace(value) &&
            !value.Contains('\r', StringComparison.Ordinal) &&
            !value.Contains('\n', StringComparison.Ordinal);
    }

    public static bool IsResolved(string? value)
    {
        return IsUsable(value) && !IsDefaultPlaceholder(value!.Trim());
    }
}
