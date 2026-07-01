using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static partial class SkillCatalog
{
    private const string SkillsMarketBaseUrl = "https://skills.open-cowork.shop";
    private const string SkillsMarketApiBaseUrl = SkillsMarketBaseUrl + "/api/v1";
    private const string SkillFileName = "SKILL.md";
    private const string TempRootName = "opencowork-skills";
    private static readonly object Sync = new();
    private static readonly HttpClient Http = WorkerHttpClientFactory.Create(TimeSpan.FromSeconds(60));
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false
    };
    private static readonly HashSet<string> TextFileExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".sh", ".bash", ".ps1", ".bat", ".cmd",
        ".rb", ".pl", ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini", ".env"
    };
    private static readonly HashSet<string> CodeFileExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".py", ".js", ".ts", ".sh", ".bash", ".ps1", ".bat", ".cmd", ".rb", ".pl"
    };

    public static WorkerResponse EnsureBuiltins(JsonElement parameters)
    {
        lock (Sync)
        {
            try
            {
                EnsureBuiltinsCore(parameters);
                return ToResponse(Mutation(true, null));
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"skills ensure builtins failed error={ex.GetType().Name}: {ex.Message}");
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    public static WorkerResponse EnsureBuiltin(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name")?.Trim() ?? string.Empty;
        if (!BuiltinSkillNameRegex().IsMatch(name))
        {
            return ToResponse(Mutation(false, "Invalid built-in skill name"));
        }

        lock (Sync)
        {
            try
            {
                var bundledDir = ResolveBundledSkillsDirectory(parameters);
                if (bundledDir is null)
                {
                    return ToResponse(Mutation(false, "Bundled skills directory not found"));
                }

                var sourceDir = Path.Combine(bundledDir, name);
                var sourceManifest = Path.Combine(sourceDir, SkillFileName);
                if (!File.Exists(sourceManifest))
                {
                    return ToResponse(Mutation(false, $"Built-in skill \"{name}\" was not found"));
                }

                Directory.CreateDirectory(SkillsDirectory());
                var targetDir = ResolveInstalledSkillPath(name);
                var targetManifest = Path.Combine(targetDir, SkillFileName);
                if (!File.Exists(targetManifest))
                {
                    if (Directory.Exists(targetDir))
                    {
                        Directory.Delete(targetDir, recursive: true);
                    }
                    CopyDirectory(sourceDir, targetDir);
                }

                return ToResponse(new JsonObject
                {
                    ["success"] = true,
                    ["name"] = name
                });
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"skills ensure builtin failed name={name} error={ex.GetType().Name}: {ex.Message}");
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    public static WorkerResponse List(JsonElement parameters)
    {
        lock (Sync)
        {
            try
            {
                EnsureBuiltinsCore(parameters);
                var result = new JsonArray();
                var root = SkillsDirectory();
                if (!Directory.Exists(root))
                {
                    return ToResponse(result);
                }

                foreach (var dir in Directory.EnumerateDirectories(root))
                {
                    var name = Path.GetFileName(dir);
                    var manifest = Path.Combine(dir, SkillFileName);
                    if (string.IsNullOrWhiteSpace(name) || !File.Exists(manifest))
                    {
                        continue;
                    }

                    try
                    {
                        var content = File.ReadAllText(manifest);
                        result.Add((JsonNode?)new JsonObject
                        {
                            ["name"] = name,
                            ["description"] = ExtractDescription(content, name)
                        });
                    }
                    catch
                    {
                        // Skip unreadable skills.
                    }
                }

                return ToResponse(result);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"skills list failed error={ex.GetType().Name}: {ex.Message}");
                return ToResponse(new JsonArray());
            }
        }
    }

    public static WorkerResponse Load(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                var skillDir = ResolveInstalledSkillPath(name);
                var manifest = Path.Combine(skillDir, SkillFileName);
                if (!File.Exists(manifest))
                {
                    return ToResponse(new JsonObject { ["error"] = $"Skill \"{name}\" not found at {manifest}" });
                }

                var raw = File.ReadAllText(manifest);
                return ToResponse(new JsonObject
                {
                    ["content"] = StripFrontmatter(raw).TrimStart(),
                    ["workingDirectory"] = skillDir
                });
            }
            catch (Exception ex)
            {
                return ToResponse(new JsonObject { ["error"] = ex.Message });
            }
        }
    }

    public static WorkerResponse Read(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                var manifest = Path.Combine(ResolveInstalledSkillPath(name), SkillFileName);
                if (!File.Exists(manifest))
                {
                    return ToResponse(new JsonObject { ["error"] = $"Skill \"{name}\" not found" });
                }

                return ToResponse(new JsonObject { ["content"] = File.ReadAllText(manifest) });
            }
            catch (Exception ex)
            {
                return ToResponse(new JsonObject { ["error"] = ex.Message });
            }
        }
    }

    public static WorkerResponse ListFiles(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                var skillDir = ResolveInstalledSkillPath(name);
                if (!Directory.Exists(skillDir))
                {
                    return ToResponse(new JsonObject { ["error"] = $"Skill \"{name}\" not found" });
                }

                return ToResponse(new JsonObject { ["files"] = ListFileInfos(skillDir) });
            }
            catch (Exception ex)
            {
                return ToResponse(new JsonObject { ["error"] = ex.Message });
            }
        }
    }

    public static WorkerResponse Delete(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                var skillDir = ResolveInstalledSkillPath(name);
                if (!Directory.Exists(skillDir))
                {
                    return ToResponse(Mutation(false, $"Skill \"{name}\" not found"));
                }

                Directory.Delete(skillDir, recursive: true);
                WorkerLog.Debug($"skills delete name={name}");
                return ToResponse(Mutation(true, null));
            }
            catch (Exception ex)
            {
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    public static WorkerResponse ResolvePath(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name") ?? string.Empty;
        try
        {
            var skillDir = ResolveInstalledSkillPath(name);
            if (!Directory.Exists(skillDir))
            {
                return ToResponse(Mutation(false, $"Skill \"{name}\" not found"));
            }

            return ToResponse(new JsonObject
            {
                ["success"] = true,
                ["path"] = skillDir
            });
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    public static WorkerResponse AddFromFolder(JsonElement parameters)
    {
        var sourcePath = JsonHelpers.GetString(parameters, "sourcePath") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                var sourceDir = Path.GetFullPath(sourcePath);
                var sourceManifest = Path.Combine(sourceDir, SkillFileName);
                if (!File.Exists(sourceManifest))
                {
                    return ToResponse(Mutation(false, $"No {SkillFileName} found in the selected folder"));
                }

                var skillName = Path.GetFileName(sourceDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                if (!IsSafeSkillName(skillName))
                {
                    return ToResponse(Mutation(false, "Invalid skill folder name"));
                }

                var targetDir = ResolveInstalledSkillPath(skillName);
                if (Directory.Exists(targetDir))
                {
                    return ToResponse(Mutation(false, $"Skill \"{skillName}\" already exists"));
                }

                Directory.CreateDirectory(SkillsDirectory());
                CopyDirectory(sourceDir, targetDir);
                WorkerLog.Debug($"skills add from folder name={skillName}");
                return ToResponse(new JsonObject
                {
                    ["success"] = true,
                    ["name"] = skillName
                });
            }
            catch (Exception ex)
            {
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    public static WorkerResponse Save(JsonElement parameters)
    {
        var name = JsonHelpers.GetString(parameters, "name") ?? string.Empty;
        var content = JsonHelpers.GetString(parameters, "content") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                var skillDir = ResolveInstalledSkillPath(name);
                if (!Directory.Exists(skillDir))
                {
                    return ToResponse(Mutation(false, $"Skill \"{name}\" not found"));
                }

                File.WriteAllText(Path.Combine(skillDir, SkillFileName), content);
                WorkerLog.Debug($"skills save name={name}");
                return ToResponse(Mutation(true, null));
            }
            catch (Exception ex)
            {
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    public static WorkerResponse Scan(JsonElement parameters)
    {
        var sourcePath = JsonHelpers.GetString(parameters, "sourcePath") ?? string.Empty;
        lock (Sync)
        {
            try
            {
                return ToResponse(ScanSkillDirectory(Path.GetFullPath(sourcePath)));
            }
            catch (Exception ex)
            {
                return ToResponse(new JsonObject { ["error"] = ex.Message });
            }
        }
    }

    public static async Task<WorkerResponse> MarketListAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var provider = JsonHelpers.GetString(parameters, "provider");
        if (!string.IsNullOrWhiteSpace(provider) && provider != "skillsmp")
        {
            return ToResponse(new JsonObject
            {
                ["total"] = 0,
                ["skills"] = new JsonArray()
            });
        }

        try
        {
            var query = JsonHelpers.GetString(parameters, "query")?.Trim() ?? string.Empty;
            var limit = Math.Min(Math.Max(JsonHelpers.GetInt(parameters, "limit", 20), 1), 100);
            var offset = Math.Max(JsonHelpers.GetInt(parameters, "offset", 0), 0);
            var page = (offset / limit) + 1;
            var url = $"{SkillsMarketApiBaseUrl}/skills/search?page={page}&limit={limit}&sortBy=popular";
            if (!string.IsNullOrWhiteSpace(query))
            {
                url += $"&q={Uri.EscapeDataString(query)}";
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            ApplyCommonHeaders(request, parameters, "application/json");
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.CancellationToken);
            var body = await response.Content.ReadAsStringAsync(context.CancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Skills marketplace API {(int)response.StatusCode}: {ExtractErrorDetail(body)}");
            }

            using var document = JsonDocument.Parse(body);
            return ToResponse(ParseMarketResponse(document.RootElement));
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"skills market list failed error={ex.GetType().Name}: {ex.Message}");
            return ToResponse(new JsonObject
            {
                ["total"] = 0,
                ["skills"] = new JsonArray()
            });
        }
    }

    public static async Task<WorkerResponse> DownloadRemoteAsync(JsonElement parameters, WorkerRequestContext context)
    {
        try
        {
            var slug = (JsonHelpers.GetString(parameters, "slug") ??
                JsonHelpers.GetString(parameters, "name") ??
                string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(slug))
            {
                return ToResponse(new JsonObject { ["error"] = "Missing skill slug for marketplace download" });
            }

            var tempBase = Path.Combine(Path.GetTempPath(), TempRootName, $"download-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}");
            var tempDir = Path.Combine(tempBase, slug);
            Directory.CreateDirectory(tempBase);

            var downloadUrl = JsonHelpers.GetString(parameters, "downloadUrl") ??
                $"{SkillsMarketBaseUrl}/skills/{Uri.EscapeDataString(slug)}/download";
            using var request = new HttpRequestMessage(HttpMethod.Get, downloadUrl);
            ApplyCommonHeaders(request, parameters, "application/zip, text/markdown;q=0.9, */*;q=0.8");
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.CancellationToken);
            var bytes = await response.Content.ReadAsByteArrayAsync(context.CancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                var body = System.Text.Encoding.UTF8.GetString(bytes);
                throw new InvalidOperationException(
                    $"Skills marketplace download failed {(int)response.StatusCode}: {(string.IsNullOrWhiteSpace(body) ? "Unknown error" : body)}");
            }

            var contentType = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant() ?? string.Empty;
            var contentDisposition = response.Content.Headers.ContentDisposition?.ToString().ToLowerInvariant() ?? string.Empty;
            var isZip = contentType.Contains("application/zip", StringComparison.Ordinal) ||
                contentDisposition.Contains(".zip", StringComparison.Ordinal);

            if (isZip)
            {
                var archivePath = Path.Combine(tempBase, $"{slug}.zip");
                var extractDir = Path.Combine(tempBase, "_archive");
                File.WriteAllBytes(archivePath, bytes);
                Directory.CreateDirectory(extractDir);
                ZipFile.ExtractToDirectory(archivePath, extractDir, overwriteFiles: true);

                var manifestPath = FindSkillManifestPath(extractDir) ??
                    throw new InvalidOperationException($"No SKILL.md found in downloaded archive for {slug}");
                var sourceDir = Path.GetDirectoryName(manifestPath)!;
                CopyDirectory(sourceDir, tempDir);

                var manifestFileName = Path.GetFileName(manifestPath);
                if (!string.Equals(manifestFileName, SkillFileName, StringComparison.Ordinal))
                {
                    var currentManifestPath = Path.Combine(tempDir, manifestFileName);
                    var normalizedManifestPath = Path.Combine(tempDir, SkillFileName);
                    if (File.Exists(currentManifestPath))
                    {
                        if (File.Exists(normalizedManifestPath))
                        {
                            File.Delete(normalizedManifestPath);
                        }
                        File.Move(currentManifestPath, normalizedManifestPath);
                    }
                }
            }
            else
            {
                Directory.CreateDirectory(tempDir);
                File.WriteAllText(Path.Combine(tempDir, SkillFileName), System.Text.Encoding.UTF8.GetString(bytes));
            }

            var files = CollectTextFiles(tempDir);
            if (!files.OfType<JsonObject>().Any(file => ReadNodeString(file, "path") == SkillFileName))
            {
                throw new InvalidOperationException($"Downloaded skill {slug} is missing SKILL.md");
            }

            return ToResponse(new JsonObject
            {
                ["tempPath"] = tempDir,
                ["files"] = files
            });
        }
        catch (Exception ex)
        {
            return ToResponse(new JsonObject { ["error"] = ex.Message });
        }
    }

    public static WorkerResponse CleanupTemp(JsonElement parameters)
    {
        var tempPath = JsonHelpers.GetString(parameters, "tempPath") ?? string.Empty;
        try
        {
            var fullPath = Path.GetFullPath(tempPath);
            var tempRoot = Path.GetFullPath(Path.Combine(Path.GetTempPath(), TempRootName));
            if (fullPath != tempRoot && !fullPath.StartsWith(tempRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                WorkerLog.Warn($"skills cleanup refused non-temp path={tempPath}");
                return ToResponse(new JsonObject { ["success"] = false });
            }

            var relative = Path.GetRelativePath(tempRoot, fullPath);
            var firstSegment = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
            var baseTempDir = Path.Combine(tempRoot, firstSegment);
            if (Directory.Exists(baseTempDir))
            {
                Directory.Delete(baseTempDir, recursive: true);
            }
            else if (Directory.Exists(fullPath))
            {
                Directory.Delete(fullPath, recursive: true);
            }

            return ToResponse(new JsonObject { ["success"] = true });
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"skills cleanup failed error={ex.GetType().Name}: {ex.Message}");
            return ToResponse(new JsonObject { ["success"] = false });
        }
    }

    private static void EnsureBuiltinsCore(JsonElement parameters)
    {
        var bundledDir = ResolveBundledSkillsDirectory(parameters);
        if (bundledDir is null)
        {
            WorkerLog.Warn("skills bundled directory not found");
            return;
        }

        Directory.CreateDirectory(SkillsDirectory());
        foreach (var sourceDir in Directory.EnumerateDirectories(bundledDir))
        {
            var name = Path.GetFileName(sourceDir);
            if (string.IsNullOrWhiteSpace(name) ||
                !File.Exists(Path.Combine(sourceDir, SkillFileName)))
            {
                continue;
            }

            var targetDir = ResolveInstalledSkillPath(name);
            if (Directory.Exists(targetDir))
            {
                continue;
            }
            CopyDirectory(sourceDir, targetDir);
        }
    }

    private static string? ResolveBundledSkillsDirectory(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("bundledDirCandidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        string? first = null;
        foreach (var candidate in candidates.EnumerateArray())
        {
            if (candidate.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var raw = candidate.GetString();
            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }
            var path = Path.GetFullPath(raw);
            first ??= path;
            if (Directory.Exists(path))
            {
                return path;
            }
        }

        return first is not null && Directory.Exists(first) ? first : null;
    }

    private static JsonObject ScanSkillDirectory(string sourceDir)
    {
        var sourceManifest = Path.Combine(sourceDir, SkillFileName);
        if (!File.Exists(sourceManifest))
        {
            return new JsonObject { ["error"] = $"No {SkillFileName} found in the selected folder" };
        }

        var skillName = Path.GetFileName(sourceDir);
        var skillContent = File.ReadAllText(sourceManifest);
        var scriptContents = new JsonArray();
        var files = new JsonArray();
        WalkFiles(sourceDir, (fullPath, relativePath) =>
        {
            var extension = Path.GetExtension(fullPath).ToLowerInvariant();
            var info = new FileInfo(fullPath);
            files.Add((JsonNode?)new JsonObject
            {
                ["name"] = relativePath,
                ["size"] = info.Length,
                ["type"] = string.IsNullOrWhiteSpace(extension) ? "unknown" : extension
            });

            if (CodeFileExtensions.Contains(extension))
            {
                try
                {
                    scriptContents.Add((JsonNode?)new JsonObject
                    {
                        ["file"] = relativePath,
                        ["content"] = File.ReadAllText(fullPath)
                    });
                }
                catch
                {
                    // Skip unreadable files.
                }
            }
        });

        var allContents = new List<(string File, string Content)> { (SkillFileName, skillContent) };
        foreach (var script in scriptContents.OfType<JsonObject>())
        {
            allContents.Add((ReadNodeString(script, "file"), ReadNodeString(script, "content")));
        }

        return new JsonObject
        {
            ["name"] = skillName,
            ["description"] = ExtractDescription(skillContent, skillName),
            ["files"] = files,
            ["risks"] = AnalyzeRisks(allContents),
            ["skillMdContent"] = skillContent,
            ["scriptContents"] = scriptContents
        };
    }

    private static JsonArray ListFileInfos(string root)
    {
        var files = new JsonArray();
        WalkFiles(root, (fullPath, relativePath) =>
        {
            var info = new FileInfo(fullPath);
            var extension = Path.GetExtension(fullPath).ToLowerInvariant();
            files.Add((JsonNode?)new JsonObject
            {
                ["name"] = relativePath,
                ["size"] = info.Length,
                ["type"] = string.IsNullOrWhiteSpace(extension) ? "unknown" : extension
            });
        });
        return files;
    }

    private static JsonArray CollectTextFiles(string root)
    {
        var files = new JsonArray();
        WalkFiles(root, (fullPath, relativePath) =>
        {
            var extension = Path.GetExtension(fullPath).ToLowerInvariant();
            var name = Path.GetFileName(fullPath).ToLowerInvariant();
            if (!TextFileExtensions.Contains(extension) && name is not ("skill.md" or "skills.md"))
            {
                return;
            }
            try
            {
                files.Add((JsonNode?)new JsonObject
                {
                    ["path"] = relativePath,
                    ["content"] = File.ReadAllText(fullPath)
                });
            }
            catch
            {
                // Skip unreadable files.
            }
        });
        return files;
    }

    private static JsonArray AnalyzeRisks(IReadOnlyList<(string File, string Content)> contents)
    {
        var risks = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (file, content) in contents)
        {
            var lines = content.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            foreach (var pattern in RiskPatterns())
            {
                for (var index = 0; index < lines.Length; index++)
                {
                    if (!pattern.Regex.IsMatch(lines[index]))
                    {
                        continue;
                    }
                    var key = $"{file}\0{index + 1}\0{pattern.Category}";
                    if (!seen.Add(key))
                    {
                        continue;
                    }
                    risks.Add((JsonNode?)new JsonObject
                    {
                        ["severity"] = pattern.Severity,
                        ["category"] = pattern.Category,
                        ["detail"] = pattern.Label,
                        ["file"] = file,
                        ["line"] = index + 1
                    });
                }
            }
        }
        return risks;
    }

    private static JsonObject ParseMarketResponse(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("success", out var success) &&
            success.ValueKind == JsonValueKind.False)
        {
            throw new InvalidOperationException(ExtractErrorDetail(root.GetRawText()));
        }

        var skills = new JsonArray();
        var data = root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("data", out var dataElement) &&
            dataElement.ValueKind == JsonValueKind.Array
                ? dataElement
                : default;
        var total = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("total", out var totalElement) &&
            totalElement.TryGetInt32(out var parsedTotal)
                ? parsedTotal
                : data.ValueKind == JsonValueKind.Array ? data.GetArrayLength() : 0;
        var index = 0;
        if (data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }
                var slug = ReadString(item, "slug");
                if (string.IsNullOrWhiteSpace(slug))
                {
                    slug = ReadString(item, "name");
                }
                if (string.IsNullOrWhiteSpace(slug))
                {
                    slug = $"skill-{index}";
                }
                var name = ReadString(item, "name");
                if (string.IsNullOrWhiteSpace(name))
                {
                    name = slug;
                }
                var url = $"{SkillsMarketBaseUrl}/skills/{Uri.EscapeDataString(slug)}";
                var skill = new JsonObject
                {
                    ["id"] = ReadString(item, "id") is { Length: > 0 } id ? id : slug,
                    ["slug"] = slug,
                    ["name"] = name,
                    ["description"] = ReadString(item, "description"),
                    ["tags"] = ReadStringArray(item, "tags"),
                    ["downloads"] = ReadInt(item, "downloads"),
                    ["url"] = url,
                    ["downloadUrl"] = $"{url}/download",
                    ["installCommand"] = $"npx skills add {slug}"
                };
                if (ReadString(item, "category") is { Length: > 0 } category)
                {
                    skill["category"] = category;
                }
                if (ReadString(item, "updatedAt") is { Length: > 0 } updatedAt)
                {
                    skill["updatedAt"] = updatedAt;
                }
                if (ReadString(item, "filePath") is { Length: > 0 } filePath)
                {
                    skill["filePath"] = filePath;
                }
                skills.Add((JsonNode?)skill);
                index++;
            }
        }

        return new JsonObject
        {
            ["total"] = total,
            ["skills"] = skills
        };
    }

    private static void ApplyCommonHeaders(HttpRequestMessage request, JsonElement parameters, string accept)
    {
        request.Headers.Accept.ParseAdd(accept);
        request.Headers.TryAddWithoutValidation(
            "User-Agent",
            ApiUserAgent.Resolve(JsonHelpers.GetString(parameters, "userAgent")));

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

    private static string? FindSkillManifestPath(string dir)
    {
        var manifests = new List<string>();
        WalkFiles(dir, (fullPath, _) =>
        {
            var name = Path.GetFileName(fullPath).ToLowerInvariant();
            if (name is "skill.md" or "skills.md")
            {
                manifests.Add(fullPath);
            }
        });
        return manifests
            .OrderBy(path => Path.GetRelativePath(dir, path).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Length)
            .ThenBy(path => path, StringComparer.Ordinal)
            .FirstOrDefault();
    }

    private static void WalkFiles(string root, Action<string, string> onFile)
    {
        foreach (var file in Directory.EnumerateFiles(root))
        {
            onFile(file, NormalizeRelativePath(Path.GetRelativePath(root, file)));
        }
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            WalkFiles(directory, (fullPath, _) =>
            {
                onFile(fullPath, NormalizeRelativePath(Path.GetRelativePath(root, fullPath)));
            });
        }
    }

    private static void CopyDirectory(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var file in Directory.EnumerateFiles(sourceDir))
        {
            File.Copy(file, Path.Combine(targetDir, Path.GetFileName(file)), overwrite: true);
        }
        foreach (var directory in Directory.EnumerateDirectories(sourceDir))
        {
            CopyDirectory(directory, Path.Combine(targetDir, Path.GetFileName(directory)));
        }
    }

    private static string ExtractDescription(string content, string fallback)
    {
        var match = FrontmatterRegex().Match(content);
        if (match.Success)
        {
            var descMatch = DescriptionRegex().Match(match.Groups[1].Value);
            if (descMatch.Success)
            {
                var desc = descMatch.Groups[1].Value.Trim().Trim('"', '\'');
                if (desc.Length > 0)
                {
                    return desc.Length > 200 ? desc[..200] + "..." : desc;
                }
            }
        }

        var inFrontmatter = false;
        foreach (var rawLine in content.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            var line = rawLine.Trim();
            if (line == "---")
            {
                inFrontmatter = !inFrontmatter;
                continue;
            }
            if (inFrontmatter || line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }
            return line.Length > 120 ? line[..120] + "..." : line;
        }

        return fallback;
    }

    private static string StripFrontmatter(string content)
    {
        return FrontmatterStripRegex().Replace(content, string.Empty);
    }

    private static string ResolveInstalledSkillPath(string name)
    {
        if (!IsSafeSkillName(name))
        {
            throw new InvalidOperationException("Invalid skill name");
        }
        var root = Path.GetFullPath(SkillsDirectory());
        var target = Path.GetFullPath(Path.Combine(root, name));
        if (target != root && !target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Path escapes skills directory");
        }
        return target;
    }

    private static bool IsSafeSkillName(string name)
    {
        return !string.IsNullOrWhiteSpace(name) &&
            !name.Contains(Path.DirectorySeparatorChar) &&
            !name.Contains(Path.AltDirectorySeparatorChar) &&
            name != "." &&
            name != "..";
    }

    private static string SkillsDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".agents",
            "skills");
    }

    private static string NormalizeRelativePath(string value)
    {
        return value.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');
    }

    private static string ReadNodeString(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : string.Empty;
    }

    private static string ReadString(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? string.Empty
                : string.Empty;
    }

    private static int ReadInt(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.TryGetInt32(out var result)
                ? result
                : 0;
    }

    private static JsonArray ReadStringArray(JsonElement element, string name)
    {
        var array = new JsonArray();
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(name, out var value) ||
            value.ValueKind != JsonValueKind.Array)
        {
            return array;
        }
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } text)
            {
                array.Add((JsonNode?)JsonValue.Create(text));
            }
        }
        return array;
    }

    private static JsonObject Mutation(bool success, string? error)
    {
        var result = new JsonObject { ["success"] = success };
        if (!string.IsNullOrWhiteSpace(error))
        {
            result["error"] = error;
        }
        return result;
    }

    private static WorkerResponse ToResponse(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString(JsonOptions));
    }

    private static IReadOnlyList<RiskPattern> RiskPatterns()
    {
        return
        [
            new(RmRfRegex(), "danger", "shell", "rm -rf"),
            new(DelForceRegex(), "danger", "shell", "del /f"),
            new(FormatDriveRegex(), "danger", "shell", "format drive"),
            new(MkfsRegex(), "danger", "shell", "mkfs"),
            new(DdRegex(), "danger", "shell", "dd"),
            new(EvalRegex(), "danger", "execution", "eval()"),
            new(ExecRegex(), "warning", "execution", "exec()"),
            new(SubprocessRegex(), "warning", "execution", "subprocess"),
            new(OsSystemRegex(), "danger", "execution", "os.system()"),
            new(ChildProcessRegex(), "warning", "execution", "child_process"),
            new(OsPopenRegex(), "danger", "execution", "os.popen()"),
            new(RequestsRegex(), "warning", "network", "requests HTTP call"),
            new(UrllibRegex(), "warning", "network", "urllib"),
            new(FetchRegex(), "warning", "network", "fetch()"),
            new(CurlRegex(), "warning", "network", "curl"),
            new(WgetRegex(), "warning", "network", "wget"),
            new(HttpClientRegex(), "warning", "network", "HTTP client"),
            new(ApiKeyRegex(), "warning", "credential", "API key reference"),
            new(PasswordRegex(), "danger", "credential", "password assignment"),
            new(TokenRegex(), "warning", "credential", "token reference"),
            new(ShutilRmtreeRegex(), "danger", "filesystem", "shutil.rmtree()"),
            new(OsRemoveRegex(), "warning", "filesystem", "os.remove()"),
            new(FsDeleteRegex(), "danger", "filesystem", "fs delete"),
            new(Base64SendRegex(), "danger", "exfiltration", "base64 + send")
        ];
    }

    private sealed record RiskPattern(Regex Regex, string Severity, string Category, string Label);

    [GeneratedRegex(@"^---\s*\r?\n([\s\S]*?)\r?\n---", RegexOptions.CultureInvariant)]
    private static partial Regex FrontmatterRegex();
    [GeneratedRegex(@"^description:\s*(.+)$", RegexOptions.Multiline | RegexOptions.CultureInvariant)]
    private static partial Regex DescriptionRegex();
    [GeneratedRegex(@"^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?", RegexOptions.CultureInvariant)]
    private static partial Regex FrontmatterStripRegex();
    [GeneratedRegex(@"^[a-z0-9-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex BuiltinSkillNameRegex();
    [GeneratedRegex(@"\brm\s+-rf\b", RegexOptions.CultureInvariant)]
    private static partial Regex RmRfRegex();
    [GeneratedRegex(@"\bdel\s+\/[fFsS]", RegexOptions.CultureInvariant)]
    private static partial Regex DelForceRegex();
    [GeneratedRegex(@"\bformat\s+[A-Z]:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FormatDriveRegex();
    [GeneratedRegex(@"\bmkfs\b", RegexOptions.CultureInvariant)]
    private static partial Regex MkfsRegex();
    [GeneratedRegex(@"\bdd\s+if=", RegexOptions.CultureInvariant)]
    private static partial Regex DdRegex();
    [GeneratedRegex(@"\beval\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex EvalRegex();
    [GeneratedRegex(@"\bexec\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex ExecRegex();
    [GeneratedRegex(@"\bsubprocess\b", RegexOptions.CultureInvariant)]
    private static partial Regex SubprocessRegex();
    [GeneratedRegex(@"\bos\.system\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex OsSystemRegex();
    [GeneratedRegex(@"\bchild_process\b", RegexOptions.CultureInvariant)]
    private static partial Regex ChildProcessRegex();
    [GeneratedRegex(@"\bos\.popen\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex OsPopenRegex();
    [GeneratedRegex(@"\brequests\.(get|post|put|delete|patch)\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex RequestsRegex();
    [GeneratedRegex(@"\burllib\b", RegexOptions.CultureInvariant)]
    private static partial Regex UrllibRegex();
    [GeneratedRegex(@"\bfetch\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex FetchRegex();
    [GeneratedRegex(@"\bcurl\s+", RegexOptions.CultureInvariant)]
    private static partial Regex CurlRegex();
    [GeneratedRegex(@"\bwget\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WgetRegex();
    [GeneratedRegex(@"\bhttpx?\.\w+\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex HttpClientRegex();
    [GeneratedRegex(@"\b(api_key|apikey|api[-_]?secret)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ApiKeyRegex();
    [GeneratedRegex(@"\b(password|passwd)\s*[=:]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PasswordRegex();
    [GeneratedRegex(@"\b(access_token|auth_token|bearer)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TokenRegex();
    [GeneratedRegex(@"\bshutil\.rmtree\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex ShutilRmtreeRegex();
    [GeneratedRegex(@"\bos\.remove\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex OsRemoveRegex();
    [GeneratedRegex(@"\bfs\.(unlinkSync|rmSync)\s*\(", RegexOptions.CultureInvariant)]
    private static partial Regex FsDeleteRegex();
    [GeneratedRegex(@"\bbase64\b.*\b(send|post|upload)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Base64SendRegex();
}
