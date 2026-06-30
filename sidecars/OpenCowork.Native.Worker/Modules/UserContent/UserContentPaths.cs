using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class UserContentPaths
{
    public static string GetUserDirectory(string name)
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            name);
    }

    public static string GetBundledDirectory(JsonElement parameters, string fallbackName)
    {
        foreach (var candidate in GetBundledDirectoryCandidates(parameters))
        {
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        var first = GetBundledDirectoryCandidates(parameters).FirstOrDefault();
        return string.IsNullOrWhiteSpace(first) ? fallbackName : first;
    }

    public static string[] GetBundledDirectoryCandidates(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("bundledDirCandidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<string>();
        foreach (var item in candidates.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var path = item.GetString()?.Trim();
            if (!string.IsNullOrWhiteSpace(path))
            {
                result.Add(Path.GetFullPath(path));
            }
        }
        return [.. result];
    }

    public static bool IsPathInsideDirectory(string targetPath, string baseDirectory)
    {
        if (string.IsNullOrWhiteSpace(targetPath) || string.IsNullOrWhiteSpace(baseDirectory))
        {
            return false;
        }

        var fullTarget = Path.GetFullPath(targetPath);
        var fullBase = Path.GetFullPath(baseDirectory);
        var relative = Path.GetRelativePath(fullBase, fullTarget);
        return relative.Length > 0 &&
            relative != "." &&
            !relative.StartsWith("..", StringComparison.Ordinal) &&
            !Path.IsPathRooted(relative);
    }

    public static IEnumerable<FileInfo> EnumerateMarkdownFiles(string directory)
    {
        if (!Directory.Exists(directory))
        {
            yield break;
        }

        foreach (var file in Directory.EnumerateFiles(directory, "*.md", SearchOption.TopDirectoryOnly))
        {
            yield return new FileInfo(file);
        }
    }

    public static string ReadText(string filePath)
    {
        return File.ReadAllText(filePath, Encoding.UTF8);
    }

    public static void WriteText(string filePath, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        File.WriteAllText(filePath, content, Encoding.UTF8);
    }

    public static WorkerResponse JsonNode(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString());
    }

    public static JsonObject Error(string error)
    {
        return new JsonObject { ["error"] = error };
    }

    public static WorkerResponse Success()
    {
        return JsonNode(new JsonObject { ["success"] = true });
    }
}
