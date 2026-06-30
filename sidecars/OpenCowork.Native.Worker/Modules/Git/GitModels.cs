internal sealed record GitExecNativeResult(
    bool Success,
    string Stdout,
    string Stderr,
    int ExitCode,
    string? ErrorType,
    bool StdoutTruncated,
    bool StderrTruncated);

internal sealed record GitRepositorySummary(
    string Name,
    string FullPath,
    string RelativePath,
    string Branch,
    bool IsRootRepo,
    string? SshConnectionId);

internal sealed record GitStatusFile(
    string Path,
    string StagedStatus,
    string UnstagedStatus,
    string? OriginalPath);

internal sealed record GitStatusDetailed(
    string Branch,
    string? Upstream,
    int Ahead,
    int Behind,
    List<GitStatusFile> Staged,
    List<GitStatusFile> Unstaged,
    List<GitStatusFile> Untracked,
    List<GitStatusFile> Conflicted);

internal sealed record NativeGitStatusDetailedResult(
    bool Success,
    GitStatusDetailed? Status,
    string? Error,
    string? ErrorType,
    int? ExitCode,
    string? Stdout,
    string? Stderr)
{
    public static NativeGitStatusDetailedResult Fail(GitExecNativeResult result, string fallback)
    {
        return new NativeGitStatusDetailedResult(
            false,
            null,
            string.IsNullOrWhiteSpace(result.Stderr) ? fallback : result.Stderr,
            result.ErrorType ?? "UNKNOWN",
            result.ExitCode,
            result.Stdout,
            result.Stderr);
    }
}

internal sealed class NativeGitQueryResult
{
    public bool Success { get; init; }
    public string? CommitId { get; init; }
    public List<string>? Commits { get; init; }
    public List<string>? Files { get; init; }
    public bool? Dirty { get; init; }
    public string? Diff { get; init; }
    public bool? IsBinary { get; init; }
    public string? Content { get; init; }
    public bool? Exists { get; init; }
    public string? Stat { get; init; }
    public string? Patch { get; init; }
    public bool? Empty { get; init; }
    public List<GitCommitHistoryItem>? History { get; init; }
    public List<GitBranchItem>? Branches { get; init; }
    public string? Current { get; init; }
    public int? Added { get; init; }
    public int? Deleted { get; init; }
    public int? Binary { get; init; }
    public string? Error { get; init; }
    public string? ErrorType { get; init; }
    public int? ExitCode { get; init; }
    public string? Stdout { get; init; }
    public string? Stderr { get; init; }

    public static NativeGitQueryResult Failure(string error, string errorType = "UNKNOWN")
    {
        return new NativeGitQueryResult
        {
            Success = false,
            Error = error,
            ErrorType = errorType
        };
    }

    public static NativeGitQueryResult Failure(GitExecNativeResult result, string fallback)
    {
        return new NativeGitQueryResult
        {
            Success = false,
            Error = string.IsNullOrWhiteSpace(result.Stderr) ? fallback : result.Stderr,
            ErrorType = result.ErrorType ?? "UNKNOWN",
            ExitCode = result.ExitCode,
            Stdout = result.Stdout,
            Stderr = result.Stderr
        };
    }
}

internal sealed record GitCommitHistoryItem(
    string Hash,
    string ShortHash,
    string Author,
    string Email,
    string Date,
    string Subject);

internal sealed record GitBranchItem(
    string Name,
    string FullName,
    string Type,
    bool IsCurrent);
