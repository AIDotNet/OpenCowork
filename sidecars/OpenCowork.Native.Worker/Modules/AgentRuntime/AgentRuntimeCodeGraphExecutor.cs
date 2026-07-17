using System.Buffers;
using System.Text.Json;

// Routes codegraph_* agent tools (codegraph_explore, and later search/callers/...)
// to the OPT-IN CodeGraph sidecar. The main worker has no direct client to that
// sidecar's socket — the Electron main process owns it — so execution goes over the
// reverse-request channel ("codegraph:tool"), where the host applies the enabled
// gate and forwards to getCodeGraphWorker().request('codegraph/<tool>', args).
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

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder");
        var payload = BuildPayload(call, workingFolder);
        var result = await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "codegraph:tool",
            payload,
            cancellationToken);

        // The host resolves with the CodeGraph worker's CodeGraphToolResult
        // ({ success, text, isError, errorKind? }) or a success-shaped fallback.
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

    private static JsonElement BuildPayload(NativeToolCallView call, string? workingFolder)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("name", call.Name);
            writer.WritePropertyName("input");
            call.Input.WriteTo(writer);
            if (!string.IsNullOrWhiteSpace(workingFolder))
            {
                writer.WriteString("workingFolder", workingFolder);
            }
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }
}
