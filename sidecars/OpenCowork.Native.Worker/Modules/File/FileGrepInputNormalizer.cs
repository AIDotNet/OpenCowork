using System.Buffers;
using System.Text.Json;

internal static class FileGrepInputNormalizer
{
    private const int GrepDefaultMaxResults = 100;
    private const int GrepMaxResults = 200;
    private const int GrepDefaultMaxLineLength = 160;
    private const int GrepMaxLineLength = 1000;
    private const int GrepDefaultMaxOutputBytes = 8 * 1024;
    private const int GrepMaxOutputBytes = 64 * 1024;
    private const int GrepMaxContextLines = 20;
    private const int GrepMaxDepth = 50;
    private const int GrepDefaultMaxScanLineLength = 16 * 1024;
    private const int GrepMaxScanLineLength = 64 * 1024;

    private static readonly Dictionary<string, string[]> TypeGlobs = new(StringComparer.OrdinalIgnoreCase)
    {
        ["c"] = ["*.c", "*.h"],
        ["cpp"] = ["*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hxx"],
        ["cs"] = ["*.cs"],
        ["css"] = ["*.css"],
        ["go"] = ["*.go"],
        ["html"] = ["*.html", "*.htm"],
        ["java"] = ["*.java"],
        ["js"] = ["*.js", "*.jsx", "*.mjs", "*.cjs"],
        ["json"] = ["*.json"],
        ["jsx"] = ["*.jsx"],
        ["kt"] = ["*.kt", "*.kts"],
        ["md"] = ["*.md", "*.mdx"],
        ["php"] = ["*.php"],
        ["py"] = ["*.py", "*.pyw"],
        ["rb"] = ["*.rb"],
        ["rs"] = ["*.rs"],
        ["rust"] = ["*.rs"],
        ["scss"] = ["*.scss"],
        ["sh"] = ["*.sh", "*.bash", "*.zsh"],
        ["sql"] = ["*.sql"],
        ["svelte"] = ["*.svelte"],
        ["swift"] = ["*.swift"],
        ["ts"] = ["*.ts", "*.tsx"],
        ["tsx"] = ["*.tsx"],
        ["vue"] = ["*.vue"],
        ["xml"] = ["*.xml"],
        ["yaml"] = ["*.yaml", "*.yml"],
        ["yml"] = ["*.yaml", "*.yml"]
    };

