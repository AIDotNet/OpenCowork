using System.Diagnostics;
using System.Text.Json;

internal static class SshTransferRemoteCopyTools
{
    private const int DefaultTransferTimeoutMs = 30 * 60_000;
    private const int DefaultMaxScanNodes = 200_000;

    public static async Task<WorkerResponse> CopyAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var taskId = JsonHelpers.GetString(parameters, "taskId") ?? $"native-transfer-remote-copy-{Guid.NewGuid():N}";
        NativeSshProcessTask? copyTask = null;

        try
        {
            var sourcePaths = JsonHelpers.GetStringArray(parameters, "sourcePaths");
            if (sourcePaths.Length == 0)
            {
                throw new InvalidOperationException("No remote paths selected for copy");
            }

            var targetDir = JsonHelpers.GetString(parameters, "targetDir") ??
                throw new InvalidOperationException("Missing required SSH transfer copy field: targetDir");
            var conflictPolicy = NormalizeConflictPolicy(JsonHelpers.GetString(parameters, "conflictPolicy"));
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var maxNodes = JsonHelpers.GetInt(parameters, "maxNodes", DefaultMaxScanNodes);
            var sourceConnectionId = ResolveConnectionId(parameters, "sourceConnection", "sourceConnectionId");
            var targetConnectionId = ResolveConnectionId(parameters, "targetConnection", "targetConnectionId");

            copyTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);
            WorkerLog.Debug(
                $"ssh transfer remote-copy start taskId={taskId} " +
                $"sourceConnectionId={FormatLogValue(sourceConnectionId)} " +
                $"targetConnectionId={FormatLogValue(targetConnectionId)} " +
                $"sourcePaths={sourcePaths.Length} targetDir={targetDir} conflictPolicy={conflictPolicy}");

            var counters = new TransferCounters();
            await EmitTransferEventAsync(
                context,
                taskId,
                sourceConnectionId,
                targetConnectionId,
                counters,
                "preparing",
                "Preparing transfer...",
                null,
                conflictPolicy);

            var resolvedTargetDir = await ResolveTargetPathAsync(parameters, targetDir, timeoutMs);
            var roots = new List<SshTransferNode>();
            foreach (var sourcePath in sourcePaths)
            {
                copyTask.ThrowIfCanceled();
                roots.Add(await SshTransferScanTools.ScanRemoteNodeAsync(
                    parameters,
                    sourcePath,
                    sourceConnectionId,
                    timeoutMs,
                    maxNodes,
                    "sourceConnection"));
            }

            counters.TotalItems = roots.Sum(root => root.ItemCount);
            counters.TotalBytes = roots.Sum(root => root.TotalBytes);
            WorkerLog.Debug(
                $"ssh transfer remote-copy plan taskId={taskId} roots={roots.Count} " +
                $"items={counters.TotalItems} bytes={counters.TotalBytes} targetDir={resolvedTargetDir}");

            await EmitTransferEventAsync(
                context,
                taskId,
                sourceConnectionId,
                targetConnectionId,
                counters,
                "preparing",
                "Transfer plan ready",
                null,
                conflictPolicy);

            foreach (var root in roots)
            {
                copyTask.ThrowIfCanceled();
                await CopyNodeToRemoteAsync(
                    parameters,
                    context,
                    copyTask,
                    taskId,
                    sourceConnectionId,
                    targetConnectionId,
                    root,
                    PosixJoin(resolvedTargetDir, root.Name),
                    conflictPolicy,
                    counters,
                    timeoutMs);
            }

            await EmitTransferEventAsync(
                context,
                taskId,
                sourceConnectionId,
                targetConnectionId,
                counters,
                "done",
                "Transfer complete",
                null,
                conflictPolicy);

