using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

// Volcengine Ark (Seedance) async video generation.
//   generate: POST {baseUrl}/contents/generations/tasks  -> { id }
//   status:   GET  {baseUrl}/contents/generations/tasks/{id} -> { status, content.video_url }
//   download: GET  {video_url} -> base64 mp4 (url expires ~1h, so fetch server-side)
internal static class SeedanceVideoTools
{
    private const long MaxVideoDownloadBytes = 512L * 1024 * 1024;
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: Timeout.InfiniteTimeSpan);

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
        var prompt = JsonHelpers.GetString(parameters, "prompt") ?? string.Empty;
        var images = GetArray(parameters, "images");
        var video = GetObject(parameters, "video");

        var body = BuildTaskBody(provider, prompt, images, video);
        var url = $"{GetBaseUrl(provider)}/contents/generations/tasks";
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        ApplyHeaders(request, provider);

        WorkerLog.Debug($"seedance video generate model={JsonHelpers.GetString(provider, "model")} url={url}");
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            context.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(context.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Seedance video generate failed HTTP {(int)response.StatusCode}: {ExtractError(text)}");
        }

        var id = ReadString(text, "id");
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new InvalidOperationException("Seedance video generate returned no task id.");
        }

        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("id", id);
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
            throw new InvalidOperationException("Seedance status requires taskId.");
        }

        var url = $"{GetBaseUrl(provider)}/contents/generations/tasks/{taskId}";
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
                $"Seedance video status failed HTTP {(int)response.StatusCode}: {ExtractError(text)}");
        }

        string status = "unknown";
        string? videoUrl = null;
        string? error = null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            var payload = root.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object
                    ? data
                    : root;
            status = JsonHelpers.GetString(payload, "status") ?? "unknown";
            if (payload.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Object)
            {
                videoUrl = JsonHelpers.GetString(content, "video_url") ??
                    JsonHelpers.GetString(content, "url");
            }
            videoUrl ??= JsonHelpers.GetString(payload, "video_url");
            error = ExtractError(payload) ?? ExtractError(root);
        }
        catch (JsonException)
        {
            // leave defaults
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
            throw new InvalidOperationException("Seedance download requires videoUrl.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, videoUrl);
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            context.CancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Seedance video download failed HTTP {(int)response.StatusCode}");
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

    private static string BuildTaskBody(
        JsonElement provider,
        string prompt,
        JsonElement images,
        JsonElement video)
    {
        var model = JsonHelpers.GetString(provider, "model") ?? string.Empty;
        var structured = UsesStructuredParams(model);

        var buffer = new System.IO.MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("model", model);
            writer.WritePropertyName("content");
            writer.WriteStartArray();

            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString("text", prompt);
            writer.WriteEndObject();

            if (images.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in images.EnumerateArray())
                {
                    var dataUrl = JsonHelpers.GetString(item, "dataUrl");
                    if (string.IsNullOrWhiteSpace(dataUrl))
                    {
                        continue;
                    }
                    writer.WriteStartObject();
                    writer.WriteString("type", "image_url");
                    writer.WritePropertyName("image_url");
                    writer.WriteStartObject();
                    writer.WriteString("url", dataUrl);
                    writer.WriteEndObject();
                    // Ark requires every image content to declare its semantic role.
                    // Structured models accept reference images or explicit keyframes;
                    // 1.x image-to-video treats an unlabelled input as the first frame.
                    var role = JsonHelpers.GetString(item, "role");
                    writer.WriteString(
                        "role",
                        !string.IsNullOrWhiteSpace(role)
                            ? role
                            : structured
                                ? "reference_image"
                                : "first_frame");
                    writer.WriteEndObject();
                }
            }

            writer.WriteEndArray();

            // Seedance 2.x takes top-level structured params. 1.x carries the same
            // values as `--flag` suffixes already baked into `prompt` by the renderer
            // (buildSeedanceCommands), so nothing extra is written for it.
            //
            // Deliberately absent for 2.x: `framespersecond` (output is fixed at 24fps
            // and the field is response-only) and `camerafixed` (a 1.x parameter that
            // 2.x removed — camera motion moves into the prompt text).
            if (structured)
            {
                if (JsonHelpers.GetString(video, "aspectRatio") is { Length: > 0 } ratio)
                {
                    writer.WriteString("ratio", ratio);
                }
                if (JsonHelpers.GetString(video, "resolution") is { Length: > 0 } resolution)
                {
                    writer.WriteString("resolution", resolution);
                }
                // -1 lets the model pick the length; otherwise 4-15 seconds.
                if (JsonHelpers.GetIntNullable(video, "duration") is { } duration &&
                    (duration == -1 || duration is >= 4 and <= 15))
                {
                    writer.WriteNumber("duration", duration);
                }
                if (TryGetBool(video, "watermark") is { } watermark)
                {
                    writer.WriteBoolean("watermark", watermark);
                }
                // Absent must stay absent: `generate_audio` defaults to true server-side,
                // so writing false on absence would silently mute every clip.
                if (TryGetBool(video, "generateAudio") is { } generateAudio)
                {
                    writer.WriteBoolean("generate_audio", generateAudio);
                }
                if (JsonHelpers.GetIntNullable(video, "seed") is { } seed && seed >= -1)
                {
                    writer.WriteNumber("seed", seed);
                }
            }

            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>
    /// Seedance 2.x takes structured top-level params; 1.x takes `--flag` suffixes
    /// appended to the prompt. Detected from the model id so user-added custom models
    /// work without extra config. Mirrors isSeedanceStructuredModel() in
    /// src/renderer/src/lib/api/seedance-video-provider.ts — the two must agree, or a
    /// request ends up carrying both the flags and the structured fields.
    /// Unrecognized ids (e.g. Ark `ep-...` endpoint ids) fall back to 1.x.
    /// </summary>
    private static bool UsesStructuredParams(string? model)
    {
        if (string.IsNullOrEmpty(model))
        {
            return false;
        }
        var index = model.IndexOf("seedance", StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            return false;
        }
        var cursor = index + "seedance".Length;
        while (cursor < model.Length && model[cursor] is '-' or '_' or '.' or ' ' or 'v' or 'V')
        {
            cursor++;
        }
        var start = cursor;
        while (cursor < model.Length && char.IsAsciiDigit(model[cursor]))
        {
            cursor++;
        }
        return cursor > start &&
            int.TryParse(model.AsSpan(start, cursor - start), out var major) &&
            major >= 2;
    }

    /// <summary>
    /// Like JsonHelpers.GetBool but distinguishes "absent" from "false" — required for
    /// params whose server-side default is true.
    /// </summary>
    private static bool? TryGetBool(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(name, out var property))
        {
            return null;
        }
        return property.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => (bool?)null
        };
    }

    private static void ApplyHeaders(HttpRequestMessage request, JsonElement provider)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            JsonHelpers.GetString(provider, "apiKey") ?? string.Empty);
        ApiUserAgent.Apply(request, provider);
        ApiUserAgent.Ensure(request, provider);
    }

    private static string GetBaseUrl(JsonElement provider)
    {
        return (JsonHelpers.GetString(provider, "baseUrl") ?? "https://ark.cn-beijing.volces.com/api/v3")
            .Trim()
            .TrimEnd('/');
    }

    private static void ValidateProvider(JsonElement provider)
    {
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "apiKey")))
        {
            throw new InvalidOperationException("Seedance video provider requires apiKey.");
        }
        if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(provider, "model")))
        {
            throw new InvalidOperationException("Seedance video provider requires model.");
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
        if (element.TryGetProperty("error", out var error))
        {
            if (error.ValueKind == JsonValueKind.String)
            {
                return error.GetString();
            }
            if (error.ValueKind == JsonValueKind.Object &&
                JsonHelpers.GetString(error, "message") is { Length: > 0 } message)
            {
                return message;
            }
        }
        return null;
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
