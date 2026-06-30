using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeCodeCompatibleExecutor
{
    private const int DefaultTimeoutMs = 600_000;
    private const int MaxTimeoutMs = 3_600_000;
    private const int MaxOutputChars = 12_000;
    private const int MonitorOutputChunkLimit = 500;

    private static readonly HashSet<string> CodeCompatibleToolNames = new(StringComparer.Ordinal)
    {
        "PowerShell", "Monitor"
    };

    private static readonly ConcurrentDictionary<string, NativeMonitorProcess> Monitors =
        new(StringComparer.Ordinal);

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsCodeCompatibleTool(string toolName)
    {
        return CodeCompatibleToolNames.Contains(toolName);
    }

    public static bool CanExecute(JsonElement parameters)
    {
        return string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "pluginId")) &&
            string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "sshConnectionId"));
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "PowerShell" => await ExecutePowerShellAsync(call.Input, parameters, cancellationToken),
            "Monitor" => ExecuteMonitor(call.Input, parameters),
            _ => EncodeError($"Native code-compatible tool not registered: {call.Name}")
        };
    }

    private static async Task<string> ExecutePowerShellAsync(
        JsonElement input,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            return EncodeJsonObject(writer =>
            {
                writer.WriteString("status", "unavailable");
                writer.WriteString("tool", "PowerShell");
                writer.WriteString("reason", "PowerShell is only exposed on Windows.");
            });
        }

        var command = JsonHelpers.GetString(input, "command")?.Trim() ?? string.Empty;
        if (command.Length == 0)
        {
            return EncodeError("PowerShell requires command");
        }

        var timeoutMs = Math.Clamp(JsonHelpers.GetInt(input, "timeout", DefaultTimeoutMs), 1, MaxTimeoutMs);
        var cwd = ResolveCwd(parameters);
        var startedAt = Stopwatch.GetTimestamp();
        using var process = CreateShellProcess(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            cwd);

        try
        {
            process.Start();
            using var timeoutCts = new CancellationTokenSource(timeoutMs);
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                timeoutCts.Token);
            var stdoutTask = process.StandardOutput.ReadToEndAsync(linkedCts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(linkedCts.Token);
            var timedOut = false;

            try
            {
                await process.WaitForExitAsync(linkedCts.Token);
            }
            catch (OperationCanceledException)
            {
                timedOut = timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested;
                TryKill(process);
                await process.WaitForExitAsync(CancellationToken.None);
                if (!timedOut)
                {
                    throw;
                }
            }

            var stdout = await CompleteOutputTaskAsync(stdoutTask);
            var stderr = await CompleteOutputTaskAsync(stderrTask);
            var exitCode = timedOut ? 124 : process.ExitCode;
            WorkerLog.Debug(
                $"code-compatible powershell done exitCode={exitCode} timedOut={timedOut} elapsedMs={ElapsedMs(startedAt)}");
            return EncodeJsonObject(writer =>
            {
                writer.WritePropertyName("result");
                writer.WriteStartObject();
                writer.WriteBoolean("success", exitCode == 0);
                writer.WriteNumber("exitCode", exitCode);
                writer.WriteString("stdout", Truncate(stdout, MaxOutputChars));
                writer.WriteString("stderr", Truncate(stderr, MaxOutputChars));
                writer.WriteString("cwd", cwd);
                writer.WriteBoolean("timedOut", timedOut);
                writer.WriteNumber("totalMs", ElapsedMs(startedAt));
                writer.WriteEndObject();
            });
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"code-compatible powershell failed elapsedMs={ElapsedMs(startedAt)} error={ex.GetType().Name}: {ex.Message}");
            return EncodeError(ex.Message);
        }
    }

    private static string ExecuteMonitor(JsonElement input, JsonElement parameters)
    {
        var command = JsonHelpers.GetString(input, "command")?.Trim() ?? string.Empty;
        if (command.Length == 0)
        {
            return EncodeError("Monitor requires command");
        }

        var description = JsonHelpers.GetString(input, "description")?.Trim();
        var id = $"native-monitor-{Guid.NewGuid():N}";
        var cwd = ResolveCwd(parameters);
        var launch = ResolveDefaultShellLaunch(command);
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var process = CreateShellProcess(launch.Shell, launch.Arguments, cwd);
        var monitor = new NativeMonitorProcess(
            id,
            process,
            command,
            cwd,
            description,
            JsonHelpers.GetString(parameters, "sessionId"),
            startedAt);

        try
        {
            process.EnableRaisingEvents = true;
            process.Start();
            monitor.ProcessId = process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            Monitors[id] = monitor;
            process.Exited += (_, _) =>
            {
                monitor.Exited = true;
                monitor.ExitCode = SafeExitCode(process);
                monitor.ExitedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                Monitors.TryRemove(id, out _);
                process.Dispose();
                WorkerLog.Debug(
                    $"code-compatible monitor exited id={id} exitCode={monitor.ExitCode} chunks={monitor.OutputChunkCount}");
            };
            _ = Task.Run(() => DrainMonitorOutputAsync(monitor, process.StandardOutput, "stdout"));
            _ = Task.Run(() => DrainMonitorOutputAsync(monitor, process.StandardError, "stderr"));
            WorkerLog.Debug(
                $"code-compatible monitor started id={id} pid={monitor.ProcessId} cwd={cwd} commandLen={command.Length}");

            return EncodeJsonObject(writer =>
            {
                writer.WritePropertyName("result");
                writer.WriteStartObject();
                writer.WriteString("id", id);
                writer.WriteString("processId", monitor.ProcessId);
                writer.WriteString("terminalId", id);
                writer.WriteString("status", "running");
                writer.WriteString("cwd", cwd);
                writer.WriteString("command", command);
                if (!string.IsNullOrWhiteSpace(description))
                {
                    writer.WriteString("description", description);
                }
                writer.WriteNumber("createdAt", startedAt);
                writer.WriteEndObject();
            });
        }
        catch (Exception ex)
        {
            process.Dispose();
            WorkerLog.Warn(
                $"code-compatible monitor failed id={id} error={ex.GetType().Name}: {ex.Message}");
            return EncodeError(ex.Message);
        }
    }

    private static async Task DrainMonitorOutputAsync(
        NativeMonitorProcess monitor,
        StreamReader reader,
        string streamName)
    {
        var buffer = new char[4096];
        try
        {
            while (await reader.ReadAsync(buffer.AsMemory()) is var read && read > 0)
            {
                monitor.AppendOutput(new string(buffer, 0, read), streamName);
            }
        }
        catch (Exception ex)
        {
            WorkerLog.Debug(
                $"code-compatible monitor output ended id={monitor.Id} stream={streamName} error={ex.GetType().Name}: {ex.Message}");
        }
    }

    private static Process CreateShellProcess(string fileName, IReadOnlyList<string> arguments, string cwd)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        return new Process { StartInfo = startInfo };
    }

    private static ShellLaunch ResolveDefaultShellLaunch(string command)
    {
        if (OperatingSystem.IsWindows())
        {
            return new ShellLaunch("cmd.exe", ["/d", "/s", "/c", command]);
        }

        return new ShellLaunch("/bin/zsh", ["-lc", command]);
    }

    private static string ResolveCwd(JsonElement parameters)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim();
        return string.IsNullOrWhiteSpace(workingFolder)
            ? Environment.CurrentDirectory
            : Path.GetFullPath(workingFolder);
    }

    private static async Task<string> CompleteOutputTaskAsync(Task<string> task)
    {
        try
        {
            return await task;
        }
        catch (OperationCanceledException)
        {
            return string.Empty;
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
        }
    }

    private static int? SafeExitCode(Process process)
    {
        try
        {
            return process.ExitCode;
        }
        catch
        {
            return null;
        }
    }

    private static string Truncate(string value, int maxChars)
    {
        return value.Length <= maxChars ? value : value[..maxChars] + "\n...[truncated]";
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
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

    private sealed record ShellLaunch(string Shell, IReadOnlyList<string> Arguments);

    private sealed class NativeMonitorProcess
    {
        private readonly object sync = new();
        private readonly Queue<string> output = new();

        public NativeMonitorProcess(
            string id,
            Process process,
            string command,
            string cwd,
            string? description,
            string? sessionId,
            long createdAt)
        {
            Id = id;
            Process = process;
            Command = command;
            Cwd = cwd;
            Description = description;
            SessionId = sessionId;
            CreatedAt = createdAt;
        }

        public string Id { get; }

        public Process Process { get; }

        public string Command { get; }

        public string Cwd { get; }

        public string? Description { get; }

        public string? SessionId { get; }

        public long CreatedAt { get; }

        public string? ProcessId { get; set; }

        public bool Exited { get; set; }

        public int? ExitCode { get; set; }

        public long? ExitedAt { get; set; }

        public int OutputChunkCount
        {
            get
            {
                lock (sync)
                {
                    return output.Count;
                }
            }
        }

        public void AppendOutput(string chunk, string stream)
        {
            lock (sync)
            {
                output.Enqueue($"[{stream}] {chunk}");
                while (output.Count > MonitorOutputChunkLimit)
                {
                    output.Dequeue();
                }
            }
        }
    }
}
