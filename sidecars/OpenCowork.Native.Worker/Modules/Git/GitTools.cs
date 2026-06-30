using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class GitTools
{
    private const int DefaultScanDepth = 3;
    private const int DefaultGitTimeoutMs = 60_000;
    private const int DefaultMaxStdoutChars = 512 * 1024;
    private const int DefaultMaxStderrChars = 64 * 1024;
    private const int DefaultLargeGitOutputChars = 2 * 1024 * 1024;
    private const int DefaultHistoryLimit = 50;
    private const int MaxHistoryLimit = 500;
    private const int DefaultMaxPatchChars = 96_000;
    private const int MaxPatchChars = 512_000;
    private const string StatusSeparator = "\u0001";
    private const string HistorySeparator = "\u0001";
    private const string PatchTruncatedSuffix = "\n\n[... patch truncated for size; more changes exist in index ...]";

    private static readonly HashSet<string> ExcludedDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", "dist", "out", "build", ".next", ".nuxt", "target", "coverage",
        "tmp", "cache","obj","bin"
    };

    private readonly record struct GitTarget(
        string Cwd,
        JsonElement Parameters,
        bool IsSsh,
        string? SshConnectionId);

    public static async Task<WorkerResponse> ExecLocalAsync(JsonElement parameters)
    {
        try
        {
            var cwd = JsonHelpers.GetString(parameters, "cwd") ?? Environment.CurrentDirectory;
            var args = JsonHelpers.GetStringArray(parameters, "args");
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultGitTimeoutMs);
            var maxStdoutChars = JsonHelpers.GetInt(parameters, "maxStdoutChars", DefaultMaxStdoutChars);
            var maxStderrChars = JsonHelpers.GetInt(parameters, "maxStderrChars", DefaultMaxStderrChars);
            var result = await ExecGitLocalAsync(args, cwd, timeoutMs, maxStdoutChars, maxStderrChars);
            return WorkerResponse.Json(result, WorkerJsonContext.Default.GitExecNativeResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static async Task<WorkerResponse> ExecAsync(JsonElement parameters)
    {
        try
        {
            var target = ReadTarget(parameters);
            var args = JsonHelpers.GetStringArray(parameters, "args");
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultGitTimeoutMs);
            var maxStdoutChars = JsonHelpers.GetInt(parameters, "maxStdoutChars", DefaultMaxStdoutChars);
            var maxStderrChars = JsonHelpers.GetInt(parameters, "maxStderrChars", DefaultMaxStderrChars);
            var result = await ExecGitAsync(target, args, timeoutMs, maxStdoutChars, maxStderrChars);
            return WorkerResponse.Json(result, WorkerJsonContext.Default.GitExecNativeResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static async Task<WorkerResponse> ScanRepositoriesAsync(JsonElement parameters)
    {
        try
        {
            var target = ReadTarget(parameters);
            var rawRootPath = JsonHelpers.GetString(parameters, "rootPath") ?? target.Cwd;
            var rootPath = target.IsSsh
                ? NormalizeRemoteScanRoot(rawRootPath)
                : Path.GetFullPath(rawRootPath);
            target = target with { Cwd = rootPath };
            var maxDepth = JsonHelpers.GetInt(parameters, "maxDepth", DefaultScanDepth);
            var excluded = new HashSet<string>(ExcludedDirs, StringComparer.OrdinalIgnoreCase);
            foreach (var dir in JsonHelpers.GetStringArray(parameters, "excludeDirs"))
            {
                excluded.Add(dir);
            }

            var repositories = new List<GitRepositorySummary>();
            var queue = new Queue<(string CurrentPath, int Depth)>();
            queue.Enqueue((rootPath, 0));

            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                var currentTarget = target with { Cwd = current.CurrentPath };
                if (await IsGitRepositoryAsync(currentTarget))
                {
                    repositories.Add(new GitRepositorySummary(
                        target.IsSsh ? PosixBasename(current.CurrentPath) : Path.GetFileName(current.CurrentPath),
                        current.CurrentPath,
                        current.CurrentPath == rootPath
                            ? "."
                            : target.IsSsh
                                ? PosixRelative(rootPath, current.CurrentPath)
                                : NormalizeSeparators(Path.GetRelativePath(rootPath, current.CurrentPath)),
                        await GetCurrentBranchAsync(currentTarget),
                        current.CurrentPath == rootPath,
                        target.SshConnectionId));
                    continue;
                }

                if (current.Depth >= maxDepth)
                {
                    continue;
                }

                IEnumerable<string> directories;
                if (target.IsSsh)
                {
                    directories = await ReadRemoteDirectoriesAsync(target, current.CurrentPath);
                }
                else
                {
                    try
                    {
                        directories = Directory.EnumerateDirectories(current.CurrentPath);
                    }
                    catch
                    {
                        continue;
                    }
                }

                foreach (var directory in directories)
                {
                    var name = target.IsSsh ? PosixBasename(directory) : Path.GetFileName(directory);
                    if (excluded.Contains(name))
                    {
                        continue;
                    }
                    queue.Enqueue((directory, current.Depth + 1));
                }
            }

            repositories.Sort((left, right) => string.Compare(left.RelativePath, right.RelativePath, StringComparison.OrdinalIgnoreCase));
            return WorkerResponse.Json(repositories, WorkerJsonContext.Default.ListGitRepositorySummary);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static async Task<WorkerResponse> StatusDetailedAsync(JsonElement parameters)
    {
        var target = ReadTarget(parameters);
        var result = await ExecGitAsync(target, new[] { "status", "--porcelain=v1", "-b" });
        if (!result.Success)
        {
            return WorkerResponse.Json(
                NativeGitStatusDetailedResult.Fail(result, "Failed to get detailed status"),
                WorkerJsonContext.Default.NativeGitStatusDetailedResult);
        }

        return WorkerResponse.Json(
            new NativeGitStatusDetailedResult(true, ParseStatusDetailed(result.Stdout), null, null, null, null, null),
            WorkerJsonContext.Default.NativeGitStatusDetailedResult);
    }

    public static Task<WorkerResponse> QueryLocalAsync(JsonElement parameters)
    {
        return QueryAsync(parameters);
    }

    public static async Task<WorkerResponse> QueryAsync(JsonElement parameters)
    {
        try
        {
            var target = ReadTarget(parameters);
            var operation = JsonHelpers.GetString(parameters, "operation") ?? string.Empty;

            NativeGitQueryResult result = operation switch
            {
                "get-head" => await GetHeadAsync(target),
                "get-range-commits" => await GetRangeCommitsAsync(target, parameters),
                "get-changed-files" => await GetChangedFilesAsync(target, parameters),
                "get-status" => await GetStatusAsync(target),
                "get-line-summary" => await GetLineSummaryAsync(target),
                "get-file-diff" => await GetFileDiffAsync(target, parameters),
                "get-file-diff-at-commit" => await GetFileDiffAtCommitAsync(target, parameters),
                "get-file-content-at-ref" => await GetFileContentAtRefAsync(target, parameters),
                "get-staged-diff-bundle" => await GetStagedDiffBundleAsync(target, parameters),
                "get-commit-history" => await GetCommitHistoryAsync(target, parameters),
                "list-branches" => await ListBranchesAsync(target),
                "get-file-history" => await GetFileHistoryAsync(target, parameters),
                _ => NativeGitQueryResult.Failure($"Unsupported git query operation: {operation}")
            };

            return WorkerResponse.Json(result, WorkerJsonContext.Default.NativeGitQueryResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                NativeGitQueryResult.Failure(ex.Message),
                WorkerJsonContext.Default.NativeGitQueryResult);
        }
    }

    private static async Task<NativeGitQueryResult> GetHeadAsync(GitTarget target)
    {
        var result = await ExecGitAsync(target, new[] { "rev-parse", "HEAD" });
        return result.Success
            ? new NativeGitQueryResult { Success = true, CommitId = result.Stdout.Trim() }
            : NativeGitQueryResult.Failure(result, "Failed to get HEAD");
    }

    private static async Task<NativeGitQueryResult> GetRangeCommitsAsync(GitTarget target, JsonElement parameters)
    {
        var range = BuildRange(parameters);
        if (range.Error is not null)
        {
            return NativeGitQueryResult.Failure(range.Error);
        }

        var result = await ExecGitAsync(
            target,
            new[] { "log", "--format=%H", range.Value },
            maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success
            ? new NativeGitQueryResult { Success = true, Commits = NormalizeLines(result.Stdout) }
            : NativeGitQueryResult.Failure(result, "Failed to get commit range");
    }

    private static async Task<NativeGitQueryResult> GetChangedFilesAsync(GitTarget target, JsonElement parameters)
    {
        var range = BuildRange(parameters);
        if (range.Error is not null)
        {
            return NativeGitQueryResult.Failure(range.Error);
        }

        var result = await ExecGitAsync(
            target,
            new[] { "diff", "--name-only", range.Value },
            maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success
            ? new NativeGitQueryResult { Success = true, Files = NormalizeLines(result.Stdout) }
            : NativeGitQueryResult.Failure(result, "Failed to get changed files");
    }

    private static async Task<NativeGitQueryResult> GetStatusAsync(GitTarget target)
    {
        var result = await ExecGitAsync(
            target,
            new[] { "status", "--short" },
            maxStdoutChars: DefaultLargeGitOutputChars);
        if (!result.Success)
        {
            return NativeGitQueryResult.Failure(result, "Failed to get git status");
        }

        var files = NormalizeLines(result.Stdout);
        return new NativeGitQueryResult { Success = true, Files = files, Dirty = files.Count > 0 };
    }

    private static async Task<NativeGitQueryResult> GetFileDiffAsync(GitTarget target, JsonElement parameters)
    {
        var filePath = JsonHelpers.GetString(parameters, "filePath");
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return NativeGitQueryResult.Failure("filePath is required");
        }

        var staged = JsonHelpers.GetBool(parameters, "staged", false);
        var args = staged
            ? new[] { "diff", "--cached", "--no-color", "--", filePath }
            : new[] { "diff", "--no-color", "--", filePath };
        var result = await ExecGitAsync(target, args, maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success
            ? new NativeGitQueryResult
            {
                Success = true,
                Diff = result.Stdout,
                IsBinary = result.Stdout.Contains("Binary files", StringComparison.Ordinal)
            }
            : NativeGitQueryResult.Failure(result, "Failed to get file diff");
    }

    private static async Task<NativeGitQueryResult> GetLineSummaryAsync(GitTarget target)
    {
        var unstagedTask = ExecGitAsync(
            target,
            new[] { "diff", "--numstat", "--no-color" },
            maxStdoutChars: DefaultLargeGitOutputChars);
        var stagedTask = ExecGitAsync(
            target,
            new[] { "diff", "--cached", "--numstat", "--no-color" },
            maxStdoutChars: DefaultLargeGitOutputChars);

        await Task.WhenAll(unstagedTask, stagedTask);
        var unstaged = await unstagedTask;
        var staged = await stagedTask;
        if (!unstaged.Success)
        {
            return NativeGitQueryResult.Failure(unstaged, "Failed to get git line summary");
        }
        if (!staged.Success)
        {
            return NativeGitQueryResult.Failure(staged, "Failed to get git line summary");
        }

        var unstagedSummary = ParseNumstatSummary(unstaged.Stdout);
        var stagedSummary = ParseNumstatSummary(staged.Stdout);
        return new NativeGitQueryResult
        {
            Success = true,
            Added = unstagedSummary.Added + stagedSummary.Added,
            Deleted = unstagedSummary.Deleted + stagedSummary.Deleted,
            Binary = unstagedSummary.Binary + stagedSummary.Binary
        };
    }

    private static async Task<NativeGitQueryResult> GetFileDiffAtCommitAsync(GitTarget target, JsonElement parameters)
    {
        var filePath = JsonHelpers.GetString(parameters, "filePath");
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return NativeGitQueryResult.Failure("filePath is required");
        }

        var hash = JsonHelpers.GetString(parameters, "commitHash")?.Trim();
        if (string.IsNullOrWhiteSpace(hash))
        {
            return NativeGitQueryResult.Failure("commitHash is required");
        }

        var result = await ExecGitAsync(
            target,
            new[] { "show", "--no-color", "--pretty=format:", "--no-notes", hash, "--", filePath },
            maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success
            ? new NativeGitQueryResult
            {
                Success = true,
                Diff = result.Stdout,
                IsBinary = result.Stdout.Contains("Binary files", StringComparison.Ordinal)
            }
            : NativeGitQueryResult.Failure(result, "Failed to get file diff at commit");
    }

    private static async Task<NativeGitQueryResult> GetFileContentAtRefAsync(GitTarget target, JsonElement parameters)
    {
        var filePath = JsonHelpers.GetString(parameters, "filePath");
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return NativeGitQueryResult.Failure("filePath is required");
        }

        var gitRef = JsonHelpers.GetString(parameters, "ref")?.Trim() ?? string.Empty;
        var objectExpr = $"{gitRef}:{filePath}";
        var result = await ExecGitAsync(
            target,
            new[] { "show", objectExpr },
            maxStdoutChars: DefaultLargeGitOutputChars);
        if (!result.Success)
        {
            var stderr = result.Stderr.ToLowerInvariant();
            var missing = stderr.Contains("does not exist", StringComparison.Ordinal)
                || stderr.Contains("exists on disk, but not in", StringComparison.Ordinal)
                || stderr.Contains("invalid object name", StringComparison.Ordinal);
            return missing
                ? new NativeGitQueryResult { Success = true, Content = string.Empty, Exists = false, IsBinary = false }
                : NativeGitQueryResult.Failure(result, "Failed to read file content at ref");
        }

        return new NativeGitQueryResult
        {
            Success = true,
            Content = result.Stdout,
            Exists = true,
            IsBinary = result.Stdout.IndexOf('\0', StringComparison.Ordinal) >= 0
        };
    }

    private static async Task<NativeGitQueryResult> GetStagedDiffBundleAsync(GitTarget target, JsonElement parameters)
    {
        var maxPatchChars = Math.Clamp(
            JsonHelpers.GetInt(parameters, "maxPatchChars", DefaultMaxPatchChars),
            1,
            MaxPatchChars);
        var statResult = await ExecGitAsync(
            target,
            new[] { "diff", "--cached", "--stat" },
            maxStdoutChars: 128 * 1024);
        if (!statResult.Success)
        {
            return NativeGitQueryResult.Failure(statResult, "Failed to read staged diff stat");
        }

        var statText = statResult.Stdout.Trim();
        if (string.IsNullOrEmpty(statText))
        {
            return new NativeGitQueryResult { Success = true, Stat = string.Empty, Patch = string.Empty, Empty = true };
        }

        var patchResult = await ExecGitAsync(
            target,
            new[] { "diff", "--cached", "--no-color" },
            maxStdoutChars: maxPatchChars + 1);
        if (!patchResult.Success)
        {
            return NativeGitQueryResult.Failure(patchResult, "Failed to read staged patch");
        }

        var patch = patchResult.Stdout;
        if (patchResult.StdoutTruncated || patch.Length > maxPatchChars)
        {
            patch = patch[..Math.Min(maxPatchChars, patch.Length)] + PatchTruncatedSuffix;
        }

        return new NativeGitQueryResult { Success = true, Stat = statText, Patch = patch, Empty = false };
    }

    private static async Task<NativeGitQueryResult> GetCommitHistoryAsync(GitTarget target, JsonElement parameters)
    {
        var limit = ClampHistoryLimit(JsonHelpers.GetInt(parameters, "limit", DefaultHistoryLimit));
        var skip = Math.Max(0, JsonHelpers.GetInt(parameters, "skip", 0));
        var format = string.Join(HistorySeparator, "%H", "%h", "%an", "%ae", "%ad", "%s");
        var result = await ExecGitAsync(
            target,
            new[]
            {
                "log", "--date=iso", $"--pretty=format:{format}", $"--max-count={limit}", $"--skip={skip}"
            },
            maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success
            ? new NativeGitQueryResult { Success = true, History = ParseCommitHistory(result.Stdout) }
            : NativeGitQueryResult.Failure(result, "Failed to get commit history");
    }

    private static async Task<NativeGitQueryResult> GetFileHistoryAsync(GitTarget target, JsonElement parameters)
    {
        var filePath = JsonHelpers.GetString(parameters, "filePath");
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return NativeGitQueryResult.Failure("filePath is required");
        }

        var limit = ClampHistoryLimit(JsonHelpers.GetInt(parameters, "limit", DefaultHistoryLimit));
        var skip = Math.Max(0, JsonHelpers.GetInt(parameters, "skip", 0));
        var format = string.Join(HistorySeparator, "%H", "%h", "%an", "%ae", "%ad", "%s");
        var result = await ExecGitAsync(
            target,
            new[]
            {
                "log", "--date=iso", $"--pretty=format:{format}", $"--max-count={limit}", $"--skip={skip}",
                "--", filePath
            },
            maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success
            ? new NativeGitQueryResult { Success = true, History = ParseCommitHistory(result.Stdout) }
            : NativeGitQueryResult.Failure(result, "Failed to get file history");
    }

    private static async Task<NativeGitQueryResult> ListBranchesAsync(GitTarget target)
    {
        var format = "%(refname)" + StatusSeparator + "%(refname:short)" + StatusSeparator + "%(HEAD)";
        var localTask = ExecGitAsync(
            target,
            new[] { "for-each-ref", "--format", format, "refs/heads" },
            maxStdoutChars: DefaultLargeGitOutputChars);
        var remoteTask = ExecGitAsync(
            target,
            new[] { "for-each-ref", "--format", format, "refs/remotes" },
            maxStdoutChars: DefaultLargeGitOutputChars);
        await Task.WhenAll(localTask, remoteTask);

        var localResult = await localTask;
        var remoteResult = await remoteTask;
        if (!localResult.Success)
        {
            return NativeGitQueryResult.Failure(localResult, "Failed to list local branches");
        }
        if (!remoteResult.Success)
        {
            return NativeGitQueryResult.Failure(remoteResult, "Failed to list remote branches");
        }

        var branches = new List<GitBranchItem>();
        branches.AddRange(ParseBranches(localResult.Stdout, "local"));
        branches.AddRange(ParseBranches(remoteResult.Stdout, "remote"));
        var current = branches.FirstOrDefault(branch => branch.IsCurrent)?.Name;
        return new NativeGitQueryResult { Success = true, Branches = branches, Current = current };
    }

    private static async Task<bool> IsGitRepositoryAsync(GitTarget target)
    {
        var result = await ExecGitAsync(target, new[] { "rev-parse", "--is-inside-work-tree" });
        return result.Success && result.Stdout.Trim() == "true";
    }

    private static async Task<string> GetCurrentBranchAsync(GitTarget target)
    {
        var result = await ExecGitAsync(target, new[] { "rev-parse", "--abbrev-ref", "HEAD" });
        return result.Success ? result.Stdout.Trim() : "HEAD";
    }

    private static GitTarget ReadTarget(JsonElement parameters)
    {
        var cwd = JsonHelpers.GetString(parameters, "cwd") ?? Environment.CurrentDirectory;
        var hasConnection = parameters.TryGetProperty("connection", out var connection) &&
            connection.ValueKind == JsonValueKind.Object;
        var sshConnectionId = hasConnection
            ? JsonHelpers.GetString(connection, "id") ?? JsonHelpers.GetString(parameters, "sshConnectionId")
            : null;
        return new GitTarget(cwd, parameters, hasConnection, sshConnectionId);
    }

    private static async Task<GitExecNativeResult> ExecGitAsync(
        GitTarget target,
        IReadOnlyList<string> args,
        int timeoutMs = DefaultGitTimeoutMs,
        int maxStdoutChars = DefaultMaxStdoutChars,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        if (!target.IsSsh)
        {
            return await ExecGitLocalAsync(
                new[] { "-C", target.Cwd }.Concat(args).ToArray(),
                target.Cwd,
                timeoutMs,
                maxStdoutChars,
                maxStderrChars);
        }

        var renderedArgs = string.Join(" ", args.Select(SshOpenSsh.ShellEscape));
        var command = $"git -C {SshOpenSsh.ShellPathExpr(target.Cwd)} {renderedArgs}";
        return await ExecSshShellAsync(target, command, timeoutMs, maxStdoutChars, maxStderrChars);
    }

    private static async Task<GitExecNativeResult> ExecSshShellAsync(
        GitTarget target,
        string command,
        int timeoutMs = DefaultGitTimeoutMs,
        int maxStdoutChars = DefaultMaxStdoutChars,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        try
        {
            var result = await SshOpenSsh.ExecuteAsync(
                target.Parameters,
                command,
                timeoutMs,
                maxStdoutChars: maxStdoutChars,
                maxStderrChars: maxStderrChars);
            var exitCode = result.TimedOut ? 124 : result.ExitCode;
            var normalized = result.TimedOut
                ? ("SSH_DISCONNECTED", "Git SSH command timed out")
                : NormalizeGitError(result.Stderr, exitCode, "SSH_DISCONNECTED");
            return new GitExecNativeResult(
                exitCode == 0 && !result.TimedOut,
                result.Stdout,
                normalized.Item2,
                exitCode,
                normalized.Item1,
                false,
                false);
        }
        catch (Exception ex)
        {
            return new GitExecNativeResult(false, string.Empty, ex.Message, 1, "SSH_DISCONNECTED", false, false);
        }
    }

    private static async Task<List<string>> ReadRemoteDirectoriesAsync(GitTarget target, string remotePath)
    {
        var result = await ExecSshShellAsync(
            target,
            $"find {SshOpenSsh.ShellPathExpr(remotePath)} -mindepth 1 -maxdepth 1 -type d -print",
            15_000,
            maxStdoutChars: DefaultLargeGitOutputChars);
        return result.Success ? NormalizeLines(result.Stdout) : [];
    }

    private static async Task<GitExecNativeResult> ExecGitLocalAsync(
        IReadOnlyList<string> args,
        string cwd,
        int timeoutMs = DefaultGitTimeoutMs,
        int maxStdoutChars = DefaultMaxStdoutChars,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var arg in args)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            return new GitExecNativeResult(false, string.Empty, ex.Message, 1, "UNKNOWN", false, false);
        }

        using var cts = new CancellationTokenSource(Math.Max(1_000, timeoutMs));
        var stdoutTask = ReadLimitedAsync(process.StandardOutput, maxStdoutChars, cts.Token);
        var stderrTask = ReadLimitedAsync(process.StandardError, maxStderrChars, cts.Token);
        var timedOut = false;

        try
        {
            await process.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            timedOut = true;
            TryKill(process);
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        var exitCode = timedOut ? 124 : process.ExitCode;
        var normalized = timedOut
            ? ("UNKNOWN", "Git command timed out")
            : NormalizeGitError(stderr.Text, exitCode, "UNKNOWN");

        return new GitExecNativeResult(
            exitCode == 0 && !timedOut,
            stdout.Text,
            normalized.Item2,
            exitCode,
            normalized.Item1,
            stdout.Truncated,
            stderr.Truncated);
    }

    private static async Task<(string Text, bool Truncated)> ReadLimitedAsync(TextReader reader, int maxChars, CancellationToken cancellationToken)
    {
        var builder = new StringBuilder(Math.Min(Math.Max(maxChars, 0), 16_384));
        var buffer = new char[8192];
        var truncated = false;

        while (true)
        {
            int read;
            try
            {
                read = await reader.ReadAsync(buffer, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            if (read <= 0)
            {
                break;
            }

            var remaining = maxChars - builder.Length;
            if (remaining > 0)
            {
                builder.Append(buffer, 0, Math.Min(remaining, read));
            }
            if (read > remaining)
            {
                truncated = true;
            }
        }

        return (builder.ToString(), truncated);
    }

    private static (string? ErrorType, string Message) NormalizeGitError(string stderr, int exitCode, string defaultType)
    {
        var message = stderr.Trim();
        var lower = message.ToLowerInvariant();
        if (lower.Contains("not a git repository"))
        {
            return ("NOT_GIT_REPO", message);
        }
        if (lower.Contains("authentication failed") || lower.Contains("could not read from remote repository"))
        {
            return ("AUTH_REQUIRED", message);
        }
        if (lower.Contains("merge conflict") || lower.Contains("conflict"))
        {
            return ("MERGE_CONFLICT", message);
        }
        if (lower.Contains("unstaged changes") || lower.Contains("would be overwritten"))
        {
            return ("UNCOMMITTED_CHANGES_BLOCKING", message);
        }
        if (lower.Contains("non-fast-forward"))
        {
            return ("NON_FAST_FORWARD", message);
        }
        return (exitCode == 0 ? null : defaultType, string.IsNullOrEmpty(message) ? "Git command failed" : message);
    }

    private static GitStatusDetailed ParseStatusDetailed(string output)
    {
        var rawLines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.TrimEnd('\r'))
            .ToArray();
        var header = rawLines.Length > 0 && rawLines[0].StartsWith("## ", StringComparison.Ordinal)
            ? ParseAheadBehind(rawLines[0])
            : ParseAheadBehind("## HEAD");
        var body = rawLines.Length > 0 && rawLines[0].StartsWith("## ", StringComparison.Ordinal)
            ? rawLines.Skip(1)
            : rawLines;

        var staged = new List<GitStatusFile>();
        var unstaged = new List<GitStatusFile>();
        var untracked = new List<GitStatusFile>();
        var conflicted = new List<GitStatusFile>();

        foreach (var line in body)
        {
            if (line.Length < 3)
            {
                continue;
            }

            var stagedStatus = line[0].ToString();
            var unstagedStatus = line[1].ToString();
            var rawPath = line[3..];
            var renameParts = rawPath.Split(" -> ");
            var filePath = renameParts[^1];
            var originalPath = renameParts.Length > 1 ? renameParts[0] : null;
            var item = new GitStatusFile(filePath, stagedStatus, unstagedStatus, originalPath);

            if (stagedStatus == "?" && unstagedStatus == "?")
            {
                untracked.Add(item);
                continue;
            }

            if ("UADRC".Contains(stagedStatus) && "UADRC".Contains(unstagedStatus) && (stagedStatus == "U" || unstagedStatus == "U"))
            {
                conflicted.Add(item);
                continue;
            }

            if (stagedStatus != " ")
            {
                staged.Add(item);
            }
            if (unstagedStatus != " ")
            {
                unstaged.Add(item);
            }
        }

        return new GitStatusDetailed(header.Branch, header.Upstream, header.Ahead, header.Behind, staged, unstaged, untracked, conflicted);
    }

    private static (string Branch, string? Upstream, int Ahead, int Behind) ParseAheadBehind(string header)
    {
        var match = Regex.Match(header, @"^##\s+([^.]+?)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$");
        var branch = match.Success ? match.Groups[1].Value : "HEAD";
        var upstream = match.Success && match.Groups[2].Success ? match.Groups[2].Value : null;
        var details = match.Success && match.Groups[3].Success ? match.Groups[3].Value : string.Empty;
        var ahead = 0;
        var behind = 0;
        foreach (var part in details.Split(','))
        {
            var value = part.Trim();
            var aheadMatch = Regex.Match(value, @"^ahead\s+(\d+)$");
            var behindMatch = Regex.Match(value, @"^behind\s+(\d+)$");
            if (aheadMatch.Success)
            {
                ahead = int.Parse(aheadMatch.Groups[1].Value);
            }
            if (behindMatch.Success)
            {
                behind = int.Parse(behindMatch.Groups[1].Value);
            }
        }
        return (branch, upstream, ahead, behind);
    }

    private static (string Value, string? Error) BuildRange(JsonElement parameters)
    {
        var gitBase = JsonHelpers.GetString(parameters, "base")?.Trim();
        if (string.IsNullOrWhiteSpace(gitBase))
        {
            return (string.Empty, "base is required");
        }
        var head = JsonHelpers.GetString(parameters, "head")?.Trim();
        if (string.IsNullOrWhiteSpace(head))
        {
            head = "HEAD";
        }
        return ($"{gitBase}..{head}", null);
    }

    private static List<string> NormalizeLines(string text)
    {
        return text
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim().TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToList();
    }

    private static (int Added, int Deleted, int Binary) ParseNumstatSummary(string output)
    {
        var added = 0;
        var deleted = 0;
        var binary = 0;

        foreach (var line in NormalizeLines(output))
        {
            var parts = line.Split('\t', 3, StringSplitOptions.None);
            if (parts.Length < 2)
            {
                continue;
            }

            if (parts[0] == "-" || parts[1] == "-")
            {
                binary++;
                continue;
            }

            if (int.TryParse(parts[0], out var addedValue))
            {
                added += addedValue;
            }
            if (int.TryParse(parts[1], out var deletedValue))
            {
                deleted += deletedValue;
            }
        }

        return (added, deleted, binary);
    }

    private static int ClampHistoryLimit(int limit)
    {
        return Math.Clamp(limit, 1, MaxHistoryLimit);
    }

    private static List<GitCommitHistoryItem> ParseCommitHistory(string output)
    {
        var history = new List<GitCommitHistoryItem>();
        foreach (var line in NormalizeLines(output))
        {
            var parts = line.Split(HistorySeparator, 6, StringSplitOptions.None);
            history.Add(new GitCommitHistoryItem(
                parts.Length > 0 ? parts[0] : string.Empty,
                parts.Length > 1 ? parts[1] : string.Empty,
                parts.Length > 2 ? parts[2] : string.Empty,
                parts.Length > 3 ? parts[3] : string.Empty,
                parts.Length > 4 ? parts[4] : string.Empty,
                parts.Length > 5 ? parts[5] : string.Empty));
        }
        return history;
    }

    private static List<GitBranchItem> ParseBranches(string output, string type)
    {
        var branches = new List<GitBranchItem>();
        foreach (var line in NormalizeLines(output))
        {
            var parts = line.Split(StatusSeparator, 3, StringSplitOptions.None);
            branches.Add(new GitBranchItem(
                parts.Length > 1 ? parts[1] : string.Empty,
                parts.Length > 0 ? parts[0] : string.Empty,
                type,
                parts.Length > 2 && parts[2] == "*"));
        }
        return branches;
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
            // best effort
        }
    }

    private static string NormalizeRemoteScanRoot(string rootPath)
    {
        var trimmed = rootPath.Trim().Replace('\\', '/');
        if (string.IsNullOrEmpty(trimmed))
        {
            return trimmed;
        }

        return trimmed.StartsWith("/", StringComparison.Ordinal) || trimmed.StartsWith("~/", StringComparison.Ordinal)
            ? trimmed
            : "/" + trimmed;
    }

    private static string PosixBasename(string value)
    {
        var trimmed = value.TrimEnd('/');
        if (string.IsNullOrEmpty(trimmed))
        {
            return "/";
        }

        var slash = trimmed.LastIndexOf('/');
        return slash >= 0 ? trimmed[(slash + 1)..] : trimmed;
    }

    private static string PosixRelative(string rootPath, string currentPath)
    {
        var root = rootPath.TrimEnd('/');
        if (currentPath == rootPath || currentPath == root)
        {
            return ".";
        }

        var prefix = root + "/";
        return currentPath.StartsWith(prefix, StringComparison.Ordinal)
            ? currentPath[prefix.Length..]
            : currentPath;
    }

    private static string NormalizeSeparators(string value)
    {
        return value.Replace('\\', '/');
    }
}
