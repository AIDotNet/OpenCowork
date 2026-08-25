using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

/// <summary>
/// HTTP transport for the worker, on Kestrel + Minimal APIs. Replaces the
/// length-prefixed MessagePack dual-socket protocol with four loopback endpoints:
///
///   POST /rpc     {"id":..,"method":..,"params":..} -> {"id":..,"result":..}
///   POST /cancel  {"requestId":..}                 -> {"ok":true,"cancelled":bool}
///   GET  /events  text/event-stream of {"event":..,"params":..}
///   GET  /health  {"ok":true,...}
///
/// Handler errors stay inside <c>result</c> as <c>{"error":"..."}</c>, exactly as the
/// frame protocol delivered them, so consumers keep one error shape. HTTP status codes
/// are reserved for transport faults: a bad token, malformed JSON, an unknown route.
///
/// Every endpoint is an <see cref="HttpContext"/>-only delegate that serializes with
/// <c>Utf8JsonWriter</c> and writes bytes itself. There is no parameter binding and no
/// reflective JSON, which is what makes this safe under Native AOT with
/// <c>JsonSerializerIsReflectionEnabledByDefault=false</c>.
///
/// The dispatcher, modules and <see cref="WorkerTransportHub"/> are untouched — only
/// the bytes on the wire change.
/// </summary>
internal sealed class HttpWorkerServer
{
    /// <summary>Marks the stdout line carrying the chosen port. Logs go to stderr.</summary>
    public const string ReadyLinePrefix = "__OPEN_COWORK_WORKER_HTTP__";

    // The supervisor never adopts a running worker: each start spawns a fresh process.
    // If nobody ever opens the event stream, or it stays gone after the host died, the
    // worker exits rather than idling forever with no owner.
    private static readonly TimeSpan FirstClientTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan OwnerlessGracePeriod = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan EventStreamKeepAliveInterval = TimeSpan.FromSeconds(15);

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

    /// <summary>
    /// Matches the frame protocol's writer so a payload that round-tripped through
    /// MessagePack is escaped identically on both transports.
    /// </summary>
    private static readonly JsonWriterOptions ResponseWriterOptions = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private const int EventQueueCapacity = 1024;
    private const long MaxBufferedEventBytes = 16L * 1024 * 1024;
    private const long MaxRequestBodyBytes = 256L * 1024 * 1024;

    private readonly WorkerDispatcher dispatcher;
    private readonly HttpWorkerEndpoint endpoint;
    private readonly byte[] expectedAuthorization;

    private readonly SemaphoreSlim dispatchSlots = new(MaxConcurrentRequests, MaxConcurrentRequests);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> activeRequests =
        new(StringComparer.Ordinal);
    private int outstandingRequests;

    /// <summary>
    /// Droppable lanes, one per durable consumer, each drained by its own
    /// <c>GET /events?consumerId=…</c> connection. These carry one-way progress and
    /// streamed output whose durable outbox is authoritative, so a dropped frame
    /// costs replay rather than correctness.
    ///
    /// It is a map rather than a single lane because the renderer and the host are
    /// independent consumers with independent cursors: the renderer talks to the
    /// worker directly and acknowledges what it has rendered, while the host keeps
    /// its own subscription for background and scheduled runs. One shared lane would
    /// force them onto one cursor, so whichever attached second would see nothing.
    /// </summary>
    private readonly ConcurrentDictionary<string, StreamLane> consumerLanes =
        new(StringComparer.Ordinal);

    /// <summary>
    /// Never-drop lane, drained by <c>GET /reverse</c>: reverse RPC the host must
    /// answer. It gets its own connection because a host that stops draining streamed
    /// output must still be able to answer an approval or a hook — the dual-socket
    /// protocol this replaced guaranteed exactly that by putting reverse RPC on the
    /// control socket, and sharing one stream would silently lose the property.
    /// </summary>
    private readonly StreamLane reverseLane = new(
        Channel.CreateUnbounded<QueuedEvent>(
            new UnboundedChannelOptions { SingleReader = true, SingleWriter = false }),
        metered: false);

