using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

internal static class TerminalTools
{
    private const int DefaultCols = 80;
    private const int DefaultRows = 24;
    private const int MinCols = 20;
    private const int MinRows = 5;
    private const int MaxOutputBufferBytes = 64 * 1024;
    private const int MaxActiveSessions = 32;
    private const int ExitedSessionRetentionMs = 120_000;
    private static readonly TimeSpan InitialOutputWaitTimeout = TimeSpan.FromMilliseconds(120);
    private static readonly ConcurrentDictionary<string, TerminalSession> Sessions = new(StringComparer.Ordinal);
    private static readonly SemaphoreSlim CreateGate = new(1, 1);

    public static async Task<WorkerResponse> CreateAsync(JsonElement parameters, WorkerRequestContext context)
    {
        await CreateGate.WaitAsync(context.CancellationToken);
        try
        {
            return await CreateCoreAsync(parameters, context);
        }
        finally
        {
            CreateGate.Release();
        }
    }

    private static async Task<WorkerResponse> CreateCoreAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        PruneExpiredExitedSessions();
        var activeSessionCount = Sessions.Values.Count(static session => !session.ExitCode.HasValue);
        if (activeSessionCount >= MaxActiveSessions)
        {
            return WorkerResponse.Json(
                new TerminalCreateResult(
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    $"Terminal session quota exceeded ({MaxActiveSessions} active sessions)."),
                WorkerJsonContext.Default.TerminalCreateResult);
        }

        var startedAt = Stopwatch.GetTimestamp();
        var requestedCwd = JsonHelpers.GetString(parameters, "cwd");
        var cwd = ResolveCwd(requestedCwd);
        var cols = NormalizeDimension(JsonHelpers.GetInt(parameters, "cols", DefaultCols), MinCols);
        var rows = NormalizeDimension(JsonHelpers.GetInt(parameters, "rows", DefaultRows), MinRows);
        var title = JsonHelpers.GetString(parameters, "title")?.Trim();
        var command = JsonHelpers.GetString(parameters, "command")?.Trim();
        var lastError = "Unknown error";

        foreach (var launch in GetShellLaunchCandidates(parameters))
        {
            context.CancellationToken.ThrowIfCancellationRequested();
            Process? process = null;
            TerminalSession? session = null;
            string? id = null;
            var added = false;
            try
            {
                process = CreateProcess(launch, cwd, command, cols, rows, parameters);
                process.Start();
                process.StandardInput.AutoFlush = true;

                id = $"term-{Guid.NewGuid():N}";
                session = new TerminalSession(
                    id,
                    process,
                    context.ForBackgroundOperation(),
                    launch.Shell,
                    cwd,
                    cols,
                    rows,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    string.IsNullOrWhiteSpace(title) ? GetShellName(launch.Shell) : title,
                    string.IsNullOrWhiteSpace(command) ? null : command);

                if (!Sessions.TryAdd(id, session))
                {
                    throw new InvalidOperationException("Duplicate terminal session id.");
                }
                added = true;

                WorkerLog.Debug(
                    $"terminal created id={id} pid={process.Id} shell={launch.Shell} " +
                    $"cols={cols} rows={rows} cwdSet={!string.IsNullOrWhiteSpace(requestedCwd)} " +
                    $"commandSet={!string.IsNullOrWhiteSpace(command)} elapsedMs={ElapsedMs(startedAt)}");
                session.StartPumps();
                var initialOutputReady = await session.WaitForInitialOutputAsync(
                    InitialOutputWaitTimeout,
                    context.CancellationToken);
                WorkerLog.Debug(
                    $"terminal bootstrap id={id} initialOutputReady={initialOutputReady} " +
                    $"elapsedMs={ElapsedMs(startedAt)}");

                return WorkerResponse.Json(
                    new TerminalCreateResult(
                        id,
                        launch.Shell,
                        cwd,
                        cols,
                        rows,
                        session.CreatedAt,
                        session.Title,
                        session.Command,
                        null),
                    WorkerJsonContext.Default.TerminalCreateResult);
            }
            catch (Exception ex)
            {
                if (added && id is not null && session is not null)
                {
                    session.Kill();
                    RemoveSession(id, session, "create-failed");
                }
                else if (process is not null)
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
                        // Process may have exited while the create request was unwinding.
                    }
                    process.Dispose();
                }
                if (ex is OperationCanceledException)
                {
                    throw;
                }
                lastError = $"{launch.Shell}: {ex.Message}";
                WorkerLog.Debug($"terminal launch failed shell={launch.Shell} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        var cwdHint =
            !string.IsNullOrWhiteSpace(requestedCwd) && !string.Equals(requestedCwd, cwd, StringComparison.Ordinal)
                ? $" Requested cwd: {requestedCwd}. Fallback cwd: {cwd}."
                : $" Cwd: {cwd}.";
        return WorkerResponse.Json(
            new TerminalCreateResult(null, null, null, null, null, null, null, null, $"Failed to start terminal shell.{cwdHint} Last error: {lastError}"),
            WorkerJsonContext.Default.TerminalCreateResult);
    }

