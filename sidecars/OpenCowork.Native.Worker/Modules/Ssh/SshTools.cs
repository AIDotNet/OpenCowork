using System.Diagnostics;
using System.Text.Json;

internal static class SshTools
{
    private const int DefaultTimeoutMs = 60_000;
    private const int DefaultConnectionTestTimeoutMs = 30_000;
    private const int DefaultTransferTimeoutMs = 30 * 60_000;

    public static async Task<WorkerResponse> ExecAsync(JsonElement parameters)
    {
        var startedAt = Stopwatch.GetTimestamp();
        try
        {
            var command = JsonHelpers.GetString(parameters, "command") ??
                throw new InvalidOperationException("Missing required SSH field: command");
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTimeoutMs);
            var result = await SshOpenSsh.ExecuteAsync(parameters, command, timeoutMs);
            var stderrText = result.Stderr;
            var error = result.TimedOut
                ? "SSH exec timeout"
                : result.ExitCode == 0
                    ? null
                    : NormalizeSshError(stderrText);

            return WorkerResponse.Json(
                new SshExecResult(
                    result.ExitCode == 0,
                    result.ExitCode,
                    result.Stdout,
                    stderrText,
                    error,
                    new SshExecTiming(result.TotalMs, result.SpawnMs, result.TimedOut, "native_aot_openssh")),
                WorkerJsonContext.Default.SshExecResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh exec failed elapsedMs={ElapsedMs(startedAt)} error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshExecResult(
                    false,
                    1,
                    string.Empty,
                    string.Empty,
                    ex.Message,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh")),
                WorkerJsonContext.Default.SshExecResult);
        }
    }

    public static async Task<WorkerResponse> TestConnectionAsync(JsonElement parameters)
    {
        var startedAt = Stopwatch.GetTimestamp();
        try
        {
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultConnectionTestTimeoutMs);
            var result = await SshOpenSsh.ExecuteAsync(parameters, "true", timeoutMs, maxStdoutChars: 1024);
            var error = result.TimedOut
                ? "SSH connection timeout"
                : result.ExitCode == 0
                    ? null
                    : NormalizeSshError(result.Stderr);

            return WorkerResponse.Json(
                new SshConnectionTestResult(
                    result.ExitCode == 0,
                    error,
                    new SshExecTiming(result.TotalMs, result.SpawnMs, result.TimedOut, "native_aot_openssh")),
                WorkerJsonContext.Default.SshConnectionTestResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh connection test failed elapsedMs={ElapsedMs(startedAt)} error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshConnectionTestResult(
                    false,
                    ex.Message,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh")),
                WorkerJsonContext.Default.SshConnectionTestResult);
        }
    }

    public static async Task<WorkerResponse> DownloadAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var taskId = JsonHelpers.GetString(parameters, "taskId") ?? $"native-download-{Guid.NewGuid():N}";
        NativeSshProcessTask? downloadTask = null;
        try
        {
            var remotePath = JsonHelpers.GetString(parameters, "remotePath") ??
                throw new InvalidOperationException("Missing required SSH field: remotePath");
            var localPath = JsonHelpers.GetString(parameters, "localPath") ??
                throw new InvalidOperationException("Missing required SSH field: localPath");
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var connectionId = ResolveConnectionId(parameters);
            downloadTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);
            WorkerLog.Debug(
                $"ssh download start taskId={taskId} connectionId={connectionId} " +
                $"remotePath={remotePath} localPath={localPath}");
            var result = await SshOpenSsh.ExecuteToFileAsync(
                parameters,
                $"cat -- {SshOpenSsh.ShellPathExpr(remotePath)}",
                localPath,
                timeoutMs,
                downloadTask.TrackProcess,
                downloadTask.Token);
            var error = result.TimedOut
                ? "SSH download timeout"
                : result.ExitCode == 0
                    ? null
                    : NormalizeSshError(result.Stderr);

