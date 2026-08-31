using System.Text;
using System.Text.Json;

internal static class AgentRuntimeToolInputNormalizer
{
    private static readonly string[] LsPathAliases =
        ["path", "target_directory", "targetDirectory", "directory", "dir"];

    private static readonly string[] FilePathAliases =
        ["path", "filePath", "filepath", "target_file", "targetFile"];

    private static readonly string[] NotebookPathAliases =
        ["file_path", "path", "filePath", "notebookPath"];

    private static readonly HashSet<string> LsListCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "ls",
        "dir",
        "Get-ChildItem",
        "gci"
    };

    public static JsonElement Normalize(string toolName, JsonElement schema, JsonElement input)
    {
        var coerced = string.Equals(toolName, "LS", StringComparison.Ordinal)
            ? CoerceLsInput(input)
            : CoerceSchemaAliases(schema, input);
        return AgentRuntimeToolSchemaValidator.PruneAdditionalProperties(schema, coerced);
    }

    /// <summary>
    /// Models trained on other tool catalogs often send <c>path</c> or
    /// <c>target_file</c> instead of the schema's <c>file_path</c>. Copy the
    /// alias onto the canonical property before required-field validation.
    /// </summary>
    private static JsonElement CoerceSchemaAliases(JsonElement schema, JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object ||
            schema.ValueKind != JsonValueKind.Object ||
            !schema.TryGetProperty("properties", out var properties) ||
            properties.ValueKind != JsonValueKind.Object)
        {
            return input;
        }

        Dictionary<string, string>? replacements = null;
        if (properties.TryGetProperty("file_path", out _) &&
            TryResolveAlias(input, FilePathAliases, out var filePath) &&
            !HasNonEmptyString(input, "file_path"))
        {
            replacements = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["file_path"] = filePath
            };
        }

        if (properties.TryGetProperty("notebook_path", out _) &&
            !HasNonEmptyString(input, "notebook_path"))
        {
            var notebookPath = HasNonEmptyString(input, "file_path")
                ? JsonHelpers.GetString(input, "file_path")!.Trim()
                : replacements is not null && replacements.TryGetValue("file_path", out var copied)
                    ? copied
                    : null;
            if (string.IsNullOrEmpty(notebookPath))
            {
                _ = TryResolveAlias(input, NotebookPathAliases, out notebookPath);
            }

            if (!string.IsNullOrEmpty(notebookPath))
            {
                replacements ??= new Dictionary<string, string>(StringComparer.Ordinal);
                replacements["notebook_path"] = notebookPath;
            }
        }

        return replacements is null ? input : WithStringProperties(input, replacements);
    }

    private static bool TryResolveAlias(JsonElement input, string[] aliases, out string value)
    {
        foreach (var name in aliases)
        {
            var candidate = JsonHelpers.GetString(input, name)?.Trim();
            if (!string.IsNullOrEmpty(candidate))
            {
                value = candidate;
                return true;
            }
        }

        value = string.Empty;
        return false;
    }

    private static bool HasNonEmptyString(JsonElement input, string name)
    {
        return !string.IsNullOrWhiteSpace(JsonHelpers.GetString(input, name));
    }

    private static JsonElement WithStringProperties(
        JsonElement input,
        IReadOnlyDictionary<string, string> extras)
    {
        return AgentRuntimeProviderSupport.CreateObjectElement(writer =>
        {
            var written = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in input.EnumerateObject())
            {
                if (extras.TryGetValue(property.Name, out var replacement))
                {
                    writer.WriteString(property.Name, replacement);
                    written.Add(property.Name);
                    continue;
                }

                writer.WritePropertyName(property.Name);
                property.Value.WriteTo(writer);
            }

            foreach (var pair in extras)
            {
                if (written.Add(pair.Key))
                {
                    writer.WriteString(pair.Key, pair.Value);
                }
            }
        });
    }

    private static JsonElement CoerceLsInput(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return input;
        }

        var existingPath = JsonHelpers.GetString(input, "path")?.Trim();
        if (!string.IsNullOrEmpty(existingPath))
        {
            return input;
        }

        var coercedPath = ResolveLsPath(input);
        if (string.IsNullOrEmpty(coercedPath))
        {
            return input;
        }

        return AgentRuntimeProviderSupport.CreateObjectElement(writer =>
        {
            var wrotePath = false;
            foreach (var property in input.EnumerateObject())
            {
                if (property.NameEquals("path"))
                {
                    writer.WriteString("path", coercedPath);
                    wrotePath = true;
                    continue;
                }

                writer.WritePropertyName(property.Name);
                property.Value.WriteTo(writer);
            }

            if (!wrotePath)
            {
                writer.WriteString("path", coercedPath);
            }
        });
    }

    private static string? ResolveLsPath(JsonElement input)
    {
        foreach (var name in LsPathAliases)
        {
            var value = JsonHelpers.GetString(input, name)?.Trim();
            if (!string.IsNullOrEmpty(value))
            {
                return value;
            }
        }

        var command = JsonHelpers.GetString(input, "command")?.Trim();
        return string.IsNullOrEmpty(command) ? null : TryPathFromCommand(command);
    }

    private static string? TryPathFromCommand(string command)
    {
        if (command.IndexOfAny(['|', ';', '&', '>', '<', '`', '\n']) >= 0 ||
            command.Contains("$("))
        {
            return null;
        }

        var tokens = Tokenize(command);
        if (tokens.Count == 0)
        {
            return null;
        }

        if (LsListCommands.Contains(tokens[0]))
        {
            for (var index = 1; index < tokens.Count; index++)
            {
                if (!IsFlag(tokens[index]))
                {
                    return tokens[index];
                }
            }

            return null;
        }

        return LooksLikePath(tokens[0]) && tokens.Count == 1 ? tokens[0] : null;
    }

    private static List<string> Tokenize(string command)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        char? quote = null;
        foreach (var ch in command)
        {
            if (quote is not null)
            {
                if (ch == quote)
                {
                    quote = null;
                }
                else
                {
                    current.Append(ch);
                }
                continue;
            }

            if (ch is '"' or '\'')
            {
                quote = ch;
                continue;
            }

            if (char.IsWhiteSpace(ch))
            {
                if (current.Length > 0)
                {
                    tokens.Add(current.ToString());
                    current.Clear();
                }
                continue;
            }

            current.Append(ch);
        }

        if (current.Length > 0)
        {
            tokens.Add(current.ToString());
        }

        return tokens;
    }

    private static bool IsFlag(string token)
    {
        if (token.StartsWith("--", StringComparison.Ordinal) || token.StartsWith('-'))
        {
            return token is not "-" and not "--";
        }

        return token.Length is 2 or 3 &&
            token[0] == '/' &&
            token.Skip(1).All(char.IsLetter);
    }

    private static bool LooksLikePath(string token)
    {
        return token.StartsWith('.') ||
            token.StartsWith('~') ||
            token.StartsWith('/') ||
            token.StartsWith('\\') ||
            token.Contains('/') ||
            token.Contains('\\');
    }
}
