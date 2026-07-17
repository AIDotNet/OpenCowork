using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

internal static class MessagePackJsonTranscoder
{
    public static JsonDocument ToJsonDocument(ReadOnlySpan<byte> messagePack)
    {
        var reader = new Reader(messagePack);
        var buffer = new ArrayBufferWriter<byte>();

        using (var writer = new Utf8JsonWriter(buffer))
        {
            reader.WriteJsonValue(writer);
        }

        reader.EnsureComplete();
        return JsonDocument.Parse(buffer.WrittenMemory);
    }

    public static byte[] ToJsonBytes(ReadOnlySpan<byte> messagePack)
    {
        var reader = new Reader(messagePack);
        var buffer = new ArrayBufferWriter<byte>();

        using (var writer = new Utf8JsonWriter(buffer))
        {
            reader.WriteJsonValue(writer);
        }

        reader.EnsureComplete();
        return buffer.WrittenMemory.ToArray();
    }

    public static byte[] FromJson(JsonElement element)
    {
        var buffer = new ArrayBufferWriter<byte>();
        WriteJsonElement(buffer, element);
        return buffer.WrittenMemory.ToArray();
    }

    public static byte[] FromJson(ReadOnlySpan<byte> json)
    {
        var reader = new Utf8JsonReader(json, isFinalBlock: true, state: default);
        if (!reader.Read())
        {
            throw new InvalidDataException("JSON response is empty.");
        }

        var writer = new WorkerMessagePackWriter();
        WriteJsonToken(ref reader, writer);
        if (reader.Read())
        {
            throw new InvalidDataException("JSON response contains trailing data.");
        }
        return writer.ToArray();
    }

