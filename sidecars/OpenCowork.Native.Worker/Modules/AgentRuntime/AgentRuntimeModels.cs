using System.Text.Json;

internal sealed record AgentRuntimeInitializeResult(bool Ok, string Runtime, string Version);

internal sealed record AgentRuntimeCapabilityResult(bool Supported);

internal sealed record AgentRuntimeRunResult(bool Started, string RunId);

internal sealed record AgentRuntimeCancelResult(bool Cancelled, string? RunId);

internal sealed record AgentRuntimeAppendMessagesResult(bool Appended, string? RunId, int Count);

internal sealed record AgentRuntimeContextCompressionResponse(
    JsonElement[] Messages,
    AgentRuntimeContextCompressionResult Result);

internal sealed record AgentRuntimeContextCompressionResult(
    bool Compressed,
    int OriginalCount,
    int NewCount,
    int? MessagesSummarized = null,
    bool? SummarizerFailed = null);

internal sealed record AgentRuntimeReverseResponseResult(bool Ok);

internal sealed record AgentRuntimeReverseRequestEnvelope(string Id, string Method, JsonElement Params);

internal sealed record AgentRuntimeApprovalRequest(
    string RunId,
    string SessionId,
    AgentRuntimeToolCallState ToolCall);

internal sealed record AgentRuntimeActiveRun(
    string RunId,
    string SessionId,
    long StartedAt,
    int QueuedMessageCount);

internal sealed record AgentRuntimeStreamEnvelope(
    int V,
    string RunId,
    string SessionId,
    long Seq,
    AgentRuntimeStreamEvent[] Events);

internal sealed record AgentRuntimeStreamEvent(
    string Type,
    int? Iteration = null,
    string? Reason = null,
    string? StopReason = null,
    string? Text = null,
    string? Thinking = null,
    string? Message = null,
    string? Content = null,
    string? Provider = null,
    string? ErrorType = null,
    string? Details = null,
    string? StackTrace = null,
    string? ToolCallId = null,
    string? ToolName = null,
    JsonElement? PartialInput = null,
    AgentRuntimeToolUseBlock? ToolUseBlock = null,
    AgentRuntimeToolCallState? ToolCall = null,
    AgentRuntimeToolResult[]? ToolResults = null,
    AgentRuntimeRequestDebugInfo? DebugInfo = null,
    AgentRuntimeTokenUsage? Usage = null,
    AgentRuntimeRequestTiming? Timing = null,
    string? ProviderResponseId = null,
    JsonElement? ImageBlock = null,
    AgentRuntimeImageError? ImageError = null,
    int? PartialImageIndex = null,
    JsonElement? ToolCallExtraContent = null,
    int? OriginalCount = null,
    int? NewCount = null,
    int? KeptMessageCount = null,
    JsonElement[]? Messages = null,
    string? SubAgentName = null,
    string? ToolUseId = null,
    JsonElement? Input = null,
    JsonElement? PromptMessage = null,
    JsonElement? AssistantMessage = null,
    JsonElement? EventMessage = null,
    JsonElement? Result = null,
    string? Report = null,
    string? Status = null,
    JsonElement? RequestModel = null,
    string? ThinkingEncryptedContent = null,
    string? ThinkingEncryptedProvider = null,
    JsonElement? SubAgentToolCallExtraContent = null);

internal sealed record AgentRuntimeToolUseBlock(
    string Id,
    string Name,
    JsonElement Input,
    JsonElement? ExtraContent = null);

internal sealed record AgentRuntimeImageError(string Code, string Message);

internal sealed record AgentRuntimeToolResult(
    string ToolUseId,
    JsonElement Content,
    bool? IsError = null);

internal sealed record AgentRuntimeToolCallState(
    string Id,
    string Name,
    JsonElement Input,
    string Status,
    JsonElement? Output = null,
    string? Error = null,
    bool RequiresApproval = false,
    long? StartedAt = null,
    long? CompletedAt = null);

internal sealed record AgentRuntimeRequestDebugInfo(
    string Url,
    string Method,
    IReadOnlyDictionary<string, string> Headers,
    string? Body,
    long Timestamp,
    string? ProviderId = null,
    string? ProviderBuiltinId = null,
    string? Model = null,
    string ExecutionPath = "sidecar",
    string Transport = "http");

internal sealed record AgentRuntimeTokenUsage(
    int InputTokens,
    int OutputTokens,
    int? BillableInputTokens = null,
    int? CacheReadTokens = null,
    int? ReasoningTokens = null,
    int? ContextTokens = null,
    int? CacheCreationTokens = null,
    int? CacheCreation5mTokens = null,
    int? CacheCreation1hTokens = null,
    double? CacheReadRatio = null);

internal sealed record AgentRuntimeRequestTiming(
    long TotalMs,
    long? TtftMs = null,
    double? Tps = null);
