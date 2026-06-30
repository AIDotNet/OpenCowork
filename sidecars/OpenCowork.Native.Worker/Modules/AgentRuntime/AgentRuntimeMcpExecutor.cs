using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeMcpExecutor
{
    private const string McpToolPrefix = "mcp__";
    private const string ResourcePrefix = "resource__";

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsMcpTool(string toolName)
    {
        return toolName.StartsWith(McpToolPrefix, StringComparison.Ordinal);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var parsed = ParseToolName(call.Name);
        if (parsed is null)
        {
            return EncodeError($"Invalid MCP tool name: {call.Name}");
        }

        var method = parsed.Value.IsResource ? "mcp:read-resource" : "mcp:call-tool";
        var request = parsed.Value.IsResource
            ? CreateReadResourceRequest(parsed.Value.ServerId, parsed.Value.Name)
            : CreateCallToolRequest(parsed.Value.ServerId, parsed.Value.Name, call.Input);

        try
        {
            var response = await AgentRuntimeReverseRequests.RequestAsync(
                context,
                method,
                request,
                cancellationToken);

            if (!JsonHelpers.GetBool(response, "success", false))
            {
                return EncodeError(JsonHelpers.GetString(response, "error") ?? "MCP request failed");
            }

            return response.ValueKind == JsonValueKind.Object &&
                response.TryGetProperty("result", out var result)
                    ? result.GetRawText()
                    : "null";
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return EncodeError(ex.Message);
        }
    }

    private static McpToolName? ParseToolName(string toolName)
    {
        if (!toolName.StartsWith(McpToolPrefix, StringComparison.Ordinal))
        {
            return null;
        }

        var rest = toolName[McpToolPrefix.Length..];
        var separatorIndex = rest.IndexOf("__", StringComparison.Ordinal);
        if (separatorIndex <= 0 || separatorIndex + 2 >= rest.Length)
        {
            return null;
        }

        var serverId = rest[..separatorIndex];
        var name = rest[(separatorIndex + 2)..];
        if (name.StartsWith(ResourcePrefix, StringComparison.Ordinal))
        {
            var resourceName = name[ResourcePrefix.Length..];
            return resourceName.Length == 0 ? null : new McpToolName(serverId, resourceName, true);
        }

        return name.Length == 0 ? null : new McpToolName(serverId, name, false);
    }

    private static JsonElement CreateCallToolRequest(
        string serverId,
        string toolName,
        JsonElement args)
    {
        return CreateJsonObject(writer =>
        {
            writer.WriteString("serverId", serverId);
            writer.WriteString("toolName", toolName);
            writer.WritePropertyName("args");
            args.WriteTo(writer);
        });
    }

    private static JsonElement CreateReadResourceRequest(string serverId, string resourceName)
    {
        return CreateJsonObject(writer =>
        {
            writer.WriteString("serverId", serverId);
            writer.WriteString("resourceName", resourceName);
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

    private static string EncodeError(string message)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private readonly record struct McpToolName(string ServerId, string Name, bool IsResource);
}
