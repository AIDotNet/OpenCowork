using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

internal sealed class WorkerMessagePackWriter
{
    private readonly ArrayBufferWriter<byte> buffer = new();

    public ReadOnlySpan<byte> WrittenSpan => buffer.WrittenSpan;

    public byte[] ToArray() => buffer.WrittenMemory.ToArray();

    public void WriteRaw(ReadOnlySpan<byte> value)
    {
        value.CopyTo(buffer.GetSpan(value.Length));
        buffer.Advance(value.Length);
    }

    public void WriteMapHeader(int length)
    {
        if (length < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(length));
        }
        if (length <= 15)
        {
            WriteByte((byte)(0x80 | length));
            return;
        }
        if (length <= ushort.MaxValue)
        {
            WriteByte(0xde);
            WriteUInt16((ushort)length);
            return;
        }

        WriteByte(0xdf);
        WriteUInt32((uint)length);
    }

    public void WriteArrayHeader(int length)
    {
        if (length < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(length));
        }
        if (length <= 15)
        {
            WriteByte((byte)(0x90 | length));
            return;
        }
        if (length <= ushort.MaxValue)
        {
            WriteByte(0xdc);
            WriteUInt16((ushort)length);
            return;
        }

        WriteByte(0xdd);
        WriteUInt32((uint)length);
    }

    public void WriteString(string value)
    {
        var byteCount = Encoding.UTF8.GetByteCount(value);
        if (byteCount <= 31)
        {
            WriteByte((byte)(0xa0 | byteCount));
        }
        else if (byteCount <= byte.MaxValue)
        {
            WriteByte(0xd9);
            WriteByte((byte)byteCount);
        }
        else if (byteCount <= ushort.MaxValue)
        {
            WriteByte(0xda);
            WriteUInt16((ushort)byteCount);
        }
        else
        {
            WriteByte(0xdb);
            WriteUInt32((uint)byteCount);
        }

        var destination = buffer.GetSpan(byteCount);
        var written = Encoding.UTF8.GetBytes(value, destination);
        buffer.Advance(written);
    }

    public void WriteBoolean(bool value) => WriteByte(value ? (byte)0xc3 : (byte)0xc2);

    public void WriteNil() => WriteByte(0xc0);

    public void WriteInt64(long value)
    {
        if (value >= 0)
        {
            WriteUInt64((ulong)value);
            return;
        }
        if (value >= -32)
        {
            WriteByte(unchecked((byte)value));
            return;
        }
        if (value >= sbyte.MinValue)
        {
            WriteByte(0xd0);
            WriteByte(unchecked((byte)(sbyte)value));
            return;
        }
        if (value >= short.MinValue)
        {
            WriteByte(0xd1);
            WriteInt16((short)value);
            return;
        }
        if (value >= int.MinValue)
        {
            WriteByte(0xd2);
            WriteInt32((int)value);
            return;
        }

        WriteByte(0xd3);
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(bytes, value);
        WriteRaw(bytes);
    }

    public void WriteUInt64(ulong value)
    {
        if (value <= 0x7f)
        {
            WriteByte((byte)value);
            return;
        }
        if (value <= byte.MaxValue)
        {
            WriteByte(0xcc);
            WriteByte((byte)value);
            return;
        }
        if (value <= ushort.MaxValue)
        {
            WriteByte(0xcd);
            WriteUInt16((ushort)value);
            return;
        }
        if (value <= uint.MaxValue)
        {
            WriteByte(0xce);
            WriteUInt32((uint)value);
            return;
        }

        WriteByte(0xcf);
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64BigEndian(bytes, value);
        WriteRaw(bytes);
    }

    public void WriteDouble(double value)
    {
        if (!double.IsFinite(value))
        {
            throw new InvalidDataException("MessagePack does not support non-finite JSON numbers.");
        }

        WriteByte(0xcb);
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(bytes, BitConverter.DoubleToInt64Bits(value));
        WriteRaw(bytes);
    }

    public void WriteJsonElement(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteMapHeader(CountProperties(element));
                foreach (var property in element.EnumerateObject())
                {
                    WriteString(property.Name);
                    WriteJsonElement(property.Value);
                }
                break;
            case JsonValueKind.Array:
                WriteArrayHeader(element.GetArrayLength());
                foreach (var item in element.EnumerateArray())
                {
                    WriteJsonElement(item);
                }
                break;
            case JsonValueKind.String:
                WriteString(element.GetString() ?? string.Empty);
                break;
            case JsonValueKind.Number when element.TryGetInt64(out var signed):
                WriteInt64(signed);
                break;
            case JsonValueKind.Number when element.TryGetUInt64(out var unsigned):
                WriteUInt64(unsigned);
                break;
            case JsonValueKind.Number:
                WriteDouble(element.GetDouble());
                break;
            case JsonValueKind.True:
                WriteBoolean(true);
                break;
            case JsonValueKind.False:
                WriteBoolean(false);
                break;
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                WriteNil();
                break;
            default:
                throw new InvalidDataException($"Unsupported JSON value kind: {element.ValueKind}");
        }
    }

    private static int CountProperties(JsonElement element)
    {
        var count = 0;
        foreach (var _ in element.EnumerateObject())
        {
            count++;
        }
        return count;
    }

    private void WriteByte(byte value)
    {
        var span = buffer.GetSpan(1);
        span[0] = value;
        buffer.Advance(1);
    }

    private void WriteUInt16(ushort value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(ushort)];
        BinaryPrimitives.WriteUInt16BigEndian(bytes, value);
        WriteRaw(bytes);
    }

    private void WriteInt16(short value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(short)];
        BinaryPrimitives.WriteInt16BigEndian(bytes, value);
        WriteRaw(bytes);
    }

    private void WriteUInt32(uint value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, value);
        WriteRaw(bytes);
    }

    private void WriteInt32(int value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(bytes, value);
        WriteRaw(bytes);
    }
}
