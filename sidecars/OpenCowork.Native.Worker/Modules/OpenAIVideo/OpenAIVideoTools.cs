using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

// OpenAI Videos API (Sora): POST /videos, GET /videos/{id}, GET /videos/{id}/content.
internal static class OpenAIVideoTools
{
    private const long MaxVideoDownloadBytes = 512L * 1024 * 1024;
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(timeout: TimeSpan.FromMinutes(10));

    public static async Task<WorkerResponse> GenerateAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var provider = GetObject(parameters, "provider");
        Validate(provider);
        var prompt = JsonHelpers.GetString(parameters, "prompt")?.Trim() ?? string.Empty;
        if (prompt.Length == 0) throw new InvalidOperationException("OpenAI video generation requires prompt.");
        var video = GetObject(parameters, "video");
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{Base(provider)}/videos");
        request.Content = new StringContent(BuildBody(provider, prompt, video), Encoding.UTF8, "application/json");
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
        return WorkerResponse.FromWriter(w => { w.WriteStartObject(); w.WriteString("status", mapped); if (mapped == "succeeded") w.WriteString("videoUrl", $"{Base(provider)}/videos/{Uri.EscapeDataString(id)}/content"); w.WriteEndObject(); });
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
            writer.WriteString("seconds", Math.Clamp(JsonHelpers.GetInt(video, "duration", 4), 1, 20).ToString());
            writer.WriteString("size", Size(JsonHelpers.GetString(video, "aspectRatio")));
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static string Base(JsonElement p) => (JsonHelpers.GetString(p, "baseUrl") ?? "https://api.openai.com/v1").TrimEnd('/');
    private static void Headers(HttpRequestMessage r, JsonElement p) { r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", JsonHelpers.GetString(p, "apiKey") ?? ""); ApiUserAgent.Apply(r, p); ApiUserAgent.Ensure(r, p); }
    private static void Validate(JsonElement p) { if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(p, "apiKey"))) throw new InvalidOperationException("OpenAI video provider requires apiKey."); if (string.IsNullOrWhiteSpace(JsonHelpers.GetString(p, "model"))) throw new InvalidOperationException("OpenAI video provider requires model."); }
    private static string? Read(string json, string key) { try { using var d = JsonDocument.Parse(json); return JsonHelpers.GetString(d.RootElement, key); } catch (JsonException) { return null; } }
    private static string? ReadNested(string json, string parent, string key) { try { using var d = JsonDocument.Parse(json); return d.RootElement.TryGetProperty(parent, out var p) && p.ValueKind == JsonValueKind.Object ? JsonHelpers.GetString(p, key) : null; } catch (JsonException) { return null; } }
    private static JsonElement GetObject(JsonElement e, string key) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
    private static string Size(string? ratio) => ratio is "9:16" or "2:3" ? "720x1280" : ratio is "16:9" or "3:2" ? "1280x720" : "1024x1024";
}
