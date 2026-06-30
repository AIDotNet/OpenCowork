using System.Text;
using System.Text.Json;

internal static class SshFileTools
{
    private const int DefaultTimeoutMs = 60_000;
    private const int DefaultTextLineReadLimit = 1_000;
    private const int MaxListEntries = 1_000;

    public static async Task<WorkerResponse> HomeDirAsync(JsonElement parameters)
    {
        try
        {
            var result = await SshOpenSsh.ExecuteAsync(parameters, "printf %s \"$HOME\"", DefaultTimeoutMs);
            if (result.ExitCode != 0)
            {
                return Home(false, null, result.Stderr);
            }

            return Home(true, result.Stdout.Trim(), null);
        }
        catch (Exception ex)
        {
            return Home(false, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> ResolvePathAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var script = """
                import os, sys
                print(os.path.abspath(os.path.expanduser(sys.argv[1])), end="")
                """;
            var result = await ExecPythonAsync(parameters, script, remotePath);
            if (result.ExitCode != 0)
            {
                return PathResult(false, null, result.Stderr);
            }

            return PathResult(true, result.Stdout.Trim(), null);
        }
        catch (Exception ex)
        {
            return PathResult(false, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> StatPathAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
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
            var result = await ExecPythonAsync(parameters, script, remotePath);
            if (result.ExitCode != 0)
            {
                return Stat(false, false, null, null, null, result.Stderr);
            }

            using var document = JsonDocument.Parse(result.Stdout);
            var root = document.RootElement;
            var exists = root.GetProperty("exists").GetBoolean();
            return Stat(
                true,
                exists,
                root.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String ? type.GetString() : null,
                root.TryGetProperty("size", out var size) && size.ValueKind == JsonValueKind.Number ? size.GetInt64() : null,
                root.TryGetProperty("mtimeMs", out var mtime) && mtime.ValueKind == JsonValueKind.Number ? mtime.GetInt64() : null,
                null);
        }
        catch (Exception ex)
        {
            return Stat(false, false, null, null, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> ReadFileAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                $"cat -- {SshOpenSsh.ShellPathExpr(remotePath)}",
                DefaultTimeoutMs);
            if (result.ExitCode != 0)
            {
                return Text(false, null, null, null, null, null, null, result.Stderr);
            }

            return Text(true, result.Stdout, null, remotePath, null, null, null, null);
        }
        catch (Exception ex)
        {
            return Text(false, null, null, null, null, null, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> ReadTextFileLinesAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var maxLines = ClampLineLimit(JsonHelpers.GetInt(parameters, "maxLines", DefaultTextLineReadLimit));
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                $"cat -- {SshOpenSsh.ShellPathExpr(remotePath)}",
                DefaultTimeoutMs);
            if (result.ExitCode != 0)
            {
                return Text(false, null, null, null, null, maxLines, null, result.Stderr);
            }

            var normalized = result.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
            var lines = normalized.Split('\n');
            var truncated = lines.Length > maxLines;
            var selected = truncated ? lines.Take(maxLines).ToArray() : lines;
            return Text(
                true,
                string.Join('\n', selected),
                GetRemoteName(remotePath),
                remotePath,
                selected.Length,
                maxLines,
                truncated,
                null);
        }
        catch (Exception ex)
        {
            return Text(false, null, null, null, null, null, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> WriteFileAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var content = JsonHelpers.GetString(parameters, "content") ?? string.Empty;
            var before = await StatForWriteAsync(parameters, remotePath);
            var command =
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(remotePath))} && " +
                $"cat > {SshOpenSsh.ShellPathExpr(remotePath)}";
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                command,
                DefaultTimeoutMs,
                Encoding.UTF8.GetBytes(content));
            if (result.ExitCode != 0)
            {
                return Mutation(false, result.Stderr);
            }

            return Mutation(true, null, before.Exists ? "modify" : "create");
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    public static async Task<WorkerResponse> ReadFileBinaryAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                $"base64 < {SshOpenSsh.ShellPathExpr(remotePath)} | tr -d '\\n'",
                DefaultTimeoutMs,
                maxStdoutChars: 64 * 1024 * 1024);
            if (result.ExitCode != 0)
            {
                return Binary(false, null, result.Stderr);
            }

            return Binary(true, result.Stdout.Trim(), null);
        }
        catch (Exception ex)
        {
            return Binary(false, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> WriteFileBinaryAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var data = JsonHelpers.GetString(parameters, "data") ?? string.Empty;
            var bytes = Convert.FromBase64String(data);
            var command =
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(remotePath))} && " +
                $"cat > {SshOpenSsh.ShellPathExpr(remotePath)}";
            var result = await SshOpenSsh.ExecuteAsync(parameters, command, DefaultTimeoutMs, bytes);
            return result.ExitCode == 0 ? Mutation(true, null) : Mutation(false, result.Stderr);
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    public static async Task<WorkerResponse> ListDirAsync(JsonElement parameters)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", MaxListEntries), 1, MaxListEntries);
            var script = """
                import json, os, sys
                p = os.path.expanduser(sys.argv[1])
                entries = []
                for name in os.listdir(p):
                    full = os.path.join(p, name)
                    try:
                        st = os.lstat(full)
                    except OSError:
                        continue
                    typ = "directory" if os.path.isdir(full) else ("symlink" if os.path.islink(full) else "file")
                    entries.append({"name": name, "path": full, "type": typ, "size": int(st.st_size), "modifyTime": int(st.st_mtime * 1000)})
                print(json.dumps(entries, separators=(",", ":")))
                """;
            var result = await ExecPythonAsync(parameters, script, remotePath);
            if (result.ExitCode != 0)
            {
                return List(false, null, null, null, result.Stderr);
            }

