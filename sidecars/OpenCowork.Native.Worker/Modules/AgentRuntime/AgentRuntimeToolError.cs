using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

/// <summary>
/// Formats tool failures for the model and the UI.
///
/// Published workers set UseSystemResourceKeys, so framework exceptions become raw keys
/// such as <c>IO_PathNotFound_Path, /tmp/missing.cs</c>. Those keys must never reach the
/// model. Recoverable tool errors are returned as a <c>&lt;system-remind&gt;</c> block.
/// </summary>
internal static class AgentRuntimeToolError
{
    private const int CorFileNotFound = unchecked((int)0x80070002);
    private const int CorPathNotFound = unchecked((int)0x80070003);
    private const int CorAccessDenied = unchecked((int)0x80070005);
    private const int CorSharingViolation = unchecked((int)0x80070020);
    private const int CorPathTooLong = unchecked((int)0x800700CE);

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private static readonly Regex ResourceKeyPattern = new(
        @"^(?<key>(?:IO|Arg|UnauthorizedAccess|net)_[A-Za-z0-9_]+)(?:,\s*(?<arg>[\s\S]+))?$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly string[] PathPropertyNames =
    [
        "file_path", "notebook_path", "path", "from", "to", "cwd"
    ];

    internal readonly record struct FormattedToolError(string Content, string Display);

    public static bool IsNotFound(Exception ex)
    {
        foreach (var candidate in EnumerateChain(ex))
        {
            if (candidate is FileNotFoundException or DirectoryNotFoundException)
            {
                return true;
            }

            if (candidate is IOException io &&
                (io.HResult == CorFileNotFound || io.HResult == CorPathNotFound))
            {
                return true;
            }

            if (TryParseResourceKey(candidate.Message, out var key, out _) &&
                IsNotFoundKey(key))
            {
                return true;
            }
        }

        return false;
    }

    public static string? TryGetPath(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var name in PathPropertyNames)
        {
            if (!input.TryGetProperty(name, out var value) ||
                value.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var text = value.GetString()?.Trim();
            if (!string.IsNullOrEmpty(text))
            {
                return text;
            }
        }

        return null;
    }

    public static string? TryExtractPath(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return null;
        }

        if (TryParseResourceKey(message, out _, out var arg) &&
            LooksLikePath(arg))
        {
            return arg;
        }

        return null;
    }

    public static string Describe(Exception ex, string? toolName = null, string? path = null)
    {
        var classified = Classify(ex, path);
        return BuildDisplay(classified, toolName);
    }

    public static string Describe(string message, string? path = null)
    {
        var classified = ClassifyMessage(message, path);
        return BuildDisplay(classified, toolName: null);
    }

    public static string Encode(string message, string? toolName = null, string? path = null)
    {
        return Format(message, toolName, path).Content;
    }

    public static string Encode(Exception ex, string? toolName = null, string? path = null)
    {
        return Format(ex, toolName, path).Content;
    }

    public static FormattedToolError Format(string message, string? toolName = null, string? path = null)
    {
        return FormatClassified(ClassifyMessage(message, path), toolName);
    }

    public static FormattedToolError Format(Exception ex, string? toolName = null, string? path = null)
    {
        return FormatClassified(Classify(ex, path), toolName);
    }

