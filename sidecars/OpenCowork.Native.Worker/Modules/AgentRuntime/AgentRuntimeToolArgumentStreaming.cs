using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal sealed class AgentRuntimeToolArgumentStreamState
{
    public string LastInputSignature { get; set; } = string.Empty;
    public long LastInputEmitTimestamp { get; set; }
}

internal static class AgentRuntimeToolArgumentStreaming
{
    private const int PartialInputEmitIntervalMs = 300;
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool TryGetInputForDelta(
        string arguments,
        AgentRuntimeToolArgumentStreamState state,
        out JsonElement input)
    {
        var now = Stopwatch.GetTimestamp();
        if (state.LastInputEmitTimestamp != 0 &&
            Stopwatch.GetElapsedTime(state.LastInputEmitTimestamp, now).TotalMilliseconds < PartialInputEmitIntervalMs)
        {
            input = default;
            return false;
        }

        if (!TryParseStreamingObject(arguments, out input))
        {
            return false;
        }

        var signature = BuildSignature(input);
        if (signature == state.LastInputSignature)
        {
            return false;
        }

        state.LastInputSignature = signature;
        state.LastInputEmitTimestamp = now;
        return true;
    }

    private static bool TryParseStreamingObject(string value, out JsonElement element)
    {
        if (TryParseCompleteObject(value, out element))
        {
            return true;
        }
        return TryParsePartialObject(value, out element);
    }

