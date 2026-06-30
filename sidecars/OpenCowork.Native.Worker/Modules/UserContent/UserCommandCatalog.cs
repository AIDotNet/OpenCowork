using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static partial class UserCommandCatalog
{
    private const string DirectoryName = "commands";

    public static WorkerResponse Ensure(JsonElement parameters)
    {
        _ = parameters;
        Directory.CreateDirectory(GetUserCommandsDirectory());
        return UserContentPaths.Success();
    }

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            var commandsByName = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            var bundledDir = GetBundledCommandsDirectory(parameters);
            foreach (var commandPath in EnumerateCommandPaths(bundledDir, GetUserCommandsDirectory()))
            {
                var name = CommandNameFromFilename(Path.GetFileName(commandPath));
                var normalizedName = NormalizeCommandName(name);
                if (commandsByName.ContainsKey(normalizedName))
                {
                    continue;
                }

                var content = UserContentPaths.ReadText(commandPath);
                commandsByName[normalizedName] = new JsonObject
                {
                    ["name"] = name,
                    ["summary"] = SummarizeCommand(content)
                };
            }

            var result = new JsonArray();
            foreach (var item in commandsByName.Values.OrderBy(
                item => item["name"]?.GetValue<string>(),
                StringComparer.OrdinalIgnoreCase))
            {
                result.Add((JsonNode?)item);
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
            var name = JsonHelpers.GetString(parameters, "name")?.Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error("Command name is required"));
            }

            var commandPath = ResolveCommandPath(parameters, name);
            if (commandPath is null)
            {
                return UserContentPaths.JsonNode(new JsonObject
                {
                    ["error"] = $"Command \"{name}\" not found",
                    ["notFound"] = true
                });
            }

            var content = UserContentPaths.ReadText(commandPath).Trim();
            if (content.Length == 0)
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error($"Command \"{name}\" is empty"));
            }

            return UserContentPaths.JsonNode(new JsonObject
            {
                ["name"] = CommandNameFromFilename(Path.GetFileName(commandPath)),
                ["content"] = content,
                ["summary"] = SummarizeCommand(content)
            });
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
            var result = new JsonArray();
            var effectiveNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var source in GetCommandSources(parameters))
            {
                foreach (var file in UserContentPaths.EnumerateMarkdownFiles(source.Directory))
                {
                    var commandPath = file.FullName;
                    var name = CommandNameFromFilename(file.Name);
                    var normalizedName = NormalizeCommandName(name);
                    var content = UserContentPaths.ReadText(commandPath);
                    var effective = !effectiveNames.Contains(normalizedName);
                    if (effective)
                    {
                        effectiveNames.Add(normalizedName);
                    }

                    result.Add((JsonNode?)new JsonObject
                    {
                        ["id"] = $"{source.Source}:{commandPath}",
                        ["name"] = name,
                        ["summary"] = SummarizeCommand(content),
                        ["path"] = commandPath,
                        ["source"] = source.Source,
                        ["editable"] = source.Editable,
                        ["effective"] = effective
                    });
                }
            }

            var sorted = result
                .OfType<JsonObject>()
                .OrderBy(item => item["name"]?.GetValue<string>(), StringComparer.OrdinalIgnoreCase)
                .ThenBy(item => item["source"]?.GetValue<string>() == "bundled" ? 0 : 1)
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
                return UserContentPaths.JsonNode(UserContentPaths.Error("Command path is required"));
            }

            var bundledDir = GetBundledCommandsDirectory(parameters);
            var userDir = GetUserCommandsDirectory();
            var isBundled = UserContentPaths.IsPathInsideDirectory(targetPath, bundledDir);
            var isUser = UserContentPaths.IsPathInsideDirectory(targetPath, userDir);
            if (!isBundled && !isUser)
            {
                return UserContentPaths.JsonNode(
                    UserContentPaths.Error("Command path is outside the managed directories"));
            }
            if (!File.Exists(targetPath))
            {
                return UserContentPaths.JsonNode(
                    UserContentPaths.Error($"Command file not found: {targetPath}"));
            }

            var content = UserContentPaths.ReadText(targetPath);
            var name = CommandNameFromFilename(Path.GetFileName(targetPath));
            var source = isBundled ? "bundled" : "user";
            var effective = string.Equals(ResolveCommandPath(parameters, name), Path.GetFullPath(targetPath), StringComparison.Ordinal);
            return UserContentPaths.JsonNode(new JsonObject
            {
                ["id"] = $"{source}:{targetPath}",
                ["name"] = name,
                ["summary"] = SummarizeCommand(content),
                ["path"] = targetPath,
                ["source"] = source,
                ["editable"] = source == "user",
                ["effective"] = effective,
                ["content"] = content
            });
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(UserContentPaths.Error(ex.Message));
        }
    }

    public static WorkerResponse ManageCreate(JsonElement parameters)
    {
        try
        {
            var name = JsonHelpers.GetString(parameters, "name")?.Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                return CommandMutation(false, null, "Command name is required");
            }

            var nameError = ValidateCommandName(name);
            if (nameError is not null)
            {
                return CommandMutation(false, null, nameError);
            }

            var userDir = GetUserCommandsDirectory();
            Directory.CreateDirectory(userDir);
            var targetPath = Path.Combine(userDir, $"{name}.md");
            if (File.Exists(targetPath))
            {
                return CommandMutation(false, null, $"Command \"{name}\" already exists");
            }

            var content = JsonHelpers.GetString(parameters, "content")?.Trim();
            if (string.IsNullOrWhiteSpace(content))
            {
                content = BuildNewCommandTemplate(name);
            }

            var contentError = ValidateCommandContent(content);
            if (contentError is not null)
            {
                return CommandMutation(false, null, contentError);
            }

            UserContentPaths.WriteText(targetPath, content);
            return CommandMutation(true, targetPath, null);
        }
        catch (Exception ex)
        {
            return CommandMutation(false, null, ex.Message);
        }
    }

    public static WorkerResponse ManageSave(JsonElement parameters)
    {
        try
        {
            var targetPath = JsonHelpers.GetString(parameters, "path")?.Trim();
            if (string.IsNullOrWhiteSpace(targetPath))
            {
                return CommandMutation(false, null, "Command path is required");
            }
            if (!UserContentPaths.IsPathInsideDirectory(targetPath, GetUserCommandsDirectory()))
            {
                return CommandMutation(false, null, "Only user commands can be edited");
            }

            var content = JsonHelpers.GetString(parameters, "content") ?? string.Empty;
            var contentError = ValidateCommandContent(content);
            if (contentError is not null)
            {
                return CommandMutation(false, null, contentError);
            }

            UserContentPaths.WriteText(targetPath, content);
            return CommandMutation(true, null, null);
        }
        catch (Exception ex)
        {
            return CommandMutation(false, null, ex.Message);
        }
    }

    private static IEnumerable<string> EnumerateCommandPaths(string bundledDir, string userDir)
    {
        foreach (var file in UserContentPaths.EnumerateMarkdownFiles(bundledDir))
        {
            yield return file.FullName;
        }
        foreach (var file in UserContentPaths.EnumerateMarkdownFiles(userDir))
        {
            yield return file.FullName;
        }
    }

    private static CommandSource[] GetCommandSources(JsonElement parameters)
    {
        return
        [
            new CommandSource(GetBundledCommandsDirectory(parameters), "bundled", false),
            new CommandSource(GetUserCommandsDirectory(), "user", true)
        ];
    }

    private static string? ResolveCommandPath(JsonElement parameters, string name)
    {
        return ResolveBundledCommandPath(parameters, name) ?? ResolveUserCommandPath(name);
    }

    private static string? ResolveBundledCommandPath(JsonElement parameters, string name)
    {
        var normalized = NormalizeCommandName(name);
        if (normalized.Length == 0)
        {
            return null;
        }

        foreach (var file in UserContentPaths.EnumerateMarkdownFiles(GetBundledCommandsDirectory(parameters)))
        {
            if (NormalizeCommandName(CommandNameFromFilename(file.Name)) == normalized)
            {
                return file.FullName;
            }
        }
        return null;
    }

    private static string? ResolveUserCommandPath(string name)
    {
        var normalized = NormalizeCommandName(name);
        if (normalized.Length == 0)
        {
            return null;
        }

        foreach (var file in UserContentPaths.EnumerateMarkdownFiles(GetUserCommandsDirectory()))
        {
            if (NormalizeCommandName(CommandNameFromFilename(file.Name)) == normalized)
            {
                return file.FullName;
            }
        }
        return null;
    }

    private static string SummarizeCommand(string content)
    {
        var firstMeaningfulLine = content
            .Split(["\r\n", "\n"], StringSplitOptions.None)
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .FirstOrDefault(line => !line.StartsWith("```", StringComparison.Ordinal));
        if (string.IsNullOrWhiteSpace(firstMeaningfulLine))
        {
            return string.Empty;
        }

        var normalized = HeadingPrefixRegex().Replace(firstMeaningfulLine, string.Empty).Trim();
        return normalized.Length > 120 ? $"{normalized[..120]}\u2026" : normalized;
    }

    private static string? ValidateCommandName(string name)
    {
        return CommandNameRegex().IsMatch(name.Trim())
            ? null
            : "Command name must be kebab-case (lowercase letters, numbers, hyphens)";
    }

    private static string? ValidateCommandContent(string content)
    {
        var normalized = content.Replace("\r\n", "\n").Trim();
        if (normalized.Length == 0)
        {
            return "Command content cannot be empty";
        }
        if (FrontmatterRegex().IsMatch(normalized))
        {
            return "Commands must be plain Markdown without YAML frontmatter";
        }
        if (SystemCommandTagRegex().IsMatch(normalized))
        {
            return "Commands cannot contain <system-command> tags";
        }

        var hasMeaningfulLine = normalized
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .Any(line => !line.StartsWith("```", StringComparison.Ordinal));
        return hasMeaningfulLine ? null : "Command markdown must include at least one non-code text line";
    }

    private static WorkerResponse CommandMutation(bool success, string? path, string? error)
    {
        var payload = new JsonObject { ["success"] = success };
        if (!string.IsNullOrWhiteSpace(path))
        {
            payload["path"] = path;
        }
        if (!string.IsNullOrWhiteSpace(error))
        {
            payload["error"] = error;
        }
        return UserContentPaths.JsonNode(payload);
    }

    private static string BuildNewCommandTemplate(string name)
    {
        return $"Describe what /{name} should make the agent do.\n\n- Goal:\n- Constraints:\n- Output format:";
    }

    private static string NormalizeCommandName(string name)
    {
        return name.Trim().ToLowerInvariant();
    }

    private static string CommandNameFromFilename(string filename)
    {
        return filename.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ? filename[..^3] : filename;
    }

    private static string GetBundledCommandsDirectory(JsonElement parameters)
    {
        return UserContentPaths.GetBundledDirectory(parameters, DirectoryName);
    }

    private static string GetUserCommandsDirectory()
    {
        return UserContentPaths.GetUserDirectory(DirectoryName);
    }

    [GeneratedRegex("^#+\\s*")]
    private static partial Regex HeadingPrefixRegex();

    [GeneratedRegex("^[a-z0-9]+(?:-[a-z0-9]+)*$")]
    private static partial Regex CommandNameRegex();

    [GeneratedRegex("^---\\s*\\n")]
    private static partial Regex FrontmatterRegex();

    [GeneratedRegex("</?system-command\\b", RegexOptions.IgnoreCase)]
    private static partial Regex SystemCommandTagRegex();

    private sealed record CommandSource(string Directory, string Source, bool Editable);
}