            WorkerLog.Debug(
                $"ssh download done taskId={taskId} success={result.ExitCode == 0} " +
                $"bytes={result.Bytes} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    result.ExitCode == 0,
                    error,
                    result.ExitCode == 0 ? Path.GetFullPath(localPath) : null,
                    result.Bytes,
                    new SshExecTiming(result.TotalMs, result.SpawnMs, result.TimedOut, "native_aot_openssh_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh download canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    "SSH download canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh download failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        finally
        {
            if (downloadTask is not null)
            {
                SshProcessTaskRegistry.Complete(taskId, downloadTask);
            }
        }
    }

    public static async Task<WorkerResponse> UploadFileAsync(
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
            var remotePath = ResolveUploadRemotePath(parameters, localPath);
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var connectionId = ResolveConnectionId(parameters);
            var emitProgress = JsonHelpers.GetBool(parameters, "emitProgress", true);
            uploadTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);
            WorkerLog.Debug(
                $"ssh upload file start taskId={taskId} connectionId={connectionId} " +
                $"localPath={localPath} remotePath={remotePath} emitProgress={emitProgress}");
            var result = await SshOpenSsh.ExecuteFromFileAsync(
                parameters,
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(remotePath))} && " +
                $"cat > {SshOpenSsh.ShellPathExpr(remotePath)}",
                localPath,
                timeoutMs,
                emitProgress
                    ? async (current, total) =>
                    {
                        await context.EmitEventAsync(
                            "ssh/upload-progress",
                            new SshUploadProgressEvent(
                                taskId,
                                connectionId,
                                "upload",
                                new SshUploadProgress(
                                    current,
                                    total,
                                    total > 0 ? (int)Math.Round((double)current / total * 100) : null),
                                "Uploading..."),
                            WorkerJsonContext.Default.SshUploadProgressEvent);
                    }
                    : null,
                uploadTask.TrackProcess,
                uploadTask.Token);
            var error = result.TimedOut
                ? "SSH upload timeout"
                : result.ExitCode == 0
                    ? null
                    : NormalizeSshError(result.Stderr);

            WorkerLog.Debug(
                $"ssh upload file done taskId={taskId} success={result.ExitCode == 0} " +
                $"bytes={result.Bytes} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    result.ExitCode == 0,
                    error,
                    result.ExitCode == 0 ? remotePath : null,
                    result.Bytes,
                    new SshExecTiming(result.TotalMs, result.SpawnMs, result.TimedOut, "native_aot_openssh_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh upload file canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    "SSH upload canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh upload failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_stream")),
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

    public static WorkerResponse AbortUpload(JsonElement parameters)
    {
        var taskId = JsonHelpers.GetString(parameters, "taskId") ??
            throw new InvalidOperationException("Missing required SSH field: taskId");
        WorkerLog.Debug($"ssh upload abort requested taskId={taskId}");
        if (!SshProcessTaskRegistry.Abort(taskId))
        {
            WorkerLog.Debug($"ssh upload abort ignored taskId={taskId} found=false");
            return WorkerResponse.Json(
                new SshFileMutationResult(false, "Upload task not found", null),
                WorkerJsonContext.Default.SshFileMutationResult);
        }

        WorkerLog.Debug($"ssh upload abort accepted taskId={taskId}");
        return WorkerResponse.Json(
            new SshFileMutationResult(true, null, null),
            WorkerJsonContext.Default.SshFileMutationResult);
    }

    public static WorkerResponse AbortDownload(JsonElement parameters)
    {
        var taskId = JsonHelpers.GetString(parameters, "taskId") ??
            throw new InvalidOperationException("Missing required SSH field: taskId");
        WorkerLog.Debug($"ssh download abort requested taskId={taskId}");
        if (!SshProcessTaskRegistry.Abort(taskId))
        {
            WorkerLog.Debug($"ssh download abort ignored taskId={taskId} found=false");
            return WorkerResponse.Json(
                new SshFileMutationResult(false, "Download task not found", null),
                WorkerJsonContext.Default.SshFileMutationResult);
        }

        WorkerLog.Debug($"ssh download abort accepted taskId={taskId}");
        return WorkerResponse.Json(
            new SshFileMutationResult(true, null, null),
            WorkerJsonContext.Default.SshFileMutationResult);
    }

    private static string NormalizeSshError(string stderr)
    {
        var trimmed = stderr.Trim();
        return string.IsNullOrEmpty(trimmed) ? "SSH command failed" : trimmed;
    }

    private static string ResolveUploadRemotePath(JsonElement parameters, string localPath)
    {
        var remotePath = JsonHelpers.GetString(parameters, "remotePath");
        if (!string.IsNullOrWhiteSpace(remotePath))
        {
            return remotePath;
        }

        var remoteDir = JsonHelpers.GetString(parameters, "remoteDir") ?? ".";
        var fileName = Path.GetFileName(localPath);
        if (string.IsNullOrWhiteSpace(fileName))
        {
            throw new InvalidOperationException("Unable to resolve upload file name");
        }

        return PosixJoin(remoteDir, fileName);
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

    private static string PosixJoin(string left, string right)
    {
        if (left == "~")
        {
            return "~/" + right.TrimStart('/', '\\');
        }

        return left.TrimEnd('/', '\\') + "/" + right.TrimStart('/', '\\');
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }
}
