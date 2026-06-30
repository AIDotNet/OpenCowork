using System.Text.Json;

internal static class AgentRuntimeDebugPayload
{
    private const int DefaultBodyPreviewChars = 4_096;
    private static readonly bool IncludeFullBody =
        ReadBooleanEnvironment("OPEN_COWORK_NATIVE_DEBUG_FULL_BODY") ?? false;
    private static readonly int BodyPreviewChars =
        ReadIntEnvironment("OPEN_COWORK_NATIVE_DEBUG_BODY_PREVIEW_CHARS", DefaultBodyPreviewChars);

    public static string? PrepareBody(string? body, JsonElement parameters)
    {
        var includeFullBody = IncludeFullBody || JsonHelpers.GetBool(parameters, "includeFullDebugBody", false);
        if (string.IsNullOrEmpty(body) || includeFullBody)
        {
            return body;
        }

        if (body.Length <= BodyPreviewChars)
        {
            return body;
        }

        return $"{body[..BodyPreviewChars]}\n... [native body truncated, {body.Length} chars total; set OPEN_COWORK_NATIVE_DEBUG_FULL_BODY=1 to include full body]";
    }

    private static int ReadIntEnvironment(string name, int defaultValue)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        return int.TryParse(raw, out var value) && value > 0 ? value : defaultValue;
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
