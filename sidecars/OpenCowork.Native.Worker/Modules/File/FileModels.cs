internal sealed record ImageReadResult(string Type, string MediaType, string Data);
internal sealed record BinaryReadResult(string Data);
internal sealed record DocumentReadResult(string? Content, string? Name, string? Error);
internal sealed record FileMutationResult(bool Success, string? Error);
internal sealed record FileWriteResult(bool Success, string Op, string? Error);
internal sealed record FileStatResult(bool Exists, string? Type, long? Size, double? MtimeMs, string? Error);
internal sealed record ReadTextLinesResult(string Content, string Name, string Path, int LineCount, int MaxLines, bool Truncated);
internal sealed record ListDirItem(string Name, string Type, string Path);
internal sealed record SearchFileItem(string Path, string Name);
internal sealed record GlobMatchItem(string Path, string? Type);
internal sealed record GlobToolResult(string Kind, List<GlobMatchItem> Matches, SearchMeta Meta, string? Error);
internal sealed record GrepToolResult(string Kind, List<GrepMatchItem> Matches, SearchMeta Meta, string Output, string? Error);
internal sealed record GrepMatchItem(string Path, int? Line, int? Column, string? Text, string? Kind, int? Count);
internal sealed record GrepLineMatchPart(string Text, int Column);
internal sealed record GlobMatchWithTime(string Path, string Type, long MtimeMs);
internal sealed record FileEntry(string Path, bool IsDirectory, long MtimeMs);
internal sealed record SearchMeta(
    string Backend,
    string? Engine,
    string SearchRoot,
    string PathStyle,
    bool Truncated,
    bool TimedOut,
    string? LimitReason,
    string Pattern,
    string? Include,
    string? Exclude,
    string OutputMode,
    bool HiddenIncluded,
    bool IgnoredDefaultsApplied,
    bool RespectGitignore,
    bool FollowSymlinks,
    int? SearchTime,
    string[] Warnings,
    int? MaxDepth,
    int BeforeContext,
    int AfterContext,
    int? MaxResults,
    int? MaxOutputBytes,
    int? MaxLineLength);
