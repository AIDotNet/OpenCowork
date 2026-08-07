using System.Globalization;
using System.Text.RegularExpressions;

internal sealed record ParsedAgentDefinition(
    int SchemaVersion,
    string Name,
    string Description,
    string SystemPrompt,
    IReadOnlyList<string> AllowedTools,
    IReadOnlyList<string> DisallowedTools,
    int MaxTurns,
    int MaxDepth,
    string? Icon,
    string? InitialPrompt,
    bool Background,
    string? Model,
    double? Temperature,
    IReadOnlyList<string> Warnings);

internal static class AgentDefinitionParser
{
    public const int DefaultMaxTurns = 12;
    public const int CompatibilityUnlimitedMaxTurns = 1000;
    private static readonly string[] V1DefaultTools = ["Read", "Glob", "Grep", "LS", "Bash"];
    private static readonly Regex FrontmatterPattern = new(
        "^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---\\s*(?:\\r?\\n)?",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    public static ParsedAgentDefinition? Parse(string content, string filename, out string? error)
    {
        error = null;
        var match = FrontmatterPattern.Match(content);
        if (!match.Success)
        {
            error = "missing Markdown frontmatter";
            return null;
        }

        var fields = ParseFrontmatter(match.Groups[1].Value);
        var name = ReadString(fields, "name");
        var description = ReadString(fields, "description");
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(description))
        {
            error = "missing name or description";
            return null;
        }

        var schemaVersion = ReadInt(fields, "schemaVersion") ?? 1;
        if (schemaVersion is not (1 or 2))
        {
            error = $"unsupported schemaVersion {schemaVersion}";
            return null;
        }

        var warnings = new List<string>();
        IReadOnlyList<string> allowedTools;
        if (schemaVersion == 2)
        {
            if (!fields.ContainsKey("allowedTools"))
            {
                error = "schema v2 requires allowedTools";
                return null;
            }
            allowedTools = ReadList(fields, "allowedTools") ?? [];
        }
        else
        {
            allowedTools = ReadList(fields, "tools") ??
                ReadList(fields, "allowedTools") ??
                V1DefaultTools;
            warnings.Add("AgentDefinition v1 compatibility mode is active.");
        }

        var disallowedTools = ReadList(fields, "disallowedTools") ?? [];
        var requestedMaxTurns = ReadInt(fields, "maxTurns") ?? ReadInt(fields, "maxIterations");
        int maxTurns;
        if (!requestedMaxTurns.HasValue)
        {
            maxTurns = DefaultMaxTurns;
        }
        else if (schemaVersion == 1 && requestedMaxTurns.Value == 0)
        {
            maxTurns = CompatibilityUnlimitedMaxTurns;
            warnings.Add("v1 maxTurns=0 was mapped to the safe compatibility limit 1000.");
        }
        else if (requestedMaxTurns.Value < 1 || requestedMaxTurns.Value > CompatibilityUnlimitedMaxTurns)
        {
            if (schemaVersion == 2)
            {
                error = "schema v2 maxTurns must be between 1 and 1000";
                return null;
            }
            maxTurns = Math.Clamp(requestedMaxTurns.Value, 1, CompatibilityUnlimitedMaxTurns);
            warnings.Add($"v1 maxTurns was clamped to {maxTurns}.");
        }
        else
        {
            maxTurns = requestedMaxTurns.Value;
        }

        var maxDepth = ReadInt(fields, "maxDepth") ?? 0;
        if (schemaVersion == 2 && maxDepth != 0)
        {
            error = "schema v2 maxDepth must be 0; recursive SubAgents are not supported";
            return null;
        }

        var body = content[match.Length..].TrimStart();
        var parsed = new ParsedAgentDefinition(
            schemaVersion,
            name.Trim(),
            description.Trim(),
            body.Length == 0 ? $"You are {name}, a specialized agent." : body,
            NormalizeToolList(allowedTools),
            NormalizeToolList(disallowedTools),
            maxTurns,
            0,
            ReadString(fields, "icon"),
            ReadString(fields, "initialPrompt"),
            ReadBool(fields, "background") ?? false,
            ReadString(fields, "model"),
            ReadDouble(fields, "temperature"),
            warnings);

        foreach (var warning in warnings)
        {
            WorkerLog.Warn($"agent compatibility warning filename={filename} message={warning}");
        }
        return parsed;
    }

    private static Dictionary<string, List<string>> ParseFrontmatter(string frontmatter)
    {
        var fields = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        string? activeList = null;
        foreach (var rawLine in frontmatter.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            if (line.StartsWith("-", StringComparison.Ordinal) && activeList is not null)
            {
                fields[activeList].Add(Unquote(line[1..].Trim()));
                continue;
            }

            var separator = line.IndexOf(':');
            if (separator <= 0)
            {
                activeList = null;
                continue;
            }
            var key = line[..separator].Trim();
            var value = line[(separator + 1)..].Trim();
            fields[key] = value.Length == 0 ? [] : [value];
            activeList = value.Length == 0 ? key : null;
        }
        return fields;
    }

    private static string? ReadString(Dictionary<string, List<string>> fields, string key)
    {
        return fields.TryGetValue(key, out var values) && values.Count > 0
            ? Unquote(values[0].Trim())
            : null;
    }

    private static int? ReadInt(Dictionary<string, List<string>> fields, string key)
    {
        return int.TryParse(ReadString(fields, key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    private static double? ReadDouble(Dictionary<string, List<string>> fields, string key)
    {
        return double.TryParse(ReadString(fields, key), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    private static bool? ReadBool(Dictionary<string, List<string>> fields, string key)
    {
        return bool.TryParse(ReadString(fields, key), out var value) ? value : null;
    }

    private static string[]? ReadList(Dictionary<string, List<string>> fields, string key)
    {
        if (!fields.TryGetValue(key, out var values)) return null;
        if (values.Count != 1 || !values[0].TrimStart().StartsWith("[", StringComparison.Ordinal))
        {
            return values.Select(Unquote).Where(item => item.Length > 0).ToArray();
        }

        var value = values[0].Trim();
        if (value.StartsWith("[", StringComparison.Ordinal) && value.EndsWith("]", StringComparison.Ordinal))
        {
            value = value[1..^1];
        }
        return value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(Unquote)
            .Where(item => item.Length > 0)
            .ToArray();
    }

    private static string[] NormalizeToolList(IEnumerable<string> values)
    {
        return values.Select(item => item.Trim())
            .Where(item => item.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static string Unquote(string value)
    {
        return value.Trim().Trim('"', '\'');
    }
}
