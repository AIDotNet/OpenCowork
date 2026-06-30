using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static class ShellTools
{
    private const int DefaultTimeoutMs = 600_000;
    private const int MaxTimeoutMs = 3_600_000;
    private const int MaxCollectedOutputChars = 64_000;
    private static readonly ConcurrentDictionary<string, RunningShellProcess> Running = new(StringComparer.Ordinal);

    public static async Task<WorkerResponse> ExecAsync(JsonElement parameters, WorkerRequestContext context)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var shell = string.Empty;
        var processId = string.Empty;
        var terminalId = string.Empty;
        var stdout = new OutputCollector(MaxCollectedOutputChars);
        var stderr = new OutputCollector(MaxCollectedOutputChars);

        try
        {
            var command = RequireString(parameters, "command");
            var timeoutMs = Math.Clamp(JsonHelpers.GetInt(parameters, "timeout", DefaultTimeoutMs), 1, MaxTimeoutMs);
            var execId = JsonHelpers.GetString(parameters, "execId")?.Trim();
            var cwd = ResolveCwd(JsonHelpers.GetString(parameters, "cwd"));
            var launch = ResolveLaunch(JsonHelpers.GetString(parameters, "shell"));
            shell = launch.Shell;
            WorkerLog.Debug(
                $"shell exec start execId={FormatLogValue(execId)} shell={shell} " +
                $"timeoutMs={timeoutMs} cwdSet={!string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "cwd"))}");

            using var process = CreateProcess(launch, command, cwd, parameters);
            var spawnStartedAt = Stopwatch.GetTimestamp();
            process.Start();
            processId = process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            terminalId = string.IsNullOrEmpty(execId) ? $"native-shell-{processId}" : $"native-shell-{execId}";
            var spawnMs = ElapsedMs(spawnStartedAt);
            WorkerLog.Debug(
                $"shell process started execId={FormatLogValue(execId)} pid={processId} " +
                $"terminalId={terminalId} spawnMs={spawnMs}");

            var running = new RunningShellProcess(process);
            if (!string.IsNullOrEmpty(execId))
            {
                Running[execId] = running;
                await context.EmitEventAsync(
                    "shell/started",
                    new ShellStartedEvent(execId, processId, terminalId),
                    WorkerJsonContext.Default.ShellStartedEvent);
            }

            using var timeoutCts = new CancellationTokenSource();
            var timeoutTask = AbortOnTimeoutAsync(running, timeoutMs, timeoutCts.Token);

            long? firstChunkMs = null;
            var stdoutTask = ReadStreamAsync(
                process.StandardOutput,
                stdout,
                "stdout",
                execId,
                context,
                startedAt,
                value => firstChunkMs ??= value);
            var stderrTask = ReadStreamAsync(
                process.StandardError,
                stderr,
                "stderr",
                execId,
                context,
                startedAt,
                value => firstChunkMs ??= value);

            try
            {
                await process.WaitForExitAsync(context.CancellationToken);
            }
            catch (OperationCanceledException)
            {
                running.Abort("canceled");
                await process.WaitForExitAsync(CancellationToken.None);
            }
            finally
            {
                await timeoutCts.CancelAsync();
                if (!string.IsNullOrEmpty(execId))
                {
                    Running.TryRemove(execId, out _);
                }
            }

            await Task.WhenAll(stdoutTask, stderrTask);
            await timeoutTask;

            var reason = running.AbortReason;
            var timedOut = reason == "timeout";
            var aborted = reason == "user" || reason == "canceled";
            var exitCode = timedOut ? 124 : aborted ? 130 : process.ExitCode;
            WorkerLog.Debug(
                $"shell exec done execId={FormatLogValue(execId)} pid={processId} " +
                $"exitCode={exitCode} timedOut={timedOut} aborted={aborted} totalMs={ElapsedMs(startedAt)}");
            var result = new ShellExecResult(
                true,
                exitCode,
                stdout.ToString(),
                stderr.ToString(),
                null,
                processId,
                terminalId,
                new ShellExecutionTiming(
                    ElapsedMs(startedAt),
                    spawnMs,
                    firstChunkMs,
                    shell,
                    timedOut,
                    aborted));

            return WorkerResponse.Json(result, WorkerJsonContext.Default.ShellExecResult);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"shell exec failed execId={FormatLogValue(JsonHelpers.GetString(parameters, "execId"))} " +
                $"elapsedMs={ElapsedMs(startedAt)} error={ex.GetType().Name}: {ex.Message}");
            var result = new ShellExecResult(
                false,
                1,
                stdout.ToString(),
                string.IsNullOrEmpty(stderr.ToString()) ? ex.Message : stderr.ToString(),
                ex.Message,
                string.IsNullOrEmpty(processId) ? null : processId,
                string.IsNullOrEmpty(terminalId) ? null : terminalId,
                new ShellExecutionTiming(
                    ElapsedMs(startedAt),
                    0,
                    null,
                    string.IsNullOrEmpty(shell) ? "native" : shell,
                    false,
                    false));
            return WorkerResponse.Json(result, WorkerJsonContext.Default.ShellExecResult);
        }
    }

    public static WorkerResponse Abort(JsonElement parameters)
    {
        try
        {
            var execId = RequireString(parameters, "execId");
            if (!Running.TryGetValue(execId, out var running))
            {
                WorkerLog.Debug($"shell abort ignored execId={execId} found=false");
                return WorkerResponse.Json(
                    new ShellAbortResult(true, false, null),
                    WorkerJsonContext.Default.ShellAbortResult);
            }

            running.Abort("user");
            WorkerLog.Debug($"shell abort requested execId={execId} found=true");
            return WorkerResponse.Json(
                new ShellAbortResult(true, true, null),
                WorkerJsonContext.Default.ShellAbortResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new ShellAbortResult(false, false, ex.Message),
                WorkerJsonContext.Default.ShellAbortResult);
        }
    }

    private static async Task AbortOnTimeoutAsync(
        RunningShellProcess running,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(timeoutMs, cancellationToken);
            running.Abort("timeout");
            WorkerLog.Debug($"shell timeout fired timeoutMs={timeoutMs}");
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static async Task ReadStreamAsync(
        StreamReader reader,
        OutputCollector collector,
        string streamName,
        string? execId,
        WorkerRequestContext context,
        long startedAt,
        Action<long> recordFirstChunk)
    {
        var buffer = new char[4096];
        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory(), context.CancellationToken);
            if (read <= 0)
            {
                break;
            }

            var chunk = new string(buffer, 0, read);
            collector.Append(chunk);
            recordFirstChunk(ElapsedMs(startedAt));
            if (!string.IsNullOrEmpty(execId))
            {
                await context.EmitEventAsync(
                    "shell/output",
                    new ShellOutputEvent(execId, chunk, streamName),
                    WorkerJsonContext.Default.ShellOutputEvent);
            }
        }
    }

    private static Process CreateProcess(
        ShellLaunch launch,
        string command,
        string cwd,
        JsonElement parameters)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = launch.Shell,
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true
        };

        foreach (var argument in GetLaunchArgs(launch, command))
        {
            startInfo.ArgumentList.Add(argument);
        }

        ApplyEnvironment(startInfo, parameters);
        return new Process { StartInfo = startInfo, EnableRaisingEvents = true };
    }

    private static void ApplyEnvironment(ProcessStartInfo startInfo, JsonElement parameters)
    {
        if (!parameters.TryGetProperty("env", out var envElement) || envElement.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (var property in envElement.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            startInfo.Environment[property.Name] = property.Value.GetString() ?? string.Empty;
        }
    }

    private static ShellLaunch ResolveLaunch(string? preferredShell)
    {
        foreach (var launch in GetShellLaunchCandidates(preferredShell))
        {
            if (OperatingSystem.IsWindows() || File.Exists(launch.Shell))
            {
                return launch;
            }
        }

        return OperatingSystem.IsWindows()
            ? new ShellLaunch(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", [])
            : new ShellLaunch("/bin/sh", []);
    }

    private static IEnumerable<ShellLaunch> GetShellLaunchCandidates(string? preferredShell)
    {
        var preferred = preferredShell?.Trim();
        if (OperatingSystem.IsWindows())
        {
            if (!string.IsNullOrEmpty(preferred))
            {
                yield return new ShellLaunch(preferred, []);
            }
            yield return new ShellLaunch(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", []);
            yield return new ShellLaunch("powershell.exe", []);
            yield return new ShellLaunch("pwsh.exe", []);
            yield break;
        }

        foreach (var shell in new[]
        {
            preferred,
            Environment.GetEnvironmentVariable("SHELL"),
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh"
        })
        {
            if (string.IsNullOrWhiteSpace(shell))
            {
                continue;
            }

            yield return new ShellLaunch(shell, shell == "/bin/sh" ? [] : ["-i"]);
        }
    }

    private static IEnumerable<string> GetLaunchArgs(ShellLaunch launch, string command)
    {
        if (OperatingSystem.IsWindows())
        {
            if (IsPowerShell(launch.Shell))
            {
                return ["-NoLogo", "-NoProfile", "-Command", command];
            }
            return ["/d", "/s", "/c", command];
        }

        return launch.Args.Concat(["-lc", command]);
    }

    private static bool IsPowerShell(string shell)
    {
        var name = Path.GetFileName(shell).ToLowerInvariant();
        return name is "powershell.exe" or "powershell" or "pwsh.exe" or "pwsh";
    }

    private static string ResolveCwd(string? cwd)
    {
        if (!string.IsNullOrWhiteSpace(cwd) && Directory.Exists(cwd))
        {
            return Path.GetFullPath(cwd);
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Directory.Exists(home) ? home : Environment.CurrentDirectory;
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required shell field: {name}");
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "none" : value;
    }

    private sealed record ShellLaunch(string Shell, string[] Args);

    private sealed class RunningShellProcess
    {
        private readonly Process process;

        public RunningShellProcess(Process process)
        {
            this.process = process;
        }

        public string? AbortReason { get; private set; }

        public void Abort(string reason)
        {
            AbortReason ??= reason;
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // The process may have exited between the check and Kill().
            }
        }
    }

    private sealed class OutputCollector
    {
        private readonly int maxChars;
        private readonly StringBuilder builder = new();
        private bool truncated;

        public OutputCollector(int maxChars)
        {
            this.maxChars = maxChars;
        }

        public void Append(string chunk)
        {
            if (truncated)
            {
                return;
            }

            var remaining = maxChars - builder.Length;
            if (remaining <= 0)
            {
                truncated = true;
                return;
            }

            if (chunk.Length <= remaining)
            {
                builder.Append(chunk);
                return;
            }

            builder.Append(chunk.AsSpan(0, remaining));
            builder.AppendLine();
            builder.Append("[Native shell output truncated]");
            truncated = true;
        }

        public override string ToString()
        {
            return builder.ToString();
        }
    }
}
