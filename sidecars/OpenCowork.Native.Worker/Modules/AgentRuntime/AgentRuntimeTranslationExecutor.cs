using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeTranslationExecutor
{
    private static readonly HashSet<string> ToolNames = new(StringComparer.Ordinal)
    {
        "Write",
        "Edit",
        "Read",
        "FileRead"
    };

    private static readonly Dictionary<string, string> BuffersByRun = new(StringComparer.Ordinal);

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsTranslationTool(string toolName)
    {
        return ToolNames.Contains(toolName);
    }

    public static bool CanExecute(string toolName, JsonElement parameters)
    {
        return IsTranslationTool(toolName) && IsTranslationRun(parameters);
    }

    public static async Task<RendererToolResult> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "Write" => await ExecuteWriteAsync(call.Input, state, context, cancellationToken),
            "Edit" => await ExecuteEditAsync(call.Input, state, context, cancellationToken),
            "Read" => StringResult(ReadBuffer(state.RunId).Length == 0 ? "(buffer is empty)" : ReadBuffer(state.RunId)),
            "FileRead" => await ExecuteFileReadAsync(call.Input, cancellationToken),
            _ => ErrorResult($"Unsupported translation tool: {call.Name}")
        };
    }

    public static void ClearRun(string runId)
    {
        lock (BuffersByRun)
        {
            BuffersByRun.Remove(runId);
        }
    }

    private static bool IsTranslationRun(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("translation", out var translation) &&
            JsonHelpers.GetBool(translation, "enabled", false);
    }

    private static async Task<RendererToolResult> ExecuteWriteAsync(
        JsonElement input,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var content = JsonHelpers.GetString(input, "content") ?? string.Empty;
        var existing = ReadBuffer(state.RunId);
        var existingLength = existing.Trim().Length;
        var nextLength = content.Trim().Length;
        if (existingLength > 0)
        {
            var veryShortComparedToBuffer =
                nextLength > 0 && nextLength <= Math.Max(24, existingLength * 12 / 100);
            if (veryShortComparedToBuffer && IsLikelyCompletionStatus(content))
            {
                return ErrorResult(
                    "Write must contain full translated text, not completion/status text. " +
                    "Keep current buffer and finish with TRANSLATION_DONE without tool calls.");
            }
        }

        SetBuffer(state.RunId, content);
        await EmitBufferUpdateAsync(state, context, content, cancellationToken);
        return StringResult(EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("ok", true);
            writer.WriteNumber("length", content.Length);
        }));
    }

    private static async Task<RendererToolResult> ExecuteEditAsync(
        JsonElement input,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var oldString = JsonHelpers.GetString(input, "old_string") ?? string.Empty;
        var newString = JsonHelpers.GetString(input, "new_string") ?? string.Empty;
        if (oldString.Length == 0)
        {
            return ErrorResult("old_string is required");
        }

        var current = ReadBuffer(state.RunId);
        var index = current.IndexOf(oldString, StringComparison.Ordinal);
        if (index < 0)
        {
            return ErrorResult("old_string not found in buffer");
        }

        var next = current.Remove(index, oldString.Length).Insert(index, newString);
        SetBuffer(state.RunId, next);
        await EmitBufferUpdateAsync(state, context, next, cancellationToken);
        return StringResult(EncodeJsonObject(writer => writer.WriteBoolean("ok", true)));
    }

    private static async Task<RendererToolResult> ExecuteFileReadAsync(
        JsonElement input,
        CancellationToken cancellationToken)
    {
        var filePath = JsonHelpers.GetString(input, "file_path")?.Trim() ?? string.Empty;
        if (filePath.Length == 0)
        {
            return ErrorResult("file_path is required");
        }

        try
        {
            var result = await FileDocumentTools.ReadDocumentAsync(
                filePath,
                maxFileReadBytes: 10 * 1024 * 1024,
                cancellationToken);
            if (!string.IsNullOrEmpty(result.Error))
            {
                return ErrorResult(result.Error);
            }

            return StringResult(result.Content ?? string.Empty);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return ErrorResult(ex.Message);
        }
    }

    private static async Task EmitBufferUpdateAsync(
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string content,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent("translation_buffer_update", Content: content));
    }

    private static string ReadBuffer(string runId)
    {
        lock (BuffersByRun)
        {
            return BuffersByRun.TryGetValue(runId, out var content) ? content : string.Empty;
        }
    }

    private static void SetBuffer(string runId, string content)
    {
        lock (BuffersByRun)
        {
            BuffersByRun[runId] = content;
        }
    }

    private static bool IsLikelyCompletionStatus(string content)
    {
        var normalized = content.Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        return normalized is "done" or "done." or "completed" or "completed." or
                "complete" or "complete." or "finished" or "finished." or
                "all done" or "all done." or "translation done" or
                "translation done." or "translation complete" or
                "translation complete." or "翻译完成" or "翻译完成。" or
                "翻译已完成" or "翻译已完成。" or "已完成" or "已完成。";
    }

    private static RendererToolResult StringResult(string content)
    {
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(content),
            false,
            null);
    }

    private static RendererToolResult ErrorResult(string message)
    {
        return new RendererToolResult(
            AgentRuntimeProviderSupport.CreateStringElement(EncodeError(message)),
            true,
            message);
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
}
