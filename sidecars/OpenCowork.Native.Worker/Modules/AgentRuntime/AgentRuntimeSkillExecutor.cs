using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class AgentRuntimeSkillExecutor
{
    private const string SkillToolName = "Skill";
    private const string SkillsDirectoryName = ".agents/skills";
    private const string SkillFileName = "SKILL.md";

    public static bool IsSkillTool(string toolName)
    {
        return string.Equals(toolName, SkillToolName, StringComparison.Ordinal);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        CancellationToken cancellationToken)
    {
        var skillName = ReadSkillName(call.Input);
        if (string.IsNullOrWhiteSpace(skillName))
        {
            return EncodeError("SkillName is required");
        }

        var skillsRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            SkillsDirectoryName);
        var skillDirectory = ResolveSkillDirectory(skillsRoot, skillName);
        if (skillDirectory is null)
        {
            return EncodeError($"Skill \"{skillName}\" not found");
        }

        var skillFilePath = Path.Combine(skillDirectory, SkillFileName);
        if (!File.Exists(skillFilePath))
        {
            return EncodeError($"Skill \"{skillName}\" not found at {skillFilePath}");
        }

        var raw = await File.ReadAllTextAsync(skillFilePath, cancellationToken);
        var content = StripFrontmatter(raw).TrimStart();
        return
            "<skill_context>\n" +
            $"<working_directory>{skillDirectory}</working_directory>\n" +
            "<instruction>CRITICAL: When executing any script mentioned in this skill, you MUST prepend the working_directory to form an absolute path. For example, if the skill says \"python scripts/foo.py\", you must run \"python " +
            skillDirectory +
            "/scripts/foo.py\". NEVER run scripts using bare relative paths like \"python scripts/foo.py\" — they will fail because your cwd is not the skill directory.</instruction>\n" +
            "</skill_context>\n\n" +
            content;
    }

    private static string ReadSkillName(JsonElement input)
    {
        return (JsonHelpers.GetString(input, "SkillName") ??
                JsonHelpers.GetString(input, "skillName") ??
                JsonHelpers.GetString(input, "name") ??
                string.Empty)
            .Trim();
    }

    private static string? ResolveSkillDirectory(string skillsRoot, string skillName)
    {
        if (!Directory.Exists(skillsRoot))
        {
            return null;
        }

        var direct = Path.Combine(skillsRoot, skillName);
        if (IsSafeChildPath(skillsRoot, direct) &&
            File.Exists(Path.Combine(direct, SkillFileName)))
        {
            return Path.GetFullPath(direct);
        }

        foreach (var directory in Directory.EnumerateDirectories(skillsRoot))
        {
            if (string.Equals(Path.GetFileName(directory), skillName, StringComparison.OrdinalIgnoreCase) &&
                File.Exists(Path.Combine(directory, SkillFileName)))
            {
                return Path.GetFullPath(directory);
            }
        }

        return null;
    }

    private static bool IsSafeChildPath(string root, string candidate)
    {
        var fullRoot = Path.GetFullPath(root);
        var fullCandidate = Path.GetFullPath(candidate);
        return fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            string.Equals(fullRoot, fullCandidate, StringComparison.Ordinal);
    }

    private static string StripFrontmatter(string raw)
    {
        return FrontmatterRegex().Replace(raw, string.Empty, 1);
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

    [GeneratedRegex("^---\\s*\\r?\\n[\\s\\S]*?\\r?\\n---\\s*(?:\\r?\\n)?")]
    private static partial Regex FrontmatterRegex();
}
