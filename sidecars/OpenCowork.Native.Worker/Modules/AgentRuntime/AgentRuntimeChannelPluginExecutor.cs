using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeChannelPluginExecutor
{
    private static readonly HashSet<string> ChannelPluginToolNames = new(StringComparer.Ordinal)
    {
        "FeishuSendImage",
        "FeishuSendFile",
        "FeishuListChatMembers",
        "FeishuAtMember",
        "FeishuSendUrgent",
        "FeishuBitableListApps",
        "FeishuBitableListTables",
        "FeishuBitableListFields",
        "FeishuBitableGetRecords",
        "FeishuBitableCreateRecords",
        "FeishuBitableUpdateRecords",
        "FeishuBitableDeleteRecords",
        "WeixinSendImage",
        "WeixinSendFile"
    };

    private static readonly HashSet<string> ApprovalToolNames = new(StringComparer.Ordinal)
    {
        "FeishuSendImage",
        "FeishuSendFile",
        "FeishuAtMember",
        "FeishuSendUrgent",
        "WeixinSendImage",
        "WeixinSendFile"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsChannelPluginTool(string toolName)
    {
        return ChannelPluginToolNames.Contains(toolName);
    }

    public static bool RequiresApproval(string toolName)
    {
        return ApprovalToolNames.Contains(toolName);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "FeishuSendImage" => await ExecuteFileSendAsync(
                call,
                parameters,
                context,
                "plugin:feishu:send-image",
                "FeishuSendImage",
                includeFileType: false,
                includeContent: false,
                cancellationToken),
            "FeishuSendFile" => await ExecuteFileSendAsync(
                call,
                parameters,
                context,
                "plugin:feishu:send-file",
                "FeishuSendFile",
                includeFileType: true,
                includeContent: false,
                cancellationToken),
            "WeixinSendImage" => await ExecuteFileSendAsync(
                call,
                parameters,
                context,
                "plugin:weixin:send-image",
                "WeixinSendImage",
                includeFileType: false,
                includeContent: true,
                cancellationToken),
            "WeixinSendFile" => await ExecuteFileSendAsync(
                call,
                parameters,
                context,
                "plugin:weixin:send-file",
                "WeixinSendFile",
                includeFileType: false,
                includeContent: true,
                cancellationToken),
            "FeishuListChatMembers" => await ExecuteListMembersAsync(call, parameters, context, cancellationToken),
            "FeishuAtMember" => await ExecuteAtMemberAsync(call, parameters, context, cancellationToken),
            "FeishuSendUrgent" => await ExecuteSendUrgentAsync(call, parameters, context, cancellationToken),
            "FeishuBitableListApps" => await ExecuteBitableAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:list-apps",
                cancellationToken,
                _ => { }),
            "FeishuBitableListTables" => await ExecuteBitableAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:list-tables",
                cancellationToken,
                writer => WriteRequiredString(writer, call.Input, "appToken", "app_token")),
            "FeishuBitableListFields" => await ExecuteBitableAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:list-fields",
                cancellationToken,
                writer =>
                {
                    WriteRequiredString(writer, call.Input, "appToken", "app_token");
                    WriteRequiredString(writer, call.Input, "tableId", "table_id");
                }),
            "FeishuBitableGetRecords" => await ExecuteBitableAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:get-records",
                cancellationToken,
                writer =>
                {
                    WriteRequiredString(writer, call.Input, "appToken", "app_token");
                    WriteRequiredString(writer, call.Input, "tableId", "table_id");
                    WriteOptionalString(writer, call.Input, "filter", "filter");
                    WriteOptionalInt(writer, call.Input, "pageSize", "page_size");
                    WriteOptionalString(writer, call.Input, "pageToken", "page_token");
                }),
            "FeishuBitableCreateRecords" => await ExecuteBitableMutationAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:create-records",
                "records",
                cancellationToken),
            "FeishuBitableUpdateRecords" => await ExecuteBitableMutationAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:update-records",
                "records",
                cancellationToken),
            "FeishuBitableDeleteRecords" => await ExecuteBitableMutationAsync(
                call,
                parameters,
                context,
                "plugin:feishu:bitable:delete-records",
                "record_ids",
                cancellationToken),
            _ => EncodeError($"Unsupported channel plugin tool: {call.Name}")
        };
    }

    private static async Task<string> ExecuteFileSendAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        string channel,
        string failurePrefix,
        bool includeFileType,
        bool includeContent,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, parameters);
        var chatId = JsonHelpers.GetString(call.Input, "chat_id")?.Trim() ?? string.Empty;
        var filePath = JsonHelpers.GetString(call.Input, "file_path")?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(pluginId) ||
            string.IsNullOrWhiteSpace(chatId) ||
            string.IsNullOrWhiteSpace(filePath))
        {
            return EncodeError("plugin_id, chat_id and file_path are required");
        }

        return await InvokeToolAsync(
            context,
            channel,
            call.Name,
            failurePrefix,
            writer =>
            {
                writer.WriteString("pluginId", pluginId);
                writer.WriteString("chatId", chatId);
                writer.WriteString("filePath", filePath);
                if (includeFileType)
                {
                    WriteOptionalString(writer, call.Input, "fileType", "file_type");
                }
                if (includeContent)
                {
                    WriteOptionalString(writer, call.Input, "content", "content");
                }
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteListMembersAsync(
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

        return await InvokeToolAsync(
            context,
            "plugin:feishu:list-members",
            call.Name,
            null,
            writer =>
            {
                writer.WriteString("pluginId", pluginId);
                writer.WriteString("chatId", chatId);
                WriteOptionalString(writer, call.Input, "pageToken", "page_token");
                WriteOptionalInt(writer, call.Input, "pageSize", "page_size");
                WriteOptionalString(writer, call.Input, "memberIdType", "member_id_type");
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteAtMemberAsync(
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
        var text = JsonHelpers.GetString(call.Input, "text")?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(pluginId) || string.IsNullOrWhiteSpace(chatId) || text.Length == 0)
        {
            return EncodeError("plugin_id, chat_id and text are required");
        }

        var userIds = JsonHelpers.GetStringArray(call.Input, "user_ids");
        if (userIds.Length == 0 && JsonHelpers.GetString(parameters, "pluginSenderId") is { Length: > 0 } senderId)
        {
            userIds = [senderId];
        }

        return await InvokeToolAsync(
            context,
            "plugin:feishu:send-mention",
            call.Name,
            "FeishuAtMember",
            writer =>
            {
                writer.WriteString("pluginId", pluginId);
                writer.WriteString("chatId", chatId);
                writer.WriteStartArray("userIds");
                foreach (var userId in userIds)
                {
                    writer.WriteStringValue(userId);
                }
                writer.WriteEndArray();
                writer.WriteBoolean("atAll", JsonHelpers.GetBool(call.Input, "at_all", false));
                writer.WriteString("text", text);
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteSendUrgentAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, parameters);
        var messageId = JsonHelpers.GetString(call.Input, "message_id")?.Trim() ?? string.Empty;
        var userIds = JsonHelpers.GetStringArray(call.Input, "user_ids");
        var urgentTypes = JsonHelpers.GetStringArray(call.Input, "urgent_types")
            .Where(item => item is "app" or "sms")
            .ToArray();
        if (string.IsNullOrWhiteSpace(pluginId) ||
            string.IsNullOrWhiteSpace(messageId) ||
            userIds.Length == 0 ||
            urgentTypes.Length == 0)
        {
            return EncodeError("plugin_id, message_id, user_ids and urgent_types are required");
        }

        return await InvokeToolAsync(
            context,
            "plugin:feishu:send-urgent",
            call.Name,
            "FeishuSendUrgent",
            writer =>
            {
                writer.WriteString("pluginId", pluginId);
                writer.WriteString("messageId", messageId);
                writer.WriteStartArray("userIds");
                foreach (var userId in userIds)
                {
                    writer.WriteStringValue(userId);
                }
                writer.WriteEndArray();
                writer.WriteStartArray("urgentTypes");
                foreach (var urgentType in urgentTypes)
                {
                    writer.WriteStringValue(urgentType);
                }
                writer.WriteEndArray();
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteBitableAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        string channel,
        CancellationToken cancellationToken,
        Action<Utf8JsonWriter> writeExtraProperties)
    {
        var pluginId = ReadPluginId(call.Input, parameters);
        if (string.IsNullOrWhiteSpace(pluginId))
        {
            return EncodeError("plugin_id is required");
        }

        return await InvokeToolAsync(
            context,
            channel,
            call.Name,
            null,
            writer =>
            {
                writer.WriteString("pluginId", pluginId);
                writeExtraProperties(writer);
            },
            cancellationToken);
    }

    private static async Task<string> ExecuteBitableMutationAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        string channel,
        string arrayInputName,
        CancellationToken cancellationToken)
    {
        var pluginId = ReadPluginId(call.Input, parameters);
        if (string.IsNullOrWhiteSpace(pluginId))
        {
            return EncodeError("plugin_id is required");
        }
        if (!call.Input.TryGetProperty(arrayInputName, out var arrayValue) ||
            arrayValue.ValueKind != JsonValueKind.Array)
        {
            return EncodeError($"{arrayInputName} must be an array");
        }

        return await InvokeToolAsync(
            context,
            channel,
            call.Name,
            null,
            writer =>
            {
                writer.WriteString("pluginId", pluginId);
                WriteRequiredString(writer, call.Input, "appToken", "app_token");
                WriteRequiredString(writer, call.Input, "tableId", "table_id");
                if (arrayInputName == "record_ids")
                {
                    writer.WritePropertyName("recordIds");
                }
                else
                {
                    writer.WritePropertyName("records");
                }
                arrayValue.WriteTo(writer);
            },
            cancellationToken);
    }

    private static async Task<string> InvokeToolAsync(
        WorkerRequestContext context,
        string channel,
        string toolName,
        string? failurePrefix,
        Action<Utf8JsonWriter> writeProperties,
        CancellationToken cancellationToken)
    {
        var response = await AgentRuntimeReverseRequests.RequestAsync(
            context,
            channel,
            CreateJsonObject(writer =>
            {
                writer.WriteString("toolName", toolName);
                writeProperties(writer);
            }),
            cancellationToken);

        if (TryReadError(response, out var error))
        {
            return EncodeError(failurePrefix is { Length: > 0 }
                ? $"{failurePrefix} failed: {error}"
                : error);
        }

        return response.GetRawText();
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

    private static void WriteRequiredString(
        Utf8JsonWriter writer,
        JsonElement input,
        string outputName,
        string inputName)
    {
        writer.WriteString(outputName, JsonHelpers.GetString(input, inputName)?.Trim() ?? string.Empty);
    }

    private static void WriteOptionalString(
        Utf8JsonWriter writer,
        JsonElement input,
        string outputName,
        string inputName)
    {
        var value = JsonHelpers.GetString(input, inputName);
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(outputName, value);
        }
    }

    private static void WriteOptionalInt(
        Utf8JsonWriter writer,
        JsonElement input,
        string outputName,
        string inputName)
    {
        if (JsonHelpers.GetIntNullable(input, inputName) is { } value)
        {
            writer.WriteNumber(outputName, value);
        }
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
