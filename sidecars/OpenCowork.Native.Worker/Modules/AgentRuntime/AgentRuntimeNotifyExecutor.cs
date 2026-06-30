using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeNotifyExecutor
{
    private const string NotifyToolName = "Notify";
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsNotifyTool(string toolName)
    {
        return string.Equals(toolName, NotifyToolName, StringComparison.Ordinal);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var title = JsonHelpers.GetString(call.Input, "title")?.Trim() ?? string.Empty;
        var body = JsonHelpers.GetString(call.Input, "body")?.Trim() ?? string.Empty;
        var type = NormalizeType(JsonHelpers.GetString(call.Input, "type"));
        var duration = Math.Max(0, JsonHelpers.GetInt(call.Input, "duration", 5000));

        if (title.Length == 0 || body.Length == 0)
        {
            return EncodeError("title and body are required");
        }

        var callerAgent = JsonHelpers.GetString(parameters, "callerAgent")?.Trim();
        var isCronAgent = string.Equals(callerAgent, "CronAgent", StringComparison.Ordinal);
        if (isCronAgent && AgentRuntimeDeliveryGuard.IsUsed(runId))
        {
            return EncodeJsonObject(writer =>
            {
                writer.WriteBoolean("success", true);
                writer.WriteBoolean("skipped", true);
                writer.WriteString("reason", "Already delivered results this run. Only one delivery call is allowed.");
            });
        }

        var pluginId = JsonHelpers.GetString(parameters, "pluginId")?.Trim();
        var pluginChatId = JsonHelpers.GetString(parameters, "pluginChatId")?.Trim();
        if (isCronAgent &&
            !string.IsNullOrEmpty(pluginId) &&
            !string.IsNullOrEmpty(pluginChatId))
        {
            AgentRuntimeDeliveryGuard.MarkUsed(runId);
            try
            {
                var pluginResult = await InvokePluginSendMessageAsync(
                    context,
                    pluginId,
                    pluginChatId,
                    $"{EmojiForType(type)} {title}\n{body}",
                    cancellationToken);
                return NormalizePluginResult(pluginResult);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                WorkerLog.Warn($"notify plugin redirect failed runId={runId} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        var notificationResult = await InvokeDesktopNotificationAsync(
            context,
            title,
            body,
            type,
            duration,
            cancellationToken);

        if (JsonHelpers.GetBool(notificationResult, "success", false))
        {
            if (isCronAgent)
            {
                AgentRuntimeDeliveryGuard.MarkUsed(runId);
            }

            return EncodeJsonObject(writer =>
            {
                writer.WriteBoolean("success", true);
                writer.WriteString("title", title);
                writer.WriteString("body", Truncate(body, 200));
            });
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", false);
            writer.WriteString(
                "error",
                JsonHelpers.GetString(notificationResult, "error") ?? "Desktop notification failed.");
        });
    }

    public static void ClearRun(string runId)
    {
        AgentRuntimeDeliveryGuard.ClearRun(runId);
    }

    private static async Task<JsonElement> InvokeDesktopNotificationAsync(
        WorkerRequestContext context,
        string title,
        string body,
        string type,
        int duration,
        CancellationToken cancellationToken)
    {
        var request = CreateJsonObject(writer =>
        {
            writer.WriteString("title", title);
            writer.WriteString("body", body);
            writer.WriteString("type", type);
            writer.WriteNumber("duration", duration);
        });
        return await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "notify:desktop",
            request,
            cancellationToken);
    }

    private static async Task<JsonElement> InvokePluginSendMessageAsync(
        WorkerRequestContext context,
        string pluginId,
        string chatId,
        string content,
        CancellationToken cancellationToken)
    {
        var request = CreateJsonObject(writer =>
        {
            writer.WriteString("pluginId", pluginId);
            writer.WriteString("action", "sendMessage");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("chatId", chatId);
            writer.WriteString("content", content);
            writer.WriteEndObject();
        });
        return await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "plugin:exec",
            request,
            cancellationToken);
    }

    private static JsonElement CreateJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        var bytes = Encoding.UTF8.GetBytes(EncodeJsonObject(writeProperties));
        using var document = JsonDocument.Parse(bytes);
        return document.RootElement.Clone();
    }

    private static string NormalizePluginResult(JsonElement result)
    {
        if (result.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
        {
            return result.GetRawText();
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WritePropertyName("result");
            result.WriteTo(writer);
        });
    }

    private static string NormalizeType(string? value)
    {
        return value is "success" or "warning" or "error" ? value : "info";
    }

    private static string EmojiForType(string type)
    {
        return type switch
        {
            "success" => "✅",
            "warning" => "⚠️",
            "error" => "❌",
            _ => "ℹ️"
        };
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string Truncate(string value, int maxChars)
    {
        return value.Length <= maxChars ? value : value[..maxChars];
    }
}