    public static RendererToolResult Failed(Exception ex, string? toolName = null, string? path = null)
    {
        var formatted = Format(ex, toolName, path);
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(formatted.Content),
            true,
            formatted.Display);
    }

    public static RendererToolResult Failed(string message, string? toolName = null, string? path = null)
    {
        var formatted = Format(message, toolName, path);
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(formatted.Content),
            true,
            formatted.Display);
    }

    public static RendererToolResult Normalize(
        RendererToolResult result,
        string? toolName,
        string? path,
        bool wrapRemind = true)
    {
        var contentText = TryReadString(result.Content);
        var jsonError = TryReadSoleJsonError(contentText);
        var raw = FirstNonEmpty(result.Error, jsonError, contentText);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return result;
        }

        var isErrorPayload = result.IsError ||
            !string.IsNullOrWhiteSpace(result.Error) ||
            jsonError is not null ||
            LooksLikeResourceKey(raw);
        if (!isErrorPayload)
        {
            return result;
        }

        if (!wrapRemind)
        {
            if (!LooksLikeResourceKey(raw) &&
                !LooksLikeResourceKey(result.Error) &&
                !LooksLikeResourceKey(jsonError))
            {
                return result;
            }

            var display = Describe(raw, path);
            return new RendererToolResult(
                AgentRuntimeProviderSupport.CreateStringElement(EncodeJson(display)),
                result.IsError,
                display);
        }

        if (ContainsRemind(raw) &&
            !LooksLikeResourceKey(result.Error) &&
            !LooksLikeResourceKey(jsonError))
        {
            return result with { Error = StripRemind(result.Error ?? jsonError ?? raw) };
        }

        return Rewrite(result, Format(raw, toolName, path), keepErrorFlag: true);
    }

    public static RendererToolResult SanitizeLeakedKeys(
        RendererToolResult result,
        string? toolName,
        string? path)
    {
        return Normalize(result, toolName, path, wrapRemind: false);
    }

    private static RendererToolResult Rewrite(
        RendererToolResult result,
        FormattedToolError formatted,
        bool keepErrorFlag)
    {
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(formatted.Content),
            keepErrorFlag && result.IsError,
            formatted.Display);
    }

    private static FormattedToolError FormatClassified(ClassifiedError classified, string? toolName)
    {
        var display = BuildDisplay(classified, toolName);
        var remind = WrapRemind(BuildRemindBody(classified, display, toolName));
        return new FormattedToolError(EncodeJson(remind), display);
    }

    private readonly record struct ClassifiedError(
        ToolErrorKind Kind,
        string? Path,
        string Friendly);

    private enum ToolErrorKind
    {
        NotFound,
        AccessDenied,
        SharingViolation,
        PathTooLong,
        AlreadyExists,
        PathIsDirectory,
        Cancelled,
        Timeout,
        Generic
    }

    private static ClassifiedError Classify(Exception ex, string? requestedPath)
    {
        foreach (var candidate in EnumerateChain(ex))
        {
            var path = requestedPath
                ?? (candidate as FileNotFoundException)?.FileName
                ?? TryExtractPath(candidate.Message);

            if (candidate is TimeoutException ||
                (candidate is OperationCanceledException && LooksLikeTimeoutText(candidate.Message)))
            {
                return new ClassifiedError(
                    ToolErrorKind.Timeout,
                    path,
                    string.IsNullOrWhiteSpace(candidate.Message)
                        ? "The tool timed out."
                        : candidate.Message);
            }

            if (candidate is OperationCanceledException)
            {
                return new ClassifiedError(ToolErrorKind.Cancelled, path, "The tool call was cancelled.");
            }

            if (candidate is FileNotFoundException or DirectoryNotFoundException ||
                (candidate is IOException ioNotFound &&
                 (ioNotFound.HResult == CorFileNotFound || ioNotFound.HResult == CorPathNotFound)))
            {
                return new ClassifiedError(ToolErrorKind.NotFound, path, string.Empty);
            }

            if (candidate is UnauthorizedAccessException ||
                (candidate is IOException ioDenied && ioDenied.HResult == CorAccessDenied))
            {
                return new ClassifiedError(ToolErrorKind.AccessDenied, path, string.Empty);
            }

            if (candidate is PathTooLongException ||
                (candidate is IOException ioLong && ioLong.HResult == CorPathTooLong))
            {
                return new ClassifiedError(ToolErrorKind.PathTooLong, path, string.Empty);
            }

            if (candidate is IOException ioShare && ioShare.HResult == CorSharingViolation)
            {
                return new ClassifiedError(ToolErrorKind.SharingViolation, path, string.Empty);
            }

            if (TryParseResourceKey(candidate.Message, out var key, out var arg))
            {
                return ClassifyKey(key, FirstNonEmpty(path, arg));
            }

            if (LooksLikeDirectoryRead(candidate.Message))
            {
                return new ClassifiedError(ToolErrorKind.PathIsDirectory, path, candidate.Message);
            }
        }

        var fallbackPath = requestedPath ?? TryExtractPath(ex.Message);
        if (!LooksLikeResourceKey(ex.Message))
        {
            return new ClassifiedError(ToolErrorKind.Generic, fallbackPath, ex.Message);
        }

        return ClassifyMessage(ex.Message, fallbackPath);
    }

    private static ClassifiedError ClassifyMessage(string message, string? requestedPath)
    {
        var trimmed = message.Trim();
        if (ContainsRemind(trimmed))
        {
            return new ClassifiedError(ToolErrorKind.Generic, requestedPath, StripRemind(trimmed));
        }

        if (TryParseResourceKey(trimmed, out var key, out var arg))
        {
            return ClassifyKey(key, FirstNonEmpty(requestedPath, arg));
        }

        var path = requestedPath ?? TryExtractPath(trimmed);
        if (LooksLikeDirectoryRead(trimmed))
        {
            return new ClassifiedError(ToolErrorKind.PathIsDirectory, path, trimmed);
        }

        if (LooksLikeNotFoundText(trimmed))
        {
            return new ClassifiedError(ToolErrorKind.NotFound, path, trimmed);
        }

        if (LooksLikeAccessDeniedText(trimmed))
        {
            return new ClassifiedError(ToolErrorKind.AccessDenied, path, trimmed);
        }

        if (LooksLikeTimeoutText(trimmed))
        {
            return new ClassifiedError(ToolErrorKind.Timeout, path, trimmed);
        }

        return new ClassifiedError(ToolErrorKind.Generic, path, trimmed);
    }

    private static ClassifiedError ClassifyKey(string key, string? path)
    {
        if (IsNotFoundKey(key))
        {
            return new ClassifiedError(ToolErrorKind.NotFound, path, string.Empty);
        }

        if (key.Contains("UnauthorizedAccess", StringComparison.Ordinal) ||
            key.Contains("IODenied", StringComparison.Ordinal))
        {
            return new ClassifiedError(ToolErrorKind.AccessDenied, path, string.Empty);
        }

        if (key.Contains("SharingViolation", StringComparison.Ordinal))
        {
            return new ClassifiedError(ToolErrorKind.SharingViolation, path, string.Empty);
        }

        if (key.Contains("PathTooLong", StringComparison.Ordinal))
        {
            return new ClassifiedError(ToolErrorKind.PathTooLong, path, string.Empty);
        }

        if (key.Contains("AlreadyExists", StringComparison.Ordinal) ||
            key.Contains("FileExists", StringComparison.Ordinal))
        {
            return new ClassifiedError(ToolErrorKind.AlreadyExists, path, string.Empty);
        }

        if (key.Contains("FileIsDirectory", StringComparison.Ordinal))
        {
            return new ClassifiedError(ToolErrorKind.PathIsDirectory, path, string.Empty);
        }

        return new ClassifiedError(
            ToolErrorKind.Generic,
            path,
            string.IsNullOrEmpty(path)
                ? "The tool failed because of an unexpected I/O error."
                : $"The tool failed because of an unexpected I/O error at '{path}'.");
    }

    private static string BuildDisplay(ClassifiedError classified, string? toolName)
    {
        var path = classified.Path;
        return classified.Kind switch
        {
            ToolErrorKind.NotFound => string.IsNullOrEmpty(path)
                ? "Path does not exist."
                : $"Path does not exist: {path}",
            ToolErrorKind.AccessDenied => string.IsNullOrEmpty(path)
                ? "Access denied."
                : $"Access denied: {path}",
            ToolErrorKind.SharingViolation => string.IsNullOrEmpty(path)
                ? "The file is locked by another process."
                : $"The file is locked by another process: {path}",
            ToolErrorKind.PathTooLong => string.IsNullOrEmpty(path)
                ? "The path is too long."
                : $"The path is too long: {path}",
            ToolErrorKind.AlreadyExists => string.IsNullOrEmpty(path)
                ? "The path already exists."
                : $"The path already exists: {path}",
            ToolErrorKind.PathIsDirectory => string.IsNullOrEmpty(path)
                ? "Expected a file but found a directory."
                : $"Expected a file but found a directory: {path}",
            ToolErrorKind.Cancelled => "The tool call was cancelled.",
            ToolErrorKind.Timeout => string.IsNullOrWhiteSpace(classified.Friendly)
                ? "The tool timed out."
                : classified.Friendly,
            _ => string.IsNullOrWhiteSpace(classified.Friendly)
                ? string.IsNullOrEmpty(toolName)
                    ? "The tool failed."
                    : $"The {toolName} tool failed."
                : classified.Friendly
        };
    }

    private static string BuildRemindBody(ClassifiedError classified, string display, string? toolName)
    {
        var path = classified.Path;
        var quoted = string.IsNullOrEmpty(path) ? "the requested path" : $"\"{path}\"";
        return classified.Kind switch
        {
            ToolErrorKind.NotFound =>
                $"The path {quoted} does not exist. Do not retry this exact path. " +
                "Use LS or Glob to locate the correct file, then call the tool again with a path that exists.",
            ToolErrorKind.AccessDenied =>
                $"Access to {quoted} was denied. Do not retry the same path unchanged. " +
                "Ask the user to grant access, or use a path inside the working folder.",
            ToolErrorKind.SharingViolation =>
                $"{quoted} is locked by another process. Wait and retry later, or choose a different file.",
            ToolErrorKind.PathTooLong =>
                "The path is too long. Use a shorter path, or work from a nearer working folder.",
            ToolErrorKind.AlreadyExists =>
                $"{quoted} already exists. Choose a different path, or Read/Edit the existing file.",
            ToolErrorKind.PathIsDirectory =>
                $"{quoted} is a directory. Use LS to list it, then Read a file inside it.",
            ToolErrorKind.Cancelled =>
                "The tool call was cancelled. Do not retry the same call unless the user asks again.",
            ToolErrorKind.Timeout =>
                $"{display} Do not retry the same call unchanged. Narrow the query, or fall back to Grep, Glob, and Read. You must still write a final report from the evidence you already have.",
            _ => string.IsNullOrEmpty(toolName)
                ? display
                : display.Contains(toolName, StringComparison.Ordinal)
                    ? display
                    : $"The {toolName} tool failed: {display}"
        };
    }

    private static string WrapRemind(string body)
    {
        var trimmed = body.Trim();
        if (ContainsRemind(trimmed))
        {
            return trimmed;
        }

        return "<system-remind>\n" + trimmed + "\n</system-remind>";
    }

    private static string StripRemind(string message)
    {
        var trimmed = message.Trim();
        if (trimmed.StartsWith("<system-remind>", StringComparison.OrdinalIgnoreCase) &&
            trimmed.EndsWith("</system-remind>", StringComparison.OrdinalIgnoreCase))
        {
            return trimmed["<system-remind>".Length..^"</system-remind>".Length].Trim();
        }

        if (trimmed.StartsWith("<system-reminder>", StringComparison.OrdinalIgnoreCase) &&
            trimmed.EndsWith("</system-reminder>", StringComparison.OrdinalIgnoreCase))
        {
            return trimmed["<system-reminder>".Length..^"</system-reminder>".Length].Trim();
        }

        return trimmed;
    }

    private static bool ContainsRemind(string message)
    {
        return message.Contains("<system-remind", StringComparison.OrdinalIgnoreCase);
    }

    private static string EncodeJson(string message)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string? TryReadString(JsonElement content)
    {
        return content.ValueKind == JsonValueKind.String ? content.GetString() : content.GetRawText();
    }

    private static string? TryReadSoleJsonError(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return null;
        }

        var trimmed = content.Trim();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(trimmed);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? error = null;
            var count = 0;
            foreach (var property in document.RootElement.EnumerateObject())
            {
                count++;
                if (property.NameEquals("error") && property.Value.ValueKind == JsonValueKind.String)
                {
                    error = property.Value.GetString();
                }
            }

            return count == 1 ? error : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool TryParseResourceKey(string? message, out string key, out string? arg)
    {
        key = string.Empty;
        arg = null;
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        var match = ResourceKeyPattern.Match(message.Trim());
        if (!match.Success)
        {
            return false;
        }

        key = match.Groups["key"].Value;
        var captured = match.Groups["arg"].Value.Trim();
        arg = captured.Length > 0 ? captured : null;
        return true;
    }

    private static bool LooksLikeResourceKey(string? message)
    {
        return TryParseResourceKey(message, out _, out _);
    }

    private static bool IsNotFoundKey(string key)
    {
        return key.Contains("FileNotFound", StringComparison.Ordinal) ||
            key.Contains("PathNotFound", StringComparison.Ordinal) ||
            key.Contains("DirectoryNotFound", StringComparison.Ordinal);
    }

    private static bool LooksLikePath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        return value.Contains('/') ||
            value.Contains('\\') ||
            (value.Length >= 2 && char.IsAsciiLetter(value[0]) && value[1] == ':');
    }

    private static bool LooksLikeDirectoryRead(string message)
    {
        return message.Contains("found a directory", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("is a directory", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("expected a file", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeNotFoundText(string message)
    {
        return message.Contains("ENOENT", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("no such file", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("does not exist", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("file not found", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("directory not found", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeAccessDeniedText(string message)
    {
        return message.Contains("permission denied", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("access denied", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("operation not permitted", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("EACCES", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("EPERM", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeTimeoutText(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        return message.Contains("-32001", StringComparison.Ordinal) ||
            message.Contains("timed out", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("timeout", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("deadline exceeded", StringComparison.OrdinalIgnoreCase);
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }

    private static IEnumerable<Exception> EnumerateChain(Exception exception)
    {
        var current = exception;
        for (var depth = 0; current is not null && depth < 8; depth++)
        {
            if (current is AggregateException aggregate)
            {
                foreach (var inner in aggregate.InnerExceptions)
                {
                    yield return inner;
                }
            }
            else
            {
                yield return current;
            }

            current = current.InnerException;
        }
    }
}
