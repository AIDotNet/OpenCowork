using System.Diagnostics;
using System.Security.Cryptography;
using System.Globalization;
using System.Text;
using System.Text.Json;

internal static class SshOpenSsh
{
    private const int DefaultTimeoutMs = 60_000;
    private const int MaxTimeoutMs = 30 * 60_000;
    private const int DefaultMaxStdoutChars = 2 * 1024 * 1024;
    private const int DefaultMaxStderrChars = 256 * 1024;
    private const string ControlSocketDirUnix = "/tmp/open-cowork-ssh";
    private const string AskPassModeEnv = "OPEN_COWORK_SSH_ASKPASS_MODE";
    private const string AskPassSecretEnv = "OPEN_COWORK_SSH_ASKPASS_SECRET";

    public static async Task<SshCommandResult> ExecuteAsync(
        JsonElement parameters,
        string command,
        int timeoutMs,
        byte[]? stdinBytes = null,
        int maxStdoutChars = DefaultMaxStdoutChars,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        var connection = ResolveConnectionElement(parameters, "connection");
        return await ExecuteWithConnectionAsync(
            parameters,
            connection,
            command,
            timeoutMs,
            stdinBytes,
            maxStdoutChars,
            maxStderrChars);
    }

    public static async Task<SshCommandResult> ExecuteAsync(
        JsonElement parameters,
        string connectionPropertyName,
        string command,
        int timeoutMs,
        byte[]? stdinBytes = null,
        int maxStdoutChars = DefaultMaxStdoutChars,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        var connection = ResolveConnectionElement(parameters, connectionPropertyName);
        return await ExecuteWithConnectionAsync(
            parameters,
            connection,
            command,
            timeoutMs,
            stdinBytes,
            maxStdoutChars,
            maxStderrChars);
    }

    private static async Task<SshCommandResult> ExecuteWithConnectionAsync(
        JsonElement parameters,
        JsonElement connection,
        string command,
        int timeoutMs,
        byte[]? stdinBytes,
        int maxStdoutChars,
        int maxStderrChars)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var stdout = new OutputCollector(maxStdoutChars);
        var stderr = new OutputCollector(maxStderrChars);
        var normalizedTimeoutMs = Math.Clamp(timeoutMs <= 0 ? DefaultTimeoutMs : timeoutMs, 1, MaxTimeoutMs);
        var launch = ResolveSshLaunch(connection, parameters);

        WorkerLog.Debug(
            $"ssh command start connectionId={FormatLogValue(JsonHelpers.GetString(connection, "id"))} " +
            $"host={launch.Host} port={launch.Port} userSet={!string.IsNullOrWhiteSpace(launch.Username)} " +
            $"proxyJumpSet={!string.IsNullOrWhiteSpace(launch.ProxyJump)} timeoutMs={normalizedTimeoutMs} " +
            $"stdinBytes={stdinBytes?.Length ?? 0}");

        using var process = CreateProcess(launch, command, stdinBytes is not null);
        var spawnStartedAt = Stopwatch.GetTimestamp();
        process.Start();
        var spawnMs = ElapsedMs(spawnStartedAt);

        var stdoutTask = ReadStreamAsync(process.StandardOutput, stdout);
        var stderrTask = ReadStreamAsync(process.StandardError, stderr);
        var stdinTask = stdinBytes is null
            ? Task.CompletedTask
            : WriteStdinAsync(process, stdinBytes);

        using var timeoutCts = new CancellationTokenSource();
        var timeoutTask = Task.Delay(normalizedTimeoutMs, timeoutCts.Token);
        var exitTask = process.WaitForExitAsync();
        var timedOut = await Task.WhenAny(exitTask, timeoutTask) == timeoutTask;

        if (timedOut)
        {
            KillProcess(process);
            await process.WaitForExitAsync(CancellationToken.None);
        }
        else
        {
            await timeoutCts.CancelAsync();
            await exitTask;
        }

        await Task.WhenAll(stdoutTask, stderrTask, stdinTask);
        var exitCode = timedOut ? 124 : process.ExitCode;
        WorkerLog.Debug(
            $"ssh command done connectionId={FormatLogValue(JsonHelpers.GetString(connection, "id"))} " +
            $"exitCode={exitCode} timedOut={timedOut} totalMs={ElapsedMs(startedAt)}");

