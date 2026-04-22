using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenCowork.Agent.Engine;

// --- Token Usage ---

public sealed class RequestTiming
{
    public long TotalMs { get; set; }
    public long? TtftMs { get; set; }
    public double? Tps { get; set; }
}

public sealed class TokenUsage
{
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public int? BillableInputTokens { get; set; }
    public int? CacheCreationTokens { get; set; }
    public int? CacheReadTokens { get; set; }
    public int? ReasoningTokens { get; set; }
    public int? ContextTokens { get; set; }
    public int? ContextLength { get; set; }
    public long? TotalDurationMs { get; set; }
    public List<RequestTiming>? RequestTimings { get; set; }
}

// --- Content Blocks ---

[JsonPolymorphic(TypeDiscriminatorPropertyName = "$type")]
[JsonDerivedType(typeof(TextBlock), "text")]
[JsonDerivedType(typeof(ImageBlock), "image")]
[JsonDerivedType(typeof(ImageErrorBlock), "image_error")]
[JsonDerivedType(typeof(ToolUseBlock), "tool_use")]
[JsonDerivedType(typeof(ToolResultBlock), "tool_result")]
[JsonDerivedType(typeof(ThinkingBlock), "thinking")]
public abstract class ContentBlock
{
    protected abstract string TypeValue { get; }

    [JsonIgnore]
    public string Type => TypeValue;

    [JsonPropertyName("type")]
    public string WireType => TypeValue;
}

public sealed class TextBlock : ContentBlock
{
    protected override string TypeValue => "text";
    public required string Text { get; set; }
}

public sealed class ImageBlock : ContentBlock
{
    protected override string TypeValue => "image";
    public required ImageSource Source { get; init; }
}

public sealed class ImageSource
{
    public required string Type { get; init; }
    public string? MediaType { get; init; }
    public string? Data { get; init; }
    public string? Url { get; init; }
    public string? FilePath { get; init; }
}

public sealed class ImageErrorBlock : ContentBlock
{
    protected override string TypeValue => "image_error";
    public required string Code { get; init; }
    public required string Message { get; init; }
}

public sealed class ToolCallExtraContent
{
    public GoogleToolCallExtraContent? Google { get; init; }
    public OpenAiResponsesToolCallExtraContent? OpenAiResponses { get; init; }
}

public sealed class GoogleToolCallExtraContent
{
    [JsonPropertyName("thought_signature")]
    public string? ThoughtSignature { get; init; }
}

public sealed class OpenAiResponsesToolCallExtraContent
{
    public OpenAiComputerUseExtraContent? ComputerUse { get; init; }
}

public sealed class OpenAiComputerUseExtraContent
{
    public string Kind { get; init; } = "computer_use";
    public required string ComputerCallId { get; init; }
    public required string ComputerActionType { get; init; }
    public required int ComputerActionIndex { get; init; }
    public bool? AutoAddedScreenshot { get; init; }
}

public sealed class ToolUseBlock : ContentBlock
{
    protected override string TypeValue => "tool_use";
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required Dictionary<string, JsonElement> Input { get; init; }
    public ToolCallExtraContent? ExtraContent { get; init; }
}

public sealed class ToolResultBlock : ContentBlock
{
    protected override string TypeValue => "tool_result";
    public required string ToolUseId { get; set; }

    [JsonIgnore]
    public object? Content { get; set; }

    [JsonPropertyName("content")]
    public JsonElement? RawContent { get; set; }

    public bool? IsError { get; set; }

    public object GetContentValue()
    {
        if (Content is not null)
            return Content;

        if (RawContent is { } raw)
        {
            if (raw.ValueKind == JsonValueKind.String)
                return raw.GetString() ?? string.Empty;

            if (raw.ValueKind == JsonValueKind.Array)
            {
                var structuredContent = GetStructuredContent();
                return structuredContent is not null ? structuredContent : raw.GetRawText();
            }

            if (raw.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                return string.Empty;

            return raw.GetRawText();
        }

        return string.Empty;
    }

