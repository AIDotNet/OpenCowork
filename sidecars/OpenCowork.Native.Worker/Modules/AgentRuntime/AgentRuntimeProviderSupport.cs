using System.Buffers;
using System.Net.Http;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeProviderSupport
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static HashSet<string> GetOmittedBodyKeys(JsonElement provider)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("omitBodyKeys", out var keys) ||
            keys.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var key in keys.EnumerateArray())
        {
            if (key.ValueKind == JsonValueKind.String && key.GetString() is { Length: > 0 } value)
            {
                result.Add(value);
            }
        }
        return result;
    }

    public static void WriteBodyOverrides(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string>? omitted = null)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("body", out var body) ||
            body.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in body.EnumerateObject())
        {
            if (omitted?.Contains(property.Name) == true)
            {
                continue;
            }
            property.WriteTo(writer);
        }
    }

    public static void ApplyHttpHeaderOverrides(
        HttpRequestMessage request,
        JsonElement provider,
        Func<string, bool>? shouldSkip = null)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("headers", out var headers) ||
            headers.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var sessionId = JsonHelpers.GetString(provider, "sessionId") ?? string.Empty;
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        foreach (var property in headers.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String ||
                shouldSkip?.Invoke(property.Name) == true)
            {
                continue;
            }

            var value = ResolveHeaderTemplate(property.Value.GetString() ?? string.Empty, sessionId, model);
            if (value.Length == 0)
            {
                continue;
            }
            request.Headers.Remove(property.Name);
            request.Headers.TryAddWithoutValidation(property.Name, value);
        }
    }

    public static void ApplyDebugHeaderOverrides(
        Dictionary<string, string> headers,
        JsonElement provider,
        Func<string, bool>? shouldSkip = null)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("headers", out var overrideHeaders) ||
            overrideHeaders.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var sessionId = JsonHelpers.GetString(provider, "sessionId") ?? string.Empty;
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        foreach (var property in overrideHeaders.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String ||
                shouldSkip?.Invoke(property.Name) == true)
            {
                continue;
            }

            var value = ResolveHeaderTemplate(property.Value.GetString() ?? string.Empty, sessionId, model);
            if (value.Length == 0)
            {
                continue;
            }
            headers[property.Name] = IsSensitiveHeader(property.Name) ? "***" : value;
        }
    }

    public static string ResolveHeaderTemplate(string value, string sessionId, string model)
    {
        return value
            .Replace("{{sessionId}}", sessionId, StringComparison.Ordinal)
            .Replace("{{ sessionId }}", sessionId, StringComparison.Ordinal)
            .Replace("{{model}}", model, StringComparison.Ordinal)
            .Replace("{{ model }}", model, StringComparison.Ordinal)
            .Trim();
    }

    public static bool IsSensitiveHeader(string name)
    {
        return name.Contains("authorization", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("api-key", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("apikey", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("token", StringComparison.OrdinalIgnoreCase);
    }

    public static JsonElement CreateEmptyObjectElement()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    public static JsonElement CreateStringElement(string value)
    {
        return JsonSerializer.SerializeToElement(value, WorkerJsonContext.Default.String);
    }

    public static JsonElement CreateImageBlockElement(string imageBase64, string? outputFormat)
    {
        var mediaType = GetResponsesImageGenerationMediaType(outputFormat) ??
            DetectImageMediaTypeFromBase64(imageBase64) ??
            "image/png";
        return CreateObjectElement(writer =>
        {
            writer.WriteString("type", "image");
            writer.WritePropertyName("source");
            writer.WriteStartObject();
            writer.WriteString("type", "base64");
            writer.WriteString("data", StripDataUrlPrefix(imageBase64));
            writer.WriteString("mediaType", mediaType);
            writer.WriteEndObject();
        });
    }

    public static JsonElement CreateObjectElement(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    public static string ToolResultToString(JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString() ?? string.Empty;
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return content.GetRawText();
        }

        var text = new StringBuilder();
        var imageCount = 0;
        foreach (var block in content.EnumerateArray())
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "text":
                    if (JsonHelpers.GetString(block, "text") is { Length: > 0 } blockText)
                    {
                        if (text.Length > 0)
                        {
                            text.Append('\n');
                        }
                        text.Append(blockText);
                    }
                    break;
                case "image":
                    imageCount++;
                    break;
            }
        }

        if (imageCount == 0)
        {
            return text.ToString();
        }
        if (text.Length > 0)
        {
            text.Append('\n');
        }
        text.Append(imageCount == 1 ? "[Image]" : $"[{imageCount} images]");
        return text.ToString();
    }

    public static string? GetResponsesImageGenerationMediaType(string? outputFormat)
    {
        return outputFormat?.Trim().ToLowerInvariant() switch
        {
            "jpeg" or "jpg" => "image/jpeg",
            "webp" => "image/webp",
            "png" => "image/png",
            _ => null
        };
    }

    public static string? DetectImageMediaTypeFromBase64(string? imageBase64)
    {
        var normalized = StripDataUrlPrefix(imageBase64).Replace(" ", string.Empty, StringComparison.Ordinal);
        if (normalized.Length == 0)
        {
            return null;
        }
        if (normalized.StartsWith("iVBORw0KGgo", StringComparison.Ordinal))
        {
            return "image/png";
        }
        if (normalized.StartsWith("/9j/", StringComparison.Ordinal))
        {
            return "image/jpeg";
        }
        if (normalized.StartsWith("UklGR", StringComparison.Ordinal))
        {
            return "image/webp";
        }
        return null;
    }

    public static string StripDataUrlPrefix(string? value)
    {
        var trimmed = value?.Trim() ?? string.Empty;
        var marker = ";base64,";
        var markerIndex = trimmed.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return markerIndex >= 0 ? trimmed[(markerIndex + marker.Length)..] : trimmed;
    }
}
