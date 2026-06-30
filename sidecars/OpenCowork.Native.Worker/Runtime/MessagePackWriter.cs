using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

internal sealed class MessagePackWriter
{
    private readonly ArrayBufferWriter<byte> buffer;

    public MessagePackWriter(int initialCapacity = 4096)
    {
        buffer = new ArrayBufferWriter<byte>(initialCapacity);
    }

    public byte[] ToArray()
    {
        return buffer.WrittenMemory.ToArray();
    }

    public void WriteMapHeader(int length)
    {
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
        WriteUInt32(checked((uint)length));
    }

    public void WriteArrayHeader(int length)
    {
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
        WriteUInt32(checked((uint)length));
    }

    public void WriteString(string value)
    {
        var byteCount = Encoding.UTF8.GetByteCount(value);
        WriteStringHeader(byteCount);

        var span = buffer.GetSpan(byteCount);
        var written = Encoding.UTF8.GetBytes(value, span);
        buffer.Advance(written);
    }

    public void WriteBoolean(bool value)
    {
        WriteByte(value ? (byte)0xc3 : (byte)0xc2);
    }

    public void WriteNull()
    {
        WriteByte(0xc0);
    }

    public void WriteInt32(int value)
    {
        WriteInt64(value);
    }

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
            WriteRawInt32((int)value);
            return;
        }

        WriteByte(0xd3);
        WriteRawInt64(value);
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
        WriteRawUInt64(value);
    }

    public void WriteDouble(double value)
    {
        if (!double.IsFinite(value))
        {
            throw new InvalidDataException("MessagePack writer does not support non-finite numbers.");
        }

        WriteByte(0xcb);
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(bytes, BitConverter.DoubleToInt64Bits(value));
        WriteBytes(bytes);
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
            case JsonValueKind.Number:
                WriteJsonNumber(element);
                break;
            case JsonValueKind.True:
                WriteBoolean(true);
                break;
            case JsonValueKind.False:
                WriteBoolean(false);
                break;
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                WriteNull();
                break;
            default:
                throw new InvalidDataException($"Unsupported JSON value kind: {element.ValueKind}");
        }
    }

    private void WriteJsonNumber(JsonElement element)
    {
        if (element.TryGetInt64(out var signed))
        {
            WriteInt64(signed);
            return;
        }

        if (element.TryGetUInt64(out var unsigned))
        {
            WriteUInt64(unsigned);
            return;
        }

        WriteDouble(element.GetDouble());
    }

    private void WriteStringHeader(int length)
    {
        if (length <= 31)
        {
            WriteByte((byte)(0xa0 | length));
            return;
        }

        if (length <= byte.MaxValue)
        {
            WriteByte(0xd9);
            WriteByte((byte)length);
            return;
        }

        if (length <= ushort.MaxValue)
        {
            WriteByte(0xda);
            WriteUInt16((ushort)length);
            return;
        }

        WriteByte(0xdb);
        WriteUInt32(checked((uint)length));
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

    private void WriteBytes(ReadOnlySpan<byte> value)
    {
        var span = buffer.GetSpan(value.Length);
        value.CopyTo(span);
        buffer.Advance(value.Length);
    }

    private void WriteUInt16(ushort value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(ushort)];
        BinaryPrimitives.WriteUInt16BigEndian(bytes, value);
        WriteBytes(bytes);
    }

    private void WriteInt16(short value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(short)];
        BinaryPrimitives.WriteInt16BigEndian(bytes, value);
        WriteBytes(bytes);
    }

    private void WriteUInt32(uint value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, value);
        WriteBytes(bytes);
    }

    private void WriteRawInt32(int value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(bytes, value);
        WriteBytes(bytes);
    }

    private void WriteRawUInt64(ulong value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64BigEndian(bytes, value);
        WriteBytes(bytes);
    }

    private void WriteRawInt64(long value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(bytes, value);
        WriteBytes(bytes);
    }
}