    public string GetTextContent()
    {
        var value = GetContentValue();
        if (value is string text)
            return text;

        if (value is List<ContentBlock> blocks)
        {
            return string.Concat(blocks.Select(block => block switch
            {
                TextBlock textBlock => textBlock.Text,
                ImageBlock imageBlock => imageBlock.Source.FilePath ?? imageBlock.Source.Url ?? imageBlock.Source.Data ?? "[image]",
                _ => string.Empty
            }));
        }

        return value.ToString() ?? string.Empty;
    }

    public List<ContentBlock>? GetStructuredContent()
    {
        if (RawContent is { } raw && raw.ValueKind == JsonValueKind.Array)
        {
            var blocks = ContentBlockJson.DeserializeList(raw);
            if (raw.GetArrayLength() > 0 && blocks.Count == raw.GetArrayLength())
                return blocks;
        }

        return null;
    }
}

public sealed class ThinkingBlock : ContentBlock
{
    protected override string TypeValue => "thinking";
    public required string Thinking { get; set; }
    public string? EncryptedContent { get; set; }
    public string? EncryptedContentProvider { get; set; }
}

internal static class ContentBlockJson
{
    public static List<ContentBlock> DeserializeList(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Array)
            return [];

        var blocks = new List<ContentBlock>(raw.GetArrayLength());
        foreach (var item in raw.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
                continue;

            var type = GetTypeDiscriminator(item);
            ContentBlock? block = type switch
            {
                "text" => JsonSerializer.Deserialize(item, AppJsonContext.Default.TextBlock),
                "image" => JsonSerializer.Deserialize(item, AppJsonContext.Default.ImageBlock),
                "image_error" => JsonSerializer.Deserialize(item, AppJsonContext.Default.ImageErrorBlock),
                "tool_use" => JsonSerializer.Deserialize(item, AppJsonContext.Default.ToolUseBlock),
                "tool_result" => JsonSerializer.Deserialize(item, AppJsonContext.Default.ToolResultBlock),
                "thinking" => JsonSerializer.Deserialize(item, AppJsonContext.Default.ThinkingBlock),
                _ => null
            };

            if (block is not null)
                blocks.Add(block);
        }

        return blocks;
    }

    private static string? GetTypeDiscriminator(JsonElement item)
    {
        if (item.TryGetProperty("$type", out var discriminator) && discriminator.ValueKind == JsonValueKind.String)
            return discriminator.GetString();

        if (item.TryGetProperty("type", out var legacyType) && legacyType.ValueKind == JsonValueKind.String)
            return legacyType.GetString();

        return null;
    }
}

// --- Messages ---

public sealed class UnifiedMessage
{
    private List<ContentBlock>? _content;
    private JsonElement? _rawContent;

    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public required string Role { get; set; }

    /// <summary>
    /// Block-based content for internal .NET processing.
    /// On the wire this may be a string or JsonElement.
    /// </summary>
    [JsonIgnore]
    public List<ContentBlock>? Content
    {
        get => _content;
        set
        {
            _content = value;
            if (value is null)
                return;

            _rawContent = JsonSerializer.SerializeToElement(value, AppJsonContext.Default.ListContentBlock);
        }
    }

    /// <summary>
    /// Raw JSON content for wire serialization.
    /// </summary>
    [JsonPropertyName("content")]
    public JsonElement? RawContent
    {
        get
        {
            if (_rawContent is null && _content is not null)
                _rawContent = JsonSerializer.SerializeToElement(_content, AppJsonContext.Default.ListContentBlock);

            return _rawContent;
        }
        set
        {
            _rawContent = value?.Clone();
            _content = value is { ValueKind: JsonValueKind.Array }
                ? ContentBlockJson.DeserializeList(value.Value)
                : null;
        }
    }

    public long CreatedAt { get; set; }
    public TokenUsage? Usage { get; set; }
    public string? ProviderResponseId { get; set; }
    public string? Source { get; set; }
    public MessageMeta? Meta { get; set; }