    private static void WriteJsonToken(
        ref Utf8JsonReader reader,
        WorkerMessagePackWriter writer)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.StartObject:
                writer.WriteMapHeader(CountContainerItems(reader, countProperties: true));
                while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                {
                    if (reader.TokenType != JsonTokenType.PropertyName)
                    {
                        throw new InvalidDataException("Invalid JSON object token sequence.");
                    }
                    writer.WriteString(reader.GetString() ?? string.Empty);
                    if (!reader.Read())
                    {
                        throw new InvalidDataException("JSON object ended before its property value.");
                    }
                    WriteJsonToken(ref reader, writer);
                }
                break;
            case JsonTokenType.StartArray:
                writer.WriteArrayHeader(CountContainerItems(reader, countProperties: false));
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                {
                    WriteJsonToken(ref reader, writer);
                }
                break;
            case JsonTokenType.String:
                writer.WriteString(reader.GetString() ?? string.Empty);
                break;
            case JsonTokenType.Number when reader.TryGetInt64(out var signed):
                writer.WriteInt64(signed);
                break;
            case JsonTokenType.Number when reader.TryGetUInt64(out var unsigned):
                writer.WriteUInt64(unsigned);
                break;
            case JsonTokenType.Number:
                writer.WriteDouble(reader.GetDouble());
                break;
            case JsonTokenType.True:
                writer.WriteBoolean(true);
                break;
            case JsonTokenType.False:
                writer.WriteBoolean(false);
                break;
            case JsonTokenType.Null:
                writer.WriteNil();
                break;
            default:
                throw new InvalidDataException($"Unsupported JSON token: {reader.TokenType}");
        }
    }

    private static int CountContainerItems(Utf8JsonReader start, bool countProperties)
    {
        var reader = start;
        var nestedDepth = 0;
        var count = 0;
        while (reader.Read())
        {
            if (nestedDepth == 0)
            {
                if (countProperties && reader.TokenType == JsonTokenType.PropertyName)
                {
                    count++;
                }
                else if (!countProperties && IsValueToken(reader.TokenType))
                {
                    count++;
                }
            }

            if (reader.TokenType is JsonTokenType.StartObject or JsonTokenType.StartArray)
            {
                nestedDepth++;
            }
            else if (reader.TokenType is JsonTokenType.EndObject or JsonTokenType.EndArray)
            {
                if (nestedDepth == 0)
                {
                    break;
                }
                nestedDepth--;
            }
        }
        return count;
    }

    private static bool IsValueToken(JsonTokenType tokenType)
    {
        return tokenType is
            JsonTokenType.StartObject or
            JsonTokenType.StartArray or
            JsonTokenType.String or
            JsonTokenType.Number or
            JsonTokenType.True or
            JsonTokenType.False or
            JsonTokenType.Null;
    }

    private static void WriteJsonElement(ArrayBufferWriter<byte> buffer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteMapHeader(buffer, CountProperties(element));
                foreach (var property in element.EnumerateObject())
                {
                    WriteString(buffer, property.Name);
                    WriteJsonElement(buffer, property.Value);
                }
                break;
            case JsonValueKind.Array:
                WriteArrayHeader(buffer, element.GetArrayLength());
                foreach (var item in element.EnumerateArray())
                {
                    WriteJsonElement(buffer, item);
                }
                break;
            case JsonValueKind.String:
                WriteString(buffer, element.GetString() ?? string.Empty);
                break;
            case JsonValueKind.Number:
                WriteNumber(buffer, element);
                break;
            case JsonValueKind.True:
                WriteByte(buffer, 0xc3);
                break;
            case JsonValueKind.False:
                WriteByte(buffer, 0xc2);
                break;
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                WriteByte(buffer, 0xc0);
                break;
            default:
                throw new InvalidDataException($"Unsupported JSON value kind: {element.ValueKind}");
        }
    }

    private static void WriteNumber(ArrayBufferWriter<byte> buffer, JsonElement element)
    {
        if (element.TryGetInt64(out var signed))
        {
            WriteInt(buffer, signed);
            return;
        }

        if (element.TryGetUInt64(out var unsigned))
        {
            WriteUInt(buffer, unsigned);
            return;
        }

        WriteDouble(buffer, element.GetDouble());
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

    private static void WriteString(ArrayBufferWriter<byte> buffer, string value)
    {
        var byteCount = Encoding.UTF8.GetByteCount(value);
        WriteStringHeader(buffer, byteCount);

        var span = buffer.GetSpan(byteCount);
        var written = Encoding.UTF8.GetBytes(value, span);
        buffer.Advance(written);
    }

    private static void WriteStringHeader(ArrayBufferWriter<byte> buffer, int length)
    {
        if (length <= 31)
        {
            WriteByte(buffer, (byte)(0xa0 | length));
            return;
        }

        if (length <= byte.MaxValue)
        {
            WriteByte(buffer, 0xd9);
            WriteByte(buffer, (byte)length);
            return;
        }

        if (length <= ushort.MaxValue)
        {
            WriteByte(buffer, 0xda);
            WriteUInt16(buffer, (ushort)length);
            return;
        }

        WriteByte(buffer, 0xdb);
        WriteUInt32(buffer, checked((uint)length));
    }

    private static void WriteArrayHeader(ArrayBufferWriter<byte> buffer, int length)
    {
        if (length <= 15)
        {
            WriteByte(buffer, (byte)(0x90 | length));
            return;
        }

        if (length <= ushort.MaxValue)
        {
            WriteByte(buffer, 0xdc);
            WriteUInt16(buffer, (ushort)length);
            return;
        }

        WriteByte(buffer, 0xdd);
        WriteUInt32(buffer, checked((uint)length));
    }

    private static void WriteMapHeader(ArrayBufferWriter<byte> buffer, int length)
    {
        if (length <= 15)
        {
            WriteByte(buffer, (byte)(0x80 | length));
            return;
        }

        if (length <= ushort.MaxValue)
        {
            WriteByte(buffer, 0xde);
            WriteUInt16(buffer, (ushort)length);
            return;
        }

        WriteByte(buffer, 0xdf);
        WriteUInt32(buffer, checked((uint)length));
    }

    private static void WriteInt(ArrayBufferWriter<byte> buffer, long value)
    {
        if (value >= 0)
        {
            WriteUInt(buffer, (ulong)value);
            return;
        }

        if (value >= -32)
        {
            WriteByte(buffer, unchecked((byte)value));
            return;
        }

        if (value >= sbyte.MinValue)
        {
            WriteByte(buffer, 0xd0);
            WriteByte(buffer, unchecked((byte)(sbyte)value));
            return;
        }

        if (value >= short.MinValue)
        {
            WriteByte(buffer, 0xd1);
            WriteInt16(buffer, (short)value);
            return;
        }

        if (value >= int.MinValue)
        {
            WriteByte(buffer, 0xd2);
            WriteInt32(buffer, (int)value);
            return;
        }

        WriteByte(buffer, 0xd3);
        WriteInt64(buffer, value);
    }

    private static void WriteUInt(ArrayBufferWriter<byte> buffer, ulong value)
    {
        if (value <= 0x7f)
        {
            WriteByte(buffer, (byte)value);
            return;
        }

        if (value <= byte.MaxValue)
        {
            WriteByte(buffer, 0xcc);
            WriteByte(buffer, (byte)value);
            return;
        }

        if (value <= ushort.MaxValue)
        {
            WriteByte(buffer, 0xcd);
            WriteUInt16(buffer, (ushort)value);
            return;
        }

        if (value <= uint.MaxValue)
        {
            WriteByte(buffer, 0xce);
            WriteUInt32(buffer, (uint)value);
            return;
        }

        WriteByte(buffer, 0xcf);
        WriteUInt64(buffer, value);
    }

    private static void WriteDouble(ArrayBufferWriter<byte> buffer, double value)
    {
        if (!double.IsFinite(value))
        {
            throw new InvalidDataException("MessagePack JSON transcoder does not support non-finite numbers.");
        }

        WriteByte(buffer, 0xcb);
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(bytes, BitConverter.DoubleToInt64Bits(value));
        WriteBytes(buffer, bytes);
    }

    private static void WriteByte(ArrayBufferWriter<byte> buffer, byte value)
    {
        var span = buffer.GetSpan(1);
        span[0] = value;
        buffer.Advance(1);
    }

    private static void WriteBytes(ArrayBufferWriter<byte> buffer, ReadOnlySpan<byte> value)
    {
        var span = buffer.GetSpan(value.Length);
        value.CopyTo(span);
        buffer.Advance(value.Length);
    }

    private static void WriteUInt16(ArrayBufferWriter<byte> buffer, ushort value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(ushort)];
        BinaryPrimitives.WriteUInt16BigEndian(bytes, value);
        WriteBytes(buffer, bytes);
    }

    private static void WriteInt16(ArrayBufferWriter<byte> buffer, short value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(short)];
        BinaryPrimitives.WriteInt16BigEndian(bytes, value);
        WriteBytes(buffer, bytes);
    }

    private static void WriteUInt32(ArrayBufferWriter<byte> buffer, uint value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, value);
        WriteBytes(buffer, bytes);
    }

    private static void WriteInt32(ArrayBufferWriter<byte> buffer, int value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(bytes, value);
        WriteBytes(buffer, bytes);
    }

    private static void WriteUInt64(ArrayBufferWriter<byte> buffer, ulong value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64BigEndian(bytes, value);
        WriteBytes(buffer, bytes);
    }

    private static void WriteInt64(ArrayBufferWriter<byte> buffer, long value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64BigEndian(bytes, value);
        WriteBytes(buffer, bytes);
    }

    private ref struct Reader
    {
        private readonly ReadOnlySpan<byte> data;
        private int offset;

        public Reader(ReadOnlySpan<byte> data)
        {
            this.data = data;
            offset = 0;
        }

        public void EnsureComplete()
        {
            if (offset != data.Length)
            {
                throw new InvalidDataException("MessagePack payload contains trailing bytes.");
            }
        }

        public void WriteJsonValue(Utf8JsonWriter writer)
        {
            var code = ReadByte();

            if (code <= 0x7f)
            {
                writer.WriteNumberValue(code);
                return;
            }

            if (code >= 0xe0)
            {
                writer.WriteNumberValue(unchecked((sbyte)code));
                return;
            }

            if ((code & 0xf0) == 0x80)
            {
                WriteMap(writer, code & 0x0f);
                return;
            }

            if ((code & 0xf0) == 0x90)
            {
                WriteArray(writer, code & 0x0f);
                return;
            }

            if ((code & 0xe0) == 0xa0)
            {
                writer.WriteStringValue(ReadStringBytes(code & 0x1f));
                return;
            }

            switch (code)
            {
                case 0xc0:
                    writer.WriteNullValue();
                    break;
                case 0xc2:
                    writer.WriteBooleanValue(false);
                    break;
                case 0xc3:
                    writer.WriteBooleanValue(true);
                    break;
                case 0xc4:
                    writer.WriteStringValue(Convert.ToBase64String(ReadBytes(ReadByte())));
                    break;
                case 0xc5:
                    writer.WriteStringValue(Convert.ToBase64String(ReadBytes(ReadUInt16())));
                    break;
                case 0xc6:
                    writer.WriteStringValue(Convert.ToBase64String(ReadBytes(ReadInt32Length())));
                    break;
                case 0xca:
                    WriteSingle(writer);
                    break;
                case 0xcb:
                    WriteDouble(writer);
                    break;
                case 0xcc:
                    writer.WriteNumberValue(ReadByte());
                    break;
                case 0xcd:
                    writer.WriteNumberValue(ReadUInt16());
                    break;
                case 0xce:
                    writer.WriteNumberValue(ReadUInt32());
                    break;
                case 0xcf:
                    writer.WriteNumberValue(ReadUInt64());
                    break;
                case 0xd0:
                    writer.WriteNumberValue(unchecked((sbyte)ReadByte()));
                    break;
                case 0xd1:
                    writer.WriteNumberValue(ReadInt16());
                    break;
                case 0xd2:
                    writer.WriteNumberValue(ReadInt32());
                    break;
                case 0xd3:
                    writer.WriteNumberValue(ReadInt64());
                    break;
                case 0xd9:
                    writer.WriteStringValue(ReadStringBytes(ReadByte()));
                    break;
                case 0xda:
                    writer.WriteStringValue(ReadStringBytes(ReadUInt16()));
                    break;
                case 0xdb:
                    writer.WriteStringValue(ReadStringBytes(ReadInt32Length()));
                    break;
                case 0xdc:
                    WriteArray(writer, ReadUInt16());
                    break;
                case 0xdd:
                    WriteArray(writer, ReadInt32Length());
                    break;
                case 0xde:
                    WriteMap(writer, ReadUInt16());
                    break;
                case 0xdf:
                    WriteMap(writer, ReadInt32Length());
                    break;
                default:
                    throw new InvalidDataException($"Unsupported MessagePack code: 0x{code:x2}");
            }
        }

        private void WriteArray(Utf8JsonWriter writer, int length)
        {
            writer.WriteStartArray();
            for (var i = 0; i < length; i++)
            {
                WriteJsonValue(writer);
            }

            writer.WriteEndArray();
        }

        private void WriteMap(Utf8JsonWriter writer, int length)
        {
            writer.WriteStartObject();
            for (var i = 0; i < length; i++)
            {
                writer.WritePropertyName(ReadMapKey());
                WriteJsonValue(writer);
            }

            writer.WriteEndObject();
        }

        private string ReadMapKey()
        {
            var code = ReadByte();

            if ((code & 0xe0) == 0xa0)
            {
                return ReadStringBytes(code & 0x1f);
            }

            return code switch
            {
                0xd9 => ReadStringBytes(ReadByte()),
                0xda => ReadStringBytes(ReadUInt16()),
                0xdb => ReadStringBytes(ReadInt32Length()),
                _ => throw new InvalidDataException("MessagePack map keys must be strings.")
            };
        }

        private void WriteSingle(Utf8JsonWriter writer)
        {
            var value = BitConverter.Int32BitsToSingle(ReadInt32());
            if (!float.IsFinite(value))
            {
                throw new InvalidDataException("MessagePack JSON transcoder does not support non-finite numbers.");
            }

            writer.WriteNumberValue(value);
        }

        private void WriteDouble(Utf8JsonWriter writer)
        {
            var value = BitConverter.Int64BitsToDouble(ReadInt64());
            if (!double.IsFinite(value))
            {
                throw new InvalidDataException("MessagePack JSON transcoder does not support non-finite numbers.");
            }

            writer.WriteNumberValue(value);
        }

        private string ReadStringBytes(int length)
        {
            return Encoding.UTF8.GetString(ReadBytes(length));
        }

        private byte ReadByte()
        {
            if (offset >= data.Length)
            {
                throw new EndOfStreamException("MessagePack payload ended early.");
            }

            return data[offset++];
        }

        private ReadOnlySpan<byte> ReadBytes(int length)
        {
            if (length < 0 || data.Length - offset < length)
            {
                throw new EndOfStreamException("MessagePack payload ended early.");
            }

            var bytes = data.Slice(offset, length);
            offset += length;
            return bytes;
        }

        private ushort ReadUInt16()
        {
            return BinaryPrimitives.ReadUInt16BigEndian(ReadBytes(sizeof(ushort)));
        }

        private uint ReadUInt32()
        {
            return BinaryPrimitives.ReadUInt32BigEndian(ReadBytes(sizeof(uint)));
        }

        private ulong ReadUInt64()
        {
            return BinaryPrimitives.ReadUInt64BigEndian(ReadBytes(sizeof(ulong)));
        }

        private short ReadInt16()
        {
            return BinaryPrimitives.ReadInt16BigEndian(ReadBytes(sizeof(short)));
        }

        private int ReadInt32()
        {
            return BinaryPrimitives.ReadInt32BigEndian(ReadBytes(sizeof(int)));
        }

        private long ReadInt64()
        {
            return BinaryPrimitives.ReadInt64BigEndian(ReadBytes(sizeof(long)));
        }

        private int ReadInt32Length()
        {
            var value = ReadUInt32();
            if (value > int.MaxValue)
            {
                throw new InvalidDataException($"MessagePack payload length is too large: {value}");
            }

            return (int)value;
        }
    }
}
