using System.Buffers;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static class AgentRuntimeSshToolExecutor
{
    private const int ReadDefaultLimit = 2_000;
    private const int LsPromptMaxItems = 100;
    private const int LsBackendFetchLimit = LsPromptMaxItems + 1;
    private const int LsPromptMaxOutputBytes = 8 * 1024;
    private const int GlobDefaultLimit = 100;
    private const int GrepPromptDefaultLimit = 25;
    private const int GrepPromptMaxResults = 200;
    private const int GrepPromptMaxChars = 64 * 1024;
    private const int GrepPromptMaxOutputBytes = 64 * 1024;
    private const int GrepPromptDefaultLineLength = 160;
    private const int GrepPromptMaxLineLength = 1000;
    private const int ShellDefaultTimeoutMs = 600_000;
    private const int ShellMaxTimeoutMs = 3_600_000;
    private const int ShellMaxOutputChars = 12_000;
    private const int RemoteFileMaxChars = 32 * 1024 * 1024;
    private const int InlineTextSnapshotLimitBytes = 64 * 1024;
    private const int SnapshotPreviewHeadChars = 1_200;
    private const int SnapshotPreviewTailChars = 400;

    private static readonly JsonSerializerOptions NotebookJsonOptions = new()
    {
        WriteIndented = true
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private static readonly HashSet<string> SshToolNames = new(StringComparer.Ordinal)
    {
        "Read", "Write", "Edit", "NotebookEdit", "LS", "Glob", "Grep", "Bash", "Shell"
    };

    private static readonly Dictionary<string, Dictionary<string, FileSnapshot>> ReadSnapshotsByRun =
        new(StringComparer.Ordinal);

    public static bool IsSshTool(string toolName)
    {
        return SshToolNames.Contains(toolName);
    }

    public static bool ShouldRoute(JsonElement parameters)
    {
        return HasConnection(parameters) ||
            !string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "sshConnectionId"));
    }

    public static bool CanExecute(string toolName, JsonElement parameters)
    {
        return IsSshTool(toolName) &&
            string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "pluginId")) &&
            HasConnection(parameters);
    }

    public static bool RequiresApproval(string toolName, JsonElement input, JsonElement parameters)
    {
        return toolName switch
        {
            "Bash" or "Shell" => true,
            "Write" or "Edit" => IsWriteOutsideWorkingFolder(input, parameters),
            "NotebookEdit" => IsNotebookWriteOutsideWorkingFolder(input, parameters),
            _ => false
        };
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        WorkerLog.Debug(
            $"agent ssh tool start runId={FormatLogValue(JsonHelpers.GetString(parameters, "runId"))} " +
            $"tool={call.Name} connectionId={FormatLogValue(ConnectionId(parameters))}");

        try
        {
            var content = call.Name switch
            {
                "Read" => await ReadAsync(call.Input, parameters, cancellationToken),
                "Write" => await WriteAsync(call, parameters, cancellationToken),
                "Edit" => await EditAsync(call, parameters, cancellationToken),
                "NotebookEdit" => await NotebookEditAsync(call, parameters, cancellationToken),
                "LS" => await LsAsync(call.Input, parameters),
                "Glob" => await GlobAsync(call.Input, parameters),
                "Grep" => await GrepAsync(call.Input, parameters),
                "Bash" or "Shell" => await ExecuteShellAsync(call.Input, parameters),
                _ => EncodeError($"Native SSH tool not registered: {call.Name}")
            };

            WorkerLog.Debug(
                $"agent ssh tool done runId={FormatLogValue(JsonHelpers.GetString(parameters, "runId"))} " +
                $"tool={call.Name} elapsedMs={ElapsedMs(startedAt)}");
            return content;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"agent ssh tool failed runId={FormatLogValue(JsonHelpers.GetString(parameters, "runId"))} " +
                $"tool={call.Name} elapsedMs={ElapsedMs(startedAt)} error={ex.GetType().Name}: {ex.Message}");
            return EncodeError(ex.Message);
        }
    }

    public static void ClearRun(string runId)
    {
        lock (ReadSnapshotsByRun)
        {
            ReadSnapshotsByRun.Remove(runId);
        }
    }

    private static async Task<string> ReadAsync(
        JsonElement input,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var path = ResolveInputPath(input, parameters);
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Read requires a non-empty file_path");
        }

        cancellationToken.ThrowIfCancellationRequested();
        var content = await ReadRemoteTextAsync(parameters, path);
        await RecordReadAsync(parameters, path);
        var offset = Math.Max(1, JsonHelpers.GetInt(input, "offset", 1));
        var limit = Math.Max(1, Math.Min(JsonHelpers.GetInt(input, "limit", ReadDefaultLimit), ReadDefaultLimit));
        var lines = content.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        var start = Math.Min(offset - 1, lines.Length);
        var end = Math.Min(start + limit, lines.Length);
        var width = Math.Max(6, end.ToString(System.Globalization.CultureInfo.InvariantCulture).Length);
        var builder = new StringBuilder();
        for (var index = start; index < end; index++)
        {
            if (builder.Length > 0)
            {
                builder.Append('\n');
            }
            builder.Append((index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(width));
            builder.Append('\t');
            builder.Append(lines[index]);
        }

        return builder.ToString();
    }

    private static async Task<string> WriteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var path = ResolveInputPath(input, parameters);
        var content = JsonHelpers.GetString(input, "content");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Write requires a non-empty file_path");
        }
        if (content is null)
        {
            throw new InvalidOperationException("Write requires a content string");
        }

        var guardError = await AssertCurrentFileMatchesLastReadAsync(
            parameters,
            path,
            "Write",
            allowMissingFile: true);
        if (guardError is not null)
        {
            throw new InvalidOperationException(guardError);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var before = await CaptureFullTextSnapshotAsync(parameters, path);
        await WriteRemoteTextAsync(parameters, path, content);
        var tracked = RecordTextWriteChange(parameters, call, path, before, BuildLightTextSnapshot(content));
        await RecordReadAsync(parameters, path);

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("path", path);
            writer.WriteString("op", before.Exists ? "modify" : "create");
            writer.WriteBoolean("tracked", tracked);
        });
    }

    private static async Task<string> EditAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var path = ResolveInputPath(input, parameters);
        var oldString = JsonHelpers.GetString(input, "old_string") ?? string.Empty;
        var newString = JsonHelpers.GetString(input, "new_string") ?? string.Empty;
        var replaceAll = JsonHelpers.GetBool(input, "replace_all", false);
        if (string.IsNullOrWhiteSpace(path))
        {
            return EncodeError("Edit requires a non-empty file_path");
        }
        if (oldString.Length == 0)
        {
            return EncodeError("old_string must be non-empty");
        }
        if (oldString == newString)
        {
            return EncodeError("new_string must be different from old_string");
        }

        var guardError = await AssertCurrentFileMatchesLastReadAsync(
            parameters,
            path,
            "Edit",
            allowMissingFile: false);
        if (guardError is not null)
        {
            return EncodeError(guardError);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var content = await ReadRemoteTextAsync(parameters, path);
        var before = BuildFullTextSnapshot(content);
        var matchedVariant = FindOldStringVariant(oldString, content);
        if (matchedVariant is null)
        {
            return EncodeError($"String to replace not found in file.\nString: {oldString}");
        }

        var occurrences = CountOccurrences(content, matchedVariant.Value.Text);
        if (occurrences == 0)
        {
            return EncodeError($"String to replace not found in file.\nString: {oldString}");
        }
        if (!replaceAll && occurrences > 1)
        {
            return EncodeError(
                $"Found {occurrences} matches of the string to replace, but replace_all is false. " +
                $"To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context.\nString: {oldString}");
        }

        var replacementText = ApplyEolStyle(
            newString,
            GetReplacementEolStyle(matchedVariant.Value, content));
        var updated = replaceAll
            ? content.Replace(matchedVariant.Value.Text, replacementText, StringComparison.Ordinal)
            : ReplaceFirst(content, matchedVariant.Value.Text, replacementText);
        await WriteRemoteTextAsync(parameters, path, updated);
        var tracked = RecordTextWriteChange(parameters, call, path, before, BuildLightTextSnapshot(updated));
        await RecordReadAsync(parameters, path);

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("path", path);
            writer.WriteBoolean("replaceAll", replaceAll);
            writer.WriteBoolean("tracked", tracked);
        });
    }

    private static async Task<string> NotebookEditAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var path = ResolveNotebookInputPath(input, parameters);
        if (string.IsNullOrWhiteSpace(path))
        {
            return EncodeError("NotebookEdit requires notebook_path or file_path");
        }

        var guardError = await AssertCurrentFileMatchesLastReadAsync(
            parameters,
            path,
            "NotebookEdit",
            allowMissingFile: false);
        if (guardError is not null)
        {
            return EncodeError(guardError);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var content = await ReadRemoteTextAsync(parameters, path);
        var before = BuildFullTextSnapshot(content);
        JsonNode? notebookNode;
        try
        {
            notebookNode = JsonNode.Parse(content);
        }
        catch (JsonException ex)
        {
            return EncodeError($"Invalid notebook JSON: {ex.Message}");
        }

        if (notebookNode is not JsonObject notebook ||
            notebook["cells"] is not JsonArray cells)
        {
            return EncodeError("Notebook does not contain a cells array");
        }

        var mode = JsonHelpers.GetString(input, "mode") switch
        {
            "insert" => "insert",
            "delete" => "delete",
            _ => "replace"
        };
        var cellIndex = ResolveNotebookCellIndex(input, cells, mode);
        if (mode != "insert" && (cellIndex < 0 || cellIndex >= cells.Count))
        {
            return EncodeError("Notebook cell not found");
        }
        if (mode == "insert" && (cellIndex < -1 || cellIndex >= cells.Count))
        {
            return EncodeError("Insert cell_index is out of range");
        }

        if (mode == "delete")
        {
            cells.RemoveAt(cellIndex);
        }
        else
        {
            var nextCell = BuildNotebookCell(input);
            if (mode == "insert")
            {
                cells.Insert(cellIndex + 1, nextCell);
            }
            else
            {
                cells[cellIndex] = MergeNotebookCell(cells[cellIndex] as JsonObject, nextCell);
            }
        }

        var updated = notebook.ToJsonString(NotebookJsonOptions) + "\n";
        await WriteRemoteTextAsync(parameters, path, updated);
        var tracked = RecordTextWriteChange(parameters, call, path, before, BuildLightTextSnapshot(updated));
        await RecordReadAsync(parameters, path);

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("path", path);
            writer.WriteString("mode", mode);
            writer.WriteBoolean("tracked", tracked);
        });
    }

    private static async Task<string> LsAsync(JsonElement input, JsonElement parameters)
    {
        var rawPath = JsonHelpers.GetString(input, "path")?.Trim() ?? string.Empty;
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim();
        if ((rawPath.Length == 0 || rawPath == ".") && string.IsNullOrWhiteSpace(workingFolder))
        {
            return EncodeError("LS requires an active working folder when path is omitted or set to `.`");
        }

        var root = ResolveSearchRoot(input, parameters);
        var ignorePatterns = JsonHelpers.GetStringArray(input, "ignore")
            .Where(static pattern => !string.IsNullOrWhiteSpace(pattern))
            .ToArray();
        var ignoreJson = ToJsonStringArray(ignorePatterns);
        var script = """
            import fnmatch, json, os, sys
            path = os.path.abspath(os.path.expanduser(sys.argv[1]))
            limit = int(sys.argv[2])
            ignore = json.loads(sys.argv[3])
            entries = []
            has_more = False
            for name in os.listdir(path):
                if any(fnmatch.fnmatch(name, pat) for pat in ignore):
                    continue
                full = os.path.join(path, name)
                try:
                    typ = "directory" if os.path.isdir(full) else ("symlink" if os.path.islink(full) else "file")
                except OSError:
                    continue
                if len(entries) >= limit:
                    has_more = True
                    break
                entries.append({"name": name, "type": typ, "path": full})
            print(json.dumps({"entries": entries, "hasMore": has_more}, separators=(",", ":")))
            """;
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(root)} {LsBackendFetchLimit} {SshOpenSsh.ShellEscape(ignoreJson)}",
            60_000,
            maxStdoutChars: 512 * 1024);
        if (result.ExitCode != 0)
        {
            return EncodeError(result.Stderr.Length > 0 ? result.Stderr : "Remote LS failed");
        }

        using var document = JsonDocument.Parse(result.Stdout);
        var entries = new List<SshLsEntry>();
        var rootElement = document.RootElement;
        if (rootElement.TryGetProperty("entries", out var entriesElement) &&
            entriesElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in entriesElement.EnumerateArray())
            {
                entries.Add(new SshLsEntry(
                    JsonHelpers.GetString(item, "name") ?? string.Empty,
                    JsonHelpers.GetString(item, "type") ?? "file",
                    JsonHelpers.GetString(item, "path") ?? string.Empty));
            }
        }

        var hasMore = rootElement.TryGetProperty("hasMore", out var hasMoreElement) &&
            hasMoreElement.ValueKind is JsonValueKind.True or JsonValueKind.False &&
            hasMoreElement.GetBoolean();
        return FormatLsResultForPrompt(entries, hasMore);
    }

    private static async Task<string> GlobAsync(JsonElement input, JsonElement parameters)
    {
        var pattern = JsonHelpers.GetString(input, "pattern");
        if (string.IsNullOrWhiteSpace(pattern))
        {
            throw new InvalidOperationException("Glob requires a pattern");
        }

        var root = ResolveSearchRoot(input, parameters);
        using var searchParameters = BuildSshToolParameters(parameters, input, writer =>
        {
            writer.WriteString("path", root);
            writer.WriteString("pattern", pattern);
            writer.WriteNumber("limit", Math.Max(1, Math.Min(JsonHelpers.GetInt(input, "limit", GlobDefaultLimit), 1_000)));
        }, skipInputProperties: ["path", "pattern", "limit"]);
        var response = await SshSearchTools.GlobAsync(searchParameters.RootElement);
        return ExtractWorkerResultJson(response);
    }

    private static async Task<string> GrepAsync(JsonElement input, JsonElement parameters)
    {
        var pattern = JsonHelpers.GetString(input, "pattern");
        if (string.IsNullOrWhiteSpace(pattern))
        {
            throw new InvalidOperationException("Grep requires a pattern");
        }

        var root = ResolveSearchRoot(input, parameters);
        var maxResults = ClampPromptLimit(
            JsonHelpers.GetIntNullable(input, "maxResults") ??
            JsonHelpers.GetIntNullable(input, "head_limit") ??
            JsonHelpers.GetIntNullable(input, "headLimit") ??
            JsonHelpers.GetIntNullable(input, "limit"),
            GrepPromptDefaultLimit,
            GrepPromptMaxResults);
        var maxOutputBytes = ClampPromptLimit(
            JsonHelpers.GetIntNullable(input, "maxOutputBytes"),
            GrepPromptMaxOutputBytes,
            GrepPromptMaxOutputBytes);
        var maxLineLength = ClampPromptLimit(
            JsonHelpers.GetIntNullable(input, "maxLineLength"),
            GrepPromptDefaultLineLength,
            GrepPromptMaxLineLength);
        using var searchParameters = BuildSshToolParameters(parameters, input, writer =>
        {
            writer.WriteString("path", root);
            writer.WriteString("pattern", pattern);
            writer.WriteNumber("maxResults", maxResults);
            writer.WriteNumber("maxOutputBytes", maxOutputBytes);
            writer.WriteNumber("maxLineLength", maxLineLength);
        }, skipInputProperties: ["path", "pattern", "maxResults", "head_limit", "headLimit", "limit", "maxOutputBytes", "maxLineLength"]);
        var response = await SshSearchTools.GrepAsync(searchParameters.RootElement);
        return AgentRuntimeGrepResultFormatter.CompactForPrompt(
            ExtractWorkerResultJson(response),
            GrepPromptMaxChars);
    }

    private static async Task<string> ExecuteShellAsync(JsonElement input, JsonElement parameters)
    {
        var command = JsonHelpers.GetString(input, "command");
        if (string.IsNullOrWhiteSpace(command))
        {
            return EncodeJsonObject(writer =>
            {
                writer.WriteNumber("exitCode", 1);
                writer.WriteString("stderr", "Missing command");
            });
        }

        var cwd = JsonHelpers.GetString(input, "cwd")?.Trim();
        if (string.IsNullOrWhiteSpace(cwd))
        {
            cwd = JsonHelpers.GetString(parameters, "workingFolder")?.Trim();
        }

        var remoteCommand = string.IsNullOrWhiteSpace(cwd)
            ? command
            : $"cd {SshOpenSsh.ShellPathExpr(cwd)} && {command}";
        var timeoutMs = Math.Clamp(
            JsonHelpers.GetInt(input, "timeout", ShellDefaultTimeoutMs),
            1,
            ShellMaxTimeoutMs);
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            remoteCommand,
            timeoutMs,
            maxStdoutChars: ShellMaxOutputChars,
            maxStderrChars: ShellMaxOutputChars);

        return EncodeJsonObject(writer =>
        {
            writer.WriteNumber("exitCode", result.TimedOut ? 124 : result.ExitCode);
            writer.WriteString("stdout", Truncate(result.Stdout, ShellMaxOutputChars));
            writer.WriteString("stderr", Truncate(result.Stderr, ShellMaxOutputChars));
            writer.WriteBoolean("timedOut", result.TimedOut);
            WriteNullableString(writer, "cwd", string.IsNullOrWhiteSpace(cwd) ? null : cwd);
            writer.WriteNumber("totalMs", result.TotalMs);
            writer.WriteString("executionEngine", "native_aot_openssh");
        });
    }

    private static async Task<string> ReadRemoteTextAsync(JsonElement parameters, string path)
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"cat -- {SshOpenSsh.ShellPathExpr(path)}",
            60_000,
            maxStdoutChars: RemoteFileMaxChars);
        if (result.ExitCode != 0)
        {
            throw new IOException(result.Stderr.Length > 0 ? result.Stderr : $"Remote file read failed: {path}");
        }

        return result.Stdout;
    }

    private static async Task WriteRemoteTextAsync(JsonElement parameters, string path, string content)
    {
        var command =
            $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(path))} && " +
            $"cat > {SshOpenSsh.ShellPathExpr(path)}";
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            command,
            60_000,
            Encoding.UTF8.GetBytes(content));
        if (result.ExitCode != 0)
        {
            throw new IOException(result.Stderr.Length > 0 ? result.Stderr : $"Remote file write failed: {path}");
        }
    }

    private static async Task RecordReadAsync(JsonElement parameters, string path)
    {
        var runId = JsonHelpers.GetString(parameters, "runId");
        if (string.IsNullOrWhiteSpace(runId))
        {
            return;
        }

        try
        {
            var snapshot = await CaptureSnapshotAsync(parameters, path);
            var key = NormalizeReadHistoryPath(parameters, path);
            lock (ReadSnapshotsByRun)
            {
                if (!ReadSnapshotsByRun.TryGetValue(runId, out var snapshots))
                {
                    snapshots = new Dictionary<string, FileSnapshot>(StringComparer.Ordinal);
                    ReadSnapshotsByRun[runId] = snapshots;
                }
                snapshots[key] = snapshot;
            }
        }
        catch (Exception ex)
        {
            WorkerLog.Debug(
                $"agent ssh tool read snapshot skipped runId={FormatLogValue(runId)} " +
                $"path={path} error={ex.GetType().Name}: {ex.Message}");
        }
    }

    private static async Task<string?> AssertCurrentFileMatchesLastReadAsync(
        JsonElement parameters,
        string path,
        string toolName,
        bool allowMissingFile)
    {
        var runId = JsonHelpers.GetString(parameters, "runId");
        if (string.IsNullOrWhiteSpace(runId))
        {
            return $"{toolName} requires an active native run id.";
        }

        var current = await CaptureSnapshotAsync(parameters, path);
        if (!current.Exists && allowMissingFile)
        {
            return null;
        }

        FileSnapshot? previous = null;
        lock (ReadSnapshotsByRun)
        {
            if (ReadSnapshotsByRun.TryGetValue(runId, out var snapshots) &&
                snapshots.TryGetValue(NormalizeReadHistoryPath(parameters, path), out var snapshot))
            {
                previous = snapshot;
            }
        }

        if (previous is null)
        {
            return $"{toolName} requires the file to be read in this agent turn first. Call Read on {path} and retry.";
        }

        if (!previous.Value.Equals(current))
        {
            return $"{toolName} refused to edit because the file changed since it was last read in this turn. Call Read on {path} again and retry.";
        }

        return null;
    }

    private static async Task<FileSnapshot> CaptureSnapshotAsync(JsonElement parameters, string path)
    {
        var script = """
            import json, os, sys
            p = os.path.expanduser(sys.argv[1])
            try:
                st = os.lstat(p)
                typ = "directory" if os.path.isdir(p) else ("symlink" if os.path.islink(p) else "file")
                print(json.dumps({"exists": True, "type": typ, "size": int(st.st_size), "mtimeMs": int(st.st_mtime * 1000)}, separators=(",", ":")))
            except FileNotFoundError:
                print(json.dumps({"exists": False, "type": None, "size": None, "mtimeMs": None}, separators=(",", ":")))
            """;
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(path)}",
            30_000,
            maxStdoutChars: 64 * 1024,
            maxStderrChars: 64 * 1024);
        if (result.ExitCode != 0)
        {
            throw new IOException(result.Stderr.Length > 0 ? result.Stderr : $"Remote stat failed: {path}");
        }

        using var document = JsonDocument.Parse(result.Stdout);
        var root = document.RootElement;
        var exists = root.TryGetProperty("exists", out var existsElement) &&
            existsElement.ValueKind is JsonValueKind.True or JsonValueKind.False &&
            existsElement.GetBoolean();
        if (!exists)
        {
            return new FileSnapshot(false, null, null, null);
        }

        return new FileSnapshot(
            true,
            JsonHelpers.GetString(root, "type"),
            JsonHelpers.GetLongNullable(root, "size"),
            JsonHelpers.GetLongNullable(root, "mtimeMs"));
    }

    private static async Task<StoredFileSnapshot> CaptureFullTextSnapshotAsync(
        JsonElement parameters,
        string path)
    {
        var snapshot = await CaptureSnapshotAsync(parameters, path);
        if (!snapshot.Exists)
        {
            return new StoredFileSnapshot
            {
                Exists = false,
                Hash = null,
                Size = 0
            };
        }

        var text = await ReadRemoteTextAsync(parameters, path);
        return BuildFullTextSnapshot(text);
    }

    private static StoredFileSnapshot BuildFullTextSnapshot(string text)
    {
        var size = Encoding.UTF8.GetByteCount(text);
        var lineCount = CountLines(text);
        var snapshot = new StoredFileSnapshot
        {
            Exists = true,
            FullText = text,
            Hash = HashText(text),
            Size = size,
            LineCount = lineCount
        };

        if (size <= InlineTextSnapshotLimitBytes)
        {
            snapshot.Text = text;
            return snapshot;
        }

        snapshot.PreviewText = text[..Math.Min(text.Length, SnapshotPreviewHeadChars)];
        if (text.Length > SnapshotPreviewTailChars)
        {
            snapshot.TailPreviewText = text[^SnapshotPreviewTailChars..];
        }
        snapshot.TextOmitted = true;
        return snapshot;
    }

    private static StoredFileSnapshot BuildLightTextSnapshot(string text)
    {
        var size = Encoding.UTF8.GetByteCount(text);
        var lineCount = CountLines(text);
        var snapshot = new StoredFileSnapshot
        {
            Exists = true,
            Hash = HashText(text),
            Size = size,
            LineCount = lineCount
        };

        if (size <= InlineTextSnapshotLimitBytes)
        {
            snapshot.Text = text;
            snapshot.FullText = text;
            return snapshot;
        }

        snapshot.PreviewText = text[..Math.Min(text.Length, SnapshotPreviewHeadChars)];
        if (text.Length > SnapshotPreviewTailChars)
        {
            snapshot.TailPreviewText = text[^SnapshotPreviewTailChars..];
        }
        snapshot.TextOmitted = true;
        return snapshot;
    }

    private static bool RecordTextWriteChange(
        JsonElement parameters,
        NativeToolCallView call,
        string path,
        StoredFileSnapshot before,
        StoredFileSnapshot after)
    {
        if (before.Exists == after.Exists &&
            string.Equals(before.Hash, after.Hash, StringComparison.OrdinalIgnoreCase))
        {
            WorkerLog.Debug($"agent ssh tool change skipped reason=unchanged tool={call.Name} path={path}");
            return false;
        }

        var runId = ResolveChangeRunId(parameters, call);
        if (string.IsNullOrWhiteSpace(runId))
        {
            WorkerLog.Warn($"agent ssh tool change dropped reason=missing-run-id tool={call.Name} path={path}");
            return false;
        }

        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
            if (string.IsNullOrEmpty(sessionId))
            {
                sessionId = null;
            }

            var parameterRunId = JsonHelpers.GetString(parameters, "runId")?.Trim();
            var assistantMessageId = string.IsNullOrEmpty(parameterRunId) ? runId : parameterRunId;
            var change = new StoredTrackedFileChange
            {
                RunId = runId,
                SessionId = sessionId,
                ToolUseId = string.IsNullOrWhiteSpace(call.Id) ? null : call.Id,
                ToolName = call.Name,
                FilePath = path,
                Transport = "ssh",
                ConnectionId = ConnectionId(parameters),
                Op = before.Exists ? "modify" : "create",
                Status = "open",
                Before = before,
                After = after,
                CreatedAt = now
            };

            DbAgentChangeTools.AppendTrackedFileChange(
                parameters,
                runId,
                sessionId,
                assistantMessageId,
                change,
                now);
            WorkerLog.Debug(
                $"agent ssh tool change recorded runId={runId} tool={call.Name} " +
                $"op={change.Op} path={path}");
            return true;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"agent ssh tool change record failed runId={runId} tool={call.Name} " +
                $"path={path} error={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static string? ResolveChangeRunId(JsonElement parameters, NativeToolCallView call)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (!string.IsNullOrEmpty(runId))
        {
            return runId;
        }

        var toolUseId = call.Id.Trim();
        return string.IsNullOrEmpty(toolUseId) ? null : toolUseId;
    }

    private static JsonDocument BuildSshToolParameters(
        JsonElement parameters,
        JsonElement input,
        Action<Utf8JsonWriter> writeOverrides,
        string[] skipInputProperties)
    {
        var skipped = new HashSet<string>(skipInputProperties, StringComparer.Ordinal);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            if (parameters.TryGetProperty("connection", out var connection))
            {
                writer.WritePropertyName("connection");
                connection.WriteTo(writer);
            }
            if (JsonHelpers.GetString(parameters, "sshPath") is { Length: > 0 } sshPath)
            {
                writer.WriteString("sshPath", sshPath);
            }
            if (input.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in input.EnumerateObject())
                {
                    if (skipped.Contains(property.Name))
                    {
                        continue;
                    }
                    property.WriteTo(writer);
                }
            }
            writeOverrides(writer);
            writer.WriteEndObject();
        }
        return JsonDocument.Parse(buffer.WrittenMemory);
    }

    private static string ExtractWorkerResultJson(WorkerResponse response)
    {
        using var document = JsonDocument.Parse(response.ToJsonBytes(null));
        return document.RootElement.TryGetProperty("result", out var result)
            ? result.GetRawText()
            : "{}";
    }

    private static bool HasConnection(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("connection", out var connection) &&
            connection.ValueKind == JsonValueKind.Object;
    }

    private static string? ConnectionId(JsonElement parameters)
    {
        if (parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("connection", out var connection))
        {
            return JsonHelpers.GetString(connection, "id");
        }
        return JsonHelpers.GetString(parameters, "sshConnectionId");
    }

    private static bool IsWriteOutsideWorkingFolder(JsonElement input, JsonElement parameters)
    {
        var target = ResolveInputPath(input, parameters);
        return IsPathOutsideWorkingFolder(target, parameters);
    }

    private static bool IsNotebookWriteOutsideWorkingFolder(JsonElement input, JsonElement parameters)
    {
        var target = ResolveNotebookInputPath(input, parameters);
        return IsPathOutsideWorkingFolder(target, parameters);
    }

    private static bool IsPathOutsideWorkingFolder(string target, JsonElement parameters)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder");
        if (string.IsNullOrWhiteSpace(target) || string.IsNullOrWhiteSpace(workingFolder))
        {
            return true;
        }

        var normalizedTarget = NormalizeRemotePath(target);
        var normalizedWorkingFolder = NormalizeRemotePath(workingFolder);
        return normalizedTarget != normalizedWorkingFolder &&
            !normalizedTarget.StartsWith(normalizedWorkingFolder.TrimEnd('/') + "/", StringComparison.Ordinal);
    }

    private static string ResolveInputPath(JsonElement input, JsonElement parameters)
    {
        var raw = JsonHelpers.GetString(input, "file_path") ??
            JsonHelpers.GetString(input, "path") ??
            string.Empty;
        return ResolveRemotePath(raw, JsonHelpers.GetString(parameters, "workingFolder"));
    }

    private static string ResolveNotebookInputPath(JsonElement input, JsonElement parameters)
    {
        var raw = JsonHelpers.GetString(input, "notebook_path") ??
            JsonHelpers.GetString(input, "file_path") ??
            string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }
        return ResolveRemotePath(raw, JsonHelpers.GetString(parameters, "workingFolder"));
    }

    private static string ResolveSearchRoot(JsonElement input, JsonElement parameters)
    {
        var raw = JsonHelpers.GetString(input, "path") ?? string.Empty;
        return ResolveRemotePath(raw, JsonHelpers.GetString(parameters, "workingFolder"));
    }

    private static string ResolveRemotePath(string rawPath, string? workingFolder)
    {
        var path = string.IsNullOrWhiteSpace(rawPath) ? workingFolder?.Trim() ?? "." : rawPath.Trim();
        if (IsRemoteAbsolute(path))
        {
            return NormalizeRemotePath(path);
        }
        if (!string.IsNullOrWhiteSpace(workingFolder))
        {
            return NormalizeRemotePath(PosixJoin(workingFolder.Trim(), path));
        }
        return NormalizeRemotePath(path);
    }

    private static bool IsRemoteAbsolute(string path)
    {
        return path.StartsWith("/", StringComparison.Ordinal) ||
            path == "~" ||
            path.StartsWith("~/", StringComparison.Ordinal);
    }

    private static string NormalizeRemotePath(string path)
    {
        var normalized = path.Replace('\\', '/').Trim();
        if (normalized.Length == 0)
        {
            return ".";
        }
        if (normalized == "~")
        {
            return normalized;
        }

        var prefix = string.Empty;
        var rest = normalized;
        if (normalized.StartsWith("~/", StringComparison.Ordinal))
        {
            prefix = "~";
            rest = normalized[2..];
        }
        else if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            prefix = "/";
            rest = normalized.TrimStart('/');
        }

        var parts = new List<string>();
        foreach (var part in rest.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == ".")
            {
                continue;
            }
            if (part == ".." && parts.Count > 0 && parts[^1] != "..")
            {
                parts.RemoveAt(parts.Count - 1);
                continue;
            }
            if (part == ".." && prefix.Length > 0)
            {
                continue;
            }
            parts.Add(part);
        }

        var body = string.Join('/', parts);
        if (prefix == "/")
        {
            return body.Length == 0 ? "/" : "/" + body;
        }
        if (prefix == "~")
        {
            return body.Length == 0 ? "~" : "~/" + body;
        }
        return body.Length == 0 ? "." : body;
    }

    private static string PosixJoin(string left, string right)
    {
        if (string.IsNullOrWhiteSpace(left))
        {
            return right;
        }
        if (string.IsNullOrWhiteSpace(right) || right == ".")
        {
            return left;
        }
        if (IsRemoteAbsolute(right))
        {
            return right;
        }
        return left.TrimEnd('/') + "/" + right.TrimStart('/');
    }

    private static string PosixDirname(string remotePath)
    {
        var normalized = remotePath.Replace('\\', '/');
        var trimmed = normalized.TrimEnd('/');
        var index = trimmed.LastIndexOf('/');
        if (index < 0)
        {
            return ".";
        }
        if (index == 0)
        {
            return "/";
        }
        if (trimmed.StartsWith("~/", StringComparison.Ordinal) && index == 1)
        {
            return "~";
        }
        return trimmed[..index];
    }

    private static string NormalizeReadHistoryPath(JsonElement parameters, string path)
    {
        return $"{ConnectionId(parameters) ?? string.Empty}:{NormalizeRemotePath(path)}";
    }

    private static string FormatLsResultForPrompt(List<SshLsEntry> entries, bool hasMore)
    {
        var limited = new List<SshLsEntry>();
        var totalBytes = 2;
        string? limitReason = hasMore ? "max_results" : null;

        foreach (var entry in entries)
        {
            if (limited.Count >= LsPromptMaxItems)
            {
                limitReason = "max_results";
                break;
            }

            var candidateBytes = Encoding.UTF8.GetByteCount(SerializeLsEntry(entry)) + 1;
            if (totalBytes + candidateBytes > LsPromptMaxOutputBytes)
            {
                limitReason = "max_output_bytes";
                break;
            }

            limited.Add(entry);
            totalBytes += candidateBytes;
        }

        return limitReason is null
            ? SerializeLsEntries(limited)
            : EncodeJsonObject(writer =>
            {
                writer.WritePropertyName("items");
                writer.WriteStartArray();
                foreach (var entry in limited)
                {
                    WriteLsEntry(writer, entry);
                }
                writer.WriteEndArray();
                writer.WriteBoolean("truncated", true);
                writer.WriteString("limitReason", limitReason);
            });
    }

    private static string SerializeLsEntries(List<SshLsEntry> entries)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            foreach (var entry in entries)
            {
                WriteLsEntry(writer, entry);
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string SerializeLsEntry(SshLsEntry entry)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WriteString("name", entry.Name);
            writer.WriteString("type", entry.Type);
            writer.WriteString("path", entry.Path);
        });
    }

    private static void WriteLsEntry(Utf8JsonWriter writer, SshLsEntry entry)
    {
        writer.WriteStartObject();
        writer.WriteString("name", entry.Name);
        writer.WriteString("type", entry.Type);
        writer.WriteString("path", entry.Path);
        writer.WriteEndObject();
    }

    private static int ResolveNotebookCellIndex(JsonElement input, JsonArray cells, string mode)
    {
        if (JsonHelpers.GetIntNullable(input, "cell_index") is { } cellIndex)
        {
            return cellIndex;
        }

        var cellId = JsonHelpers.GetString(input, "cell_id");
        if (!string.IsNullOrEmpty(cellId))
        {
            for (var index = 0; index < cells.Count; index++)
            {
                if (cells[index] is JsonObject cell &&
                    string.Equals(GetJsonString(cell, "id"), cellId, StringComparison.Ordinal))
                {
                    return index;
                }
            }
            return -1;
        }

        return mode == "insert" ? cells.Count - 1 : -1;
    }

    private static JsonObject BuildNotebookCell(JsonElement input)
    {
        var cellType = JsonHelpers.GetString(input, "cell_type") switch
        {
            "markdown" => "markdown",
            "raw" => "raw",
            _ => "code"
        };
        var source = JsonHelpers.GetString(input, "new_source") ??
            JsonHelpers.GetString(input, "source") ??
            string.Empty;
        var cell = new JsonObject
        {
            ["cell_type"] = cellType,
            ["metadata"] = new JsonObject(),
            ["source"] = BuildNotebookSourceArray(source)
        };
        if (cellType == "code")
        {
            cell["outputs"] = new JsonArray();
            cell["execution_count"] = null;
        }
        return cell;
    }

    private static JsonObject MergeNotebookCell(JsonObject? existingCell, JsonObject nextCell)
    {
        var merged = new JsonObject();
        if (existingCell is not null)
        {
            foreach (var property in existingCell)
            {
                merged[property.Key] = property.Value?.DeepClone();
            }
        }
        foreach (var property in nextCell)
        {
            merged[property.Key] = property.Value?.DeepClone();
        }
        return merged;
    }

    private static JsonArray BuildNotebookSourceArray(string source)
    {
        var lines = new JsonArray();
        if (source.Length == 0)
        {
            return lines;
        }

        var start = 0;
        for (var index = 0; index < source.Length; index++)
        {
            if (source[index] != '\n')
            {
                continue;
            }
            lines.Add((JsonNode?)JsonValue.Create(source[start..(index + 1)]));
            start = index + 1;
        }

        if (start < source.Length)
        {
            lines.Add((JsonNode?)JsonValue.Create(source[start..]));
        }
        else if (source.EndsWith("\n", StringComparison.Ordinal))
        {
            lines.Add((JsonNode?)JsonValue.Create(string.Empty));
        }

        return lines;
    }

    private static string? GetJsonString(JsonObject jsonObject, string propertyName)
    {
        return jsonObject.TryGetPropertyValue(propertyName, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    private static OldStringVariant? FindOldStringVariant(string oldString, string content)
    {
        foreach (var variant in BuildOldStringVariants(oldString, content))
        {
            if (variant.Text.Length > 0 && content.Contains(variant.Text, StringComparison.Ordinal))
            {
                return variant;
            }
        }
        return null;
    }

    private static List<OldStringVariant> BuildOldStringVariants(string oldString, string content)
    {
        var variants = new List<OldStringVariant>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        AddOldStringVariant(variants, seen, oldString, DetectEolStyle(oldString));

        if (oldString.Contains('\n', StringComparison.Ordinal))
        {
            var lfText = NormalizeToLf(oldString);
            AddOldStringVariant(variants, seen, lfText, "\n");
            if (content.Contains("\r\n", StringComparison.Ordinal))
            {
                AddOldStringVariant(
                    variants,
                    seen,
                    lfText.Replace("\n", "\r\n", StringComparison.Ordinal),
                    "\r\n");
            }
        }

        return variants;
    }

    private static void AddOldStringVariant(
        List<OldStringVariant> variants,
        HashSet<string> seen,
        string text,
        string? eol)
    {
        if (seen.Add(text))
        {
            variants.Add(new OldStringVariant(text, eol));
        }
    }

    private static string? DetectEolStyle(string value)
    {
        if (value.Contains("\r\n", StringComparison.Ordinal))
        {
            return "\r\n";
        }
        return value.Contains('\n', StringComparison.Ordinal) ? "\n" : null;
    }

    private static string? DetectDominantEolStyle(string value)
    {
        var crlf = 0;
        var lf = 0;
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] == '\r' && index + 1 < value.Length && value[index + 1] == '\n')
            {
                crlf++;
                index++;
            }
            else if (value[index] == '\n')
            {
                lf++;
            }
        }

        if (crlf == 0 && lf == 0)
        {
            return null;
        }
        return crlf >= lf ? "\r\n" : "\n";
    }

    private static string NormalizeToLf(string value)
    {
        return value.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string ApplyEolStyle(string value, string? eol)
    {
        if (eol is null)
        {
            return value;
        }

        var normalized = NormalizeToLf(value);
        return eol == "\n"
            ? normalized
            : normalized.Replace("\n", "\r\n", StringComparison.Ordinal);
    }

    private static string? GetReplacementEolStyle(OldStringVariant matchedVariant, string content)
    {
        return matchedVariant.Eol ?? DetectDominantEolStyle(content);
    }

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }
        return count;
    }

    private static string ReplaceFirst(string source, string oldValue, string newValue)
    {
        var index = source.IndexOf(oldValue, StringComparison.Ordinal);
        return index < 0
            ? source
            : source[..index] + newValue + source[(index + oldValue.Length)..];
    }

    private static string HashText(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static int CountLines(string text)
    {
        return text.Length == 0 ? 0 : text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Length;
    }

    private static string ToJsonStringArray(IEnumerable<string> values)
    {
        return "[" + string.Join(
            ',',
            values.Select(value => "\"" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"")) + "]";
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static int ClampPromptLimit(int? value, int fallback, int max)
    {
        if (value is null or <= 0)
        {
            return fallback;
        }

        return Math.Min(value.Value, max);
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null)
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, value);
        }
    }

    private static string Truncate(string value, int maxChars)
    {
        if (value.Length <= maxChars)
        {
            return value;
        }
        return value[..maxChars] + $"\n... [truncated, {value.Length} chars total]";
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "-" : value;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed record SshLsEntry(string Name, string Type, string Path);
}
