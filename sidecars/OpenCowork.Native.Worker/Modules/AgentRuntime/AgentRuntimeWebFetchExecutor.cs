using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class AgentRuntimeWebFetchExecutor
{
    private const int DefaultTimeoutMs = 30_000;
    private const int MaxTimeoutMs = 120_000;
    private static readonly HttpClient Http = CreateHttpClient();

    public static bool IsWebFetchTool(string toolName)
    {
        return toolName == "WebFetch";
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        CancellationToken cancellationToken)
    {
        var urls = ReadUrls(call.Input);
        var format = NormalizeFormat(JsonHelpers.GetString(call.Input, "format"));
        var timeoutMs = Math.Clamp(
            JsonHelpers.GetInt(call.Input, "timeout", DefaultTimeoutMs),
            1_000,
            MaxTimeoutMs);

        if (urls.Count == 0)
        {
            return EncodeError("Web fetch requires a url or urls input");
        }

        var tasks = urls.Select(url => FetchUrlAsync(url, format, timeoutMs, cancellationToken)).ToArray();
        var results = await Task.WhenAll(tasks);
        return EncodeResponse(results, format);
    }

    private static HttpClient CreateHttpClient()
    {
        var client = WorkerHttpClientFactory.Create(
            allowAutoRedirect: true,
            maxAutomaticRedirections: 5);
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7");
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "Accept-Language",
            "zh-CN,zh;q=0.9,en;q=0.8");
        return client;
    }

    private static List<string> ReadUrls(JsonElement input)
    {
        var urls = new List<string>();
        if (JsonHelpers.GetString(input, "url") is { Length: > 0 } directUrl)
        {
            urls.Add(directUrl.Trim());
            return urls;
        }

        if (!input.TryGetProperty("urls", out var rawUrls))
        {
            return urls;
        }

        if (rawUrls.ValueKind == JsonValueKind.String &&
            rawUrls.GetString() is { Length: > 0 } url)
        {
            urls.Add(url.Trim());
            return urls;
        }

        if (rawUrls.ValueKind != JsonValueKind.Array)
        {
            return urls;
        }

        foreach (var item in rawUrls.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String &&
                item.GetString() is { Length: > 0 } itemUrl)
            {
                urls.Add(itemUrl.Trim());
            }
        }
        return urls.Where(static item => item.Length > 0).Distinct(StringComparer.Ordinal).ToList();
    }

    private static string NormalizeFormat(string? value)
    {
        return value?.Trim().ToLowerInvariant() switch
        {
            "html" => "html",
            "text" => "text",
            _ => "markdown"
        };
    }

    private static async Task<WebFetchResult> FetchUrlAsync(
        string targetUrl,
        string format,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            timeoutCts.Token);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, targetUrl);
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseContentRead, linkedCts.Token);
            var raw = await response.Content.ReadAsStringAsync(linkedCts.Token);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"HTTP {(int)response.StatusCode}");
            }

            var finalUrl = response.RequestMessage?.RequestUri?.ToString() ?? targetUrl;
            var contentType = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant() ?? string.Empty;
            var looksHtml = contentType.Contains("html", StringComparison.Ordinal) ||
                Regex.IsMatch(raw, "<html\\b|<body\\b|<main\\b|<article\\b", RegexOptions.IgnoreCase);
            var content = raw;
            string? title = null;

            if (looksHtml)
            {
                title = ExtractTitleFromHtml(raw);
                content = format switch
                {
                    "html" => raw,
                    "text" => StripHtml(SanitizeHtmlForContent(ExtractPreferredContentHtml(raw))),
                    _ => ConvertHtmlToMarkdown(raw, finalUrl)
                };
            }
            else if (format is "markdown" or "text")
            {
                content = raw.Trim();
            }

            return new WebFetchResult(targetUrl, finalUrl, title, content, format, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || timeoutCts.IsCancellationRequested)
        {
            var message = timeoutCts.IsCancellationRequested
                ? $"Request timeout after {timeoutMs}ms"
                : ex.Message;
            return new WebFetchResult(targetUrl, null, null, string.Empty, format, message);
        }
    }

    private static string ExtractHtmlTagContent(string html, string tagName)
    {
        var match = Regex.Match(
            html,
            $"<{tagName}\\b[^>]*>([\\s\\S]*?)</{tagName}>",
            RegexOptions.IgnoreCase);
        return match.Success ? match.Groups[1].Value : string.Empty;
    }

    private static string ExtractPreferredContentHtml(string html)
    {
        var article = ExtractHtmlTagContent(html, "article");
        if (!string.IsNullOrWhiteSpace(article))
        {
            return article;
        }
        var main = ExtractHtmlTagContent(html, "main");
        if (!string.IsNullOrWhiteSpace(main))
        {
            return main;
        }
        var body = ExtractHtmlTagContent(html, "body");
        return string.IsNullOrWhiteSpace(body) ? html : body;
    }

    private static string SanitizeHtmlForContent(string html)
    {
        return Regex.Replace(
            Regex.Replace(
                Regex.Replace(
                    Regex.Replace(
                        Regex.Replace(html, "<!--[\\s\\S]*?-->", " "),
                        "<script\\b[^>]*>[\\s\\S]*?</script>",
                        " ",
                        RegexOptions.IgnoreCase),
                    "<style\\b[^>]*>[\\s\\S]*?</style>",
                    " ",
                    RegexOptions.IgnoreCase),
                "<noscript\\b[^>]*>[\\s\\S]*?</noscript>",
                " ",
                RegexOptions.IgnoreCase),
            "<(nav|header|footer|aside|form|button|svg|canvas)\\b[^>]*>[\\s\\S]*?</\\1>",
            " ",
            RegexOptions.IgnoreCase);
    }

    private static string ExtractTitleFromHtml(string html)
    {
        var title = ExtractHtmlTagContent(html, "title");
        return StripHtml(title);
    }

    private static string ConvertHtmlToMarkdown(string html, string baseUrl)
    {
        var markdown = SanitizeHtmlForContent(ExtractPreferredContentHtml(html));
        markdown = Regex.Replace(
            markdown,
            "<pre\\b[^>]*><code\\b[^>]*>([\\s\\S]*?)</code></pre>",
            match => $"\n\n@@CODE_BLOCK_START@@\n{DecodeHtml(match.Groups[1].Value).Trim()}\n@@CODE_BLOCK_END@@\n\n",
            RegexOptions.IgnoreCase);
        markdown = Regex.Replace(
            markdown,
            "<pre\\b[^>]*>([\\s\\S]*?)</pre>",
            match => $"\n\n@@CODE_BLOCK_START@@\n{StripHtml(match.Groups[1].Value)}\n@@CODE_BLOCK_END@@\n\n",
            RegexOptions.IgnoreCase);
        markdown = Regex.Replace(
            markdown,
            "<h([1-6])\\b[^>]*>([\\s\\S]*?)</h\\1>",
            match => $"\n\n{new string('#', int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture))} {ConvertInlineHtmlToMarkdown(match.Groups[2].Value, baseUrl)}\n\n",
            RegexOptions.IgnoreCase);
        markdown = Regex.Replace(
            markdown,
            "<blockquote\\b[^>]*>([\\s\\S]*?)</blockquote>",
            match =>
            {
                var lines = ConvertInlineHtmlToMarkdown(match.Groups[1].Value, baseUrl)
                    .Split('\n')
                    .Select(static line => line.Trim())
                    .Where(static line => line.Length > 0);
                return $"\n\n{string.Join('\n', lines.Select(static line => $"> {line}"))}\n\n";
            },
            RegexOptions.IgnoreCase);
        markdown = Regex.Replace(
            markdown,
            "<li\\b[^>]*>([\\s\\S]*?)</li>",
            match => $"- {ConvertInlineHtmlToMarkdown(match.Groups[1].Value, baseUrl)}\n",
            RegexOptions.IgnoreCase);
        markdown = Regex.Replace(markdown, "</(ul|ol)>", "\n", RegexOptions.IgnoreCase);
        markdown = Regex.Replace(markdown, "<(ul|ol)\\b[^>]*>", "\n", RegexOptions.IgnoreCase);
        markdown = Regex.Replace(
            markdown,
            "<(p|div|section|article|main)\\b[^>]*>([\\s\\S]*?)</\\1>",
            match =>
            {
                var converted = ConvertInlineHtmlToMarkdown(match.Groups[2].Value, baseUrl);
                return converted.Length > 0 ? $"\n\n{converted}\n\n" : "\n";
            },
            RegexOptions.IgnoreCase);
        markdown = Regex.Replace(markdown, "<table\\b[^>]*>[\\s\\S]*?</table>", string.Empty, RegexOptions.IgnoreCase);
        markdown = Regex.Replace(markdown, "<hr\\s*/?>", "\n\n---\n\n", RegexOptions.IgnoreCase);

        return NormalizeMarkdownOutput(
            DecodeHtml(markdown)
                .Replace("@@CODE_BLOCK_START@@", "```", StringComparison.Ordinal)
                .Replace("@@CODE_BLOCK_END@@", "```", StringComparison.Ordinal));
    }

    private static string ConvertInlineHtmlToMarkdown(string input, string baseUrl)
    {
        var value = input;
        value = Regex.Replace(
            value,
            "<img\\b[^>]*src=[\"']([^\"']+)[\"'][^>]*alt=[\"']([^\"']*)[\"'][^>]*>",
            match => $"![{StripHtml(match.Groups[2].Value)}]({ResolveAbsoluteUrl(match.Groups[1].Value, baseUrl)})",
            RegexOptions.IgnoreCase);
        value = Regex.Replace(
            value,
            "<img\\b[^>]*alt=[\"']([^\"']*)[\"'][^>]*src=[\"']([^\"']+)[\"'][^>]*>",
            match => $"![{StripHtml(match.Groups[1].Value)}]({ResolveAbsoluteUrl(match.Groups[2].Value, baseUrl)})",
            RegexOptions.IgnoreCase);
        value = Regex.Replace(
            value,
            "<img\\b[^>]*src=[\"']([^\"']+)[\"'][^>]*>",
            match => $"![]({ResolveAbsoluteUrl(match.Groups[1].Value, baseUrl)})",
            RegexOptions.IgnoreCase);
        value = Regex.Replace(
            value,
            "<a\\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</a>",
            match =>
            {
                var target = ResolveAbsoluteUrl(match.Groups[1].Value, baseUrl);
                var label = StripHtml(match.Groups[2].Value);
                return $"[{(label.Length > 0 ? label : target)}]({target})";
            },
            RegexOptions.IgnoreCase);
        value = Regex.Replace(
            value,
            "<(strong|b)\\b[^>]*>([\\s\\S]*?)</\\1>",
            match => $"**{StripHtml(match.Groups[2].Value)}**",
            RegexOptions.IgnoreCase);
        value = Regex.Replace(
            value,
            "<(em|i)\\b[^>]*>([\\s\\S]*?)</\\1>",
            match => $"*{StripHtml(match.Groups[2].Value)}*",
            RegexOptions.IgnoreCase);
        value = Regex.Replace(
            value,
            "<code\\b[^>]*>([\\s\\S]*?)</code>",
            match => $"`{StripHtml(match.Groups[1].Value).Replace("`", "\\`", StringComparison.Ordinal)}`",
            RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "<br\\s*/?>", "\n", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "<[^>]+>", " ");
        return NormalizeInlineMarkdown(DecodeHtml(value));
    }

    private static string StripHtml(string input)
    {
        var sanitized = Regex.Replace(input, "<script\\b[^>]*>[\\s\\S]*?</script>", " ", RegexOptions.IgnoreCase);
        sanitized = Regex.Replace(sanitized, "<style\\b[^>]*>[\\s\\S]*?</style>", " ", RegexOptions.IgnoreCase);
        sanitized = Regex.Replace(sanitized, "<em\\b[^>]*>", string.Empty, RegexOptions.IgnoreCase);
        sanitized = Regex.Replace(sanitized, "</em>", string.Empty, RegexOptions.IgnoreCase);
        sanitized = Regex.Replace(sanitized, "<[^>]+>", " ");
        sanitized = DecodeHtml(sanitized);
        return Regex.Replace(sanitized, "\\s+", " ").Trim();
    }

    private static string ResolveAbsoluteUrl(string value, string baseUrl)
    {
        return Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri) &&
            Uri.TryCreate(baseUri, value, out var uri)
            ? uri.ToString()
            : value;
    }

    private static string NormalizeMarkdownOutput(string value)
    {
        value = Regex.Replace(value, "<[^>]+>", " ");
        value = Regex.Replace(value, "[ \\t]+\\n", "\n");
        value = Regex.Replace(value, "\\n[ \\t]+", "\n");
        value = Regex.Replace(value, "\\n{3,}", "\n\n");
        return value.Trim();
    }

    private static string NormalizeInlineMarkdown(string value)
    {
        value = Regex.Replace(value, "[ \\t]+", " ");
        value = Regex.Replace(value, " *\\n *", "\n");
        return value.Trim();
    }

    private static string DecodeHtml(string value)
    {
        return WebUtility.HtmlDecode(value) ?? string.Empty;
    }

    private static string EncodeResponse(IReadOnlyList<WebFetchResult> results, string format)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("results");
            writer.WriteStartArray();
            foreach (var result in results)
            {
                writer.WriteStartObject();
                writer.WriteString("url", result.Url);
                if (!string.IsNullOrWhiteSpace(result.FinalUrl))
                {
                    writer.WriteString("finalUrl", result.FinalUrl);
                }
                if (!string.IsNullOrWhiteSpace(result.Title))
                {
                    writer.WriteString("title", result.Title);
                }
                writer.WriteString("content", result.Content);
                writer.WriteString("format", result.Format);
                if (!string.IsNullOrWhiteSpace(result.Error))
                {
                    writer.WriteString("error", result.Error);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteString("format", format);
            writer.WriteNumber("totalResults", results.Count(static item => string.IsNullOrWhiteSpace(item.Error)));
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string EncodeError(string message)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private sealed record WebFetchResult(
        string Url,
        string? FinalUrl,
        string? Title,
        string Content,
        string Format,
        string? Error);
}