    public static async Task<WorkerResponse> InputAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        PruneExpiredExitedSessions();
        try
        {
            var id = RequireString(parameters, "id");
            var data = JsonHelpers.GetString(parameters, "data") ?? string.Empty;
            if (!Sessions.TryGetValue(id, out var session))
            {
                return Mutation(false, "Terminal not found");
            }

            var result = await session.WriteInputAsync(data, context.CancellationToken);
            WorkerLog.Debug(
                $"terminal input id={id} bytes={Encoding.UTF8.GetByteCount(data)} success={result.Success}");
            return Mutation(result.Success, result.Error);
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    public static WorkerResponse Resize(JsonElement parameters)
    {
        PruneExpiredExitedSessions();
        try
        {
            var id = RequireString(parameters, "id");
            if (!Sessions.TryGetValue(id, out var session))
            {
                return Mutation(false, "Terminal not found");
            }

            var cols = NormalizeDimension(JsonHelpers.GetInt(parameters, "cols", session.Cols), MinCols);
            var rows = NormalizeDimension(JsonHelpers.GetInt(parameters, "rows", session.Rows), MinRows);
            session.Resize(cols, rows);
            WorkerLog.Debug($"terminal resize id={id} cols={cols} rows={rows}");
            return Mutation(true, null);
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    public static WorkerResponse Kill(JsonElement parameters)
    {
        PruneExpiredExitedSessions();
        try
        {
            var id = RequireString(parameters, "id");
            if (!Sessions.TryGetValue(id, out var session))
            {
                return Mutation(false, "Terminal not found");
            }

            session.Kill();
            WorkerLog.Debug($"terminal kill requested id={id}");
            return Mutation(true, null);
        }
        catch (Exception ex)
        {
            return Mutation(false, ex.Message);
        }
    }

    public static WorkerResponse KillAll(JsonElement parameters)
    {
        foreach (var session in Sessions.Values)
        {
            session.Kill();
        }

        Sessions.Clear();
        WorkerLog.Debug("terminal kill-all requested");
        return Mutation(true, null);
    }

    public static WorkerResponse Get(JsonElement parameters)
    {
        PruneExpiredExitedSessions();
        try
        {
            var id = RequireString(parameters, "id");
            if (!Sessions.TryGetValue(id, out var session))
            {
                return WorkerResponse.Json(
                    new TerminalSnapshotResult(false, null, "Terminal not found"),
                    WorkerJsonContext.Default.TerminalSnapshotResult);
            }

            return WorkerResponse.Json(
                new TerminalSnapshotResult(true, session.ToRecord(includeBuffer: true), null),
                WorkerJsonContext.Default.TerminalSnapshotResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new TerminalSnapshotResult(false, null, ex.Message),
                WorkerJsonContext.Default.TerminalSnapshotResult);
        }
    }

    public static WorkerResponse List(JsonElement parameters)
    {
        PruneExpiredExitedSessions();
        var sessions = Sessions.Values
            .OrderBy(static session => session.CreatedAt)
            .Select(static session => session.ToRecord(includeBuffer: true))
            .ToList();
        return WorkerResponse.Json(sessions, WorkerJsonContext.Default.ListTerminalSessionRecord);
    }

    private static WorkerResponse Mutation(bool success, string? error)
    {
        return WorkerResponse.Json(
            new TerminalMutationResult(success, error),
            WorkerJsonContext.Default.TerminalMutationResult);
    }

    private static Process CreateProcess(
        TerminalShellLaunch launch,
        string cwd,
        string? command,
        int cols,
        int rows,
        JsonElement parameters)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = launch.Shell,
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardInput = true,
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
        startInfo.Environment["TERM"] = startInfo.Environment.TryGetValue("TERM", out var term) && !string.IsNullOrWhiteSpace(term)
            ? term
            : "xterm-256color";
        startInfo.Environment["COLUMNS"] = cols.ToString(CultureInfo.InvariantCulture);
        startInfo.Environment["LINES"] = rows.ToString(CultureInfo.InvariantCulture);
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

    private static IEnumerable<TerminalShellLaunch> GetShellLaunchCandidates(JsonElement parameters)
    {
        var preferred = JsonHelpers.GetString(parameters, "shell")?.Trim();
        if (OperatingSystem.IsWindows())
        {
            if (!string.IsNullOrWhiteSpace(preferred))
            {
                yield return new TerminalShellLaunch(preferred, []);
            }

            yield return new TerminalShellLaunch(GetEnvironmentValue(parameters, "ComSpec") ?? "cmd.exe", []);
            yield return new TerminalShellLaunch("powershell.exe", []);
            yield return new TerminalShellLaunch("pwsh.exe", []);
            yield break;
        }

        foreach (var shell in new[]
        {
            preferred,
            GetEnvironmentValue(parameters, "SHELL"),
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh"
        })
        {
            if (string.IsNullOrWhiteSpace(shell) || !File.Exists(shell))
            {
                continue;
            }

            yield return new TerminalShellLaunch(shell, shell == "/bin/sh" ? [] : ["-i"]);
        }

        yield return new TerminalShellLaunch("/bin/sh", []);
    }

    private static IEnumerable<string> GetLaunchArgs(TerminalShellLaunch launch, string? command)
    {
        if (OperatingSystem.IsWindows())
        {
            if (string.IsNullOrWhiteSpace(command))
            {
                return IsPowerShell(launch.Shell) ? ["-NoLogo"] : [];
            }

            return IsPowerShell(launch.Shell)
                ? ["-NoLogo", "-NoProfile", "-Command", command]
                : ["/d", "/s", "/c", command];
        }

        return string.IsNullOrWhiteSpace(command) ? launch.Args : ["-lc", command];
    }

    private static string? GetEnvironmentValue(JsonElement parameters, string key)
    {
        if (!parameters.TryGetProperty("env", out var envElement) || envElement.ValueKind != JsonValueKind.Object)
        {
            return Environment.GetEnvironmentVariable(key);
        }

        if (envElement.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
        {
            return value.GetString();
        }

        return Environment.GetEnvironmentVariable(key);
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

    private static int NormalizeDimension(int value, int minimum)
    {
        return Math.Max(minimum, value);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required terminal field: {name}");
    }

    private static bool IsPowerShell(string shell)
    {
        var name = Path.GetFileName(shell).ToLowerInvariant();
        return name is "powershell.exe" or "powershell" or "pwsh.exe" or "pwsh";
    }

    private static string GetShellName(string shell)
    {
        return Path.GetFileName(shell) is { Length: > 0 } name ? name : shell;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static void PruneExpiredExitedSessions()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var entry in Sessions)
        {
            if (!entry.Value.ShouldPrune(now))
            {
                continue;
            }

            RemoveSession(entry.Key, entry.Value, "expired");
        }
    }

    private static void RemoveSession(string id, TerminalSession session, string reason)
    {
        if (!Sessions.TryRemove(new KeyValuePair<string, TerminalSession>(id, session)))
        {
            return;
        }

        session.Dispose();
        WorkerLog.Debug($"terminal removed id={id} reason={reason}");
    }

    private sealed record TerminalShellLaunch(string Shell, string[] Args);

    private sealed class TerminalSession : IDisposable
    {
        private readonly object gate = new();
        private readonly Process process;
        private WorkerRequestContext? context;
        private readonly List<TerminalOutputChunk> outputBuffer = [];
        private readonly TaskCompletionSource<bool> initialOutputSignal = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int outputBufferBytes;
        private int nextSeq;
        private bool exitEmitted;
        private bool cleanupScheduled;
        private bool disposed;

        public TerminalSession(
            string id,
            Process process,
            WorkerRequestContext context,
            string shell,
            string cwd,
            int cols,
            int rows,
            long createdAt,
            string title,
            string? command)
        {
            Id = id;
            this.process = process;
            this.context = context;
            Shell = shell;
            Cwd = cwd;
            Cols = cols;
            Rows = rows;
            CreatedAt = createdAt;
            Title = title;
            Command = command;
        }

        public string Id { get; }

        public string Shell { get; }

        public string Cwd { get; }

        public int Cols { get; private set; }

        public int Rows { get; private set; }

        public long CreatedAt { get; }

        public string Title { get; }

        public string? Command { get; }

        public int? ExitCode { get; private set; }

        public int? ExitSignal { get; private set; }

        public long? ExitedAt { get; private set; }

        public void StartPumps()
        {
            var stdoutTask = PumpStreamAsync(process.StandardOutput);
            var stderrTask = PumpStreamAsync(process.StandardError);
            _ = WatchExitAsync(stdoutTask, stderrTask);
        }

        public async Task<bool> WaitForInitialOutputAsync(
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            if (timeout <= TimeSpan.Zero)
            {
                return initialOutputSignal.Task.IsCompletedSuccessfully && initialOutputSignal.Task.Result;
            }

            var completed = await Task.WhenAny(
                initialOutputSignal.Task,
                Task.Delay(timeout, cancellationToken));
            cancellationToken.ThrowIfCancellationRequested();
            if (completed != initialOutputSignal.Task)
            {
                return false;
            }

            return await initialOutputSignal.Task;
        }

        public async Task<(bool Success, string? Error)> WriteInputAsync(
            string data,
            CancellationToken cancellationToken)
        {
            if (ExitCode.HasValue)
            {
                return (false, "Terminal already exited");
            }

            try
            {
                var normalized = data.Replace("\r\n", "\n", StringComparison.Ordinal)
                    .Replace("\r", "\n", StringComparison.Ordinal);
                await process.StandardInput.WriteAsync(normalized.AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);
                return (true, null);
            }
            catch (Exception ex)
            {
                return (false, ex.Message);
            }
        }

        public void Resize(int cols, int rows)
        {
            lock (gate)
            {
                Cols = cols;
                Rows = rows;
            }
        }

        public void Kill()
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
                // The process may exit between HasExited and Kill.
            }
        }

        public TerminalSessionRecord ToRecord(bool includeBuffer)
        {
            lock (gate)
            {
                return new TerminalSessionRecord(
                    Id,
                    Shell,
                    Cwd,
                    Cols,
                    Rows,
                    CreatedAt,
                    Title,
                    Command,
                    ExitCode,
                    ExitSignal,
                    includeBuffer ? outputBuffer.ToList() : []);
            }
        }

        private async Task PumpStreamAsync(StreamReader reader)
        {
            var buffer = new char[4096];
            try
            {
                while (true)
                {
                    var read = await reader.ReadAsync(buffer.AsMemory());
                    if (read <= 0)
                    {
                        break;
                    }

                    var data = new string(buffer, 0, read);
                    var chunk = AppendOutput(data);
                    await EmitOutputAsync(chunk);
                }
            }
            catch (Exception ex)
            {
                WorkerLog.Debug($"terminal stream stopped id={Id} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        private async Task WatchExitAsync(Task stdoutTask, Task stderrTask)
        {
            try
            {
                await process.WaitForExitAsync();
                await Task.WhenAll(stdoutTask, stderrTask);
                MarkExited(process.ExitCode, null);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"terminal exit watch failed id={Id} error={ex.GetType().Name}: {ex.Message}");
                MarkExited(1, null);
            }
            finally
            {
                await EmitExitAsync();
                ReleaseCompletionReferences();
                ScheduleCleanup();
                WorkerLog.Debug($"terminal exited id={Id} exitCode={ExitCode ?? 0}");
            }
        }

        private TerminalOutputChunk AppendOutput(string data)
        {
            lock (gate)
            {
                var chunk = new TerminalOutputChunk(++nextSeq, data);
                outputBuffer.Add(chunk);
                outputBufferBytes += Encoding.UTF8.GetByteCount(data);

                while (outputBuffer.Count > 1 && outputBufferBytes > MaxOutputBufferBytes)
                {
                    var removed = outputBuffer[0];
                    outputBuffer.RemoveAt(0);
                    outputBufferBytes -= Encoding.UTF8.GetByteCount(removed.Data);
                }

                initialOutputSignal.TrySetResult(true);
                return chunk;
            }
        }

        public bool ShouldPrune(long now)
        {
            lock (gate)
            {
                return ExitedAt.HasValue && now - ExitedAt.Value >= ExitedSessionRetentionMs;
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }

                disposed = true;
                context = null;
                outputBuffer.Clear();
                outputBufferBytes = 0;
            }

            process.Dispose();
        }

        private void MarkExited(int exitCode, int? signal)
        {
            lock (gate)
            {
                if (ExitCode.HasValue)
                {
                    return;
                }

                ExitCode = exitCode;
                ExitSignal = signal;
                ExitedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                initialOutputSignal.TrySetResult(false);
            }
        }

        private async ValueTask EmitOutputAsync(TerminalOutputChunk chunk)
        {
            var currentContext = context;
            if (currentContext is null)
            {
                return;
            }

            try
            {
                await currentContext.EmitEventAsync(
                    "terminal/output",
                    new TerminalOutputEvent(Id, chunk.Data, chunk.Seq),
                    WorkerJsonContext.Default.TerminalOutputEvent);
            }
            catch (Exception ex)
            {
                WorkerLog.Debug($"terminal output event failed id={Id} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        private async ValueTask EmitExitAsync()
        {
            lock (gate)
            {
                if (exitEmitted)
                {
                    return;
                }

                exitEmitted = true;
            }

            var currentContext = context;
            if (currentContext is null)
            {
                return;
            }

            try
            {
                await currentContext.EmitEventAsync(
                    "terminal/exit",
                    new TerminalExitEvent(Id, ExitCode ?? 0, ExitSignal),
                    WorkerJsonContext.Default.TerminalExitEvent);
            }
            catch (Exception ex)
            {
                WorkerLog.Debug($"terminal exit event failed id={Id} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        private void ReleaseCompletionReferences()
        {
            lock (gate)
            {
                context = null;
            }

            process.Dispose();
        }

        private void ScheduleCleanup()
        {
            lock (gate)
            {
                if (cleanupScheduled || ExitedAt is null)
                {
                    return;
                }

                cleanupScheduled = true;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(ExitedSessionRetentionMs);
                }
                catch
                {
                    return;
                }

                RemoveSession(Id, this, "exit-retention");
            });
        }
    }
}
