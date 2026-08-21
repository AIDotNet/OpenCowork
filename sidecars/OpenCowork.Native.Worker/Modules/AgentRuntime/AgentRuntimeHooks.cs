using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

internal static class AgentRuntimeHooks
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<AgentRuntimeHookResult> RunPreToolUseAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        AgentRuntimeNativeToolCall call,
        bool requiresApproval)
    {
        return await RunAsync(
            parameters,
            state,
            context,
            "PreToolUse",
            call.Name,
            writer =>
            {
                writer.WriteString("toolName", call.Name);
                writer.WriteString("toolUseId", call.Id);
                writer.WritePropertyName("toolInput");
                call.Input.WriteTo(writer);
                writer.WriteBoolean("requiresApproval", requiresApproval);
            });
    }

    public static async Task<AgentRuntimeHookResult> RunPostToolUseAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        AgentRuntimeNativeToolCall call,
        JsonElement toolResponse,
        bool isError)
    {
        return await RunAsync(
            parameters,
            state,
            context,
            "PostToolUse",
            call.Name,
            writer =>
            {
                writer.WriteString("toolName", call.Name);
                writer.WriteString("toolUseId", call.Id);
                writer.WritePropertyName("toolInput");
                call.Input.WriteTo(writer);
                writer.WritePropertyName("toolResponse");
                toolResponse.WriteTo(writer);
                writer.WriteBoolean("isError", isError);
            });
    }

    public static async Task<AgentRuntimeHookResult> RunCompactAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string eventName,
        string trigger,
        int? originalCount = null,
        int? newCount = null)
    {
        return await RunAsync(
            parameters,
            state,
            context,
            eventName,
            trigger,
            writer =>
            {
                writer.WriteString("trigger", trigger);
                if (originalCount.HasValue)
                {
                    writer.WriteNumber("originalCount", originalCount.Value);
                }
                if (newCount.HasValue)
                {
                    writer.WriteNumber("newCount", newCount.Value);
                }
            });
    }

    public static async Task<AgentRuntimeHookResult> RunSubagentAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string eventName,
        string agentId,
        string agentType,
        string? toolUseId)
    {
        return await RunAsync(
            parameters,
            state,
            context,
            eventName,
            agentType,
            writer =>
            {
                writer.WriteString("agentId", agentId);
                writer.WriteString("agentType", agentType);
                if (!string.IsNullOrWhiteSpace(toolUseId))
                {
                    writer.WriteString("toolUseId", toolUseId);
                }
            });
    }

    public static async Task<AgentRuntimeHookResult> RunStopAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string reason,
        bool stopHookActive,
        string? lastAssistantMessage)
    {
        return await RunAsync(
            parameters,
            state,
            context,
            "Stop",
            "*",
            writer =>
            {
                writer.WriteString("reason", reason);
                writer.WriteBoolean("stopHookActive", stopHookActive);
                if (!string.IsNullOrEmpty(lastAssistantMessage))
                {
                    writer.WriteString("lastAssistantMessage", lastAssistantMessage);
                }
            });
    }

    /// <summary>
    /// Grace period for terminal hooks (Stop) on runs whose own token is already
    /// cancelled: the reverse request still has to reach the host, so it runs on a
    /// detached bounded token instead of the doomed run token.
    /// </summary>
    private static readonly TimeSpan CancelledRunHookTimeout = TimeSpan.FromSeconds(10);

    private static async Task<AgentRuntimeHookResult> RunAsync(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        string eventName,
        string matcherValue,
        Action<Utf8JsonWriter> writeInputFields)
    {
        // Every await on an already-cancelled token throws before the request can
        // reach the host, which both spams "hook reverse request failed" and drops
        // Stop hooks for aborted runs. Deliver those on a detached bounded token.
        using var detached = state.CancellationToken.IsCancellationRequested
            ? new CancellationTokenSource(CancelledRunHookTimeout)
            : null;
        var hookToken = detached?.Token ?? state.CancellationToken;
        try
        {
            var request = CreateRequest(parameters, state, eventName, matcherValue, writeInputFields);
            var result = await AgentRuntimeReverseRequests.RequestAsync(
                context,
                "hooks/run",
                request,
                hookToken);
            return AgentRuntimeHookResult.FromJson(result);
        }
        catch (OperationCanceledException) when (detached is not null)
        {
            WorkerLog.Warn(
                $"hook reverse request timed out on cancelled run runId={state.RunId} event={eventName}");
            return AgentRuntimeHookResult.Empty;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Full ToString: the AOT-published worker degrades Message to resource
            // keys (e.g. Arg_NullReferenceException), so type+message alone is not
            // diagnosable.
            WorkerLog.Warn(
                $"hook reverse request failed runId={state.RunId} event={eventName} error={ex}");
            return AgentRuntimeHookResult.Empty;
        }
    }

    private static JsonElement CreateRequest(
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        string eventName,
        string matcherValue,
        Action<Utf8JsonWriter> writeInputFields)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writer.WriteString("eventName", eventName);
            writer.WriteString("matcherValue", matcherValue);
            writer.WriteString("sessionId", state.SessionId);
            writer.WriteString("runId", state.RunId);
            if (JsonHelpers.GetString(parameters, "workingFolder") is { Length: > 0 } workingFolder)
            {
                writer.WriteString("projectRoot", workingFolder);
            }
            if (JsonHelpers.GetString(parameters, "sshConnectionId") is { Length: > 0 } sshConnectionId)
            {
                writer.WriteString("sshConnectionId", sshConnectionId);
            }
            writer.WritePropertyName("input");
            writer.WriteStartObject();
            writeInputFields(writer);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }
}

internal sealed class AgentRuntimeHookResult
{
    public static readonly AgentRuntimeHookResult Empty = new();

    public bool Blocked { get; private init; }
    public string? Reason { get; private init; }
    public JsonElement? UpdatedInput { get; private init; }
    public JsonElement? ReplacementToolFeedback { get; private init; }
    public IReadOnlyList<string> SystemMessages { get; private init; } = [];
    public IReadOnlyList<string> AdditionalContext { get; private init; } = [];

    public static AgentRuntimeHookResult FromJson(JsonElement result)
    {
        if (result.ValueKind != JsonValueKind.Object)
        {
            return Empty;
        }

        return new AgentRuntimeHookResult
        {
            Blocked = JsonHelpers.GetBool(result, "blocked", false),
            Reason = JsonHelpers.GetString(result, "reason"),
            UpdatedInput = CloneProperty(result, "updatedInput"),
            ReplacementToolFeedback = CloneProperty(result, "replacementToolFeedback"),
            SystemMessages = ReadStringArray(result, "systemMessages"),
            AdditionalContext = ReadStringArray(result, "additionalContext")
        };
    }

    public bool HasContext => SystemMessages.Count > 0 || AdditionalContext.Count > 0;

    private static JsonElement? CloneProperty(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var property))
        {
            return null;
        }
        return property.Clone();
    }

    private static List<string> ReadStringArray(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(name, out var property) ||
            property.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var values = new List<string>();
        foreach (var item in property.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } value)
            {
                values.Add(value);
            }
        }
        return values;
    }
}