    public static JsonDocument BuildSearchParameters(JsonElement input, string root)
    {
        var pattern = ToJsString(GetProperty(input, "pattern"));
        var patternMode = NormalizePatternMode(input);
        var normalizedPatterns = NormalizePatternInputs(input);
        var patterns = normalizedPatterns.Patterns.Count > 0
            ? normalizedPatterns.Patterns
            : [pattern];
        var smartCase = GetBool(input, "smartCase", false);
        var ignoreCase = GetOptionalBool(input, "ignoreCase");
        var caseSensitive = GetOptionalBool(input, "caseSensitive") ??
            (ignoreCase is not null
                ? !ignoreCase.Value
                : smartCase
                    ? patterns.Any(ContainsAsciiUpper)
                    : true);
        var context = ClampContext(GetNumber(input, "context"));
        var beforeContext = HasProperty(input, "beforeContext")
            ? ClampContext(GetNumber(input, "beforeContext"))
            : context;
        var afterContext = HasProperty(input, "afterContext")
            ? ClampContext(GetNumber(input, "afterContext"))
            : context;
        var include = GetTrimmedString(input, "include");
        var exclude = GetTrimmedString(input, "exclude");
        var codeGlobPatterns = ParseGlobPatterns(GetProperty(input, "glob"));
        var typeFilters = ParseTypeFilters(GetProperty(input, "type"));
        var typeIncludePatterns = TypeFiltersToIncludePatterns(typeFilters);
        var pathspecs = ParsePatternList(GetProperty(input, "pathspec"))
            .Concat(ParsePatternList(GetProperty(input, "pathspecs")))
            .ToArray();
        var pathspecIncludePatterns = ParseGlobPatterns(GetProperty(input, "pathspecInclude"))
            .Concat(ParseGlobPatterns(GetProperty(input, "pathspecIncludes")))
            .Concat(ParseGlobPatterns(GetProperty(input, "includes")))
            .ToArray();
        var pathspecExcludePatterns = ParseGlobPatterns(GetProperty(input, "pathspecExclude"))
            .Concat(ParseGlobPatterns(GetProperty(input, "pathspecExcludes")))
            .Concat(ParseGlobPatterns(GetProperty(input, "excludes")))
            .ToArray();
        var requestedOutputMode = NormalizeOutputMode(
            GetProperty(input, "output_mode") ?? GetProperty(input, "outputMode"));
        var outputMode = GetBool(input, "filesWithMatches", false)
            ? "files_with_matches"
            : GetBool(input, "filesWithoutMatches", false)
                ? "files_without_matches"
                : GetBool(input, "count", false)
                    ? "count"
                    : requestedOutputMode;
        var respectGitignore = GetBool(input, "respectGitignore", true);
        var patternOperatorInput = GetProperty(input, "patternOperator") ??
            GetProperty(input, "operator") ??
            GetProperty(input, "combine") ??
            GetProperty(input, "matchOperator");

        return JsonDocument.Parse(WriteJson(writer =>
        {
            writer.WriteString("path", root);
            writer.WriteString("pattern", pattern);
            writer.WriteString("patternMode", patternMode);
            WriteStringArray(writer, "patterns", patterns);
            WriteStringArray(writer, "notPatterns", normalizedPatterns.NotPatterns);
            writer.WriteString(
                "patternOperator",
                patternOperatorInput is null
                    ? NormalizePatternOperator(normalizedPatterns.Operator)
                    : NormalizePatternOperator(patternOperatorInput));
            writer.WriteBoolean("allMatch", GetBool(input, "allMatch", false));
            WriteOptionalString(writer, "include", include);
            WriteOptionalString(writer, "exclude", exclude);
            WriteStringArray(
                writer,
                "includePatterns",
                ParseGlobPatterns(include)
                    .Concat(codeGlobPatterns)
                    .Concat(typeIncludePatterns));
            WriteStringArray(writer, "excludePatterns", ParseGlobPatterns(exclude));
            writer.WriteBoolean("caseSensitive", caseSensitive);
            writer.WriteBoolean("smartCase", smartCase);
            writer.WriteBoolean("literal", patternMode == "fixed");
            writer.WriteBoolean("word", GetBool(input, "word", false));
            writer.WriteBoolean("line", GetBool(input, "line", false));
            writer.WriteBoolean("invertMatch", GetBool(input, "invertMatch", false));
            writer.WriteBoolean("onlyMatching", GetBool(input, "onlyMatching", false));
            writer.WriteBoolean("column", GetBool(input, "column", false));
            writer.WriteNumber("beforeContext", beforeContext);
            writer.WriteNumber("afterContext", afterContext);
            writer.WriteNumber(
                "maxResults",
                ClampNumber(
                    GetNumber(input, "head_limit") ??
                    GetNumber(input, "headLimit") ??
                    GetNumber(input, "maxResults") ??
                    GetNumber(input, "limit"),
                    GrepDefaultMaxResults,
                    GrepMaxResults));
            writer.WriteNumber(
                "maxOutputBytes",
                ClampNumber(GetNumber(input, "maxOutputBytes"), GrepDefaultMaxOutputBytes, GrepMaxOutputBytes));
            writer.WriteNumber(
                "maxLineLength",
                ClampNumber(GetNumber(input, "maxLineLength"), GrepDefaultMaxLineLength, GrepMaxLineLength));
            writer.WriteNumber(
                "maxScanLineLength",
                ClampNumber(
                    GetNumber(input, "maxScanLineLength"),
                    GrepDefaultMaxScanLineLength,
                    GrepMaxScanLineLength));
            WriteOptionalNumber(writer, "maxCount", ClampOptionalNumber(GetNumber(input, "maxCount"), GrepMaxResults));
            WriteOptionalNumber(writer, "maxDepth", ClampOptionalNumber(GetNumber(input, "maxDepth"), GrepMaxDepth));
            writer.WriteBoolean("hidden", GetBool(input, "hidden", true));
            writer.WriteBoolean("respectGitignore", respectGitignore);
            writer.WriteBoolean("excludeStandard", GetBool(input, "excludeStandard", respectGitignore));
            writer.WriteBoolean("followSymlinks", GetBool(input, "followSymlinks", false));
            writer.WriteString("outputMode", outputMode);
            writer.WriteString("pathStyle", NormalizePathStyle(GetProperty(input, "pathStyle")));
            writer.WriteBoolean("untracked", GetBool(input, "untracked", true));
            writer.WriteBoolean("cached", GetBool(input, "cached", false));
            writer.WriteBoolean("noIndex", GetBool(input, "noIndex", false));
            writer.WriteBoolean("index", GetBool(input, "index", false));
            writer.WriteBoolean("text", GetBool(input, "text", false));
            writer.WriteBoolean("textconv", GetBool(input, "textconv", false));
            WriteOptionalNumber(writer, "threads", NormalizeThreads(GetNumber(input, "threads")));
            WriteStringArray(writer, "pathspecs", pathspecs);
            WriteStringArray(writer, "pathspecIncludePatterns", pathspecIncludePatterns);
            WriteStringArray(writer, "pathspecExcludePatterns", pathspecExcludePatterns);
            WriteStringArray(writer, "typeFilters", typeFilters);
            writer.WriteBoolean("multiline", GetBool(input, "multiline", false));
        }));
    }

