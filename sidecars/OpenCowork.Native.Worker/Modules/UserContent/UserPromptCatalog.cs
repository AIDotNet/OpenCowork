using System.Text.Json;
using System.Text.Json.Nodes;

internal static class UserPromptCatalog
{
    private const string DirectoryName = "prompts";

    public static WorkerResponse Ensure(JsonElement parameters)
    {
        try
        {
            EnsureBuiltinPrompts(parameters);
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
            EnsureBuiltinPrompts(parameters);
            var prompts = new JsonArray();
            foreach (var file in UserContentPaths.EnumerateMarkdownFiles(GetUserPromptsDirectory()))
            {
                prompts.Add((JsonNode?)JsonValue.Create(Path.GetFileNameWithoutExtension(file.Name)));
            }
            return UserContentPaths.JsonNode(prompts);
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
            EnsureBuiltinPrompts(parameters);
            var name = JsonHelpers.GetString(parameters, "name")?.Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error("Prompt name is required"));
            }

            var promptPath = ResolvePromptPath(parameters, name);
            if (promptPath is null)
            {
                return UserContentPaths.JsonNode(UserContentPaths.Error($"Prompt \"{name}\" not found"));
            }

            return UserContentPaths.JsonNode(new JsonObject
            {
                ["content"] = UserContentPaths.ReadText(promptPath)
            });
        }
        catch (Exception ex)
        {
            return UserContentPaths.JsonNode(UserContentPaths.Error(ex.Message));
        }
    }

    private static void EnsureBuiltinPrompts(JsonElement parameters)
    {
        var bundledDir = UserContentPaths.GetBundledDirectory(parameters, DirectoryName);
        if (!Directory.Exists(bundledDir))
        {
            WorkerLog.Warn($"prompts bundled directory not found path={bundledDir}");
            return;
        }

        var userDir = GetUserPromptsDirectory();
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

    private static string? ResolvePromptPath(JsonElement parameters, string name)
    {
        var filename = ResolvePromptFilename(name);
        if (filename is null)
        {
            return null;
        }

        var userPath = Path.Combine(GetUserPromptsDirectory(), filename);
        if (File.Exists(userPath))
        {
            return userPath;
        }

        var bundledPath = Path.Combine(UserContentPaths.GetBundledDirectory(parameters, DirectoryName), filename);
        return File.Exists(bundledPath) ? bundledPath : null;
    }

    private static string? ResolvePromptFilename(string name)
    {
        var trimmed = Path.GetFileName(name.Trim());
        if (string.IsNullOrWhiteSpace(trimmed) || trimmed == "." || trimmed == "..")
        {
            return null;
        }
        return trimmed.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : $"{trimmed}.md";
    }

    private static string GetUserPromptsDirectory()
    {
        return UserContentPaths.GetUserDirectory(DirectoryName);
    }
}