    public string GetTextContent()
    {
        if (Content is not null)
        {
            foreach (var block in Content)
            {
                if (block is TextBlock tb) return tb.Text;
            }
            return "";
        }

        if (RawContent is { } raw)
        {
            if (raw.ValueKind == JsonValueKind.String)
                return raw.GetString() ?? "";
        }

        return "";
    }

    public List<ContentBlock> GetBlockContent()
    {
        if (Content is not null) return Content;

        if (RawContent is { } raw && raw.ValueKind == JsonValueKind.Array)
            return ContentBlockJson.DeserializeList(raw);

        return [];
    }
}

public sealed class CompactBoundarySegment
{
    public required string HeadId { get; set; }
    public required string AnchorId { get; set; }
    public required string TailId { get; set; }
}

public sealed class CompactBoundaryMeta
{
    public required string Trigger { get; set; }
    public int PreTokens { get; set; }
    public int MessagesSummarized { get; set; }
    public CompactBoundarySegment? PreservedSegment { get; set; }
}

public sealed class CompactSummaryMeta
{
    public int MessagesSummarized { get; set; }
    public bool RecentMessagesPreserved { get; set; }
}

public sealed class MessageMeta
{
    public CompactBoundaryMeta? CompactBoundary { get; set; }
    public CompactSummaryMeta? CompactSummary { get; set; }
}

// --- Tool Definitions ---

public sealed class ToolDefinition
{
    public required string Name { get; init; }
    public required string Description { get; init; }
    public required JsonElement InputSchema { get; init; }
}

// --- Tool Call State ---

[JsonConverter(typeof(JsonStringEnumConverter<ToolCallStatus>))]
public enum ToolCallStatus
{
    Streaming,
    PendingApproval,
    Running,
    Completed,
    Error
}

public sealed class ToolCallState
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public required Dictionary<string, JsonElement> Input { get; set; }
    public ToolCallStatus Status { get; set; }
    public JsonElement? Output { get; set; }
    public string? Error { get; set; }
    public bool RequiresApproval { get; set; }
    public ToolCallExtraContent? ExtraContent { get; set; }
    public long? StartedAt { get; set; }
    public long? CompletedAt { get; set; }
}

// --- Agent Loop Config ---

public sealed class AgentLoopConfig
{
    public int MaxIterations { get; init; }
    public required ProviderConfig Provider { get; init; }
    public required List<ToolDefinition> Tools { get; init; }
    public required string SystemPrompt { get; init; }
    public string? WorkingFolder { get; init; }
}

public sealed class ThinkingConfig
{
    public Dictionary<string, JsonElement> BodyParams { get; set; } = [];
    public Dictionary<string, JsonElement>? DisabledBodyParams { get; set; }
    public double? ForceTemperature { get; set; }
    public List<string>? ReasoningEffortLevels { get; set; }
    public string? DefaultReasoningEffort { get; set; }
}

public sealed class RequestOverrides
{
    public Dictionary<string, string>? Headers { get; set; }
    public Dictionary<string, JsonElement>? Body { get; set; }
    public List<string>? OmitBodyKeys { get; set; }
}

public sealed class ProviderConfig
{
    public string Type { get; set; } = "";
    /// <summary>
    /// "native" (default) runs inside the sidecar via a built-in ILlmProvider;
    /// "bridged" delegates each streaming request back to the renderer over IPC
    /// so unsupported providers can still drive the sidecar agent loop.
    /// </summary>
    public string? Mode { get; set; }
    public string ApiKey { get; set; } = "";
    public string? BaseUrl { get; set; }
    public string Model { get; set; } = "";
    public string? Category { get; set; }
    public int? MaxTokens { get; set; }
    public double? Temperature { get; set; }
    public string? SystemPrompt { get; set; }
    public bool? UseSystemProxy { get; set; }
    public bool? AllowInsecureTls { get; set; }
    public bool? ThinkingEnabled { get; set; }
    public ThinkingConfig? ThinkingConfig { get; set; }
    public string? ReasoningEffort { get; set; }
    public string? ProviderId { get; set; }
    public string? ProviderBuiltinId { get; set; }
    public string? UserAgent { get; set; }
    public string? SessionId { get; set; }
    public string? ResponsesSessionScope { get; set; }
    public string? ServiceTier { get; set; }
    public bool? EnablePromptCache { get; set; }
    public bool? EnableSystemPromptCache { get; set; }
    public string? PromptCacheKey { get; set; }
    public RequestOverrides? RequestOverrides { get; set; }
    public string? InstructionsPrompt { get; set; }
    public string? ResponseSummary { get; set; }
    public ResponsesImageGenerationConfig? ResponsesImageGeneration { get; set; }
    public bool? ComputerUseEnabled { get; set; }
    public string? Organization { get; set; }
    public string? Project { get; set; }
    public string? AccountId { get; set; }
    public string? WebsocketUrl { get; set; }
    public string? WebsocketMode { get; set; }
}

