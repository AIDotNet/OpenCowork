using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

internal sealed class WorkerRequestContext
{
    private readonly Func<string, Action<Utf8JsonWriter>, CancellationToken, ValueTask> emitEventAsync;
    private readonly Func<WorkerMessagePackEvent, CancellationToken, ValueTask> emitMessagePackEventAsync;

    public WorkerRequestContext(
        Func<string, Action<Utf8JsonWriter>, CancellationToken, ValueTask> emitEventAsync,
        Func<WorkerMessagePackEvent, CancellationToken, ValueTask> emitMessagePackEventAsync,
        CancellationToken cancellationToken,
        CancellationToken connectionCancellationToken = default)
    {
        this.emitEventAsync = emitEventAsync;
        this.emitMessagePackEventAsync = emitMessagePackEventAsync;
        CancellationToken = cancellationToken;
        ConnectionCancellationToken = connectionCancellationToken == default
            ? cancellationToken
            : connectionCancellationToken;
    }

    public CancellationToken CancellationToken { get; }

    public CancellationToken ConnectionCancellationToken { get; }

    public WorkerRequestContext ForBackgroundOperation()
    {
        return new WorkerRequestContext(
            emitEventAsync,
            emitMessagePackEventAsync,
            ConnectionCancellationToken,
            ConnectionCancellationToken);
    }

    public ValueTask EmitEventAsync<T>(string eventName, T parameters, JsonTypeInfo<T> typeInfo)
    {
        return emitEventAsync(
            eventName,
            writer => JsonSerializer.Serialize(writer, parameters, typeInfo),
            CancellationToken);
    }

    public ValueTask EmitEventIgnoringCancellationAsync<T>(string eventName, T parameters, JsonTypeInfo<T> typeInfo)
    {
        return emitEventAsync(
            eventName,
            writer => JsonSerializer.Serialize(writer, parameters, typeInfo),
            CancellationToken.None);
    }

    public ValueTask EmitMessagePackEventAsync(WorkerMessagePackEvent messagePackEvent)
    {
        return emitMessagePackEventAsync(messagePackEvent, CancellationToken);
    }
}
