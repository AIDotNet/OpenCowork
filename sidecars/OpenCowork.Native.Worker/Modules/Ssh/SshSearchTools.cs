using System.Text.Json;

internal static class SshSearchTools
{
    private const int DefaultTimeoutMs = 60_000;
    private const int DefaultGlobLimit = 100;
    private const int DefaultGrepLimit = 20;
    private const int MaxGrepLimit = 200;
    private const int MaxGrepContext = 20;
    private const int MaxGrepDepth = 50;
    private const int DefaultGrepMaxLineLength = 160;
    private const int MaxGrepLineLength = 1000;
    private const int MaxRemoteGrepLineChars = 2 * 1024;
    private const int MaxSearchStdoutChars = 64 * 1024;

    private static readonly string[] IgnoreDirs =
    [
        "node_modules",
        ".git",
        ".svn",
        ".hg",
        ".bzr",
        "dist",
        "build",
        "out",
        ".next",
        ".nuxt",
        ".output",
        "coverage",
        ".nyc_output",
        ".cache",
        ".parcel-cache",
        "vendor",
        "target",
        "bin",
        "obj",
        ".gradle",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".venv",
        "venv",
        "env"
    ];

    public static async Task<WorkerResponse> GlobAsync(JsonElement parameters)
    {
        var path = JsonHelpers.GetString(parameters, "path") ?? ".";
        var pattern = JsonHelpers.GetString(parameters, "pattern") ?? string.Empty;
        var limit = ClampSearchLimit(JsonHelpers.GetInt(parameters, "limit", DefaultGlobLimit), DefaultGlobLimit);
        const int maxDepth = 5;

        try
        {
            var ignoreJson = ToJsonStringArray(FilterIgnoredDirs(pattern));
            var script = """
                import fnmatch, json, os, sys
                root = os.path.abspath(os.path.expanduser(sys.argv[1]))
                pattern = sys.argv[2]
                limit = int(sys.argv[3])
                max_depth = int(sys.argv[4])
                ignore = set(json.loads(sys.argv[5]))
                matches = []
                truncated = False

                def emit():
                    print(json.dumps({"root": root, "matches": matches, "truncated": truncated}, separators=(",", ":")))

                if not os.path.exists(root):
                    emit()
                    sys.exit(0)

                def kind(full):
                    if os.path.isdir(full):
                        return "directory"
                    if os.path.islink(full):
                        return "symlink"
                    return "file"

                def maybe_add(full, rel, name):
                    global truncated
                    if fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(rel, pattern):
                        matches.append({"path": full, "type": kind(full)})
                        if len(matches) >= limit:
                            truncated = True
                            emit()
                            sys.exit(0)

                if os.path.isfile(root) or os.path.islink(root):
                    maybe_add(root, os.path.basename(root), os.path.basename(root))
                    emit()
                    sys.exit(0)

                for dirpath, dirs, files in os.walk(root, followlinks=False):
                    rel_dir = os.path.relpath(dirpath, root)
                    if rel_dir == ".":
                        rel_dir = ""
                    depth = 0 if not rel_dir else rel_dir.count(os.sep) + 1
                    if depth >= max_depth:
                        dirs[:] = []
                    else:
                        dirs[:] = [d for d in dirs if d not in ignore]

                    for name in list(dirs):
                        rel = os.path.join(rel_dir, name) if rel_dir else name
                        maybe_add(os.path.join(root, rel), rel, name)
                    for name in files:
                        rel = os.path.join(rel_dir, name) if rel_dir else name
                        maybe_add(os.path.join(root, rel), rel, name)

                emit()
                """;
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(path)} {SshOpenSsh.ShellEscape(pattern)} {limit} {maxDepth} {SshOpenSsh.ShellEscape(ignoreJson)}",
                DefaultTimeoutMs,
                maxStdoutChars: MaxSearchStdoutChars);

            if (result.ExitCode != 0)
            {
                return Glob(path, pattern, [], false, null, result.Stderr, maxDepth);
            }

