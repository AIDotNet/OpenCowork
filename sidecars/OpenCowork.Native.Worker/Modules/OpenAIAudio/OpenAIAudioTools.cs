using System.Net.Http.Headers;
using System.Text.Json;

internal static class OpenAIAudioTools
{
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: TimeSpan.FromMinutes(10));

    public static async Task<WorkerResponse> TranscribeAsync(JsonElement parameters)
    {
        var provider = GetObject(parameters, "provider");
        ValidateProvider(provider);

        var file = GetObject(parameters, "file");
        var base64 = NormalizeBase64(JsonHelpers.GetString(file, "base64") ?? string.Empty);
        if (string.IsNullOrWhiteSpace(base64))
        {
            throw new InvalidOperationException("OpenAI audio transcription requires file.base64.");
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException ex)
        {
            throw new InvalidOperationException("OpenAI audio transcription received invalid base64 audio.", ex);
        }

        var mediaType = NormalizeMediaType(JsonHelpers.GetString(file, "mediaType"));
        var fileName = NormalizeFileName(JsonHelpers.GetString(file, "fileName"), mediaType);
        var text = await TranscribeAsync(provider, bytes, mediaType, fileName);

        return WorkerResponse.Json(
            new NativeOpenAIAudioTranscriptionResult(text),
            WorkerJsonContext.Default.NativeOpenAIAudioTranscriptionResult);
    }

    private static async Task<string> TranscribeAsync(
        JsonElement provider,
        byte[] bytes,
        string mediaType,
        string fileName)
    {
        var url = $"{GetBaseUrl(provider)}/audio/transcriptions";
        using var content = new MultipartFormDataContent();
        var omitted = GetOmittedBodyKeys(provider);
        if (!omitted.Contains("file"))
        {
            var fileContent = new ByteArrayContent(bytes);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue(mediaType);
            content.Add(fileContent, "file", fileName);
        }
        if (!omitted.Contains("model"))
        {
            AddFormString(content, "model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
        }
        ApplyBodyOverridesToForm(content, provider, omitted);

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = content;
        ApplyOpenAIHeaders(request, provider);

        WorkerLog.Debug(
            $"openai audio transcription request model={JsonHelpers.GetString(provider, "model")} url={url} bytes={bytes.Length}");
        using var response = await Http.SendAsync(request);
        var responseText = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"OpenAI audio transcription failed HTTP {(int)response.StatusCode}: {ExtractErrorMessage(responseText)}");
        }

        return ParseTranscriptionText(responseText);
    }

    private static string ParseTranscriptionText(string responseText)
    {
        if (string.IsNullOrWhiteSpace(responseText))
        {
            return string.Empty;
        }

        try
        {
            using var document = JsonDocument.Parse(responseText);
            var root = document.RootElement;
            if (JsonHelpers.GetString(root, "text") is { } text)
            {
                return text;
            }
        }
        catch (JsonException)
        {
            // Some compatible endpoints can return plain text when response_format is overridden.
        }

        return responseText.Trim();
    }

    private static void ApplyBodyOverridesToForm(
        MultipartFormDataContent content,
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
                AddFormValue(content, property.Name, property.Value);
            }
        }
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

    private static void ApplyOpenAIHeaders(HttpRequestMessage request, JsonElement provider)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);
        ApiUserAgent.Apply(request, provider);
        if (JsonHelpers.GetString(provider, "organization") is { Length: > 0 } organization)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Organization", organization);
        }
        if (JsonHelpers.GetString(provider, "project") is { Length: > 0 } project)
        {
            request.Headers.TryAddWithoutValidation("OpenAI-Project", project);
        }
        ApplyHeaderOverrides(request, provider);
        ApiUserAgent.Ensure(request, provider);
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
            throw new InvalidOperationException("OpenAI audio transcription requires apiKey.");
        }
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "model")))
        {
            throw new InvalidOperationException("OpenAI audio transcription requires model.");
        }
    }

    private static string NormalizeBase64(string data)
    {
        var trimmed = data.Trim();
        var comma = trimmed.IndexOf(',', StringComparison.Ordinal);
        if (trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
        {
            trimmed = trimmed[(comma + 1)..];
        }
        return string.Concat(trimmed.Where(item => !char.IsWhiteSpace(item)));
    }

    private static string NormalizeMediaType(string? mediaType)
    {
        return string.IsNullOrWhiteSpace(mediaType)
            ? "application/octet-stream"
            : mediaType.Trim();
    }

    private static string NormalizeFileName(string? fileName, string mediaType)
    {
        var normalized = Path.GetFileName(fileName?.Trim() ?? string.Empty);
        if (string.IsNullOrWhiteSpace(normalized))
        {
            normalized = "audio";
        }
        if (Path.HasExtension(normalized))
        {
            return normalized;
        }

        return mediaType.ToLowerInvariant() switch
        {
            "audio/mpeg" or "audio/mp3" => $"{normalized}.mp3",
            "audio/mp4" or "audio/m4a" => $"{normalized}.m4a",
            "audio/wav" or "audio/x-wav" => $"{normalized}.wav",
            "audio/webm" => $"{normalized}.webm",
            "audio/ogg" => $"{normalized}.ogg",
            "audio/flac" => $"{normalized}.flac",
            _ => normalized
        };
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
}
