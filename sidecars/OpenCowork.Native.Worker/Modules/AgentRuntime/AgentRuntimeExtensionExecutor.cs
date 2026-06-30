using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class AgentRuntimeExtensionExecutor
{
    private const string ExtensionToolPrefix = "extension__";
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsExtensionTool(string toolName)
    {
        return toolName.StartsWith(ExtensionToolPrefix, StringComparison.Ordinal);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var parsed = ParseToolName(call.Name);
        if (parsed is null)
        {
            return EncodeError($"Invalid extension tool name: {call.Name}");
        }

        try
        {
            var extension = ExtensionManifestStore.FindExtensionOrThrow(parsed.Value.ExtensionId);
            if (!extension.Enabled)
            {
                return EncodeError($"Extension \"{parsed.Value.ExtensionId}\" is disabled");
            }

            var tool = extension.Manifest.Tools.FirstOrDefault(item =>
                string.Equals(item.Name, parsed.Value.ToolName, StringComparison.Ordinal));
            if (tool is null)
            {
                return EncodeError(
                    $"Tool \"{parsed.Value.ToolName}\" not found in extension \"{parsed.Value.ExtensionId}\"");
            }

            if (tool.Kind == "js")
            {
                return await ExecuteJavaScriptToolAsync(
                    parsed.Value.ExtensionId,
                    parsed.Value.ToolName,
                    call.Input,
                    context,
                    cancellationToken);
            }

            var response = await ExtensionHttpToolExecutor.ExecuteAsync(
                parsed.Value.ExtensionId,
                parsed.Value.ToolName,
                call.Input,
                cancellationToken);
            if (!response.Success)
            {
                return EncodeError(response.Error ?? "Extension tool failed");
            }

            return response.Content ?? string.Empty;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return EncodeError(ex.Message);
        }
    }

    private static async Task<string> ExecuteJavaScriptToolAsync(
        string extensionId,
        string toolName,
        JsonElement input,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var response = await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "extension:execute-js-tool",
            CreateJavaScriptToolRequest(extensionId, toolName, input),
            cancellationToken);

        var success = response.ValueKind == JsonValueKind.Object &&
            response.TryGetProperty("success", out var successElement) &&
            successElement.ValueKind == JsonValueKind.True;
        if (!success)
        {
            var error = JsonHelpers.GetString(response, "error") ?? "Extension JavaScript tool failed";
            return EncodeError(error);
        }

        return JsonHelpers.GetString(response, "content") ?? string.Empty;
    }

    private static JsonElement CreateJavaScriptToolRequest(
        string extensionId,
        string toolName,
        JsonElement input)
    {
        var request = new JsonObject
        {
            ["extensionId"] = extensionId,
            ["toolName"] = toolName,
            ["input"] = JsonNode.Parse(input.GetRawText()) ?? new JsonObject()
        };

        using var document = JsonDocument.Parse(request.ToJsonString());
        return document.RootElement.Clone();
    }

    private static ExtensionToolName? ParseToolName(string toolName)
    {
        if (!toolName.StartsWith(ExtensionToolPrefix, StringComparison.Ordinal))
        {
            return null;
        }

        var rest = toolName[ExtensionToolPrefix.Length..];
        var separatorIndex = rest.IndexOf("__", StringComparison.Ordinal);
        if (separatorIndex <= 0 || separatorIndex + 2 >= rest.Length)
        {
            return null;
        }

        var extensionId = rest[..separatorIndex];
        var tool = rest[(separatorIndex + 2)..];
        return string.IsNullOrWhiteSpace(extensionId) || string.IsNullOrWhiteSpace(tool)
            ? null
            : new ExtensionToolName(extensionId, tool);
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

    private readonly record struct ExtensionToolName(string ExtensionId, string ToolName);
}