    public static bool HasUsablePattern(JsonElement input)
    {
        var normalized = NormalizePatternInputs(input);
        if (normalized.Patterns.Count > 0)
        {
            return true;
        }
        return !string.IsNullOrWhiteSpace(ToJsString(GetProperty(input, "pattern")));
    }

    private static byte[] WriteJson(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        writeProperties(writer);
        writer.WriteEndObject();
        writer.Flush();
        return buffer.WrittenMemory.ToArray();
    }

    private static JsonElement? GetProperty(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var property)
            ? property
            : null;
    }

    private static bool HasProperty(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out _);
    }

    private static string? GetString(JsonElement element, string name)
    {
        return GetProperty(element, name) is { ValueKind: JsonValueKind.String } property
            ? property.GetString()
            : null;
    }

    private static string? GetTrimmedString(JsonElement element, string name)
    {
        var value = GetString(element, name)?.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }

    private static bool GetBool(JsonElement element, string name, bool fallback)
    {
        return GetProperty(element, name) is { } property
            ? property.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback
            }
            : fallback;
    }

    private static bool? GetOptionalBool(JsonElement element, string name)
    {
        return GetProperty(element, name) is { } property
            ? property.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null
            }
            : null;
    }

    private static double? GetNumber(JsonElement element, string name)
    {
        if (GetProperty(element, name) is not { ValueKind: JsonValueKind.Number } property ||
            !property.TryGetDouble(out var value) ||
            double.IsNaN(value) ||
            double.IsInfinity(value))
        {
            return null;
        }
        return value;
    }

    private static int ClampNumber(double? value, int fallback, int max)
    {
        if (value is null)
        {
            return fallback;
        }
        var normalized = (int)Math.Floor(value.Value);
        return normalized <= 0 ? fallback : Math.Min(normalized, max);
    }

    private static int? ClampOptionalNumber(double? value, int max)
    {
        if (value is null)
        {
            return null;
        }
        var normalized = (int)Math.Floor(value.Value);
        return normalized <= 0 ? null : Math.Min(normalized, max);
    }

    private static int ClampContext(double? value)
    {
        return ClampOptionalNumber(value, GrepMaxContextLines) ?? 0;
    }

    private static int? NormalizeThreads(double? value)
    {
        return ClampOptionalNumber(value, 64);
    }

    private static string NormalizeOutputMode(JsonElement? value)
    {
        var mode = value is { ValueKind: JsonValueKind.String } element ? element.GetString() : null;
        return mode switch
        {
            "content" or "matches" => "matches",
            "files_with_matches" or "files_without_matches" or "count" => mode,
            _ => "files_with_matches"
        };
    }

    private static string NormalizePathStyle(JsonElement? value)
    {
        return value is { ValueKind: JsonValueKind.String } element &&
            element.GetString() == "absolute"
            ? "absolute"
            : "relative";
    }

    private static string NormalizePatternMode(JsonElement input)
    {
        var mode = GetString(input, "patternMode") ??
            GetString(input, "regexpType") ??
            GetString(input, "regexMode");
        if (mode is "fixed" or "literal" or "fixed_strings")
        {
            return "fixed";
        }
        if (mode is "basic" or "basic_regexp")
        {
            return "basic";
        }
        if (mode is "extended" or "extended_regexp")
        {
            return "extended";
        }
        if (mode is "perl" or "perl_regexp" or "pcre")
        {
            return "perl";
        }
        if (GetBool(input, "literal", false) ||
            GetBool(input, "fixed", false) ||
            GetBool(input, "fixedStrings", false))
        {
            return "fixed";
        }
        if (GetBool(input, "basic", false) || GetBool(input, "basicRegexp", false))
        {
            return "basic";
        }
        if (GetBool(input, "extended", false) || GetBool(input, "extendedRegexp", false))
        {
            return "extended";
        }
        if (GetBool(input, "perl", false) || GetBool(input, "perlRegexp", false))
        {
            return "perl";
        }
        return "extended";
    }

    private static string NormalizePatternOperator(JsonElement? value)
    {
        return value is { ValueKind: JsonValueKind.String } element &&
            element.GetString() is "and" or "AND"
            ? "and"
            : "or";
    }

    private static string NormalizePatternOperator(string value)
    {
        return value is "and" or "AND" ? "and" : "or";
    }

    private static NormalizedPatterns NormalizePatternInputs(JsonElement input)
    {
        var positives = new List<string>();
        var negatives = new List<string>();

        void AddPattern(JsonElement? value, bool negated = false)
        {
            if (value is null)
            {
                return;
            }
            if (value.Value.ValueKind == JsonValueKind.String)
            {
                var pattern = value.Value.GetString()?.Trim();
                if (string.IsNullOrEmpty(pattern))
                {
                    return;
                }
                (negated ? negatives : positives).Add(pattern);
                return;
            }
            if (value.Value.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            var patternValue = GetProperty(value.Value, "pattern") is { ValueKind: JsonValueKind.String } patternProperty
                ? patternProperty
                : GetProperty(value.Value, "value");
            var patternNegated = negated ||
                GetBool(value.Value, "not", false) ||
                GetBool(value.Value, "negated", false) ||
                GetBool(value.Value, "invert", false);
            AddPattern(patternValue, patternNegated);
        }

        if (HasProperty(input, "patterns"))
        {
            var patterns = GetProperty(input, "patterns");
            if (patterns is { ValueKind: JsonValueKind.Array } patternArray)
            {
                foreach (var item in patternArray.EnumerateArray())
                {
                    AddPattern(item);
                }
            }
            else
            {
                AddPattern(patterns);
            }
        }
        else
        {
            AddPattern(GetProperty(input, "pattern"));
        }

        positives.AddRange(ParsePatternList(GetProperty(input, "orPatterns")));
        var andPatterns = ParsePatternList(GetProperty(input, "andPatterns"));
        negatives.AddRange(ParsePatternList(GetProperty(input, "notPatterns")));
        if (andPatterns.Length > 0)
        {
            positives.AddRange(andPatterns);
            return new NormalizedPatterns(positives, negatives, "and");
        }

        return new NormalizedPatterns(positives, negatives, "or");
    }

    private static string[] ParseDelimitedPatterns(JsonElement? value)
    {
        if (value is null)
        {
            return [];
        }
        if (value.Value.ValueKind == JsonValueKind.Array)
        {
            return value.Value.EnumerateArray()
                .SelectMany(item => ParseDelimitedPatterns(item))
                .ToArray();
        }
        if (value.Value.ValueKind != JsonValueKind.String)
        {
            return [];
        }
        return value.Value.GetString()?
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(static pattern => pattern.Length > 0)
            .ToArray() ?? [];
    }

    private static string[] ParseDelimitedPatterns(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(static pattern => pattern.Length > 0)
                .ToArray();
    }

    private static string[] ParsePatternList(JsonElement? value)
    {
        if (value is null)
        {
            return [];
        }
        if (value.Value.ValueKind == JsonValueKind.Array)
        {
            return value.Value.EnumerateArray()
                .SelectMany(static item =>
                {
                    if (item.ValueKind == JsonValueKind.String)
                    {
                        return [item.GetString() ?? string.Empty];
                    }
                    if (item.ValueKind == JsonValueKind.Object &&
                        item.TryGetProperty("pattern", out var pattern) &&
                        pattern.ValueKind == JsonValueKind.String)
                    {
                        return [pattern.GetString() ?? string.Empty];
                    }
                    return Array.Empty<string>();
                })
                .Select(static pattern => pattern.Trim())
                .Where(static pattern => pattern.Length > 0)
                .ToArray();
        }
        if (value.Value.ValueKind == JsonValueKind.String)
        {
            var pattern = value.Value.GetString()?.Trim();
            return string.IsNullOrEmpty(pattern) ? [] : [pattern];
        }
        return [];
    }

    private static string[] ParseGlobPatterns(JsonElement? value)
    {
        return ParseDelimitedPatterns(value);
    }

    private static string[] ParseGlobPatterns(string? value)
    {
        return ParseDelimitedPatterns(value);
    }

    private static string[] ParseTypeFilters(JsonElement? value)
    {
        return ParseDelimitedPatterns(value)
            .Select(static item =>
            {
                if (item.StartsWith("--type=", StringComparison.Ordinal))
                {
                    return item[7..].Trim();
                }
                if (item.StartsWith("-type=", StringComparison.Ordinal))
                {
                    return item[6..].Trim();
                }
                return item.Trim();
            })
            .Where(static item => item.Length > 0)
            .ToArray();
    }

    private static IEnumerable<string> TypeFiltersToIncludePatterns(IEnumerable<string> typeFilters)
    {
        foreach (var typeFilter in typeFilters)
        {
            if (!TypeGlobs.TryGetValue(typeFilter, out var patterns))
            {
                continue;
            }
            foreach (var pattern in patterns)
            {
                yield return pattern;
            }
        }
    }

    private static string ToJsString(JsonElement? value)
    {
        if (value is null || value.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return string.Empty;
        }
        return value.Value.ValueKind switch
        {
            JsonValueKind.String => value.Value.GetString() ?? string.Empty,
            JsonValueKind.Number => value.Value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Array => string.Join(",", value.Value.EnumerateArray().Select(item => ToJsString(item))),
            JsonValueKind.Object => "[object Object]",
            _ => string.Empty
        };
    }

    private static bool ContainsAsciiUpper(string value)
    {
        return value.Any(static character => character is >= 'A' and <= 'Z');
    }

    private static void WriteOptionalString(Utf8JsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(name, value);
        }
    }

    private static void WriteOptionalNumber(Utf8JsonWriter writer, string name, int? value)
    {
        if (value is not null)
        {
            writer.WriteNumber(name, value.Value);
        }
    }

    private static void WriteStringArray(Utf8JsonWriter writer, string name, IEnumerable<string> values)
    {
        writer.WritePropertyName(name);
        writer.WriteStartArray();
        foreach (var value in values.Where(static item => !string.IsNullOrWhiteSpace(item)))
        {
            writer.WriteStringValue(value.Trim());
        }
        writer.WriteEndArray();
    }

    private sealed record NormalizedPatterns(List<string> Patterns, List<string> NotPatterns, string Operator);
}
