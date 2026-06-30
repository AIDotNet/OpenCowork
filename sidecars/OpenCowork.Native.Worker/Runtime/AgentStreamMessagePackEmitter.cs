using System.Text.Json;

internal static class AgentStreamMessagePackEmitter
{
    public static bool TraceEnabled { get; } = ReadBooleanEnvironment("OPEN_COWORK_MSGPACK_TRACE") ?? false;

    public static WorkerMessagePackEvent Encode(AgentRuntimeStreamEnvelope envelope)
    {
        var writer = new MessagePackWriter();

        writer.WriteMapHeader(6);
        writer.WriteString("event");
        writer.WriteString("agent/stream");
        writer.WriteString("v");
        writer.WriteInt32(envelope.V);
        writer.WriteString("runId");
        writer.WriteString(envelope.RunId);
        writer.WriteString("sessionId");
        writer.WriteString(envelope.SessionId);
        writer.WriteString("seq");
        writer.WriteInt64(envelope.Seq);
        writer.WriteString("events");
        WriteEvents(writer, envelope.Events);

        return new WorkerMessagePackEvent("agent/stream", writer.ToArray());
    }

    private static void WriteEvents(MessagePackWriter writer, AgentRuntimeStreamEvent[] events)
    {
        writer.WriteArrayHeader(events.Length);
        foreach (var streamEvent in events)
        {
            WriteEvent(writer, streamEvent);
        }
    }

    private static void WriteEvent(MessagePackWriter writer, AgentRuntimeStreamEvent streamEvent)
    {
        writer.WriteMapHeader(CountEventProperties(streamEvent));
        writer.WriteString("type");
        writer.WriteString(streamEvent.Type);

        WriteOptionalInt(writer, "iteration", streamEvent.Iteration);
        WriteOptionalString(writer, "reason", streamEvent.Reason);
        WriteOptionalString(writer, "stopReason", streamEvent.StopReason);
        WriteOptionalString(writer, "text", streamEvent.Text);
        WriteOptionalString(writer, "thinking", streamEvent.Thinking);
        WriteOptionalMessage(writer, streamEvent);
        WriteOptionalString(writer, "content", streamEvent.Content);
        WriteOptionalString(writer, "provider", streamEvent.Provider);
        WriteOptionalString(writer, "errorType", streamEvent.ErrorType);
        WriteOptionalString(writer, "details", streamEvent.Details);
        WriteOptionalString(writer, "stackTrace", streamEvent.StackTrace);
        WriteOptionalString(writer, "toolCallId", streamEvent.ToolCallId);
        WriteOptionalString(writer, "toolName", streamEvent.ToolName);
        WriteOptionalJson(writer, "partialInput", streamEvent.PartialInput);
        WriteOptionalToolUseBlock(writer, streamEvent.ToolUseBlock);
        WriteOptionalToolCall(writer, streamEvent.ToolCall);
        WriteOptionalToolResults(writer, streamEvent.ToolResults);
        WriteOptionalDebugInfo(writer, streamEvent.DebugInfo);
        WriteOptionalUsage(writer, streamEvent.Usage);
        WriteOptionalTiming(writer, streamEvent.Timing);
        WriteOptionalString(writer, "providerResponseId", streamEvent.ProviderResponseId);
        WriteOptionalJson(writer, "imageBlock", streamEvent.ImageBlock);
        WriteOptionalImageError(writer, streamEvent.ImageError);
        WriteOptionalInt(writer, "partialImageIndex", streamEvent.PartialImageIndex);
        WriteOptionalJson(writer, "extraContent", streamEvent.ToolCallExtraContent);
        WriteOptionalInt(writer, "originalCount", streamEvent.OriginalCount);
        WriteOptionalInt(writer, "newCount", streamEvent.NewCount);
        WriteOptionalInt(writer, "keptMessageCount", streamEvent.KeptMessageCount);
        WriteOptionalMessages(writer, streamEvent.Messages);
        WriteOptionalString(writer, "subAgentName", streamEvent.SubAgentName);
        WriteOptionalString(writer, "toolUseId", streamEvent.ToolUseId);
        WriteOptionalJson(writer, "input", streamEvent.Input);
        WriteOptionalJson(writer, "promptMessage", streamEvent.PromptMessage);
        WriteOptionalJson(writer, "assistantMessage", streamEvent.AssistantMessage);
        WriteOptionalJson(writer, "result", streamEvent.Result);
        WriteOptionalString(writer, "report", streamEvent.Report);
        WriteOptionalString(writer, "status", streamEvent.Status);
        WriteOptionalJson(writer, "requestModel", streamEvent.RequestModel);
        WriteOptionalString(writer, "thinkingEncryptedContent", streamEvent.ThinkingEncryptedContent);
        WriteOptionalString(writer, "thinkingEncryptedProvider", streamEvent.ThinkingEncryptedProvider);
        WriteOptionalJson(writer, "toolCallExtraContent", streamEvent.SubAgentToolCallExtraContent);
    }

