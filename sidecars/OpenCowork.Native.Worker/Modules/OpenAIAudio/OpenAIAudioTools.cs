using System.Buffers;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class OpenAIAudioTools
{
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: TimeSpan.FromMinutes(10));

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

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

    public static async Task<WorkerResponse> SpeechAsync(JsonElement parameters)
    {
        var provider = GetObject(parameters, "provider");
        ValidateProvider(provider);

        var input = (JsonHelpers.GetString(parameters, "input") ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(input))
        {
            throw new InvalidOperationException("OpenAI speech synthesis requires input text.");
        }

        var voice = JsonHelpers.GetString(parameters, "voice")?.Trim();
        var instruction = JsonHelpers.GetString(parameters, "instruction")?.Trim();
        var format = JsonHelpers.GetString(parameters, "format")?.Trim()?.ToLowerInvariant();
        var mode = JsonHelpers.GetString(parameters, "mode")?.Trim()?.ToLowerInvariant();
        var chatStyle = JsonHelpers.GetString(parameters, "chatStyle")?.Trim()?.ToLowerInvariant();

        var result = mode == "chat"
            ? await SynthesizeViaChatAsync(
                provider, input, voice, instruction, format ?? "wav", chatStyle ?? "assistant")
            : await SynthesizeViaSpeechAsync(provider, input, voice, instruction, format ?? "mp3");

        return WorkerResponse.Json(
            result,
            WorkerJsonContext.Default.NativeOpenAIAudioSpeechResult);
    }

    /// <summary>Classic OpenAI text-to-speech: POST {base}/audio/speech → binary audio.</summary>
    private static async Task<NativeOpenAIAudioSpeechResult> SynthesizeViaSpeechAsync(
        JsonElement provider,
        string input,
        string? voice,
        string? instruction,
        string format)
    {
        var url = $"{GetBaseUrl(provider)}/audio/speech";
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = GetOmittedBodyKeys(provider);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            if (!omitted.Contains("input"))
            {
                writer.WriteString("input", input);
            }
            if (!omitted.Contains("voice") && !string.IsNullOrWhiteSpace(voice))
            {
                writer.WriteString("voice", voice);
            }
            if (!omitted.Contains("response_format"))
            {
                writer.WriteString("response_format", format);
            }
            if (!omitted.Contains("instructions") && !string.IsNullOrWhiteSpace(instruction))
            {
                writer.WriteString("instructions", instruction);
            }
            ApplyBodyOverrides(writer, provider, omitted);
            writer.WriteEndObject();
        }

        var bytes = await PostForAudioBytesAsync(url, buffer, provider, "OpenAI speech synthesis");
        return new NativeOpenAIAudioSpeechResult(Convert.ToBase64String(bytes), MapAudioMediaType(format));
    }

    /// <summary>
    /// Chat-completions style synthesis, audio returned as base64 in
    /// choices[0].message.audio.data. Two message shapes:
    /// - "assistant" (Xiaomi MiMo TTS): the assistant message carries the
    ///   exact text to speak; an optional user message carries the style.
    /// - "instruct" (OpenAI gpt-4o-audio / gpt-audio): a single user message
    ///   asks the model to read the text verbatim; modalities is required.
    /// </summary>
    private static async Task<NativeOpenAIAudioSpeechResult> SynthesizeViaChatAsync(
        JsonElement provider,
        string input,
        string? voice,
        string? instruction,
        string format,
        string chatStyle)
    {
        var url = $"{GetBaseUrl(provider)}/chat/completions";
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            var omitted = GetOmittedBodyKeys(provider);
            writer.WriteStartObject();
            if (!omitted.Contains("model"))
            {
                writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            }
            if (!omitted.Contains("modalities"))
            {
                writer.WriteStartArray("modalities");
                writer.WriteStringValue("text");
                writer.WriteStringValue("audio");
                writer.WriteEndArray();
            }
            if (!omitted.Contains("messages"))
            {
                writer.WriteStartArray("messages");
                if (chatStyle == "instruct")
                {
                    var directive = string.IsNullOrWhiteSpace(instruction)
                        ? "Read the following text aloud exactly as written. Do not add, omit or change anything."
                        : $"Read the following text aloud exactly as written. Do not add, omit or change anything. Speaking style: {instruction}";
                    writer.WriteStartObject();
                    writer.WriteString("role", "user");
                    writer.WriteString("content", $"{directive}\n\n{input}");
                    writer.WriteEndObject();
                }
                else
                {
                    if (!string.IsNullOrWhiteSpace(instruction))
                    {
                        writer.WriteStartObject();
                        writer.WriteString("role", "user");
                        writer.WriteString("content", instruction);
                        writer.WriteEndObject();
                    }
                    writer.WriteStartObject();
                    writer.WriteString("role", "assistant");
                    writer.WriteString("content", input);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }
            if (!omitted.Contains("audio"))
            {
                writer.WriteStartObject("audio");
                writer.WriteString("format", format);
                if (!string.IsNullOrWhiteSpace(voice))
                {
                    writer.WriteString("voice", voice);
                }
                writer.WriteEndObject();
            }
            ApplyBodyOverrides(writer, provider, omitted);
            writer.WriteEndObject();
        }

        var bytes = await PostForAudioBytesAsync(url, buffer, provider, "Chat speech synthesis");
        var responseText = Encoding.UTF8.GetString(bytes);
        var base64 = ParseChatAudioData(responseText)
            ?? throw new InvalidOperationException("Chat speech synthesis returned no audio data.");
        return new NativeOpenAIAudioSpeechResult(base64, MapAudioMediaType(format));
    }

    private static async Task<byte[]> PostForAudioBytesAsync(
        string url,
        ArrayBufferWriter<byte> body,
        JsonElement provider,
        string label)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new ByteArrayContent(body.WrittenSpan.ToArray());
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        ApplyOpenAIHeaders(request, provider);

        WorkerLog.Debug(
            $"openai audio speech request model={JsonHelpers.GetString(provider, "model")} url={url}");
        using var response = await Http.SendAsync(request);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (!response.IsSuccessStatusCode)
        {
            var errorText = Encoding.UTF8.GetString(bytes);
            throw new InvalidOperationException(
                $"{label} failed HTTP {(int)response.StatusCode}: {ExtractErrorMessage(errorText)}");
        }
        return bytes;
    }

    private static string? ParseChatAudioData(string responseText)
    {
        try
        {
            using var document = JsonDocument.Parse(responseText);
            if (!document.RootElement.TryGetProperty("choices", out var choices) ||
                choices.ValueKind != JsonValueKind.Array)
            {
                return null;
            }
            foreach (var choice in choices.EnumerateArray())
            {
                if (choice.ValueKind == JsonValueKind.Object &&
                    choice.TryGetProperty("message", out var message) &&
                    message.ValueKind == JsonValueKind.Object &&
                    message.TryGetProperty("audio", out var audio) &&
                    audio.ValueKind == JsonValueKind.Object &&
                    JsonHelpers.GetString(audio, "data") is { Length: > 0 } data)
                {
                    return data;
                }
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return null;
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

    private static string MapAudioMediaType(string format)
    {
        return format switch
        {
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "opus" => "audio/ogg",
            "aac" => "audio/aac",
            "flac" => "audio/flac",
            "pcm" or "pcm16" => "audio/wav",
            _ => "audio/mpeg"
        };
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
