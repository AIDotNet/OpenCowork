using System.Buffers;
using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class ExtensionHttpToolExecutor
{
    private const int MaxExtensionFetchRedirects = 5;
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(
        timeout: TimeSpan.FromMinutes(2),
        allowAutoRedirect: false);

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<NativeExtensionToolExecutionResult> ExecuteAsync(
        string extensionId,
        string toolName,
        JsonElement input,
        CancellationToken cancellationToken)
    {
        try
        {
            var extension = ExtensionManifestStore.FindExtensionOrThrow(extensionId);
            if (!extension.Enabled)
            {
                throw new InvalidOperationException($"Extension \"{extensionId}\" is disabled");
            }

            var tool = extension.Manifest.Tools.FirstOrDefault(item =>
                string.Equals(item.Name, toolName, StringComparison.Ordinal));
            if (tool is null)
            {
                throw new InvalidOperationException($"Tool \"{toolName}\" not found in extension \"{extensionId}\"");
            }
            if (tool.Kind != "http" || tool.Http is null)
            {
                throw new InvalidOperationException($"Tool \"{toolName}\" is not an HTTP tool");
            }

            var normalizedInput = input.ValueKind == JsonValueKind.Object
                ? input
                : EmptyJsonObject();
            var request = BuildToolFetchRequest(extension, tool, normalizedInput);
            var response = await PerformFetchAsync(extension, request, cancellationToken);
            return new NativeExtensionToolExecutionResult(
                true,
                EncodeExtensionToolResult(NormalizeHttpToolResult(extension, tool, response)),
                null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new NativeExtensionToolExecutionResult(false, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> ExecuteWorkerAsync(JsonElement parameters)
    {
        var extensionId = JsonHelpers.GetString(parameters, "extensionId")?.Trim() ?? string.Empty;
        var toolName = JsonHelpers.GetString(parameters, "toolName")?.Trim() ?? string.Empty;
        var input = parameters.TryGetProperty("input", out var inputElement)
            ? inputElement
            : EmptyJsonObject();
        var result = await ExecuteAsync(extensionId, toolName, input, CancellationToken.None);
        return WorkerResponse.Json(result, WorkerJsonContext.Default.NativeExtensionToolExecutionResult);
    }

    private static ExtensionFetchRequest BuildToolFetchRequest(
        NativeExtensionInstance extension,
        NativeExtensionToolDefinition tool,
        JsonElement input)
    {
        var http = tool.Http ?? throw new InvalidOperationException($"Tool \"{tool.Name}\" is not an HTTP tool");
        var headers = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var item in http.Headers)
        {
            headers[item.Key] = InterpolateString(item.Value, input, extension.Config);
        }

        return new ExtensionFetchRequest(
            http.Method,
            InterpolateString(http.Url, input, extension.Config),
            headers,
            http.Body.HasValue
                ? InterpolateValue(http.Body.Value, input, extension.Config).Clone()
                : null);
    }

    private static async Task<ExtensionFetchResponse> PerformFetchAsync(
        NativeExtensionInstance extension,
        ExtensionFetchRequest request,
        CancellationToken cancellationToken)
    {
        var url = request.Url;
        var method = string.IsNullOrWhiteSpace(request.Method)
            ? "GET"
            : request.Method.ToUpperInvariant();
        var headers = new Dictionary<string, string>(request.Headers, StringComparer.Ordinal);

        HttpResponseMessage? response = null;
        for (var redirectCount = 0; redirectCount <= MaxExtensionFetchRedirects; redirectCount++)
        {
            if (string.IsNullOrWhiteSpace(url) || !IsNetworkAllowed(extension.Manifest, url))
            {
                throw new InvalidOperationException($"Network access denied for {(string.IsNullOrWhiteSpace(url) ? "(empty url)" : url)}");
            }

            using var message = new HttpRequestMessage(new HttpMethod(method), url);
            using var bodyContent = CreateHttpContent(method, headers, request.Body);
            if (bodyContent is not null)
            {
                message.Content = bodyContent;
            }
            foreach (var header in headers)
            {
                if (!message.Headers.TryAddWithoutValidation(header.Key, header.Value))
                {
                    message.Content?.Headers.TryAddWithoutValidation(header.Key, header.Value);
                }
            }

            response = await Http.SendAsync(message, cancellationToken);
            var location = response.Headers.Location?.ToString();
            if (!response.IsSuccessStatusCode &&
                !IsRedirectStatus(response.StatusCode))
            {
                WorkerLog.Debug(
                    "extension fetch failed " +
                    $"extensionId={extension.Id} method={method} url={DescribeFetchUrl(url)} " +
                    $"status={(int)response.StatusCode} reason={response.ReasonPhrase ?? string.Empty}");
            }
            if (!IsRedirectStatus(response.StatusCode) || string.IsNullOrWhiteSpace(location))
            {
                break;
            }
            if (redirectCount == MaxExtensionFetchRedirects)
            {
                throw new InvalidOperationException("Extension fetch exceeded redirect limit");
            }

            var nextUrl = new Uri(new Uri(url), location).ToString();
            if (!IsNetworkAllowed(extension.Manifest, nextUrl))
            {
                throw new InvalidOperationException($"Network access denied for redirect to {nextUrl}");
            }

            WorkerLog.Debug(
                "extension fetch redirect " +
                $"extensionId={extension.Id} method={method} status={(int)response.StatusCode} " +
                $"from={DescribeFetchUrl(url)} to={DescribeFetchUrl(nextUrl)}");
            url = nextUrl;
            if (response.StatusCode == HttpStatusCode.SeeOther)
            {
                method = "GET";
                headers.Remove("Content-Type");
                headers.Remove("content-type");
            }
        }

        if (response is null)
        {
            throw new InvalidOperationException("Extension fetch failed");
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            return new ExtensionFetchResponse(
                response.IsSuccessStatusCode,
                (int)response.StatusCode,
                response.ReasonPhrase ?? string.Empty,
                ReadResponseHeaders(response),
                text,
                TryParseJson(text));
        }
    }

    private static HttpContent? CreateHttpContent(
        string method,
        Dictionary<string, string> headers,
        JsonElement? body)
    {
        if (!body.HasValue || method is "GET" or "HEAD")
        {
            return null;
        }

        HttpContent content;
        if (body.Value.ValueKind == JsonValueKind.String)
        {
            content = new StringContent(body.Value.GetString() ?? string.Empty, Encoding.UTF8);
        }
        else
        {
            content = new StringContent(body.Value.GetRawText(), Encoding.UTF8, "application/json");
            if (!headers.Keys.Any(static key => string.Equals(key, "content-type", StringComparison.OrdinalIgnoreCase)))
            {
                headers["Content-Type"] = "application/json";
            }
        }

        return content;
    }

    private static string DescribeFetchUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            return "(invalid url)";
        }
        return $"{uri.Scheme}://{uri.Host}{uri.AbsolutePath}";
    }

    private static Dictionary<string, string> ReadResponseHeaders(HttpResponseMessage response)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var header in response.Headers)
        {
            result[header.Key.ToLowerInvariant()] = string.Join(", ", header.Value);
        }
        foreach (var header in response.Content.Headers)
        {
            result[header.Key.ToLowerInvariant()] = string.Join(", ", header.Value);
        }
        return result;
    }

    private static JsonElement? TryParseJson(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.Clone();
        }
        catch
        {
            return null;
        }
    }

    private static string EncodeExtensionToolResult(ExtensionToolResult result)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("__openCoworkExtensionResult", true);
            writer.WriteString("extensionId", result.ExtensionId);
            writer.WriteString("toolName", result.ToolName);
            writer.WriteString("text", result.Text);
            writer.WritePropertyName("data");
            WriteExtensionToolData(writer, result.Response);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static ExtensionToolResult NormalizeHttpToolResult(
        NativeExtensionInstance extension,
        NativeExtensionToolDefinition tool,
        ExtensionFetchResponse response)
    {
        return new ExtensionToolResult(
            extension.Id,
            tool.Name,
            response.Ok
                ? $"HTTP {response.Status} {response.StatusText}".Trim()
                : $"HTTP request failed: {response.Status} {response.StatusText}".Trim(),
            response);
    }

    private static void WriteExtensionToolData(Utf8JsonWriter writer, ExtensionFetchResponse response)
    {
        writer.WriteStartObject();
        writer.WriteBoolean("ok", response.Ok);
        writer.WriteNumber("status", response.Status);
        writer.WriteString("statusText", response.StatusText);
        writer.WritePropertyName("headers");
        writer.WriteStartObject();
        foreach (var header in response.Headers.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            writer.WriteString(header.Key, header.Value);
        }
        writer.WriteEndObject();
        writer.WritePropertyName("body");
        if (response.Json.HasValue)
        {
            response.Json.Value.WriteTo(writer);
        }
        else
        {
            writer.WriteStringValue(response.Text);
        }
        writer.WriteEndObject();
    }

    private static bool IsNetworkAllowed(NativeExtensionManifest manifest, string targetUrl)
    {
        if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out var target))
        {
            return false;
        }
        if (target.Scheme is not ("http" or "https"))
        {
            return false;
        }

        var allowlist = manifest.NetworkPermissions;
        if (allowlist.Contains("*", StringComparer.Ordinal))
        {
            return true;
        }
        if (allowlist.Count == 0)
        {
            return false;
        }

        return allowlist.Any(allowed => IsAllowedUrl(target, allowed));
    }

    private static bool IsAllowedUrl(Uri target, string allowed)
    {
        var value = allowed.Trim();
        if (value.Length == 0)
        {
            return false;
        }

        if (value.EndsWith('*'))
        {
            return target.AbsoluteUri.StartsWith(value[..^1], StringComparison.Ordinal);
        }

        if (Uri.TryCreate(value, UriKind.Absolute, out var allowedUrl))
        {
            return string.Equals(target.GetLeftPart(UriPartial.Authority), allowedUrl.GetLeftPart(UriPartial.Authority), StringComparison.Ordinal) &&
                target.AbsoluteUri.StartsWith(allowedUrl.AbsoluteUri, StringComparison.Ordinal);
        }

        return string.Equals(target.GetLeftPart(UriPartial.Authority), value, StringComparison.Ordinal);
    }

    private static bool IsRedirectStatus(HttpStatusCode status)
    {
        return status is HttpStatusCode.MovedPermanently or
            HttpStatusCode.Found or
            HttpStatusCode.SeeOther or
            HttpStatusCode.TemporaryRedirect or
            HttpStatusCode.PermanentRedirect;
    }

    private static string InterpolateString(
        string value,
        JsonElement input,
        IReadOnlyDictionary<string, string> config)
    {
        return InterpolationRegex().Replace(value, match =>
        {
            var scope = match.Groups[1].Value;
            var key = match.Groups[2].Value;
            JsonElement? resolved = scope == "input"
                ? GetNestedValue(input, key)
                : ConfigValueToJson(config, key);
            if (!resolved.HasValue ||
                resolved.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                return string.Empty;
            }

            return resolved.Value.ValueKind == JsonValueKind.String
                ? resolved.Value.GetString() ?? string.Empty
                : resolved.Value.GetRawText();
        });
    }

    private static JsonElement InterpolateValue(
        JsonElement value,
        JsonElement input,
        IReadOnlyDictionary<string, string> config)
    {
        using var document = JsonDocument.Parse(WriteInterpolatedJson(value, input, config));
        return document.RootElement.Clone();
    }

    private static byte[] WriteInterpolatedJson(
        JsonElement value,
        JsonElement input,
        IReadOnlyDictionary<string, string> config)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer, WriterOptions);
        WriteInterpolatedJsonValue(writer, value, input, config);
        writer.Flush();
        return buffer.WrittenMemory.ToArray();
    }

    private static void WriteInterpolatedJsonValue(
        Utf8JsonWriter writer,
        JsonElement value,
        JsonElement input,
        IReadOnlyDictionary<string, string> config)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                writer.WriteStringValue(InterpolateString(value.GetString() ?? string.Empty, input, config));
                break;
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in value.EnumerateObject())
                {
                    writer.WritePropertyName(property.Name);
                    WriteInterpolatedJsonValue(writer, property.Value, input, config);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in value.EnumerateArray())
                {
                    WriteInterpolatedJsonValue(writer, item, input, config);
                }
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }

    private static JsonElement? GetNestedValue(JsonElement source, string dottedPath)
    {
        var current = source;
        foreach (var part in dottedPath.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (current.ValueKind != JsonValueKind.Object ||
                !current.TryGetProperty(part, out current))
            {
                return null;
            }
        }
        return current;
    }

    private static JsonElement? ConfigValueToJson(
        IReadOnlyDictionary<string, string> config,
        string key)
    {
        var parts = key.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 1 || !config.TryGetValue(parts[0], out var value))
        {
            return null;
        }

        using var document = JsonDocument.Parse(
            JsonSerializer.Serialize(value, WorkerJsonContext.Default.String));
        return document.RootElement.Clone();
    }

    private static JsonElement EmptyJsonObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    [GeneratedRegex("\\{\\{\\s*(input|config)\\.([A-Za-z0-9_.-]+)\\s*\\}\\}", RegexOptions.CultureInvariant)]
    private static partial Regex InterpolationRegex();

    private readonly record struct ExtensionFetchRequest(
        string Method,
        string Url,
        IReadOnlyDictionary<string, string> Headers,
        JsonElement? Body);

    private readonly record struct ExtensionFetchResponse(
        bool Ok,
        int Status,
        string StatusText,
        IReadOnlyDictionary<string, string> Headers,
        string Text,
        JsonElement? Json);

    private readonly record struct ExtensionToolResult(
        string ExtensionId,
        string ToolName,
        string Text,
        ExtensionFetchResponse Response);
}