    private static int CountEventProperties(AgentRuntimeStreamEvent streamEvent)
    {
        var count = 1;
        if (streamEvent.Iteration.HasValue) count++;
        if (streamEvent.Reason is not null) count++;
        if (streamEvent.StopReason is not null) count++;
        if (streamEvent.Text is not null) count++;
        if (streamEvent.Thinking is not null) count++;
        if (streamEvent.Message is not null || HasJson(streamEvent.EventMessage)) count++;
        if (streamEvent.Content is not null) count++;
        if (streamEvent.Provider is not null) count++;
        if (streamEvent.ErrorType is not null) count++;
        if (streamEvent.Details is not null) count++;
        if (streamEvent.StackTrace is not null) count++;
        if (streamEvent.ToolCallId is not null) count++;
        if (streamEvent.ToolName is not null) count++;
        if (HasJson(streamEvent.PartialInput)) count++;
        if (streamEvent.ToolUseBlock is not null) count++;
        if (streamEvent.ToolCall is not null) count++;
        if (streamEvent.ToolResults is not null) count++;
        if (streamEvent.DebugInfo is not null) count++;
        if (streamEvent.Usage is not null) count++;
        if (streamEvent.Timing is not null) count++;
        if (streamEvent.ProviderResponseId is not null) count++;
        if (HasJson(streamEvent.ImageBlock)) count++;
        if (streamEvent.ImageError is not null) count++;
        if (streamEvent.PartialImageIndex.HasValue) count++;
        if (HasJson(streamEvent.ToolCallExtraContent)) count++;
        if (streamEvent.OriginalCount.HasValue) count++;
        if (streamEvent.NewCount.HasValue) count++;
        if (streamEvent.KeptMessageCount.HasValue) count++;
        if (streamEvent.Messages is not null) count++;
        if (streamEvent.SubAgentName is not null) count++;
        if (streamEvent.ToolUseId is not null) count++;
        if (HasJson(streamEvent.Input)) count++;
        if (HasJson(streamEvent.PromptMessage)) count++;
        if (HasJson(streamEvent.AssistantMessage)) count++;
        if (HasJson(streamEvent.Result)) count++;
        if (streamEvent.Report is not null) count++;
        if (streamEvent.Status is not null) count++;
        if (HasJson(streamEvent.RequestModel)) count++;
        if (streamEvent.ThinkingEncryptedContent is not null) count++;
        if (streamEvent.ThinkingEncryptedProvider is not null) count++;
        if (HasJson(streamEvent.SubAgentToolCallExtraContent)) count++;
        return count;
    }

    private static void WriteOptionalMessage(MessagePackWriter writer, AgentRuntimeStreamEvent streamEvent)
    {
        if (streamEvent.Message is not null)
        {
            writer.WriteString("message");
            writer.WriteString(streamEvent.Message);
            return;
        }

        if (!HasJson(streamEvent.EventMessage))
        {
            return;
        }

        writer.WriteString("message");
        writer.WriteJsonElement(streamEvent.EventMessage!.Value);
    }

    private static void WriteOptionalInt(MessagePackWriter writer, string name, int? value)
    {
        if (!value.HasValue) return;
        writer.WriteString(name);
        writer.WriteInt32(value.Value);
    }

    private static void WriteOptionalString(MessagePackWriter writer, string name, string? value)
    {
        if (value is null) return;
        writer.WriteString(name);
        writer.WriteString(value);
    }

    private static void WriteOptionalJson(MessagePackWriter writer, string name, JsonElement? value)
    {
        if (!value.HasValue || value.Value.ValueKind == JsonValueKind.Undefined) return;
        var element = value.GetValueOrDefault();
        writer.WriteString(name);
        writer.WriteJsonElement(element);
    }

