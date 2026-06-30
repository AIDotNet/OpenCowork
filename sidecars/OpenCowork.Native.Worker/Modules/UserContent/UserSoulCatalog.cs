using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class UserSoulCatalog
{
    private const string DirectoryName = "souls";
    private const string MarketBaseUrl = "https://skills.open-cowork.shop";
    private const string MarketApiBaseUrl = MarketBaseUrl + "/api/v1";
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(TimeSpan.FromSeconds(60));

    private static readonly SoulCategory[] FallbackCategories =
    [
        new("assistant", "Assistant"),
        new("workflow", "Workflow"),
        new("coding", "Coding"),
        new("writing", "Writing"),
        new("research", "Research"),
        new("roleplay", "Roleplay"),
        new("business", "Business"),
        new("learning", "Learning")
    ];

    public static WorkerResponse BuiltinList(JsonElement parameters)
    {
        try
        {
            var templates = new JsonArray();
            foreach (var template in ReadTemplateMetadata(parameters))
            {
                var filePath = Path.Combine(GetBundledSoulsDirectory(parameters), template.Filename);
                templates.Add((JsonNode?)new JsonObject
                {
                    ["id"] = template.Id,
                    ["name"] = template.Name,
                    ["description"] = template.Description,
                    ["category"] = template.Category,
                    ["tags"] = ToStringArrayNode(template.Tags),
                    ["filename"] = template.Filename,
                    ["content"] = UserContentPaths.ReadText(filePath)
                });
            }

            return UserContentPaths.JsonNode(new JsonObject { ["templates"] = templates });
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(new JsonObject
            {
                ["templates"] = new JsonArray(),
                ["error"] = ex.Message
            });
        }
    }

    public static async Task<WorkerResponse> MarketListAsync(JsonElement parameters)
    {
        try
        {
            var limit = Math.Min(JsonHelpers.GetInt(parameters, "limit", 20), 100);
            if (limit <= 0)
            {
                limit = 20;
            }

            var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));
            var page = (offset / limit) + 1;
            var query = JsonHelpers.GetString(parameters, "query")?.Trim();
            var category = JsonHelpers.GetString(parameters, "category")?.Trim();
            var sortBy = JsonHelpers.GetString(parameters, "sortBy")?.Trim();
            if (string.IsNullOrWhiteSpace(sortBy))
            {
                sortBy = "recent";
            }

            var url =
                $"{MarketApiBaseUrl}/souls/search?page={page}&limit={limit}&sortBy={Uri.EscapeDataString(sortBy)}";
            if (!string.IsNullOrWhiteSpace(query))
            {
                url += $"&q={Uri.EscapeDataString(query)}";
            }
            if (!string.IsNullOrWhiteSpace(category))
            {
                url += $"&category={Uri.EscapeDataString(category)}";
            }

            using var document = await FetchJsonAsync(url, parameters);
            return UserContentPaths.JsonNode(ParseSoulsResponse(document.RootElement));
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"souls market list failed error={ex.GetType().Name}: {ex.Message}");
            return UserContentPaths.JsonNode(new JsonObject
            {
                ["total"] = 0,
                ["souls"] = new JsonArray(),
                ["error"] = ex.Message
            });
        }
    }

    public static async Task<WorkerResponse> CategoriesAsync(JsonElement parameters)
    {
        try
        {
            using var document = await FetchJsonAsync($"{MarketApiBaseUrl}/souls/categories", parameters);
            return UserContentPaths.JsonNode(new JsonObject
            {
                ["categories"] = ParseCategories(document.RootElement)
            });
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"souls categories failed error={ex.GetType().Name}: {ex.Message}");
            return UserContentPaths.JsonNode(new JsonObject
            {
                ["categories"] = ToCategoryArray(FallbackCategories)
            });
        }
    }

    public static async Task<WorkerResponse> DownloadRemoteAsync(JsonElement parameters)
    {
        try
        {
            var slug = JsonHelpers.GetString(parameters, "slug")?.Trim();
            if (string.IsNullOrWhiteSpace(slug))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error("Missing SOUL slug for marketplace download"));
            }

            var downloadUrl = JsonHelpers.GetString(parameters, "downloadUrl")?.Trim();
            if (string.IsNullOrWhiteSpace(downloadUrl))
            {
                downloadUrl = $"{MarketApiBaseUrl}/souls/{Uri.EscapeDataString(slug)}/download";
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, downloadUrl);
            ApplyCommonHeaders(request, parameters, "text/markdown, text/plain;q=0.9, */*;q=0.8");
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error(
                    $"SOUL marketplace download failed {(int)response.StatusCode}: {ExtractErrorDetail(body)}"));
            }

            return UserContentPaths.JsonNode(new JsonObject { ["content"] = body });
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(UserContentPaths.Error(ex.Message));
        }
    }

    public static WorkerResponse GetTargetPaths(JsonElement parameters)
    {
        var projectPath = ResolveProjectSoulPath(JsonHelpers.GetString(parameters, "projectRootPath"));
        return UserContentPaths.JsonNode(new JsonObject
        {
            ["global"] = new JsonObject
            {
                ["available"] = true,
                ["path"] = ResolveGlobalSoulPath()
            },
            ["project"] = new JsonObject
            {
                ["available"] = projectPath is not null,
                ["path"] = projectPath is null ? null : JsonValue.Create(projectPath)
            }
        });
    }

    public static WorkerResponse Install(JsonElement parameters)
    {
        try
        {
            var content = JsonHelpers.GetString(parameters, "content") ?? string.Empty;
            if (string.IsNullOrWhiteSpace(content))
            {
                return SoulMutation(false, null, "SOUL content is empty");
            }

            var target = JsonHelpers.GetString(parameters, "target");
            var targetPath = string.Equals(target, "project", StringComparison.Ordinal)
                ? ResolveProjectSoulPath(JsonHelpers.GetString(parameters, "projectRootPath"))
                : ResolveGlobalSoulPath();
            if (string.IsNullOrWhiteSpace(targetPath))
            {
                return SoulMutation(false, null, "Project SOUL target is unavailable");
            }

            UserContentPaths.WriteText(targetPath, content);
            return SoulMutation(true, targetPath, null);
        }
        catch (Exception ex)
        {
            return SoulMutation(false, null, ex.Message);
        }
    }

    private static async Task<JsonDocument> FetchJsonAsync(string url, JsonElement parameters)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        ApplyCommonHeaders(request, parameters, "application/json");
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"SOUL marketplace API {(int)response.StatusCode}: {ExtractErrorDetail(body)}");
        }

        return JsonDocument.Parse(body);
    }

    private static void ApplyCommonHeaders(HttpRequestMessage request, JsonElement parameters, string accept)
    {
        request.Headers.Accept.ParseAdd(accept);
        var userAgent = JsonHelpers.GetString(parameters, "userAgent")?.Trim();
        request.Headers.TryAddWithoutValidation(
            "User-Agent",
            string.IsNullOrWhiteSpace(userAgent) ? "OpenCowork" : userAgent);

        var apiKey = JsonHelpers.GetString(parameters, "apiKey")?.Trim();
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        }
    }

    private static string ExtractErrorDetail(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return "Unknown error";
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object &&
                root.TryGetProperty("error", out var error) &&
                error.ValueKind == JsonValueKind.Object)
            {
                var message = JsonHelpers.GetString(error, "message");
                var code = JsonHelpers.GetString(error, "code");
                if (!string.IsNullOrWhiteSpace(message) && !string.IsNullOrWhiteSpace(code))
                {
                    return $"{code}: {message}";
                }
                if (!string.IsNullOrWhiteSpace(message))
                {
                    return message;
                }
            }
        }
        catch
        {
            // Return raw body below.
        }

        return body;
    }

    private static JsonObject ParseSoulsResponse(JsonElement root)
    {
        if (IsApiFailure(root))
        {
            throw new InvalidOperationException(ReadApiFailure(root, "SOUL marketplace API returned failure"));
        }

        var rawSouls = root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("data", out var data) &&
            data.ValueKind == JsonValueKind.Array
                ? data
                : default;
        var souls = new JsonArray();
        var index = 0;
        if (rawSouls.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in rawSouls.EnumerateArray())
            {
                souls.Add((JsonNode?)NormalizeSoulItem(item, index));
                index += 1;
            }
        }

        var total = index;
        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("total", out var totalElement) &&
            totalElement.ValueKind == JsonValueKind.Number &&
            totalElement.TryGetInt32(out var parsedTotal))
        {
            total = parsedTotal;
        }

        return new JsonObject
        {
            ["total"] = total,
            ["souls"] = souls
        };
    }

    private static JsonObject NormalizeSoulItem(JsonElement item, int index)
    {
        var slug = GetJsonString(item, "slug") ?? GetJsonString(item, "name") ?? $"soul-{index}";
        var name = GetJsonString(item, "name") ?? slug;
        var downloads = GetJsonNumber(item, "downloads") ?? 0;
        return new JsonObject
        {
            ["id"] = GetJsonString(item, "id") ?? slug,
            ["slug"] = slug,
            ["name"] = name,
            ["description"] = GetJsonString(item, "description") ?? string.Empty,
            ["category"] = GetJsonString(item, "category"),
            ["downloads"] = downloads,
            ["updatedAt"] = GetJsonString(item, "updatedAt"),
            ["filePath"] = GetJsonString(item, "filePath"),
            ["url"] = $"{MarketBaseUrl}/souls/{Uri.EscapeDataString(slug)}",
            ["downloadUrl"] = $"{MarketApiBaseUrl}/souls/{Uri.EscapeDataString(slug)}/download"
        };
    }

    private static JsonArray ParseCategories(JsonElement root)
    {
        if (IsApiFailure(root))
        {
            return ToCategoryArray(FallbackCategories);
        }

        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.Array)
        {
            return ToCategoryArray(FallbackCategories);
        }

        var result = new JsonArray();
        foreach (var item in data.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                var value = item.GetString()?.Trim();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    result.Add((JsonNode?)new JsonObject { ["value"] = value, ["label"] = value });
                }
                continue;
            }

            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var valueText = GetJsonString(item, "value") ??
                GetJsonString(item, "slug") ??
                GetJsonString(item, "name");
            if (string.IsNullOrWhiteSpace(valueText))
            {
                continue;
            }

            result.Add((JsonNode?)new JsonObject
            {
                ["value"] = valueText.Trim(),
                ["label"] = GetJsonString(item, "label") ?? GetJsonString(item, "name") ?? valueText.Trim()
            });
        }

        return result.Count > 0 ? result : ToCategoryArray(FallbackCategories);
    }

    private static bool IsApiFailure(JsonElement root)
    {
        return root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("success", out var success) &&
            success.ValueKind == JsonValueKind.False;
    }

    private static string ReadApiFailure(JsonElement root, string fallback)
    {
        if (root.TryGetProperty("error", out var error) &&
            error.ValueKind == JsonValueKind.Object &&
            JsonHelpers.GetString(error, "message") is { Length: > 0 } message)
        {
            return message;
        }
        return fallback;
    }

    private static string GetBundledSoulsDirectory(JsonElement parameters)
    {
        return UserContentPaths.GetBundledDirectory(parameters, DirectoryName);
    }

    private static string ResolveGlobalSoulPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "SOUL.md");
    }

    private static string? ResolveProjectSoulPath(string? projectRootPath)
    {
        var root = projectRootPath?.Trim();
        return string.IsNullOrWhiteSpace(root) ? null : Path.Combine(root, ".agents", "SOUL.md");
    }

    private static WorkerResponse SoulMutation(bool success, string? path, string? error)
    {
        return UserContentPaths.JsonNode(new JsonObject
        {
            ["success"] = success,
            ["path"] = path is null ? null : JsonValue.Create(path),
            ["error"] = string.IsNullOrWhiteSpace(error) ? null : JsonValue.Create(error)
        });
    }

    private static SoulTemplate[] ReadTemplateMetadata(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("builtinTemplates", out var templates) ||
            templates.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<SoulTemplate>();
        foreach (var template in templates.EnumerateArray())
        {
            if (template.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var id = GetJsonString(template, "id");
            var name = GetJsonString(template, "name");
            var description = GetJsonString(template, "description");
            var category = GetJsonString(template, "category");
            var filename = Path.GetFileName(GetJsonString(template, "filename") ?? string.Empty);
            if (string.IsNullOrWhiteSpace(id) ||
                string.IsNullOrWhiteSpace(name) ||
                string.IsNullOrWhiteSpace(description) ||
                string.IsNullOrWhiteSpace(category) ||
                string.IsNullOrWhiteSpace(filename))
            {
                continue;
            }

            result.Add(new SoulTemplate(
                id,
                name,
                description,
                category,
                ReadTags(template),
                filename));
        }

        return [.. result];
    }

    private static string[] ReadTags(JsonElement template)
    {
        if (!template.TryGetProperty("tags", out var tags) || tags.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<string>();
        foreach (var tag in tags.EnumerateArray())
        {
            if (tag.ValueKind == JsonValueKind.String && tag.GetString() is { Length: > 0 } value)
            {
                result.Add(value);
            }
        }
        return [.. result];
    }

    private static JsonArray ToStringArrayNode(IEnumerable<string> values)
    {
        var result = new JsonArray();
        foreach (var value in values)
        {
            result.Add((JsonNode?)JsonValue.Create(value));
        }
        return result;
    }

    private static JsonArray ToCategoryArray(IEnumerable<SoulCategory> categories)
    {
        var result = new JsonArray();
        foreach (var category in categories)
        {
            result.Add((JsonNode?)new JsonObject
            {
                ["value"] = category.Value,
                ["label"] = category.Label
            });
        }
        return result;
    }

    private static string? GetJsonString(JsonElement item, string propertyName)
    {
        if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString(),
            JsonValueKind.Number => property.ToString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };
    }

    private static int? GetJsonNumber(JsonElement item, string propertyName)
    {
        if (item.ValueKind != JsonValueKind.Object ||
            !item.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        return property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out var value)
            ? value
            : null;
    }

    private sealed record SoulCategory(string Value, string Label);

    private sealed record SoulTemplate(
        string Id,
        string Name,
        string Description,
        string Category,
        string[] Tags,
        string Filename);
}
