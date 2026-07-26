using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeCanvasExecutor
{
    private static readonly HashSet<string> CanvasToolNames = new(StringComparer.Ordinal)
    {
        "read_canvas",
        "get_node_status",
        "subscribe_node",
        "wait_for_node_event",
        "create_node",
        "update_node",
        "delete_nodes",
        "duplicate_nodes",
        "connect_nodes",
        "disconnect_nodes",
        "move_nodes",
        "resize_node",
        "select_nodes",
        "run_node",
        "retry_node",
        "cancel_node",
        "generate_media",
        "generate_video",
        "edit_image",
        "media_action",
        "create_trigger",
        "delete_trigger",
        "manage_canvas"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool CanExecute(string toolName, JsonElement parameters)
    {
        return CanvasToolNames.Contains(toolName) && TryGetProjectId(parameters, out _);
    }

    public static bool RequiresApproval(string toolName, JsonElement input)
    {
        if (toolName is "delete_nodes" or "cancel_node")
        {
            return true;
        }
        if (!string.Equals(toolName, "manage_canvas", StringComparison.Ordinal))
        {
            return false;
        }
        return JsonHelpers.GetString(input, "action") is
            "clear_canvas" or "import_canvas" or "replace_canvas" or "delete_project";
    }

    public static async Task<RendererToolResult> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        if (!TryGetProjectId(parameters, out var projectId))
        {
            return Error("Canvas context is missing a project id");
        }

        try
        {
            var result = await AgentRuntimeReverseRequests.RequestAsync(
                context,
                "canvas/tool-request",
                CreateRequest(call, parameters, runId, projectId),
                cancellationToken);
            return ParseResult(result);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Error(ex.Message);
        }
    }

    private static bool TryGetProjectId(JsonElement parameters, out string projectId)
    {
        projectId = string.Empty;
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("canvasContext", out var context) ||
            context.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        projectId = JsonHelpers.GetString(context, "projectId")?.Trim() ?? string.Empty;
        return projectId.Length > 0;
    }

    private static JsonElement CreateRequest(
        NativeToolCallView call,
        JsonElement parameters,
        string runId,
        string projectId)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("runId", runId);
            writer.WriteString("agentRunId", runId);
            writer.WriteString("projectId", projectId);
            writer.WriteString("toolUseId", call.Id);
            writer.WriteString("toolName", call.Name);
            WriteOptionalString(writer, "sessionId", JsonHelpers.GetString(parameters, "sessionId"));
            WriteOptionalString(
                writer,
                "workingFolder",
                JsonHelpers.GetString(parameters, "workingFolder"));
            writer.WritePropertyName("input");
            call.Input.WriteTo(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static RendererToolResult ParseResult(JsonElement result)
    {
        if (result.ValueKind != JsonValueKind.Object)
        {
            return new RendererToolResult(result.Clone(), false, null);
        }
        var content = result.TryGetProperty("content", out var contentElement)
            ? contentElement.Clone()
            : AgentRuntimeProviderSupport.CreateStringElement(string.Empty);
        var error = JsonHelpers.GetString(result, "error");
        var isError = JsonHelpers.GetBool(result, "isError", false) ||
            !string.IsNullOrWhiteSpace(error);
        return new RendererToolResult(content, isError, error);
    }

    private static RendererToolResult Error(string message)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            writer.WriteEndObject();
        }
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(Encoding.UTF8.GetString(stream.ToArray())),
            true,
            message);
    }

    private static void WriteOptionalString(Utf8JsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value)) writer.WriteString(name, value);
    }
}
