using System.Text.Json;

internal sealed record AgentRuntimeCapabilityResult(bool Supported);

internal sealed record AgentRuntimeRunResult(bool Started, string RunId, string? AssistantMessageId = null);

internal sealed record AgentRuntimeSubAgentCancelResult(bool Cancelled, int Count);

internal sealed record AgentRuntimeContextCompressionResponse(
    JsonElement[] Messages,
    AgentRuntimeContextCompressionResult Result);

internal sealed record AgentRuntimeContextCompressionResult(
    bool Compressed,
    int OriginalCount,
    int NewCount,
    int? MessagesSummarized = null,
    bool? SummarizerFailed = null,
    string? Error = null,
    /// <summary>Id of the plain user message carrying the summary text.</summary>
    string? SummaryMessageId = null,
    /// <summary>
    /// Every message the summarizer consumed. The host resolves these against its
    /// own transcript to record the compaction cut, so it never has to guess which
    /// rows the summary replaced.
    /// </summary>
    string[]? CompactedMessageIds = null);

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
    AgentRuntimeStreamEvent[] Events,
    bool Live = false);

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
    bool? SummarizerFailed = null,
    JsonElement[]? Messages = null,
    /// <summary>Plain user message holding the summary, for the host to persist.</summary>
    JsonElement? CompactSummaryMessage = null,
    /// <summary>Messages the summary replaced, so the host can record the cut.</summary>
    string[]? CompactedMessageIds = null,
    string? SubAgentName = null,
    string? ToolUseId = null,
    string[]? McpServerIds = null,
    string? PermissionMode = null,
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
    JsonElement? SubAgentToolCallExtraContent = null,
    JsonElement? WebSearchSources = null,
    string? WebSearchId = null,
    int? Attempt = null,
    int? MaxAttempts = null,
    int? DelayMs = null,
    int? StatusCode = null,
    string? AssistantMessageId = null,
    /// <summary>Context tokens measured when compression was triggered.</summary>
    int? PreTokens = null);

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
    string Transport = "http",
    string? PromptCacheKeyHash = null,
    string? BodyRef = null,
    long? BodyBytes = null);

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