    private static bool TryParseCompleteObject(string value, out JsonElement element)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            element = default;
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(value);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                element = default;
                return false;
            }

            element = document.RootElement.Clone();
            return true;
        }
        catch (JsonException)
        {
            element = default;
            return false;
        }
    }

    private static bool TryParsePartialObject(string source, out JsonElement element)
    {
        element = default;
        if (string.IsNullOrWhiteSpace(source))
        {
            return false;
        }

        var index = 0;
        SkipWhitespace(source, ref index);
        if (index >= source.Length || source[index] != '{')
        {
            return false;
        }
        index++;

        var wroteAny = false;
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();

            while (index < source.Length)
            {
                SkipWhitespace(source, ref index);
                if (index >= source.Length || source[index] == '}')
                {
                    break;
                }
                if (source[index] == ',')
                {
                    index++;
                    continue;
                }
                if (source[index] != '"')
                {
                    break;
                }

                if (!TryReadJsonString(source, index, false, out var key, out index, out var keyComplete) ||
                    !keyComplete)
                {
                    break;
                }

                SkipWhitespace(source, ref index);
                if (index >= source.Length || source[index] != ':')
                {
                    break;
                }
                index++;
                SkipWhitespace(source, ref index);
                if (index >= source.Length)
                {
                    break;
                }

                if (source[index] == '"')
                {
                    if (!TryReadJsonString(source, index, true, out var stringValue, out index, out var complete))
                    {
                        break;
                    }
                    writer.WriteString(key, stringValue);
                    wroteAny = true;
                    if (!complete)
                    {
                        break;
                    }
                    continue;
                }

                if (!TryReadCompleteJsonValue(source, index, out var valueEnd))
                {
                    break;
                }

                try
                {
                    using var valueDocument = JsonDocument.Parse(source[index..valueEnd]);
                    writer.WritePropertyName(key);
                    valueDocument.RootElement.WriteTo(writer);
                    wroteAny = true;
                }
                catch (JsonException)
                {
                    break;
                }

                index = valueEnd;
            }

            writer.WriteEndObject();
        }

        if (!wroteAny)
        {
            return false;
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        element = document.RootElement.Clone();
        return true;
    }

    private static bool TryReadCompleteJsonValue(string source, int start, out int end)
    {
        end = start;
        if (start >= source.Length)
        {
            return false;
        }

        var first = source[start];
        if (first is '{' or '[')
        {
            return TryReadBalancedJsonValue(source, start, out end);
        }

        if (first == '-' || char.IsDigit(first))
        {
            end = start + 1;
            while (end < source.Length && !IsValueDelimiter(source[end]))
            {
                end++;
            }
            return end > start;
        }

        if (TryReadLiteral(source, start, "true", out end) ||
            TryReadLiteral(source, start, "false", out end) ||
            TryReadLiteral(source, start, "null", out end))
        {
            return true;
        }

        return false;
    }

    private static bool TryReadBalancedJsonValue(string source, int start, out int end)
    {
        end = start;
        var depth = 0;
        var inString = false;
        var escaped = false;

        for (var i = start; i < source.Length; i++)
        {
            var ch = source[i];
            if (inString)
            {
                if (escaped)
                {
                    escaped = false;
                    continue;
                }
                if (ch == '\\')
                {
                    escaped = true;
                    continue;
                }
                if (ch == '"')
                {
                    inString = false;
                }
                continue;
            }

            if (ch == '"')
            {
                inString = true;
                continue;
            }
            if (ch is '{' or '[')
            {
                depth++;
                continue;
            }
            if (ch is '}' or ']')
            {
                depth--;
                if (depth == 0)
                {
                    end = i + 1;
                    return true;
                }
            }
        }

        return false;
    }

    private static bool TryReadLiteral(string source, int start, string literal, out int end)
    {
        end = start + literal.Length;
        return source.Length >= end &&
            string.CompareOrdinal(source, start, literal, 0, literal.Length) == 0 &&
            (end >= source.Length || IsValueDelimiter(source[end]));
    }

    private static bool TryReadJsonString(
        string source,
        int start,
        bool allowIncomplete,
        out string value,
        out int next,
        out bool complete)
    {
        value = string.Empty;
        next = start;
        complete = false;
        if (start >= source.Length || source[start] != '"')
        {
            return false;
        }

        var builder = new StringBuilder();
        var index = start + 1;
        while (index < source.Length)
        {
            var ch = source[index++];
            if (ch == '"')
            {
                value = builder.ToString();
                next = index;
                complete = true;
                return true;
            }

            if (ch != '\\')
            {
                builder.Append(ch);
                continue;
            }

            if (index >= source.Length)
            {
                if (!allowIncomplete) return false;
                value = builder.ToString();
                next = index;
                return true;
            }

            var escaped = source[index++];
            switch (escaped)
            {
                case '"':
                case '\\':
                case '/':
                    builder.Append(escaped);
                    break;
                case 'b':
                    builder.Append('\b');
                    break;
                case 'f':
                    builder.Append('\f');
                    break;
                case 'n':
                    builder.Append('\n');
                    break;
                case 'r':
                    builder.Append('\r');
                    break;
                case 't':
                    builder.Append('\t');
                    break;
                case 'u':
                    if (index + 4 > source.Length)
                    {
                        if (!allowIncomplete) return false;
                        value = builder.ToString();
                        next = source.Length;
                        return true;
                    }
                    if (!TryReadHexChar(source, index, out var decoded))
                    {
                        return false;
                    }
                    builder.Append(decoded);
                    index += 4;
                    break;
                default:
                    if (!allowIncomplete) return false;
                    builder.Append(escaped);
                    break;
            }
        }

        if (!allowIncomplete)
        {
            return false;
        }

        value = builder.ToString();
        next = source.Length;
        return true;
    }

    private static bool TryReadHexChar(string source, int start, out char decoded)
    {
        decoded = '\0';
        var value = 0;
        for (var i = 0; i < 4; i++)
        {
            var digit = HexValue(source[start + i]);
            if (digit < 0)
            {
                return false;
            }
            value = (value << 4) | digit;
        }
        decoded = (char)value;
        return true;
    }

    private static int HexValue(char ch)
    {
        if (ch is >= '0' and <= '9') return ch - '0';
        if (ch is >= 'a' and <= 'f') return ch - 'a' + 10;
        if (ch is >= 'A' and <= 'F') return ch - 'A' + 10;
        return -1;
    }

    private static void SkipWhitespace(string source, ref int index)
    {
        while (index < source.Length && char.IsWhiteSpace(source[index]))
        {
            index++;
        }
    }

    private static bool IsValueDelimiter(char ch)
    {
        return ch == ',' || ch == '}' || char.IsWhiteSpace(ch);
    }

    private static string BuildSignature(JsonElement input)
    {
        var raw = input.GetRawText();
        unchecked
        {
            var hash = 2166136261u;
            foreach (var ch in raw)
            {
                hash ^= ch;
                hash *= 16777619u;
            }
            return $"{raw.Length}:{hash:x8}";
        }
    }
}
