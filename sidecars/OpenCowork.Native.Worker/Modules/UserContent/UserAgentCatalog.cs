using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static partial class UserAgentCatalog
{
    private const string DirectoryName = "agents";

    public static WorkerResponse Ensure(JsonElement parameters)
    {
        try
        {
            EnsureBuiltinAgents(parameters);
            return UserContentPaths.Success();
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(UserContentPaths.Error(ex.Message));
        }
    }

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            EnsureBuiltinAgents(parameters);
            var result = new JsonArray();
            foreach (var file in UserContentPaths.EnumerateMarkdownFiles(GetUserAgentsDirectory()))
            {
                try
                {
                    var agent = ParseAgentFile(UserContentPaths.ReadText(file.FullName), file.Name);
                    if (agent is not null)
                    {
                        result.Add((JsonNode?)agent);
                    }
                }
                catch
                {
                    // Skip unreadable files.
                }
            }
            return UserContentPaths.JsonNode(result);
        }
        catch
        {
            return UserContentPaths.JsonNode(new JsonArray());
        }
    }

    public static WorkerResponse Load(JsonElement parameters)
    {
        try
        {
            EnsureBuiltinAgents(parameters);
            var name = JsonHelpers.GetString(parameters, "name");
            var userDir = GetUserAgentsDirectory();
            if (!Directory.Exists(userDir))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error("Agents directory not found"));
            }

            foreach (var file in UserContentPaths.EnumerateMarkdownFiles(userDir))
            {
                try
                {
                    var agent = ParseAgentFile(UserContentPaths.ReadText(file.FullName), file.Name);
                    if (agent is not null &&
                        string.Equals(agent["name"]?.GetValue<string>(), name, StringComparison.Ordinal))
                    {
                        return UserContentPaths.JsonNode(agent);
                    }
                }
                catch
                {
                    // Skip unreadable files.
                }
            }

            return UserContentPaths.JsonNode(UserContentPaths.Error($"Agent \"{name}\" not found"));
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(UserContentPaths.Error(ex.Message));
        }
    }

    public static WorkerResponse ManageList(JsonElement parameters)
    {
        try
        {
            EnsureBuiltinAgents(parameters);
            var result = new JsonArray();
            foreach (var file in UserContentPaths.EnumerateMarkdownFiles(GetUserAgentsDirectory()))
            {
                try
                {
                    var agent = ParseAgentFile(UserContentPaths.ReadText(file.FullName), file.Name);
                    if (agent is null)
                    {
                        continue;
                    }

                    result.Add((JsonNode?)new JsonObject
                    {
                        ["id"] = file.FullName,
                        ["name"] = agent["name"]?.DeepClone(),
                        ["description"] = agent["description"]?.DeepClone(),
                        ["path"] = file.FullName,
                        ["source"] = "user",
                        ["editable"] = true
                    });
                }
                catch
                {
                    // Skip unreadable files.
                }
            }

            var sorted = result
                .OfType<JsonObject>()
                .OrderBy(item => item["name"]?.GetValue<string>() ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                .Select(item => (JsonNode?)item.DeepClone())
                .ToArray();
            return UserContentPaths.JsonNode(new JsonArray(sorted));
        }
        catch
        {
            return UserContentPaths.JsonNode(new JsonArray());
        }
    }

    public static WorkerResponse ManageRead(JsonElement parameters)
    {
        try
        {
            var targetPath = JsonHelpers.GetString(parameters, "path")?.Trim();
            if (string.IsNullOrWhiteSpace(targetPath))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error("Agent path is required"));
            }
            if (!UserContentPaths.IsPathInsideDirectory(targetPath, GetUserAgentsDirectory()))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error("Agent path is outside the managed directory"));
            }
            if (!File.Exists(targetPath))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error($"Agent file not found: {targetPath}"));
            }

            var content = UserContentPaths.ReadText(targetPath);
            var agent = ParseAgentFile(content, Path.GetFileName(targetPath));
            if (agent is null)
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error($"Agent file is invalid: {targetPath}"));
            }

            return UserContentPaths.JsonNode(new JsonObject
            {
                ["id"] = targetPath,
                ["name"] = agent["name"]?.DeepClone(),
                ["description"] = agent["description"]?.DeepClone(),
                ["path"] = targetPath,
                ["source"] = "user",
                ["editable"] = true,
                ["content"] = content
            });
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(UserContentPaths.Error(ex.Message));
        }
    }

    public static WorkerResponse ManageSave(JsonElement parameters)
    {
        try
        {
            var targetPath = JsonHelpers.GetString(parameters, "path")?.Trim();
            if (string.IsNullOrWhiteSpace(targetPath))
            {
                return AgentMutation(false, "Agent path is required");
            }
            if (!UserContentPaths.IsPathInsideDirectory(targetPath, GetUserAgentsDirectory()))
            {
                return AgentMutation(false, "Agent path is outside the managed directory");
            }

            var content = JsonHelpers.GetString(parameters, "content") ?? string.Empty;
            if (ParseAgentFile(content, Path.GetFileName(targetPath)) is null)
            {
                return AgentMutation(false, "Agent markdown is invalid or missing required frontmatter");
            }

            UserContentPaths.WriteText(targetPath, content);
            return AgentMutation(true, null);
        }
        catch (Exception ex)
        {
            return AgentMutation(false, ex.Message);
        }
    }

    private static void EnsureBuiltinAgents(JsonElement parameters)
    {
        var bundledDir = UserContentPaths.GetBundledDirectory(parameters, DirectoryName);
        if (!Directory.Exists(bundledDir))
        {
            WorkerLog.Warn($"agents bundled directory not found path={bundledDir}");
            return;
        }

        var userDir = GetUserAgentsDirectory();
        Directory.CreateDirectory(userDir);
        foreach (var file in UserContentPaths.EnumerateMarkdownFiles(bundledDir))
        {
            var targetPath = Path.Combine(userDir, file.Name);
            if (File.Exists(targetPath))
            {
                continue;
            }

            File.Copy(file.FullName, targetPath);
        }
    }

    private static JsonObject? ParseAgentFile(string content, string filename)
    {
        var match = FrontmatterRegex().Match(content);
        if (!match.Success)
        {
            return null;
        }

        var frontmatter = match.Groups[1].Value;
        var body = content[match.Length..].TrimStart();
        var name = GetFrontmatterString(frontmatter, "name");
        var description = GetFrontmatterString(frontmatter, "description");
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(description))
        {
            WorkerLog.Warn($"agent skipped filename={filename} reason=missing name/description");
            return null;
        }

        var tools = GetFrontmatterStringList(frontmatter, "tools") ??
            GetFrontmatterStringList(frontmatter, "allowedTools") ??
            ["Read", "Glob", "Grep", "LS", "Bash"];
        var disallowedTools = GetFrontmatterStringList(frontmatter, "disallowedTools") ?? [];
        var maxTurns = GetFrontmatterInt(frontmatter, "maxTurns") ??
            GetFrontmatterInt(frontmatter, "maxIterations");
        var result = new JsonObject
        {
            ["name"] = name,
            ["description"] = description,
            ["tools"] = ToJsonArray(tools),
            ["allowedTools"] = ToJsonArray(tools),
            ["disallowedTools"] = ToJsonArray(disallowedTools),
            ["systemPrompt"] = body.Length == 0 ? $"You are {name}, a specialized agent." : body
        };

        // Preserve the distinction between an omitted limit (runtime default) and an
        // explicit zero (unlimited). Returning zero for both would make the catalog lie
        // about agents that still use the runtime's default turn limit.
        if (maxTurns.HasValue)
        {
            result["maxTurns"] = maxTurns.Value;
            result["maxIterations"] = maxTurns.Value;
        }

        AddOptionalString(result, "icon", GetFrontmatterString(frontmatter, "icon"));
        AddOptionalString(result, "initialPrompt", GetFrontmatterString(frontmatter, "initialPrompt"));
        AddOptionalBool(result, "background", GetFrontmatterBool(frontmatter, "background"));
        AddOptionalString(result, "model", GetFrontmatterString(frontmatter, "model"));
        AddOptionalDouble(result, "temperature", GetFrontmatterDouble(frontmatter, "temperature"));
        return result;
    }

    private static string? GetFrontmatterString(string frontmatter, string key)
    {
        var match = Regex.Match(
            frontmatter,
            $"^{Regex.Escape(key)}:\\s*(.+)$",
            RegexOptions.Multiline);
        return match.Success ? match.Groups[1].Value.Trim().Trim('"', '\'') : null;
    }

    private static int? GetFrontmatterInt(string frontmatter, string key)
    {
        return int.TryParse(GetFrontmatterString(frontmatter, key), out var value) ? value : null;
    }

    private static double? GetFrontmatterDouble(string frontmatter, string key)
    {
        return double.TryParse(GetFrontmatterString(frontmatter, key), out var value) ? value : null;
    }

    private static bool? GetFrontmatterBool(string frontmatter, string key)
    {
        var value = GetFrontmatterString(frontmatter, key);
        return value switch
        {
            "true" => true,
            "false" => false,
            _ => null
        };
    }

    private static string[]? GetFrontmatterStringList(string frontmatter, string key)
    {
        var raw = GetFrontmatterString(frontmatter, key);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var normalized = raw.Trim();
        if (normalized.StartsWith("[", StringComparison.Ordinal) &&
            normalized.EndsWith("]", StringComparison.Ordinal))
        {
            normalized = normalized[1..^1];
        }

        var values = normalized
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(item => item.Trim().Trim('"', '\''))
            .Where(item => item.Length > 0)
            .ToArray();
        return values.Length == 0 ? null : values;
    }

    private static JsonArray ToJsonArray(IEnumerable<string> values)
    {
        var result = new JsonArray();
        foreach (var value in values)
        {
            result.Add((JsonNode?)JsonValue.Create(value));
        }
        return result;
    }

    private static void AddOptionalString(JsonObject result, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            result[name] = value;
        }
    }

    private static void AddOptionalBool(JsonObject result, string name, bool? value)
    {
        if (value.HasValue)
        {
            result[name] = value.Value;
        }
    }

    private static void AddOptionalDouble(JsonObject result, string name, double? value)
    {
        if (value.HasValue)
        {
            result[name] = value.Value;
        }
    }

    private static WorkerResponse AgentMutation(bool success, string? error)
    {
        var payload = new JsonObject { ["success"] = success };
        if (!string.IsNullOrWhiteSpace(error))
        {
            payload["error"] = error;
        }
        return UserContentPaths.JsonNode(payload);
    }

    private static string GetUserAgentsDirectory()
    {
        return UserContentPaths.GetUserDirectory(DirectoryName);
    }

    [GeneratedRegex("^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---")]
    private static partial Regex FrontmatterRegex();
}
