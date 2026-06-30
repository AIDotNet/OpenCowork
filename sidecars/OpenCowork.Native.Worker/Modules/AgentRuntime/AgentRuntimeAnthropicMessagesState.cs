using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private static AgentRuntimeTokenUsage MergeUsage(AgentRuntimeTokenUsage? current, JsonElement usage)
    {
        var uncachedInputTokens = ReadInt(usage, "input_tokens");
        var outputTokens = ReadInt(usage, "output_tokens");
        var cacheReadTokens = ReadInt(usage, "cache_read_input_tokens");
        if (cacheReadTokens == 0 && usage.TryGetProperty("input_tokens_details", out var inputDetails))
        {
            cacheReadTokens = ReadInt(inputDetails, "cached_tokens");
        }

        var cacheCreation5m = ReadInt(usage, "cache_creation_5m_input_tokens");
        var cacheCreation1h = ReadInt(usage, "cache_creation_1h_input_tokens");
        var cacheCreationTokens = ReadInt(usage, "cache_creation_input_tokens");
        if (usage.TryGetProperty("cache_creation", out var cacheCreation) &&
            cacheCreation.ValueKind == JsonValueKind.Object)
        {
            cacheCreation5m = Math.Max(cacheCreation5m, ReadInt(cacheCreation, "ephemeral_5m_input_tokens"));
            cacheCreation1h = Math.Max(cacheCreation1h, ReadInt(cacheCreation, "ephemeral_1h_input_tokens"));
        }
        if (cacheCreationTokens == 0)
        {
            cacheCreationTokens = cacheCreation5m + cacheCreation1h;
        }

        var cachedInputTokens = cacheReadTokens + cacheCreationTokens;
        var inputTokens = uncachedInputTokens > 0 || cachedInputTokens > 0
            ? uncachedInputTokens + cachedInputTokens
            : current?.InputTokens ?? 0;
        var reasoningTokens = ReadInt(usage, "reasoning_tokens");
        if (reasoningTokens == 0 && usage.TryGetProperty("output_tokens_details", out var outputDetails))
        {
            reasoningTokens = ReadInt(outputDetails, "reasoning_tokens");
        }
        var effectiveOutputTokens = outputTokens > 0 ? outputTokens : current?.OutputTokens ?? 0;
        var effectiveCacheRead = cacheReadTokens > 0 ? cacheReadTokens : current?.CacheReadTokens;
        var effectiveCacheCreation = cacheCreationTokens > 0 ? cacheCreationTokens : current?.CacheCreationTokens;
        var cacheReadRatio = inputTokens > 0 && effectiveCacheRead.HasValue
            ? effectiveCacheRead.Value / (double)inputTokens
            : current?.CacheReadRatio;
        return new AgentRuntimeTokenUsage(
            inputTokens,
            effectiveOutputTokens,
            cachedInputTokens > 0 ? uncachedInputTokens : current?.BillableInputTokens,
            effectiveCacheRead,
            reasoningTokens > 0 ? reasoningTokens : current?.ReasoningTokens,
            inputTokens > 0 ? inputTokens : current?.ContextTokens,
            effectiveCacheCreation,
            cacheCreation5m > 0 ? cacheCreation5m : current?.CacheCreation5mTokens,
            cacheCreation1h > 0 ? cacheCreation1h : current?.CacheCreation1hTokens,
            cacheReadRatio);
    }

    private static string ToolResultToString(JsonElement content)
    {
        return AgentRuntimeProviderSupport.ToolResultToString(content);
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

    private static int ReadInt(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Number &&
            property.TryGetInt32(out var value))
        {
            return value;
        }
        return 0;
    }

    private static void MarkFirstToken(AnthropicParseState parseState, long startedAt)
    {
        parseState.FirstTokenMs ??= ElapsedMs(startedAt);
    }

    private static int EstimateTokenCount(string text)
    {
        return string.IsNullOrWhiteSpace(text) ? 0 : Math.Max(1, text.Length / 4);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenMs, long completedMs)
    {
        if (!firstTokenMs.HasValue || outputTokens <= 0)
        {
            return null;
        }
        var durationMs = completedMs - firstTokenMs.Value;
        return durationMs <= 0 ? null : outputTokens / (durationMs / 1000.0);
    }

    private sealed class AnthropicParseState
    {
        public StringBuilder AssistantText { get; } = new();
        public Dictionary<int, AnthropicToolBuffer> ToolBuffers { get; } = new();
        public List<AgentRuntimeNativeToolCall> ToolCalls { get; } = new();
        public HashSet<string> EmittedEncryptedReasoning { get; } = new(StringComparer.Ordinal);
        public long? FirstTokenMs { get; set; }
        public int EstimatedOutputTokens { get; set; }
        public AgentRuntimeTokenUsage? Usage { get; set; }
        public string StopReason { get; set; } = "end_turn";
    }

    private sealed class AnthropicToolBuffer
    {
        public AnthropicToolBuffer(string id, string name)
        {
            Id = id;
            Name = name;
        }

        public string Id { get; }
        public string Name { get; }
        public StringBuilder Arguments { get; } = new();
        public AgentRuntimeToolArgumentStreamState ArgumentStream { get; } = new();
    }

    private sealed class AnthropicCacheControlBudget
    {
        private int remaining;

        public AnthropicCacheControlBudget(bool enabled, string ttl)
        {
            remaining = enabled ? MaxAnthropicCacheControlBlocks : 0;
            Ttl = ttl;
        }

        public int Remaining => remaining;

        private string Ttl { get; }

        public bool TryUse(out string ttl)
        {
            ttl = Ttl;
            if (remaining <= 0)
            {
                return false;
            }
            remaining--;
            return true;
        }
    }
}