public sealed class ResponsesImageGenerationConfig
{
    public bool? Enabled { get; set; }
    public string? Action { get; set; }
    public string? Background { get; set; }
    public string? InputFidelity { get; set; }
    public string? Moderation { get; set; }
    public int? OutputCompression { get; set; }
    public string? OutputFormat { get; set; }
    public int? PartialImages { get; set; }
    public string? Quality { get; set; }
    public string? Size { get; set; }
}

// --- Agent Events ---

[JsonPolymorphic(TypeDiscriminatorPropertyName = "$type")]
[JsonDerivedType(typeof(LoopStartEvent), "loop_start")]
[JsonDerivedType(typeof(IterationStartEvent), "iteration_start")]
[JsonDerivedType(typeof(TextDeltaEvent), "text_delta")]
[JsonDerivedType(typeof(ThinkingDeltaEvent), "thinking_delta")]
[JsonDerivedType(typeof(ThinkingEncryptedEvent), "thinking_encrypted")]
[JsonDerivedType(typeof(ImageGenerationStartedEvent), "image_generation_started")]
[JsonDerivedType(typeof(ImageGenerationPartialEvent), "image_generation_partial")]
[JsonDerivedType(typeof(ImageGeneratedEvent), "image_generated")]
[JsonDerivedType(typeof(ImageErrorEvent), "image_error")]
[JsonDerivedType(typeof(MessageEndEvent), "message_end")]
[JsonDerivedType(typeof(ToolUseStreamingStartEvent), "tool_use_streaming_start")]
[JsonDerivedType(typeof(ToolUseArgsDeltaEvent), "tool_use_args_delta")]
[JsonDerivedType(typeof(ToolUseGeneratedEvent), "tool_use_generated")]
[JsonDerivedType(typeof(ToolCallStartEvent), "tool_call_start")]
[JsonDerivedType(typeof(ToolCallApprovalNeededEvent), "tool_call_approval_needed")]
[JsonDerivedType(typeof(ToolCallDeltaEvent), "tool_call_delta")]
[JsonDerivedType(typeof(ToolCallRunningEvent), "tool_call_running")]
[JsonDerivedType(typeof(ToolCallResultEvent), "tool_call_result")]
[JsonDerivedType(typeof(IterationEndEvent), "iteration_end")]
[JsonDerivedType(typeof(LoopEndEvent), "loop_end")]
[JsonDerivedType(typeof(AgentErrorEvent), "error")]
[JsonDerivedType(typeof(ErrorEvent), "error_event")]
[JsonDerivedType(typeof(ContextCompressionStartEvent), "context_compression_start")]
[JsonDerivedType(typeof(ContextCompressedEvent), "context_compressed")]
[JsonDerivedType(typeof(RequestDebugEvent), "request_debug")]
[JsonDerivedType(typeof(SubAgentStartEvent), "sub_agent_start")]
[JsonDerivedType(typeof(SubAgentIterationEvent), "sub_agent_iteration")]
[JsonDerivedType(typeof(SubAgentTextDeltaEvent), "sub_agent_text_delta")]
[JsonDerivedType(typeof(SubAgentThinkingDeltaEvent), "sub_agent_thinking_delta")]
[JsonDerivedType(typeof(SubAgentThinkingEncryptedEvent), "sub_agent_thinking_encrypted")]
[JsonDerivedType(typeof(SubAgentToolUseStreamingStartEvent), "sub_agent_tool_use_streaming_start")]
[JsonDerivedType(typeof(SubAgentToolUseArgsDeltaEvent), "sub_agent_tool_use_args_delta")]
[JsonDerivedType(typeof(SubAgentToolUseGeneratedEvent), "sub_agent_tool_use_generated")]
[JsonDerivedType(typeof(SubAgentMessageEndEvent), "sub_agent_message_end")]
[JsonDerivedType(typeof(SubAgentToolResultMessageEvent), "sub_agent_tool_result_message")]
[JsonDerivedType(typeof(SubAgentReportUpdateEvent), "sub_agent_report_update")]
[JsonDerivedType(typeof(SubAgentToolCallEvent), "sub_agent_tool_call")]
[JsonDerivedType(typeof(SubAgentEndEvent), "sub_agent_end")]
public abstract class AgentEvent
{
    protected abstract string TypeValue { get; }

