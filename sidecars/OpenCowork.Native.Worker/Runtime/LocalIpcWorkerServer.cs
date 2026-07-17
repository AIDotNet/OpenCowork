using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text.Json;

internal sealed class LocalIpcWorkerServer
{
    // The Electron supervisor never reconnects to an existing worker: every
    // (re)start spawns a fresh process with a fresh endpoint. Exiting once the
    // sole client disconnects (or never shows up) keeps a crashed or SIGKILLed
    // parent from leaking an orphaned worker that idles forever with no owner.
    private static readonly TimeSpan FirstClientAcceptTimeout = TimeSpan.FromMinutes(2);
    private static readonly int MaxConcurrentRequests = ReadLimit(
        "OPEN_COWORK_NATIVE_MAX_CONCURRENT_REQUESTS",
        defaultValue: Math.Clamp(Environment.ProcessorCount, 4, 12),
        minimum: 1,
        maximum: 64);
    private static readonly int MaxOutstandingRequests = ReadLimit(
        "OPEN_COWORK_NATIVE_MAX_OUTSTANDING_REQUESTS",
        defaultValue: 128,
        minimum: MaxConcurrentRequests,
        maximum: 4096);

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

        while (true)
        {
            await using var pipe = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            using var acceptCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            acceptCts.CancelAfter(FirstClientAcceptTimeout);
            try
            {
                await pipe.WaitForConnectionAsync(acceptCts.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                WorkerLog.Warn("no client connected before the accept deadline; exiting");
                return;
            }

            WorkerLog.Debug("client connected transport=named-pipe");
            var sawTraffic = await HandleClientAsync(pipe, cancellationToken);
            if (sawTraffic)
            {
                WorkerLog.Info("client disconnected transport=named-pipe; exiting so the supervisor owns respawn");
                return;
            }

            // The supervisor's connect-retry can abandon an OS-established
            // connection before sending anything; only a client that spoke is
            // treated as the sole owner whose disconnect ends this process.
            WorkerLog.Debug("client disconnected before any frame transport=named-pipe; awaiting replacement");
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
            while (true)
            {
                using var acceptCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                acceptCts.CancelAfter(FirstClientAcceptTimeout);
                Socket client;
                try
                {
                    client = await listener.AcceptAsync(acceptCts.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    WorkerLog.Warn("no client connected before the accept deadline; exiting");
                    return;
                }

                WorkerLog.Debug("client connected transport=unix-domain-socket");
                bool sawTraffic;
                using (client)
                {
                    await using var stream = new NetworkStream(client, ownsSocket: true);
                    sawTraffic = await HandleClientAsync(stream, cancellationToken);
                }

                if (sawTraffic)
                {
                    WorkerLog.Info("client disconnected transport=unix-domain-socket; exiting so the supervisor owns respawn");
                    return;
                }

                // The supervisor's connect-retry can abandon an OS-established
                // connection before sending anything; only a client that spoke is
                // treated as the sole owner whose disconnect ends this process.
                WorkerLog.Debug("client disconnected before any frame transport=unix-domain-socket; awaiting replacement");
            }
        }
        finally
        {
            TryDeleteSocketFile(endpoint.Address);
        }
    }

    private async Task<bool> HandleClientAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var clientCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var writeLock = new SemaphoreSlim(1, 1);
        using var dispatchSlots = new SemaphoreSlim(MaxConcurrentRequests, MaxConcurrentRequests);
        var activeRequests = new ConcurrentDictionary<string, CancellationTokenSource>(StringComparer.Ordinal);
        var dispatchTasks = new ConcurrentDictionary<Task, byte>();
        var sawTraffic = false;
        var outstandingRequests = 0;

        try
        {
            while (!clientCts.IsCancellationRequested)
            {
                var frame = await MessagePackFrameProtocol.ReadFrameAsync(stream, clientCts.Token);
                if (frame is null)
                {
                    break;
                }

                sawTraffic = true;
                ParsedWorkerRequest request;
                try
                {
                    request = ParsedWorkerRequest.Parse(frame);
                }
                catch (Exception ex)
                {
                    var invalidResponse = MessagePackFrameProtocol.EncodeResponse(
                        WorkerResponse.Error($"Invalid native worker request: {ex.Message}"),
                        id: null);
                    await WritePayloadAsync(stream, writeLock, invalidResponse, clientCts.Token);
                    continue;
                }

                if (string.Equals(request.Method, "worker/cancel", StringComparison.Ordinal))
                {
                    CancelRequest(request.Parameters, activeRequests);
                    request.Dispose();
                    continue;
                }

                if (Interlocked.Increment(ref outstandingRequests) > MaxOutstandingRequests)
                {
                    Interlocked.Decrement(ref outstandingRequests);
                    var busyResponse = MessagePackFrameProtocol.EncodeResponse(
                        WorkerResponse.Error(
                            $"Native worker request quota exceeded ({MaxOutstandingRequests} outstanding requests)."),
                        request.Id);
                    request.Dispose();
                    await WritePayloadAsync(stream, writeLock, busyResponse, clientCts.Token);
                    continue;
                }

                var requestCts = CancellationTokenSource.CreateLinkedTokenSource(clientCts.Token);
                var requestKey = FormatRequestKey(request.Id);
                if (requestKey is not null && !activeRequests.TryAdd(requestKey, requestCts))
                {
                    Interlocked.Decrement(ref outstandingRequests);
                    requestCts.Dispose();
                    var duplicateResponse = MessagePackFrameProtocol.EncodeResponse(
                        WorkerResponse.Error("Duplicate native worker request id."),
                        request.Id);
                    request.Dispose();
                    await WritePayloadAsync(stream, writeLock, duplicateResponse, clientCts.Token);
                    continue;
                }

                var task = Task.Run(
                    async () =>
                    {
                        var slotAcquired = false;
                        try
                        {
                            await dispatchSlots.WaitAsync(requestCts.Token);
                            slotAcquired = true;
                            await HandleRequestAsync(
                                stream,
                                writeLock,
                                request,
                                requestCts.Token,
                                clientCts.Token);
                        }
                        catch (Exception ex)
                        {
                            WorkerLog.Warn(
                                $"request task stopped method={request.Method} " +
                                $"error={ex.GetType().Name}: {ex.Message}");
                        }
                        finally
                        {
                            if (slotAcquired)
                            {
                                dispatchSlots.Release();
                            }
                            if (requestKey is not null)
                            {
                                activeRequests.TryRemove(
                                    new KeyValuePair<string, CancellationTokenSource>(requestKey, requestCts));
                            }
                            requestCts.Dispose();
                            request.Dispose();
                            Interlocked.Decrement(ref outstandingRequests);
                        }
                    },
                    CancellationToken.None);
                dispatchTasks.TryAdd(task, 0);
                _ = task.ContinueWith(
                    completed => dispatchTasks.TryRemove(completed, out _),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
        finally
        {
            await clientCts.CancelAsync();
            foreach (var activeRequest in activeRequests.Values)
            {
                activeRequest.Cancel();
            }
            try
            {
                await Task.WhenAll(dispatchTasks.Keys);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"request task stopped after client disconnect error={ex.GetType().Name}: {ex.Message}");
            }
        }

        return sawTraffic;
    }

    private async Task HandleRequestAsync(
        Stream stream,
        SemaphoreSlim writeLock,
        ParsedWorkerRequest request,
        CancellationToken requestCancellationToken,
        CancellationToken connectionCancellationToken)
    {
        using var operation = WorkerMemory.TrackOperation("ipc-frame");
        var response = await DispatchRequestAsync(
            request,
            (eventName, writeParameters, eventCancellationToken) =>
                WriteEventFrameAsync(stream, writeLock, eventName, writeParameters, eventCancellationToken),
            (messagePackEvent, eventCancellationToken) =>
                WriteMessagePackEventFrameAsync(stream, writeLock, messagePackEvent, eventCancellationToken),
            requestCancellationToken,
            connectionCancellationToken);
        await WritePayloadAsync(stream, writeLock, response, connectionCancellationToken);
        WorkerMemory.ReportCompletedWork("ipc-frame", request.FrameLength + response.Length);
    }

    private async Task<byte[]> DispatchRequestAsync(
        ParsedWorkerRequest request,
        Func<string, Action<Utf8JsonWriter>, CancellationToken, ValueTask> emitEventAsync,
        Func<WorkerMessagePackEvent, CancellationToken, ValueTask> emitMessagePackEventAsync,
        CancellationToken requestCancellationToken,
        CancellationToken connectionCancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var id = request.Id;
        var method = request.Method;

        try
        {
            var context = new WorkerRequestContext(
                emitEventAsync,
                emitMessagePackEventAsync,
                requestCancellationToken,
                connectionCancellationToken);
            var response = await dispatcher.DispatchAsync(method, request.Parameters, context);
            var encoded = MessagePackFrameProtocol.EncodeResponse(response, id);
            WorkerLog.RequestCompleted(
                method,
                FormatRequestId(id),
                GetElapsedMilliseconds(startedAt),
                request.FrameLength,
                encoded.Length,
                error: null);
            return encoded;
        }
        catch (Exception ex)
        {
            var errorMessage = ex is OperationCanceledException
                ? $"Native worker request cancelled: {method}"
                : ex.Message;
            var encoded = MessagePackFrameProtocol.EncodeResponse(WorkerResponse.Error(errorMessage), id);
            WorkerLog.RequestCompleted(
                method,
                FormatRequestId(id),
                GetElapsedMilliseconds(startedAt),
                request.FrameLength,
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

    private static string? FormatRequestKey(JsonElement? id)
    {
        if (!id.HasValue || id.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        return $"{id.Value.ValueKind}:{id.Value.GetRawText()}";
    }

    private static void CancelRequest(
        JsonElement parameters,
        ConcurrentDictionary<string, CancellationTokenSource> activeRequests)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("requestId", out var requestId))
        {
            return;
        }

        var key = FormatRequestKey(requestId);
        if (key is not null && activeRequests.TryGetValue(key, out var requestCts))
        {
            requestCts.Cancel();
        }
    }

    private static int ReadLimit(string variableName, int defaultValue, int minimum, int maximum)
    {
        var raw = Environment.GetEnvironmentVariable(variableName);
        return int.TryParse(raw, out var value)
            ? Math.Clamp(value, minimum, maximum)
            : Math.Clamp(defaultValue, minimum, maximum);
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

    private sealed class ParsedWorkerRequest : IDisposable
    {
        private readonly JsonDocument document;

        private ParsedWorkerRequest(
            JsonDocument document,
            JsonElement? id,
            string method,
            JsonElement parameters,
            int frameLength)
        {
            this.document = document;
            Id = id;
            Method = method;
            Parameters = parameters;
            FrameLength = frameLength;
        }

        public JsonElement? Id { get; }

        public string Method { get; }

        public JsonElement Parameters { get; }

        public int FrameLength { get; }

        public static ParsedWorkerRequest Parse(ReadOnlyMemory<byte> frame)
        {
            var document = MessagePackFrameProtocol.ConvertRequestToJsonDocument(frame);
            try
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidDataException("Request root must be an object.");
                }

                JsonElement? id = root.TryGetProperty("id", out var idElement)
                    ? idElement.Clone()
                    : null;
                var method = JsonHelpers.GetString(root, "method") ??
                    throw new InvalidOperationException("Missing method");
                var parameters = root.TryGetProperty("params", out var paramsElement)
                    ? paramsElement
                    : default;
                return new ParsedWorkerRequest(document, id, method, parameters, frame.Length);
            }
            catch
            {
                document.Dispose();
                throw;
            }
        }

        public void Dispose()
        {
            document.Dispose();
        }
    }
}
