using System.Text.Json;
using System.Text.Json.Serialization;
using OpenCowork.Agent.Protocol;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Providers;

namespace OpenCowork.Agent;

/// <summary>
/// Master source-generated JSON serializer context.
/// Every type that crosses a serialization boundary MUST be registered here.
/// With JsonSerializerIsReflectionEnabledByDefault=false, any missed type
/// will fail at runtime rather than silently falling back to reflection.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    UseStringEnumConverter = true,
    WriteIndented = false)]
// Primitives used in JSON-RPC id fields
[JsonSerializable(typeof(long))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(bool))]
[JsonSerializable(typeof(object))]
// Protocol layer
[JsonSerializable(typeof(JsonRpcMessage))]
[JsonSerializable(typeof(JsonRpcError))]
// Ping/pong and lifecycle
[JsonSerializable(typeof(PingParams))]
[JsonSerializable(typeof(PongResult))]
[JsonSerializable(typeof(InitializeParams))]
[JsonSerializable(typeof(InitializeResult))]
// Agent events (streamed to Electron)
[JsonSerializable(typeof(AgentEvent))]
[JsonSerializable(typeof(ToolCallState))]
[JsonSerializable(typeof(TokenUsage))]
[JsonSerializable(typeof(RequestTiming))]
[JsonSerializable(typeof(AgentLoopConfig))]
[JsonSerializable(typeof(ProviderConfig))]
[JsonSerializable(typeof(ResponsesImageGenerationConfig))]
[JsonSerializable(typeof(ThinkingConfig))]
[JsonSerializable(typeof(RequestOverrides))]
[JsonSerializable(typeof(RequestDebugInfo))]
[JsonSerializable(typeof(RequestDebugEvent))]
[JsonSerializable(typeof(ToolDefinition))]
[JsonSerializable(typeof(UnifiedMessage))]
[JsonSerializable(typeof(MessageMeta))]
[JsonSerializable(typeof(CompactBoundaryMeta))]
[JsonSerializable(typeof(CompactBoundarySegment))]
[JsonSerializable(typeof(CompactSummaryMeta))]
[JsonSerializable(typeof(ContentBlock))]
[JsonSerializable(typeof(TextBlock))]
[JsonSerializable(typeof(ImageBlock))]
[JsonSerializable(typeof(ImageErrorBlock))]
[JsonSerializable(typeof(ToolUseBlock))]
[JsonSerializable(typeof(ToolResultBlock))]
[JsonSerializable(typeof(ThinkingBlock))]
[JsonSerializable(typeof(ToolCallExtraContent))]
[JsonSerializable(typeof(GoogleToolCallExtraContent))]
[JsonSerializable(typeof(OpenAiResponsesToolCallExtraContent))]
[JsonSerializable(typeof(OpenAiComputerUseExtraContent))]
[JsonSerializable(typeof(List<UnifiedMessage>))]
[JsonSerializable(typeof(List<ToolDefinition>))]
[JsonSerializable(typeof(List<ContentBlock>))]
[JsonSerializable(typeof(List<ToolResultSummary>))]
// Tool inputs (dynamic shape via JsonElement)
[JsonSerializable(typeof(Dictionary<string, JsonElement>))]
[JsonSerializable(typeof(JsonElement))]
// LLM provider SSE payloads
[JsonSerializable(typeof(AnthropicSsePayload))]
[JsonSerializable(typeof(AnthropicMessage))]
[JsonSerializable(typeof(AnthropicContentBlock))]
[JsonSerializable(typeof(AnthropicDelta))]
[JsonSerializable(typeof(AnthropicUsage))]
[JsonSerializable(typeof(AnthropicError))]
[JsonSerializable(typeof(OpenAiChatChunk))]
[JsonSerializable(typeof(OpenAiChatChoice))]
[JsonSerializable(typeof(OpenAiChatDelta))]
[JsonSerializable(typeof(OpenAiChatMessage))]
[JsonSerializable(typeof(OpenAiToolCallDelta))]
[JsonSerializable(typeof(OpenAiFunctionDelta))]
[JsonSerializable(typeof(OpenAiUsage))]
[JsonSerializable(typeof(GeminiStreamChunk))]
[JsonSerializable(typeof(GeminiCandidate))]
[JsonSerializable(typeof(GeminiContent))]
[JsonSerializable(typeof(GeminiPart))]
[JsonSerializable(typeof(GeminiFunctionCall))]
[JsonSerializable(typeof(GeminiUsageMetadata))]
// Stream events
[JsonSerializable(typeof(StreamEvent))]
[JsonSerializable(typeof(StreamEventImageError))]
// Additional event types from agent loop
[JsonSerializable(typeof(ToolCallDeltaEvent))]
[JsonSerializable(typeof(ToolCallRunningEvent))]
[JsonSerializable(typeof(ImageGenerationStartedEvent))]
[JsonSerializable(typeof(ImageGenerationPartialEvent))]
[JsonSerializable(typeof(ImageGeneratedEvent))]
[JsonSerializable(typeof(ImageErrorEvent))]
[JsonSerializable(typeof(ErrorEvent))]
[JsonSerializable(typeof(AgentEventNotification))]
[JsonSerializable(typeof(AgentEventBatchNotification))]
[JsonSerializable(typeof(ApprovalRequestParams))]
[JsonSerializable(typeof(ApprovalResponseResult))]
[JsonSerializable(typeof(ElectronInvokeParams))]
[JsonSerializable(typeof(RendererToolRequestParams))]
[JsonSerializable(typeof(RendererToolResponseResult))]
[JsonSerializable(typeof(BridgedProviderStreamStartParams))]
[JsonSerializable(typeof(BridgedProviderStreamStartResult))]
[JsonSerializable(typeof(BridgedProviderStreamEventParams))]
[JsonSerializable(typeof(DesktopInputAvailableResult))]
[JsonSerializable(typeof(DesktopOperationResult))]
[JsonSerializable(typeof(FsGrepParams))]
[JsonSerializable(typeof(FsGrepMatch))]
[JsonSerializable(typeof(FsGrepResult))]
[JsonSerializable(typeof(List<FsGrepMatch>))]
// Protocol request/response types
[JsonSerializable(typeof(CapabilitiesCheckParams))]
[JsonSerializable(typeof(CapabilitiesCheckResult))]
[JsonSerializable(typeof(CapabilitiesListResult))]
[JsonSerializable(typeof(AgentRunParams))]
[JsonSerializable(typeof(AgentRunResult))]
[JsonSerializable(typeof(AgentCancelParams))]
[JsonSerializable(typeof(AgentCancelResult))]
[JsonSerializable(typeof(ShutdownResult))]
// Sub-agent types
[JsonSerializable(typeof(OpenCowork.Agent.SubAgents.SubAgentDefinition))]
[JsonSerializable(typeof(List<OpenCowork.Agent.SubAgents.SubAgentDefinition>))]
[JsonSerializable(typeof(OpenCowork.Agent.Engine.SubAgentResult))]
// Engine types
[JsonSerializable(typeof(CompressionConfig))]
// Request body building (dynamic structures for LLM API payloads)
[JsonSerializable(typeof(Dictionary<string, object?>))]
[JsonSerializable(typeof(List<object>))]
[JsonSerializable(typeof(List<Dictionary<string, object?>>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(double))]
internal partial class AppJsonContext : JsonSerializerContext;