    [JsonIgnore]
    public string Type => TypeValue;

    [JsonPropertyName("type")]
    public string WireType => TypeValue;
}

public sealed class LoopStartEvent : AgentEvent
{
    protected override string TypeValue => "loop_start";
    public int TotalMessages { get; init; }
}

public sealed class IterationStartEvent : AgentEvent
{
    protected override string TypeValue => "iteration_start";
    public int Iteration { get; init; }
}

public sealed class TextDeltaEvent : AgentEvent
{
    protected override string TypeValue => "text_delta";
    public required string Text { get; init; }
}

public sealed class ThinkingDeltaEvent : AgentEvent
{
    protected override string TypeValue => "thinking_delta";
    public required string Thinking { get; init; }
}

public sealed class ThinkingEncryptedEvent : AgentEvent
{
    protected override string TypeValue => "thinking_encrypted";
    public required string ThinkingEncryptedContent { get; init; }
    public required string ThinkingEncryptedProvider { get; init; }
}

public sealed class ImageGenerationStartedEvent : AgentEvent
{
    protected override string TypeValue => "image_generation_started";
}

public sealed class ImageGenerationPartialEvent : AgentEvent
{
    protected override string TypeValue => "image_generation_partial";
    public required ImageBlock ImageBlock { get; init; }
    public int? PartialImageIndex { get; init; }
}

public sealed class ImageGeneratedEvent : AgentEvent
{
    protected override string TypeValue => "image_generated";
    public required ImageBlock ImageBlock { get; init; }
}

public sealed class ImageErrorEvent : AgentEvent
{
    protected override string TypeValue => "image_error";
    public required ImageErrorBlock ImageError { get; init; }
}

public sealed class MessageEndEvent : AgentEvent
{
    protected override string TypeValue => "message_end";
    public TokenUsage? Usage { get; init; }
    public RequestTiming? Timing { get; init; }
    public string? ProviderResponseId { get; init; }
    public string? StopReason { get; init; }
}

public sealed class ToolUseStreamingStartEvent : AgentEvent
{
    protected override string TypeValue => "tool_use_streaming_start";
    public required string ToolCallId { get; init; }
    public required string ToolName { get; init; }
    public ToolCallExtraContent? ToolCallExtraContent { get; init; }
}

public sealed class ToolUseArgsDeltaEvent : AgentEvent
{
    protected override string TypeValue => "tool_use_args_delta";
    public required string ToolCallId { get; init; }
    public required Dictionary<string, JsonElement> PartialInput { get; init; }
}

public sealed class ToolUseGeneratedEvent : AgentEvent
{
    protected override string TypeValue => "tool_use_generated";
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required Dictionary<string, JsonElement> Input { get; init; }
    public ToolCallExtraContent? ExtraContent { get; init; }
}

