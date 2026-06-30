using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

internal sealed class WorkerResponse
{
    private readonly Action<Utf8JsonWriter> resultWriter;

    private WorkerResponse(Action<Utf8JsonWriter> resultWriter)
    {
        this.resultWriter = resultWriter;
    }

    public static WorkerResponse Json<T>(T result, JsonTypeInfo<T> typeInfo)
    {
        return new WorkerResponse(writer => JsonSerializer.Serialize(writer, result, typeInfo));
    }

    public static WorkerResponse String(string result)
    {
        return new WorkerResponse(writer => writer.WriteStringValue(result));
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
}
