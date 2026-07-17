using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeImageGenerateExecutor
{
    private const string ToolName = "ImageGenerate";
    private const int MaxCount = 4;
    private const int MaxReferenceImages = 6;
    private const int MaxReferenceImageBytes = 16 * 1024 * 1024;
    private const int MaxReferenceImagesTotalBytes = 32 * 1024 * 1024;
    private const int MaxGeneratedImageBytes = 32 * 1024 * 1024;

    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: TimeSpan.FromMinutes(10));

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsImageGenerateTool(string toolName)
    {
        return string.Equals(toolName, ToolName, StringComparison.Ordinal);
    }

    public static async Task<RendererToolResult> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var prompt = JsonHelpers.GetString(call.Input, "prompt")?.Trim() ?? string.Empty;
        if (prompt.Length == 0)
        {
            return Error("ImageGenerate requires a non-empty prompt.");
        }

        if (!parameters.TryGetProperty("imagePluginProvider", out var provider) ||
            provider.ValueKind != JsonValueKind.Object)
        {
            return Error("Image plugin is disabled or has no valid image model configured.");
        }

        var count = Math.Clamp(JsonHelpers.GetInt(call.Input, "count", 1), 1, MaxCount);
        var size = NormalizeImageSize(JsonHelpers.GetString(call.Input, "size"));
        var quality = NormalizeImageQuality(JsonHelpers.GetString(call.Input, "quality"));
        var providerWithOverrides = size is null && quality is null
            ? provider
            : BuildProviderWithOverrides(provider, size, quality);
        var referenceImages = await ReadReferenceImagesAsync(call.Input, parameters, cancellationToken);
        var savedImages = new List<PersistedGeneratedImage>();
        var notes = new List<string>();
        if (referenceImages.GetArrayLength() > 0)
        {
            notes.Add($"Using {referenceImages.GetArrayLength()} reference image(s).");
        }

        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var generated = await OpenAIImagesTools.GenerateImagesForProviderAsync(
                providerWithOverrides,
                prompt,
                referenceImages,
                cancellationToken: cancellationToken);
            if (generated.Count == 0)
            {
                continue;
            }

            foreach (var image in generated)
            {
                cancellationToken.ThrowIfCancellationRequested();
                savedImages.Add(await PersistGeneratedImageAsync(
                    image,
                    savedImages.Count,
                    cancellationToken));
            }
        }

        if (savedImages.Count == 0)
        {
            return Error("Image generation returned no images.");
        }

        return new RendererToolResult(BuildToolResult(savedImages, notes), false, null);
    }

    private static async Task<JsonElement> ReadReferenceImagesAsync(
        JsonElement input,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var references = ReadReferenceImagePaths(input);
        if (references.Count == 0)
        {
            using var emptyDocument = JsonDocument.Parse("[]");
            return emptyDocument.RootElement.Clone();
        }

        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim();
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            var totalBytes = 0L;
            foreach (var reference in references)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var path = ResolveReferencePath(reference, workingFolder);
                byte[] bytes;
                try
                {
                    var fileLength = new FileInfo(path).Length;
                    if (fileLength > MaxReferenceImageBytes ||
                        totalBytes + fileLength > MaxReferenceImagesTotalBytes)
                    {
                        throw new InvalidOperationException(
                            $"Reference images exceed the {MaxReferenceImagesTotalBytes} byte request limit.");
                    }
                    bytes = await File.ReadAllBytesAsync(path, cancellationToken);
                    totalBytes += bytes.Length;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    throw new InvalidOperationException(
                        $"Failed to read reference image \"{path}\": {ex.Message}");
                }

                var mediaType = MediaTypeFromPath(path);
                writer.WriteStartObject();
                writer.WriteString(
                    "dataUrl",
                    $"data:{mediaType};base64,{Convert.ToBase64String(bytes)}");
                writer.WriteString("mediaType", mediaType);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static List<string> ReadReferenceImagePaths(JsonElement input)
    {
        if (!input.TryGetProperty("reference_images", out var value))
        {
            return [];
        }

        var result = new List<string>();
        if (value.ValueKind == JsonValueKind.String)
        {
            var path = value.GetString()?.Trim();
            if (!string.IsNullOrWhiteSpace(path))
            {
                result.Add(path);
            }
            return result;
        }

        if (value.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in value.EnumerateArray())
        {
            if (result.Count >= MaxReferenceImages)
            {
                break;
            }
            if (item.ValueKind == JsonValueKind.String &&
                item.GetString()?.Trim() is { Length: > 0 } path)
            {
                result.Add(path);
            }
        }

        return result;
    }

    private static async Task<PersistedGeneratedImage> PersistGeneratedImageAsync(
        NativeGeneratedImage image,
        int index,
        CancellationToken cancellationToken)
    {
        var mediaType = image.MediaType == "url" ? "image/png" : image.MediaType;
        byte[] bytes;
        if (image.SourceType == "url")
        {
            using var response = await Http.GetAsync(
                image.Data,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            response.EnsureSuccessStatusCode();
            mediaType = response.Content.Headers.ContentType?.MediaType ?? mediaType;
            bytes = await MediaFileStore.ReadHttpContentBytesAsync(
                response.Content,
                MaxGeneratedImageBytes,
                cancellationToken);
        }
        else
        {
            var base64 = StripDataUriPrefix(image.Data);
            if (base64.Length > ((MaxGeneratedImageBytes + 2L) / 3L) * 4L)
            {
                throw new InvalidOperationException(
                    $"Generated image exceeds the {MaxGeneratedImageBytes} byte limit.");
            }
            bytes = Convert.FromBase64String(base64);
        }

        var outputDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "images",
            DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(outputDir);

        var fileName =
            $"image-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{index + 1}-{RandomSuffix()}{ImageExtensionForMediaType(mediaType)}";
        var filePath = Path.Combine(outputDir, fileName);
        await File.WriteAllBytesAsync(filePath, bytes, cancellationToken);

        return new PersistedGeneratedImage(
            filePath,
            mediaType);
    }

    private static JsonElement BuildToolResult(
        IReadOnlyList<PersistedGeneratedImage> images,
        IReadOnlyList<string> notes)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            writer.WriteStartObject();
            writer.WriteString(
                "type",
                "text");
            writer.WriteString(
                "text",
                $"Saved image absolute paths:\n{string.Join('\n', images.Select(image => image.FilePath))}");
            writer.WriteEndObject();

            foreach (var image in images)
            {
                writer.WriteStartObject();
                writer.WriteString("type", "image");
                writer.WritePropertyName("source");
                writer.WriteStartObject();
                writer.WriteString("type", "base64");
                writer.WriteString("mediaType", image.MediaType);
                writer.WriteString("filePath", image.FilePath);
                writer.WriteBoolean("dataOmitted", true);
                writer.WriteEndObject();
                writer.WriteEndObject();
            }

            foreach (var note in notes)
            {
                writer.WriteStartObject();
                writer.WriteString("type", "text");
                writer.WriteString("text", note);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static JsonElement BuildProviderWithOverrides(
        JsonElement provider,
        string? size,
        string? quality)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            foreach (var property in provider.EnumerateObject())
            {
                if (!property.NameEquals("requestOverrides"))
                {
                    property.WriteTo(writer);
                }
            }

            writer.WritePropertyName("requestOverrides");
            writer.WriteStartObject();
            if (provider.TryGetProperty("requestOverrides", out var overrides) &&
                overrides.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in overrides.EnumerateObject())
                {
                    if (!property.NameEquals("body"))
                    {
                        property.WriteTo(writer);
                    }
                }
            }

            writer.WritePropertyName("body");
            writer.WriteStartObject();
            if (provider.TryGetProperty("requestOverrides", out var existingOverrides) &&
                existingOverrides.ValueKind == JsonValueKind.Object &&
                existingOverrides.TryGetProperty("body", out var body) &&
                body.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in body.EnumerateObject())
                {
                    if ((size is not null && property.NameEquals("size")) ||
                        (quality is not null && property.NameEquals("quality")))
                    {
                        continue;
                    }
                    property.WriteTo(writer);
                }
            }
            if (size is not null)
            {
                writer.WriteString("size", size);
            }
            if (quality is not null)
            {
                writer.WriteString("quality", quality);
            }
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static string ResolveReferencePath(string filePath, string? workingFolder)
    {
        if (Path.IsPathFullyQualified(filePath) || string.IsNullOrWhiteSpace(workingFolder))
        {
            return filePath;
        }
        return Path.GetFullPath(Path.Combine(workingFolder, filePath));
    }

    private static string? NormalizeImageSize(string? value)
    {
        return value?.Trim() switch
        {
            "1024x1024" or "1024x1536" or "1536x1024" => value.Trim(),
            _ => null
        };
    }

    private static string? NormalizeImageQuality(string? value)
    {
        return value?.Trim() switch
        {
            "low" or "medium" or "high" => value.Trim(),
            _ => null
        };
    }

    private static string MediaTypeFromPath(string filePath)
    {
        var normalized = filePath.Split('?', 2)[0].ToLowerInvariant();
        if (normalized.EndsWith(".jpg", StringComparison.Ordinal) ||
            normalized.EndsWith(".jpeg", StringComparison.Ordinal))
        {
            return "image/jpeg";
        }
        if (normalized.EndsWith(".webp", StringComparison.Ordinal))
        {
            return "image/webp";
        }
        if (normalized.EndsWith(".gif", StringComparison.Ordinal))
        {
            return "image/gif";
        }
        if (normalized.EndsWith(".svg", StringComparison.Ordinal))
        {
            return "image/svg+xml";
        }
        return "image/png";
    }

    private static string ImageExtensionForMediaType(string mediaType)
    {
        return mediaType.ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => ".jpg",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            "image/svg+xml" => ".svg",
            _ => ".png"
        };
    }

    private static string StripDataUriPrefix(string data)
    {
        var marker = ";base64,";
        var index = data.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return index >= 0 ? data[(index + marker.Length)..] : data;
    }

    private static string RandomSuffix()
    {
        Span<byte> bytes = stackalloc byte[4];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static RendererToolResult Error(string message)
    {
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(EncodeError(message)),
            true,
            message);
    }

    private static string EncodeError(string message)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private sealed record PersistedGeneratedImage(
        string FilePath,
        string MediaType);
}
