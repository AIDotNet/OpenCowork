using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text.Json;

internal sealed class LocalIpcWorkerServer
{
    private readonly WorkerDispatcher dispatcher;
    private readonly WorkerEndpoint endpoint;

    public LocalIpcWorkerServer(WorkerDispatcher dispatcher, WorkerEndpoint endpoint)
    {
        this.dispatcher = dispatcher;
        this.endpoint = endpoint;
    }

    public Task RunAsync(CancellationToken cancellationToken = default)
    {
        return OperatingSystem.IsWindows()
            ? RunNamedPipeAsync(cancellationToken)
            : RunUnixSocketAsync(cancellationToken);
    }

    private async Task RunNamedPipeAsync(CancellationToken cancellationToken)
    {
        var pipeName = endpoint.Address.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase)
            ? endpoint.Address[@"\\.\pipe\".Length..]
            : endpoint.Address;

        WorkerLog.Info(
            $"server listening transport=named-pipe debug={WorkerLog.DebugEnabled} " +
            $"slowRequestMs={WorkerLog.SlowRequestMs}");

        while (!cancellationToken.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            await pipe.WaitForConnectionAsync(cancellationToken);
            WorkerLog.Debug("client connected transport=named-pipe");
            await HandleClientAsync(pipe, cancellationToken);
            WorkerLog.Debug("client disconnected transport=named-pipe");
        }
    }

    private async Task RunUnixSocketAsync(CancellationToken cancellationToken)
    {
        TryDeleteSocketFile(endpoint.Address);

        using var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(endpoint.Address));
        listener.Listen(backlog: 1);
        WorkerLog.Info(
            $"server listening transport=unix-domain-socket debug={WorkerLog.DebugEnabled} " +
            $"slowRequestMs={WorkerLog.SlowRequestMs}");

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                using var client = await listener.AcceptAsync(cancellationToken);
                WorkerLog.Debug("client connected transport=unix-domain-socket");
                await using var stream = new NetworkStream(client, ownsSocket: true);
                await HandleClientAsync(stream, cancellationToken);
                WorkerLog.Debug("client disconnected transport=unix-domain-socket");
            }
        }
        finally
        {
            TryDeleteSocketFile(endpoint.Address);
        }
    }

    private async Task HandleClientAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var clientCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var writeLock = new SemaphoreSlim(1, 1);
        var dispatchTasks = new List<Task>();

        try
        {
            while (!clientCts.IsCancellationRequested)
            {
                var frame = await MessagePackFrameProtocol.ReadFrameAsync(stream, clientCts.Token);
                if (frame is null)
                {
                    break;
                }

                var task = HandleFrameAsync(stream, writeLock, frame, clientCts.Token);
                dispatchTasks.Add(task);
                dispatchTasks.RemoveAll(static item => item.IsCompleted);
            }
        }
        finally
        {
            await clientCts.CancelAsync();
            try
            {
                await Task.WhenAll(dispatchTasks);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"request task stopped after client disconnect error={ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    private async Task HandleFrameAsync(
        Stream stream,
        SemaphoreSlim writeLock,
        ReadOnlyMemory<byte> frame,
        CancellationToken cancellationToken)
    {
        using var operation = WorkerMemory.TrackOperation("ipc-frame");
        var response = await DispatchFrameAsync(
            frame,
            (eventName, writeParameters, eventCancellationToken) =>
                WriteEventFrameAsync(stream, writeLock, eventName, writeParameters, eventCancellationToken),
            (messagePackEvent, eventCancellationToken) =>
                WriteMessagePackEventFrameAsync(stream, writeLock, messagePackEvent, eventCancellationToken),
            cancellationToken);
        await WritePayloadAsync(stream, writeLock, response, cancellationToken);
        WorkerMemory.ReportCompletedWork("ipc-frame", frame.Length + response.Length);
    }

    private async Task<byte[]> DispatchFrameAsync(
        ReadOnlyMemory<byte> frame,
        Func<string, Action<Utf8JsonWriter>, CancellationToken, ValueTask> emitEventAsync,
        Func<WorkerMessagePackEvent, CancellationToken, ValueTask> emitMessagePackEventAsync,
        CancellationToken cancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        JsonElement? id = null;
        var method = "<unknown>";

        try
        {
            var requestJson = MessagePackFrameProtocol.ConvertRequestToJson(frame);
            using var document = JsonDocument.Parse(requestJson);
            var root = document.RootElement;

            if (root.TryGetProperty("id", out var idElement))
            {
                id = idElement.Clone();
            }

            method = JsonHelpers.GetString(root, "method") ??
                throw new InvalidOperationException("Missing method");
            var parameters = root.TryGetProperty("params", out var paramsElement)
                ? paramsElement
                : default;

            var context = new WorkerRequestContext(
                emitEventAsync,
                emitMessagePackEventAsync,
                cancellationToken);
            var response = await dispatcher.DispatchAsync(method, parameters, context);
            var encoded = MessagePackFrameProtocol.EncodeResponse(response, id);
            WorkerLog.RequestCompleted(
                method,
                FormatRequestId(id),
                GetElapsedMilliseconds(startedAt),
                frame.Length,
                encoded.Length,
                error: null);
            return encoded;
        }
        catch (Exception ex)
        {
            var encoded = MessagePackFrameProtocol.EncodeResponse(WorkerResponse.Error(ex.Message), id);
            WorkerLog.RequestCompleted(
                method,
                FormatRequestId(id),
                GetElapsedMilliseconds(startedAt),
                frame.Length,
                encoded.Length,
                ex);
            return encoded;
        }
    }

    private static async ValueTask WriteEventFrameAsync(
        Stream stream,
        SemaphoreSlim writeLock,
        string eventName,
        Action<Utf8JsonWriter> writeParameters,
        CancellationToken cancellationToken)
    {
        var encoded = MessagePackFrameProtocol.EncodeEvent(eventName, writeParameters);
        await WritePayloadAsync(stream, writeLock, encoded, cancellationToken);
    }

    private static async ValueTask WriteMessagePackEventFrameAsync(
        Stream stream,
        SemaphoreSlim writeLock,
        WorkerMessagePackEvent messagePackEvent,
        CancellationToken cancellationToken)
    {
        if (messagePackEvent.Payload.IsEmpty)
        {
            return;
        }

        if (IsMessagePackTraceEnabled())
        {
            WorkerLog.Debug(
                $"event msgpack event={messagePackEvent.EventName} bytes={messagePackEvent.Payload.Length}");
        }
        await WritePayloadAsync(stream, writeLock, messagePackEvent.Payload, cancellationToken);
    }

    private static async ValueTask WritePayloadAsync(
        Stream stream,
        SemaphoreSlim writeLock,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        await writeLock.WaitAsync(cancellationToken);
        try
        {
            await MessagePackFrameProtocol.WriteFrameAsync(stream, payload, cancellationToken);
        }
        finally
        {
            writeLock.Release();
        }
    }

    private static long GetElapsedMilliseconds(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static string FormatRequestId(JsonElement? id)
    {
        if (!id.HasValue)
        {
            return "null";
        }

        var value = id.Value;
        return value.ValueKind switch
        {
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Null => "null",
            JsonValueKind.Undefined => "undefined",
            _ => value.GetRawText()
        };
    }

    private static void TryDeleteSocketFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Best effort cleanup; bind will surface any real failure.
        }
    }

    private static bool IsMessagePackTraceEnabled()
    {
        var raw = Environment.GetEnvironmentVariable("OPEN_COWORK_MSGPACK_TRACE");
        return raw?.Trim().ToLowerInvariant() is "1" or "true" or "yes" or "on";
    }
}
