using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenCowork.Agent.Providers;

// --- Stream Event (unified across all providers) ---

public sealed class StreamEvent
{
    public required string Type { get; init; }
    public string? Text { get; init; }
    public string? Thinking { get; init; }
    public string? ThinkingEncryptedContent { get; init; }
    public string? ThinkingEncryptedProvider { get; init; }
    public string? ToolCallId { get; init; }
    public string? ToolName { get; init; }
    public string? ArgumentsDelta { get; init; }
    public Dictionary<string, JsonElement>? ToolCallInput { get; init; }
    public Engine.ToolCallExtraContent? ToolCallExtraContent { get; init; }
    public int? PartialImageIndex { get; init; }
    public Engine.ImageBlock? ImageBlock { get; init; }
    public StreamEventImageError? ImageError { get; init; }
    public string? StopReason { get; init; }
    public Engine.TokenUsage? Usage { get; init; }
    public Engine.RequestTiming? Timing { get; init; }
    public string? ProviderResponseId { get; init; }
    public Engine.RequestDebugInfo? DebugInfo { get; init; }
    public StreamEventError? Error { get; init; }
}

public sealed class StreamEventError
{
    public string Type { get; init; } = "";
    public string Message { get; init; } = "";
}

public sealed class StreamEventImageError
{
    public string Code { get; init; } = "";
    public string Message { get; init; } = "";
}

// --- Anthropic SSE Payload Types ---

public sealed class AnthropicSsePayload
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "";

    [JsonPropertyName("message")]
    public AnthropicMessage? Message { get; init; }

    [JsonPropertyName("index")]
    public int? Index { get; init; }

    [JsonPropertyName("content_block")]
    public AnthropicContentBlock? ContentBlock { get; init; }

    [JsonPropertyName("delta")]
    public AnthropicDelta? Delta { get; init; }

    [JsonPropertyName("usage")]
    public AnthropicUsage? Usage { get; init; }

    [JsonPropertyName("error")]
    public AnthropicError? Error { get; init; }
}

public sealed class AnthropicMessage
{
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("usage")]
    public AnthropicUsage? Usage { get; init; }
}

public sealed class AnthropicContentBlock
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "";

    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("signature")]
    public string? Signature { get; init; }

    [JsonPropertyName("encrypted_content")]
    public string? EncryptedContent { get; init; }
}

public sealed class AnthropicDelta
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "";

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("thinking")]
    public string? Thinking { get; init; }

    [JsonPropertyName("partial_json")]
    public string? PartialJson { get; init; }

    [JsonPropertyName("stop_reason")]
    public string? StopReason { get; init; }

    [JsonPropertyName("signature")]
    public string? Signature { get; init; }

    [JsonPropertyName("encrypted_content")]
    public string? EncryptedContent { get; init; }
}

public sealed class AnthropicUsage
{
    [JsonPropertyName("input_tokens")]
    public int? InputTokens { get; init; }

    [JsonPropertyName("output_tokens")]
    public int? OutputTokens { get; init; }

    [JsonPropertyName("cache_creation_input_tokens")]
    public int? CacheCreationInputTokens { get; init; }

    [JsonPropertyName("cache_read_input_tokens")]
    public int? CacheReadInputTokens { get; init; }

    [JsonPropertyName("cache_creation")]
    public AnthropicCacheCreationUsage? CacheCreation { get; init; }
}

public sealed class AnthropicCacheCreationUsage
{
    [JsonPropertyName("ephemeral_5m_input_tokens")]
    public int? Ephemeral5mInputTokens { get; init; }

    [JsonPropertyName("ephemeral_1h_input_tokens")]
    public int? Ephemeral1hInputTokens { get; init; }
}

public sealed class AnthropicError
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "";

    [JsonPropertyName("message")]
    public string Message { get; init; } = "";
}

// --- OpenAI Chat Completions SSE Payload Types ---

public sealed class OpenAiChatChunk
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = "";

    [JsonPropertyName("object")]
    public string Object { get; init; } = "";

    [JsonPropertyName("choices")]
    public List<OpenAiChatChoice>? Choices { get; init; }

    [JsonPropertyName("usage")]
    public OpenAiUsage? Usage { get; init; }
}

public sealed class OpenAiChatChoice
{
    [JsonPropertyName("index")]
    public int Index { get; init; }

    [JsonPropertyName("delta")]
    public OpenAiChatDelta? Delta { get; init; }

    [JsonPropertyName("message")]
    public OpenAiChatMessage? Message { get; init; }

    [JsonPropertyName("finish_reason")]
    public string? FinishReason { get; init; }
}

public sealed class OpenAiChatMessage
{
    [JsonPropertyName("tool_calls")]
    public List<OpenAiToolCallDelta>? ToolCalls { get; init; }
}

