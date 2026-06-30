using System.Diagnostics;
using System.Text.Json;

internal static class SshTransferDownloadTools
{
    private const int DefaultTransferTimeoutMs = 30 * 60_000;
    private const int DefaultMaxScanNodes = 200_000;

    public static async Task<WorkerResponse> DownloadAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var taskId = JsonHelpers.GetString(parameters, "taskId") ?? $"native-transfer-download-{Guid.NewGuid():N}";
        NativeSshProcessTask? transferTask = null;

        try
        {
            var remotePaths = JsonHelpers.GetStringArray(parameters, "remotePaths");
            if (remotePaths.Length == 0)
            {
                throw new InvalidOperationException("No remote paths selected for download");
            }

            var localDir = JsonHelpers.GetString(parameters, "localDir") ??
                throw new InvalidOperationException("Missing required SSH transfer download field: localDir");
            var conflictPolicy = NormalizeConflictPolicy(JsonHelpers.GetString(parameters, "conflictPolicy"));
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var maxNodes = JsonHelpers.GetInt(parameters, "maxNodes", DefaultMaxScanNodes);
            var connectionId = ResolveConnectionId(parameters);
            var targetRoot = Path.GetFullPath(localDir);
            Directory.CreateDirectory(targetRoot);

            transferTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);
            WorkerLog.Debug(
                $"ssh transfer download start taskId={taskId} connectionId={FormatLogValue(connectionId)} " +
                $"remotePaths={remotePaths.Length} localDir={targetRoot} conflictPolicy={conflictPolicy}");

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

            var roots = new List<SshTransferNode>();
            foreach (var remotePath in remotePaths)
            {
                transferTask.ThrowIfCanceled();
                roots.Add(await SshTransferScanTools.ScanRemoteNodeAsync(
                    parameters,
                    remotePath,
                    connectionId,
                    timeoutMs,
                    maxNodes));
            }

