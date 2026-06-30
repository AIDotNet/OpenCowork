using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

internal sealed class WorkerRequestContext
{
    private readonly Func<string, Action<Utf8JsonWriter>, CancellationToken, ValueTask> emitEventAsync;
    private readonly Func<WorkerMessagePackEvent, CancellationToken, ValueTask> emitMessagePackEventAsync;

    public WorkerRequestContext(
        Func<string, Action<Utf8JsonWriter>, CancellationToken, ValueTask> emitEventAsync,
        Func<WorkerMessagePackEvent, CancellationToken, ValueTask> emitMessagePackEventAsync,
        CancellationToken cancellationToken)
    {
        this.emitEventAsync = emitEventAsync;
        this.emitMessagePackEventAsync = emitMessagePackEventAsync;
        CancellationToken = cancellationToken;
    }

    public CancellationToken CancellationToken { get; }

    public ValueTask EmitEventAsync<T>(string eventName, T parameters, JsonTypeInfo<T> typeInfo)
    {
        return emitEventAsync(
            eventName,
            writer => JsonSerializer.Serialize(writer, parameters, typeInfo),
            CancellationToken);
    }

    public ValueTask EmitMessagePackEventAsync(WorkerMessagePackEvent messagePackEvent)
    {
        return emitMessagePackEventAsync(messagePackEvent, CancellationToken);
    }
}