            WorkerLog.Debug(
                $"ssh transfer remote-copy done taskId={taskId} bytes={counters.ProcessedBytes} " +
                $"items={counters.ProcessedItems} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    true,
                    null,
                    resolvedTargetDir,
                    counters.ProcessedBytes,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_remote_copy")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh transfer remote-copy canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    "SSH transfer remote copy canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_remote_copy")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh transfer remote-copy failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_transfer_remote_copy")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        finally
        {
            if (copyTask is not null)
            {
                SshProcessTaskRegistry.Complete(taskId, copyTask);
            }
        }
    }

    private static async Task CopyNodeToRemoteAsync(
        JsonElement parameters,
        WorkerRequestContext context,
        NativeSshProcessTask copyTask,
        string taskId,
        string sourceConnectionId,
        string targetConnectionId,
        SshTransferNode node,
        string requestedTargetPath,
        string conflictPolicy,
        TransferCounters counters,
        int timeoutMs)
    {
        copyTask.ThrowIfCanceled();

        if (node.Type == "directory")
        {
            var targetPath = await ResolveTargetConflictAsync(
                parameters,
                requestedTargetPath,
                isDirectory: true,
                conflictPolicy,
                timeoutMs);
            if (targetPath is null)
            {
                await MarkSkippedAsync(
                    context,
                    taskId,
                    sourceConnectionId,
                    targetConnectionId,
                    node,
                    counters,
                    conflictPolicy);
                return;
            }

            await RunTargetMutationAsync(
                parameters,
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(targetPath)}",
                timeoutMs,
                "SSH mkdir failed");
            counters.ProcessedItems += 1;
            await EmitTransferEventAsync(
                context,
                taskId,
                sourceConnectionId,
                targetConnectionId,
                counters,
                "transferring",
                "Prepared directory",
                targetPath,
                conflictPolicy);

            foreach (var child in node.Children ?? [])
            {
                copyTask.ThrowIfCanceled();
                await CopyNodeToRemoteAsync(
                    parameters,
                    context,
                    copyTask,
                    taskId,
                    sourceConnectionId,
                    targetConnectionId,
                    child,
                    PosixJoin(targetPath, child.Name),
                    conflictPolicy,
                    counters,
                    timeoutMs);
            }

            return;
        }

        var fileTargetPath = await ResolveTargetConflictAsync(
            parameters,
            requestedTargetPath,
            isDirectory: false,
            conflictPolicy,
            timeoutMs);
        if (fileTargetPath is null)
        {
            await MarkSkippedAsync(
                context,
                taskId,
                sourceConnectionId,
                targetConnectionId,
                node,
                counters,
                conflictPolicy);
            return;
        }

        await CopyFileAsync(
            parameters,
            context,
            copyTask,
            taskId,
            sourceConnectionId,
            targetConnectionId,
            node.RemotePath,
            fileTargetPath,
            node.Size,
            counters,
            timeoutMs,
            conflictPolicy);
    }

    private static async Task CopyFileAsync(
        JsonElement parameters,
        WorkerRequestContext context,
        NativeSshProcessTask copyTask,
        string taskId,
        string sourceConnectionId,
        string targetConnectionId,
        string sourcePath,
        string targetPath,
        long size,
        TransferCounters counters,
        int timeoutMs,
        string conflictPolicy)
    {
        await EmitTransferEventAsync(
            context,
            taskId,
            sourceConnectionId,
            targetConnectionId,
            counters,
            "transferring",
            "Transferring file...",
            sourcePath,
            conflictPolicy);

        var result = await SshOpenSsh.ExecuteRemoteToRemoteFileAsync(
            parameters,
            sourcePath,
            targetPath,
            timeoutMs,
            copyTask.TrackProcess,
            copyTask.Token);

        copyTask.ThrowIfCanceled();
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                result.TimedOut ? "SSH remote copy timeout" : NormalizeSshError(result.Stderr));
        }

        counters.ProcessedItems += 1;
        counters.ProcessedBytes += size;
        await EmitTransferEventAsync(
            context,
            taskId,
            sourceConnectionId,
            targetConnectionId,
            counters,
            "transferring",
            "Transferred file",
            sourcePath,
            conflictPolicy);
    }

    private static async Task<string?> ResolveTargetConflictAsync(
        JsonElement parameters,
        string targetPath,
        bool isDirectory,
        string conflictPolicy,
        int timeoutMs)
    {
        var existing = await StatTargetPathAsync(parameters, targetPath, timeoutMs);
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
                var candidateStat = await StatTargetPathAsync(parameters, candidate, timeoutMs);
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
            await RunTargetMutationAsync(
                parameters,
                $"rm -rf -- {SshOpenSsh.ShellPathExpr(targetPath)}",
                timeoutMs,
                "SSH delete failed");
        }

        return targetPath;
    }

    private static async Task<SshTargetStat> StatTargetPathAsync(
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
            "targetConnection",
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
        return new SshTargetStat(exists, type);
    }

    private static async Task<string> ResolveTargetPathAsync(
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
            "targetConnection",
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

    private static async Task RunTargetMutationAsync(
        JsonElement parameters,
        string command,
        int timeoutMs,
        string fallbackError)
    {
        var result = await SshOpenSsh.ExecuteAsync(
            parameters,
            "targetConnection",
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
        string sourceConnectionId,
        string targetConnectionId,
        SshTransferNode node,
        TransferCounters counters,
        string conflictPolicy)
    {
        counters.ProcessedItems += node.ItemCount;
        counters.ProcessedBytes += node.TotalBytes;
        await EmitTransferEventAsync(
            context,
            taskId,
            sourceConnectionId,
            targetConnectionId,
            counters,
            "transferring",
            "Skipped by conflict policy",
            node.RemotePath,
            conflictPolicy);
    }

    private static ValueTask EmitTransferEventAsync(
        WorkerRequestContext context,
        string taskId,
        string sourceConnectionId,
        string targetConnectionId,
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
                "remote-copy",
                stage,
                sourceConnectionId,
                targetConnectionId,
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

    private static string ResolveConnectionId(
        JsonElement parameters,
        string connectionProperty,
        string explicitIdProperty)
    {
        if (JsonHelpers.GetString(parameters, explicitIdProperty) is { Length: > 0 } explicitId)
        {
            return explicitId;
        }

        if (parameters.TryGetProperty(connectionProperty, out var connection))
        {
            return JsonHelpers.GetString(connection, "id") ?? string.Empty;
        }

        return string.Empty;
    }

    private static string NormalizeSshError(string stderr, string fallback = "SSH remote copy failed")
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

    private sealed record SshTargetStat(bool Exists, string? Type);

    private sealed class TransferCounters
    {
        public long ProcessedItems { get; set; }
        public long TotalItems { get; set; }
        public long ProcessedBytes { get; set; }
        public long TotalBytes { get; set; }
    }
}