public sealed class ToolCallStartEvent : AgentEvent
{
    protected override string TypeValue => "tool_call_start";
    public required string ToolCallId { get; init; }
    public required string ToolName { get; init; }
    public ToolCallState? ToolCall { get; init; }
}

public sealed class ToolCallApprovalNeededEvent : AgentEvent
{
    protected override string TypeValue => "tool_call_approval_needed";
    public required ToolCallState ToolCall { get; init; }
}

public sealed class ToolCallDeltaEvent : AgentEvent
{
    protected override string TypeValue => "tool_call_delta";
    public required string ToolCallId { get; init; }
    public required string ArgumentsDelta { get; init; }
}

public sealed class ToolCallRunningEvent : AgentEvent
{
    protected override string TypeValue => "tool_call_running";
    public required string ToolCallId { get; init; }
    public required string ToolName { get; init; }
    public ToolCallState? ToolCall { get; init; }
}

public sealed class ToolCallResultEvent : AgentEvent
{
    protected override string TypeValue => "tool_call_result";
    public required string ToolCallId { get; init; }
    public required string ToolName { get; init; }
    public string? Result { get; init; }
    public bool IsError { get; init; }
    public ToolCallState? ToolCall { get; init; }
}

public sealed class ToolResultSummary
{
    public required string ToolUseId { get; init; }
    public required JsonElement Content { get; init; }
    public bool? IsError { get; init; }
}

public sealed class IterationEndEvent : AgentEvent
{
    protected override string TypeValue => "iteration_end";
    public int Iteration { get; init; }
    public required string StopReason { get; init; }
    public List<ToolResultSummary>? ToolResults { get; init; }
}

public sealed class LoopEndEvent : AgentEvent
{
    protected override string TypeValue => "loop_end";
    public required string Reason { get; init; }
    public List<UnifiedMessage>? Messages { get; init; }
}

public sealed class AgentErrorEvent : AgentEvent
{
    protected override string TypeValue => "error";
    public required string Message { get; init; }
    public string? ErrorType { get; init; }
    public string? Details { get; init; }
    public string? StackTrace { get; init; }
}

public sealed class ErrorEvent : AgentEvent
{
    protected override string TypeValue => "error_event";
    public required string ErrorMessage { get; init; }
    public string? ErrorType { get; init; }
}

public sealed class ContextCompressionStartEvent : AgentEvent
{
    protected override string TypeValue => "context_compression_start";
}

public sealed class ContextCompressedEvent : AgentEvent
{
    protected override string TypeValue => "context_compressed";
    public int OriginalCount { get; init; }
    public int CompressedCount { get; init; }
    public List<UnifiedMessage>? Messages { get; init; }
}

public sealed class RequestDebugInfo
{
    public required string Url { get; init; }
    public required string Method { get; init; }
    public required Dictionary<string, string> Headers { get; init; }
    public string? Body { get; init; }
    public string? ContextWindowBody { get; init; }
    public long Timestamp { get; init; }
    public string? ProviderId { get; init; }
    public string? ProviderBuiltinId { get; init; }
    public string? Model { get; init; }
    public string? ExecutionPath { get; init; }
    public string? Transport { get; init; }
    public string? FallbackReason { get; init; }
    public bool? ReusedConnection { get; init; }
    public string? WebsocketRequestKind { get; init; }
    public string? WebsocketIncrementalReason { get; init; }
    public string? PreviousResponseId { get; init; }
}

public sealed class RequestDebugEvent : AgentEvent
{
    protected override string TypeValue => "request_debug";
    public required RequestDebugInfo DebugInfo { get; init; }
}

public sealed class SubAgentResult
{
    public bool Success { get; init; }
    public required string Output { get; init; }
    public bool? ReportSubmitted { get; init; }
    public int ToolCallCount { get; init; }
    public int Iterations { get; init; }
    public required TokenUsage Usage { get; init; }
    public string? Error { get; init; }
}

public sealed class SubAgentStartEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_start";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required Dictionary<string, JsonElement> Input { get; init; }
    public required UnifiedMessage PromptMessage { get; init; }
}

