using System.Text;
using System.Text.Json;

internal static class AgentRuntimeGlobResultFormatter
{
    public static string CompactForPrompt(string resultJson, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(resultJson))
        {
            return "[]";
        }

        try
        {
            using var document = JsonDocument.Parse(resultJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Truncate(resultJson, maxChars, "glob result");
            }

            var matches = ReadMatchPaths(root);
            var error = ReadString(root, "error");
            if (ShouldUseCompactPayload(root, error))
            {
                return Truncate(JsonSerializer.Serialize(matches, WorkerJsonContext.Default.ListString), maxChars, "glob result");
            }

            return Truncate(SerializeDetailedPayload(root, matches, error), maxChars, "glob result");
        }
        catch
        {
            return Truncate(resultJson, maxChars, "glob result");
        }
    }

    private static List<string> ReadMatchPaths(JsonElement root)
    {
        if (!root.TryGetProperty("matches", out var matchesElement) ||
            matchesElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var matches = new List<string>();
        foreach (var match in matchesElement.EnumerateArray())
        {
            string? path = null;
            if (match.ValueKind == JsonValueKind.String)
            {
                path = match.GetString();
            }
            else if (match.ValueKind == JsonValueKind.Object)
            {
                path = ReadString(match, "path");
            }

            if (!string.IsNullOrWhiteSpace(path))
            {
                matches.Add(path);
            }
        }

        return matches;
    }

    private static bool ShouldUseCompactPayload(JsonElement root, string? error)
    {
        if (!string.IsNullOrWhiteSpace(error))
        {
            return false;
        }

        if (!root.TryGetProperty("meta", out var meta) || meta.ValueKind != JsonValueKind.Object)
        {
            return true;
        }

        return string.IsNullOrWhiteSpace(ReadString(meta, "engine")) &&
            !ReadBool(meta, "truncated") &&
            !ReadBool(meta, "timedOut") &&
            !HasWarnings(meta);
    }

    private static string SerializeDetailedPayload(JsonElement root, List<string> matches, string? error)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("matches");
            JsonSerializer.Serialize(writer, matches, WorkerJsonContext.Default.ListString);

            if (root.TryGetProperty("meta", out var meta) && meta.ValueKind == JsonValueKind.Object)
            {
                WriteBool(writer, meta, "truncated");
                WriteBool(writer, meta, "timedOut");
                WriteString(writer, meta, "limitReason");
                WriteString(writer, meta, "engine");

                if (meta.TryGetProperty("warnings", out var warnings) && warnings.ValueKind == JsonValueKind.Array)
                {
                    writer.WritePropertyName("warnings");
                    warnings.WriteTo(writer);
                }
            }

            if (!string.IsNullOrWhiteSpace(error))
            {
                writer.WriteString("error", error);
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static bool HasWarnings(JsonElement meta)
    {
        return meta.TryGetProperty("warnings", out var warnings) &&
            warnings.ValueKind == JsonValueKind.Array &&
            warnings.GetArrayLength() > 0;
    }

    private static void WriteBool(Utf8JsonWriter writer, JsonElement element, string name)
    {
        if (element.TryGetProperty(name, out var value) &&
            value.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            writer.WriteBoolean(name, value.GetBoolean());
        }
    }

    private static void WriteString(Utf8JsonWriter writer, JsonElement element, string name)
    {
        var value = ReadString(element, name);
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(name, value);
        }
    }

    private static bool ReadBool(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) &&
            value.ValueKind is JsonValueKind.True or JsonValueKind.False &&
            value.GetBoolean();
    }

    private static string? ReadString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static string Truncate(string value, int maxChars, string label)
    {
        if (maxChars <= 0 || value.Length <= maxChars)
        {
            return value;
        }

        var suffix = $"\n... [{label} truncated to {maxChars} chars]";
        var keep = Math.Max(0, maxChars - suffix.Length);
        return value[..keep] + suffix;
    }
}
