using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

// OpenAI Videos API (Sora): POST /videos, GET /videos/{id}, GET /videos/{id}/content.
internal static class OpenAIVideoTools
{
    private const long MaxVideoDownloadBytes = 512L * 1024 * 1024;
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: Timeout.InfiniteTimeSpan);

    public static async Task<WorkerResponse> GenerateAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider");
        Validate(provider);
        var prompt = JsonHelpers.GetString(parameters, "prompt")?.Trim() ?? string.Empty;
        if (prompt.Length == 0) throw new InvalidOperationException("OpenAI video generation requires prompt.");
        var video = GetObject(parameters, "video");
        var image = ReadFirstImage(GetArray(parameters, "images"));
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{Base(provider)}/videos");
        request.Content = image == null
            ? new StringContent(BuildBody(provider, prompt, video), Encoding.UTF8, "application/json")
            : BuildMultipartBody(provider, prompt, video, image);
        Headers(request, provider);
        using var response = await Http.SendAsync(request, context.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(context.CancellationToken);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"OpenAI video generate failed HTTP {(int)response.StatusCode}: {text}");
        var id = Read(text, "id") ?? ReadNested(text, "data", "id") ?? ReadNested(text, "video", "id");
        if (string.IsNullOrWhiteSpace(id)) throw new InvalidOperationException("OpenAI video generation returned no id.");
        return WorkerResponse.FromWriter(w => { w.WriteStartObject(); w.WriteString("id", id); w.WriteEndObject(); });
    }

    public static async Task<WorkerResponse> StatusAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider"); Validate(provider);
        var id = JsonHelpers.GetString(parameters, "taskId");
        if (string.IsNullOrWhiteSpace(id)) throw new InvalidOperationException("OpenAI video status requires taskId.");
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{Base(provider)}/videos/{Uri.EscapeDataString(id)}");
        Headers(request, provider);
        using var response = await Http.SendAsync(request, context.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(context.CancellationToken);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"OpenAI video status failed HTTP {(int)response.StatusCode}: {text}");
        var status = Read(text, "status") ?? "unknown";
        var mapped = status == "completed" ? "succeeded" : status == "failed" ? "failed" : status;
        var error = mapped == "failed" ? ReadVideoError(text) : null;
        var progress = mapped == "succeeded" ? 100 : ReadVideoProgress(text);
        return WorkerResponse.FromWriter(w =>
        {
            w.WriteStartObject();
            w.WriteString("status", mapped);
            if (progress.HasValue)
            {
                w.WriteNumber("progress", progress.Value);
            }
            if (mapped == "succeeded")
            {
                w.WriteString("videoUrl", $"{Base(provider)}/videos/{Uri.EscapeDataString(id)}/content");
            }
            if (!string.IsNullOrWhiteSpace(error))
            {
                w.WriteString("error", error);
            }
            w.WriteEndObject();
        });
    }

    public static async Task<WorkerResponse> DownloadAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider");
        Validate(provider);
        var url = JsonHelpers.GetString(parameters, "videoUrl");
        if (string.IsNullOrWhiteSpace(url)) throw new InvalidOperationException("OpenAI video download requires videoUrl.");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        Headers(request, provider);
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.CancellationToken);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"OpenAI video download failed HTTP {(int)response.StatusCode}");
        var saved = await MediaFileStore.WriteHttpContentAsync(response.Content, "video", ".mp4", MaxVideoDownloadBytes, context.CancellationToken);
        return WorkerResponse.FromWriter(w => { w.WriteStartObject(); w.WriteString("filePath", saved.FilePath); w.WriteString("mediaType", "video/mp4"); w.WriteNumber("bytes", saved.Bytes); w.WriteEndObject(); });
    }

    private static string BuildBody(JsonElement provider, string prompt, JsonElement video)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("model", JsonHelpers.GetString(provider, "model"));
            writer.WriteString("prompt", prompt);
            writer.WriteString("seconds", NormalizeSeconds(JsonHelpers.GetInt(video, "duration", 4)));
            writer.WriteString(
                "size",
                Size(
                    JsonHelpers.GetString(video, "aspectRatio"),
                    JsonHelpers.GetString(video, "resolution")));
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static MultipartFormDataContent BuildMultipartBody(
        JsonElement provider,
        string prompt,
        JsonElement video,
        VideoImageInput image)
    {
        var content = new MultipartFormDataContent();
        content.Add(new StringContent(JsonHelpers.GetString(provider, "model") ?? string.Empty), "model");
        content.Add(new StringContent(prompt), "prompt");
        content.Add(
            new StringContent(NormalizeSeconds(JsonHelpers.GetInt(video, "duration", 4))),
            "seconds");
        content.Add(
            new StringContent(
                Size(
                    JsonHelpers.GetString(video, "aspectRatio"),
                    JsonHelpers.GetString(video, "resolution"))),
            "size");

        var imageContent = new ByteArrayContent(image.Bytes);
        imageContent.Headers.ContentType = new MediaTypeHeaderValue(image.MediaType);
        content.Add(imageContent, "input_reference", GetImageFileName(image.MediaType));
        return content;
    }

    private static VideoImageInput? ReadFirstImage(JsonElement images)
    {
        if (images.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var item in images.EnumerateArray())
        {
            var dataUrl = JsonHelpers.GetString(item, "dataUrl");
            if (string.IsNullOrWhiteSpace(dataUrl))
            {
                continue;
            }

            var comma = dataUrl.IndexOf(',', StringComparison.Ordinal);
            var base64 = comma >= 0 ? dataUrl[(comma + 1)..] : dataUrl;
            try
            {
                var bytes = Convert.FromBase64String(base64);
                if (bytes.Length == 0)
                {
                    continue;
                }

                var mediaType = JsonHelpers.GetString(item, "mediaType")
                    ?? GetDataUrlMediaType(dataUrl)
                    ?? "image/png";
                return new VideoImageInput(bytes, mediaType);
            }
            catch (FormatException)
            {
                throw new InvalidOperationException(
                    "OpenAI video input reference must contain valid base64 image data.");
            }
        }

        return null;
    }

    private static string? GetDataUrlMediaType(string dataUrl)
    {
        if (!dataUrl.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var semi = dataUrl.IndexOf(';', StringComparison.Ordinal);
        return semi > 5 ? dataUrl[5..semi] : null;
    }

    private static string GetImageFileName(string mediaType) => mediaType.ToLowerInvariant() switch
    {
        "image/jpeg" or "image/jpg" => "input-reference.jpg",
        "image/webp" => "input-reference.webp",
        _ => "input-reference.png"
    };

    private static string Base(JsonElement p) => (JsonHelpers.GetString(p, "baseUrl") ?? "https://api.openai.com/v1").TrimEnd('/');
    private static void Headers(HttpRequestMessage r, JsonElement p) { r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", JsonHelpers.GetString(p, "apiKey") ?? ""); ApiUserAgent.Apply(r, p); ApiUserAgent.Ensure(r, p); }
    private static void Validate(JsonElement p) { if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(p, "apiKey"))) throw new InvalidOperationException("OpenAI video provider requires apiKey."); if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(p, "model"))) throw new InvalidOperationException("OpenAI video provider requires model."); }
    private static string? Read(string json, string key) { try { using var d = JsonDocument.Parse(json); return JsonHelpers.GetString(d.RootElement, key); } catch (JsonException) { return null; } }
    private static string? ReadNested(string json, string parent, string key) { try { using var d = JsonDocument.Parse(json); return d.RootElement.TryGetProperty(parent, out var p) && p.ValueKind == JsonValueKind.Object ? JsonHelpers.GetString(p, key) : null; } catch (JsonException) { return null; } }
    private static string? ReadVideoError(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var error = root.TryGetProperty("error", out var rootError)
                ? rootError
                : root.TryGetProperty("data", out var data) &&
                  data.ValueKind == JsonValueKind.Object &&
                  data.TryGetProperty("error", out var dataError)
                    ? dataError
                    : default;

            if (error.ValueKind == JsonValueKind.String)
            {
                return error.GetString();
            }
            if (error.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var message = JsonHelpers.GetString(error, "message");
            var code = JsonHelpers.GetString(error, "code");
            return (message, code) switch
            {
                ({ Length: > 0 }, { Length: > 0 }) => $"{message} ({code})",
                ({ Length: > 0 }, _) => message,
                (_, { Length: > 0 }) => code,
                _ => error.GetRawText()
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
    private static double? ReadVideoProgress(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var progress = JsonHelpers.GetDoubleNullable(root, "progress");
            if (!progress.HasValue &&
                root.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object)
            {
                progress = JsonHelpers.GetDoubleNullable(data, "progress");
            }
            return progress.HasValue ? Math.Clamp(progress.Value, 0, 100) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
    private static JsonElement GetObject(JsonElement e, string key) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
    private static JsonElement GetArray(JsonElement e, string key) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.Array ? p : default;
    private static string Size(string? ratio, string? resolution)
    {
        var portrait = ratio is "9:16" or "2:3";
        var highResolution = resolution == "1024p";
        return (portrait, highResolution) switch
        {
            (true, true) => "1024x1792",
            (false, true) => "1792x1024",
            (true, false) => "720x1280",
            _ => "1280x720"
        };
    }
    private static string NormalizeSeconds(int seconds) => seconds switch
    {
        8 => "8",
        12 => "12",
        _ => "4"
    };

    private sealed record VideoImageInput(byte[] Bytes, string MediaType);
}
