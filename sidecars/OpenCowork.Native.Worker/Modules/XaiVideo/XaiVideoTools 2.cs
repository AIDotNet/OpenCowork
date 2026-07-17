using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

// xAI-compatible asynchronous video generation.
// Routin protocol: https://docs.routin.ai/zh/docs/API/xai-video
//   generate: POST {baseUrl}/xai/v1/videos/generations -> { request_id }
//   status:   GET  {baseUrl}/xai/v1/videos/{request_id} -> { status, video.url }
internal static class XaiVideoTools
{
    private const long MaxVideoDownloadBytes = 512L * 1024 * 1024;
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: TimeSpan.FromMinutes(10));

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<WorkerResponse> GenerateAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        using var quota = await WorkerTaskQuotas.EnterMediaAsync(context.CancellationToken);
        var provider = GetObject(parameters, "provider");
        ValidateProvider(provider);
        var prompt = JsonHelpers.GetString(parameters, "prompt")?.Trim() ?? string.Empty;
        if (prompt.Length == 0)
        {
            throw new InvalidOperationException("xAI video generation requires prompt.");
        }

        var body = BuildGenerationBody(
            provider,
            prompt,
            GetArray(parameters, "images"),
            GetObject(parameters, "video"));
        var url = $"{GetXaiBaseUrl(provider)}/videos/generations";
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider);

        WorkerLog.Debug($"xAI video generate model={JsonHelpers.GetString(provider, "model")} url={url}");
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            context.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(context.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"xAI video generate failed HTTP {(int)response.StatusCode}: {ExtractError(text)}");
        }

        var requestId = ReadString(text, "request_id");
        if (string.IsNullOrWhiteSpace(requestId))
        {
            throw new InvalidOperationException("xAI video generation returned no request_id.");
        }

        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("id", requestId);
            writer.WriteEndObject();
        });
    }

    public static async Task<WorkerResponse> StatusAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        using var quota = await WorkerTaskQuotas.EnterMediaAsync(context.CancellationToken);
        var provider = GetObject(parameters, "provider");
        ValidateProvider(provider);
        var taskId = JsonHelpers.GetString(parameters, "taskId");
        if (string.IsNullOrWhiteSpace(taskId))
        {
            throw new InvalidOperationException("xAI video status requires taskId.");
        }

        var url = $"{GetXaiBaseUrl(provider)}/videos/{Uri.EscapeDataString(taskId)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        ApplyHeaders(request, provider);
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            context.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(context.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"xAI video status failed HTTP {(int)response.StatusCode}: {ExtractError(text)}");
        }

        var status = "unknown";
        string? videoUrl = null;
        string? error = null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            var xaiStatus = JsonHelpers.GetString(root, "status") ?? "unknown";
            status = xaiStatus switch
            {
                "done" => "succeeded",
                "expired" => "failed",
                _ => xaiStatus
            };
            if (root.TryGetProperty("video", out var video) && video.ValueKind == JsonValueKind.Object)
            {
                videoUrl = JsonHelpers.GetString(video, "url");
            }
            error = ExtractError(root);
            if (xaiStatus == "expired" && string.IsNullOrWhiteSpace(error))
            {
                error = "xAI video request expired.";
            }
        }
        catch (JsonException)
        {
            // The caller will continue polling an unknown response until timeout.
        }

        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("status", status);
            if (videoUrl is { Length: > 0 })
            {
                writer.WriteString("videoUrl", videoUrl);
            }
            if (error is { Length: > 0 })
            {
                writer.WriteString("error", error);
            }
            writer.WriteEndObject();
        });
    }

    public static async Task<WorkerResponse> DownloadAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        using var quota = await WorkerTaskQuotas.EnterMediaAsync(context.CancellationToken);
        var videoUrl = JsonHelpers.GetString(parameters, "videoUrl");
        if (string.IsNullOrWhiteSpace(videoUrl))
        {
            throw new InvalidOperationException("xAI video download requires videoUrl.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, videoUrl);
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            context.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"xAI video download failed HTTP {(int)response.StatusCode}");
        }

        var mediaType = response.Content.Headers.ContentType?.MediaType ?? "video/mp4";
        var extension = mediaType.Contains("webm", StringComparison.OrdinalIgnoreCase)
            ? ".webm"
            : ".mp4";
        var saved = await MediaFileStore.WriteHttpContentAsync(
            response.Content,
            "video",
            extension,
            MaxVideoDownloadBytes,
            context.CancellationToken);

        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("filePath", saved.FilePath);
            writer.WriteString("mediaType", mediaType);
            writer.WriteNumber("bytes", saved.Bytes);
            writer.WriteEndObject();
        });
    }

    private static string BuildGenerationBody(
        JsonElement provider,
        string prompt,
        JsonElement images,
        JsonElement video)
    {
        var imageUrls = images.ValueKind == JsonValueKind.Array
            ? images.EnumerateArray()
                .Select(item => JsonHelpers.GetString(item, "dataUrl"))
                .Where(url => !string.IsNullOrWhiteSpace(url))
                .Take(7)
                .Cast<string>()
                .ToArray()
            : [];
        var duration = Math.Clamp(
            JsonHelpers.GetInt(video, "duration", 5),
            1,
            imageUrls.Length > 1 ? 10 : 15);
        var aspectRatio = JsonHelpers.GetString(video, "aspectRatio");
        var requestedResolution = JsonHelpers.GetString(video, "resolution");
        var resolution = requestedResolution == "480p" ? "480p" : "720p";

        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("model", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            writer.WriteString("prompt", prompt);

            if (imageUrls.Length == 1)
            {
                writer.WritePropertyName("image");
                writer.WriteStartObject();
                writer.WriteString("url", imageUrls[0]);
                writer.WriteEndObject();
            }
            else if (imageUrls.Length > 1)
            {
                writer.WritePropertyName("reference_images");
                writer.WriteStartArray();
                foreach (var imageUrl in imageUrls)
                {
                    writer.WriteStartObject();
                    writer.WriteString("url", imageUrl);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
            }

            writer.WriteNumber("duration", duration);
            if (!string.IsNullOrWhiteSpace(aspectRatio))
            {
                writer.WriteString("aspect_ratio", aspectRatio);
            }
            writer.WriteString("resolution", resolution);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static void ApplyHeaders(HttpRequestMessage request, JsonElement provider)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);
        ApiUserAgent.Apply(request, provider);
        ApiUserAgent.Ensure(request, provider);
    }

    private static string GetXaiBaseUrl(JsonElement provider)
    {
        var baseUrl = (JsonHelpers.GetString(provider, "baseUrl") ?? "https://api.routin.ai/v1")
            .Trim()
            .TrimEnd('/');
        if (baseUrl.EndsWith("/xai/v1", StringComparison.OrdinalIgnoreCase))
        {
            return baseUrl;
        }
        if (baseUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase))
        {
            baseUrl = baseUrl[..^3];
        }
        return $"{baseUrl}/xai/v1";
    }

    private static void ValidateProvider(JsonElement provider)
    {
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "apiKey")))
        {
            throw new InvalidOperationException("xAI video provider requires apiKey.");
        }
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "model")))
        {
            throw new InvalidOperationException("xAI video provider requires model.");
        }
    }

    private static string? ReadString(string json, string property)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return JsonHelpers.GetString(doc.RootElement, property);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string ExtractError(string responseText)
    {
        if (string.IsNullOrWhiteSpace(responseText))
        {
            return "empty error response";
        }
        try
        {
            using var doc = JsonDocument.Parse(responseText);
            return ExtractError(doc.RootElement) ?? responseText;
        }
        catch (JsonException)
        {
            return responseText;
        }
    }

    private static string? ExtractError(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            return element.GetString();
        }
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        if (!element.TryGetProperty("error", out var error))
        {
            return null;
        }
        if (error.ValueKind == JsonValueKind.String)
        {
            return error.GetString();
        }
        return error.ValueKind == JsonValueKind.Object
            ? JsonHelpers.GetString(error, "message")
            : null;
    }

    private static JsonElement GetObject(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Object
                ? property
                : default;
    }

    private static JsonElement GetArray(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Array
                ? property
                : default;
    }
}