    private long eventSequence;
    private long lastOwnerActivityAt = Stopwatch.GetTimestamp();
    private volatile bool sawAnyClient;

    public HttpWorkerServer(WorkerDispatcher dispatcher, HttpWorkerEndpoint endpoint)
    {
        this.dispatcher = dispatcher;
        this.endpoint = endpoint;
        expectedAuthorization = Encoding.UTF8.GetBytes($"Bearer {endpoint.Token}");
    }

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        WorkerTransportHub.ConfigureWorkerCancellation(lifetime.Token);
        WorkerTransportHub.SetEventPublisher(PublishStreamEventAsync, TryPublishStreamEvent);
        WorkerTransportHub.SetControlPublisher(PublishControlEventAsync);
        // The durable pump addresses a single consumer's lane, which the shared hub
        // has no concept of, so that path is routed locally instead.
        WorkerEventRouter.SetConsumerPublisher(TryPublishToConsumer);

        // Slim builder: no MVC, no Razor, no reflective config binding. Args are
        // deliberately not forwarded — the worker's own flags are not configuration.
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions());

        // stdout carries exactly one machine-readable line (the ready line), so no
        // logging provider may write there. Diagnostics go through WorkerLog (stderr).
        builder.Logging.ClearProviders();

        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Limits.MaxRequestBodySize = MaxRequestBodyBytes;
            // Port 0: the worker picks the port and publishes it, so a lingering
            // previous process can never make a fresh one fail to bind.
            options.Listen(IPAddress.Loopback, endpoint.RequestedPort);
            options.AddServerHeader = false;
        });

        await using var app = builder.Build();

        // CORS runs before auth on purpose: a browser preflight never carries the
        // Authorization header, so authenticating it would reject every cross-origin
        // request before the real one is ever sent. The renderer is a separate origin
        // from this server (a dev server on localhost, or file:// when packaged), so
        // its calls are cross-origin even though both ends are the same application.
        app.Use(async (context, next) =>
        {
            var origin = context.Request.Headers.Origin.ToString();
            var originAllowed = IsAllowedOrigin(origin);
            if (originAllowed)
            {
                context.Response.Headers["Access-Control-Allow-Origin"] = origin;
                // Responses differ by origin, so anything caching them must key on it.
                context.Response.Headers["Vary"] = "Origin";
            }

            if (HttpMethods.IsOptions(context.Request.Method))
            {
                if (!originAllowed)
                {
                    await WriteErrorAsync(
                        context,
                        StatusCodes.Status403Forbidden,
                        "Origin is not permitted to call the worker.");
                    return;
                }
                context.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                context.Response.Headers["Access-Control-Allow-Headers"] =
                    "Authorization, Content-Type, Accept";
                context.Response.Headers["Access-Control-Max-Age"] = "600";
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }

            await next();
        });

        app.Use(async (context, next) =>
        {
            if (!IsAuthorized(context.Request.Headers.Authorization))
            {
                await WriteErrorAsync(context, StatusCodes.Status401Unauthorized, "Invalid worker token.");
                return;
            }

            sawAnyClient = true;
            TouchOwnerActivity();
            await next();
        });

        app.MapPost("/rpc", ServeRpcAsync);
        app.MapPost("/cancel", ServeCancelAsync);
        app.MapGet("/events", ServeConsumerStreamAsync);
        app.MapGet(
            "/reverse",
            (HttpContext context) => ServeStreamAsync(context, reverseLane, "reverse"));
        app.MapGet("/health", ServeHealthAsync);

        await app.StartAsync(lifetime.Token);

        var watchdog = RunOwnerWatchdogAsync(
            app.Services.GetRequiredService<IHostApplicationLifetime>(),
            lifetime.Token);
        try
        {
            PublishReadyLine(ResolveBoundPort(app));
            WorkerLog.Info(
                $"server listening transport=http debug={WorkerLog.DebugEnabled} " +
                $"slowRequestMs={WorkerLog.SlowRequestMs}");
            await app.WaitForShutdownAsync(lifetime.Token);
        }
        finally
        {
            await lifetime.CancelAsync();
            WorkerTransportHub.ClearControlPublisher();
            WorkerTransportHub.ClearEventPublisher();
            WorkerEventRouter.ClearConsumerPublisher();
            CancelAllRequests();
            try
            {
                await watchdog;
            }
            catch (OperationCanceledException)
            {
                // Expected during shutdown.
            }
        }
    }

    private static int ResolveBoundPort(WebApplication app)
    {
        foreach (var url in app.Urls)
        {
            if (Uri.TryCreate(url, UriKind.Absolute, out var parsed) && parsed.Port > 0)
            {
                return parsed.Port;
            }
        }

        throw new InvalidOperationException("Kestrel did not report a bound HTTP port.");
    }

    /// <summary>
    /// stdout carries exactly one machine-readable line so the supervisor can learn the
    /// ephemeral port. Only the worker knows it, because Kestrel chose it.
    /// </summary>
    private void PublishReadyLine(int port)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("ready", true);
            writer.WriteString("transport", "http");
            writer.WriteString("address", "127.0.0.1");
            writer.WriteNumber("port", port);
            writer.WriteNumber("pid", Environment.ProcessId);
            writer.WriteNumber("protocolVersion", WorkerProtocol.Version);
            writer.WriteString("hostId", endpoint.HostId);
            writer.WriteEndObject();
        }

        Console.Out.WriteLine($"{ReadyLinePrefix} {Encoding.UTF8.GetString(buffer.WrittenSpan)}");
        Console.Out.Flush();
    }

    private async Task RunOwnerWatchdogAsync(
        IHostApplicationLifetime hostLifetime,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);

            // Any attached stream proves an owner is still there.
            if (reverseLane.IsAttached || HasAttachedConsumer())
            {
                TouchOwnerActivity();
                continue;
            }

            var idle = Stopwatch.GetElapsedTime(Volatile.Read(ref lastOwnerActivityAt));
            var deadline = sawAnyClient ? OwnerlessGracePeriod : FirstClientTimeout;
            if (idle <= deadline)
            {
                continue;
            }

            WorkerLog.Warn(
                sawAnyClient
                    ? $"event stream absent for {idle.TotalSeconds:0}s; exiting so the supervisor owns respawn"
                    : "no client connected before the accept deadline; exiting");
            hostLifetime.StopApplication();
            return;
        }
    }

    private void TouchOwnerActivity()
    {
        Volatile.Write(ref lastOwnerActivityAt, Stopwatch.GetTimestamp());
    }

    private bool HasAttachedConsumer()
    {
        foreach (var entry in consumerLanes)
        {
            if (entry.Value.IsAttached)
            {
                return true;
            }
        }
        return false;
    }

    private async Task ServeHealthAsync(HttpContext context)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("ok", true);
            writer.WriteNumber("pid", Environment.ProcessId);
            writer.WriteNumber("protocolVersion", WorkerProtocol.Version);
            writer.WriteString(
                "appVersion",
                Environment.GetEnvironmentVariable("OPEN_COWORK_APP_VERSION"));
            writer.WriteBoolean("eventStreamAttached", HasAttachedConsumer());
            writer.WriteBoolean("reverseStreamAttached", reverseLane.IsAttached);
            var dropped = 0L;
            writer.WritePropertyName("consumers");
            writer.WriteStartArray();
            foreach (var entry in consumerLanes)
            {
                dropped += entry.Value.Dropped;
                writer.WriteStartObject();
                writer.WriteString("consumerId", entry.Key);
                writer.WriteBoolean("attached", entry.Value.IsAttached);
                writer.WriteNumber("bufferedBytes", entry.Value.BufferedBytes);
                writer.WriteNumber("droppedEvents", entry.Value.Dropped);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteNumber("droppedEvents", dropped);
            writer.WriteEndObject();
        }

        await WriteJsonAsync(context, StatusCodes.Status200OK, buffer.WrittenMemory);
    }

    private async Task ServeRpcAsync(HttpContext context)
    {
        JsonDocument document;
        try
        {
            document = await JsonDocument.ParseAsync(
                context.Request.Body,
                default,
                context.RequestAborted);
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            await WriteErrorAsync(
                context,
                StatusCodes.Status400BadRequest,
                $"Invalid request JSON: {ex.Message}");
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                await WriteErrorAsync(
                    context,
                    StatusCodes.Status400BadRequest,
                    "Request root must be an object.");
                return;
            }

            JsonElement? id = root.TryGetProperty("id", out var idElement) ? idElement : null;
            var method = JsonHelpers.GetString(root, "method");
            if (string.IsNullOrEmpty(method))
            {
                await WriteErrorAsync(
                    context,
                    StatusCodes.Status400BadRequest,
                    "Request is missing method.");
                return;
            }

            var parameters = root.TryGetProperty("params", out var paramsElement)
                ? paramsElement
                : default;

            // Liveness and handshake answer without taking a dispatch slot: a worker
            // saturated by long requests must still prove it is alive, or the
            // supervisor's heartbeat misreads load as death.
            if (method is "worker/ping")
            {
                await WriteResponseAsync(
                    context,
                    WorkerResponse.Json(
                        new StatusResult(true, Environment.ProcessId),
                        WorkerJsonContext.Default.StatusResult),
                    id);
                return;
            }

            if (method is "worker/hello")
            {
                await WriteResponseAsync(
                    context,
                    WorkerResponse.Json(
                        new WorkerHelloResult(
                            true,
                            Environment.ProcessId,
                            WorkerProtocol.Version,
                            Environment.GetEnvironmentVariable("OPEN_COWORK_APP_VERSION")),
                        WorkerJsonContext.Default.WorkerHelloResult),
                    id);
                return;
            }

            if (Interlocked.Increment(ref outstandingRequests) > MaxOutstandingRequests)
            {
                Interlocked.Decrement(ref outstandingRequests);
                await WriteResponseAsync(
                    context,
                    WorkerResponse.Error(
                        $"Native worker request quota exceeded ({MaxOutstandingRequests} outstanding requests)."),
                    id);
                return;
            }

            var requestKey = FormatRequestKey(id);
            using var requestCts = CancellationTokenSource.CreateLinkedTokenSource(
                context.RequestAborted);
            if (requestKey is not null && !activeRequests.TryAdd(requestKey, requestCts))
            {
                Interlocked.Decrement(ref outstandingRequests);
                await WriteResponseAsync(
                    context,
                    WorkerResponse.Error("Duplicate native worker request id."),
                    id);
                return;
            }

            try
            {
                await dispatchSlots.WaitAsync(requestCts.Token);
                try
                {
                    var response = await DispatchAsync(
                        method,
                        parameters,
                        id,
                        requestCts.Token,
                        context.RequestAborted);
                    await WriteResponseAsync(context, response, id);
                }
                finally
                {
                    dispatchSlots.Release();
                }
            }
            catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
            {
                await WriteResponseAsync(
                    context,
                    WorkerResponse.Error($"Native worker request cancelled: {method}"),
                    id);
            }
            catch (OperationCanceledException)
            {
                // The client hung up; nothing to write.
            }
            finally
            {
                if (requestKey is not null)
                {
                    activeRequests.TryRemove(
                        new KeyValuePair<string, CancellationTokenSource>(requestKey, requestCts));
                }
                Interlocked.Decrement(ref outstandingRequests);
            }
        }
    }

    private async ValueTask<WorkerResponse> DispatchAsync(
        string method,
        JsonElement parameters,
        JsonElement? id,
        CancellationToken requestCancellationToken,
        CancellationToken connectionCancellationToken)
    {
        using var operation = WorkerMemory.TrackOperation("http-request");
        var startedAt = Stopwatch.GetTimestamp();
        try
        {
            var context = new WorkerRequestContext(
                PublishControlEventAsync,
                PublishStreamEventAsync,
                requestCancellationToken,
                connectionCancellationToken);
            var response = await dispatcher.DispatchAsync(method, parameters, context);
            WorkerLog.RequestCompleted(
                method,
                FormatRequestId(id),
                GetElapsedMilliseconds(startedAt),
                requestBytes: 0,
                responseBytes: 0,
                error: null);
            return response;
        }
        catch (Exception ex)
        {
            var message = ex is OperationCanceledException
                ? $"Native worker request cancelled: {method}"
                : ex.Message;
            WorkerLog.RequestCompleted(
                method,
                FormatRequestId(id),
                GetElapsedMilliseconds(startedAt),
                requestBytes: 0,
                responseBytes: 0,
                ex);
            return WorkerResponse.Error(message);
        }
    }

    private async Task ServeCancelAsync(HttpContext context)
    {
        var cancelled = false;
        try
        {
            using var document = await JsonDocument.ParseAsync(
                context.Request.Body,
                default,
                context.RequestAborted);
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("requestId", out var requestId) &&
                FormatRequestKey(requestId) is { } key &&
                activeRequests.TryGetValue(key, out var requestCts))
            {
                await requestCts.CancelAsync();
                cancelled = true;
            }
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            await WriteErrorAsync(
                context,
                StatusCodes.Status400BadRequest,
                $"Invalid cancel JSON: {ex.Message}");
            return;
        }
        catch (ObjectDisposedException)
        {
            // The request completed between lookup and cancel; treat as not cancelled.
        }

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("ok", true);
            writer.WriteBoolean("cancelled", cancelled);
            writer.WriteEndObject();
        }

        await WriteJsonAsync(context, StatusCodes.Status200OK, buffer.WrittenMemory);
    }

    /// <summary>
    /// Serves one SSE lane. `/events` and `/reverse` are separate connections so a
    /// consumer that stops draining streamed output cannot also stall the reverse RPC
    /// a run is blocked on.
    /// </summary>
    /// <summary>
    /// Resolves the caller's durable consumer and serves that consumer's lane.
    /// </summary>
    /// <remarks>
    /// The id is required rather than defaulted: two consumers that both omitted it
    /// would silently collide on one lane and one of them would stall, which is the
    /// exact failure this split exists to prevent.
    /// </remarks>
    private Task ServeConsumerStreamAsync(HttpContext context)
    {
        var consumerId = context.Request.Query["consumerId"].ToString();
        if (string.IsNullOrWhiteSpace(consumerId))
        {
            return WriteErrorAsync(
                context,
                StatusCodes.Status400BadRequest,
                "GET /events requires a consumerId query parameter.").AsTask();
        }

        var lane = consumerLanes.GetOrAdd(consumerId, static _ => new StreamLane(
            Channel.CreateBounded<QueuedEvent>(
                new BoundedChannelOptions(EventQueueCapacity)
                {
                    SingleReader = true,
                    SingleWriter = false,
                    FullMode = BoundedChannelFullMode.Wait,
                    AllowSynchronousContinuations = false
                }),
            metered: true));

        return ServeStreamAsync(context, lane, $"events[{consumerId}]");
    }

    private async Task ServeStreamAsync(HttpContext context, StreamLane lane, string label)
    {
        if (!lane.TryAttach())
        {
            await WriteErrorAsync(
                context,
                StatusCodes.Status409Conflict,
                $"The worker {label} stream is already attached.");
            return;
        }

        var cancellationToken = context.RequestAborted;
        try
        {
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.Headers.ContentType = "text/event-stream; charset=utf-8";
            context.Response.Headers.CacheControl = "no-cache, no-transform";
            // Without this, small frames can sit in a buffer and stall streamed agent
            // output behind a partially filled write.
            context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            await context.Response.BodyWriter.FlushAsync(cancellationToken);
            WorkerLog.Debug($"{label} stream attached transport=http");

            while (!cancellationToken.IsCancellationRequested)
            {
                var wroteAny = false;
                while (lane.Queue.Reader.TryRead(out var queued))
                {
                    lane.Release(queued.Payload.Length);
                    await WriteEventAsync(context, queued, cancellationToken);
                    wroteAny = true;
                }

                if (wroteAny)
                {
                    continue;
                }

                using var idle = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                idle.CancelAfter(EventStreamKeepAliveInterval);
                try
                {
                    await lane.WaitForWakeAsync(idle.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // Comment frames keep intermediaries and the client's own read
                    // deadline from treating a quiet stream as a dead one.
                    await WriteRawAsync(context, ":keepalive\n\n", cancellationToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Client detached or worker shutting down.
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            WorkerLog.Debug($"{label} stream detached error={ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            lane.Detach();
            TouchOwnerActivity();
            WorkerLog.Debug($"{label} stream detached transport=http");
        }
    }

    /// <summary>
    /// Writes one SSE frame. The payload must be a single line, which
    /// <c>Utf8JsonWriter</c> guarantees for non-indented output: newlines inside strings
    /// are escaped and no whitespace is emitted between tokens.
    /// </summary>
    private async ValueTask WriteEventAsync(
        HttpContext context,
        QueuedEvent queued,
        CancellationToken cancellationToken)
    {
        var sequence = Interlocked.Increment(ref eventSequence);
        var writer = context.Response.BodyWriter;
        WriteAscii(writer, "id: ");
        WriteAscii(writer, sequence.ToString());
        WriteAscii(writer, "\ndata: ");
        writer.Write(queued.Payload.Span);
        WriteAscii(writer, "\n\n");
        await writer.FlushAsync(cancellationToken);
    }

    private static async ValueTask WriteRawAsync(
        HttpContext context,
        string ascii,
        CancellationToken cancellationToken)
    {
        WriteAscii(context.Response.BodyWriter, ascii);
        await context.Response.BodyWriter.FlushAsync(cancellationToken);
    }

    /// <summary>
    /// Event-lane publisher. Payloads arrive as encoded MessagePack envelopes; they are
    /// transcoded to the identical JSON envelope so the wire carries one representation.
    /// </summary>
    private ValueTask PublishStreamEventAsync(
        WorkerMessagePackEvent messagePackEvent,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        TryPublishStreamEvent(messagePackEvent);
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Broadcast publisher: live-only events that are not in the durable outbox, so
    /// every known consumer needs its own copy. Reports success when at least one
    /// lane accepted the frame.
    /// </summary>
    /// <remarks>
    /// Enqueues to known lanes whether or not they are currently attached. These
    /// events have no durable backing, so dropping them during a momentary detach
    /// would lose them outright; the bounded queue and per-lane byte budget are what
    /// keep a permanently absent consumer from growing without limit.
    /// </remarks>
    private bool TryPublishStreamEvent(WorkerMessagePackEvent messagePackEvent)
    {
        if (!TryTranscode(messagePackEvent, out var json))
        {
            return false;
        }

        var delivered = false;
        foreach (var entry in consumerLanes)
        {
            delivered |= TryEnqueue(entry.Value, messagePackEvent.EventName, json);
        }
        return delivered;
    }

    /// <summary>
    /// Targeted publisher for the durable event pump, which owns a per-consumer
    /// cursor and must deliver to exactly that consumer's lane.
    /// </summary>
    private bool TryPublishToConsumer(string consumerId, WorkerMessagePackEvent messagePackEvent)
    {
        if (!consumerLanes.TryGetValue(consumerId, out var lane) || !lane.IsAttached)
        {
            return false;
        }
        if (!TryTranscode(messagePackEvent, out var json))
        {
            return false;
        }
        return TryEnqueue(lane, messagePackEvent.EventName, json);
    }

    private static bool TryTranscode(WorkerMessagePackEvent messagePackEvent, out byte[] json)
    {
        if (messagePackEvent.Payload.IsEmpty)
        {
            json = [];
            return false;
        }

        try
        {
            json = MessagePackJsonTranscoder.ToJsonBytes(messagePackEvent.Payload.Span);
            return true;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"event transcode failed event={messagePackEvent.EventName} " +
                $"error={ex.GetType().Name}: {ex.Message}");
            json = [];
            return false;
        }
    }

    private static bool TryEnqueue(StreamLane lane, string eventName, byte[] json)
    {
        if (!lane.TryReserve(json.Length))
        {
            LogDropped(lane, eventName, json.Length);
            return false;
        }

        if (!lane.Queue.Writer.TryWrite(new QueuedEvent(eventName, json)))
        {
            lane.Release(json.Length);
            LogDropped(lane, eventName, json.Length);
            return false;
        }

        lane.Signal();
        return true;
    }

    /// <summary>
    /// Reverse-lane publisher: reverse RPC and anything else the host must answer.
    /// Fails loudly when nothing is attached, matching the previous transport — a
    /// silently dropped reverse request would hang the run waiting on it. It checks
    /// only the reverse stream, so a consumer that stops draining streamed output
    /// still receives approvals and hooks.
    /// </summary>
    private ValueTask PublishControlEventAsync(
        string eventName,
        Action<Utf8JsonWriter> writeParameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        if (!reverseLane.IsAttached)
        {
            throw new IOException(
                $"Worker reverse stream is unavailable while publishing '{eventName}'.");
        }

        var json = WorkerJson.WriteEvent(eventName, writeParameters);
        reverseLane.Queue.Writer.TryWrite(new QueuedEvent(eventName, json));
        reverseLane.Signal();
        return ValueTask.CompletedTask;
    }

    private static void LogDropped(StreamLane lane, string eventName, int length)
    {
        var dropped = lane.RecordDrop();
        WorkerLog.Warn(
            $"event stream queue full; durable replay required event={eventName} " +
            $"bytes={length} bufferedBytes={lane.BufferedBytes} dropped={dropped}");
    }

    private void CancelAllRequests()
    {
        foreach (var request in activeRequests.Values)
        {
            try
            {
                request.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The owning request already completed and disposed it.
            }
        }
    }

    /// <summary>
    /// Whether a browser origin may call this worker.
    /// </summary>
    /// <remarks>
    /// Restricted to this machine's own app surfaces: loopback http(s) origins (the
    /// dev server) and the opaque <c>null</c> origin a packaged <c>file://</c> window
    /// sends. The bearer token remains the actual gate — this only keeps an arbitrary
    /// website from being handed permission to try. Reflecting the caller's origin
    /// rather than answering <c>*</c> keeps that list explicit.
    /// </remarks>
    private static bool IsAllowedOrigin(string origin)
    {
        if (string.IsNullOrEmpty(origin))
        {
            // Same-origin and non-browser callers (the host, the CLI, harnesses)
            // send no Origin at all and need no CORS headers.
            return false;
        }

        // A packaged renderer loaded from file:// reports its origin as "null".
        if (string.Equals(origin, "null", StringComparison.Ordinal))
        {
            return true;
        }

        if (!Uri.TryCreate(origin, UriKind.Absolute, out var parsed))
        {
            return false;
        }

        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        return IPAddress.TryParse(parsed.Host, out var address)
            ? IPAddress.IsLoopback(address)
            : string.Equals(parsed.Host, "localhost", StringComparison.OrdinalIgnoreCase);
    }

    private bool IsAuthorized(string? authorization)
    {
        if (authorization is null)
        {
            return false;
        }

        var provided = Encoding.UTF8.GetBytes(authorization);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            provided,
            expectedAuthorization);
    }

    /// <summary>
    /// Serializes one `{ id, result }` envelope.
    /// </summary>
    /// <remarks>
    /// Deliberately not <c>WorkerResponse.ToJsonBytes(id)</c>: for a handler that
    /// returned <c>DirectMessagePack</c> that path writes <c>result: null</c>, because
    /// the real payload lives in a separate MessagePack buffer that only the frame
    /// protocol knew how to splice in. <c>ToResultJsonBytes()</c> transcodes it, so the
    /// hot `db/messages-*` routes answer with their actual result instead of null.
    /// </remarks>
    private static async ValueTask WriteResponseAsync(
        HttpContext context,
        WorkerResponse response,
        JsonElement? id)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, ResponseWriterOptions))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("id");
            if (id.HasValue)
            {
                id.Value.WriteTo(writer);
            }
            else
            {
                writer.WriteNullValue();
            }
            writer.WritePropertyName("result");
            writer.WriteRawValue(response.ToResultJsonBytes(), skipInputValidation: true);
            writer.WriteEndObject();
        }

        await WriteJsonAsync(context, StatusCodes.Status200OK, buffer.WrittenMemory);
    }

    private static async ValueTask WriteErrorAsync(HttpContext context, int statusCode, string message)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }

        await WriteJsonAsync(context, statusCode, buffer.WrittenMemory);
    }

    private static async ValueTask WriteJsonAsync(
        HttpContext context,
        int statusCode,
        ReadOnlyMemory<byte> body)
    {
        context.Response.StatusCode = statusCode;
        context.Response.Headers.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength = body.Length;
        await context.Response.BodyWriter.WriteAsync(body, context.RequestAborted);
    }

    private static void WriteAscii(IBufferWriter<byte> buffer, string value)
    {
        var span = buffer.GetSpan(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            span[i] = (byte)value[i];
        }
        buffer.Advance(value.Length);
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

    private static int ReadLimit(string variableName, int defaultValue, int minimum, int maximum)
    {
        var raw = Environment.GetEnvironmentVariable(variableName);
        return int.TryParse(raw, out var value)
            ? Math.Clamp(value, minimum, maximum)
            : Math.Clamp(defaultValue, minimum, maximum);
    }

    private readonly record struct QueuedEvent(string EventName, ReadOnlyMemory<byte> Payload);

    /// <summary>
    /// One SSE lane: its queue, its wake signal, and whether a client holds it open.
    ///
    /// The wake signal exists because the drain loop must await exactly one thing.
    /// Awaiting the queue and a timeout together via <c>Task.WhenAny</c> does not work:
    /// it never throws, so a timeout is indistinguishable from an arrival, and the
    /// losing awaiter leaks a registration every iteration. A single-slot drop-write
    /// channel also collapses a burst into one wake instead of one per frame.
    /// </summary>
    private sealed class StreamLane
    {
        private readonly Channel<byte> wake = Channel.CreateBounded<byte>(
            new BoundedChannelOptions(1)
            {
                SingleReader = true,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.DropWrite,
                AllowSynchronousContinuations = false
            });
        private int connections;
        private long bufferedBytes;
        private long dropped;

        public StreamLane(Channel<QueuedEvent> queue, bool metered)
        {
            Queue = queue;
            Metered = metered;
        }

        public Channel<QueuedEvent> Queue { get; }

        /// <summary>
        /// Whether the lane enforces a byte budget. The budget is per lane, not
        /// global: one consumer that stops reading must not exhaust a shared
        /// allowance and start costing every other consumer dropped frames.
        /// </summary>
        public bool Metered { get; }

        public long BufferedBytes => Volatile.Read(ref bufferedBytes);

        public long Dropped => Volatile.Read(ref dropped);

        public bool IsAttached => Volatile.Read(ref connections) > 0;

        public bool TryReserve(int length)
        {
            if (!Metered)
            {
                return true;
            }

            while (true)
            {
                var current = Volatile.Read(ref bufferedBytes);
                // One oversized frame may still make progress on an empty queue.
                if (current > 0 && current + length > MaxBufferedEventBytes)
                {
                    return false;
                }
                if (Interlocked.CompareExchange(ref bufferedBytes, current + length, current) == current)
                {
                    return true;
                }
            }
        }

        public void Release(int length)
        {
            if (Metered)
            {
                Interlocked.Add(ref bufferedBytes, -length);
            }
        }

        public long RecordDrop() => Interlocked.Increment(ref dropped);

        /// <summary>
        /// Claims the lane for one client. A second concurrent reader would split the
        /// stream between them, so the loser is told to go away instead.
        /// </summary>
        public bool TryAttach()
        {
            if (Interlocked.CompareExchange(ref connections, 1, 0) == 0)
            {
                return true;
            }
            return false;
        }

        public void Detach()
        {
            Interlocked.Exchange(ref connections, 0);
        }

        public void Signal()
        {
            wake.Writer.TryWrite(0);
        }

        /// <summary>Waits for a wake. Throws when the idle deadline expires first.</summary>
        public async ValueTask WaitForWakeAsync(CancellationToken cancellationToken)
        {
            await wake.Reader.WaitToReadAsync(cancellationToken);
            wake.Reader.TryRead(out _);
        }
    }
}