public sealed class SubAgentIterationEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_iteration";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public int Iteration { get; init; }
    public required UnifiedMessage AssistantMessage { get; init; }
}

public sealed class SubAgentTextDeltaEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_text_delta";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required string Text { get; init; }
}

public sealed class SubAgentThinkingDeltaEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_thinking_delta";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required string Thinking { get; init; }
}

public sealed class SubAgentThinkingEncryptedEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_thinking_encrypted";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required string ThinkingEncryptedContent { get; init; }
    public required string ThinkingEncryptedProvider { get; init; }
}

public sealed class SubAgentToolUseStreamingStartEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_tool_use_streaming_start";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required string ToolCallId { get; init; }
    public required string ToolName { get; init; }
    public ToolCallExtraContent? ToolCallExtraContent { get; init; }
}

public sealed class SubAgentToolUseArgsDeltaEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_tool_use_args_delta";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required string ToolCallId { get; init; }
    public required Dictionary<string, JsonElement> PartialInput { get; init; }
}

public sealed class SubAgentToolUseGeneratedEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_tool_use_generated";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required ToolUseBlock ToolUseBlock { get; init; }
}

public sealed class SubAgentMessageEndEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_message_end";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public TokenUsage? Usage { get; init; }
    public string? ProviderResponseId { get; init; }
}

public sealed class SubAgentToolResultMessageEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_tool_result_message";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required UnifiedMessage Message { get; init; }
}

public sealed class SubAgentReportUpdateEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_report_update";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required string Report { get; init; }
    public required string Status { get; init; }
}

public sealed class SubAgentToolCallEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_tool_call";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required ToolCallState ToolCall { get; init; }
}

public sealed class SubAgentEndEvent : AgentEvent
{
    protected override string TypeValue => "sub_agent_end";
    public required string SubAgentName { get; init; }
    public required string ToolUseId { get; init; }
    public required SubAgentResult Result { get; init; }
}

// --- Lifecycle messages ---

public sealed class AgentEventNotification
{
    public required string RunId { get; init; }
    public required JsonElement Event { get; init; }
}

public sealed class AgentEventBatchNotification
{
    public required string RunId { get; init; }
    public required List<JsonElement> Events { get; init; }
}

public sealed class ApprovalRequestParams
{
    public required string RunId { get; init; }
    public required string SessionId { get; init; }
    public required ToolCallState ToolCall { get; init; }
}

public sealed class ApprovalResponseResult
{
    public bool Approved { get; init; }
    public string? Reason { get; init; }
}

public sealed class ElectronInvokeParams
{
    public required string Channel { get; init; }
    public List<JsonElement>? Args { get; init; }
}

public sealed class RendererToolRequestParams
{
    public required string ToolName { get; init; }
    public required Dictionary<string, JsonElement> Input { get; init; }
    public string? SessionId { get; init; }
    public string? WorkingFolder { get; init; }
    public string? CurrentToolUseId { get; init; }
    public string? AgentRunId { get; init; }
    public string? PluginId { get; init; }
    public string? PluginChatId { get; init; }
    public string? PluginChatType { get; init; }
    public string? PluginSenderId { get; init; }
    public string? PluginSenderName { get; init; }
    public string? SshConnectionId { get; init; }
}

public sealed class RendererToolResponseResult
{
    public JsonElement? Content { get; init; }
    public bool IsError { get; init; }
    public string? Error { get; init; }
}

public sealed class BridgedProviderStreamStartParams
{
    public required string StreamId { get; init; }
    public required string ProviderType { get; init; }
    public required ProviderConfig ProviderConfig { get; init; }
    public required List<UnifiedMessage> Messages { get; init; }
    public required List<ToolDefinition> Tools { get; init; }
    public string? AgentRunId { get; init; }
    public string? SessionId { get; init; }
}

public sealed class BridgedProviderStreamStartResult
{
    public bool Accepted { get; init; }
    public string? Error { get; init; }
}

