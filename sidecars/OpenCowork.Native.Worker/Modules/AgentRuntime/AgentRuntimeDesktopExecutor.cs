using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeDesktopExecutor
{
    private static readonly HashSet<string> DesktopToolNames = new(StringComparer.Ordinal)
    {
        "DesktopScreenshot",
        "DesktopClick",
        "DesktopType",
        "DesktopScroll",
        "DesktopWait"
    };

    private static readonly HashSet<string> AllowedButtons = new(StringComparer.Ordinal)
    {
        "left",
        "right",
        "middle"
    };

    private static readonly HashSet<string> AllowedClickActions = new(StringComparer.Ordinal)
    {
        "click",
        "double_click",
        "down",
        "up"
    };

    private static readonly HashSet<string> AllowedModifiers = new(StringComparer.Ordinal)
    {
        "Control",
        "Meta",
        "Alt",
        "Shift"
    };

    private static readonly HashSet<string> AllowedNamedKeys = new(StringComparer.Ordinal)
    {
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsDesktopTool(string toolName)
    {
        return DesktopToolNames.Contains(toolName);
    }

    public static async Task<RendererToolResult> ExecuteAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "DesktopScreenshot" => await ExecuteScreenshotAsync(call.Input, context, cancellationToken),
            "DesktopClick" => await ExecuteClickAsync(call.Input, context, cancellationToken),
            "DesktopType" => await ExecuteTypeAsync(call.Input, context, cancellationToken),
            "DesktopScroll" => await ExecuteScrollAsync(call.Input, context, cancellationToken),
            "DesktopWait" => await ExecuteWaitAsync(call.Input, cancellationToken),
            _ => StringResult(EncodeError($"Unsupported desktop tool: {call.Name}"), true)
        };
    }

    private static async Task<RendererToolResult> ExecuteScreenshotAsync(
        JsonElement input,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var delayMs = Math.Clamp(JsonHelpers.GetInt(input, "delayMs", 0), 0, 5_000);
        if (delayMs > 0)
        {
            await Task.Delay(delayMs, cancellationToken);
        }

        var response = await InvokeMainAsync(
            context,
            "desktop:screenshot:capture",
            CreateJsonObject(_ => { }),
            cancellationToken);

        var data = JsonHelpers.GetString(response, "data");
        if (!JsonHelpers.GetBool(response, "success", false) || string.IsNullOrEmpty(data))
        {
            return StringResult(
                EncodeError(JsonHelpers.GetString(response, "error") ?? "Failed to capture desktop screenshot."),
                true);
        }

        return new RendererToolResult(CreateScreenshotContent(response, data), false, null);
    }

    private static async Task<RendererToolResult> ExecuteClickAsync(
        JsonElement input,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var x = JsonHelpers.GetDoubleNullable(input, "x");
        var y = JsonHelpers.GetDoubleNullable(input, "y");
        var button = JsonHelpers.GetString(input, "button") ?? "left";
        var action = JsonHelpers.GetString(input, "action") ?? "click";

        if (!x.HasValue || !y.HasValue)
        {
            return StringResult(EncodeError("DesktopClick requires numeric x and y coordinates."), true);
        }
        if (!AllowedButtons.Contains(button))
        {
            return StringResult(EncodeError($"Unsupported button: {button}."), true);
        }
        if (!AllowedClickActions.Contains(action))
        {
            return StringResult(EncodeError($"Unsupported action: {action}."), true);
        }

        var response = await InvokeMainAsync(
            context,
            "desktop:input:click",
            CreateJsonObject(writer =>
            {
                writer.WriteNumber("x", x.Value);
                writer.WriteNumber("y", y.Value);
                writer.WriteString("button", button);
                writer.WriteString("action", action);
            }),
            cancellationToken);

        if (!JsonHelpers.GetBool(response, "success", false))
        {
            return StringResult(
                EncodeError(JsonHelpers.GetString(response, "error") ?? "Desktop click failed."),
                true);
        }

        var resultX = JsonHelpers.GetDoubleNullable(response, "x") ?? x.Value;
        var resultY = JsonHelpers.GetDoubleNullable(response, "y") ?? y.Value;
        var resultButton = JsonHelpers.GetString(response, "button") ?? button;
        var resultAction = JsonHelpers.GetString(response, "action") ?? action;
        return StringResult(EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteNumber("x", resultX);
            writer.WriteNumber("y", resultY);
            writer.WriteString("button", resultButton);
            writer.WriteString("action", resultAction);
            writer.WriteString(
                "message",
                $"Desktop {resultAction} executed at ({resultX}, {resultY}) with {resultButton} button.");
        }));
    }

    private static async Task<RendererToolResult> ExecuteTypeAsync(
        JsonElement input,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var text = JsonHelpers.GetString(input, "text");
        var key = JsonHelpers.GetString(input, "key");
        var hotkey = ReadStringArray(input, "hotkey");
        var providedCount = (!string.IsNullOrEmpty(text) ? 1 : 0) +
            (!string.IsNullOrEmpty(key) ? 1 : 0) +
            (hotkey.Count > 0 ? 1 : 0);

        if (providedCount != 1)
        {
            return StringResult(EncodeError("DesktopType requires exactly one of: text, key, or hotkey."), true);
        }
        if (!string.IsNullOrEmpty(key) && !AllowedNamedKeys.Contains(key) && !IsSupportedSingleKey(key))
        {
            return StringResult(EncodeError($"Unsupported key: {key}."), true);
        }
        if (hotkey.Count > 0)
        {
            if (hotkey.Count < 2)
            {
                return StringResult(
                    EncodeError("DesktopType hotkey must include at least one modifier and one key."),
                    true);
            }
            var modifiers = hotkey.Take(hotkey.Count - 1).ToArray();
            if (modifiers.Any(item => !AllowedModifiers.Contains(item)))
            {
                return StringResult(
                    EncodeError($"DesktopType hotkey modifiers must be one of: {string.Join(", ", AllowedModifiers)}."),
                    true);
            }
            if (string.IsNullOrEmpty(hotkey[^1]))
            {
                return StringResult(EncodeError("DesktopType hotkey requires a trailing key."), true);
            }
        }

        var response = await InvokeMainAsync(
            context,
            "desktop:input:type",
            CreateJsonObject(writer =>
            {
                WriteNullableString(writer, "text", text);
                WriteNullableString(writer, "key", key);
                writer.WritePropertyName("hotkey");
                if (hotkey.Count == 0)
                {
                    writer.WriteNullValue();
                }
                else
                {
                    writer.WriteStartArray();
                    foreach (var item in hotkey)
                    {
                        writer.WriteStringValue(item);
                    }
                    writer.WriteEndArray();
                }
            }),
            cancellationToken);

        if (!JsonHelpers.GetBool(response, "success", false))
        {
            return StringResult(
                EncodeError(JsonHelpers.GetString(response, "error") ?? "Desktop typing failed."),
                true);
        }

        var mode = JsonHelpers.GetString(response, "mode") ?? string.Empty;
        var textLength = JsonHelpers.GetInt(response, "textLength", text?.Length ?? 0);
        var resultKey = JsonHelpers.GetString(response, "key") ?? key;
        var resultHotkey = ReadStringArray(response, "hotkey");
        return StringResult(EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("mode", mode);
            writer.WriteNumber("textLength", textLength);
            WriteNullableString(writer, "key", resultKey);
            writer.WritePropertyName("hotkey");
            WriteStringArrayOrNull(writer, resultHotkey.Count > 0 ? resultHotkey : hotkey);
            writer.WriteString("message", BuildTypeMessage(mode, textLength, resultKey, resultHotkey, hotkey));
        }));
    }

    private static async Task<RendererToolResult> ExecuteScrollAsync(
        JsonElement input,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var x = JsonHelpers.GetDoubleNullable(input, "x");
        var y = JsonHelpers.GetDoubleNullable(input, "y");
        var scrollX = JsonHelpers.GetDoubleNullable(input, "scrollX") ?? 0;
        var scrollY = JsonHelpers.GetDoubleNullable(input, "scrollY") ?? 0;

        if ((x.HasValue && !y.HasValue) || (!x.HasValue && y.HasValue))
        {
            return StringResult(
                EncodeError("DesktopScroll requires both x and y when specifying a scroll anchor."),
                true);
        }

        var response = await InvokeMainAsync(
            context,
            "desktop:input:scroll",
            CreateJsonObject(writer =>
            {
                if (x.HasValue)
                {
                    writer.WriteNumber("x", x.Value);
                }
                else
                {
                    writer.WriteNull("x");
                }
                if (y.HasValue)
                {
                    writer.WriteNumber("y", y.Value);
                }
                else
                {
                    writer.WriteNull("y");
                }
                writer.WriteNumber("scrollX", scrollX);
                writer.WriteNumber("scrollY", scrollY);
            }),
            cancellationToken);

        if (!JsonHelpers.GetBool(response, "success", false))
        {
            return StringResult(
                EncodeError(JsonHelpers.GetString(response, "error") ?? "Desktop scroll failed."),
                true);
        }

        var resultX = JsonHelpers.GetDoubleNullable(response, "x");
        var resultY = JsonHelpers.GetDoubleNullable(response, "y");
        var resultScrollX = JsonHelpers.GetDoubleNullable(response, "scrollX") ?? scrollX;
        var resultScrollY = JsonHelpers.GetDoubleNullable(response, "scrollY") ?? scrollY;
        return StringResult(EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            WriteOptionalNumber(writer, "x", resultX);
            WriteOptionalNumber(writer, "y", resultY);
            writer.WriteNumber("scrollX", resultScrollX);
            writer.WriteNumber("scrollY", resultScrollY);
            writer.WriteString(
                "message",
                resultX.HasValue && resultY.HasValue
                    ? $"Desktop scroll executed at ({resultX}, {resultY}) with delta ({resultScrollX}, {resultScrollY})."
                    : $"Desktop scroll executed with delta ({resultScrollX}, {resultScrollY}).");
        }));
    }

    private static async Task<RendererToolResult> ExecuteWaitAsync(
        JsonElement input,
        CancellationToken cancellationToken)
    {
        var delayMs = JsonHelpers.GetDoubleNullable(input, "delayMs") ?? 2_000;
        if (double.IsNaN(delayMs) || double.IsInfinity(delayMs) || delayMs < 0)
        {
            return StringResult(EncodeError("DesktopWait requires a non-negative numeric delayMs."), true);
        }

        var boundedDelayMs = (int)Math.Min(delayMs, 10_000);
        if (boundedDelayMs > 0)
        {
            await Task.Delay(boundedDelayMs, cancellationToken);
        }

        return StringResult(EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteNumber("delayMs", boundedDelayMs);
            writer.WriteString("message", $"Desktop wait completed after {boundedDelayMs}ms.");
        }));
    }

    private static async Task<JsonElement> InvokeMainAsync(
        WorkerRequestContext context,
        string method,
        JsonElement request,
        CancellationToken cancellationToken)
    {
        return await AgentRuntimeReverseRequests.RequestAsync(
            context,
            method,
            request,
            cancellationToken);
    }

    private static JsonElement CreateJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static JsonElement CreateScreenshotContent(JsonElement response, string data)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartArray();
            writer.WriteStartObject();
            writer.WriteString("type", "image");
            writer.WritePropertyName("source");
            writer.WriteStartObject();
            writer.WriteString("type", "base64");
            writer.WriteString("mediaType", JsonHelpers.GetString(response, "mediaType") ?? "image/png");
            writer.WriteString("data", data);
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString(
                "text",
                $"Captured desktop screenshot {JsonHelpers.GetInt(response, "width", 0)}x{JsonHelpers.GetInt(response, "height", 0)} across {JsonHelpers.GetInt(response, "displayCount", 1)} display(s).");
            writer.WriteEndObject();
            writer.WriteEndArray();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static RendererToolResult StringResult(string content, bool isError = false)
    {
        return new RendererToolResult(AgentRuntimeProviderSupport.CreateStringElement(content), isError, null);
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

    private static bool IsSupportedSingleKey(string value)
    {
        if (value.Length == 1 && char.IsLetterOrDigit(value[0]))
        {
            return true;
        }
        if (value.Length is 2 or 3 &&
            value[0] == 'F' &&
            int.TryParse(value[1..], out var functionKey))
        {
            return functionKey is >= 1 and <= 12;
        }
        return false;
    }

    private static List<string> ReadStringArray(JsonElement input, string name)
    {
        if (input.ValueKind != JsonValueKind.Object ||
            !input.TryGetProperty(name, out var property) ||
            property.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<string>();
        foreach (var item in property.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { } value)
            {
                result.Add(value);
            }
        }
        return result;
    }

    private static string BuildTypeMessage(
        string mode,
        int textLength,
        string? key,
        IReadOnlyList<string> resultHotkey,
        IReadOnlyList<string> fallbackHotkey)
    {
        return mode switch
        {
            "text" => $"Typed {textLength} characters into the desktop target.",
            "key" => $"Pressed key {key}.",
            _ => $"Pressed hotkey {string.Join(" + ", resultHotkey.Count > 0 ? resultHotkey : fallbackHotkey)}."
        };
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, value);
        }
    }

    private static void WriteOptionalNumber(Utf8JsonWriter writer, string name, double? value)
    {
        if (value.HasValue)
        {
            writer.WriteNumber(name, value.Value);
        }
    }

    private static void WriteStringArrayOrNull(Utf8JsonWriter writer, IReadOnlyList<string> values)
    {
        if (values.Count == 0)
        {
            writer.WriteNullValue();
            return;
        }

        writer.WriteStartArray();
        foreach (var value in values)
        {
            writer.WriteStringValue(value);
        }
        writer.WriteEndArray();
    }
}