            using var document = JsonDocument.Parse(result.Stdout);
            var entries = new List<SshFileListEntry>();
            foreach (var item in document.RootElement.EnumerateArray())
            {
                if (entries.Count >= limit)
                {
                    break;
                }

                entries.Add(new SshFileListEntry(
                    item.GetProperty("name").GetString() ?? string.Empty,
                    item.GetProperty("path").GetString() ?? string.Empty,
                    item.GetProperty("type").GetString() ?? "file",
                    item.GetProperty("size").GetInt64(),
                    item.GetProperty("modifyTime").GetInt64()));
            }

            return List(true, entries, document.RootElement.GetArrayLength() > entries.Count, null, null);
        }
        catch (Exception ex)
        {
            return List(false, null, null, null, ex.Message);
        }
    }

    public static async Task<WorkerResponse> MkdirAsync(JsonElement parameters)
    {
        return await RunMutationCommandAsync(
            parameters,
            path => $"mkdir -p -- {SshOpenSsh.ShellPathExpr(path)}");
    }

    public static async Task<WorkerResponse> DeleteAsync(JsonElement parameters)
    {
        return await RunMutationCommandAsync(
            parameters,
            path => $"rm -rf -- {SshOpenSsh.ShellPathExpr(path)}");
    }

    public static async Task<WorkerResponse> MoveAsync(JsonElement parameters)
    {
        try
        {
            var from = RequireString(parameters, "from");
            var to = RequireString(parameters, "to");
            var command =
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(to))} && " +
                $"mv -- {SshOpenSsh.ShellPathExpr(from)} {SshOpenSsh.ShellPathExpr(to)}";
            var result = await SshOpenSsh.ExecuteAsync(parameters, command, DefaultTimeoutMs);
            return result.ExitCode == 0 ? Mutation(true, null) : Mutation(false, result.Stderr);
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    private static async Task<WorkerResponse> RunMutationCommandAsync(
        JsonElement parameters,
        Func<string, string> buildCommand)
    {
        try
        {
            var remotePath = RequirePath(parameters);
            var result = await SshOpenSsh.ExecuteAsync(parameters, buildCommand(remotePath), DefaultTimeoutMs);
            return result.ExitCode == 0 ? Mutation(true, null) : Mutation(false, result.Stderr);
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    private static async Task<SshCommandResult> ExecPythonAsync(
        JsonElement parameters,
        string script,
        string remotePath)
    {
        return await SshOpenSsh.ExecuteAsync(
            parameters,
            $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(remotePath)}",
            DefaultTimeoutMs,
            maxStdoutChars: 8 * 1024 * 1024);
    }

    private static async Task<(bool Exists, string? Type)> StatForWriteAsync(
        JsonElement parameters,
        string remotePath)
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"test -e {SshOpenSsh.ShellPathExpr(remotePath)}",
            DefaultTimeoutMs);
        return (result.ExitCode == 0, null);
    }

    private static WorkerResponse Mutation(bool success, string? error, string? op = null)
    {
        return WorkerResponse.Json(
            new SshFileMutationResult(success, error, op),
            WorkerJsonContext.Default.SshFileMutationResult);
    }

    private static WorkerResponse Home(bool success, string? path, string? error)
    {
        return WorkerResponse.Json(
            new SshFileHomeResult(success, path, error),
            WorkerJsonContext.Default.SshFileHomeResult);
    }

    private static WorkerResponse PathResult(bool success, string? path, string? error)
    {
        return WorkerResponse.Json(
            new SshFilePathResult(success, path, error),
            WorkerJsonContext.Default.SshFilePathResult);
    }

    private static WorkerResponse Text(
        bool success,
        string? content,
        string? name,
        string? path,
        int? lineCount,
        int? maxLines,
        bool? truncated,
        string? error)
    {
        return WorkerResponse.Json(
            new SshFileTextResult(success, content, name, path, lineCount, maxLines, truncated, error),
            WorkerJsonContext.Default.SshFileTextResult);
    }

    private static WorkerResponse Binary(bool success, string? data, string? error)
    {
        return WorkerResponse.Json(
            new SshFileBinaryResult(success, data, error),
            WorkerJsonContext.Default.SshFileBinaryResult);
    }

    private static WorkerResponse Stat(
        bool success,
        bool exists,
        string? type,
        long? size,
        long? mtimeMs,
        string? error)
    {
        return WorkerResponse.Json(
            new SshFileStatResult(success, exists, type, size, mtimeMs, error),
            WorkerJsonContext.Default.SshFileStatResult);
    }

    private static WorkerResponse List(
        bool success,
        List<SshFileListEntry>? entries,
        bool? hasMore,
        string? nextCursor,
        string? error)
    {
        return WorkerResponse.Json(
            new SshFileListResult(success, entries, hasMore, nextCursor, error),
            WorkerJsonContext.Default.SshFileListResult);
    }

    private static string RequirePath(JsonElement parameters)
    {
        return RequireString(parameters, "path");
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required SSH file field: {name}");
    }

    private static int ClampLineLimit(int value)
    {
        return Math.Max(1, Math.Min(DefaultTextLineReadLimit, value));
    }

    private static string GetRemoteName(string remotePath)
    {
        var trimmed = remotePath.TrimEnd('/');
        var index = trimmed.LastIndexOf('/');
        return index >= 0 ? trimmed[(index + 1)..] : trimmed;
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

        return trimmed[..index];
    }
}