public sealed class BridgedProviderStreamEventParams
{
    public required string StreamId { get; init; }
    public OpenCowork.Agent.Providers.StreamEvent? Event { get; init; }
    public bool Done { get; init; }
    public string? Error { get; init; }
}

public sealed class DesktopInputAvailableResult
{
    public bool Available { get; init; }
    public string? Error { get; init; }
}

public sealed class DesktopOperationResult
{
    public bool Success { get; init; }
    public string? Error { get; init; }
    public JsonElement? Payload { get; init; }
}

public sealed class FsGrepParams
{
    public string Pattern { get; init; } = "";
    public string? Path { get; init; }
    public string? Include { get; init; }
    public int? MaxResults { get; init; }
    public int? MaxLineLength { get; init; }
    public int? MaxOutputBytes { get; init; }
    public int? TimeoutMs { get; init; }
}

public sealed class FsGrepMatch
{
    public string File { get; init; } = "";
    public int Line { get; init; }
    public string Text { get; init; } = "";
}

public sealed class FsGrepResult
{
    public List<FsGrepMatch> Results { get; init; } = [];
    public bool Truncated { get; init; }
    public bool TimedOut { get; init; }
    public string? LimitReason { get; init; }
    public long SearchTime { get; init; }
}

public sealed class PingParams
{
    public long Timestamp { get; init; }
}

public sealed class PongResult
{
    public long Timestamp { get; init; }
    public string Version { get; init; } = "";
}

public sealed class InitializeParams
{
    public string? DataDir { get; init; }
    public string? WorkingFolder { get; init; }
}

public sealed class InitializeResult
{
    public bool Ok { get; init; }
    public string Version { get; init; } = "";
    public List<string>? Capabilities { get; init; }
}

public sealed class CapabilitiesCheckParams
{
    public string Capability { get; init; } = "";
}

public sealed class CapabilitiesCheckResult
{
    public bool Supported { get; init; }
    public string Capability { get; init; } = "";
}

public sealed class CapabilitiesListResult
{
    public List<string> Capabilities { get; init; } = [];
}

public sealed class AgentRunParams
{
    public List<UnifiedMessage> Messages { get; init; } = [];
    public ProviderConfig Provider { get; init; } = new();
    public List<ToolDefinition> Tools { get; init; } = [];
    public string? RunId { get; init; }
    public string? SessionId { get; init; }
    public string? WorkingFolder { get; init; }
    /// <summary>
    /// 0 (default) = unlimited — the loop runs until the model stops calling
    /// tools. Any positive value caps the number of iterations.
    /// </summary>
    public int MaxIterations { get; init; } = 0;
    public bool ForceApproval { get; init; }
    public int MaxParallelTools { get; init; } = 8;
    public CompressionConfig? Compression { get; init; }
    /// <summary>
    /// "agent" (default) runs the full tool-calling loop.
    /// "chat" runs a single provider turn with tool execution disabled.
    /// </summary>
    public string? SessionMode { get; init; }
    /// <summary>
    /// When true, any tool call not in <see cref="PlanModeAllowedTools"/> is
    /// answered with a synthesized error tool_result instead of executing.
    /// Mirrors the renderer-side plan-tool.ts PLAN_MODE_ALLOWED_TOOLS filter.
    /// </summary>
    public bool PlanMode { get; init; }
    public List<string>? PlanModeAllowedTools { get; init; }
    public string? PluginId { get; init; }
    public string? PluginChatId { get; init; }
    public string? PluginChatType { get; init; }
    public string? PluginSenderId { get; init; }
    public string? PluginSenderName { get; init; }
    public string? SshConnectionId { get; init; }
}

public sealed class AgentRunResult
{
    public bool Started { get; init; }
    public string RunId { get; init; } = "";
}

public sealed class AgentCancelParams
{
    public string RunId { get; init; } = "";
}

public sealed class AgentCancelResult
{
    public bool Cancelled { get; init; }
    public string RunId { get; init; } = "";
}

public sealed class ShutdownResult
{
    public bool Ok { get; init; }
}
