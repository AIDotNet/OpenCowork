using System.Diagnostics;
using System.Text.Json;

internal static class SshRemoteCopyTools
{
    private const int DefaultTransferTimeoutMs = 30 * 60_000;

    public static async Task<WorkerResponse> CopyFileAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var taskId = JsonHelpers.GetString(parameters, "taskId") ?? $"native-remote-copy-{Guid.NewGuid():N}";
        NativeSshProcessTask? copyTask = null;

        try
        {
            var sourcePath = JsonHelpers.GetString(parameters, "sourcePath") ??
                throw new InvalidOperationException("Missing required SSH field: sourcePath");
            var targetPath = JsonHelpers.GetString(parameters, "targetPath") ??
                throw new InvalidOperationException("Missing required SSH field: targetPath");
            var timeoutMs = JsonHelpers.GetInt(parameters, "timeoutMs", DefaultTransferTimeoutMs);
            var sourceConnectionId = ResolveConnectionId(parameters, "sourceConnection", "sourceConnectionId");
            var targetConnectionId = ResolveConnectionId(parameters, "targetConnection", "targetConnectionId");

            copyTask = SshProcessTaskRegistry.Start(taskId, context.CancellationToken);
            WorkerLog.Debug(
                $"ssh remote copy start taskId={taskId} sourceConnectionId={sourceConnectionId} " +
                $"targetConnectionId={targetConnectionId} sourcePath={sourcePath} targetPath={targetPath}");

            var result = await SshOpenSsh.ExecuteRemoteToRemoteFileAsync(
                parameters,
                sourcePath,
                targetPath,
                timeoutMs,
                copyTask.TrackProcess,
                copyTask.Token);
            var error = result.TimedOut
                ? "SSH remote copy timeout"
                : result.ExitCode == 0
                    ? null
                    : NormalizeSshError(result.Stderr);

            WorkerLog.Debug(
                $"ssh remote copy done taskId={taskId} success={result.ExitCode == 0} " +
                $"bytes={result.Bytes} elapsedMs={ElapsedMs(startedAt)}");

            return WorkerResponse.Json(
                new SshFileTransferResult(
                    result.ExitCode == 0,
                    error,
                    result.ExitCode == 0 ? targetPath : null,
                    result.Bytes,
                    new SshExecTiming(result.TotalMs, result.SpawnMs, result.TimedOut, "native_aot_openssh_remote_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (OperationCanceledException)
        {
            WorkerLog.Debug(
                $"ssh remote copy canceled taskId={taskId} elapsedMs={ElapsedMs(startedAt)}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    "SSH remote copy canceled",
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_remote_stream")),
                WorkerJsonContext.Default.SshFileTransferResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"ssh remote copy failed taskId={taskId} elapsedMs={ElapsedMs(startedAt)} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.Json(
                new SshFileTransferResult(
                    false,
                    ex.Message,
                    null,
                    0,
                    new SshExecTiming(ElapsedMs(startedAt), 0, false, "native_aot_openssh_remote_stream")),
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

    public static WorkerResponse Abort(JsonElement parameters)
    {
        var taskId = JsonHelpers.GetString(parameters, "taskId") ??
            throw new InvalidOperationException("Missing required SSH field: taskId");
        if (!SshProcessTaskRegistry.Abort(taskId))
        {
            return WorkerResponse.Json(
                new SshFileMutationResult(false, "Remote copy task not found", null),
                WorkerJsonContext.Default.SshFileMutationResult);
        }

        return WorkerResponse.Json(
            new SshFileMutationResult(true, null, null),
            WorkerJsonContext.Default.SshFileMutationResult);
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

    private static string NormalizeSshError(string stderr)
    {
        var trimmed = stderr.Trim();
        return string.IsNullOrEmpty(trimmed) ? "SSH remote copy failed" : trimmed;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }
}
