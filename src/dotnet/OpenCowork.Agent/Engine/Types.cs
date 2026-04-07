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
                return ContentBlockJson.DeserializeList(raw);

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
            return ContentBlockJson.DeserializeList(raw);

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
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public required string Role { get; set; }

    /// <summary>
    /// Block-based content for internal .NET processing.
    /// On the wire this may be a string or JsonElement.
    /// </summary>
    [JsonIgnore]
    public List<ContentBlock>? Content { get; set; }

    /// <summary>
    /// Raw JSON content for wire serialization.
    /// </summary>
    [JsonPropertyName("content")]
    public JsonElement? RawContent { get; set; }

    public long CreatedAt { get; set; }
    public TokenUsage? Usage { get; set; }
    public string? ProviderResponseId { get; set; }
    public string? Source { get; set; }

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
    public string ApiKey { get; set; } = "";
    public string? BaseUrl { get; set; }
    public string Model { get; set; } = "";
    public string? Category { get; set; }
    public int? MaxTokens { get; set; }
    public double? Temperature { get; set; }
    public string? SystemPrompt { get; set; }
    public bool? UseSystemProxy { get; set; }
    public bool? ThinkingEnabled { get; set; }
    public ThinkingConfig? ThinkingConfig { get; set; }
    public string? ReasoningEffort { get; set; }
    public string? ProviderId { get; set; }
    public string? ProviderBuiltinId { get; set; }
    public string? UserAgent { get; set; }
    public string? SessionId { get; set; }
    public string? ServiceTier { get; set; }
    public bool? EnablePromptCache { get; set; }
    public bool? EnableSystemPromptCache { get; set; }
    public string? PromptCacheKey { get; set; }
    public RequestOverrides? RequestOverrides { get; set; }
    public string? InstructionsPrompt { get; set; }
    public string? ResponseSummary { get; set; }
    public bool? ComputerUseEnabled { get; set; }
    public string? Organization { get; set; }
    public string? Project { get; set; }
    public string? AccountId { get; set; }
}

// --- Agent Events ---

[JsonPolymorphic(TypeDiscriminatorPropertyName = "$type")]
[JsonDerivedType(typeof(LoopStartEvent), "loop_start")]
[JsonDerivedType(typeof(IterationStartEvent), "iteration_start")]
[JsonDerivedType(typeof(TextDeltaEvent), "text_delta")]
[JsonDerivedType(typeof(ThinkingDeltaEvent), "thinking_delta")]
[JsonDerivedType(typeof(ThinkingEncryptedEvent), "thinking_encrypted")]
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
}

public sealed class RequestDebugInfo
{
    public required string Url { get; init; }
    public required string Method { get; init; }
    public required Dictionary<string, string> Headers { get; init; }
    public string? Body { get; init; }
    public long Timestamp { get; init; }
    public string? ProviderId { get; init; }
    public string? ProviderBuiltinId { get; init; }
    public string? Model { get; init; }
    public string? ExecutionPath { get; init; }
}

public sealed class RequestDebugEvent : AgentEvent
{
    protected override string TypeValue => "request_debug";
    public required RequestDebugInfo DebugInfo { get; init; }
}

// --- Lifecycle messages ---

public sealed class AgentEventNotification
{
    public required string RunId { get; init; }
    public required JsonElement Event { get; init; }
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
}

public sealed class RendererToolResponseResult
{
    public JsonElement? Content { get; init; }
    public bool IsError { get; init; }
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
    public int MaxIterations { get; init; } = 25;
    public bool ForceApproval { get; init; }
    public CompressionConfig? Compression { get; init; }
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