    private static void WriteOptionalToolUseBlock(MessagePackWriter writer, AgentRuntimeToolUseBlock? block)
    {
        if (block is null) return;
        writer.WriteString("toolUseBlock");
        writer.WriteMapHeader(HasJson(block.ExtraContent) ? 4 : 3);
        writer.WriteString("id");
        writer.WriteString(block.Id);
        writer.WriteString("name");
        writer.WriteString(block.Name);
        writer.WriteString("input");
        writer.WriteJsonElement(block.Input);
        WriteOptionalJson(writer, "extraContent", block.ExtraContent);
    }

    private static void WriteOptionalToolCall(MessagePackWriter writer, AgentRuntimeToolCallState? toolCall)
    {
        if (toolCall is null) return;
        writer.WriteString("toolCall");
        WriteToolCall(writer, toolCall);
    }

    private static void WriteToolCall(MessagePackWriter writer, AgentRuntimeToolCallState toolCall)
    {
        writer.WriteMapHeader(CountToolCallProperties(toolCall));
        writer.WriteString("id");
        writer.WriteString(toolCall.Id);
        writer.WriteString("name");
        writer.WriteString(toolCall.Name);
        writer.WriteString("input");
        writer.WriteJsonElement(toolCall.Input);
        writer.WriteString("status");
        writer.WriteString(toolCall.Status);
        WriteOptionalJson(writer, "output", toolCall.Output);
        WriteOptionalString(writer, "error", toolCall.Error);
        writer.WriteString("requiresApproval");
        writer.WriteBoolean(toolCall.RequiresApproval);
        if (toolCall.StartedAt.HasValue)
        {
            writer.WriteString("startedAt");
            writer.WriteInt64(toolCall.StartedAt.Value);
        }
        if (toolCall.CompletedAt.HasValue)
        {
            writer.WriteString("completedAt");
            writer.WriteInt64(toolCall.CompletedAt.Value);
        }
    }

    private static int CountToolCallProperties(AgentRuntimeToolCallState toolCall)
    {
        var count = 5;
        if (HasJson(toolCall.Output)) count++;
        if (toolCall.Error is not null) count++;
        if (toolCall.StartedAt.HasValue) count++;
        if (toolCall.CompletedAt.HasValue) count++;
        return count;
    }

    private static void WriteOptionalToolResults(
        MessagePackWriter writer,
        AgentRuntimeToolResult[]? results)
    {
        if (results is null) return;
        writer.WriteString("toolResults");
        writer.WriteArrayHeader(results.Length);
        foreach (var result in results)
        {
            writer.WriteMapHeader(result.IsError.HasValue ? 3 : 2);
            writer.WriteString("toolUseId");
            writer.WriteString(result.ToolUseId);
            writer.WriteString("content");
            writer.WriteJsonElement(result.Content);
            if (result.IsError.HasValue)
            {
                writer.WriteString("isError");
                writer.WriteBoolean(result.IsError.Value);
            }
        }
    }

    private static void WriteOptionalDebugInfo(
        MessagePackWriter writer,
        AgentRuntimeRequestDebugInfo? debugInfo)
    {
        if (debugInfo is null) return;
        writer.WriteString("debugInfo");
        writer.WriteMapHeader(CountDebugInfoProperties(debugInfo));
        writer.WriteString("url");
        writer.WriteString(debugInfo.Url);
        writer.WriteString("method");
        writer.WriteString(debugInfo.Method);
        writer.WriteString("headers");
        writer.WriteMapHeader(debugInfo.Headers.Count);
        foreach (var item in debugInfo.Headers)
        {
            writer.WriteString(item.Key);
            writer.WriteString(item.Value);
        }
        WriteOptionalString(writer, "body", debugInfo.Body);
        writer.WriteString("timestamp");
        writer.WriteInt64(debugInfo.Timestamp);
        WriteOptionalString(writer, "providerId", debugInfo.ProviderId);
        WriteOptionalString(writer, "providerBuiltinId", debugInfo.ProviderBuiltinId);
        WriteOptionalString(writer, "model", debugInfo.Model);
        WriteOptionalString(writer, "executionPath", debugInfo.ExecutionPath);
        WriteOptionalString(writer, "transport", debugInfo.Transport);
    }

