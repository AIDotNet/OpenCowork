using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class FileTools
{
    private const int DefaultTextLineReadLimit = 1_000;
    private const int MaxListDirItems = 1_000;
    private const int MaxGlobMatches = 1_000;
    private const int FileSearchMaxResults = 20;
    private const int GrepDefaultMaxResults = 100;
    private const int GrepMaxResults = 200;
    private const int GrepMaxFileSize = 10 * 1024 * 1024;
    private const int GrepTimeoutMs = 30_000;
    private const int GrepDefaultMaxLineLength = 160;
    private const int GrepMaxLineLength = 1000;
    private const int GrepDefaultMaxScanLineLength = 16 * 1024;
    private const int GrepMaxScanLineLength = 64 * 1024;
    private const int GrepDefaultMaxOutputBytes = 8 * 1024;
    private const int GrepMaxOutputBytes = 64 * 1024;
    private const long DefaultMaxFileReadBytes = 10 * 1024 * 1024;
    private const long DefaultMaxImageReadBytes = 10 * 1024 * 1024;

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".heic", ".heif"
    };

    private static readonly Dictionary<string, string> ImageMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".bmp"] = "image/bmp",
        [".webp"] = "image/webp",
        [".svg"] = "image/svg+xml",
        [".ico"] = "image/x-icon",
        [".tiff"] = "image/tiff",
        [".heic"] = "image/heic",
        [".heif"] = "image/heif"
    };

    private static readonly HashSet<string> TextReadBlockedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".heic", ".heif",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".gz", ".tgz",
        ".rar", ".7z", ".tar"
    };

    private static readonly HashSet<string> GrepBinaryExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".mp4", ".avi", ".mov",
        ".mkv", ".mp3", ".wav", ".flac", ".zip", ".tar", ".gz", ".rar", ".7z", ".exe",
        ".dll", ".so", ".dylib", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".woff", ".woff2", ".ttf", ".eot", ".otf", ".db", ".sqlite", ".sqlite3"
    };

    private static readonly HashSet<string> DefaultIgnoredDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", ".svn", ".hg", ".bzr", "dist", "build", "out", ".next",
        ".nuxt", ".output", "coverage", ".nyc_output", ".cache", ".parcel-cache", "vendor",
        "target", "bin", "obj", ".gradle", "__pycache__", ".pytest_cache", ".mypy_cache",
        ".venv", "venv", "env"
    };

    public static async Task<WorkerResponse> ReadFileAsync(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            var extension = Path.GetExtension(filePath);
            var maxFileReadBytes = JsonHelpers.GetLong(parameters, "maxFileReadBytes", DefaultMaxFileReadBytes);
            var maxImageReadBytes = JsonHelpers.GetLong(parameters, "maxImageReadBytes", DefaultMaxImageReadBytes);

            if (ImageExtensions.Contains(extension))
            {
                EnsureFileSize(filePath, maxImageReadBytes);
                var bytes = await File.ReadAllBytesAsync(filePath);
                var mediaType = ImageMimeTypes.GetValueOrDefault(extension, "application/octet-stream");
                return WorkerResponse.Json(
                    new ImageReadResult("image", mediaType, Convert.ToBase64String(bytes)),
                    WorkerJsonContext.Default.ImageReadResult);
            }

            EnsureFileSize(filePath, maxFileReadBytes);
            var content = await File.ReadAllTextAsync(filePath, Encoding.UTF8);

            if (JsonHelpers.GetBool(parameters, "raw", true))
            {
                return WorkerResponse.String(content);
            }

            var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 1) - 1);
            var count = Math.Max(0, Math.Min(JsonHelpers.GetInt(parameters, "limit", 2_000), 2_000));
            var normalized = content.Replace("\r\n", "\n").Replace('\r', '\n');
            var lines = normalized.Split('\n');
            var end = Math.Min(offset + count, lines.Length);
            var width = Math.Max(6, end.ToString().Length);
            var builder = new StringBuilder();
            for (var i = offset; i < end; i++)
            {
                if (builder.Length > 0)
                {
                    builder.Append('\n');
                }
                builder.Append((i + 1).ToString().PadLeft(width));
                builder.Append('\t');
                builder.Append(lines[i]);
            }
            return WorkerResponse.String(builder.ToString());
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static async Task<WorkerResponse> ReadBinaryFileAsync(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            var maxFileReadBytes = JsonHelpers.GetLong(parameters, "maxFileReadBytes", DefaultMaxFileReadBytes);
            EnsureFileSize(filePath, maxFileReadBytes);
            var bytes = await File.ReadAllBytesAsync(filePath);
            return WorkerResponse.Json(
                new BinaryReadResult(Convert.ToBase64String(bytes)),
                WorkerJsonContext.Default.BinaryReadResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static async Task<WorkerResponse> WriteFileAsync(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            var content = JsonHelpers.GetString(parameters, "content") ??
                throw new InvalidOperationException("Missing content");
            var beforeExists = File.Exists(filePath);
            var directory = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            await File.WriteAllTextAsync(filePath, content, Encoding.UTF8);
            return WorkerResponse.Json(
                new FileWriteResult(true, beforeExists ? "modify" : "create", null),
                WorkerJsonContext.Default.FileWriteResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new FileWriteResult(false, string.Empty, ex.Message),
                WorkerJsonContext.Default.FileWriteResult);
        }
    }

    public static async Task<WorkerResponse> WriteBinaryFileAsync(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            var data = JsonHelpers.GetString(parameters, "data") ??
                throw new InvalidOperationException("Missing data");
            var directory = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            await File.WriteAllBytesAsync(filePath, Convert.FromBase64String(data));
            return FileMutation(success: true, error: null);
        }
        catch (Exception ex)
        {
            return FileMutation(success: false, error: ex.Message);
        }
    }

    public static WorkerResponse StatPath(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            if (!File.Exists(filePath) && !Directory.Exists(filePath))
            {
                return WorkerResponse.Json(
                    new FileStatResult(false, null, null, null, null),
                    WorkerJsonContext.Default.FileStatResult);
            }

            var attributes = File.GetAttributes(filePath);
            var isDirectory = attributes.HasFlag(FileAttributes.Directory);
            var type = File.Exists(filePath)
                ? "file"
                : isDirectory
                    ? "directory"
                    : "other";
            long size = 0;
            DateTime lastWriteUtc;
            if (isDirectory)
            {
                var info = new DirectoryInfo(filePath);
                lastWriteUtc = info.LastWriteTimeUtc;
            }
            else
            {
                var info = new FileInfo(filePath);
                size = info.Length;
                lastWriteUtc = info.LastWriteTimeUtc;
            }

            return WorkerResponse.Json(
                new FileStatResult(true, type, size, new DateTimeOffset(lastWriteUtc).ToUnixTimeMilliseconds(), null),
                WorkerJsonContext.Default.FileStatResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new FileStatResult(false, null, null, null, ex.Message),
                WorkerJsonContext.Default.FileStatResult);
        }
    }

    public static WorkerResponse MakeDirectory(JsonElement parameters)
    {
        try
        {
            Directory.CreateDirectory(RequirePath(parameters));
            return FileMutation(success: true, error: null);
        }
        catch (Exception ex)
        {
            return FileMutation(success: false, error: ex.Message);
        }
    }

    public static WorkerResponse DeletePath(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            if (Directory.Exists(filePath))
            {
                Directory.Delete(filePath, recursive: true);
            }
            else if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
            return FileMutation(success: true, error: null);
        }
        catch (Exception ex)
        {
            return FileMutation(success: false, error: ex.Message);
        }
    }

    public static WorkerResponse MovePath(JsonElement parameters)
    {
        try
        {
            var from = JsonHelpers.GetString(parameters, "from") ??
                throw new InvalidOperationException("Missing from");
            var to = JsonHelpers.GetString(parameters, "to") ??
                throw new InvalidOperationException("Missing to");
            if (File.Exists(from))
            {
                File.Move(from, to, overwrite: true);
            }
            else if (Directory.Exists(from))
            {
                Directory.Move(from, to);
            }
            else
            {
                throw new FileNotFoundException($"Path does not exist: {from}", from);
            }
            return FileMutation(success: true, error: null);
        }
        catch (Exception ex)
        {
            return FileMutation(success: false, error: ex.Message);
        }
    }

    public static async Task<WorkerResponse> ReadTextFileLinesAsync(JsonElement parameters)
    {
        try
        {
            var filePath = RequirePath(parameters);
            var extension = Path.GetExtension(filePath);
            if (TextReadBlockedExtensions.Contains(extension))
            {
                return WorkerResponse.Error("This file type cannot be read as plain text");
            }

            var maxFileReadBytes = JsonHelpers.GetLong(parameters, "maxFileReadBytes", DefaultMaxFileReadBytes);
            EnsureFileSize(filePath, maxFileReadBytes);

            var maxLines = Math.Max(1, Math.Min(JsonHelpers.GetInt(parameters, "maxLines", DefaultTextLineReadLimit), DefaultTextLineReadLimit));
            var lines = new List<string>(maxLines);
            var truncated = false;
            using var stream = File.OpenRead(filePath);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            while (await reader.ReadLineAsync() is { } line)
            {
                if (lines.Count >= maxLines)
                {
                    truncated = true;
                    break;
                }
                lines.Add(line);
            }

            return WorkerResponse.Json(
                new ReadTextLinesResult(string.Join('\n', lines), Path.GetFileName(filePath), filePath, lines.Count, maxLines, truncated),
                WorkerJsonContext.Default.ReadTextLinesResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse ListDirectory(JsonElement parameters)
    {
        try
        {
            var root = Path.GetFullPath(RequirePath(parameters));
            var limit = ClampNullable(JsonHelpers.GetIntNullable(parameters, "limit"), MaxListDirItems) ?? MaxListDirItems;
            var matcher = IgnoreMatcher.Create(root, JsonHelpers.GetStringArray(parameters, "ignore"), respectGitignore: true);
            var items = new List<ListDirItem>();

            foreach (var entry in Directory.EnumerateFileSystemEntries(root))
            {
                if (items.Count >= limit)
                {
                    break;
                }

                FileAttributes attributes;
                try
                {
                    attributes = File.GetAttributes(entry);
                }
                catch
                {
                    continue;
                }

                var isDirectory = attributes.HasFlag(FileAttributes.Directory);
                if (!isDirectory && !File.Exists(entry))
                {
                    continue;
                }

                if (matcher.IsIgnored(entry, isDirectory))
                {
                    continue;
                }

                items.Add(new ListDirItem(Path.GetFileName(entry), isDirectory ? "directory" : "file", entry));
            }

            return WorkerResponse.Json(items, WorkerJsonContext.Default.ListListDirItem);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Glob(JsonElement parameters)
    {
        var cwd = Path.GetFullPath(JsonHelpers.GetString(parameters, "path") ?? Environment.CurrentDirectory);
        var pattern = JsonHelpers.GetString(parameters, "pattern") ?? "*";
        try
        {
            var hidden = JsonHelpers.GetBool(parameters, "hidden", true);
            var respectGitignore = JsonHelpers.GetBool(parameters, "respectGitignore", true);
            var followSymlinks = JsonHelpers.GetBool(parameters, "followSymlinks", false);
            var maxDepth = ClampNullable(JsonHelpers.GetIntNullable(parameters, "maxDepth"), 50);
            var limit = ClampNullable(JsonHelpers.GetIntNullable(parameters, "limit"), MaxGlobMatches) ?? 100;
            var matcher = IgnoreMatcher.Create(cwd, JsonHelpers.GetStringArray(parameters, "ignore"), respectGitignore);
            var glob = new PathGlobMatcher(pattern);
            var matches = new List<GlobMatchWithTime>();
            var truncated = false;

            foreach (var candidate in EnumerateEntries(cwd, includeDirectories: true, hidden, followSymlinks, maxDepth, matcher))
            {
                var relative = NormalizeRelativePath(cwd, candidate.Path);
                if (!glob.Matches(relative, Path.GetFileName(candidate.Path)))
                {
                    continue;
                }

                matches.Add(new GlobMatchWithTime(candidate.Path, candidate.IsDirectory ? "directory" : "file", candidate.MtimeMs));
                if (matches.Count >= MaxGlobMatches)
                {
                    truncated = true;
                    break;
                }
            }

            matches.Sort((left, right) =>
            {
                var timeCompare = right.MtimeMs.CompareTo(left.MtimeMs);
                return timeCompare != 0
                    ? timeCompare
                    : string.Compare(left.Path, right.Path, StringComparison.OrdinalIgnoreCase);
            });

            if (matches.Count > limit)
            {
                truncated = true;
            }

            var limited = matches
                .Take(limit)
                .Select(item => new GlobMatchItem(item.Path, item.Type))
                .ToList();

            return WorkerResponse.Json(
                new GlobToolResult("glob", limited, CreateSearchMeta(cwd, pattern, null, null, "matches", truncated, false, truncated ? "max_results" : null, "native_aot", null, hidden, respectGitignore, followSymlinks, maxDepth, 0, 0, null, null, null), null),
                WorkerJsonContext.Default.GlobToolResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new GlobToolResult("glob", new List<GlobMatchItem>(), CreateSearchMeta(cwd, pattern, null, null, "matches", false, false, null, "native_aot", null, true, false, false, null, 0, 0, null, null, null), ex.Message),
                WorkerJsonContext.Default.GlobToolResult);
        }
    }

    public static WorkerResponse SearchFiles(JsonElement parameters)
    {
        try
        {
            var root = Path.GetFullPath(JsonHelpers.GetString(parameters, "path") ?? Environment.CurrentDirectory);
            var query = (JsonHelpers.GetString(parameters, "query") ?? string.Empty).Trim();
            var limit = Math.Max(1, Math.Min(JsonHelpers.GetInt(parameters, "limit", FileSearchMaxResults), 100));
            var matcher = IgnoreMatcher.Create(root, Array.Empty<string>(), respectGitignore: true);
            var candidates = EnumerateEntries(root, includeDirectories: false, hidden: true, followSymlinks: false, maxDepth: null, matcher)
                .Where(item => !item.IsDirectory)
                .Select(item => NormalizeRelativePath(root, item.Path))
                .ToList();

            var result = string.IsNullOrEmpty(query)
                ? candidates
                    .OrderBy(item => item, StringComparer.OrdinalIgnoreCase)
                    .Take(limit)
                    .Select(item => new SearchFileItem(item, Path.GetFileName(item)))
                    .ToList()
                : candidates
                    .Select(item => new { Path = item, Score = ScoreFileSearchMatch(item, query) })
                    .Where(item => !double.IsPositiveInfinity(item.Score))
                    .OrderBy(item => item.Score)
                    .ThenBy(item => item.Path, StringComparer.OrdinalIgnoreCase)
                    .Take(limit)
                    .Select(item => new SearchFileItem(item.Path, Path.GetFileName(item.Path)))
                    .ToList();

            return WorkerResponse.Json(result, WorkerJsonContext.Default.ListSearchFileItem);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static async Task<WorkerResponse> GrepAsync(JsonElement parameters)
    {
        var stopwatch = Stopwatch.StartNew();
        var searchTarget = Path.GetFullPath(JsonHelpers.GetString(parameters, "path") ?? Environment.CurrentDirectory);
        GrepOptions options;
        try
        {
            if (parameters.TryGetProperty("options", out var optionsElement))
            {
                options = GrepOptions.FromJson(optionsElement);
            }
            else
            {
                using var normalizedParameters = FileGrepInputNormalizer.BuildSearchParameters(parameters, searchTarget);
                options = GrepOptions.FromJson(normalizedParameters.RootElement);
            }
        }
        catch (Exception ex)
        {
            var meta = CreateSearchMeta(searchTarget, string.Empty, null, null, "matches", false, false, null, "native_aot", 0, true, true, false, null, 0, 0, null, null, null);
            return WorkerResponse.Json(
                new GrepToolResult("grep", new List<GrepMatchItem>(), meta, string.Empty, $"Invalid grep options: {ex.Message}"),
                WorkerJsonContext.Default.GrepToolResult);
        }

        try
        {
            if (!File.Exists(searchTarget) && !Directory.Exists(searchTarget))
            {
                var missingMeta = CreateSearchMeta(searchTarget, options.Pattern, options.Include, options.Exclude, options.OutputMode, false, false, null, "native_aot", 0, options.Hidden, options.RespectGitignore, options.FollowSymlinks, options.MaxDepth, options.BeforeContext, options.AfterContext, options.MaxResults, options.MaxOutputBytes, options.MaxLineLength);
                return WorkerResponse.Json(
                    new GrepToolResult("grep", new List<GrepMatchItem>(), missingMeta, string.Empty, $"Search path does not exist: {searchTarget}"),
                    WorkerJsonContext.Default.GrepToolResult);
            }

            var searchRoot = Directory.Exists(searchTarget)
                ? searchTarget
                : Path.GetDirectoryName(searchTarget) ?? Environment.CurrentDirectory;
            var timeoutAt = Stopwatch.GetTimestamp() + (long)(TimeSpan.FromMilliseconds(GrepTimeoutMs).TotalSeconds * Stopwatch.Frequency);
            var externalResult = await FileGrepExternalEngines.TrySearchAsync(
                searchRoot,
                searchTarget,
                Directory.Exists(searchTarget),
                options,
                timeoutAt);
            if (externalResult is not null)
            {
                var externalMeta = CreateSearchMeta(
                    searchRoot,
                    options.Pattern,
                    options.Include,
                    options.Exclude,
                    options.OutputMode,
                    externalResult.Truncated,
                    externalResult.TimedOut,
                    externalResult.LimitReason,
                    externalResult.Engine,
                    (int)stopwatch.ElapsedMilliseconds,
                    options.Hidden,
                    options.RespectGitignore,
                    options.FollowSymlinks,
                    options.MaxDepth,
                    options.BeforeContext,
                    options.AfterContext,
                    options.MaxResults,
                    options.MaxOutputBytes,
                    options.MaxLineLength,
                    externalResult.Warnings);
                var externalOutput = FormatGrepOutput(externalResult.Results, options);
                return WorkerResponse.Json(
                    new GrepToolResult("grep", externalResult.Results, externalMeta, externalOutput, null),
                    WorkerJsonContext.Default.GrepToolResult);
            }

            var matcher = GrepMatcher.Create(options);
            var collector = new GrepCollector(searchRoot, options);
            var ignoreMatcher = IgnoreMatcher.Create(searchRoot, Array.Empty<string>(), options.RespectGitignore);
            var pathMatcher = new GrepPathMatcher(searchRoot, options);
            var timedOut = false;

            foreach (var file in EnumerateGrepTargets(searchRoot, searchTarget, options, ignoreMatcher, pathMatcher))
            {
                if (Stopwatch.GetTimestamp() > timeoutAt)
                {
                    timedOut = true;
                    break;
                }

                if (!await ScanFileAsync(file, matcher, collector, options, timeoutAt))
                {
                    timedOut = collector.LimitReason == "timeout";
                    break;
                }

                if (collector.Truncated)
                {
                    break;
                }
            }

            var truncated = collector.Truncated || timedOut;
            var limitReason = timedOut ? "timeout" : collector.LimitReason;
            var warnings = collector.LinesTruncated
                ? new[] { $"Lines longer than {options.MaxScanLineLength} chars were truncated before matching" }
                : Array.Empty<string>();
            var meta = CreateSearchMeta(
                searchRoot,
                options.Pattern,
                options.Include,
                options.Exclude,
                options.OutputMode,
                truncated,
                timedOut,
                limitReason,
                "native_aot",
                (int)stopwatch.ElapsedMilliseconds,
                options.Hidden,
                options.RespectGitignore,
                options.FollowSymlinks,
                options.MaxDepth,
                options.BeforeContext,
                options.AfterContext,
                options.MaxResults,
                options.MaxOutputBytes,
                options.MaxLineLength,
                warnings);
            var output = FormatGrepOutput(collector.Results, options);
            return WorkerResponse.Json(
                new GrepToolResult("grep", collector.Results, meta, output, null),
                WorkerJsonContext.Default.GrepToolResult);
        }
        catch (Exception ex)
        {
            var meta = CreateSearchMeta(searchTarget, options.Pattern, options.Include, options.Exclude, options.OutputMode, false, false, null, "native_aot", (int)stopwatch.ElapsedMilliseconds, options.Hidden, options.RespectGitignore, options.FollowSymlinks, options.MaxDepth, options.BeforeContext, options.AfterContext, options.MaxResults, options.MaxOutputBytes, options.MaxLineLength);
            return WorkerResponse.Json(
                new GrepToolResult("grep", new List<GrepMatchItem>(), meta, string.Empty, ex.Message),
                WorkerJsonContext.Default.GrepToolResult);
        }
    }

    private static async Task<bool> ScanFileAsync(string filePath, GrepMatcher matcher, GrepCollector collector, GrepOptions options, long timeoutAt)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(filePath);
        }
        catch
        {
            return true;
        }

        if (info.Length == 0 || info.Length > GrepMaxFileSize)
        {
            return true;
        }

        if (!options.Text && IsBinaryFile(filePath))
        {
            return true;
        }

        var beforeBuffer = new Queue<(int Line, string Text)>();
        var afterContextRemaining = 0;
        var emittedContextLines = new HashSet<int>();
        var positiveHits = new bool[matcher.PositivePatternCount];
        var fileResults = new List<GrepMatchItem>();
        var hasMatch = false;
        var matchedCount = 0;
        var emittedMatchCount = 0;
        var lineNumber = 0;

        await using var stream = File.OpenRead(filePath);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        using var lineReader = new BoundedGrepLineReader(reader, options.MaxScanLineLength);
        while (await lineReader.ReadLineAsync() is { } readLine)
        {
            var line = readLine.Text;
            if (readLine.Truncated)
            {
                collector.MarkLineTruncated();
            }
            lineNumber++;
            if (Stopwatch.GetTimestamp() > timeoutAt)
            {
                collector.SetLimit("timeout");
                return false;
            }

            var hits = matcher.PositiveHits(line);
            for (var i = 0; i < hits.Length; i++)
            {
                positiveHits[i] |= hits[i];
            }

            var matches = matcher.TestLine(line);
            if (options.InvertMatch)
            {
                matches = !matches;
            }

            if (matches)
            {
                hasMatch = true;
                if (options.MaxCount is null || matchedCount < options.MaxCount.Value)
                {
                    matchedCount++;
                }

                if (options.OutputMode == "files_with_matches")
                {
                    if (!options.AllMatch)
                    {
                        fileResults.Add(new GrepMatchItem(FormatResultPath(collector.SearchRoot, filePath, options.PathStyle), null, null, null, null, null));
                        break;
                    }
                    continue;
                }

                if (options.OutputMode == "matches" && (options.MaxCount is null || emittedMatchCount < options.MaxCount.Value))
                {
                    if (!options.OnlyMatching)
                    {
                        foreach (var context in beforeBuffer)
                        {
                            AddContext(fileResults, emittedContextLines, collector.SearchRoot, filePath, context.Line, context.Text, options);
                        }
                    }

                    if (options.OnlyMatching)
                    {
                        var parts = matcher.MatchingParts(line);
                        if (parts.Count == 0)
                        {
                            parts.Add(new GrepLineMatchPart(line, 1));
                        }

                        foreach (var part in parts)
                        {
                            if (options.MaxCount is not null && emittedMatchCount >= options.MaxCount.Value)
                            {
                                break;
                            }

                            fileResults.Add(new GrepMatchItem(
                                FormatResultPath(collector.SearchRoot, filePath, options.PathStyle),
                                lineNumber,
                                options.Column ? part.Column : null,
                                NormalizeGrepLine(part.Text, options.MaxLineLength),
                                "match",
                                null));
                            emittedMatchCount++;
                        }
                    }
                    else
                    {
                        fileResults.Add(new GrepMatchItem(
                            FormatResultPath(collector.SearchRoot, filePath, options.PathStyle),
                            lineNumber,
                            options.Column ? matcher.FirstColumn(line) : null,
                            NormalizeGrepLine(line, options.MaxLineLength),
                            "match",
                            null));
                        emittedMatchCount++;
                        afterContextRemaining = options.AfterContext;
                    }
                }
            }
            else if (afterContextRemaining > 0 && options.OutputMode == "matches")
            {
                AddContext(fileResults, emittedContextLines, collector.SearchRoot, filePath, lineNumber, line, options);
                afterContextRemaining--;
            }

            if (options.BeforeContext > 0)
            {
                beforeBuffer.Enqueue((lineNumber, line));
                while (beforeBuffer.Count > options.BeforeContext)
                {
                    beforeBuffer.Dequeue();
                }
            }
        }

        if (options.OutputMode == "count" && hasMatch)
        {
            fileResults.Add(new GrepMatchItem(FormatResultPath(collector.SearchRoot, filePath, options.PathStyle), null, null, null, null, matchedCount));
        }
        else if (options.OutputMode == "files_with_matches" && hasMatch && fileResults.Count == 0)
        {
            fileResults.Add(new GrepMatchItem(FormatResultPath(collector.SearchRoot, filePath, options.PathStyle), null, null, null, null, null));
        }
        else if (options.OutputMode == "files_without_matches" && !hasMatch)
        {
            fileResults.Add(new GrepMatchItem(FormatResultPath(collector.SearchRoot, filePath, options.PathStyle), null, null, null, null, null));
        }

        if (options.AllMatch && positiveHits.Any(hit => !hit))
        {
            if (options.OutputMode == "files_without_matches")
            {
                fileResults = new List<GrepMatchItem>
                {
                    new(FormatResultPath(collector.SearchRoot, filePath, options.PathStyle), null, null, null, null, null)
                };
            }
            else
            {
                fileResults.Clear();
            }
        }

        foreach (var item in fileResults)
        {
            if (!collector.TryAdd(item))
            {
                return false;
            }
        }

        return true;
    }

    private static void AddContext(List<GrepMatchItem> results, HashSet<int> emittedContextLines, string searchRoot, string filePath, int lineNumber, string line, GrepOptions options)
    {
        if (!emittedContextLines.Add(lineNumber))
        {
            return;
        }

        results.Add(new GrepMatchItem(
            FormatResultPath(searchRoot, filePath, options.PathStyle),
            lineNumber,
            null,
            NormalizeGrepLine(line, options.MaxLineLength),
            "context",
            null));
    }

    private static IEnumerable<string> EnumerateGrepTargets(string searchRoot, string searchTarget, GrepOptions options, IgnoreMatcher ignoreMatcher, GrepPathMatcher pathMatcher)
    {
        if (File.Exists(searchTarget))
        {
            if (pathMatcher.ShouldKeep(searchTarget) && !ignoreMatcher.IsIgnored(searchTarget, isDirectory: false))
            {
                yield return searchTarget;
            }
            yield break;
        }

        foreach (var item in EnumerateEntries(searchTarget, includeDirectories: false, options.Hidden, options.FollowSymlinks, options.MaxDepth, ignoreMatcher))
        {
            if (!item.IsDirectory && pathMatcher.ShouldKeep(item.Path))
            {
                yield return item.Path;
            }
        }
    }

    private static IEnumerable<FileEntry> EnumerateEntries(string root, bool includeDirectories, bool hidden, bool followSymlinks, int? maxDepth, IgnoreMatcher matcher)
    {
        root = Path.GetFullPath(root);
        var stack = new Stack<(string Path, int Depth)>();
        stack.Push((root, 0));

        while (stack.Count > 0)
        {
            var (current, depth) = stack.Pop();
            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFileSystemEntries(current);
            }
            catch
            {
                continue;
            }

            foreach (var entry in entries)
            {
                FileAttributes attributes;
                try
                {
                    attributes = File.GetAttributes(entry);
                }
                catch
                {
                    continue;
                }

                var isDirectory = attributes.HasFlag(FileAttributes.Directory);
                var isSymlink = attributes.HasFlag(FileAttributes.ReparsePoint);
                if (isSymlink && !followSymlinks)
                {
                    continue;
                }

                if (!hidden && HasHiddenSegment(root, entry))
                {
                    continue;
                }

                if (matcher.IsIgnored(entry, isDirectory))
                {
                    continue;
                }

                var entryDepth = GetRelativeDepth(root, entry);
                if (maxDepth is not null && entryDepth > maxDepth.Value)
                {
                    continue;
                }

                if (isDirectory)
                {
                    if (includeDirectories)
                    {
                        yield return new FileEntry(entry, true, GetMtimeMs(entry));
                    }
                    stack.Push((entry, depth + 1));
                }
                else if (File.Exists(entry))
                {
                    yield return new FileEntry(entry, false, GetMtimeMs(entry));
                }
            }
        }
    }

    private static bool IsBinaryFile(string filePath)
    {
        try
        {
            var extension = Path.GetExtension(filePath);
            if (GrepBinaryExtensions.Contains(extension))
            {
                return true;
            }

            using var stream = File.OpenRead(filePath);
            Span<byte> buffer = stackalloc byte[512];
            var read = stream.Read(buffer);
            return buffer[..read].Contains((byte)0);
        }
        catch
        {
            return true;
        }
    }

    private static void EnsureFileSize(string filePath, long limit)
    {
        var info = new FileInfo(filePath);
        if (info.Length > limit)
        {
            throw new InvalidOperationException($"File too large ({info.Length / 1024d / 1024d:0.0} MB, limit {limit / 1024d / 1024d:0} MB): {filePath}");
        }
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
        bool respectGitignore,
        bool followSymlinks,
        int? maxDepth,
        int beforeContext,
        int afterContext,
        int? maxResults,
        int? maxOutputBytes,
        int? maxLineLength,
        string[]? warnings = null)
    {
        return new SearchMeta(
            "local",
            engine,
            searchRoot,
            "relative_to_search_root",
            truncated,
            timedOut,
            limitReason,
            pattern,
            include,
            exclude,
            outputMode,
            hiddenIncluded,
            true,
            respectGitignore,
            followSymlinks,
            searchTime,
            warnings ?? Array.Empty<string>(),
            maxDepth,
            beforeContext,
            afterContext,
            maxResults,
            maxOutputBytes,
            maxLineLength);
    }

    private static string FormatGrepOutput(List<GrepMatchItem> matches, GrepOptions options)
    {
        var builder = new StringBuilder();
        foreach (var item in matches)
        {
            if (builder.Length > 0)
            {
                builder.Append('\n');
            }

            if (options.OutputMode == "files_with_matches" || options.OutputMode == "files_without_matches")
            {
                builder.Append(item.Path);
                continue;
            }

            if (options.OutputMode == "count")
            {
                builder.Append(item.Path);
                builder.Append(':');
                builder.Append(item.Count ?? 0);
                continue;
            }

            if (item.Line is null)
            {
                builder.Append(item.Path);
                continue;
            }

            var separator = item.Kind == "context" ? '-' : ':';
            builder.Append(item.Path);
            builder.Append(separator);
            builder.Append(item.Line.Value);
            builder.Append(separator);
            if (options.Column && item.Column is not null && item.Kind != "context")
            {
                builder.Append(item.Column.Value);
                builder.Append(separator);
            }
            builder.Append(item.Text ?? string.Empty);
        }
        return builder.ToString();
    }

    private static string FormatResultPath(string searchRoot, string filePath, string pathStyle)
    {
        var absolute = Path.GetFullPath(filePath);
        return pathStyle == "absolute" ? absolute : NormalizeRelativePath(searchRoot, absolute);
    }

    private static string NormalizeGrepLine(string text, int maxLineLength)
    {
        var normalized = text.Trim();
        return normalized.Length <= maxLineLength
            ? normalized
            : normalized[..Math.Max(0, maxLineLength - 3)] + "...";
    }

    private static double ScoreFileSearchMatch(string filePath, string query)
    {
        var normalizedPath = NormalizeSeparators(filePath).ToLowerInvariant();
        var normalizedQuery = NormalizeSeparators(query).Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(normalizedQuery))
        {
            return double.PositiveInfinity;
        }

        var fileName = Path.GetFileName(normalizedPath);
        if (fileName == normalizedQuery)
        {
            return 0;
        }
        if (fileName.StartsWith(normalizedQuery, StringComparison.Ordinal))
        {
            return 1;
        }

        var fileNameIndex = fileName.IndexOf(normalizedQuery, StringComparison.Ordinal);
        if (fileNameIndex >= 0)
        {
            return 10 + fileNameIndex;
        }

        if (normalizedPath == normalizedQuery)
        {
            return 20;
        }

        var pathIndex = normalizedPath.IndexOf(normalizedQuery, StringComparison.Ordinal);
        if (pathIndex >= 0)
        {
            return 30 + pathIndex;
        }

        var cursor = 0;
        var gapScore = 0;
        foreach (var character in normalizedQuery)
        {
            var nextIndex = normalizedPath.IndexOf(character, cursor);
            if (nextIndex < 0)
            {
                return double.PositiveInfinity;
            }
            gapScore += nextIndex - cursor;
            cursor = nextIndex + 1;
        }

        return 100 + gapScore;
    }

    private static bool HasHiddenSegment(string root, string filePath)
    {
        var relative = NormalizeRelativePath(root, filePath);
        return relative.Split('/').Any(part => part.StartsWith('.') && part != ".");
    }

    private static int GetRelativeDepth(string root, string filePath)
    {
        var relative = NormalizeRelativePath(root, filePath);
        if (string.IsNullOrEmpty(relative) || relative == ".")
        {
            return 0;
        }
        return Math.Max(0, relative.Split('/', StringSplitOptions.RemoveEmptyEntries).Length - 1);
    }

    private static long GetMtimeMs(string filePath)
    {
        try
        {
            return new FileInfo(filePath).LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond;
        }
        catch
        {
            return 0;
        }
    }

    private static string RequirePath(JsonElement parameters)
    {
        return JsonHelpers.GetString(parameters, "path") is { Length: > 0 } filePath
            ? filePath
            : throw new InvalidOperationException("Missing path");
    }

    private static int? ClampNullable(int? value, int max)
    {
        if (value is null || value.Value <= 0)
        {
            return null;
        }
        return Math.Min(value.Value, max);
    }

    private static string NormalizeRelativePath(string root, string filePath)
    {
        return NormalizeSeparators(Path.GetRelativePath(root, filePath));
    }

    private static string NormalizeSeparators(string value)
    {
        return value.Replace('\\', '/');
    }

    internal static int ClampMaxResults(int value) => Math.Max(1, Math.Min(value, GrepMaxResults));
    internal static int ClampMaxLineLength(int value) => Math.Max(1, Math.Min(value, GrepMaxLineLength));
    internal static int ClampMaxScanLineLength(int value) => Math.Max(1, Math.Min(value, GrepMaxScanLineLength));
    internal static int ClampMaxOutputBytes(int value) => Math.Max(1, Math.Min(value, GrepMaxOutputBytes));
    internal static int DefaultMaxResults => GrepDefaultMaxResults;
    internal static int DefaultMaxLineLength => GrepDefaultMaxLineLength;
    internal static int DefaultMaxScanLineLength => GrepDefaultMaxScanLineLength;
    internal static int DefaultMaxOutputBytes => GrepDefaultMaxOutputBytes;
    internal static int MaxGrepResults => GrepMaxResults;

    private static WorkerResponse FileMutation(bool success, string? error)
    {
        return WorkerResponse.Json(
            new FileMutationResult(success, error),
            WorkerJsonContext.Default.FileMutationResult);
    }
}

internal sealed class GrepCollector(string searchRoot, GrepOptions options)
{
    private int _totalBytes = 2;

    public string SearchRoot { get; } = searchRoot;
    public List<GrepMatchItem> Results { get; } = new();
    public string? LimitReason { get; private set; }
    public bool Truncated => LimitReason is not null;
    public bool LinesTruncated { get; private set; }

    public bool TryAdd(GrepMatchItem item)
    {
        if (Results.Count >= options.MaxResults)
        {
            LimitReason ??= "max_results";
            return false;
        }

        var candidateBytes = Encoding.UTF8.GetByteCount(item.Path)
            + Encoding.UTF8.GetByteCount(item.Text ?? string.Empty)
            + 96;
        if (_totalBytes + candidateBytes > options.MaxOutputBytes)
        {
            LimitReason ??= "max_output_bytes";
            return false;
        }

        Results.Add(item);
        _totalBytes += candidateBytes;
        return true;
    }

    public void SetLimit(string reason)
    {
        LimitReason ??= reason;
    }

    public void MarkLineTruncated()
    {
        LinesTruncated = true;
    }
}

internal sealed class BoundedGrepLineReader : IDisposable
{
    private const int BufferSize = 8 * 1024;

    private readonly StreamReader _reader;
    private readonly int _maxLineLength;
    private readonly char[] _buffer;
    private int _offset;
    private int _count;
    private bool _finished;
    private bool _skipNextLf;

    public BoundedGrepLineReader(StreamReader reader, int maxLineLength)
    {
        _reader = reader;
        _maxLineLength = Math.Max(1, maxLineLength);
        _buffer = ArrayPool<char>.Shared.Rent(BufferSize);
    }

    public async ValueTask<BoundedGrepLine?> ReadLineAsync()
    {
        if (_finished)
        {
            return null;
        }

        var builder = new StringBuilder(Math.Min(_maxLineLength, BufferSize));
        var truncated = false;

        while (true)
        {
            if (_offset >= _count)
            {
                _count = await _reader.ReadAsync(_buffer.AsMemory(0, _buffer.Length));
                _offset = 0;
                if (_count == 0)
                {
                    _finished = true;
                    return builder.Length == 0 && !truncated
                        ? null
                        : new BoundedGrepLine(builder.ToString(), truncated);
                }
            }

            var current = _buffer[_offset++];
            if (_skipNextLf)
            {
                _skipNextLf = false;
                if (current == '\n')
                {
                    continue;
                }
            }

            if (current == '\n')
            {
                return new BoundedGrepLine(builder.ToString(), truncated);
            }

            if (current == '\r')
            {
                _skipNextLf = true;
                return new BoundedGrepLine(builder.ToString(), truncated);
            }

            if (builder.Length < _maxLineLength)
            {
                builder.Append(current);
            }
            else
            {
                truncated = true;
            }
        }
    }

    public void Dispose()
    {
        ArrayPool<char>.Shared.Return(_buffer);
    }
}

internal sealed record BoundedGrepLine(string Text, bool Truncated);

internal sealed class GrepOptions
{
    public string Pattern { get; init; } = string.Empty;
    public string PatternMode { get; init; } = "extended";
    public string[] Patterns { get; init; } = Array.Empty<string>();
    public string[] NotPatterns { get; init; } = Array.Empty<string>();
    public string PatternOperator { get; init; } = "or";
    public bool AllMatch { get; init; }
    public string? Include { get; init; }
    public string? Exclude { get; init; }
    public string[] IncludePatterns { get; init; } = Array.Empty<string>();
    public string[] ExcludePatterns { get; init; } = Array.Empty<string>();
    public string[] Pathspecs { get; init; } = Array.Empty<string>();
    public string[] PathspecIncludePatterns { get; init; } = Array.Empty<string>();
    public string[] PathspecExcludePatterns { get; init; } = Array.Empty<string>();
    public bool CaseSensitive { get; init; } = true;
    public bool SmartCase { get; init; }
    public bool Literal { get; init; }
    public bool Word { get; init; }
    public bool Line { get; init; }
    public bool InvertMatch { get; init; }
    public bool OnlyMatching { get; init; }
    public bool Column { get; init; }
    public int BeforeContext { get; init; }
    public int AfterContext { get; init; }
    public int MaxResults { get; init; } = FileTools.DefaultMaxResults;
    public int MaxOutputBytes { get; init; } = FileTools.DefaultMaxOutputBytes;
    public int MaxLineLength { get; init; } = FileTools.DefaultMaxLineLength;
    public int MaxScanLineLength { get; init; } = FileTools.DefaultMaxScanLineLength;
    public int? MaxCount { get; init; }
    public int? MaxDepth { get; init; }
    public bool Hidden { get; init; } = true;
    public bool RespectGitignore { get; init; } = true;
    public bool ExcludeStandard { get; init; } = true;
    public bool FollowSymlinks { get; init; }
    public bool Untracked { get; init; } = true;
    public bool Cached { get; init; }
    public bool NoIndex { get; init; }
    public bool Index { get; init; }
    public bool Text { get; init; }
    public bool Textconv { get; init; }
    public int? Threads { get; init; }
    public string[] TypeFilters { get; init; } = Array.Empty<string>();
    public bool Multiline { get; init; }
    public string OutputMode { get; init; } = "files_with_matches";
    public string PathStyle { get; init; } = "relative";

    public static GrepOptions FromJson(JsonElement element)
    {
        var pattern = JsonHelpers.GetString(element, "pattern") ?? string.Empty;
        var patterns = JsonHelpers.GetStringArray(element, "patterns");
        if (patterns.Length == 0)
        {
            patterns = new[] { pattern };
        }
        var context = JsonHelpers.GetIntNullable(element, "context");
        var patternMode = ResolvePatternMode(element);
        var typeFilters = JsonHelpers.GetStringArray(element, "type")
            .Concat(JsonHelpers.GetStringArray(element, "typeFilters"))
            .Select(NormalizeTypeFilter)
            .Where(static value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var includePatterns = ParseDelimitedPatterns(JsonHelpers.GetString(element, "include"))
            .Concat(JsonHelpers.GetStringArray(element, "glob"))
            .Concat(JsonHelpers.GetStringArray(element, "includePatterns"))
            .Concat(TypeFiltersToIncludePatterns(typeFilters))
            .ToList();
        if (JsonHelpers.GetString(element, "glob") is { Length: > 0 } glob)
        {
            includePatterns.Insert(0, glob);
        }
        var excludePatterns = ParseDelimitedPatterns(JsonHelpers.GetString(element, "exclude"))
            .Concat(JsonHelpers.GetStringArray(element, "excludePatterns"))
            .ToArray();
        var pathspecs = JsonHelpers.GetStringArray(element, "pathspec")
            .Concat(JsonHelpers.GetStringArray(element, "pathspecs"))
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value.Trim())
            .ToArray();
        var pathspecPatterns = pathspecs
            .Select(SplitPathspecMagic)
            .Where(static spec => spec.Pattern.Length > 0)
            .ToArray();
        var pathspecIncludePatterns = JsonHelpers.GetStringArray(element, "pathspecIncludePatterns")
            .Concat(ParseDelimitedPatterns(JsonHelpers.GetString(element, "pathspecInclude")))
            .Concat(ParseDelimitedPatterns(JsonHelpers.GetString(element, "pathspecIncludes")))
            .Concat(ParseDelimitedPatterns(JsonHelpers.GetString(element, "includes")))
            .Concat(pathspecPatterns.Where(static spec => !spec.Exclude).Select(static spec => spec.Pattern))
            .ToArray();
        var pathspecExcludePatterns = JsonHelpers.GetStringArray(element, "pathspecExcludePatterns")
            .Concat(ParseDelimitedPatterns(JsonHelpers.GetString(element, "pathspecExclude")))
            .Concat(ParseDelimitedPatterns(JsonHelpers.GetString(element, "pathspecExcludes")))
            .Concat(ParseDelimitedPatterns(JsonHelpers.GetString(element, "excludes")))
            .Concat(pathspecPatterns.Where(static spec => spec.Exclude).Select(static spec => spec.Pattern))
            .ToArray();
        var requestedOutputMode = NormalizeOutputMode(
            JsonHelpers.GetString(element, "outputMode") ??
            JsonHelpers.GetString(element, "output_mode") ??
            "files_with_matches");
        var outputMode = JsonHelpers.GetBool(element, "filesWithMatches", false)
            ? "files_with_matches"
            : JsonHelpers.GetBool(element, "filesWithoutMatches", false)
                ? "files_without_matches"
                : JsonHelpers.GetBool(element, "count", false)
                    ? "count"
                    : requestedOutputMode;

        return new GrepOptions
        {
            Pattern = pattern,
            PatternMode = patternMode,
            Patterns = patterns,
            NotPatterns = JsonHelpers.GetStringArray(element, "notPatterns"),
            PatternOperator = NormalizePatternOperator(
                JsonHelpers.GetString(element, "patternOperator") ??
                JsonHelpers.GetString(element, "operator") ??
                JsonHelpers.GetString(element, "combine") ??
                JsonHelpers.GetString(element, "matchOperator") ??
                "or"),
            AllMatch = JsonHelpers.GetBool(element, "allMatch", false),
            Include = JsonHelpers.GetString(element, "include"),
            Exclude = JsonHelpers.GetString(element, "exclude"),
            IncludePatterns = includePatterns
                .Where(static value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            ExcludePatterns = excludePatterns
                .Where(static value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            Pathspecs = pathspecs,
            PathspecIncludePatterns = pathspecIncludePatterns
                .Where(static value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            PathspecExcludePatterns = pathspecExcludePatterns
                .Where(static value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            CaseSensitive = ResolveCaseSensitive(element, patterns),
            SmartCase = JsonHelpers.GetBool(element, "smartCase", false),
            Literal = JsonHelpers.GetBool(element, "literal", false) ||
                JsonHelpers.GetBool(element, "fixedStrings", false) ||
                patternMode == "fixed",
            Word = JsonHelpers.GetBool(element, "word", false),
            Line = JsonHelpers.GetBool(element, "line", false),
            InvertMatch = JsonHelpers.GetBool(element, "invertMatch", false),
            OnlyMatching = JsonHelpers.GetBool(element, "onlyMatching", false),
            Column = JsonHelpers.GetBool(element, "column", false),
            BeforeContext = ClampContext(JsonHelpers.GetIntNullable(element, "beforeContext") ?? context),
            AfterContext = ClampContext(JsonHelpers.GetIntNullable(element, "afterContext") ?? context),
            MaxResults = FileTools.ClampMaxResults(
                JsonHelpers.GetIntNullable(element, "maxResults") ??
                JsonHelpers.GetIntNullable(element, "head_limit") ??
                JsonHelpers.GetIntNullable(element, "headLimit") ??
                JsonHelpers.GetIntNullable(element, "limit") ??
                FileTools.DefaultMaxResults),
            MaxOutputBytes = FileTools.ClampMaxOutputBytes(JsonHelpers.GetInt(element, "maxOutputBytes", FileTools.DefaultMaxOutputBytes)),
            MaxLineLength = FileTools.ClampMaxLineLength(JsonHelpers.GetInt(element, "maxLineLength", FileTools.DefaultMaxLineLength)),
            MaxScanLineLength = FileTools.ClampMaxScanLineLength(JsonHelpers.GetInt(element, "maxScanLineLength", FileTools.DefaultMaxScanLineLength)),
            MaxCount = ClampOptionalNumber(JsonHelpers.GetIntNullable(element, "maxCount"), FileTools.MaxGrepResults),
            MaxDepth = ClampOptionalNumber(JsonHelpers.GetIntNullable(element, "maxDepth"), 50),
            Hidden = JsonHelpers.GetBool(element, "hidden", true),
            RespectGitignore = JsonHelpers.GetBool(element, "respectGitignore", true),
            ExcludeStandard = JsonHelpers.GetBool(
                element,
                "excludeStandard",
                JsonHelpers.GetBool(element, "respectGitignore", true)),
            FollowSymlinks = JsonHelpers.GetBool(element, "followSymlinks", false),
            Untracked = JsonHelpers.GetBool(element, "untracked", true),
            Cached = JsonHelpers.GetBool(element, "cached", false),
            NoIndex = JsonHelpers.GetBool(element, "noIndex", false),
            Index = JsonHelpers.GetBool(element, "index", false),
            Text = JsonHelpers.GetBool(element, "text", false),
            Textconv = JsonHelpers.GetBool(element, "textconv", false),
            Threads = ClampOptionalNumber(JsonHelpers.GetIntNullable(element, "threads"), 64),
            TypeFilters = typeFilters,
            Multiline = JsonHelpers.GetBool(element, "multiline", false),
            OutputMode = outputMode,
            PathStyle = JsonHelpers.GetString(element, "pathStyle") ?? "relative"
        };
    }

    private static string[] ParseDelimitedPatterns(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? Array.Empty<string>()
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static IEnumerable<string> TypeFiltersToIncludePatterns(IEnumerable<string> typeFilters)
    {
        foreach (var filter in typeFilters)
        {
            var normalized = NormalizeTypeFilter(filter);
            foreach (var pattern in TypeGlobs(normalized))
            {
                yield return pattern;
            }
        }
    }

    private static string NormalizeTypeFilter(string value)
    {
        var normalized = value.Trim();
        if (normalized.StartsWith("--type=", StringComparison.Ordinal))
        {
            return normalized[7..].Trim();
        }
        if (normalized.StartsWith("-type=", StringComparison.Ordinal))
        {
            return normalized[6..].Trim();
        }
        return normalized;
    }

    private static string[] TypeGlobs(string type)
    {
        return type.ToLowerInvariant() switch
        {
            "c" => ["*.c", "*.h"],
            "cpp" => ["*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hxx"],
            "cs" => ["*.cs"],
            "css" => ["*.css"],
            "go" => ["*.go"],
            "html" => ["*.html", "*.htm"],
            "java" => ["*.java"],
            "js" => ["*.js", "*.jsx", "*.mjs", "*.cjs"],
            "json" => ["*.json"],
            "jsx" => ["*.jsx"],
            "kt" => ["*.kt", "*.kts"],
            "md" => ["*.md", "*.mdx"],
            "php" => ["*.php"],
            "py" => ["*.py", "*.pyw"],
            "rb" => ["*.rb"],
            "rs" or "rust" => ["*.rs"],
            "scss" => ["*.scss"],
            "sh" => ["*.sh", "*.bash", "*.zsh"],
            "sql" => ["*.sql"],
            "svelte" => ["*.svelte"],
            "swift" => ["*.swift"],
            "ts" => ["*.ts", "*.tsx"],
            "tsx" => ["*.tsx"],
            "vue" => ["*.vue"],
            "xml" => ["*.xml"],
            "yaml" or "yml" => ["*.yaml", "*.yml"],
            _ => []
        };
    }

    private static (string Pattern, bool Exclude) SplitPathspecMagic(string pathspec)
    {
        var normalized = NormalizePathspec(pathspec);
        if (normalized.Length == 0)
        {
            return (string.Empty, false);
        }
        if (normalized.StartsWith(":!", StringComparison.Ordinal) ||
            normalized.StartsWith(":^", StringComparison.Ordinal))
        {
            return (normalized[2..], true);
        }
        if (!normalized.StartsWith(":(", StringComparison.Ordinal))
        {
            return (normalized, false);
        }

        var closeIndex = normalized.IndexOf(')', StringComparison.Ordinal);
        if (closeIndex == -1)
        {
            return (normalized, false);
        }
        var magic = normalized[2..closeIndex]
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return (normalized[(closeIndex + 1)..], magic.Contains("exclude", StringComparer.Ordinal));
    }

    private static string NormalizePathspec(string pathspec)
    {
        return pathspec.Trim().Replace('\\', '/').TrimEnd('/');
    }

    private static int ClampContext(int? value)
    {
        if (value is null || value.Value <= 0)
        {
            return 0;
        }
        return Math.Min(value.Value, 20);
    }

    private static int? ClampOptionalNumber(int? value, int max)
    {
        if (value is null || value.Value <= 0)
        {
            return null;
        }
        return Math.Min(value.Value, max);
    }

    private static string ResolvePatternMode(JsonElement element)
    {
        var mode = JsonHelpers.GetString(element, "patternMode") ??
            JsonHelpers.GetString(element, "regexpType") ??
            JsonHelpers.GetString(element, "regexMode");
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

        if (JsonHelpers.GetBool(element, "literal", false) ||
            JsonHelpers.GetBool(element, "fixed", false) ||
            JsonHelpers.GetBool(element, "fixedStrings", false))
        {
            return "fixed";
        }
        if (JsonHelpers.GetBool(element, "basic", false) ||
            JsonHelpers.GetBool(element, "basicRegexp", false))
        {
            return "basic";
        }
        if (JsonHelpers.GetBool(element, "extended", false) ||
            JsonHelpers.GetBool(element, "extendedRegexp", false))
        {
            return "extended";
        }
        if (JsonHelpers.GetBool(element, "perl", false) ||
            JsonHelpers.GetBool(element, "perlRegexp", false))
        {
            return "perl";
        }

        return "extended";
    }

    private static string NormalizePatternOperator(string value)
    {
        return value is "and" or "AND" ? "and" : "or";
    }

    private static bool ResolveCaseSensitive(JsonElement element, string[] patterns)
    {
        if (JsonHelpers.GetBool(element, "ignoreCase", false))
        {
            return false;
        }
        if (JsonHelpers.GetBool(element, "smartCase", false))
        {
            return patterns.Any(pattern => pattern.Any(static character => character is >= 'A' and <= 'Z'));
        }
        return JsonHelpers.GetBool(element, "caseSensitive", true);
    }

    private static string NormalizeOutputMode(string mode)
    {
        return mode switch
        {
            "content" => "matches",
            "matches" or "files_with_matches" or "files_without_matches" or "count" => mode,
            _ => "files_with_matches"
        };
    }
}

internal sealed class GrepMatcher
{
    private readonly List<Regex> _positive;
    private readonly List<Regex> _negative;
    private readonly GrepOptions _options;

    private GrepMatcher(List<Regex> positive, List<Regex> negative, GrepOptions options)
    {
        _positive = positive;
        _negative = negative;
        _options = options;
    }

    public int PositivePatternCount => _positive.Count;

    public static GrepMatcher Create(GrepOptions options)
    {
        var regexOptions = RegexOptions.CultureInvariant;
        if (!options.CaseSensitive)
        {
            regexOptions |= RegexOptions.IgnoreCase;
        }

        string BuildSource(string pattern)
        {
            var source = options.Literal || options.PatternMode == "fixed"
                ? Regex.Escape(pattern)
                : options.PatternMode == "basic"
                    ? TranslateBasicRegexpToDotNet(pattern)
                    : pattern;
            if (options.Word)
            {
                source = $@"\b(?:{source})\b";
            }
            if (options.Line)
            {
                source = $"^(?:{source})$";
            }
            return source;
        }

        return new GrepMatcher(
            options.Patterns.Select(pattern => new Regex(BuildSource(pattern), regexOptions)).ToList(),
            options.NotPatterns.Select(pattern => new Regex(BuildSource(pattern), regexOptions)).ToList(),
            options);
    }

    public bool[] PositiveHits(string line)
    {
        return _positive.Select(regex => regex.IsMatch(line)).ToArray();
    }

    public bool TestLine(string line)
    {
        var hits = PositiveHits(line);
        var positiveMatch = _positive.Count == 0
            || (_options.PatternOperator == "and" ? hits.All(BooleanIdentity) : hits.Any(BooleanIdentity));
        return positiveMatch && !_negative.Any(regex => regex.IsMatch(line));
    }

    public List<GrepLineMatchPart> MatchingParts(string line)
    {
        var parts = new List<GrepLineMatchPart>();
        foreach (var regex in _positive.Where(regex => regex.IsMatch(line)))
        {
            foreach (Match match in regex.Matches(line))
            {
                if (match.Length == 0)
                {
                    continue;
                }
                parts.Add(new GrepLineMatchPart(match.Value, match.Index + 1));
            }
        }
        return parts
            .OrderBy(part => part.Column)
            .ThenBy(part => part.Text, StringComparer.Ordinal)
            .DistinctBy(part => $"{part.Column}\0{part.Text}")
            .ToList();
    }

    public int? FirstColumn(string line)
    {
        return MatchingParts(line).FirstOrDefault()?.Column;
    }

    private static bool BooleanIdentity(bool value) => value;

    private static string TranslateBasicRegexpToDotNet(string pattern)
    {
        var builder = new StringBuilder();
        for (var index = 0; index < pattern.Length; index++)
        {
            var character = pattern[index];
            var hasNext = index + 1 < pattern.Length;
            if (character == '\\' && hasNext)
            {
                var next = pattern[index + 1];
                if ("()+?|{}".Contains(next))
                {
                    builder.Append(next);
                    index++;
                    continue;
                }

                builder.Append(character);
                builder.Append(next);
                index++;
                continue;
            }

            if ("()+?|{}".Contains(character))
            {
                builder.Append('\\');
            }
            builder.Append(character);
        }
        return builder.ToString();
    }
}

internal sealed class GrepPathMatcher
{
    private readonly string _root;
    private readonly GrepOptions _options;
    private readonly PathGlobMatcher[] _includes;
    private readonly PathGlobMatcher[] _excludes;

    public GrepPathMatcher(string root, GrepOptions options)
    {
        _root = root;
        _options = options;
        _includes = options.IncludePatterns.Concat(options.PathspecIncludePatterns).Select(pattern => new PathGlobMatcher(pattern)).ToArray();
        _excludes = options.ExcludePatterns.Concat(options.PathspecExcludePatterns).Select(pattern => new PathGlobMatcher(pattern)).ToArray();
    }

    public bool ShouldKeep(string filePath)
    {
        var relative = Normalize(Path.GetRelativePath(NormalizeComparablePath(_root), NormalizeComparablePath(filePath)));
        var name = Path.GetFileName(filePath);
        if (_includes.Length > 0 && !_includes.Any(matcher => matcher.Matches(relative, name)))
        {
            return false;
        }
        return !_excludes.Any(matcher => matcher.Matches(relative, name));
    }

    private static string Normalize(string value) => value.Replace('\\', '/');

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
}

internal sealed class IgnoreMatcher
{
    private readonly string _root;
    private readonly PathGlobMatcher[] _patterns;

    private IgnoreMatcher(string root, PathGlobMatcher[] patterns)
    {
        _root = root;
        _patterns = patterns;
    }

    public static IgnoreMatcher Create(string root, IEnumerable<string> extraPatterns, bool respectGitignore)
    {
        var patterns = new List<string>();
        patterns.AddRange(extraPatterns.Where(pattern => !string.IsNullOrWhiteSpace(pattern)));
        if (respectGitignore)
        {
            var gitignorePath = Path.Combine(root, ".gitignore");
            if (File.Exists(gitignorePath))
            {
                foreach (var line in File.ReadLines(gitignorePath))
                {
                    var trimmed = line.Trim();
                    if (trimmed.Length == 0 || trimmed.StartsWith('#') || trimmed.StartsWith('!'))
                    {
                        continue;
                    }
                    patterns.Add(trimmed);
                }
            }
        }
        return new IgnoreMatcher(Path.GetFullPath(root), patterns.Select(pattern => new PathGlobMatcher(pattern)).ToArray());
    }

    public bool IsIgnored(string filePath, bool isDirectory)
    {
        var name = Path.GetFileName(filePath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (isDirectory && FileToolsDefaultIgnoredDirs.Contains(name))
        {
            return true;
        }

        var relative = Path.GetRelativePath(_root, filePath).Replace('\\', '/');
        return _patterns.Any(pattern => pattern.Matches(relative, name));
    }

    private static HashSet<string> FileToolsDefaultIgnoredDirs => new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", ".svn", ".hg", ".bzr", "dist", "build", "out", ".next",
        ".nuxt", ".output", "coverage", ".nyc_output", ".cache", ".parcel-cache", "vendor",
        "target", "bin", "obj", ".gradle", "__pycache__", ".pytest_cache", ".mypy_cache",
        ".venv", "venv", "env"
    };
}

internal sealed class PathGlobMatcher
{
    private readonly string _pattern;
    private readonly Regex _regex;
    private readonly bool _hasSlash;
    private readonly bool _hasWildcard;
    private readonly bool _extensionOnly;

    public PathGlobMatcher(string pattern)
    {
        _pattern = NormalizePattern(pattern);
        _hasSlash = _pattern.Contains('/');
        _hasWildcard = _pattern.Contains('*') || _pattern.Contains('?');
        _extensionOnly = _pattern.StartsWith("*.") && !_hasSlash && _pattern.Count(character => character == '*') == 1;
        _regex = new Regex("^" + GlobToRegex(_pattern) + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    public bool Matches(string relativePath, string fileName)
    {
        var normalizedRelative = NormalizePattern(relativePath);
        var normalizedName = NormalizePattern(fileName);
        var extension = Path.GetExtension(normalizedName).ToLowerInvariant();
        if (_extensionOnly)
        {
            return normalizedName.EndsWith(_pattern[1..], StringComparison.OrdinalIgnoreCase);
        }
        if (!_hasWildcard)
        {
            var lowered = _pattern.ToLowerInvariant();
            return string.Equals(normalizedName, lowered, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(normalizedRelative, lowered, StringComparison.OrdinalIgnoreCase) ||
                extension == lowered;
        }
        return _regex.IsMatch(normalizedRelative)
            || (!_hasSlash && _regex.IsMatch(normalizedName))
            || (_pattern.EndsWith('/') && normalizedRelative.StartsWith(_pattern, StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizePattern(string pattern)
    {
        var normalized = pattern.Trim().Replace('\\', '/').TrimStart('/');
        if (normalized.StartsWith("./", StringComparison.Ordinal))
        {
            normalized = normalized[2..];
        }
        if (normalized.StartsWith("**/", StringComparison.Ordinal))
        {
            normalized = normalized[3..];
        }
        return normalized;
    }

    private static string GlobToRegex(string pattern)
    {
        var builder = new StringBuilder();
        for (var i = 0; i < pattern.Length; i++)
        {
            var character = pattern[i];
            if (character == '*')
            {
                if (i + 1 < pattern.Length && pattern[i + 1] == '*')
                {
                    builder.Append(".*");
                    i++;
                }
                else
                {
                    builder.Append("[^/]*");
                }
                continue;
            }

            if (character == '?')
            {
                builder.Append("[^/]");
                continue;
            }

            if ("+()^$.{}=!|[]\\".Contains(character))
            {
                builder.Append('\\');
            }
            builder.Append(character);
        }
        return builder.ToString();
    }
}
