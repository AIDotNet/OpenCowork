using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed record GrepBackendResult(
    List<GrepMatchItem> Results,
    bool Truncated,
    bool TimedOut,
    string? LimitReason,
    string Engine,
    string[] Warnings);

internal static class FileGrepExternalEngines
{
    private const int GitRootTimeoutMs = 5_000;
    private const int GrepMaxFileSize = 10 * 1024 * 1024;

    private static readonly HashSet<string> DefaultIgnoredDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", ".svn", ".hg", ".bzr", "dist", "build", "out", ".next",
        ".nuxt", ".output", "coverage", ".nyc_output", ".cache", ".parcel-cache", "vendor",
        "target", "bin", "obj", ".gradle", "__pycache__", ".pytest_cache", ".mypy_cache",
        ".venv", "venv", "env"
    };

    public static async Task<GrepBackendResult?> TrySearchAsync(
        string searchRoot,
        string searchTarget,
        bool targetIsDirectory,
        GrepOptions options,
        long timeoutAt)
    {
        if (ShouldUseGitGrepFirst(options))
        {
            var gitFirst = await RunGitGrepSearchAsync(searchRoot, searchTarget, targetIsDirectory, options, timeoutAt);
            if (gitFirst is not null)
            {
                return gitFirst;
            }
        }

        var ripgrep = await RunRipgrepSearchAsync(searchRoot, searchTarget, targetIsDirectory, options, timeoutAt);
        if (ripgrep is not null)
        {
            return ripgrep;
        }

        if (!ShouldUseGitGrepFirst(options))
        {
            var git = await RunGitGrepSearchAsync(searchRoot, searchTarget, targetIsDirectory, options, timeoutAt);
            if (git is not null)
            {
                return git;
            }
        }

        return null;
    }

    private static bool ShouldUseGitGrepFirst(GrepOptions options)
    {
        return options.Cached ||
            options.Index ||
            options.NoIndex ||
            options.Textconv ||
            options.Pathspecs.Length > 0;
    }

    private static async Task<GrepBackendResult?> RunGitGrepSearchAsync(
        string searchRoot,
        string searchTarget,
        bool targetIsDirectory,
        GrepOptions options,
        long timeoutAt)
    {
        if (options.FollowSymlinks)
        {
            return null;
        }

        var repoRoot = options.NoIndex
            ? searchRoot
            : await FindGitWorktreeRootAsync(searchTarget, targetIsDirectory);
        if (string.IsNullOrWhiteSpace(repoRoot))
        {
            WorkerLog.Debug("grep git skipped reason=no-worktree");
            return null;
        }

        var pathspecs = BuildGitGrepPathspecs(repoRoot, searchTarget, targetIsDirectory, options);
        var collector = new GrepCollector(searchRoot, options);
        var pathMatcher = new GrepPathMatcher(searchRoot, options);
        var matcher = TryCreateMatcher(options);
        var warnings = matcher is null
            ? new[] { "Git grep context kind classification used a best-effort parser" }
            : Array.Empty<string>();

        var gitArgs = new List<string>
        {
            "grep",
            "--line-number",
            "--null",
            "--no-color",
            "--full-name"
        };
        if (options.NoIndex)
        {
            gitArgs.Add("--no-index");
        }
        else if (options.Index)
        {
            gitArgs.Add("--index");
        }
        if (options.Cached)
        {
            gitArgs.Add("--cached");
        }
        else if (!options.NoIndex && options.Untracked)
        {
            gitArgs.Add("--untracked");
        }
        if (options.ExcludeStandard && (options.Untracked || options.NoIndex))
        {
            gitArgs.Add("--exclude-standard");
        }

        AppendGitGrepModeArgs(gitArgs, options);
        AppendGitPatternExpression(gitArgs, options);
        gitArgs.Add("--");
        gitArgs.AddRange(pathspecs);

        using var process = CreateProcess("git", gitArgs, repoRoot);
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            WorkerLog.Debug($"grep git skipped reason=start-failed error={ex.GetType().Name}: {ex.Message}");
            return null;
        }

        var stdoutBuffer = string.Empty;
        var timedOut = false;
        var parseFailed = false;

        void AppendRecord(GrepMatchItem item)
        {
            if (!collector.TryAdd(item))
            {
                TryKill(process);
            }
        }

        string? ResolveAndFilterPath(string rawPath)
        {
            if (string.IsNullOrWhiteSpace(rawPath))
            {
                return null;
            }
            var absolutePath = Path.GetFullPath(Path.IsPathRooted(rawPath)
                ? rawPath
                : Path.Combine(repoRoot, rawPath));
            if (!ShouldKeepPath(absolutePath, searchRoot, options, pathMatcher))
            {
                return null;
            }
            return absolutePath;
        }

        void AppendFile(string rawPath)
        {
            var absolutePath = ResolveAndFilterPath(rawPath);
            if (absolutePath is null)
            {
                return;
            }
            AppendRecord(new GrepMatchItem(
                FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                null,
                null,
                null,
                null,
                null));
        }

        void AppendCount(string rawPath, string rawCount)
        {
            if (!int.TryParse(rawCount.Trim(), out var count) || count <= 0)
            {
                return;
            }
            var absolutePath = ResolveAndFilterPath(rawPath);
            if (absolutePath is null)
            {
                return;
            }
            AppendRecord(new GrepMatchItem(
                FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                null,
                null,
                null,
                null,
                count));
        }

        void AppendMatch(string rawPath, string rawLine, string text, string? rawColumn)
        {
            if (!int.TryParse(rawLine, out var line) || line <= 0)
            {
                return;
            }
            var absolutePath = ResolveAndFilterPath(rawPath);
            if (absolutePath is null)
            {
                return;
            }
            var hasColumn = int.TryParse(rawColumn, out var column) && column > 0;
            var isMatch = hasColumn ||
                options.OnlyMatching ||
                matcher is null ||
                (options.InvertMatch ? !matcher.TestLine(text) : matcher.TestLine(text));
            AppendRecord(new GrepMatchItem(
                FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                line,
                hasColumn ? column : null,
                NormalizeGrepLine(text, options.MaxLineLength),
                isMatch ? "match" : "context",
                null));
        }

        void FlushStdout(bool flush)
        {
            stdoutBuffer = StripGitContextSeparator(stdoutBuffer);
            if (options.OutputMode is "files_with_matches" or "files_without_matches")
            {
                var separatorIndex = stdoutBuffer.IndexOf('\0', StringComparison.Ordinal);
                while (separatorIndex != -1 || (flush && stdoutBuffer.Length > 0))
                {
                    var endIndex = separatorIndex == -1 ? stdoutBuffer.Length : separatorIndex;
                    var rawPath = stdoutBuffer[..endIndex];
                    stdoutBuffer = stdoutBuffer[Math.Min(endIndex + 1, stdoutBuffer.Length)..];
                    AppendFile(rawPath);
                    if (process.HasExited)
                    {
                        return;
                    }
                    separatorIndex = stdoutBuffer.IndexOf('\0', StringComparison.Ordinal);
                }
                return;
            }

            if (options.OutputMode == "count")
            {
                var pathEnd = stdoutBuffer.IndexOf('\0', StringComparison.Ordinal);
                var lineEnd = pathEnd == -1 ? -1 : stdoutBuffer.IndexOf('\n', pathEnd + 1);
                while (pathEnd != -1 && (lineEnd != -1 || (flush && stdoutBuffer.Length > pathEnd)))
                {
                    var endIndex = lineEnd == -1 ? stdoutBuffer.Length : lineEnd;
                    AppendCount(stdoutBuffer[..pathEnd], stdoutBuffer[(pathEnd + 1)..endIndex]);
                    stdoutBuffer = stdoutBuffer[Math.Min(endIndex + 1, stdoutBuffer.Length)..];
                    if (process.HasExited)
                    {
                        return;
                    }
                    pathEnd = stdoutBuffer.IndexOf('\0', StringComparison.Ordinal);
                    lineEnd = pathEnd == -1 ? -1 : stdoutBuffer.IndexOf('\n', pathEnd + 1);
                }
                return;
            }

            var matchPathEnd = stdoutBuffer.IndexOf('\0', StringComparison.Ordinal);
            var matchLineEnd = matchPathEnd == -1 ? -1 : stdoutBuffer.IndexOf('\0', matchPathEnd + 1);
            var newlineEnd = matchLineEnd == -1 ? -1 : stdoutBuffer.IndexOf('\n', matchLineEnd + 1);
            while (matchPathEnd != -1 &&
                matchLineEnd != -1 &&
                (newlineEnd != -1 || (flush && stdoutBuffer.Length > matchLineEnd)))
            {
                var endIndex = newlineEnd == -1 ? stdoutBuffer.Length : newlineEnd;
                var columnEnd = stdoutBuffer.IndexOf('\0', matchLineEnd + 1);
                var hasColumn = columnEnd != -1 && columnEnd < endIndex;
                AppendMatch(
                    stdoutBuffer[..matchPathEnd],
                    stdoutBuffer[(matchPathEnd + 1)..matchLineEnd],
                    stdoutBuffer[(hasColumn ? columnEnd + 1 : matchLineEnd + 1)..endIndex].TrimEnd('\r'),
                    hasColumn ? stdoutBuffer[(matchLineEnd + 1)..columnEnd] : null);
                stdoutBuffer = stdoutBuffer[Math.Min(endIndex + 1, stdoutBuffer.Length)..];
                if (process.HasExited)
                {
                    return;
                }
                stdoutBuffer = StripGitContextSeparator(stdoutBuffer);
                matchPathEnd = stdoutBuffer.IndexOf('\0', StringComparison.Ordinal);
                matchLineEnd = matchPathEnd == -1 ? -1 : stdoutBuffer.IndexOf('\0', matchPathEnd + 1);
                newlineEnd = matchLineEnd == -1 ? -1 : stdoutBuffer.IndexOf('\n', matchLineEnd + 1);
            }
        }

        var consumeStdout = Task.Run(async () =>
        {
            var buffer = new char[8192];
            while (true)
            {
                var read = await process.StandardOutput.ReadAsync(buffer.AsMemory(0, buffer.Length));
                if (read <= 0)
                {
                    break;
                }
                stdoutBuffer += new string(buffer, 0, read);
                FlushStdout(flush: false);
            }
        });
        var consumeStderr = process.StandardError.ReadToEndAsync();
        var waitTask = process.WaitForExitAsync();
        var timeoutTask = Task.Delay(RemainingTimeoutMs(timeoutAt));
        if (await Task.WhenAny(waitTask, timeoutTask) == timeoutTask)
        {
            timedOut = true;
            TryKill(process);
        }

        try
        {
            await waitTask;
            await consumeStdout;
            _ = await consumeStderr;
            FlushStdout(flush: true);
        }
        catch
        {
            parseFailed = true;
        }

        if (parseFailed)
        {
            return null;
        }

        if (timedOut || collector.Truncated)
        {
            return new GrepBackendResult(
                collector.Results,
                true,
                timedOut,
                timedOut ? "timeout" : collector.LimitReason,
                "git_grep",
                warnings);
        }

        if (process.ExitCode is 0 or 1)
        {
            return new GrepBackendResult(collector.Results, false, false, null, "git_grep", warnings);
        }

        var stderr = await consumeStderr;
        WorkerLog.Debug($"grep git failed exitCode={process.ExitCode} stderr={TruncateLog(stderr)}");
        return null;
    }

    private static async Task<GrepBackendResult?> RunRipgrepSearchAsync(
        string searchRoot,
        string searchTarget,
        bool targetIsDirectory,
        GrepOptions options,
        long timeoutAt)
    {
        if (options.PatternMode == "basic" ||
            options.NotPatterns.Length > 0 ||
            options.PatternOperator != "or" ||
            options.AllMatch ||
            options.Pathspecs.Length > 0 ||
            options.Cached ||
            options.Index ||
            options.Textconv)
        {
            return null;
        }

        var collector = new GrepCollector(searchRoot, options);
        var rgArgs = new List<string>
        {
            "--line-number",
            "--color",
            "never",
            "--no-messages",
            "--max-filesize",
            $"{GrepMaxFileSize / (1024 * 1024)}M"
        };

        if (options.OutputMode == "matches")
        {
            rgArgs.Insert(0, "--json");
            if (options.BeforeContext > 0)
            {
                rgArgs.AddRange(["--before-context", options.BeforeContext.ToString()]);
            }
            if (options.AfterContext > 0)
            {
                rgArgs.AddRange(["--after-context", options.AfterContext.ToString()]);
            }
        }
        else if (options.OutputMode == "files_with_matches")
        {
            rgArgs.Add("--files-with-matches");
        }
        else if (options.OutputMode == "files_without_matches")
        {
            rgArgs.Add("--files-without-match");
        }
        else
        {
            rgArgs.Add("--count");
        }

        if (options.PatternMode == "perl")
        {
            rgArgs.Add("--pcre2");
        }
        if (options.SmartCase)
        {
            rgArgs.Add("--smart-case");
        }
        else if (!options.CaseSensitive)
        {
            rgArgs.Add("--ignore-case");
        }
        if (options.Literal)
        {
            rgArgs.Add("--fixed-strings");
        }
        if (options.Word)
        {
            rgArgs.Add("--word-regexp");
        }
        if (options.Line)
        {
            rgArgs.Add("--line-regexp");
        }
        if (options.InvertMatch)
        {
            rgArgs.Add("--invert-match");
        }
        if (options.OnlyMatching)
        {
            rgArgs.Add("--only-matching");
        }
        if (options.Column)
        {
            rgArgs.Add("--column");
        }
        if (options.Hidden)
        {
            rgArgs.Add("--hidden");
        }
        if (options.RespectGitignore)
        {
            rgArgs.Add("--no-require-git");
        }
        else
        {
            rgArgs.Add("--no-ignore");
        }
        if (options.FollowSymlinks)
        {
            rgArgs.Add("--follow");
        }
        if (options.MaxDepth is { } maxDepth)
        {
            rgArgs.AddRange(["--max-depth", maxDepth.ToString()]);
        }
        if (options.MaxCount is { } maxCount)
        {
            rgArgs.AddRange(["--max-count", maxCount.ToString()]);
        }
        if (options.Threads is { } threads)
        {
            rgArgs.AddRange(["--threads", threads.ToString()]);
        }
        if (options.Text)
        {
            rgArgs.Add("--text");
        }
        if (options.Multiline)
        {
            rgArgs.AddRange(["--multiline", "--multiline-dotall"]);
        }

        foreach (var typeFilter in options.TypeFilters)
        {
            rgArgs.AddRange(["--type", typeFilter]);
        }
        foreach (var directory in DefaultIgnoredDirs)
        {
            rgArgs.AddRange(["--glob", $"!{directory}/**"]);
            rgArgs.AddRange(["--glob", $"!**/{directory}/**"]);
        }
        foreach (var includePattern in options.IncludePatterns.Concat(options.PathspecIncludePatterns))
        {
            rgArgs.AddRange(["--glob", NormalizeRipgrepGlob(includePattern)]);
        }
        foreach (var excludePattern in options.ExcludePatterns.Concat(options.PathspecExcludePatterns))
        {
            rgArgs.AddRange(["--glob", "!" + NormalizeRipgrepGlob(excludePattern)]);
        }

        var patterns = options.Patterns.Length > 0 ? options.Patterns : [options.Pattern];
        foreach (var pattern in patterns)
        {
            rgArgs.AddRange(["--regexp", pattern]);
        }
        rgArgs.Add("--");
        rgArgs.Add(targetIsDirectory ? "." : Path.GetFileName(searchTarget));

        using var process = CreateProcess("rg", rgArgs, searchRoot);
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            WorkerLog.Debug($"grep rg skipped reason=start-failed error={ex.GetType().Name}: {ex.Message}");
            return null;
        }

        var timedOut = false;
        var parseFailed = false;

        void AppendRecord(GrepMatchItem item)
        {
            if (!collector.TryAdd(item))
            {
                TryKill(process);
            }
        }

        void AppendFile(string rawPath)
        {
            var absolutePath = Path.GetFullPath(Path.IsPathRooted(rawPath)
                ? rawPath
                : Path.Combine(searchRoot, rawPath));
            if (IncludesDefaultIgnoredDir(absolutePath, searchRoot))
            {
                return;
            }
            AppendRecord(new GrepMatchItem(
                FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                null,
                null,
                null,
                null,
                null));
        }

        void AppendCount(string rawLine)
        {
            var line = rawLine.TrimEnd();
            var separator = line.LastIndexOf(':');
            var rawPath = separator >= 0 ? line[..separator] : Path.GetFileName(searchTarget);
            var rawCount = separator >= 0 ? line[(separator + 1)..] : line;
            if (!int.TryParse(rawCount, out var count) || count <= 0)
            {
                return;
            }
            var absolutePath = Path.GetFullPath(Path.IsPathRooted(rawPath)
                ? rawPath
                : Path.Combine(searchRoot, rawPath));
            if (IncludesDefaultIgnoredDir(absolutePath, searchRoot))
            {
                return;
            }
            AppendRecord(new GrepMatchItem(
                FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                null,
                null,
                null,
                null,
                count));
        }

        void ProcessLine(string rawLine)
        {
            if (string.IsNullOrWhiteSpace(rawLine))
            {
                return;
            }

            if (options.OutputMode != "matches")
            {
                if (options.OutputMode is "files_with_matches" or "files_without_matches")
                {
                    AppendFile(rawLine.TrimEnd());
                }
                else
                {
                    AppendCount(rawLine);
                }
                return;
            }

            using var document = JsonDocument.Parse(rawLine);
            var root = document.RootElement;
            var type = ReadString(root, "type");
            if (type is not ("match" or "context") ||
                !root.TryGetProperty("data", out var data) ||
                data.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            var rawPath = ReadNestedString(data, "path", "text");
            var lineNumber = ReadInt(data, "line_number");
            var text = ReadNestedString(data, "lines", "text") ?? string.Empty;
            if (string.IsNullOrWhiteSpace(rawPath) || lineNumber is null)
            {
                return;
            }

            var absolutePath = Path.GetFullPath(Path.IsPathRooted(rawPath)
                ? rawPath
                : Path.Combine(searchRoot, rawPath));
            if (IncludesDefaultIgnoredDir(absolutePath, searchRoot))
            {
                return;
            }

            var submatches = data.TryGetProperty("submatches", out var submatchArray) &&
                submatchArray.ValueKind == JsonValueKind.Array
                ? submatchArray.EnumerateArray().ToArray()
                : [];

            if (options.OnlyMatching && type == "match" && submatches.Length > 0)
            {
                foreach (var submatch in submatches)
                {
                    var matchText = ReadNestedString(submatch, "match", "text");
                    if (matchText is null)
                    {
                        continue;
                    }
                    var column = options.Column ? ReadInt(submatch, "start") + 1 : null;
                    AppendRecord(new GrepMatchItem(
                        FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                        lineNumber,
                        column,
                        NormalizeGrepLine(matchText, options.MaxLineLength),
                        "match",
                        null));
                    if (process.HasExited)
                    {
                        break;
                    }
                }
                return;
            }

            var firstColumn = type == "match" && submatches.Length > 0
                ? ReadInt(submatches[0], "start")
                : null;
            AppendRecord(new GrepMatchItem(
                FormatResultPath(searchRoot, absolutePath, options.PathStyle),
                lineNumber,
                options.Column && firstColumn is not null ? firstColumn + 1 : null,
                NormalizeGrepLine(text, options.MaxLineLength),
                type,
                null));
        }

        var consumeStdout = Task.Run(async () =>
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                try
                {
                    ProcessLine(line);
                }
                catch
                {
                    parseFailed = true;
                    TryKill(process);
                    break;
                }
            }
        });
        var consumeStderr = process.StandardError.ReadToEndAsync();
        var waitTask = process.WaitForExitAsync();
        var timeoutTask = Task.Delay(RemainingTimeoutMs(timeoutAt));
        if (await Task.WhenAny(waitTask, timeoutTask) == timeoutTask)
        {
            timedOut = true;
            TryKill(process);
        }

        try
        {
            await waitTask;
            await consumeStdout;
            await consumeStderr;
        }
        catch
        {
            parseFailed = true;
        }

        if (parseFailed)
        {
            return null;
        }

        if (timedOut || collector.Truncated)
        {
            return new GrepBackendResult(
                collector.Results,
                true,
                timedOut,
                timedOut ? "timeout" : collector.LimitReason,
                "ripgrep",
                []);
        }

        if (process.ExitCode is 0 or 1)
        {
            return new GrepBackendResult(collector.Results, false, false, null, "ripgrep", []);
        }

        WorkerLog.Debug($"grep rg failed exitCode={process.ExitCode}");
        return null;
    }

    private static async Task<string?> FindGitWorktreeRootAsync(string searchTarget, bool targetIsDirectory)
    {
        var cwd = targetIsDirectory ? searchTarget : Path.GetDirectoryName(searchTarget);
        if (string.IsNullOrWhiteSpace(cwd))
        {
            return null;
        }

        var result = await RunProcessTextAsync("git", ["rev-parse", "--show-toplevel"], cwd, GitRootTimeoutMs);
        if (result is null || result.TimedOut || result.Code != 0)
        {
            WorkerLog.Debug(
                $"grep git root failed code={result?.Code.ToString() ?? "null"} timedOut={result?.TimedOut.ToString().ToLowerInvariant() ?? "false"}");
            return null;
        }

        var root = result.Stdout.Trim().Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
        if (string.IsNullOrWhiteSpace(root))
        {
            return null;
        }

        var resolvedRoot = Path.GetFullPath(root);
        return IsWithinRoot(resolvedRoot, searchTarget) ? resolvedRoot : null;
    }

    private static async Task<ProcessTextResult?> RunProcessTextAsync(
        string command,
        IEnumerable<string> args,
        string cwd,
        int timeoutMs)
    {
        using var process = CreateProcess(command, args, cwd);
        try
        {
            process.Start();
        }
        catch
        {
            return null;
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var waitTask = process.WaitForExitAsync();
        var timedOut = false;
        if (await Task.WhenAny(waitTask, Task.Delay(timeoutMs)) != waitTask)
        {
            timedOut = true;
            TryKill(process);
        }

        try
        {
            await waitTask;
        }
        catch
        {
            return null;
        }

        var stdout = await stdoutTask;
        _ = await stderrTask;
        return new ProcessTextResult(process.ExitCode, stdout, timedOut);
    }

    private static List<string> BuildGitGrepPathspecs(
        string repoRoot,
        string searchTarget,
        bool targetIsDirectory,
        GrepOptions options)
    {
        var relativeTarget = NormalizeGitPathspecPath(
            Path.GetRelativePath(NormalizeComparablePath(repoRoot), NormalizeComparablePath(searchTarget)));
        var targetPathspec = string.IsNullOrWhiteSpace(relativeTarget) ? "." : relativeTarget;
        var includePatterns = options.IncludePatterns.Concat(options.PathspecIncludePatterns).ToArray();
        var excludePatterns = options.ExcludePatterns.Concat(options.PathspecExcludePatterns).ToArray();
        var explicitPathspecs = options.Pathspecs
            .Select(pathspec => NormalizeGitPathspecArgument(pathspec))
            .Where(static pathspec => !string.IsNullOrWhiteSpace(pathspec))
            .Select(static pathspec => pathspec!)
            .ToArray();

        var pathspecs = targetIsDirectory && includePatterns.Length > 0
            ? includePatterns.Select(pattern => ":(glob)" + JoinGitPathspecGlob(targetPathspec, pattern)).ToList()
            : [targetPathspec];

        pathspecs.AddRange(explicitPathspecs);

        foreach (var pattern in excludePatterns)
        {
            pathspecs.Add(":(exclude,glob)" + JoinGitPathspecGlob(targetPathspec, pattern));
        }

        foreach (var pathspec in options.Pathspecs)
        {
            var parsed = SplitGitPathspecMagic(pathspec);
            if (!parsed.Exclude)
            {
                continue;
            }
            var normalized = NormalizeGitPathspecArgument(pathspec, forceExclude: true);
            if (!string.IsNullOrWhiteSpace(normalized))
            {
                pathspecs.Add(normalized);
            }
        }

        return pathspecs;
    }

    private static void AppendGitGrepModeArgs(List<string> gitArgs, GrepOptions options)
    {
        var patternMode = options.Line && options.PatternMode == "fixed" ? "perl" : options.PatternMode;
        if (patternMode == "fixed")
        {
            gitArgs.Add("--fixed-strings");
        }
        if (patternMode == "basic")
        {
            gitArgs.Add("--basic-regexp");
        }
        if (patternMode == "extended")
        {
            gitArgs.Add("--extended-regexp");
        }
        if (patternMode == "perl")
        {
            gitArgs.Add("--perl-regexp");
        }

        if (options.OutputMode == "files_with_matches")
        {
            gitArgs.Add("--files-with-matches");
        }
        else if (options.OutputMode == "files_without_matches")
        {
            gitArgs.Add("--files-without-match");
        }
        else if (options.OutputMode == "count")
        {
            gitArgs.Add("--count");
        }
        else
        {
            if (options.OnlyMatching)
            {
                gitArgs.Add("--only-matching");
            }
            if (options.BeforeContext > 0)
            {
                gitArgs.AddRange(["--before-context", options.BeforeContext.ToString()]);
            }
            if (options.AfterContext > 0)
            {
                gitArgs.AddRange(["--after-context", options.AfterContext.ToString()]);
            }
        }

        if (!options.CaseSensitive)
        {
            gitArgs.Add("--ignore-case");
        }
        if (options.Word)
        {
            gitArgs.Add("--word-regexp");
        }
        if (options.InvertMatch)
        {
            gitArgs.Add("--invert-match");
        }
        if (options.Column)
        {
            gitArgs.Add("--column");
        }
        if (options.MaxCount is { } maxCount)
        {
            gitArgs.AddRange(["--max-count", maxCount.ToString()]);
        }
        if (options.MaxDepth is { } maxDepth)
        {
            gitArgs.AddRange(["--max-depth", maxDepth.ToString()]);
        }
        if (options.Threads is { } threads)
        {
            gitArgs.AddRange(["--threads", threads.ToString()]);
        }
        if (options.Text)
        {
            gitArgs.Add("--text");
        }
        else
        {
            gitArgs.Add("-I");
        }
        if (options.Textconv)
        {
            gitArgs.Add("--textconv");
        }
    }

    private static void AppendGitPatternExpression(List<string> gitArgs, GrepOptions options)
    {
        if (options.AllMatch)
        {
            gitArgs.Add("--all-match");
        }

        string NormalizePattern(string pattern)
        {
            if (!options.Line)
            {
                return pattern;
            }
            if (options.PatternMode == "fixed")
            {
                return "^" + Regex.Escape(pattern) + "$";
            }
            if (options.PatternMode == "basic")
            {
                return "^" + pattern + "$";
            }
            return "^(?:" + pattern + ")$";
        }

        void AppendPositives(List<string> target)
        {
            for (var index = 0; index < options.Patterns.Length; index++)
            {
                if (index > 0)
                {
                    target.Add(options.PatternOperator == "and" ? "--and" : "--or");
                }
                target.Add("-e");
                target.Add(NormalizePattern(options.Patterns[index]));
            }
        }

        var expression = new List<string>();
        if (options.Patterns.Length > 0)
        {
            if (options.Patterns.Length > 1 && options.NotPatterns.Length > 0)
            {
                expression.Add("(");
                AppendPositives(expression);
                expression.Add(")");
            }
            else
            {
                AppendPositives(expression);
            }
        }

        foreach (var pattern in options.NotPatterns)
        {
            if (expression.Count > 0)
            {
                expression.Add("--and");
            }
            expression.Add("--not");
            expression.Add("-e");
            expression.Add(NormalizePattern(pattern));
        }

        if (expression.Count == 0)
        {
            expression.Add("-e");
            expression.Add(NormalizePattern(options.Pattern));
        }
        gitArgs.AddRange(expression);
    }

    private static bool ShouldKeepPath(
        string absolutePath,
        string searchRoot,
        GrepOptions options,
        GrepPathMatcher pathMatcher)
    {
        if (!IsWithinRoot(searchRoot, absolutePath))
        {
            return false;
        }
        if (!options.Hidden && HasHiddenSegment(searchRoot, absolutePath))
        {
            return false;
        }
        if (options.MaxDepth is not null && GetRelativeDepth(searchRoot, absolutePath) > options.MaxDepth.Value)
        {
            return false;
        }
        return pathMatcher.ShouldKeep(absolutePath);
    }

    private static GrepMatcher? TryCreateMatcher(GrepOptions options)
    {
        try
        {
            return GrepMatcher.Create(options);
        }
        catch
        {
            return null;
        }
    }

    private static Process CreateProcess(string command, IEnumerable<string> args, string cwd)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = command,
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true
        };
        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }
        return new Process { StartInfo = startInfo };
    }

    private static int RemainingTimeoutMs(long timeoutAt)
    {
        var remainingTicks = timeoutAt - Stopwatch.GetTimestamp();
        if (remainingTicks <= 0)
        {
            return 1;
        }
        var remainingMs = (int)Math.Ceiling(remainingTicks * 1000d / Stopwatch.Frequency);
        return Math.Max(1, remainingMs);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Process may have exited naturally.
        }
    }

    private static string NormalizeGitPathspecPath(string value)
    {
        return NormalizeSeparators(value).TrimEnd('/');
    }

    private static (string Pattern, bool Exclude, bool HasMagic) SplitGitPathspecMagic(string pathspec)
    {
        var normalized = NormalizeGitPathspecPath(pathspec.Trim());
        if (normalized.Length == 0)
        {
            return (string.Empty, false, false);
        }
        if (normalized.StartsWith(":!", StringComparison.Ordinal) ||
            normalized.StartsWith(":^", StringComparison.Ordinal))
        {
            return (normalized[2..], true, true);
        }
        if (!normalized.StartsWith(":(", StringComparison.Ordinal))
        {
            return (normalized, false, false);
        }

        var closeIndex = normalized.IndexOf(')', StringComparison.Ordinal);
        if (closeIndex == -1)
        {
            return (normalized, false, true);
        }
        var magic = normalized[2..closeIndex]
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return (normalized[(closeIndex + 1)..], magic.Contains("exclude", StringComparer.Ordinal), true);
    }

    private static string? NormalizeGitPathspecArgument(string pathspec, bool forceExclude = false)
    {
        var trimmed = NormalizeGitPathspecPath(pathspec.Trim());
        if (trimmed.Length == 0)
        {
            return null;
        }
        var parsed = SplitGitPathspecMagic(trimmed);
        var exclude = forceExclude || parsed.Exclude;
        if (trimmed.StartsWith(":(", StringComparison.Ordinal))
        {
            if (!exclude || parsed.Exclude)
            {
                return trimmed;
            }
            return ":(exclude)" + parsed.Pattern;
        }
        if (trimmed.StartsWith(":!", StringComparison.Ordinal) ||
            trimmed.StartsWith(":^", StringComparison.Ordinal))
        {
            return ":(exclude)" + parsed.Pattern;
        }
        return exclude ? ":(exclude,glob)" + trimmed : trimmed;
    }

    private static string NormalizeGitPathspecGlob(string pattern)
    {
        var normalized = NormalizeSeparators(pattern).Trim();
        if (normalized.StartsWith("./", StringComparison.Ordinal))
        {
            normalized = normalized[2..];
        }
        if (!normalized.Contains("*", StringComparison.Ordinal) &&
            !normalized.Contains("?", StringComparison.Ordinal) &&
            normalized.StartsWith(".", StringComparison.Ordinal))
        {
            normalized = "*" + normalized;
        }
        return normalized;
    }

    private static string JoinGitPathspecGlob(string basePath, string globPattern)
    {
        var normalizedBase = NormalizeGitPathspecPath(basePath);
        var normalizedPattern = NormalizeGitPathspecGlob(globPattern);
        var pattern = normalizedPattern.StartsWith("**/", StringComparison.Ordinal)
            ? normalizedPattern[3..]
            : normalizedPattern;

        if (string.IsNullOrWhiteSpace(normalizedBase) || normalizedBase == ".")
        {
            return pattern.Contains("/", StringComparison.Ordinal) ? pattern : "**/" + pattern;
        }

        return pattern.Contains("/", StringComparison.Ordinal) ? normalizedBase + "/" + pattern : normalizedBase + "/**/" + pattern;
    }

    private static string NormalizeRipgrepGlob(string pattern)
    {
        var normalized = NormalizeSeparators(pattern);
        if (normalized.StartsWith("./", StringComparison.Ordinal))
        {
            normalized = normalized[2..];
        }
        if (normalized.StartsWith("**/", StringComparison.Ordinal))
        {
            normalized = normalized[3..];
        }
        if (!normalized.Contains("*", StringComparison.Ordinal) &&
            !normalized.Contains("?", StringComparison.Ordinal) &&
            normalized.StartsWith(".", StringComparison.Ordinal))
        {
            return "*" + normalized;
        }
        return normalized;
    }

    private static string StripGitContextSeparator(string buffer)
    {
        while (buffer.StartsWith("--\n", StringComparison.Ordinal) ||
            buffer.StartsWith("--\r\n", StringComparison.Ordinal))
        {
            buffer = buffer.StartsWith("--\r\n", StringComparison.Ordinal)
                ? buffer[4..]
                : buffer[3..];
        }
        return buffer;
    }

    private static bool IsWithinRoot(string root, string filePath)
    {
        var relative = Path.GetRelativePath(NormalizeComparablePath(root), NormalizeComparablePath(filePath));
        return string.IsNullOrEmpty(relative) ||
            (!relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative));
    }

    private static int GetRelativeDepth(string root, string filePath)
    {
        var relative = NormalizeSeparators(Path.GetRelativePath(NormalizeComparablePath(root), NormalizeComparablePath(filePath)));
        if (string.IsNullOrEmpty(relative) || relative == ".")
        {
            return 0;
        }
        return Math.Max(0, relative.Split('/', StringSplitOptions.RemoveEmptyEntries).Length - 1);
    }

    private static bool HasHiddenSegment(string root, string filePath)
    {
        var relative = NormalizeSeparators(Path.GetRelativePath(NormalizeComparablePath(root), NormalizeComparablePath(filePath)));
        return relative.Split('/').Any(static part => part.StartsWith('.') && part != ".");
    }

    private static bool IncludesDefaultIgnoredDir(string filePath, string searchRoot)
    {
        var relative = NormalizeSeparators(Path.GetRelativePath(NormalizeComparablePath(searchRoot), NormalizeComparablePath(filePath)));
        if (string.IsNullOrEmpty(relative) ||
            relative.StartsWith("..", StringComparison.Ordinal) ||
            Path.IsPathRooted(relative))
        {
            return false;
        }
        return relative.Split('/').Any(part => DefaultIgnoredDirs.Contains(part));
    }

    private static string FormatResultPath(string searchRoot, string filePath, string pathStyle)
    {
        var absolute = Path.GetFullPath(filePath);
        return pathStyle == "absolute"
            ? absolute
            : NormalizeSeparators(Path.GetRelativePath(NormalizeComparablePath(searchRoot), NormalizeComparablePath(absolute)));
    }

    private static string NormalizeGrepLine(string text, int maxLineLength)
    {
        var normalized = text.Trim();
        return normalized.Length <= maxLineLength
            ? normalized
            : normalized[..Math.Max(0, maxLineLength - 3)] + "...";
    }

    private static string NormalizeSeparators(string value)
    {
        return value.Replace('\\', '/');
    }

    private static string NormalizeComparablePath(string value)
    {
        var fullPath = Path.GetFullPath(value);
        if (OperatingSystem.IsMacOS() &&
            fullPath.StartsWith("/private/", StringComparison.Ordinal))
        {
            return fullPath["/private".Length..];
        }
        return fullPath;
    }

    private static string TruncateLog(string value)
    {
        var normalized = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return normalized.Length <= 300 ? normalized : normalized[..300] + "...";
    }

    private static string? ReadString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static string? ReadNestedString(JsonElement element, string objectName, string stringName)
    {
        return element.TryGetProperty(objectName, out var nested) && nested.ValueKind == JsonValueKind.Object
            ? ReadString(nested, stringName)
            : null;
    }

    private static int? ReadInt(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.TryGetInt32(out var number)
            ? number
            : null;
    }

    private sealed record ProcessTextResult(int Code, string Stdout, bool TimedOut);
}