            counters.TotalItems = roots.Sum(root => root.ItemCount);
            counters.TotalBytes = roots.Sum(root => root.TotalBytes);
            WorkerLog.Debug(
                $"ssh transfer download plan taskId={taskId} roots={roots.Count} " +
                $"items={counters.TotalItems} bytes={counters.TotalBytes}");

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
                transferTask.ThrowIfCanceled();
                await CopyNodeToLocalAsync(
                    parameters,
                    context,
                    transferTask,
                    taskId,
                    connectionId,
                    root,
                    Path.Combine(targetRoot, root.Name),
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
                $"ssh transfer download done taskId={taskId} bytes={counters.ProcessedBytes} " +
                $"items={counters.ProcessedItems} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    true,
                    null,
                    targetRoot,
                    counters.ProcessedBytes,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_download")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh transfer download canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
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
                    "SSH transfer download canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_download")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh transfer download failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_download")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        finally
        {
            if (transferTask is not null)
            {
                SshProcessTaskRegistry.Complete(taskId, transferTask);
            }
        }
    }

    private static async Task CopyNodeToLocalAsync(
        JsonElement parameters,
        WorkerRequestContext context,
        NativeSshProcessTask transferTask,
        string taskId,
        string connectionId,
        SshTransferNode node,
        string requestedTargetPath,
        string conflictPolicy,
        TransferCounters counters,
        int timeoutMs)
    {
        transferTask.ThrowIfCanceled();

        if (node.Type == "directory")
        {
            var targetPath = ResolveLocalConflict(requestedTargetPath, isDirectory: true, conflictPolicy);
            if (targetPath is null)
            {
                await MarkSkippedAsync(context, taskId, connectionId, node, counters, conflictPolicy);
                return;
            }

            Directory.CreateDirectory(targetPath);
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
                transferTask.ThrowIfCanceled();
                await CopyNodeToLocalAsync(
                    parameters,
                    context,
                    transferTask,
                    taskId,
                    connectionId,
                    child,
                    Path.Combine(targetPath, child.Name),
                    conflictPolicy,
                    counters,
                    timeoutMs);
            }

            return;
        }

        var fileTargetPath = ResolveLocalConflict(requestedTargetPath, isDirectory: false, conflictPolicy);
        if (fileTargetPath is null)
        {
            await MarkSkippedAsync(context, taskId, connectionId, node, counters, conflictPolicy);
            return;
        }

        await DownloadFileAsync(
            parameters,
            context,
            transferTask,
            taskId,
            connectionId,
            node.RemotePath,
            fileTargetPath,
            node.Size,
            counters,
            timeoutMs,
            conflictPolicy);
    }

    private static async Task DownloadFileAsync(
        JsonElement parameters,
        WorkerRequestContext context,
        NativeSshProcessTask transferTask,
        string taskId,
        string connectionId,
        string remotePath,
        string localPath,
        long size,
        TransferCounters counters,
        int timeoutMs,
        string conflictPolicy)
    {
        var targetDir = Path.GetDirectoryName(localPath);
        if (!string.IsNullOrWhiteSpace(targetDir))
        {
            Directory.CreateDirectory(targetDir);
        }

        await EmitTransferEventAsync(
            context,
            taskId,
            connectionId,
            counters,
            "transferring",
            "Transferring file...",
            remotePath,
            conflictPolicy);

        var result = await SshOpenSsh.ExecuteToFileAsync(
            parameters,
            $"cat -- {SshOpenSsh.ShellPathExpr(remotePath)}",
            localPath,
            timeoutMs,
            transferTask.TrackProcess,
            transferTask.Token);

        transferTask.ThrowIfCanceled();
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH download timeout" : SshTransferScanTools.NormalizeSshError(result.Stderr));
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
            remotePath,
            conflictPolicy);
    }

    private static async Task MarkSkippedAsync(
        WorkerRequestContext context,
        string taskId,
        string connectionId,
        SshTransferNode node,
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
            node.RemotePath,
            conflictPolicy);
    }

    private static string? ResolveLocalConflict(
        string targetPath,
        bool isDirectory,
        string conflictPolicy)
    {
        var exists = File.Exists(targetPath) || Directory.Exists(targetPath);
        if (!exists)
        {
            return targetPath;
        }

        if (conflictPolicy == "skip")
        {
            return null;
        }

        if (conflictPolicy == "duplicate")
        {
            var parent = Path.GetDirectoryName(targetPath) ?? Environment.CurrentDirectory;
            var baseName = Path.GetFileName(targetPath);
            for (var index = 1; index < 10_000; index += 1)
            {
                var candidate = Path.Combine(parent, BuildCopyName(baseName, index, isDirectory));
                if (!File.Exists(candidate) && !Directory.Exists(candidate))
                {
                    return candidate;
                }
            }

            throw new InvalidOperationException($"Unable to resolve duplicate path for {targetPath}");
        }

        var sameKind = isDirectory ? Directory.Exists(targetPath) : File.Exists(targetPath);
        if (!sameKind || !isDirectory)
        {
            RemoveLocalPath(targetPath);
        }

        return targetPath;
    }

    private static string BuildCopyName(string baseName, int index, bool isDirectory)
    {
        if (isDirectory)
        {
            return $"{baseName} copy{(index > 1 ? $" {index}" : string.Empty)}";
        }

        var extension = Path.GetExtension(baseName);
        var stem = string.IsNullOrEmpty(extension)
            ? baseName
            : baseName[..^extension.Length];
        return $"{stem} copy{(index > 1 ? $" {index}" : string.Empty)}{extension}";
    }

    private static void RemoveLocalPath(string targetPath)
    {
        if (Directory.Exists(targetPath))
        {
            Directory.Delete(targetPath, recursive: true);
            return;
        }

        if (File.Exists(targetPath))
        {
            File.Delete(targetPath);
        }
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
                "download",
                stage,
                connectionId,
                null,
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

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "none" : value;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed class TransferCounters
    {
        public long ProcessedItems { get; set; }
        public long TotalItems { get; set; }
        public long ProcessedBytes { get; set; }
        public long TotalBytes { get; set; }
    }
}
