using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeWidgetExecutor
{
    private const string WidgetToolName = "visualize_show_widget";

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsWidgetTool(string toolName)
    {
        return string.Equals(toolName, WidgetToolName, StringComparison.Ordinal);
    }

    public static string Execute(NativeToolCallView call)
    {
        var title = JsonHelpers.GetString(call.Input, "title")?.Trim() ?? string.Empty;
        if (title.Length == 0)
        {
            return EncodeError("title is required");
        }

        var loadingMessages = ReadLoadingMessages(call.Input);
        if (loadingMessages.Count is < 1 or > 4)
        {
            return EncodeError("loading_messages must contain 1-4 strings");
        }

        var widgetCode = JsonHelpers.GetString(call.Input, "widget_code") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(widgetCode))
        {
            return EncodeError("widget_code is empty");
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("title", title);
            writer.WriteString("message", $"Widget \"{title}\" rendered inline");
        });
    }

    private static List<string> ReadLoadingMessages(JsonElement input)
    {
        var result = new List<string>();
        if (input.ValueKind != JsonValueKind.Object ||
            !input.TryGetProperty("loading_messages", out var messages) ||
            messages.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in messages.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var text = item.GetString()?.Trim();
            if (!string.IsNullOrEmpty(text))
            {
                result.Add(text);
            }
        }

        return result;
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }
}