            using var document = JsonDocument.Parse(result.Stdout);
            var root = document.RootElement;
            var searchRoot = root.TryGetProperty("root", out var rootElement) &&
                rootElement.ValueKind == JsonValueKind.String
                    ? rootElement.GetString() ?? path
                    : path;
            var truncated = root.TryGetProperty("truncated", out var truncatedElement) &&
                truncatedElement.ValueKind is JsonValueKind.True or JsonValueKind.False &&
                truncatedElement.GetBoolean();
            var matches = new List<GlobMatchItem>();
            if (root.TryGetProperty("matches", out var matchesElement) &&
                matchesElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in matchesElement.EnumerateArray())
                {
                    var matchPath = JsonHelpers.GetString(item, "path");
                    if (string.IsNullOrWhiteSpace(matchPath))
                    {
                        continue;
                    }

                    matches.Add(new GlobMatchItem(matchPath, JsonHelpers.GetString(item, "type")));
                }
            }

            return Glob(searchRoot, pattern, matches, truncated, truncated ? "max_results" : null, null, maxDepth);
        }
        catch (Exception ex)
        {
            return Glob(path, pattern, [], false, null, ex.Message, maxDepth);
        }
    }

    public static async Task<WorkerResponse> GrepAsync(JsonElement parameters)
    {
        var options = SshGrepOptions.FromJson(parameters);
        var cwdInput = JsonHelpers.GetString(parameters, "path") ?? ".";
        var cwd = await ResolveRemotePathAsync(parameters, cwdInput);

        try
        {
            var hasRipgrep = await HasRemoteCommandAsync(parameters, "rg");
            return hasRipgrep
                ? await GrepWithRipgrepAsync(parameters, cwd, options)
                : await GrepWithGrepAsync(parameters, cwd, options);
        }
        catch (Exception ex)
        {
            return Grep(
                cwd,
                options,
                [],
                false,
                false,
                null,
                null,
                [ex.Message],
                ex.Message);
        }
    }

    private static async Task<WorkerResponse> GrepWithRipgrepAsync(
        JsonElement parameters,
        string cwd,
        SshGrepOptions options)
    {
        var remoteLineLimit = options.OutputMode == "matches"
            ? Math.Max(
                options.MaxResults * Math.Max(8, options.BeforeContext + options.AfterContext + 4),
                options.MaxResults + 100)
            : options.MaxResults;
        var command = $"cd {SshOpenSsh.ShellPathExpr(cwd)} && rg --line-number --color never --no-messages --max-filesize 10M";
        command = AppendRipgrepSearchFlags(command, options);
        command = AppendRipgrepDefaultGlobs(command);
        foreach (var include in ParsePatterns(options.Include))
        {
            command += $" --glob {SshOpenSsh.ShellEscape(include)}";
        }

        foreach (var exclude in ParsePatterns(options.Exclude))
        {
            command += $" --glob {SshOpenSsh.ShellEscape("!" + exclude)}";
        }

        command += $" -- {SshOpenSsh.ShellEscape(options.Pattern)} . 2>/dev/null | head -{remoteLineLimit}";
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            command,
            DefaultTimeoutMs,
            maxStdoutChars: MaxSearchStdoutChars);

        if (result.ExitCode != 0 && result.ExitCode != 1)
        {
            return Grep(
                cwd,
                options,
                [],
                false,
                false,
                null,
                "remote_rg",
                ["SSH grep uses remote rg and may be truncated by result limits"],
                result.Stderr.Length > 0 ? result.Stderr : "grep failed");
        }

        var matches = new List<GrepMatchItem>();
        var rawMatchCount = 0;
        var parseFailed = false;

        foreach (var rawLine in SplitLines(result.Stdout))
        {
            if (string.IsNullOrWhiteSpace(rawLine))
            {
                continue;
            }

            if (options.OutputMode != "matches")
            {
                ParseNonMatchOutput(cwd, options, rawLine.Trim(), matches);
                rawMatchCount++;
                continue;
            }

            try
            {
                using var document = JsonDocument.Parse(rawLine);
                var root = document.RootElement;
                var type = JsonHelpers.GetString(root, "type");
                if (type is not ("match" or "context") || !root.TryGetProperty("data", out var data))
                {
                    continue;
                }

                rawMatchCount++;
                var rawPath = data.TryGetProperty("path", out var pathElement)
                    ? JsonHelpers.GetString(pathElement, "text")
                    : null;
                var text = data.TryGetProperty("lines", out var linesElement)
                    ? JsonHelpers.GetString(linesElement, "text") ?? string.Empty
                    : string.Empty;
                var lineNumber = JsonHelpers.GetIntNullable(data, "line_number");
                if (string.IsNullOrWhiteSpace(rawPath) || lineNumber is null)
                {
                    continue;
                }

                matches.Add(new GrepMatchItem(
                    FormatGrepPath(cwd, rawPath, options),
                    lineNumber,
                    null,
                    NormalizeGrepLine(text, options.MaxLineLength),
                    type,
                    null));
            }
            catch
            {
                parseFailed = true;
            }
        }

        var truncated = rawMatchCount >= options.MaxResults;
        var warnings = new List<string>();
        if (truncated)
        {
            warnings.Add("SSH grep result truncated by remote limit");
        }

        if (parseFailed)
        {
            warnings.Add("Some SSH grep result lines could not be parsed");
        }

        return Grep(
            cwd,
            options,
            matches,
            truncated,
            false,
            truncated ? "max_results" : null,
            "remote_rg",
            warnings,
            null,
            result.Stdout);
    }

    private static async Task<WorkerResponse> GrepWithGrepAsync(
        JsonElement parameters,
        string cwd,
        SshGrepOptions options)
    {
        var grepWarnings = new List<string>();
        if (options.RespectGitignore)
        {
            grepWarnings.Add("SSH grep fallback does not support gitignore semantics");
        }

        if (options.SmartCase)
        {
            grepWarnings.Add("SSH grep fallback does not support smartCase");
        }

        if (options.MaxDepth is not null)
        {
            grepWarnings.Add("SSH grep fallback does not support maxDepth");
        }

        if (!options.Hidden)
        {
            grepWarnings.Add("SSH grep fallback does not support hidden=false");
        }

        if (options.FollowSymlinks)
        {
            grepWarnings.Add("SSH grep fallback follows grep implementation defaults");
        }

        var supportsRecursiveGlobs = await RemoteGrepSupportsRecursiveGlobsAsync(parameters);
        if (!supportsRecursiveGlobs)
        {
            return Grep(
                cwd,
                options,
                [],
                false,
                false,
                null,
                "remote_grep",
                [.. grepWarnings, "Install ripgrep on the remote host for full SSH Grep support"],
                "Remote grep fallback requires ripgrep or GNU grep-style --include/--exclude-dir support");
        }

        var command = "grep -Rsn";
        if (!options.CaseSensitive) command += " -i";
        if (options.Literal) command += " -F";
        if (options.Word) command += " -w";
        if (options.Line) command += " -x";
        if (options.InvertMatch) command += " -v";
        if (options.BeforeContext > 0) command += $" -B {options.BeforeContext}";
        if (options.AfterContext > 0) command += $" -A {options.AfterContext}";
        if (options.OutputMode == "files_with_matches") command += " -l";
        if (options.OutputMode == "files_without_matches") command += " -L";
        if (options.OutputMode == "count") command += " -c";
        command = AppendGrepExcludeDirs(command);
        foreach (var include in ParsePatterns(options.Include))
        {
            command += $" --include={SshOpenSsh.ShellEscape(include)}";
        }

        foreach (var exclude in ParsePatterns(options.Exclude))
        {
            command += $" --exclude={SshOpenSsh.ShellEscape(exclude)}";
        }

        command += $" -- {SshOpenSsh.ShellEscape(options.Pattern)} {SshOpenSsh.ShellPathExpr(cwd)}";
        command += options.OutputMode == "matches"
            ? $" 2>/dev/null | cut -c 1-{RemoteLineOutputLimit(options)} | head -{options.MaxResults}"
            : $" 2>/dev/null | head -{options.MaxResults}";
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            command,
            DefaultTimeoutMs,
            maxStdoutChars: MaxSearchStdoutChars);

        if (result.ExitCode != 0 && result.ExitCode != 1)
        {
            return Grep(
                cwd,
                options,
                [],
                false,
                false,
                null,
                "remote_grep",
                grepWarnings,
                result.Stderr.Length > 0 ? result.Stderr : "grep failed");
        }

        var rawLines = SplitLines(result.Stdout).Where(line => line.Length > 0).ToArray();
        var matches = new List<GrepMatchItem>();
        foreach (var line in rawLines)
        {
            ParseGrepLine(cwd, options, line, matches);
        }

        var truncated = rawLines.Length >= options.MaxResults;
        if (truncated)
        {
            grepWarnings.Add("SSH grep result truncated by remote limit");
        }

        return Grep(
            cwd,
            options,
            matches,
            truncated,
            false,
            truncated ? "max_results" : null,
            "remote_grep",
            grepWarnings,
            null,
            result.Stdout);
    }

    private static async Task<string> ResolveRemotePathAsync(JsonElement parameters, string path)
    {
        var script = "import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))";
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(path)}",
            10_000,
            maxStdoutChars: 64 * 1024,
            maxStderrChars: 64 * 1024);
        return result.ExitCode == 0 && result.Stdout.Trim().Length > 0 ? result.Stdout.Trim() : path;
    }

    private static async Task<bool> HasRemoteCommandAsync(JsonElement parameters, string command)
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"command -v {SshOpenSsh.ShellEscape(command)} >/dev/null 2>&1",
            10_000,
            maxStdoutChars: 1024,
            maxStderrChars: 1024);
        return result.ExitCode == 0;
    }

    private static async Task<bool> RemoteGrepSupportsRecursiveGlobsAsync(JsonElement parameters)
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            "grep --help 2>/dev/null | grep -q -- '--include'",
            10_000,
            maxStdoutChars: 1024,
            maxStderrChars: 1024);
        return result.ExitCode == 0;
    }

    private static WorkerResponse Glob(
        string searchRoot,
        string pattern,
        List<GlobMatchItem> matches,
        bool truncated,
        string? limitReason,
        string? error,
        int? maxDepth)
    {
        return WorkerResponse.Json(
            new GlobToolResult(
                "glob",
                matches,
                CreateSearchMeta(
                    searchRoot,
                    pattern,
                    null,
                    null,
                    "matches",
                    truncated,
                    false,
                    limitReason,
                    "native_aot_openssh_python",
                    null,
                    true,
                    true,
                    false,
                    false,
                    maxDepth,
                    0,
                    0,
                    null,
                    null,
                    null,
                    error is null ? [] : ["SSH glob runs in the native worker through OpenSSH"]),
                error),
            WorkerJsonContext.Default.GlobToolResult);
    }

    private static WorkerResponse Grep(
        string searchRoot,
        SshGrepOptions options,
        List<GrepMatchItem> matches,
        bool truncated,
        bool timedOut,
        string? limitReason,
        string? engine,
        IEnumerable<string> warnings,
        string? error,
        string output = "")
    {
        return WorkerResponse.Json(
            new GrepToolResult(
                "grep",
                matches,
                CreateSearchMeta(
                    searchRoot,
                    options.Pattern,
                    options.Include,
                    options.Exclude,
                    options.OutputMode,
                    truncated,
                    timedOut,
                    limitReason,
                    engine,
                    null,
                    options.Hidden,
                    true,
                    options.RespectGitignore,
                    options.FollowSymlinks,
                    options.MaxDepth,
                    options.BeforeContext,
                    options.AfterContext,
                    options.MaxResults,
                    null,
                    options.MaxLineLength,
                    warnings.ToArray()),
                output,
                error),
            WorkerJsonContext.Default.GrepToolResult);
    }

    private static SearchMeta CreateSearchMeta(
        string searchRoot,
        string pattern,
        string? include,
        string? exclude,
        string outputMode,
        bool truncated,
        bool timedOut,
        string? limitReason,
        string? engine,
        int? searchTime,
        bool hiddenIncluded,
        bool ignoredDefaultsApplied,
        bool respectGitignore,
        bool followSymlinks,
        int? maxDepth,
        int beforeContext,
        int afterContext,
        int? maxResults,
        int? maxOutputBytes,
        int? maxLineLength,
        string[] warnings)
    {
        return new SearchMeta(
            "ssh",
            engine,
            searchRoot,
            "absolute",
            truncated,
            timedOut,
            limitReason,
            pattern,
            include,
            exclude,
            outputMode,
            hiddenIncluded,
            ignoredDefaultsApplied,
            respectGitignore,
            followSymlinks,
            searchTime,
            warnings,
            maxDepth,
            beforeContext,
            afterContext,
            maxResults,
            maxOutputBytes,
            maxLineLength);
    }

    private static string AppendRipgrepSearchFlags(string command, SshGrepOptions options)
    {
        var next = command;
        if (options.OutputMode == "matches")
        {
            next += " --json";
            next += $" --max-columns {options.MaxLineLength}";
            if (options.BeforeContext > 0) next += $" --before-context {options.BeforeContext}";
            if (options.AfterContext > 0) next += $" --after-context {options.AfterContext}";
        }
        else if (options.OutputMode == "files_with_matches")
        {
            next += " --files-with-matches";
        }
        else if (options.OutputMode == "files_without_matches")
        {
            next += " --files-without-match";
        }
        else
        {
            next += " --count";
        }

        if (options.SmartCase) next += " --smart-case";
        else if (!options.CaseSensitive) next += " --ignore-case";
        if (options.Literal) next += " --fixed-strings";
        if (options.Word) next += " --word-regexp";
        if (options.Line) next += " --line-regexp";
        if (options.InvertMatch) next += " --invert-match";
        if (options.Hidden) next += " --hidden";
        if (options.RespectGitignore) next += " --no-require-git";
        else next += " --no-ignore";
        if (options.FollowSymlinks) next += " --follow";
        if (options.MaxDepth is not null) next += $" --max-depth {options.MaxDepth}";
        if (options.Multiline) next += " --multiline --multiline-dotall";
        foreach (var typeFilter in options.TypeFilters)
        {
            next += $" --type {SshOpenSsh.ShellEscape(typeFilter)}";
        }

        return next;
    }

    private static string AppendRipgrepDefaultGlobs(string command)
    {
        var next = command;
        foreach (var dir in IgnoreDirs)
        {
            next += $" --glob {SshOpenSsh.ShellEscape("!" + dir + "/**")}";
            next += $" --glob {SshOpenSsh.ShellEscape("!**/" + dir + "/**")}";
        }

        return next;
    }

    private static string AppendGrepExcludeDirs(string command)
    {
        var next = command;
        foreach (var dir in IgnoreDirs)
        {
            next += $" --exclude-dir={SshOpenSsh.ShellEscape(dir)}";
        }

        return next;
    }

    private static void ParseNonMatchOutput(
        string cwd,
        SshGrepOptions options,
        string line,
        List<GrepMatchItem> matches)
    {
        if (options.OutputMode is "files_with_matches" or "files_without_matches")
        {
            matches.Add(new GrepMatchItem(FormatGrepPath(cwd, line, options), null, null, null, null, null));
            return;
        }

        var index = line.LastIndexOf(':');
        if (index <= 0 || index >= line.Length - 1 || !int.TryParse(line[(index + 1)..], out var count))
        {
            return;
        }

        if (count > 0)
        {
            matches.Add(new GrepMatchItem(FormatGrepPath(cwd, line[..index], options), null, null, null, null, count));
        }
    }

    private static void ParseGrepLine(
        string cwd,
        SshGrepOptions options,
        string line,
        List<GrepMatchItem> matches)
    {
        if (options.OutputMode is "files_with_matches" or "files_without_matches")
        {
            matches.Add(new GrepMatchItem(FormatGrepPath(cwd, line.Trim(), options), null, null, null, null, null));
            return;
        }

        if (options.OutputMode == "count")
        {
            ParseNonMatchOutput(cwd, options, line.Trim(), matches);
            return;
        }

        var firstColon = line.IndexOf(':');
        if (firstColon <= 0)
        {
            return;
        }

        var pathPart = line[..firstColon];
        var rest = line[(firstColon + 1)..];
        var separatorIndex = rest.IndexOfAny([':', '-']);
        if (separatorIndex <= 0 || !int.TryParse(rest[..separatorIndex], out var lineNumber))
        {
            return;
        }

        var separator = rest[separatorIndex];
        var text = separatorIndex + 1 < rest.Length ? rest[(separatorIndex + 1)..] : string.Empty;
        matches.Add(new GrepMatchItem(
            FormatGrepPath(cwd, pathPart, options),
            lineNumber,
            null,
            NormalizeGrepLine(text, options.MaxLineLength),
            separator == '-' ? "context" : "match",
            null));
    }

    private static string FormatGrepPath(string cwd, string rawPath, SshGrepOptions options)
    {
        if (options.PathStyle == "absolute")
        {
            return rawPath.StartsWith("/", StringComparison.Ordinal) ? rawPath : PosixJoin(cwd, rawPath);
        }

        var fullPath = rawPath.StartsWith("/", StringComparison.Ordinal) ? rawPath : PosixJoin(cwd, rawPath);
        return fullPath.StartsWith(cwd.TrimEnd('/') + "/", StringComparison.Ordinal)
            ? fullPath[(cwd.TrimEnd('/').Length + 1)..]
            : fullPath;
    }

    private static string PosixJoin(string left, string right)
    {
        var normalizedRight = right.Replace('\\', '/').TrimStart('/');
        while (normalizedRight.StartsWith("./", StringComparison.Ordinal))
        {
            normalizedRight = normalizedRight[2..];
        }

        if (normalizedRight == ".")
        {
            return left;
        }

        if (string.IsNullOrEmpty(left) || left == "/")
        {
            return "/" + normalizedRight;
        }

        return left.TrimEnd('/') + "/" + normalizedRight;
    }

    private static string[] ParsePatterns(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static IEnumerable<string> FilterIgnoredDirs(string pattern)
    {
        return IgnoreDirs.Where(dir => !IncludesIgnoredDir(pattern, dir));
    }

    private static bool IncludesIgnoredDir(string pattern, string dirName)
    {
        var normalized = pattern.Replace('\\', '/');
        return normalized.Split('/', StringSplitOptions.RemoveEmptyEntries).Contains(dirName);
    }

    private static string[] SplitLines(string value)
    {
        return value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
    }

    private static string NormalizeGrepLine(string text, int maxLineLength)
    {
        var normalized = text.Trim();
        return normalized.Length <= maxLineLength
            ? normalized
            : normalized[..Math.Max(0, maxLineLength - 3)] + "...";
    }

    private static int RemoteLineOutputLimit(SshGrepOptions options)
    {
        return Math.Min(MaxRemoteGrepLineChars, Math.Max(512, options.MaxLineLength + 512));
    }

    private static string ToJsonStringArray(IEnumerable<string> values)
    {
        return "[" + string.Join(
            ',',
            values.Select(value => "\"" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"")) + "]";
    }

    private static int ClampSearchLimit(int value, int fallback)
    {
        if (value <= 0)
        {
            return fallback;
        }

        return Math.Min(value, MaxGrepLimit);
    }

    private static int ClampContext(int value)
    {
        if (value <= 0)
        {
            return 0;
        }

        return Math.Min(value, MaxGrepContext);
    }

    private static int ClampLineLength(int value)
    {
        if (value <= 0)
        {
            return DefaultGrepMaxLineLength;
        }

        return Math.Min(value, MaxGrepLineLength);
    }

    private static int? ClampOptionalNumber(int? value, int max)
    {
        if (value is null or <= 0)
        {
            return null;
        }

        return Math.Min(value.Value, max);
    }

    private sealed record SshGrepOptions(
        string Pattern,
        string? Include,
        string? Exclude,
        string[] TypeFilters,
        bool CaseSensitive,
        bool SmartCase,
        bool Literal,
        bool Word,
        bool Line,
        bool InvertMatch,
        int BeforeContext,
        int AfterContext,
        int MaxResults,
        int MaxLineLength,
        int? MaxDepth,
        bool Hidden,
        bool RespectGitignore,
        bool FollowSymlinks,
        string OutputMode,
        string PathStyle,
        bool Multiline)
    {
        public static SshGrepOptions FromJson(JsonElement parameters)
        {
            var pattern = JsonHelpers.GetString(parameters, "pattern") ?? string.Empty;
            var smartCase = JsonHelpers.GetBool(parameters, "smartCase", false);
            var hasCaseSensitive = parameters.ValueKind == JsonValueKind.Object &&
                parameters.TryGetProperty("caseSensitive", out var caseSensitiveElement) &&
                caseSensitiveElement.ValueKind is JsonValueKind.True or JsonValueKind.False;
            var caseSensitive = hasCaseSensitive
                ? JsonHelpers.GetBool(parameters, "caseSensitive", false)
                : smartCase
                    ? pattern.Any(char.IsUpper)
                    : false;
            var context = ClampContext(JsonHelpers.GetInt(parameters, "context", 0));
            var beforeContext = parameters.TryGetProperty("beforeContext", out _)
                ? ClampContext(JsonHelpers.GetInt(parameters, "beforeContext", 0))
                : context;
            var afterContext = parameters.TryGetProperty("afterContext", out _)
                ? ClampContext(JsonHelpers.GetInt(parameters, "afterContext", 0))
                : context;
            var include = string.Join(
                ',',
                JsonHelpers.GetStringArray(parameters, "include")
                    .Concat(JsonHelpers.GetStringArray(parameters, "glob")));
            var exclude = JsonHelpers.GetString(parameters, "exclude")?.Trim();
            var maxResults = ClampSearchLimit(
                JsonHelpers.GetIntNullable(parameters, "head_limit") ??
                JsonHelpers.GetIntNullable(parameters, "headLimit") ??
                JsonHelpers.GetIntNullable(parameters, "maxResults") ??
                JsonHelpers.GetIntNullable(parameters, "limit") ??
                DefaultGrepLimit,
                DefaultGrepLimit);
            var rawOutputMode = JsonHelpers.GetString(parameters, "output_mode") ??
                JsonHelpers.GetString(parameters, "outputMode");
            var outputMode = NormalizeOutputMode(rawOutputMode);
            var typeFilters = JsonHelpers.GetStringArray(parameters, "type")
                .Select(item => item.StartsWith("--type=", StringComparison.Ordinal) ? item["--type=".Length..] : item)
                .Select(item => item.StartsWith("-type=", StringComparison.Ordinal) ? item["-type=".Length..] : item)
                .Where(item => item.Length > 0)
                .ToArray();

            return new SshGrepOptions(
                pattern,
                include.Length > 0 ? include : null,
                string.IsNullOrWhiteSpace(exclude) ? null : exclude,
                typeFilters,
                caseSensitive,
                smartCase,
                JsonHelpers.GetBool(parameters, "literal", false),
                JsonHelpers.GetBool(parameters, "word", false),
                JsonHelpers.GetBool(parameters, "line", false),
                JsonHelpers.GetBool(parameters, "invertMatch", false),
                beforeContext,
                afterContext,
                maxResults,
                ClampLineLength(JsonHelpers.GetInt(parameters, "maxLineLength", DefaultGrepMaxLineLength)),
                ClampOptionalNumber(JsonHelpers.GetIntNullable(parameters, "maxDepth"), MaxGrepDepth),
                JsonHelpers.GetBool(parameters, "hidden", true),
                JsonHelpers.GetBool(parameters, "respectGitignore", true),
                JsonHelpers.GetBool(parameters, "followSymlinks", false),
                outputMode,
                JsonHelpers.GetString(parameters, "pathStyle") == "absolute" ? "absolute" : "relative",
                JsonHelpers.GetBool(parameters, "multiline", false));
        }

        private static string NormalizeOutputMode(string? value)
        {
            return value switch
            {
                "content" or "matches" => "matches",
                "files_with_matches" or "files_without_matches" or "count" => value,
                _ => "files_with_matches"
            };
        }
    }
}
