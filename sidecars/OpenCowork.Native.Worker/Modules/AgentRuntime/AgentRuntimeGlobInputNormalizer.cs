using System.Text.Json;

internal static class AgentRuntimeGlobInputNormalizer
{
    private const int DefaultLimit = 100;
    private const int MaxLimit = 1_000;
    private const int MaxDepth = 50;

    public static JsonDocument BuildSearchParameters(JsonElement input, string root)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("path", root);
            writer.WriteString("pattern", RequirePattern(input));
            writer.WriteNumber("limit", NormalizeLimit(input));
            writer.WriteBoolean("hidden", JsonHelpers.GetBool(input, "hidden", true));
            writer.WriteBoolean("respectGitignore", JsonHelpers.GetBool(input, "respectGitignore", true));
            writer.WriteBoolean("followSymlinks", JsonHelpers.GetBool(input, "followSymlinks", false));

            var maxDepth = NormalizeMaxDepth(input);
            if (maxDepth is not null)
            {
                writer.WriteNumber("maxDepth", maxDepth.Value);
            }

            if (input.TryGetProperty("ignore", out var ignore) && ignore.ValueKind == JsonValueKind.Array)
            {
                writer.WritePropertyName("ignore");
                ignore.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        return JsonDocument.Parse(stream.ToArray());
    }

    private static string RequirePattern(JsonElement input)
    {
        var pattern = JsonHelpers.GetString(input, "pattern");
        if (string.IsNullOrWhiteSpace(pattern))
        {
            throw new InvalidOperationException("Glob requires a pattern");
        }

        return pattern.Trim();
    }

    private static int NormalizeLimit(JsonElement input)
    {
        var limit = JsonHelpers.GetInt(input, "limit", DefaultLimit);
        return Math.Max(1, Math.Min(limit, MaxLimit));
    }

    private static int? NormalizeMaxDepth(JsonElement input)
    {
        var value = JsonHelpers.GetIntNullable(input, "maxDepth");
        if (value is null || value.Value <= 0)
        {
            return null;
        }

        return Math.Min(value.Value, MaxDepth);
    }
}