        return new SshCommandResult(
            exitCode,
            stdout.ToString(),
            stderr.ToString(),
            timedOut,
            ElapsedMs(startedAt),
            spawnMs);
    }

    public static async Task<SshFileStreamResult> ExecuteToFileAsync(
        JsonElement parameters,
        string command,
        string localPath,
        int timeoutMs,
        Action<Process>? processStarted = null,
        CancellationToken cancellationToken = default,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var stderr = new OutputCollector(maxStderrChars);
        var normalizedTimeoutMs = Math.Clamp(timeoutMs <= 0 ? DefaultTimeoutMs : timeoutMs, 1, MaxTimeoutMs);
        var connection = parameters.TryGetProperty("connection", out var connectionElement)
            ? connectionElement
            : throw new InvalidOperationException("Missing SSH connection");
        var launch = ResolveSshLaunch(connection, parameters);
        var targetPath = Path.GetFullPath(localPath);
        var targetDir = Path.GetDirectoryName(targetPath);
        if (!string.IsNullOrWhiteSpace(targetDir))
        {
            Directory.CreateDirectory(targetDir);
        }

        var tempPath = Path.Combine(
            string.IsNullOrWhiteSpace(targetDir) ? Environment.CurrentDirectory : targetDir,
            $".{Path.GetFileName(targetPath)}.open-cowork-{Guid.NewGuid():N}.tmp");

        WorkerLog.Debug(
            $"ssh stream-to-file start connectionId={FormatLogValue(JsonHelpers.GetString(connection, "id"))} " +
            $"host={launch.Host} port={launch.Port} userSet={!string.IsNullOrWhiteSpace(launch.Username)} " +
            $"proxyJumpSet={!string.IsNullOrWhiteSpace(launch.ProxyJump)} timeoutMs={normalizedTimeoutMs}");

        try
        {
            using var process = CreateProcess(launch, command, redirectStdin: false);
            var spawnStartedAt = Stopwatch.GetTimestamp();
            process.Start();
            processStarted?.Invoke(process);
            var spawnMs = ElapsedMs(spawnStartedAt);
            long bytes;
            int exitCode;
            bool timedOut;

            await using (var output = new FileStream(
                tempPath,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 1024 * 1024,
                useAsync: true))
            {
                var stdoutTask = process.StandardOutput.BaseStream.CopyToAsync(output, cancellationToken);
                var stderrTask = ReadStreamAsync(process.StandardError, stderr);

                using var timeoutCts = new CancellationTokenSource();
                var timeoutTask = Task.Delay(normalizedTimeoutMs, timeoutCts.Token);
                var exitTask = process.WaitForExitAsync(cancellationToken);
                timedOut = await Task.WhenAny(exitTask, timeoutTask) == timeoutTask;

                if (timedOut)
                {
                    KillProcess(process);
                    await process.WaitForExitAsync(CancellationToken.None);
                }
                else
                {
                    await timeoutCts.CancelAsync();
                    try
                    {
                        await exitTask;
                    }
                    catch (OperationCanceledException)
                    {
                        KillProcess(process);
                        await process.WaitForExitAsync(CancellationToken.None);
                    }
                }

                Exception? stdoutError = null;
                try
                {
                    await stdoutTask;
                }
                catch (Exception ex)
                {
                    stdoutError = ex;
                }

                await stderrTask;
                if (stdoutError is not null)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        throw new OperationCanceledException("SSH download canceled", stdoutError, cancellationToken);
                    }

                    if (!timedOut || stdoutError is not IOException)
                    {
                        throw stdoutError;
                    }
                }

                await output.FlushAsync();
                bytes = output.Length;
                exitCode = timedOut ? 124 : process.ExitCode;
            }

            if (exitCode == 0)
            {
                File.Move(tempPath, targetPath, overwrite: true);
            }
            else
            {
                DeleteFileIfExists(tempPath);
            }

            WorkerLog.Debug(
                $"ssh stream-to-file done connectionId={FormatLogValue(JsonHelpers.GetString(connection, "id"))} " +
                $"exitCode={exitCode} timedOut={timedOut} bytes={bytes} totalMs={ElapsedMs(startedAt)}");

            return new SshFileStreamResult(
                exitCode,
                stderr.ToString(),
                timedOut,
                ElapsedMs(startedAt),
                spawnMs,
                bytes);
        }
        catch
        {
            DeleteFileIfExists(tempPath);
            throw;
        }
    }

    public static async Task<SshFileStreamResult> ExecuteFromFileAsync(
        JsonElement parameters,
        string command,
        string localPath,
        int timeoutMs,
        Func<long, long, ValueTask>? reportProgressAsync = null,
        Action<Process>? processStarted = null,
        CancellationToken cancellationToken = default,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var stderr = new OutputCollector(maxStderrChars);
        var normalizedTimeoutMs = Math.Clamp(timeoutMs <= 0 ? DefaultTimeoutMs : timeoutMs, 1, MaxTimeoutMs);
        var connection = parameters.TryGetProperty("connection", out var connectionElement)
            ? connectionElement
            : throw new InvalidOperationException("Missing SSH connection");
        var launch = ResolveSshLaunch(connection, parameters);
        var sourcePath = Path.GetFullPath(localPath);
        var totalBytes = new FileInfo(sourcePath).Length;

        WorkerLog.Debug(
            $"ssh stream-from-file start connectionId={FormatLogValue(JsonHelpers.GetString(connection, "id"))} " +
            $"host={launch.Host} port={launch.Port} userSet={!string.IsNullOrWhiteSpace(launch.Username)} " +
            $"proxyJumpSet={!string.IsNullOrWhiteSpace(launch.ProxyJump)} timeoutMs={normalizedTimeoutMs} " +
            $"bytes={totalBytes}");

        using var process = CreateProcess(launch, command, redirectStdin: true);
        var spawnStartedAt = Stopwatch.GetTimestamp();
        process.Start();
        processStarted?.Invoke(process);
        var spawnMs = ElapsedMs(spawnStartedAt);

        var stderrTask = ReadStreamAsync(process.StandardError, stderr);
        var stdinTask = WriteFileToStdinAsync(
            process,
            sourcePath,
            totalBytes,
            reportProgressAsync,
            cancellationToken);

        using var timeoutCts = new CancellationTokenSource();
        var timeoutTask = Task.Delay(normalizedTimeoutMs, timeoutCts.Token);
        var exitTask = process.WaitForExitAsync(cancellationToken);
        var timedOut = await Task.WhenAny(exitTask, timeoutTask) == timeoutTask;

        if (timedOut)
        {
            KillProcess(process);
            await process.WaitForExitAsync(CancellationToken.None);
        }
        else
        {
            await timeoutCts.CancelAsync();
            try
            {
                await exitTask;
            }
            catch (OperationCanceledException)
            {
                KillProcess(process);
                await process.WaitForExitAsync(CancellationToken.None);
            }
        }

        long bytesWritten;
        Exception? stdinError = null;
        try
        {
            bytesWritten = await stdinTask;
        }
        catch (Exception ex)
        {
            stdinError = ex;
            bytesWritten = 0;
        }

        await stderrTask;
        if (stdinError is not null)
        {
            throw stdinError;
        }

        var exitCode = timedOut ? 124 : process.ExitCode;
        WorkerLog.Debug(
            $"ssh stream-from-file done connectionId={FormatLogValue(JsonHelpers.GetString(connection, "id"))} " +
            $"exitCode={exitCode} timedOut={timedOut} bytes={bytesWritten} totalMs={ElapsedMs(startedAt)}");

        return new SshFileStreamResult(
            exitCode,
            stderr.ToString(),
            timedOut,
            ElapsedMs(startedAt),
            spawnMs,
            bytesWritten);
    }

    public static async Task<SshFileStreamResult> ExecuteRemoteToRemoteFileAsync(
        JsonElement parameters,
        string sourcePath,
        string targetPath,
        int timeoutMs,
        Action<Process>? processStarted = null,
        CancellationToken cancellationToken = default,
        int maxStderrChars = DefaultMaxStderrChars)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var sourceStderr = new OutputCollector(maxStderrChars);
        var targetStderr = new OutputCollector(maxStderrChars);
        var targetStdout = new OutputCollector(16 * 1024);
        var normalizedTimeoutMs = Math.Clamp(timeoutMs <= 0 ? DefaultTimeoutMs : timeoutMs, 1, MaxTimeoutMs);
        var sourceConnection = parameters.TryGetProperty("sourceConnection", out var sourceConnectionElement)
            ? sourceConnectionElement
            : throw new InvalidOperationException("Missing SSH source connection");
        var targetConnection = parameters.TryGetProperty("targetConnection", out var targetConnectionElement)
            ? targetConnectionElement
            : throw new InvalidOperationException("Missing SSH target connection");
        var sourceLaunch = ResolveSshLaunch(sourceConnection, parameters);
        var targetLaunch = ResolveSshLaunch(targetConnection, parameters);

        WorkerLog.Debug(
            $"ssh stream-remote-to-remote start sourceConnectionId={FormatLogValue(JsonHelpers.GetString(sourceConnection, "id"))} " +
            $"targetConnectionId={FormatLogValue(JsonHelpers.GetString(targetConnection, "id"))} " +
            $"sourceHost={sourceLaunch.Host} targetHost={targetLaunch.Host} timeoutMs={normalizedTimeoutMs}");

        using var sourceProcess = CreateProcess(
            sourceLaunch,
            $"cat -- {ShellPathExpr(sourcePath)}",
            redirectStdin: false);
        using var targetProcess = CreateProcess(
            targetLaunch,
            $"mkdir -p -- {ShellPathExpr(PosixDirname(targetPath))} && cat > {ShellPathExpr(targetPath)}",
            redirectStdin: true);

        var spawnStartedAt = Stopwatch.GetTimestamp();
        sourceProcess.Start();
        processStarted?.Invoke(sourceProcess);
        targetProcess.Start();
        processStarted?.Invoke(targetProcess);
        var spawnMs = ElapsedMs(spawnStartedAt);

        var sourceStderrTask = ReadStreamAsync(sourceProcess.StandardError, sourceStderr);
        var targetStderrTask = ReadStreamAsync(targetProcess.StandardError, targetStderr);
        var targetStdoutTask = ReadStreamAsync(targetProcess.StandardOutput, targetStdout);
        var copyTask = CopyAndCloseAsync(
            sourceProcess.StandardOutput.BaseStream,
            targetProcess.StandardInput.BaseStream,
            cancellationToken);

        using var timeoutCts = new CancellationTokenSource();
        var timeoutTask = Task.Delay(normalizedTimeoutMs, timeoutCts.Token);
        var doneTask = Task.WhenAll(
            sourceProcess.WaitForExitAsync(cancellationToken),
            targetProcess.WaitForExitAsync(cancellationToken),
            copyTask);
        var timedOut = await Task.WhenAny(doneTask, timeoutTask) == timeoutTask;

        if (timedOut)
        {
            KillProcess(sourceProcess);
            KillProcess(targetProcess);
            await Task.WhenAll(
                sourceProcess.WaitForExitAsync(CancellationToken.None),
                targetProcess.WaitForExitAsync(CancellationToken.None));
        }
        else
        {
            await timeoutCts.CancelAsync();
            try
            {
                await doneTask;
            }
            catch (OperationCanceledException)
            {
                KillProcess(sourceProcess);
                KillProcess(targetProcess);
                await Task.WhenAll(
                    sourceProcess.WaitForExitAsync(CancellationToken.None),
                    targetProcess.WaitForExitAsync(CancellationToken.None));
            }
        }

        Exception? copyError = null;
        long bytes = 0;
        try
        {
            bytes = await copyTask;
        }
        catch (Exception ex)
        {
            copyError = ex;
        }

        await Task.WhenAll(sourceStderrTask, targetStderrTask, targetStdoutTask);
        if (copyError is not null)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException("SSH remote copy canceled", copyError, cancellationToken);
            }

            if (!timedOut && copyError is not IOException && SourceExitCode(sourceProcess) == 0 && SourceExitCode(targetProcess) == 0)
            {
                throw copyError;
            }
        }

        var sourceExitCode = timedOut ? 124 : SourceExitCode(sourceProcess);
        var targetExitCode = timedOut ? 124 : SourceExitCode(targetProcess);
        var exitCode = sourceExitCode == 0 ? targetExitCode : sourceExitCode;
        var stderr = CombineRemoteCopyOutput(
            sourceStderr.ToString(),
            targetStderr.ToString(),
            targetStdout.ToString());

        WorkerLog.Debug(
            $"ssh stream-remote-to-remote done sourceConnectionId={FormatLogValue(JsonHelpers.GetString(sourceConnection, "id"))} " +
            $"targetConnectionId={FormatLogValue(JsonHelpers.GetString(targetConnection, "id"))} " +
            $"exitCode={exitCode} timedOut={timedOut} bytes={bytes} totalMs={ElapsedMs(startedAt)}");

        return new SshFileStreamResult(
            exitCode,
            stderr,
            timedOut,
            ElapsedMs(startedAt),
            spawnMs,
            bytes);
    }

    public static string ShellEscape(string value)
    {
        return "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";
    }

    public static string ShellPathExpr(string value)
    {
        if (value == "~")
        {
            return "\"$HOME\"";
        }

        if (value.StartsWith("~/", StringComparison.Ordinal))
        {
            return "\"$HOME\"" + ShellEscape(value[1..]);
        }

        return ShellEscape(value);
    }

    private static async Task WriteStdinAsync(Process process, byte[] bytes)
    {
        try
        {
            await process.StandardInput.BaseStream.WriteAsync(bytes);
            await process.StandardInput.BaseStream.FlushAsync();
            process.StandardInput.Close();
        }
        catch (Exception ex)
        {
            WorkerLog.Debug($"ssh stdin write stopped error={ex.GetType().Name}: {ex.Message}");
        }
    }

    private static async Task<long> WriteFileToStdinAsync(
        Process process,
        string localPath,
        long totalBytes,
        Func<long, long, ValueTask>? reportProgressAsync,
        CancellationToken cancellationToken)
    {
        var written = 0L;
        var lastReportAt = Stopwatch.GetTimestamp();
        await using var input = new FileStream(
            localPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 1024 * 1024,
            useAsync: true);

        await ReportProgressAsync(reportProgressAsync, written, totalBytes);
        var buffer = new byte[1024 * 1024];
        while (true)
        {
            var read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
            if (read <= 0)
            {
                break;
            }

            try
            {
                await process.StandardInput.BaseStream.WriteAsync(
                    buffer.AsMemory(0, read),
                    cancellationToken);
            }
            catch (Exception ex) when (ex is IOException or InvalidOperationException)
            {
                WorkerLog.Debug($"ssh stdin file upload stopped error={ex.GetType().Name}: {ex.Message}");
                break;
            }

            written += read;
            if (Stopwatch.GetElapsedTime(lastReportAt).TotalMilliseconds >= 200)
            {
                lastReportAt = Stopwatch.GetTimestamp();
                await ReportProgressAsync(reportProgressAsync, written, totalBytes);
            }
        }

        try
        {
            await process.StandardInput.BaseStream.FlushAsync(cancellationToken);
            process.StandardInput.Close();
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        {
            WorkerLog.Debug($"ssh stdin file upload close stopped error={ex.GetType().Name}: {ex.Message}");
        }

        await ReportProgressAsync(reportProgressAsync, written, totalBytes);
        return written;
    }

    private static async ValueTask ReportProgressAsync(
        Func<long, long, ValueTask>? reportProgressAsync,
        long current,
        long total)
    {
        if (reportProgressAsync is not null)
        {
            await reportProgressAsync(current, total);
        }
    }

    private static async Task<long> CopyAndCloseAsync(
        Stream source,
        Stream target,
        CancellationToken cancellationToken)
    {
        var bytes = 0L;
        var buffer = new byte[1024 * 1024];
        try
        {
            while (true)
            {
                var read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
                if (read <= 0)
                {
                    break;
                }

                await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                bytes += read;
            }

            await target.FlushAsync(cancellationToken);
            return bytes;
        }
        finally
        {
            try
            {
                target.Close();
            }
            catch
            {
                // Target stdin may already be closed by the remote process.
            }
        }
    }

    private static SshLaunch ResolveSshLaunch(JsonElement connection, JsonElement parameters)
    {
        var host = RequireString(connection, "host");
        var authType = NormalizeAuthType(JsonHelpers.GetString(connection, "authType"));
        var username = JsonHelpers.GetString(connection, "username");
        var port = JsonHelpers.GetInt(connection, "port", 22);
        var privateKeyPath = JsonHelpers.GetString(connection, "privateKeyPath");
        var password = JsonHelpers.GetString(connection, "password");
        var passphrase = JsonHelpers.GetString(connection, "passphrase");
        var proxyJump = JsonHelpers.GetString(connection, "proxyJump");
        var sshPath = JsonHelpers.GetString(parameters, "sshPath");
        return new SshLaunch(
            string.IsNullOrWhiteSpace(sshPath) ? "ssh" : sshPath,
            host,
            string.IsNullOrWhiteSpace(username) ? null : username,
            port <= 0 ? 22 : port,
            string.IsNullOrWhiteSpace(privateKeyPath) ? null : ExpandHome(privateKeyPath),
            string.IsNullOrWhiteSpace(proxyJump) ? null : proxyJump,
            authType,
            ResolveAskPassSecret(authType, password, passphrase));
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

    private static int SourceExitCode(Process process)
    {
        try
        {
            return process.ExitCode;
        }
        catch
        {
            return 1;
        }
    }

    private static string CombineRemoteCopyOutput(
        string sourceStderr,
        string targetStderr,
        string targetStdout)
    {
        var builder = new StringBuilder();
        AppendLabeledOutput(builder, "source", sourceStderr);
        AppendLabeledOutput(builder, "target", targetStderr);
        AppendLabeledOutput(builder, "target-stdout", targetStdout);
        return builder.ToString();
    }

    private static void AppendLabeledOutput(StringBuilder builder, string label, string text)
    {
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return;
        }

        if (builder.Length > 0)
        {
            builder.AppendLine();
        }

        builder.Append('[');
        builder.Append(label);
        builder.Append("] ");
        builder.Append(trimmed);
    }

    private static Process CreateProcess(SshLaunch launch, string command, bool redirectStdin)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = launch.SshPath,
            UseShellExecute = false,
            RedirectStandardInput = redirectStdin,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true
        };
        var usesAskPass = !string.IsNullOrEmpty(launch.AskPassSecret);
        var usesPasswordAuth = launch.AuthType == "password";

        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add(usesAskPass ? "BatchMode=no" : "BatchMode=yes");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add($"PreferredAuthentications={ResolvePreferredAuthentications(launch)}");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add($"PasswordAuthentication={(usesPasswordAuth ? "yes" : "no")}");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add(
            $"KbdInteractiveAuthentication={(usesPasswordAuth ? "yes" : "no")}");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add($"PubkeyAuthentication={(usesPasswordAuth ? "no" : "yes")}");
        if (usesAskPass)
        {
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add("NumberOfPasswordPrompts=1");
        }
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add("StrictHostKeyChecking=accept-new");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add("ServerAliveInterval=15");
        startInfo.ArgumentList.Add("-o");
        startInfo.ArgumentList.Add("ServerAliveCountMax=2");
        if (TryConfigureConnectionMultiplexing(startInfo, launch))
        {
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add("ControlMaster=auto");
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add("ControlPersist=60");
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add("StreamLocalBindUnlink=yes");
        }
        startInfo.ArgumentList.Add("-p");
        startInfo.ArgumentList.Add(launch.Port.ToString(CultureInfo.InvariantCulture));

        if (!string.IsNullOrWhiteSpace(launch.Username))
        {
            startInfo.ArgumentList.Add("-l");
            startInfo.ArgumentList.Add(launch.Username);
        }

        if (!string.IsNullOrWhiteSpace(launch.PrivateKeyPath))
        {
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add("IdentitiesOnly=yes");
            startInfo.ArgumentList.Add("-i");
            startInfo.ArgumentList.Add(launch.PrivateKeyPath);
        }

        if (!string.IsNullOrWhiteSpace(launch.ProxyJump))
        {
            startInfo.ArgumentList.Add("-J");
            startInfo.ArgumentList.Add(launch.ProxyJump);
        }

        string? askPassHelperPath = null;
        if (usesAskPass)
        {
            askPassHelperPath = ConfigureAskPass(startInfo, launch.AskPassSecret!);
        }

        startInfo.ArgumentList.Add(launch.Host);
        startInfo.ArgumentList.Add(command);
        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!string.IsNullOrWhiteSpace(askPassHelperPath))
        {
            process.Exited += (_, _) => DeleteFileIfExists(askPassHelperPath);
        }
        return process;
    }

    private static string NormalizeAuthType(string? value)
    {
        return value is "privateKey" or "agent" or "password" ? value : "password";
    }

    private static string? ResolveAskPassSecret(
        string authType,
        string? password,
        string? passphrase)
    {
        return authType switch
        {
            "password" when !string.IsNullOrEmpty(password) => password,
            "privateKey" when !string.IsNullOrEmpty(passphrase) => passphrase,
            _ => null
        };
    }

    private static string ResolvePreferredAuthentications(SshLaunch launch)
    {
        return launch.AuthType switch
        {
            "password" => "password,keyboard-interactive",
            "privateKey" or "agent" => "publickey",
            _ => "password,keyboard-interactive,publickey"
        };
    }

    private static string? ConfigureAskPass(ProcessStartInfo startInfo, string secret)
    {
        string? helperPath = null;
        if (OperatingSystem.IsWindows())
        {
            var programPath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(programPath))
            {
                programPath = Process.GetCurrentProcess().MainModule?.FileName;
            }
            if (string.IsNullOrWhiteSpace(programPath))
            {
                throw new InvalidOperationException("Failed to resolve SSH askpass helper path");
            }
            startInfo.Environment["SSH_ASKPASS"] = programPath;
        }
        else
        {
            helperPath = Path.Combine(
                Path.GetTempPath(),
                $"open-cowork-ssh-askpass-{Guid.NewGuid():N}.sh");
            File.WriteAllText(
                helperPath,
                "#!/bin/sh\nprintf '%s\\n' \"${OPEN_COWORK_SSH_ASKPASS_SECRET}\"\n");
            File.SetUnixFileMode(
                helperPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            startInfo.Environment["SSH_ASKPASS"] = helperPath;
        }

        startInfo.Environment["SSH_ASKPASS_REQUIRE"] = "force";
        startInfo.Environment["DISPLAY"] = startInfo.Environment.TryGetValue("DISPLAY", out var display) &&
            !string.IsNullOrWhiteSpace(display)
                ? display
                : "127.0.0.1:0";
        startInfo.Environment[AskPassModeEnv] = "1";
        startInfo.Environment[AskPassSecretEnv] = secret;
        return helperPath;
    }

    private static bool TryConfigureConnectionMultiplexing(ProcessStartInfo startInfo, SshLaunch launch)
    {
        if (OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            Directory.CreateDirectory(ControlSocketDirUnix);
            var keyMaterial = string.Join(
                "\n",
                launch.Host,
                launch.Port.ToString(CultureInfo.InvariantCulture),
                launch.Username ?? string.Empty,
                launch.PrivateKeyPath ?? string.Empty,
                launch.ProxyJump ?? string.Empty,
                launch.AuthType);
            var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(keyMaterial));
            var socketName = Convert.ToHexString(hashBytes.AsSpan(0, 10)).ToLowerInvariant();
            var controlPath = Path.Combine(ControlSocketDirUnix, socketName);
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add($"ControlPath={controlPath}");
            return true;
        }
        catch (Exception ex)
        {
            WorkerLog.Debug($"ssh multiplex disabled error={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static async Task ReadStreamAsync(StreamReader reader, OutputCollector collector)
    {
        var buffer = new char[4096];
        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory());
            if (read <= 0)
            {
                break;
            }

            collector.Append(new string(buffer, 0, read));
        }
    }

    private static void KillProcess(Process process)
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

    private static void DeleteFileIfExists(string filePath)
    {
        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
            // Best-effort cleanup only.
        }
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required SSH field: {name}");
    }

    private static JsonElement ResolveConnectionElement(JsonElement parameters, string propertyName)
    {
        return parameters.TryGetProperty(propertyName, out var connection)
            ? connection
            : throw new InvalidOperationException($"Missing SSH connection: {propertyName}");
    }

    private static string ExpandHome(string filePath)
    {
        if (filePath == "~")
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        if (filePath.StartsWith("~/", StringComparison.Ordinal))
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), filePath[2..]);
        }

        return filePath;
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static string FormatLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "none" : value;
    }

    private sealed record SshLaunch(
        string SshPath,
        string Host,
        string? Username,
        int Port,
        string? PrivateKeyPath,
        string? ProxyJump,
        string AuthType,
        string? AskPassSecret);

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
            builder.Append("[Native SSH output truncated]");
            truncated = true;
        }

        public override string ToString()
        {
            return builder.ToString();
        }
    }
}

internal sealed record SshCommandResult(
    int ExitCode,
    string Stdout,
    string Stderr,
    bool TimedOut,
    long TotalMs,
    long SpawnMs);

internal sealed record SshFileStreamResult(
    int ExitCode,
    string Stderr,
    bool TimedOut,
    long TotalMs,
    long SpawnMs,
    long Bytes);
