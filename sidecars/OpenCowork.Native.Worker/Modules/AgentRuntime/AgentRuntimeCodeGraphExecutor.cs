using System.Buffers;
using System.Text.Json;

// Routes codegraph_* agent tools onto the source-merged CodeGraph engine in this
// same worker. The old path bounced through host reverse-request ("codegraph:tool")
// so Electron could forward to a separate sidecar; that sidecar is gone, and the
// bounce fails outright when GET /reverse is not attached.
//
// Error convention: the CodeGraph tool surface is success-shaped for expected
// conditions (not_indexed / disabled return guidance text, never a thrown error),
// so the returned `text` is always the tool content.
internal static class AgentRuntimeCodeGraphExecutor
{
    public static bool IsCodeGraphTool(string toolName)
    {
        return toolName.StartsWith("codegraph_", StringComparison.Ordinal);
    }

    public static Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        _ = context;
        _ = cancellationToken;
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder");
        var args = BuildToolArgs(call, workingFolder);
        WorkerResponse response;
        try
        {
            response = Dispatch(call.Name, args);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Task.FromResult($"CodeGraph {call.Name} failed: {ex.Message}");
        }

        return Task.FromResult(ReadToolText(response));
    }

    private static WorkerResponse Dispatch(string toolName, JsonElement args)
    {
        return toolName switch
        {
            "codegraph_explore" => CodeGraphToolHandler.ExploreRpc(args),
            "codegraph_search" => CodeGraphToolHandler.SearchRpc(args),
            "codegraph_status" => CodeGraphToolHandler.StatusRpc(args),
            "codegraph_node" => CodeGraphToolHandler.NodeRpc(args),
            "codegraph_callers" => CodeGraphToolHandler.CallersRpc(args),
            "codegraph_callees" => CodeGraphToolHandler.CalleesRpc(args),
            "codegraph_impact" => CodeGraphToolHandler.ImpactRpc(args),
            "codegraph_files" => CodeGraphToolHandler.FilesRpc(args),
            _ => WorkerResponse.Json(
                new CodeGraphToolResult(
                    true,
                    $"Unknown CodeGraph tool: {toolName}",
                    false,
                    CodeGraphErrorKind.NotIndexed),
                CodeGraphJsonContext.Default.CodeGraphToolResult)
        };
    }

    private static string ReadToolText(WorkerResponse response)
    {
        using var document = JsonDocument.Parse(response.ToResultJsonBytes());
        var result = document.RootElement;
        var text = JsonHelpers.GetString(result, "text");
        if (!string.IsNullOrEmpty(text))
        {
            return text;
        }

        var message = JsonHelpers.GetString(result, "message") ?? JsonHelpers.GetString(result, "error");
        if (!string.IsNullOrEmpty(message))
        {
            return message;
        }

        return result.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
            ? "CodeGraph returned no result."
            : result.GetRawText();
    }

    private static JsonElement BuildToolArgs(NativeToolCallView call, string? workingFolder)
    {
        var input = call.Input;
        var hasProject = input.ValueKind == JsonValueKind.Object &&
            (HasNonEmptyString(input, "projectPath") || HasNonEmptyString(input, "workingFolder"));
        if (hasProject || string.IsNullOrWhiteSpace(workingFolder))
        {
            return input.ValueKind == JsonValueKind.Object ? input.Clone() : CreateEmptyObject();
        }

        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            if (input.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in input.EnumerateObject())
                {
                    property.WriteTo(writer);
                }
            }

            writer.WriteString("workingFolder", workingFolder);
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static bool HasNonEmptyString(JsonElement source, string name)
    {
        return source.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(value.GetString());
    }

    private static JsonElement CreateEmptyObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }
}
