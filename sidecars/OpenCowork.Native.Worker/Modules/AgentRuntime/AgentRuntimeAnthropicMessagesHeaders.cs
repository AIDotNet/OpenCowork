using System.Net.Http.Headers;
using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private static void ApplyHeaders(HttpRequestMessage request, JsonElement provider)
    {
        var apiKey = JsonHelpers.GetString(provider, "apiKey") ?? string.Empty;
        if (JsonHelpers.GetString(provider, "providerBuiltinId") == "longcat")
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            request.Headers.TryAddWithoutValidation("x-api-key", apiKey);
        }
        else
        {
            request.Headers.TryAddWithoutValidation("x-api-key", apiKey);
        }
        request.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
        request.Headers.TryAddWithoutValidation("anthropic-beta", BuildAnthropicBetaHeader(provider));
        ApiUserAgent.Apply(request, provider);
    }

    private static IReadOnlyDictionary<string, string> BuildDebugHeaders(JsonElement provider)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = "application/json",
            ["anthropic-version"] = "2023-06-01",
            ["anthropic-beta"] = BuildAnthropicBetaHeader(provider)
        };
        if (JsonHelpers.GetString(provider, "providerBuiltinId") == "longcat")
        {
            headers["Authorization"] = "Bearer ***";
            headers["x-api-key"] = "***";
        }
        else
        {
            headers["x-api-key"] = "***";
        }
        ApiUserAgent.ApplyDebug(headers, provider);
        return headers;
    }

    private static string BuildAnthropicBetaHeader(JsonElement provider)
    {
        return JsonHelpers.GetString(provider, "cacheTtl") == "1h"
            ? "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11"
            : "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14";
    }

}
