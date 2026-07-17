using System.Buffers.Binary;
using System.Text.Json;

internal static class MessagePackFrameProtocol
{
    private const int HeaderLength = 4;
    private const int MaxFrameLength = 256 * 1024 * 1024;

    public static async ValueTask<byte[]?> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[HeaderLength];
        var headerBytes = await ReadSomeOrEndAsync(stream, header, cancellationToken);
        if (headerBytes == 0)
        {
            return null;
        }

        if (headerBytes != HeaderLength)
        {
            throw new EndOfStreamException("Native worker IPC frame header ended early.");
        }

        var length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length <= 0 || length > MaxFrameLength)
        {
            throw new InvalidDataException($"Invalid native worker IPC frame length: {length}");
        }

        var payload = GC.AllocateUninitializedArray<byte>(length);
        await stream.ReadExactlyAsync(payload.AsMemory(), cancellationToken);
        return payload;
    }

    public static async ValueTask WriteFrameAsync(
        Stream stream,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        if (payload.Length <= 0 || payload.Length > MaxFrameLength)
        {
            throw new InvalidDataException($"Invalid native worker IPC response length: {payload.Length}");
        }

        var header = new byte[HeaderLength];
        BinaryPrimitives.WriteInt32BigEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static byte[] ConvertRequestToJson(ReadOnlyMemory<byte> payload)
    {
        return MessagePackJsonTranscoder.ToJsonBytes(payload.Span);
    }

    public static JsonDocument ConvertRequestToJsonDocument(ReadOnlyMemory<byte> payload)
    {
        return MessagePackJsonTranscoder.ToJsonDocument(payload.Span);
    }

    public static byte[] ConvertResponseFromJson(ReadOnlyMemory<byte> json)
    {
        return MessagePackJsonTranscoder.FromJson(json.Span);
    }

    public static byte[] EncodeResponse(WorkerResponse response, JsonElement? id)
    {
        if (response.TryGetMessagePackResult(out var result))
        {
            var writer = new WorkerMessagePackWriter();
            writer.WriteMapHeader(2);
            writer.WriteString("id");
            if (id.HasValue)
            {
                writer.WriteJsonElement(id.Value);
            }
            else
            {
                writer.WriteNil();
            }
            writer.WriteString("result");
            writer.WriteRaw(result.Span);
            return writer.ToArray();
        }

        return ConvertResponseFromJson(response.ToJsonBytes(id));
    }

    public static byte[] EncodeEvent(string eventName, Action<Utf8JsonWriter> writeParameters)
    {
        return ConvertResponseFromJson(WorkerJson.WriteEvent(eventName, writeParameters));
    }

    private static async ValueTask<int> ReadSomeOrEndAsync(
        Stream stream,
        byte[] buffer,
        CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total, buffer.Length - total), cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
        }

        return total;
    }
}
