using System.Diagnostics;
using System.Text.Json;

internal static class SshDirectoryUploadTools
{
    private const int DefaultTransferTimeoutMs = 30 * 60_000;
    private const int DirectoryCreateBatchSize = 64;

    public static async Task<WorkerResponse> UploadDirectoryAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var taskId = JsonHelpers.GetString(parameters, "taskId") ?? $"native-upload-{Guid.NewGuid():N}";
        NativeSshProcessTask? uploadTask = null;

        try
        {
            var localPath = JsonHelpers.GetString(parameters, "localPath") ??
                throw new InvalidOperationException("Missing required SSH field: localPath");
            var remoteDir = JsonHelpers.GetString(parameters, "remoteDir") ?? ".";
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var connectionId = ResolveConnectionId(parameters);
            var localRoot = Path.GetFullPath(localPath);
            if (!Directory.Exists(localRoot))
            {
                throw new InvalidOperationException("Selected path is not a directory");
            }

            var remoteRoot = PosixJoin(remoteDir, GetDirectoryUploadName(localRoot));
            uploadTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);

            WorkerLog.Debug(
                $"ssh directory upload start taskId={taskId} connectionId={FormatLogValue(connectionId)} " +
                $"localRoot={localRoot} remoteRoot={remoteRoot}");

            await EmitProgressAsync(
                context,
                taskId,
                connectionId,
                0,
                0,
                "Preparing upload...");

            var plan = BuildUploadPlan(localRoot, remoteRoot);
            uploadTask.ThrowIfCanceled();

            WorkerLog.Debug(
                $"ssh directory upload plan taskId={taskId} dirs={plan.Directories.Count} " +
                $"files={plan.Files.Count} bytes={plan.TotalBytes}");

            await EmitProgressAsync(
                context,
                taskId,
                connectionId,
                0,
                plan.TotalBytes,
                plan.Files.Count == 0 ? "Creating directories..." : "Uploading...");

            await CreateRemoteDirectoriesAsync(parameters, plan.Directories, timeoutMs, uploadTask);

            var uploadedBytes = 0L;
            var uploadedFiles = 0;
            foreach (var file in plan.Files)
            {
                uploadTask.ThrowIfCanceled();
                var result = await SshOpenSsh.ExecuteFromFileAsync(
                    parameters,
                    $"cat > {SshOpenSsh.ShellPathExpr(file.RemotePath)}",
                    file.LocalPath,
                    timeoutMs,
                    async (current, total) =>
                    {
                        var currentBytes = Math.Min(plan.TotalBytes, uploadedBytes + current);
                        await EmitProgressAsync(
                            context,
                            taskId,
                            connectionId,
                            currentBytes,
                            plan.TotalBytes,
                            $"Uploading {file.RelativePath}");
                    },
                    uploadTask.TrackProcess,
                    uploadTask.Token);

                uploadTask.ThrowIfCanceled();
                if (result.ExitCode != 0)
                {
                    throw new InvalidOperationException(
                        result.TimedOut ? "SSH upload timeout" : NormalizeSshError(result.Stderr));
                }

                uploadedBytes += file.Size;
                uploadedFiles += 1;
                await EmitProgressAsync(
                    context,
                    taskId,
                    connectionId,
                    uploadedBytes,
                    plan.TotalBytes,
                    $"Uploaded {uploadedFiles}/{plan.Files.Count}");
            }

            await EmitProgressAsync(
                context,
                taskId,
                connectionId,
                plan.TotalBytes,
                plan.TotalBytes,
                "Upload complete");