public sealed class OpenAiChatDelta
{
    [JsonPropertyName("role")]
    public string? Role { get; init; }

    [JsonPropertyName("content")]
    public string? Content { get; init; }

    [JsonPropertyName("reasoning_content")]
    public string? ReasoningContent { get; init; }

    [JsonPropertyName("reasoning_encrypted_content")]
    public string? ReasoningEncryptedContent { get; init; }

    [JsonPropertyName("tool_calls")]
    public List<OpenAiToolCallDelta>? ToolCalls { get; init; }
}

public sealed class OpenAiToolCallDelta
{
    [JsonPropertyName("index")]
    public int? Index { get; init; }

    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("type")]
    public string? Type { get; init; }

    [JsonPropertyName("function")]
    public OpenAiFunctionDelta? Function { get; init; }

    [JsonPropertyName("extra_content")]
    public Engine.ToolCallExtraContent? ExtraContent { get; init; }
}

public sealed class OpenAiFunctionDelta
{
    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("arguments")]
    public JsonElement? Arguments { get; init; }

    [JsonPropertyName("args")]
    public JsonElement? Args { get; init; }

    [JsonPropertyName("input")]
    public JsonElement? Input { get; init; }

    public string? GetArgumentsChunk()
    {
        return ReadChunk(Arguments) ?? ReadChunk(Args) ?? ReadChunk(Input);
    }

    private static string? ReadChunk(JsonElement? element)
    {
        if (element is null)
            return null;

        return element.Value.ValueKind switch
        {
            JsonValueKind.String => element.Value.GetString(),
            JsonValueKind.Object or JsonValueKind.Array or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => element.Value.GetRawText(),
            _ => null
        };
    }
}

public sealed class OpenAiUsage
{
    [JsonPropertyName("prompt_tokens")]
    public int? PromptTokens { get; init; }

    [JsonPropertyName("completion_tokens")]
    public int? CompletionTokens { get; init; }

    [JsonPropertyName("total_tokens")]
    public int? TotalTokens { get; init; }

    [JsonPropertyName("completion_tokens_details")]
    public OpenAiCompletionTokensDetails? CompletionTokensDetails { get; init; }
}

public sealed class OpenAiCompletionTokensDetails
{
    [JsonPropertyName("reasoning_tokens")]
    public int? ReasoningTokens { get; init; }
}

// --- Gemini SSE Payload Types ---

public sealed class GeminiStreamChunk
{
    [JsonPropertyName("candidates")]
    public List<GeminiCandidate>? Candidates { get; init; }

    [JsonPropertyName("usageMetadata")]
    public GeminiUsageMetadata? UsageMetadata { get; init; }
}

public sealed class GeminiCandidate
{
    [JsonPropertyName("content")]
    public GeminiContent? Content { get; init; }

    [JsonPropertyName("finishReason")]
    public string? FinishReason { get; init; }

    [JsonPropertyName("finish_reason")]
    public string? FinishReasonCompat { get; init; }
}

public sealed class GeminiContent
{
    [JsonPropertyName("parts")]
    public List<GeminiPart>? Parts { get; init; }

    [JsonPropertyName("role")]
    public string? Role { get; init; }
}

public sealed class GeminiPart
{
    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("inlineData")]
    public GeminiInlineData? InlineData { get; init; }

    [JsonPropertyName("inline_data")]
    public GeminiInlineData? InlineDataCompat { get; init; }

    [JsonPropertyName("functionCall")]
    public GeminiFunctionCall? FunctionCall { get; init; }

    [JsonPropertyName("function_call")]
    public GeminiFunctionCall? FunctionCallCompat { get; init; }

    [JsonPropertyName("thought")]
    public bool? Thought { get; init; }

    [JsonPropertyName("thoughtSignature")]
    public string? ThoughtSignature { get; init; }

    [JsonPropertyName("thought_signature")]
    public string? ThoughtSignatureCompat { get; init; }
}

public sealed class GeminiInlineData
{
    [JsonPropertyName("mimeType")]
    public string? MimeType { get; init; }

    [JsonPropertyName("mime_type")]
    public string? MimeTypeCompat { get; init; }

    [JsonPropertyName("data")]
    public string? Data { get; init; }
}

public sealed class GeminiFunctionCall
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("args")]
    public Dictionary<string, JsonElement>? Args { get; init; }
}

public sealed class GeminiUsageMetadata
{
    [JsonPropertyName("promptTokenCount")]
    public int? PromptTokenCount { get; init; }

    [JsonPropertyName("candidatesTokenCount")]
    public int? CandidatesTokenCount { get; init; }

    [JsonPropertyName("totalTokenCount")]
    public int? TotalTokenCount { get; init; }

    [JsonPropertyName("thoughtsTokenCount")]
    public int? ThoughtsTokenCount { get; init; }
}
