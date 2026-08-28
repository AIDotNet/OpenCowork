using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static string ToolResultToString(JsonElement content)
    {
        return content.ValueKind == JsonValueKind.String
            ? content.GetString() ?? string.Empty
            : content.GetRawText();
    }

    private static bool TryParseJsonObject(string value, out JsonElement element)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            element = CreateEmptyObjectElement();
            return false;
        }
        try
        {
            using var document = JsonDocument.Parse(value);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                element = CreateEmptyObjectElement();
                return false;
            }
            element = document.RootElement.Clone();
            return true;
        }
        catch (JsonException)
        {
            element = CreateEmptyObjectElement();
            return false;
        }
    }

    private static JsonElement CreateEmptyObjectElement()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private static string BuildToolCallKey(AgentRuntimeNativeToolCall call)
    {
        return $"{call.Id}:{call.Name}:{call.Input.GetRawText()}";
    }

    private static int ReadInt(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(propertyName, out var property))
        {
            return 0;
        }
        if (property.ValueKind == JsonValueKind.Number &&
            property.TryGetInt64(out var longValue))
        {
            return longValue > int.MaxValue ? int.MaxValue : (int)Math.Max(0, longValue);
        }
        if (property.ValueKind == JsonValueKind.String &&
            long.TryParse(property.GetString(), out longValue))
        {
            return longValue > int.MaxValue ? int.MaxValue : (int)Math.Max(0, longValue);
        }
        return 0;
    }

    private static void MarkFirstToken(ResponsesParseState parseState, long startedAt)
    {
        parseState.FirstTokenMs ??= ElapsedMs(startedAt);
    }

    private static int EstimateTokenCount(string text)
    {
        return AgentRuntimeThroughput.EstimateTokens(text);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed class ResponsesParseState
    {
        public StringBuilder AssistantText { get; } = new();
        public List<AgentRuntimeNativeToolCall> ToolCalls { get; } = new();
        public Dictionary<string, ResponsesToolBuffer> ToolBuffers { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> CallIdAliases { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedToolCallKeys { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedEncryptedReasoning { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedComputerCallIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedImageGenerationStartIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedImageOutputItemIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedWebSearchCallIds { get; } = new(StringComparer.Ordinal);
        public bool ImageGenerationStarted { get; set; }
        public bool EmittedThinkingDelta { get; set; }
        /// <summary>
        /// True only when reasoning summary text streamed live (during the reasoning
        /// phase). Summaries surfaced at output_item.done arrive after reasoning ended,
        /// so they do not prove the TPS window covered reasoning generation.
        /// </summary>
        public bool ReasoningStreamedLive { get; set; }
        public bool ReceivedAnyMessage { get; set; }
        public long? FirstTokenMs { get; set; }
        public int EstimatedOutputTokens { get; set; }
        public AgentRuntimeTokenUsage? Usage { get; set; }
        public string StopReason { get; set; } = "completed";
        public string? ProviderResponseId { get; set; }
    }

    private readonly record struct ResponsesPreviousResponseAnchor(
        string ResponseId,
        int NextMessageIndex);

    private sealed class ResponsesToolBuffer
    {
        public ResponsesToolBuffer(string callId, string name)
        {
            CallId = callId;
            Name = name;
        }

        public string CallId { get; }
        public string Name { get; set; }
        public StringBuilder Arguments { get; } = new();
        public AgentRuntimeToolArgumentStreamState ArgumentStream { get; } = new();
    }

    private static class NativeGlobalPromptCacheKey
    {
        public static readonly string Value = $"ocw-global-{Guid.NewGuid():N}";
    }
}
