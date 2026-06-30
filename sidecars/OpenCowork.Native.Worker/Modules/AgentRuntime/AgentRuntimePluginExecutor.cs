using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimePluginExecutor
{
    private static readonly HashSet<string> PluginToolNames = new(StringComparer.Ordinal)
    {
        "PluginSendMessage",
        "PluginReplyMessage",
        "PluginGetGroupMessages",
        "PluginListGroups",
        "PluginSummarizeGroup",
        "PluginGetCurrentChatMessages"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsPluginTool(string toolName)
    {
        return PluginToolNames.Contains(toolName);
    }

    public static bool RequiresApproval(string toolName)
    {
        return toolName is "PluginSendMessage" or "PluginReplyMessage";
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "PluginSendMessage" => await ExecuteSendMessageAsync(call, parameters, runId, context, cancellationToken),
            "PluginReplyMessage" => await ExecuteReplyMessageAsync(call, context, cancellationToken),
            "PluginGetGroupMessages" => await ExecuteGetGroupMessagesAsync(call, context, 20, cancellationToken),
            "PluginListGroups" => await ExecuteListGroupsAsync(call, context, cancellationToken),
            "PluginSummarizeGroup" => await ExecuteGetGroupMessagesAsync(call, context, 50, cancellationToken),
            "PluginGetCurrentChatMessages" => await ExecuteGetCurrentChatMessagesAsync(
                call,
                parameters,
                context,
                cancellationToken),
            _ => EncodeError($"Unsupported plugin tool: {call.Name}")
        };
    }

    private static async Task<string> ExecuteSendMessageAsync(
        NativeToolCallView call,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
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
        if (isCronAgent)
        {
            AgentRuntimeDeliveryGuard.MarkUsed(runId);
        }

        var pluginId = ReadPluginId(call.Input, parameters);
        var chatId = JsonHelpers.GetString(call.Input, "chat_id")?.Trim();
        var content = JsonHelpers.GetString(call.Input, "content");
        if (string.IsNullOrWhiteSpace(pluginId) ||
            string.IsNullOrWhiteSpace(chatId) ||
            string.IsNullOrEmpty(content))
        {
            return EncodeError("plugin_id, chat_id and content are required");
        }

        return await InvokePluginExecAsync(
            context,
            pluginId,
            "sendMessage",
            "PluginSendMessage",
            writer =>
            {
                writer.WriteString("chatId", chatId);
                writer.WriteString("content", content);
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteReplyMessageAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, default);
        var messageId = JsonHelpers.GetString(call.Input, "message_id")?.Trim();
        var content = JsonHelpers.GetString(call.Input, "content");
        if (string.IsNullOrWhiteSpace(pluginId) ||
            string.IsNullOrWhiteSpace(messageId) ||
            string.IsNullOrEmpty(content))
        {
            return EncodeError("plugin_id, message_id and content are required");
        }

        return await InvokePluginExecAsync(
            context,
            pluginId,
            "replyMessage",
            "PluginReplyMessage",
            writer =>
            {
                writer.WriteString("messageId", messageId);
                writer.WriteString("content", content);
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteGetGroupMessagesAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        int defaultCount,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, default);
        var chatId = JsonHelpers.GetString(call.Input, "chat_id")?.Trim();
        if (string.IsNullOrWhiteSpace(pluginId) || string.IsNullOrWhiteSpace(chatId))
        {
            return EncodeError("plugin_id and chat_id are required");
        }

        var count = JsonHelpers.GetInt(call.Input, "count", defaultCount);
        return await InvokePluginExecAsync(
            context,
            pluginId,
            "getGroupMessages",
            call.Name,
            writer =>
            {
                writer.WriteString("chatId", chatId);
                writer.WriteNumber("count", count);
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteListGroupsAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, default);
        if (string.IsNullOrWhiteSpace(pluginId))
        {
            return EncodeError("Missing or invalid plugin_id. Check the active channels list.");
        }

        return await InvokePluginExecAsync(
            context,
            pluginId,
            "listGroups",
            "PluginListGroups",
            _ => { },
            cancellationToken);
    }

    private static async Task<string> ExecuteGetCurrentChatMessagesAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, parameters);
        var chatId = (JsonHelpers.GetString(call.Input, "chat_id") ??
                JsonHelpers.GetString(parameters, "pluginChatId") ??
                string.Empty)
            .Trim();
        if (string.IsNullOrWhiteSpace(pluginId) || string.IsNullOrWhiteSpace(chatId))
        {
            return EncodeError("Missing plugin_id or chat_id. Ensure you are in a channel chat session.");
        }

        var enabled = await InvokeMainAsync(
            context,
            "plugin:tool-enabled",
            CreatePluginEnabledRequest(pluginId, "PluginGetCurrentChatMessages"),
            cancellationToken);
        if (TryReadError(enabled, out var enabledError))
        {
            return EncodeError(enabledError);
        }
        if (!JsonHelpers.GetBool(enabled, "enabled", true))
        {
            return EncodeError("Tool \"PluginGetCurrentChatMessages\" is disabled for this channel.");
        }

        var sessionResult = DbPluginSessionTools.FindPluginSessionRecordByChat($"plugin:{pluginId}:chat:{chatId}");
        if (!sessionResult.Success)
        {
            return EncodeError($"DB error: {sessionResult.Error ?? "failed to load channel session"}");
        }
        if (sessionResult.Session is null ||
            string.IsNullOrWhiteSpace(sessionResult.Session.Id))
        {
            return EncodeError("Channel session not found for this chat.");
        }

        var sessionId = sessionResult.Session.Id;
        var count = JsonHelpers.GetInt(call.Input, "count", 20);
        List<PluginSessionMessageRow> rows;
        try
        {
            rows = DbPluginSessionTools.ListPluginSessionMessageRecords(sessionId, count);
        }
        catch (Exception ex)
        {
            return EncodeError($"DB error: {ex.Message}");
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteString("sessionId", sessionId);
            writer.WritePropertyName("messages");
            JsonSerializer.Serialize(writer, rows, WorkerJsonContext.Default.ListPluginSessionMessageRow);
        });
    }

    private static async Task<string> InvokePluginExecAsync(
        WorkerRequestContext context,
        string pluginId,
        string action,
        string toolName,
        Action<Utf8JsonWriter> writeParams,
        CancellationToken cancellationToken)
    {
        var response = await InvokeMainAsync(
            context,
            "plugin:exec",
            CreatePluginExecRequest(pluginId, action, toolName, writeParams),
            cancellationToken);
        if (TryReadError(response, out var error))
        {
            return EncodeError($"Plugin action \"{action}\" failed: {error}");
        }
        return response.GetRawText();
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

    private static JsonElement CreatePluginExecRequest(
        string pluginId,
        string action,
        string toolName,
        Action<Utf8JsonWriter> writeParams)
    {
        return CreateJsonObject(writer =>
        {
            writer.WriteString("pluginId", pluginId);
            writer.WriteString("action", action);
            writer.WriteString("toolName", toolName);
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writeParams(writer);
            writer.WriteEndObject();
        });
    }

    private static JsonElement CreatePluginEnabledRequest(string pluginId, string toolName)
    {
        return CreateJsonObject(writer =>
        {
            writer.WriteString("pluginId", pluginId);
            writer.WriteString("toolName", toolName);
        });
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

    private static string ReadPluginId(JsonElement input, JsonElement parameters)
    {
        return (JsonHelpers.GetString(input, "plugin_id") ??
                JsonHelpers.GetString(parameters, "pluginId") ??
                string.Empty)
            .Trim();
    }

    private static bool TryReadError(JsonElement response, out string error)
    {
        error = JsonHelpers.GetString(response, "error") ?? string.Empty;
        return error.Length > 0;
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
