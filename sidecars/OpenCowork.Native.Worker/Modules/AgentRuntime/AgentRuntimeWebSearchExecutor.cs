using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class AgentRuntimeWebSearchExecutor
{
    private const int DefaultTimeoutMs = 30_000;
    private const int DefaultMaxResults = 5;
    private const int MaxResultsLimit = 50;
    private const int MaxTimeoutMs = 120_000;
    private static readonly HttpClient Http = CreateHttpClient();

    public static bool IsWebSearchTool(string toolName)
    {
        return toolName == "WebSearch";
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var query = JsonHelpers.GetString(call.Input, "query")?.Trim() ?? string.Empty;
        if (query.Length == 0)
        {
            return EncodeError("Web search requires a query input");
        }

        var config = ReadConfig(parameters);
        if (config is null || !config.Enabled)
        {
            return EncodeError("Web search is not enabled for this native agent run");
        }

        var request = new WebSearchRequest(
            query,
            config.Provider,
            Math.Clamp(
                JsonHelpers.GetInt(call.Input, "maxResults", config.MaxResults ?? DefaultMaxResults),
                1,
                MaxResultsLimit),
            JsonHelpers.GetString(call.Input, "searchMode") ?? "web",
            config.ApiKey,
            Math.Clamp(config.TimeoutMs ?? DefaultTimeoutMs, 1_000, MaxTimeoutMs));

        try
        {
            var response = request.Provider switch
            {
                "tavily" => await SearchTavilyAsync(request, cancellationToken),
                "searxng" => await SearchSearxngAsync(request, cancellationToken),
                "exa" => await SearchExaAsync(request, cancellationToken),
                "exa-mcp" => SearchExaMcp(request),
                "bocha" => await SearchBochaAsync(request, cancellationToken),
                "zhipu" => await SearchZhipuAsync(request, cancellationToken),
                "google" => await SearchGoogleAsync(request, cancellationToken),
                "bing" => await SearchBingAsync(request, cancellationToken),
                "baidu" => await SearchBaiduAsync(request, cancellationToken),
                _ => throw new InvalidOperationException($"Unsupported provider: {request.Provider}")
            };
            return EncodeResponse(response);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return EncodeError($"Web search failed: {ex.Message}");
        }
    }

    private static HttpClient CreateHttpClient()
    {
        var client = WorkerHttpClientFactory.Create(
            allowAutoRedirect: true,
            maxAutomaticRedirections: 5);
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
        return client;
    }

    private static WebSearchConfig? ReadConfig(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("webSearch", out var config) ||
            config.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var provider = JsonHelpers.GetString(config, "provider") ?? string.Empty;
        if (provider.Length == 0)
        {
            return null;
        }

        return new WebSearchConfig(
            JsonHelpers.GetBool(config, "enabled", false),
            provider,
            JsonHelpers.GetString(config, "apiKey"),
            JsonHelpers.GetIntNullable(config, "maxResults"),
            JsonHelpers.GetIntNullable(config, "timeout"));
    }

    private static async Task<WebSearchResponse> SearchGoogleAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        var url = $"https://www.google.com/search?hl=en&num={request.MaxResults}&gbv=1&q={Uri.EscapeDataString(request.Query)}";
        var response = await SendGetAsync(
            url,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ["Accept-Language"] = "en-US,en;q=0.9",
                ["Cache-Control"] = "no-cache",
                ["Pragma"] = "no-cache"
            },
            request.TimeoutMs,
            cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Google search error: {response.StatusCode}");
        }
        if (Regex.IsMatch(response.Body, "unusual traffic|detected unusual traffic|sorry/index|To continue, please type", RegexOptions.IgnoreCase))
        {
            throw new InvalidOperationException("Google blocked background crawling for this request");
        }

        var results = ExtractGoogleResults(response.Body, request.MaxResults);
        if (results.Count == 0)
        {
            throw new InvalidOperationException("Google returned no parseable search results");
        }
        return new WebSearchResponse(results, request.Query, "google", results.Count);
    }

    private static async Task<WebSearchResponse> SearchBingAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        var url = $"https://www.bing.com/search?q={Uri.EscapeDataString(request.Query)}&count={request.MaxResults}";
        var response = await SendGetAsync(
            url,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ["Accept-Language"] = "en-US,en;q=0.9",
                ["Cache-Control"] = "no-cache",
                ["Pragma"] = "no-cache"
            },
            request.TimeoutMs,
            cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Bing search error: {response.StatusCode}");
        }

        var results = ExtractBingResults(response.Body, request.MaxResults);
        if (results.Count == 0)
        {
            throw new InvalidOperationException("Bing returned no parseable search results");
        }
        return new WebSearchResponse(results, request.Query, "bing", results.Count);
    }

    private static async Task<WebSearchResponse> SearchBaiduAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        var url = $"https://www.baidu.com/s?wd={Uri.EscapeDataString(request.Query)}&rn={request.MaxResults}";
        var response = await SendGetAsync(
            url,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ["Accept-Language"] = "zh-CN,zh;q=0.9,en;q=0.8",
                ["Cache-Control"] = "no-cache",
                ["Pragma"] = "no-cache"
            },
            request.TimeoutMs,
            cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Baidu search error: {response.StatusCode}");
        }
        if (Regex.IsMatch(response.Body, "百度安全验证|网络不给力|请输入验证码|verify", RegexOptions.IgnoreCase))
        {
            throw new InvalidOperationException("Baidu blocked background crawling for this request");
        }

        var results = ExtractBaiduResults(response.Body, request.MaxResults);
        if (results.Count == 0)
        {
            throw new InvalidOperationException("Baidu returned no parseable search results");
        }
        return new WebSearchResponse(results, request.Query, "baidu", results.Count);
    }

    private static async Task<WebSearchResponse> SearchTavilyAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.ApiKey))
        {
            throw new InvalidOperationException("Tavily API key is required");
        }

        var body = EncodeJsonObject(writer =>
        {
            writer.WriteString("query", request.Query);
            writer.WriteString("api_key", request.ApiKey);
            writer.WriteNumber("max_results", request.MaxResults);
            writer.WriteString("search_mode", request.SearchMode);
        });
        var response = await SendJsonPostAsync("https://api.tavily.com/search", body, null, request.TimeoutMs, cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Tavily API error: {response.StatusCode} - {response.Body}");
        }
        return ParseProviderJsonResponse(response.Body, request.Query, "tavily", "content");
    }

    private static async Task<WebSearchResponse> SearchSearxngAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        var url = $"https://searxng.org/search?q={Uri.EscapeDataString(request.Query)}&format=json&limit={request.MaxResults}";
        var response = await SendGetAsync(url, null, request.TimeoutMs, cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Searxng API error: {response.StatusCode} - {response.Body}");
        }
        return ParseProviderJsonResponse(response.Body, request.Query, "searxng", "content");
    }

    private static async Task<WebSearchResponse> SearchExaAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.ApiKey))
        {
            throw new InvalidOperationException("Exa API key is required");
        }

        var body = EncodeJsonObject(writer =>
        {
            writer.WriteString("query", request.Query);
            writer.WriteNumber("numResults", request.MaxResults);
            writer.WriteString("searchMode", request.SearchMode);
        });
        var response = await SendJsonPostAsync(
            "https://api.exa.ai/search",
            body,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["x-api-key"] = request.ApiKey },
            request.TimeoutMs,
            cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Exa API error: {response.StatusCode} - {response.Body}");
        }
        return ParseProviderJsonResponse(response.Body, request.Query, "exa", "snippet");
    }

    private static async Task<WebSearchResponse> SearchBochaAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.ApiKey))
        {
            throw new InvalidOperationException("Bocha API key is required");
        }

        var body = EncodeJsonObject(writer =>
        {
            writer.WriteString("query", request.Query);
            writer.WriteNumber("limit", request.MaxResults);
        });
        var response = await SendJsonPostAsync(
            "https://api.bocha.cn/search",
            body,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Authorization"] = $"Bearer {request.ApiKey}" },
            request.TimeoutMs,
            cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Bocha API error: {response.StatusCode} - {response.Body}");
        }
        return ParseProviderJsonResponse(response.Body, request.Query, "bocha", "snippet");
    }

    private static async Task<WebSearchResponse> SearchZhipuAsync(
        WebSearchRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.ApiKey))
        {
            throw new InvalidOperationException("Zhipu API key is required");
        }

        var body = EncodeJsonObject(writer =>
        {
            writer.WriteString("prompt", request.Query);
            writer.WriteNumber("max_results", request.MaxResults);
        });
        var response = await SendJsonPostAsync(
            "https://open.bigmodel.cn/api/paas/v4/tools/search",
            body,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Authorization"] = $"Bearer {request.ApiKey}" },
            request.TimeoutMs,
            cancellationToken);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"Zhipu API error: {response.StatusCode} - {response.Body}");
        }
        return ParseProviderJsonResponse(response.Body, request.Query, "zhipu", "content", fallbackContentProperty: "snippet");
    }

    private static WebSearchResponse SearchExaMcp(WebSearchRequest request)
    {
        return new WebSearchResponse(
            [
                new WebSearchResult(
                    "Exa MCP Search",
                    string.Empty,
                    "Exa MCP search requires an MCP server connection. Please configure an MCP server with Exa search capabilities.",
                    null,
                    null)
            ],
            request.Query,
            "exa-mcp",
            0);
    }

    private static WebSearchResponse ParseProviderJsonResponse(
        string body,
        string query,
        string provider,
        string contentProperty,
        string? fallbackContentProperty = null)
    {
        using var document = JsonDocument.Parse(body);
        var results = new List<WebSearchResult>();
        if (document.RootElement.TryGetProperty("results", out var resultArray) &&
            resultArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in resultArray.EnumerateArray())
            {
                var content = JsonHelpers.GetString(item, contentProperty) ??
                    (fallbackContentProperty is null ? null : JsonHelpers.GetString(item, fallbackContentProperty)) ??
                    string.Empty;
                results.Add(new WebSearchResult(
                    JsonHelpers.GetString(item, "title") ?? string.Empty,
                    JsonHelpers.GetString(item, "url") ?? string.Empty,
                    content,
                    ReadDouble(item, "score"),
                    JsonHelpers.GetString(item, "published_date") ?? JsonHelpers.GetString(item, "publishedDate")));
            }
        }
        return new WebSearchResponse(results, query, provider, results.Count);
    }

    private static List<WebSearchResult> ExtractGoogleResults(string html, int maxResults)
    {
        const string pattern = "<a\\b[^>]*href=[\"']([^\"']*(?:/url\\?(?:[^\"']*?[?&])?(?:q|url)=[^\"']+|https?://[^\"']+))[\"'][^>]*>[\\s\\S]*?<h3\\b[^>]*>([\\s\\S]*?)</h3>";
        var headings = Regex.Matches(html, pattern, RegexOptions.IgnoreCase);
        var results = new List<WebSearchResult>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        for (var index = 0; index < headings.Count && results.Count < maxResults; index++)
        {
            var match = headings[index];
            var title = StripHtml(match.Groups[2].Value);
            var url = ResolveSearchResultUrl("google", match.Groups[1].Value);
            if (title.Length == 0 || url.Length == 0 || url.Contains("/search?", StringComparison.Ordinal))
            {
                continue;
            }

            var dedupeKey = $"{title}::{url}";
            if (!seen.Add(dedupeKey))
            {
                continue;
            }

            var start = match.Index;
            var nextStart = index + 1 < headings.Count
                ? headings[index + 1].Index
                : Math.Min(start + 6000, html.Length);
            var section = html[start..Math.Min(nextStart, Math.Min(start + 6000, html.Length))];
            var snippet = ExtractSnippet(
                section,
                [
                    "<div\\b[^>]*class=[\"'][^\"']*(?:VwiC3b|yXK7lf|MUxGbd|kvH3mc)[^\"']*[\"'][^>]*>([\\s\\S]*?)</div>",
                    "<span\\b[^>]*class=[\"'][^\"']*(?:aCOpRe|hgKElc)[^\"']*[\"'][^>]*>([\\s\\S]*?)</span>",
                    "<div\\b[^>]*data-sncf=[\"'][^\"']*[\"'][^>]*>([\\s\\S]*?)</div>"
                ],
                title);
            results.Add(new WebSearchResult(title, url, snippet, null, null));
        }
        return results;
    }

    private static List<WebSearchResult> ExtractBingResults(string html, int maxResults)
    {
        var blocks = Regex.Matches(html, "<li\\b[^>]*class=[\"'][^\"']*b_algo[^\"']*[\"'][^>]*>([\\s\\S]*?)</li>", RegexOptions.IgnoreCase);
        var results = new List<WebSearchResult>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match block in blocks)
        {
            if (results.Count >= maxResults)
            {
                break;
            }
            var section = block.Groups[1].Value;
            var heading = Regex.Match(section, "<h2\\b[^>]*>\\s*<a\\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</a>\\s*</h2>", RegexOptions.IgnoreCase);
            if (!heading.Success)
            {
                continue;
            }
            var title = StripHtml(heading.Groups[2].Value);
            var url = ResolveSearchResultUrl("bing", heading.Groups[1].Value);
            if (title.Length == 0 || url.Length == 0 || !seen.Add($"{title}::{url}"))
            {
                continue;
            }
            var snippet = ExtractSnippet(
                section,
                [
                    "<div\\b[^>]*class=[\"'][^\"']*b_caption[^\"']*[\"'][^>]*>[\\s\\S]*?<p>([\\s\\S]*?)</p>",
                    "<p>([\\s\\S]*?)</p>"
                ],
                title);
            results.Add(new WebSearchResult(title, url, snippet, null, null));
        }
        return results;
    }

    private static List<WebSearchResult> ExtractBaiduResults(string html, int maxResults)
    {
        var headings = Regex.Matches(html, "<h3\\b[^>]*>[\\s\\S]*?<a\\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</a>[\\s\\S]*?</h3>", RegexOptions.IgnoreCase);
        var results = new List<WebSearchResult>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < headings.Count && results.Count < maxResults; index++)
        {
            var match = headings[index];
            var title = StripHtml(match.Groups[2].Value);
            var url = ResolveSearchResultUrl("baidu", match.Groups[1].Value);
            if (title.Length == 0 || url.Length == 0 || !seen.Add($"{title}::{url}"))
            {
                continue;
            }
            var start = match.Index;
            var nextStart = index + 1 < headings.Count
                ? headings[index + 1].Index
                : Math.Min(start + 4000, html.Length);
            var section = html[start..Math.Min(nextStart, Math.Min(start + 4000, html.Length))];
            var snippet = ExtractSnippet(
                section,
                [
                    "<(div|span|p)\\b[^>]*class=[\"'][^\"']*(?:c-abstract|content-right_[^\"']*|content-right|c-span-last|c-color-text|result-op[^\"']*)[^\"']*[\"'][^>]*>([\\s\\S]*?)</\\1>"
                ],
                title,
                groupIndex: 2);
            results.Add(new WebSearchResult(title, url, snippet, null, null));
        }
        return results;
    }

    private static string ExtractSnippet(
        string section,
        IReadOnlyList<string> patterns,
        string title,
        int groupIndex = 1)
    {
        foreach (var pattern in patterns)
        {
            var match = Regex.Match(section, pattern, RegexOptions.IgnoreCase);
            if (!match.Success)
            {
                continue;
            }
            var text = StripHtml(match.Groups[groupIndex].Value);
            if (text.Length > 0 && text != title)
            {
                return text;
            }
        }
        return StripHtml(section).Replace(title, string.Empty, StringComparison.Ordinal).Trim();
    }

    private static async Task<HttpTextResponse> SendGetAsync(
        string url,
        IReadOnlyDictionary<string, string>? headers,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        ApplyHeaders(request, headers);
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseContentRead, linkedCts.Token);
        return new HttpTextResponse((int)response.StatusCode, await response.Content.ReadAsStringAsync(linkedCts.Token));
    }

    private static async Task<HttpTextResponse> SendJsonPostAsync(
        string url,
        string body,
        IReadOnlyDictionary<string, string>? headers,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        ApplyHeaders(request, headers);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseContentRead, linkedCts.Token);
        return new HttpTextResponse((int)response.StatusCode, await response.Content.ReadAsStringAsync(linkedCts.Token));
    }

    private static void ApplyHeaders(HttpRequestMessage request, IReadOnlyDictionary<string, string>? headers)
    {
        if (headers is null)
        {
            return;
        }
        foreach (var header in headers)
        {
            request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    private static string ResolveSearchResultUrl(string provider, string rawUrl)
    {
        var normalized = NormalizeUrl(rawUrl);
        if (provider == "google")
        {
            try
            {
                var absolute = normalized.StartsWith("/url?", StringComparison.Ordinal)
                    ? $"https://www.google.com{normalized}"
                    : normalized;
                var uri = new Uri(absolute);
                return NormalizeUrl(ReadQueryValue(uri.Query, "q") ?? ReadQueryValue(uri.Query, "url") ?? normalized);
            }
            catch
            {
                return normalized;
            }
        }

        if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            var baseUrl = provider == "bing" ? "https://www.bing.com" : "https://www.baidu.com";
            return $"{baseUrl}{normalized}";
        }
        return normalized;
    }

    private static string? ReadQueryValue(string query, string name)
    {
        var trimmed = query.TrimStart('?');
        foreach (var part in trimmed.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = part.IndexOf('=', StringComparison.Ordinal);
            var rawName = separator >= 0 ? part[..separator] : part;
            if (!string.Equals(Uri.UnescapeDataString(rawName), name, StringComparison.Ordinal))
            {
                continue;
            }
            var rawValue = separator >= 0 ? part[(separator + 1)..] : string.Empty;
            return Uri.UnescapeDataString(rawValue.Replace("+", " ", StringComparison.Ordinal));
        }
        return null;
    }

    private static string NormalizeUrl(string value)
    {
        return DecodeHtml(value)
            .Replace("\\u002F", "/", StringComparison.Ordinal)
            .Replace("\\u003A", ":", StringComparison.Ordinal)
            .Trim();
    }

    private static string StripHtml(string input)
    {
        var value = Regex.Replace(input, "<script\\b[^>]*>[\\s\\S]*?</script>", " ", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "<style\\b[^>]*>[\\s\\S]*?</style>", " ", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "<em\\b[^>]*>", string.Empty, RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "</em>", string.Empty, RegexOptions.IgnoreCase);
        value = Regex.Replace(value, "<[^>]+>", " ");
        value = DecodeHtml(value);
        return Regex.Replace(value, "\\s+", " ").Trim();
    }

    private static string DecodeHtml(string value)
    {
        return WebUtility.HtmlDecode(value) ?? string.Empty;
    }

    private static double? ReadDouble(JsonElement item, string propertyName)
    {
        return item.ValueKind == JsonValueKind.Object &&
            item.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Number &&
            property.TryGetDouble(out var value)
                ? value
                : null;
    }

    private static string EncodeResponse(WebSearchResponse response)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WritePropertyName("results");
            writer.WriteStartArray();
            foreach (var result in response.Results)
            {
                writer.WriteStartObject();
                writer.WriteString("title", result.Title);
                writer.WriteString("url", result.Url);
                writer.WriteString("content", result.Content);
                if (result.Score.HasValue)
                {
                    writer.WriteNumber("score", result.Score.Value);
                }
                if (!string.IsNullOrWhiteSpace(result.PublishedDate))
                {
                    writer.WriteString("publishedDate", result.PublishedDate);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteString("query", response.Query);
            writer.WriteString("provider", response.Provider);
            writer.WriteNumber("totalResults", response.TotalResults);
        });
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private sealed record WebSearchConfig(
        bool Enabled,
        string Provider,
        string? ApiKey,
        int? MaxResults,
        int? TimeoutMs);

    private sealed record WebSearchRequest(
        string Query,
        string Provider,
        int MaxResults,
        string SearchMode,
        string? ApiKey,
        int TimeoutMs);

    private sealed record WebSearchResponse(
        List<WebSearchResult> Results,
        string Query,
        string Provider,
        int TotalResults);

    private sealed record WebSearchResult(
        string Title,
        string Url,
        string Content,
        double? Score,
        string? PublishedDate);

    private sealed record HttpTextResponse(int StatusCode, string Body);
}
