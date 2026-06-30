using System.Diagnostics;
using System.Text.Json;

internal static class SshTransferUploadTools
{
    private const int DefaultTransferTimeoutMs = 30 * 60_000;

    public static async Task<WorkerResponse> UploadAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var taskId = JsonHelpers.GetString(parameters, "taskId") ?? $"native-transfer-upload-{Guid.NewGuid():N}";
        NativeSshProcessTask? uploadTask = null;

        try
        {
            var localPaths = JsonHelpers.GetStringArray(parameters, "localPaths");
            if (localPaths.Length == 0)
            {
                throw new InvalidOperationException("No local paths selected for upload");
            }

            var remoteDir = JsonHelpers.GetString(parameters, "remoteDir") ??
                throw new InvalidOperationException("Missing required SSH transfer upload field: remoteDir");
            var conflictPolicy = NormalizeConflictPolicy(JsonHelpers.GetString(parameters, "conflictPolicy"));
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var connectionId = ResolveConnectionId(parameters);

            uploadTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);
            WorkerLog.Debug(
                $"ssh transfer upload start taskId={taskId} connectionId={FormatLogValue(connectionId)} " +
                $"localPaths={localPaths.Length} remoteDir={remoteDir} conflictPolicy={conflictPolicy}");

            var counters = new TransferCounters();
            await EmitTransferEventAsync(
                context,
                taskId,
                connectionId,
                counters,
                "preparing",
                "Preparing transfer...",
                null,
                conflictPolicy);

            var resolvedRemoteDir = await ResolveRemotePathAsync(parameters, remoteDir, timeoutMs);
            var roots = new List<LocalTransferNode>();
            foreach (var localPath in localPaths)
            {
                uploadTask.ThrowIfCanceled();
                roots.Add(ScanLocalNode(Path.GetFullPath(localPath)));
            }

            counters.TotalItems = roots.Sum(root => root.ItemCount);
            counters.TotalBytes = roots.Sum(root => root.TotalBytes);
            WorkerLog.Debug(
                $"ssh transfer upload plan taskId={taskId} roots={roots.Count} " +
                $"items={counters.TotalItems} bytes={counters.TotalBytes} remoteDir={resolvedRemoteDir}");

            await EmitTransferEventAsync(
                context,
                taskId,
                connectionId,
                counters,
                "preparing",
                "Transfer plan ready",
                null,
                conflictPolicy);

            foreach (var root in roots)
            {
                uploadTask.ThrowIfCanceled();
                await UploadNodeAsync(
                    parameters,
                    context,
                    uploadTask,
                    taskId,
                    connectionId,
                    root,
                    PosixJoin(resolvedRemoteDir, root.Name),
                    conflictPolicy,
                    counters,
                    timeoutMs);
            }

            await EmitTransferEventAsync(
                context,
                taskId,
                connectionId,
                counters,
                "done",
                "Transfer complete",
                null,
                conflictPolicy);

            WorkerLog.Debug(
                $"ssh transfer upload done taskId={taskId} bytes={counters.ProcessedBytes} " +
                $"items={counters.ProcessedItems} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    true,
                    null,
                    resolvedRemoteDir,
                    counters.ProcessedBytes,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_upload")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh transfer upload canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
            if (JsonHelpers.GetString(parameters, "connectionId") is { Length: > 0 } connectionId)
            {
                await EmitTransferEventAsync(
                    context,
                    taskId,
                    connectionId,
                    new TransferCounters(),
                    "canceled",
                    "Transfer canceled",
                    null,
                    NormalizeConflictPolicy(JsonHelpers.GetString(parameters, "conflictPolicy")));
            }

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    "SSH transfer upload canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_upload")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh transfer upload failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_upload")),
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

    private static LocalTransferNode ScanLocalNode(string localPath)
    {
        var attributes = File.GetAttributes(localPath);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException($"Symbolic links are not supported for transfer upload: {localPath}");
        }

