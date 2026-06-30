using System.Text;
using System.Text.Json;

internal static class AgentRuntimeGrepResultFormatter
{
    public static string CompactForPrompt(string resultJson, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(resultJson))
        {
            return string.Empty;
        }

        try
        {
            using var document = JsonDocument.Parse(resultJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Truncate(resultJson, maxChars, "grep result");
            }

            var output = ReadString(root, "output") ?? FormatGrepOutput(root);
            var error = ReadString(root, "error");
            var meta = root.TryGetProperty("meta", out var metaElement) &&
                metaElement.ValueKind == JsonValueKind.Object
                    ? metaElement
                    : default;

            if (!string.IsNullOrWhiteSpace(output) && ShouldUseCompactPayload(meta, error))
            {
                return Truncate(output, maxChars, "grep output");
            }

            return Truncate(SerializeDetailedPayload(root, meta, output, error), maxChars, "grep result");
        }
        catch
        {
            return Truncate(resultJson, maxChars, "grep result");
        }
    }

    private static bool ShouldUseCompactPayload(JsonElement meta, string? error)
    {
        if (!string.IsNullOrWhiteSpace(error))
        {
            return false;
        }

        if (meta.ValueKind != JsonValueKind.Object)
        {
            return true;
        }

        return string.IsNullOrWhiteSpace(ReadString(meta, "engine")) &&
            !ReadBool(meta, "truncated") &&
            !ReadBool(meta, "timedOut") &&
            !HasWarnings(meta);
    }

    private static string SerializeDetailedPayload(
        JsonElement root,
        JsonElement meta,
        string output,
        string? error)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("output", output);
            writer.WritePropertyName("matches");
            WriteMatches(writer, root);

            if (meta.ValueKind == JsonValueKind.Object)
            {
                WriteBool(writer, meta, "truncated");
                WriteBool(writer, meta, "timedOut");
                WriteNullableString(writer, "limitReason", ReadString(meta, "limitReason"));
                WriteNullableString(writer, "engine", ReadString(meta, "engine"));
                WriteWarnings(writer, meta);
            }
            else
            {
                writer.WriteBoolean("truncated", false);
                writer.WriteBoolean("timedOut", false);
                writer.WriteNull("limitReason");
                writer.WriteNull("engine");
                writer.WritePropertyName("warnings");
                writer.WriteStartArray();
                writer.WriteEndArray();
            }

            if (!string.IsNullOrWhiteSpace(error))
            {
                writer.WriteString("error", error);
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteMatches(Utf8JsonWriter writer, JsonElement root)
    {
        writer.WriteStartArray();
        if (root.TryGetProperty("matches", out var matches) && matches.ValueKind == JsonValueKind.Array)
        {
            foreach (var match in matches.EnumerateArray())
            {
                if (match.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var path = ReadString(match, "path") ?? ReadString(match, "file");
                if (string.IsNullOrWhiteSpace(path))
                {
                    continue;
                }

                writer.WriteStartObject();
                writer.WriteString("file", path);
                WriteOptionalInt(writer, "line", ReadInt(match, "line"));
                WriteOptionalInt(writer, "column", ReadInt(match, "column"));
                WriteOptionalString(writer, "text", ReadString(match, "text"));
                WriteOptionalString(writer, "kind", ReadString(match, "kind"));
                WriteOptionalInt(writer, "count", ReadInt(match, "count"));
                writer.WriteEndObject();
            }
        }
        writer.WriteEndArray();
    }

    private static string FormatGrepOutput(JsonElement root)
    {
        if (!root.TryGetProperty("matches", out var matches) || matches.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var outputMode = "matches";
        if (root.TryGetProperty("meta", out var meta) && meta.ValueKind == JsonValueKind.Object)
        {
            outputMode = ReadString(meta, "outputMode") ?? outputMode;
        }

        var builder = new StringBuilder();
        foreach (var match in matches.EnumerateArray())
        {
            if (match.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var line = FormatGrepLine(match, outputMode);
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            if (builder.Length > 0)
            {
                builder.Append('\n');
            }
            builder.Append(line);
        }

        return builder.ToString();
    }

    private static string FormatGrepLine(JsonElement match, string outputMode)
    {
        var path = ReadString(match, "path") ?? ReadString(match, "file");
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        if (outputMode is "files_with_matches" or "files_without_matches")
        {
            return path;
        }

        var count = ReadInt(match, "count");
        if (outputMode == "count")
        {
            return $"{path}:{count ?? 0}";
        }

        var line = ReadInt(match, "line");
        if (line is null)
        {
            return path;
        }

        var kind = ReadString(match, "kind");
        var separator = kind == "context" ? '-' : ':';
        var column = ReadInt(match, "column");
        var text = ReadString(match, "text") ?? string.Empty;
        if (column is not null && kind != "context")
        {
            return $"{path}{separator}{line.Value}{separator}{column.Value}{separator}{text}";
        }

        return $"{path}{separator}{line.Value}{separator}{text}";
    }

    private static bool HasWarnings(JsonElement meta)
    {
        return meta.TryGetProperty("warnings", out var warnings) &&
            warnings.ValueKind == JsonValueKind.Array &&
            warnings.GetArrayLength() > 0;
    }

    private static void WriteWarnings(Utf8JsonWriter writer, JsonElement meta)
    {
        writer.WritePropertyName("warnings");
        if (meta.TryGetProperty("warnings", out var warnings) && warnings.ValueKind == JsonValueKind.Array)
        {
            warnings.WriteTo(writer);
            return;
        }

        writer.WriteStartArray();
        writer.WriteEndArray();
    }

    private static void WriteBool(Utf8JsonWriter writer, JsonElement element, string name)
    {
        if (element.TryGetProperty(name, out var value) &&
            value.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            writer.WriteBoolean(name, value.GetBoolean());
            return;
        }

        writer.WriteBoolean(name, false);
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            writer.WriteNull(name);
            return;
        }

        writer.WriteString(name, value);
    }

    private static void WriteOptionalString(Utf8JsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(name, value);
        }
    }

    private static void WriteOptionalInt(Utf8JsonWriter writer, string name, int? value)
    {
        if (value is not null)
        {
            writer.WriteNumber(name, value.Value);
        }
    }

    private static bool ReadBool(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) &&
            value.ValueKind is JsonValueKind.True or JsonValueKind.False &&
            value.GetBoolean();
    }

    private static int? ReadInt(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : null;
    }

    private static string? ReadString(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String
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
