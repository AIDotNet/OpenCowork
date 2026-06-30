using System.Buffers;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class OpenAIImagesTools
{
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: TimeSpan.FromMinutes(10));

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<WorkerResponse> GenerateAsync(JsonElement parameters)
    {
        var provider = GetObject(parameters, "provider");
        var prompt = JsonHelpers.GetString(parameters, "prompt") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(prompt))
        {
            prompt = "Edit this image";
        }
        var responseImages = await GenerateImagesForProviderAsync(provider, prompt, GetArray(parameters, "images"));

        return WorkerResponse.Json(
            new NativeOpenAIImagesResult(responseImages.ToArray()),
            WorkerJsonContext.Default.NativeOpenAIImagesResult);
    }

    public static async Task<List<NativeGeneratedImage>> GenerateImagesForProviderAsync(
        JsonElement provider,
        string prompt,
        JsonElement imagesElement)
    {
        ValidateProvider(provider);

        var images = ReadImages(imagesElement);
        return images.Count > 0
            ? await EditImagesAsync(provider, prompt, images)
            : await GenerateImagesAsync(provider, prompt);
    }

    private static async Task<List<NativeGeneratedImage>> GenerateImagesAsync(
        JsonElement provider,
        string prompt)
    {
        var url = $"{GetBaseUrl(provider)}/images/generations";
        var body = BuildGenerationBody(provider, prompt);
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyOpenAIHeaders(request, provider);

        WorkerLog.Debug($"openai images generation request model={JsonHelpers.GetString(provider, "model")} url={url}");
        using var response = await Http.SendAsync(request);
        var responseText = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"OpenAI image generation failed HTTP {(int)response.StatusCode}: {ExtractErrorMessage(responseText)}");
        }

        return ParseImagesResponse(responseText, "Image generation returned no image output");
    }

    private static async Task<List<NativeGeneratedImage>> EditImagesAsync(
        JsonElement provider,
        string prompt,
        IReadOnlyList<NativeImageInput> images)
    {
        var url = $"{GetBaseUrl(provider)}/images/edits";
        using var content = new MultipartFormDataContent();
        var omitted = GetOmittedBodyKeys(provider);
        if (!omitted.Contains("model"))
        {
            AddFormString(content, "model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
        }
        if (!omitted.Contains("prompt"))
        {
            AddFormString(content, "prompt", prompt);
        }
        if (!omitted.Contains("size"))
        {
            AddFormString(content, "size", JsonHelpers.GetString(provider, "size"));
        }

        var fieldName = images.Count > 1 ? "image[]" : "image";
        if (!omitted.Contains(fieldName) && !omitted.Contains("image"))
        {
            for (var index = 0; index < images.Count; index++)
            {
                var image = images[index];
                var bytes = Convert.FromBase64String(image.Base64Data);
                var imageContent = new ByteArrayContent(bytes);
                imageContent.Headers.ContentType = new MediaTypeHeaderValue(image.MediaType);
                content.Add(imageContent, fieldName, GetImageFileName(image.MediaType, index));
            }
        }
        ApplyBodyOverridesToForm(content, provider, omitted);

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = content;
        ApplyOpenAIHeaders(request, provider);

        WorkerLog.Debug($"openai images edit request model={JsonHelpers.GetString(provider, "model")} url={url} images={images.Count}");
        using var response = await Http.SendAsync(request);
        var responseText = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"OpenAI image edit failed HTTP {(int)response.StatusCode}: {ExtractErrorMessage(responseText)}");
        }

        return ParseImagesResponse(responseText, "Image edit returned no image output");
    }

    private static string BuildGenerationBody(JsonElement provider, string prompt)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = GetOmittedBodyKeys(provider);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            if (!omitted.Contains("prompt"))
            {
                writer.WriteString("prompt", prompt);
            }
            ApplyBodyOverrides(writer, provider, omitted);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void ApplyBodyOverrides(
        Utf8JsonWriter writer,
        JsonElement provider,
        HashSet<string> omitted)
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
            if (!omitted.Contains(property.Name))
            {
                property.WriteTo(writer);
            }
        }
    }

    private static void ApplyBodyOverridesToForm(
        MultipartFormDataContent content,
        JsonElement provider,
        HashSet<string> omitted)
    {
        if (provider.TryGetProperty("requestOverrides", out var overrides) &&
            overrides.ValueKind == JsonValueKind.Object &&
            overrides.TryGetProperty("body", out var body) &&
            body.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in body.EnumerateObject())
            {
                if (!omitted.Contains(property.Name))
                {
                    AddFormValue(content, property.Name, property.Value);
                }
            }
        }
    }

    private static HashSet<string> GetOmittedBodyKeys(JsonElement provider)
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

    private static void AddFormValue(MultipartFormDataContent content, string key, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                AddFormValue(content, key, item);
            }
            return;
        }

        var text = value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : value.GetRawText();
        AddFormString(content, key, text);
    }

    private static void AddFormString(MultipartFormDataContent content, string key, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }
        content.Add(new StringContent(value), key);
    }

    private static List<NativeGeneratedImage> ParseImagesResponse(string responseText, string emptyMessage)
    {
        using var document = JsonDocument.Parse(responseText);
        var root = document.RootElement;
        var outputFormat = JsonHelpers.GetString(root, "output_format");
        var result = new List<NativeGeneratedImage>();
        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                if (JsonHelpers.GetString(item, "b64_json") is { Length: > 0 } base64)
                {
                    var normalized = NormalizeBase64ImageData(base64);
                    result.Add(new NativeGeneratedImage(
                        "base64",
                        normalized,
                        MediaTypeFromOutputFormat(outputFormat) ?? DetectImageMediaType(normalized)));
                    continue;
                }
                if (JsonHelpers.GetString(item, "url") is { Length: > 0 } url)
                {
                    result.Add(new NativeGeneratedImage("url", url, "url"));
                }
            }
        }

        if (result.Count == 0)
        {
            throw new InvalidOperationException(emptyMessage);
        }
        return result;
    }

    private static string ExtractErrorMessage(string responseText)
    {
        if (string.IsNullOrWhiteSpace(responseText))
        {
            return "empty error response";
        }

        try
        {
            using var document = JsonDocument.Parse(responseText);
            return ExtractErrorMessage(document.RootElement) ?? responseText;
        }
        catch (JsonException)
        {
            return responseText;
        }
    }

    private static string? ExtractErrorMessage(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            return element.GetString();
        }
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var key in new[] { "message", "code", "type" })
        {
            if (JsonHelpers.GetString(element, key) is { Length: > 0 } value)
            {
                return value;
            }
        }
        return element.TryGetProperty("error", out var error)
            ? ExtractErrorMessage(error)
            : null;
    }

    private static List<NativeImageInput> ReadImages(JsonElement images)
    {
        var result = new List<NativeImageInput>();
        if (images.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in images.EnumerateArray())
        {
            var dataUrl = JsonHelpers.GetString(item, "dataUrl");
            if (string.IsNullOrWhiteSpace(dataUrl))
            {
                continue;
            }
            var mediaType = JsonHelpers.GetString(item, "mediaType") ?? GetImageInputMediaType(dataUrl);
            var base64 = ExtractBase64FromDataUrl(dataUrl);
            if (!string.IsNullOrWhiteSpace(base64))
            {
                result.Add(new NativeImageInput(base64, mediaType));
            }
        }
        return result;
    }

    private static JsonElement GetArray(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Array
                ? property
                : default;
    }

    private static string ExtractBase64FromDataUrl(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',', StringComparison.Ordinal);
        return comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl;
    }

    private static string GetImageInputMediaType(string dataUrl)
    {
        if (dataUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var semi = dataUrl.IndexOf(';', StringComparison.Ordinal);
            if (semi > 5)
            {
                return dataUrl[5..semi];
            }
        }
        return "application/octet-stream";
    }

    private static string GetImageFileName(string mediaType, int index)
    {
        return mediaType.ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => $"image-{index + 1}.jpg",
            "image/webp" => $"image-{index + 1}.webp",
            "image/png" => $"image-{index + 1}.png",
            _ => $"image-{index + 1}"
        };
    }

    private static string NormalizeBase64ImageData(string data)
    {
        var trimmed = data.Trim();
        var comma = trimmed.IndexOf(',', StringComparison.Ordinal);
        if (trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
        {
            trimmed = trimmed[(comma + 1)..];
        }
        return string.Concat(trimmed.Where(item => !char.IsWhiteSpace(item)));
    }

    private static string? MediaTypeFromOutputFormat(string? outputFormat)
    {
        return outputFormat?.Trim().ToLowerInvariant() switch
        {
            "jpeg" or "jpg" => "image/jpeg",
            "webp" => "image/webp",
            "png" => "image/png",
            _ => null
        };
    }

    private static string DetectImageMediaType(string base64)
    {
        try
        {
            var header = Convert.FromBase64String(base64.Length > 48 ? base64[..48] : base64);
            if (header.Length >= 4 && header[0] == 0x89 && header[1] == 0x50)
            {
                return "image/png";
            }
            if (header.Length >= 3 && header[0] == 0xff && header[1] == 0xd8)
            {
                return "image/jpeg";
            }
            if (header.Length >= 12 &&
                header[0] == (byte)'R' &&
                header[1] == (byte)'I' &&
                header[2] == (byte)'F' &&
                header[3] == (byte)'F' &&
                header[8] == (byte)'W' &&
                header[9] == (byte)'E' &&
                header[10] == (byte)'B' &&
                header[11] == (byte)'P')
            {
                return "image/webp";
            }
        }
        catch
        {
            // Fall through to PNG; OpenAI image outputs default to PNG.
        }
        return "image/png";
    }

    private static string GetBaseUrl(JsonElement provider)
    {
        return (JsonHelpers.GetString(provider, "baseUrl") ?? "https://api.openai.com/v1")
            .Trim()
            .TrimEnd('/');
    }

    private static void ValidateProvider(JsonElement provider)
    {
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "apiKey")))
        {
            throw new InvalidOperationException("OpenAI image provider requires apiKey.");
        }
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "model")))
        {
            throw new InvalidOperationException("OpenAI image provider requires model.");
        }
    }

    private static void ApplyOpenAIHeaders(HttpRequestMessage request, JsonElement provider)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);
        if (JsonHelpers.GetString(provider, "userAgent") is { Length: > 0 } userAgent)
        {
            request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        }
        if (JsonHelpers.GetString(provider, "organization") is { Length: > 0 } organization)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Organization", organization);
        }
        if (JsonHelpers.GetString(provider, "project") is { Length: > 0 } project)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Project", project);
        }
        ApplyHeaderOverrides(request, provider);
    }

    private static void ApplyHeaderOverrides(HttpRequestMessage request, JsonElement provider)
    {
        if (!provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("headers", out var headers) ||
            headers.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in headers.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var value = property.Value.GetString()?.Trim();
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }
            request.Headers.Remove(property.Name);
            request.Headers.TryAddWithoutValidation(property.Name, value);
        }
    }

    private static JsonElement GetObject(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Object)
        {
            return property;
        }
        return default;
    }

    private sealed record NativeImageInput(string Base64Data, string MediaType);
}