            WorkerLog.Debug(
                $"ssh directory upload done taskId={taskId} files={uploadedFiles} " +
                $"bytes={uploadedBytes} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    true,
                    null,
                    remoteRoot,
                    uploadedBytes,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_recursive")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh directory upload canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    "SSH upload canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_recursive")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh directory upload failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_recursive")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        finally
        {
            if (uploadTask is not null)
            {
                SshProcessTaskRegistry.Complete(taskId, uploadTask);
            }
        }
    }

    private static UploadDirectoryPlan BuildUploadPlan(string localRoot, string remoteRoot)
    {
        var directories = new List<string> { remoteRoot };
        var files = new List<UploadFilePlan>();
        ScanDirectory(localRoot, localRoot, remoteRoot, directories, files);
        return new UploadDirectoryPlan(directories, files, files.Sum(file => file.Size));
    }

    private static void ScanDirectory(
        string localRoot,
        string currentDir,
        string remoteRoot,
        List<string> directories,
        List<UploadFilePlan> files)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(currentDir).OrderBy(Path.GetFileName, StringComparer.Ordinal))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                WorkerLog.Debug($"ssh directory upload skip reparsePoint path={entry}");
                continue;
            }

            if ((attributes & FileAttributes.Directory) != 0)
            {
                var relativeDir = ToPosixRelativePath(localRoot, entry);
                directories.Add(PosixJoin(remoteRoot, relativeDir));
                ScanDirectory(localRoot, entry, remoteRoot, directories, files);
                continue;
            }

            var relativePath = ToPosixRelativePath(localRoot, entry);
            files.Add(
                new UploadFilePlan(
                    entry,
                    relativePath,
                    PosixJoin(remoteRoot, relativePath),
                    new FileInfo(entry).Length));
        }
    }

    private static async Task CreateRemoteDirectoriesAsync(
        JsonElement parameters,
        IReadOnlyList<string> directories,
        int timeoutMs,
        NativeSshProcessTask uploadTask)
    {
        for (var index = 0; index < directories.Count; index += DirectoryCreateBatchSize)
        {
            uploadTask.ThrowIfCanceled();
            var batch = directories.Skip(index).Take(DirectoryCreateBatchSize);
            var command = "mkdir -p -- " + string.Join(' ', batch.Select(SshOpenSsh.ShellPathExpr));
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                command,
                timeoutMs,
                maxStdoutChars: 1024);
            uploadTask.ThrowIfCanceled();
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    result.TimedOut ? "SSH upload timeout" : NormalizeSshError(result.Stderr));
            }
        }
    }

    private static ValueTask EmitProgressAsync(
        WorkerRequestContext context,
        string taskId,
        string connectionId,
        long current,
        long total,
        string message)
    {
        return context.EmitEventAsync(
            "ssh/upload-progress",
            new SshUploadProgressEvent(
                taskId,
                connectionId,
                "upload",
                new SshUploadProgress(
                    current,
                    total,
                    total > 0 ? (int)Math.Round((double)current / total * 100) : 100),
                message),
            WorkerJsonContext.Default.SshUploadProgressEvent);
    }

    private static string GetDirectoryUploadName(string localRoot)
    {
        var trimmed = localRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return Path.GetFileName(trimmed) is { Length: > 0 } name
            ? name
            : throw new InvalidOperationException("Unable to resolve upload directory name");
    }

    private static string ToPosixRelativePath(string root, string path)
    {
        return Path.GetRelativePath(root, path)
            .Replace(Path.DirectorySeparatorChar, '/')
            .Replace(Path.AltDirectorySeparatorChar, '/');
    }

    private static string PosixJoin(string left, string right)
    {
        if (left == "~")
        {
            return "~/" + right.TrimStart('/', '\\');
        }

        return left.TrimEnd('/', '\\') + "/" + right.TrimStart('/', '\\');
    }

    private static string NormalizeSshError(string stderr)
    {
        var trimmed = stderr.Trim();
        return string.IsNullOrEmpty(trimmed) ? "SSH command failed" : trimmed;
    }

    private static string ResolveConnectionId(JsonElement parameters)
    {
        if (JsonHelpers.GetString(parameters, "connectionId") is { Length: > 0 } explicitId)
        {
            return explicitId;
        }

        if (parameters.TryGetProperty("connection", out var connection))
        {
            return JsonHelpers.GetString(connection, "id") ?? string.Empty;
        }

        return string.Empty;
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "none" : value;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed record UploadDirectoryPlan(
        IReadOnlyList<string> Directories,
        IReadOnlyList<UploadFilePlan> Files,
        long TotalBytes);

    private sealed record UploadFilePlan(
        string LocalPath,
        string RelativePath,
        string RemotePath,
        long Size);
}
