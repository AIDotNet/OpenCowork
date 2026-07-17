using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

internal sealed class WorkerResponse
{
    private readonly Action<Utf8JsonWriter> resultWriter;
    private readonly byte[]? messagePackResult;

    private WorkerResponse(Action<Utf8JsonWriter> resultWriter, byte[]? messagePackResult = null)
    {
        this.resultWriter = resultWriter;
        this.messagePackResult = messagePackResult;
    }

    public static WorkerResponse Json<T>(T result, JsonTypeInfo<T> typeInfo)
    {
        return new WorkerResponse(writer => JsonSerializer.Serialize(writer, result, typeInfo));
    }

    public static WorkerResponse String(string result)
    {
        return new WorkerResponse(writer => writer.WriteStringValue(result));
    }

    // Writes the result directly into the outgoing JSON buffer. Prefer this over
    // building a JsonObject and RawJson-ing it when the payload is large (e.g. a
    // multi-MB debug body): it escapes the value once instead of serializing,
    // re-parsing and re-serializing it.
    public static WorkerResponse FromWriter(Action<Utf8JsonWriter> writeResult)
    {
        return new WorkerResponse(writeResult);
    }

    public static WorkerResponse DirectMessagePack(Action<WorkerMessagePackWriter> writeResult)
    {
        var writer = new WorkerMessagePackWriter();
        writeResult(writer);
        var result = writer.ToArray();
        return new WorkerResponse(
            jsonWriter => jsonWriter.WriteNullValue(),
            result);
    }

    public static WorkerResponse DirectMessagePackJson(ReadOnlySpan<byte> jsonResult)
    {
        var result = MessagePackJsonTranscoder.FromJson(jsonResult);
        return new WorkerResponse(
            jsonWriter => jsonWriter.WriteNullValue(),
            result);
    }

    public static WorkerResponse RawJson(string result)
    {
        return new WorkerResponse(writer =>
        {
            try
            {
                using var document = JsonDocument.Parse(result);
                document.RootElement.WriteTo(writer);
            }
            catch
            {
                writer.WriteStringValue(result);
            }
        });
    }

    public static WorkerResponse Error(string message)
    {
        return Json(new ErrorResult(message), WorkerJsonContext.Default.ErrorResult);
    }

    public byte[] ToJsonBytes(JsonElement? id)
    {
        return WorkerJson.WriteResponse(id, resultWriter);
    }

    public bool TryGetMessagePackResult(out ReadOnlyMemory<byte> result)
    {
        result = messagePackResult;
        return messagePackResult is not null;
    }
}
