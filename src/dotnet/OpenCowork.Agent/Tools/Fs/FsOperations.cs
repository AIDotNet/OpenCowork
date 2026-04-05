using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.FileSystemGlobbing;

namespace OpenCowork.Agent.Tools.Fs;

/// <summary>
/// Core filesystem operations: read, write, list, mkdir, delete, move.
/// </summary>
public static class FsOperations
{
    public const int MaxReadLines = 2000;

    public static async Task<string> ReadFileAsync(string path, int? offset = null,
        int? limit = null, CancellationToken ct = default)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        var content = await File.ReadAllTextAsync(path, ct);
        return FormatReadOutput(content, offset, limit);
    }

    public static string FormatReadOutput(string content, int? offset = null, int? limit = null)
    {
        var normalized = content.Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n');
        var start = Math.Max(0, (offset ?? 1) - 1);
        var maxCount = limit ?? MaxReadLines;
        var count = Math.Max(0, Math.Min(maxCount, MaxReadLines));

        if (start >= lines.Length)
            return string.Empty;

        var end = Math.Min(start + count, lines.Length);
        var width = Math.Max(6, end.ToString().Length);
        var sb = new StringBuilder();
        for (var i = start; i < end; i++)
        {
            sb.Append((i + 1).ToString().PadLeft(width))
              .Append('\t')
              .Append(lines[i]);
            if (i < end - 1)
                sb.Append('\n');
        }
        return sb.ToString();
    }

    public static string ReadFileRaw(string path)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        return File.ReadAllText(path);
    }
    public static void RecordRead(string path, IDictionary<string, DateTimeOffset>? readHistory)
    {
        if (readHistory is null) return;
        readHistory[Path.GetFullPath(path)] = DateTimeOffset.UtcNow;
    }

    public static string ReplaceExact(string content, string oldString, string newString, bool replaceAll)
    {
        if (string.IsNullOrEmpty(oldString))
            throw new InvalidOperationException("old_string must be non-empty");

        var occurrences = CountOccurrences(content, oldString);
        if (occurrences == 0)
            throw new InvalidOperationException("old_string not found in file");

        if (!replaceAll && occurrences > 1)
            throw new InvalidOperationException("old_string is not unique in file");

        return replaceAll
            ? content.Replace(oldString, newString, StringComparison.Ordinal)
            : ReplaceFirst(content, oldString, newString);
    }

    public static IReadOnlyList<(string Text, string Eol)> BuildOldStringVariants(string oldString, string fileContent)
    {
        var variants = new List<(string Text, string Eol)>
        {
            (oldString, DetectEolStyle(oldString))
        };

        var fileHasCrlf = fileContent.Contains("\r\n", StringComparison.Ordinal);
        var fileHasOnlyLf = !fileHasCrlf;

        if (oldString.Contains('\n') && !oldString.Contains('\r') && fileHasCrlf)
        {
            variants.Add((oldString.Replace("\n", "\r\n", StringComparison.Ordinal), "\r\n"));
        }
        else if (oldString.Contains("\r\n", StringComparison.Ordinal) && fileHasOnlyLf)
        {
            variants.Add((oldString.Replace("\r\n", "\n", StringComparison.Ordinal), "\n"));
        }

        return variants;
    }

    public static string DetectEolStyle(string value)
    {
        if (value.Contains("\r\n", StringComparison.Ordinal)) return "\r\n";
        if (value.Contains('\r')) return "\r";
        return "\n";
    }

    public static string ApplyEolStyle(string value, string eol)
    {
        var normalized = value.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        return eol == "\n" ? normalized : normalized.Replace("\n", eol, StringComparison.Ordinal);
    }

    public static JsonObject BuildReadMetadata(string path, string content, int? offset = null, int? limit = null)
    {
        var normalized = content.Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n');
        var start = Math.Max(0, (offset ?? 1) - 1);
        var maxCount = limit ?? MaxReadLines;
        var count = Math.Max(0, Math.Min(maxCount, MaxReadLines));
        var end = Math.Min(start + count, lines.Length);

        return new JsonObject
        {
            ["path"] = Path.GetFullPath(path),
            ["line_count"] = lines.Length,
            ["offset"] = offset ?? 1,
            ["limit"] = count,
            ["returned_first_line"] = end > start ? start + 1 : null,
            ["returned_last_line"] = end > start ? end : null
        };
    }

    public static async Task WriteFileAsync(string path, string content,
        CancellationToken ct = default)
    {
        var dir = Path.GetDirectoryName(path);
        if (dir is not null && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        await File.WriteAllTextAsync(path, content, ct);
    }

    private static int CountOccurrences(string content, string value)
    {
        if (string.IsNullOrEmpty(value)) return 0;

        var count = 0;
        var index = 0;
        while (true)
        {
            index = content.IndexOf(value, index, StringComparison.Ordinal);
            if (index < 0) break;
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string ReplaceFirst(string content, string oldString, string newString)
    {
        var index = content.IndexOf(oldString, StringComparison.Ordinal);
        if (index < 0)
            throw new InvalidOperationException("old_string not found in file");

        return string.Concat(content.AsSpan(0, index), newString, content.AsSpan(index + oldString.Length));
    }

    public static List<FsEntry> ListDirectory(string path, bool showHidden = false, IEnumerable<string>? ignore = null)
    {
        var dir = new DirectoryInfo(path);
        if (!dir.Exists)
            throw new DirectoryNotFoundException($"Directory not found: {path}");

        var entries = new List<FsEntry>();
        var ignoreMatcher = BuildIgnoreMatcher(ignore);

        foreach (var d in dir.EnumerateDirectories())
        {
            if (!showHidden && d.Name.StartsWith('.')) continue;
            if (ShouldIgnoreDir(d.Name)) continue;
            if (ShouldIgnoreEntry(ignoreMatcher, d.Name, isDirectory: true)) continue;

            entries.Add(new FsEntry
            {
                Name = d.Name,
                Type = "directory",
                Size = null,
                ModifiedAt = new DateTimeOffset(d.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            });
        }

        foreach (var f in dir.EnumerateFiles())
        {
            if (!showHidden && f.Name.StartsWith('.')) continue;
            if (ShouldIgnoreEntry(ignoreMatcher, f.Name, isDirectory: false)) continue;

            entries.Add(new FsEntry
            {
                Name = f.Name,
                Type = "file",
                Size = f.Length,
                ModifiedAt = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            });
        }

        return entries;
    }

    public static void CreateDirectory(string path)
    {
        Directory.CreateDirectory(path);
    }

    public static void Delete(string path)
    {
        if (File.Exists(path))
            File.Delete(path);
        else if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
        else
            throw new FileNotFoundException($"Path not found: {path}");
    }

    public static void Move(string source, string destination)
    {
        if (File.Exists(source))
            File.Move(source, destination, overwrite: true);
        else if (Directory.Exists(source))
            Directory.Move(source, destination);
        else
            throw new FileNotFoundException($"Source not found: {source}");
    }

    private static Matcher? BuildIgnoreMatcher(IEnumerable<string>? ignore)
    {
        if (ignore is null)
            return null;

        var matcher = new Matcher(StringComparison.OrdinalIgnoreCase);
        var hasPatterns = false;
        foreach (var pattern in ignore)
        {
            if (string.IsNullOrWhiteSpace(pattern))
                continue;

            hasPatterns = true;
            matcher.AddInclude(pattern.Replace('\\', '/'));
            matcher.AddInclude($"**/{pattern.Replace('\\', '/')}");
        }

        return hasPatterns ? matcher : null;
    }

    private static bool ShouldIgnoreEntry(Matcher? matcher, string name, bool isDirectory)
    {
        if (matcher is null)
            return false;

        var normalized = name.Replace('\\', '/');
        var candidates = isDirectory
            ? new[] { normalized, $"{normalized}/" }
            : new[] { normalized };

        return candidates.Any(candidate => matcher.Match(candidate).HasMatches);
    }

    private static bool ShouldIgnoreDir(string name) =>
        name is "node_modules" or ".git" or "__pycache__" or ".venv";
}

public class FsEntry
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public long? Size { get; init; }
    public long ModifiedAt { get; init; }
}
