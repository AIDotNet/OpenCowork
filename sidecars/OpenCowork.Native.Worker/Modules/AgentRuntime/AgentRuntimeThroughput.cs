/// <summary>
/// Shared tokens-per-second math for all provider runtimes.
///
/// TPS is defined as tokens generated inside the observed streaming window
/// (first received token -> request end) divided by that window. The subtlety is
/// reasoning: some models burn reasoning tokens *before* the first visible token
/// (hidden reasoning lives inside TTFT), so counting them against the shorter
/// window would wildly inflate the rate. Reasoning tokens are therefore counted
/// only when the reasoning phase actually streamed inside the window.
/// </summary>
internal static class AgentRuntimeThroughput
{
    /// <summary>
    /// Windows shorter than this produce noise, not throughput (e.g. non-streaming
    /// JSON responses where the "first token" is only seen at parse time).
    /// </summary>
    private const long MinWindowMs = 250;

    /// <param name="usage">Provider-reported usage; falls back to <paramref name="estimatedOutputTokens"/> when absent.</param>
    /// <param name="estimatedOutputTokens">Streamed-text estimate used when the provider reports no usage.</param>
    /// <param name="reasoningStreamed">True when reasoning/thinking deltas streamed inside the measured window.</param>
    /// <param name="usageIncludesReasoning">
    /// True when <c>usage.OutputTokens</c> already contains reasoning tokens
    /// (OpenAI completion_tokens, Anthropic output_tokens). False when reasoning is
    /// reported separately (Gemini candidatesTokenCount vs thoughtsTokenCount).
    /// </param>
    public static double? ComputeTps(
        AgentRuntimeTokenUsage? usage,
        int estimatedOutputTokens,
        bool reasoningStreamed,
        bool usageIncludesReasoning,
        long? firstTokenMs,
        long totalMs)
    {
        if (!firstTokenMs.HasValue)
        {
            return null;
        }

        var tokens = ResolveGeneratedTokens(
            usage,
            estimatedOutputTokens,
            reasoningStreamed,
            usageIncludesReasoning);
        if (tokens <= 0)
        {
            return null;
        }

        var durationMs = totalMs - firstTokenMs.Value;
        return durationMs < MinWindowMs ? null : Math.Round(tokens / (durationMs / 1000.0), 2);
    }

    private static int ResolveGeneratedTokens(
        AgentRuntimeTokenUsage? usage,
        int estimatedOutputTokens,
        bool reasoningStreamed,
        bool usageIncludesReasoning)
    {
        if (usage is null || usage.OutputTokens <= 0)
        {
            return estimatedOutputTokens;
        }

        var reasoningTokens = Math.Max(0, usage.ReasoningTokens ?? 0);
        if (usageIncludesReasoning)
        {
            // Hidden reasoning happened before the window opened: count visible tokens only.
            return reasoningStreamed
                ? usage.OutputTokens
                : Math.Max(0, usage.OutputTokens - reasoningTokens);
        }

        // Usage reports reasoning separately: add it back when thoughts streamed in-window.
        return reasoningStreamed
            ? usage.OutputTokens + reasoningTokens
            : usage.OutputTokens;
    }

    /// <summary>
    /// Rough token estimate for streamed text, used only when the provider reports no
    /// usage. ASCII averages ~4 chars/token; CJK and other non-ASCII scripts average
    /// ~1.5 chars/token, so a flat length/4 undercounts them severely.
    /// </summary>
    public static int EstimateTokens(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return 0;
        }

        var asciiChars = 0;
        var wideChars = 0;
        foreach (var ch in text)
        {
            if (ch <= 0x7F)
            {
                asciiChars++;
            }
            else
            {
                wideChars++;
            }
        }

        return Math.Max(1, (int)Math.Round(asciiChars / 4.0 + wideChars / 1.5));
    }
}