        if ((attributes & FileAttributes.Directory) != 0)
        {
            var children = new List<LocalTransferNode>();
            foreach (var entry in Directory.EnumerateFileSystemEntries(localPath).OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                try
                {
                    children.Add(ScanLocalNode(entry));
                }
                catch (InvalidOperationException ex) when (ex.Message.StartsWith("Symbolic links are not supported", StringComparison.Ordinal))
                {
                    WorkerLog.Debug($"ssh transfer upload skip reparsePoint path={entry}");
                }
            }

            return new LocalTransferNode(
                Path.GetFileName(localPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)),
                "directory",
                localPath,
                0,
                1 + children.Sum(child => child.ItemCount),
                children.Sum(child => child.TotalBytes),
                children);
        }

        var size = new FileInfo(localPath).Length;
        return new LocalTransferNode(
            Path.GetFileName(localPath),
            "file",
            localPath,
            size,
            1,
            size,
            null);
    }

    private static async Task UploadNodeAsync(
        JsonElement parameters,
        WorkerRequestContext context,
        NativeSshProcessTask uploadTask,
        string taskId,
        string connectionId,
        LocalTransferNode node,
        string requestedTargetPath,
        string conflictPolicy,
        TransferCounters counters,
        int timeoutMs)
    {
        uploadTask.ThrowIfCanceled();

        if (node.Type == "directory")
        {
            var targetPath = await ResolveRemoteConflictAsync(
                parameters,
                requestedTargetPath,
                isDirectory: true,
                conflictPolicy,
                timeoutMs);
            if (targetPath is null)
            {
                await MarkSkippedAsync(context, taskId, connectionId, node, counters, conflictPolicy);
                return;
            }

            await RunRemoteMutationAsync(
                parameters,
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(targetPath)}",
                timeoutMs,
                "SSH mkdir failed");
            counters.ProcessedItems += 1;
            await EmitTransferEventAsync(
                context,
                taskId,
                connectionId,
                counters,
                "transferring",
                "Prepared directory",
                targetPath,
                conflictPolicy);

            foreach (var child in node.Children ?? [])
            {
                uploadTask.ThrowIfCanceled();
                await UploadNodeAsync(
                    parameters,
                    context,
                    uploadTask,
                    taskId,
                    connectionId,
                    child,
                    PosixJoin(targetPath, child.Name),
                    conflictPolicy,
                    counters,
                    timeoutMs);
            }

            return;
        }

        var fileTargetPath = await ResolveRemoteConflictAsync(
            parameters,
            requestedTargetPath,
            isDirectory: false,
            conflictPolicy,
            timeoutMs);
        if (fileTargetPath is null)
        {
            await MarkSkippedAsync(context, taskId, connectionId, node, counters, conflictPolicy);
            return;
        }

        await UploadFileAsync(
            parameters,
            context,
            uploadTask,
            taskId,
            connectionId,
            node.LocalPath,
            fileTargetPath,
            node.Size,
            counters,
            timeoutMs,
            conflictPolicy);
    }

    private static async Task UploadFileAsync(
        JsonElement parameters,
        WorkerRequestContext context,
        NativeSshProcessTask uploadTask,
        string taskId,
        string connectionId,
        string localPath,
        string remotePath,
        long size,
        TransferCounters counters,
        int timeoutMs,
        string conflictPolicy)
    {
        await EmitTransferEventAsync(
            context,
            taskId,
            connectionId,
            counters,
            "transferring",
            "Transferring file...",
            localPath,
            conflictPolicy);

        var result = await SshOpenSsh.ExecuteFromFileAsync(
            parameters,
            $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(remotePath))} && " +
            $"cat > {SshOpenSsh.ShellPathExpr(remotePath)}",
            localPath,
            timeoutMs,
            null,
            uploadTask.TrackProcess,
            uploadTask.Token);

        uploadTask.ThrowIfCanceled();
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH upload timeout" : NormalizeSshError(result.Stderr));
        }

        counters.ProcessedItems += 1;
        counters.ProcessedBytes += size;
        await EmitTransferEventAsync(
            context,
            taskId,
            connectionId,
            counters,
            "transferring",
            "Transferred file",
            localPath,
            conflictPolicy);
    }

    private static async Task<string?> ResolveRemoteConflictAsync(
        JsonElement parameters,
        string targetPath,
        bool isDirectory,
        string conflictPolicy,
        int timeoutMs)
    {
        var existing = await StatRemotePathAsync(parameters, targetPath, timeoutMs);
        if (!existing.Exists)
        {
            return targetPath;
        }

        if (conflictPolicy == "skip")
        {
            return null;
        }

        if (conflictPolicy == "duplicate")
        {
            var dir = PosixDirname(targetPath);
            var baseName = PosixBasename(targetPath);
            for (var index = 1; index < 10_000; index += 1)
            {
                var candidate = PosixJoin(dir, BuildCopyName(baseName, index, isDirectory));
                var candidateStat = await StatRemotePathAsync(parameters, candidate, timeoutMs);
                if (!candidateStat.Exists)
                {
                    return candidate;
                }
            }

            throw new InvalidOperationException($"Unable to resolve duplicate path for {targetPath}");
        }

        var sameKind =
            (isDirectory && existing.Type == "directory") ||
            (!isDirectory && existing.Type == "file");
        if (!sameKind || !isDirectory)
        {
            await RunRemoteMutationAsync(
                parameters,
                $"rm -rf -- {SshOpenSsh.ShellPathExpr(targetPath)}",
                timeoutMs,
                "SSH delete failed");
        }

        return targetPath;
    }

    private static async Task<SshRemoteStat> StatRemotePathAsync(
        JsonElement parameters,
        string targetPath,
        int timeoutMs)
    {
        var script = """
            import json, os, sys
            p = os.path.expanduser(sys.argv[1])
            try:
                st = os.lstat(p)
                typ = "directory" if os.path.isdir(p) else ("symlink" if os.path.islink(p) else "file")
                print(json.dumps({"exists": True, "type": typ}, separators=(",", ":")))
            except FileNotFoundError:
                print(json.dumps({"exists": False, "type": None}, separators=(",", ":")))
            """;
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(targetPath)}",
            timeoutMs,
            maxStdoutChars: 16 * 1024);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH stat timeout" : NormalizeSshError(result.Stderr));
        }

        using var document = JsonDocument.Parse(result.Stdout);
        var root = document.RootElement;
        var exists = root.GetProperty("exists").GetBoolean();
        var type = root.TryGetProperty("type", out var typeElement) &&
            typeElement.ValueKind == JsonValueKind.String
                ? typeElement.GetString()
                : null;
        return new SshRemoteStat(exists, type);
    }

    private static async Task<string> ResolveRemotePathAsync(
        JsonElement parameters,
        string targetPath,
        int timeoutMs)
    {
        var script = """
            import os, sys
            print(os.path.abspath(os.path.expanduser(sys.argv[1])), end="")
            """;
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            $"python3 -c {SshOpenSsh.ShellEscape(script)} {SshOpenSsh.ShellPathExpr(targetPath)}",
            timeoutMs,
            maxStdoutChars: 16 * 1024);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH path resolve timeout" : NormalizeSshError(result.Stderr));
        }

        return result.Stdout.Trim();
    }

    private static async Task RunRemoteMutationAsync(
        JsonElement parameters,
        string command,
        int timeoutMs,
        string fallbackError)
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            command,
            timeoutMs,
            maxStdoutChars: 16 * 1024);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH mutation timeout" : NormalizeSshError(result.Stderr, fallbackError));
        }
    }

    private static async Task MarkSkippedAsync(
        WorkerRequestContext context,
        string taskId,
        string connectionId,
        LocalTransferNode node,
        TransferCounters counters,
        string conflictPolicy)
    {
        counters.ProcessedItems += node.ItemCount;
        counters.ProcessedBytes += node.TotalBytes;
        await EmitTransferEventAsync(
            context,
            taskId,
            connectionId,
            counters,
            "transferring",
            "Skipped by conflict policy",
            node.LocalPath,
            conflictPolicy);
    }

    private static ValueTask EmitTransferEventAsync(
        WorkerRequestContext context,
        string taskId,
        string connectionId,
        TransferCounters counters,
        string stage,
        string message,
        string? currentItem,
        string conflictPolicy)
    {
        return context.EmitEventAsync(
            "ssh/transfer-progress",
            new SshTransferProgressEvent(
                taskId,
                "upload",
                stage,
                null,
                connectionId,
                BuildProgress(counters),
                message,
                currentItem,
                conflictPolicy),
            WorkerJsonContext.Default.SshTransferProgressEvent);
    }

    private static SshTransferProgress BuildProgress(TransferCounters counters)
    {
        var percent = counters.TotalBytes > 0
            ? (int)Math.Round((double)counters.ProcessedBytes / counters.TotalBytes * 100)
            : counters.TotalItems > 0
                ? (int)Math.Round((double)counters.ProcessedItems / counters.TotalItems * 100)
                : 100;
        return new SshTransferProgress(
            Math.Min(counters.TotalBytes, counters.ProcessedBytes),
            counters.TotalBytes,
            percent,
            counters.ProcessedItems,
            counters.TotalItems);
    }

    private static string BuildCopyName(string baseName, int index, bool isDirectory)
    {
        if (isDirectory)
        {
            return $"{baseName} copy{(index > 1 ? $" {index}" : string.Empty)}";
        }

        var dotIndex = baseName.LastIndexOf('.');
        var hasExtension = dotIndex > 0;
        var stem = hasExtension ? baseName[..dotIndex] : baseName;
        var extension = hasExtension ? baseName[dotIndex..] : string.Empty;
        return $"{stem} copy{(index > 1 ? $" {index}" : string.Empty)}{extension}";
    }

    private static string PosixJoin(string left, string right)
    {
        if (left == "/")
        {
            return "/" + right.TrimStart('/');
        }

        return left.TrimEnd('/') + "/" + right.TrimStart('/');
    }

    private static string PosixDirname(string remotePath)
    {
        var trimmed = remotePath.TrimEnd('/');
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

    private static string PosixBasename(string remotePath)
    {
        var trimmed = remotePath.TrimEnd('/');
        var index = trimmed.LastIndexOf('/');
        return index >= 0 ? trimmed[(index + 1)..] : trimmed;
    }

    private static string NormalizeConflictPolicy(string? value)
    {
        return value is "overwrite" or "duplicate" ? value : "skip";
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

    private static string NormalizeSshError(string stderr, string fallback = "SSH upload failed")
    {
        var trimmed = stderr.Trim();
        return string.IsNullOrEmpty(trimmed) ? fallback : trimmed;
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "none" : value;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed record SshRemoteStat(bool Exists, string? Type);

    private sealed record LocalTransferNode(
        string Name,
        string Type,
        string LocalPath,
        long Size,
        long ItemCount,
        long TotalBytes,
        List<LocalTransferNode>? Children);

    private sealed class TransferCounters
    {
        public long ProcessedItems { get; set; }
        public long TotalItems { get; set; }
        public long ProcessedBytes { get; set; }
        public long TotalBytes { get; set; }
    }
}