    private static int CountDebugInfoProperties(AgentRuntimeRequestDebugInfo debugInfo)
    {
        var count = 4;
        if (debugInfo.Body is not null) count++;
        if (debugInfo.ProviderId is not null) count++;
        if (debugInfo.ProviderBuiltinId is not null) count++;
        if (debugInfo.Model is not null) count++;
        if (debugInfo.ExecutionPath is not null) count++;
        if (debugInfo.Transport is not null) count++;
        return count;
    }

    private static void WriteOptionalUsage(MessagePackWriter writer, AgentRuntimeTokenUsage? usage)
    {
        if (usage is null) return;
        writer.WriteString("usage");
        writer.WriteMapHeader(CountUsageProperties(usage));
        writer.WriteString("inputTokens");
        writer.WriteInt32(usage.InputTokens);
        writer.WriteString("outputTokens");
        writer.WriteInt32(usage.OutputTokens);
        WriteOptionalInt(writer, "billableInputTokens", usage.BillableInputTokens);
        WriteOptionalInt(writer, "cacheReadTokens", usage.CacheReadTokens);
        WriteOptionalInt(writer, "reasoningTokens", usage.ReasoningTokens);
        WriteOptionalInt(writer, "contextTokens", usage.ContextTokens);
        WriteOptionalInt(writer, "cacheCreationTokens", usage.CacheCreationTokens);
        WriteOptionalInt(writer, "cacheCreation5mTokens", usage.CacheCreation5mTokens);
        WriteOptionalInt(writer, "cacheCreation1hTokens", usage.CacheCreation1hTokens);
        if (usage.CacheReadRatio.HasValue)
        {
            writer.WriteString("cacheReadRatio");
            writer.WriteDouble(usage.CacheReadRatio.Value);
        }
    }

    private static int CountUsageProperties(AgentRuntimeTokenUsage usage)
    {
        var count = 2;
        if (usage.BillableInputTokens.HasValue) count++;
        if (usage.CacheReadTokens.HasValue) count++;
        if (usage.ReasoningTokens.HasValue) count++;
        if (usage.ContextTokens.HasValue) count++;
        if (usage.CacheCreationTokens.HasValue) count++;
        if (usage.CacheCreation5mTokens.HasValue) count++;
        if (usage.CacheCreation1hTokens.HasValue) count++;
        if (usage.CacheReadRatio.HasValue) count++;
        return count;
    }

    private static void WriteOptionalTiming(MessagePackWriter writer, AgentRuntimeRequestTiming? timing)
    {
        if (timing is null) return;
        writer.WriteString("timing");
        writer.WriteMapHeader(CountTimingProperties(timing));
        writer.WriteString("totalMs");
        writer.WriteInt64(timing.TotalMs);
        if (timing.TtftMs.HasValue)
        {
            writer.WriteString("ttftMs");
            writer.WriteInt64(timing.TtftMs.Value);
        }
        if (timing.Tps.HasValue)
        {
            writer.WriteString("tps");
            writer.WriteDouble(timing.Tps.Value);
        }
    }

    private static int CountTimingProperties(AgentRuntimeRequestTiming timing)
    {
        var count = 1;
        if (timing.TtftMs.HasValue) count++;
        if (timing.Tps.HasValue) count++;
        return count;
    }

    private static void WriteOptionalMessages(MessagePackWriter writer, JsonElement[]? messages)
    {
        if (messages is null) return;
        writer.WriteString("messages");
        writer.WriteArrayHeader(messages.Length);
        foreach (var message in messages)
        {
            writer.WriteJsonElement(message);
        }
    }

    private static void WriteOptionalImageError(MessagePackWriter writer, AgentRuntimeImageError? imageError)
    {
        if (imageError is null) return;
        writer.WriteString("imageError");
        writer.WriteMapHeader(2);
        writer.WriteString("code");
        writer.WriteString(imageError.Code);
        writer.WriteString("message");
        writer.WriteString(imageError.Message);
    }

    private static bool HasJson(JsonElement? value)
    {
        return value.HasValue && value.Value.ValueKind != JsonValueKind.Undefined;
    }

    private static bool? ReadBooleanEnvironment(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (raw is null)
        {
            return null;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => null
        };
    }
}
