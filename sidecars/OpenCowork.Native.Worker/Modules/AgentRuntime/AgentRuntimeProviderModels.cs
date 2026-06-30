using System.Text.Json;

internal sealed record AgentRuntimeProviderTurnResult(
    AgentRuntimeChatMessage AssistantMessage,
    List<AgentRuntimeNativeToolCall> ToolCalls,
    string StopReason,
    AgentRuntimeTokenUsage? Usage = null);

internal sealed record AgentRuntimeNativeToolCall(
    string Id,
    string Name,
    JsonElement Input,
    JsonElement? ExtraContent = null);

internal sealed record AgentRuntimeChatToolUse(
    string Id,
    string Name,
    JsonElement Input,
    JsonElement? ExtraContent = null);

internal sealed record AgentRuntimeChatMessage(
    string Role,
    string Text,
    List<AgentRuntimeChatToolUse> ToolUses,
    List<AgentRuntimeToolResult> ToolResults,
    string? ProviderResponseId = null,
    List<JsonElement>? ContentBlocks = null)
{
    public static AgentRuntimeChatMessage UserToolResults(List<AgentRuntimeToolResult> toolResults)
    {
        return new AgentRuntimeChatMessage("user", string.Empty, [], toolResults);
    }
}
