using System.Text.RegularExpressions;

namespace OpenCowork.Agent.Engine;

public sealed class CompressionConfig
{
    public bool Enabled { get; init; }
    public int ContextLength { get; init; }
    public double Threshold { get; init; } = 0.8;
    public double PreCompressThreshold { get; init; } = 0.65;
}

/// <summary>
/// Context compression logic for managing conversation length.
/// Two-tier: pre-compression (trim tool results/thinking) and
/// full compression (summarize via LLM with analysis/summary two-phase).
/// </summary>
public static class ContextCompression
{
    /// <summary>Number of recent messages to preserve after full compression.</summary>
    private const int PreserveRecentCount = 4;

    /// <summary>Max retry attempts for compression failures.</summary>
    private const int MaxRetries = 2;

    /// <summary>Max consecutive failures before circuit-breaking.</summary>
    private const int MaxConsecutiveFailures = 3;

    /// <summary>Circuit breaker counter (resets on success).</summary>
    private static int _consecutiveFailures;

    public static void ResetFailures() => _consecutiveFailures = 0;

    public static bool ShouldCompress(int inputTokens, CompressionConfig config)
    {
        if (!config.Enabled || config.ContextLength <= 0) return false;
        if (_consecutiveFailures >= MaxConsecutiveFailures) return false;
        return (double)inputTokens / config.ContextLength >= config.Threshold;
    }

    public static bool ShouldPreCompress(int inputTokens, CompressionConfig config)
    {
        if (!config.Enabled || config.ContextLength <= 0) return false;
        var ratio = (double)inputTokens / config.ContextLength;
        return ratio >= config.PreCompressThreshold && ratio < config.Threshold;
    }

    /// <summary>
    /// Pre-compress by replacing long tool results, thinking blocks, and image blocks
    /// in older messages. Preserves the last 6 messages. When the list exceeds 30 messages,
    /// drops the oldest non-system messages beyond the preserve window.
    /// Does not call the LLM.
    /// </summary>
    public static List<UnifiedMessage> PreCompressMessages(List<UnifiedMessage> messages)
    {
        if (messages.Count <= 6) return messages;

        var result = new List<UnifiedMessage>(messages.Count);
        var preserveFrom = messages.Count - 6;

        // When message list grows very large, drop oldest non-system messages
        var dropBefore = 0;
        if (messages.Count > 30)
        {
            dropBefore = messages.Count - 20;
        }

        for (var i = 0; i < messages.Count; i++)
        {
            var msg = messages[i];

            // Always keep system messages
            if (i < dropBefore && msg.Role != "system")
                continue;

            if (i >= preserveFrom)
            {
                result.Add(msg);
                continue;
            }

            var blocks = msg.Content;
            if (blocks is null || blocks.Count == 0)
            {
                result.Add(msg);
                continue;
            }

            var compressed = false;
            var newContent = new List<ContentBlock>();

            foreach (var block in blocks)
            {
                if (block is ToolResultBlock trb && trb.GetTextContent().Length > 200)
                {
                    newContent.Add(new ToolResultBlock
                    {
                        ToolUseId = trb.ToolUseId,
                        Content = "[Tool result compressed]",
                        IsError = trb.IsError
                    });
                    compressed = true;
                }
                else if (block is ThinkingBlock)
                {
                    newContent.Add(new TextBlock { Text = "[Thinking compressed]" });
                    compressed = true;
                }
                else if (block is ImageBlock)
                {
                    newContent.Add(new TextBlock { Text = "[image]" });
                    compressed = true;
                }
                else
                {
                    newContent.Add(block);
                }
            }

            if (compressed)
            {
                result.Add(new UnifiedMessage
                {
                    Id = msg.Id,
                    Role = msg.Role,
                    Content = newContent
                });
            }
            else
            {
                result.Add(msg);
            }
        }

        return result;
    }

    /// <summary>
    /// Full compression: summarize older conversation history via the LLM provider,
    /// preserving the most recent messages intact. Uses analysis/summary two-phase
    /// prompting and tool_use/tool_result pair protection.
    /// </summary>
    public static async Task<List<UnifiedMessage>> CompressMessagesAsync(
        List<UnifiedMessage> messages,
        Providers.ILlmProvider provider,
        ProviderConfig config,
        CancellationToken ct)
    {
        if (messages.Count <= PreserveRecentCount + 2) return messages;

        // Find safe boundary that doesn't split tool_use/tool_result pairs
        var boundaryIdx = FindSafeCompactBoundary(messages, messages.Count - PreserveRecentCount);
        var messagesToCompress = messages.Take(boundaryIdx).ToList();
        var messagesToPreserve = messages.Skip(boundaryIdx).ToList();

        if (messagesToCompress.Count < 2) return messages;

        // Retry with exponential backoff
        Exception? lastError = null;
        for (var attempt = 0; attempt <= MaxRetries; attempt++)
        {
            try
            {
                var inputMessages = attempt == 0
                    ? messagesToCompress
                    : TruncateOldestMessages(messagesToCompress, attempt);

                var serialized = SerializeMessages(inputMessages);

                var summaryRequest = new List<UnifiedMessage>
                {
                    new()
                    {
                        Role = "user",
                        Content = new List<ContentBlock>
                        {
                            new TextBlock
                            {
                                Text = $"""
                                Please create a detailed summary of the following conversation history.
                                This summary will REPLACE the original messages, so nothing important can be lost.

                                ---
                                {serialized}
                                """
                            }
                        }
                    }
                };

                var summaryConfig = new ProviderConfig
                {
                    Type = config.Type,
                    ApiKey = config.ApiKey,
                    BaseUrl = config.BaseUrl,
                    Model = config.Model,
                    MaxTokens = 8000,
                    SystemPrompt = CompactSystemPrompt,
                    ResponsesSessionScope = "context-compression",
                    WebsocketUrl = config.WebsocketUrl,
                    WebsocketMode = "disabled"
                };

                var summaryBuilder = new System.Text.StringBuilder();
                await foreach (var evt in provider.SendMessageAsync(
                    summaryRequest, [], summaryConfig, ct))
                {
                    if (evt.Type == "text_delta" && evt.Text is not null)
                        summaryBuilder.Append(evt.Text);
                }

                var rawSummary = summaryBuilder.ToString();
                var summary = FormatCompactSummary(rawSummary);

                if (string.IsNullOrWhiteSpace(summary))
                    throw new InvalidOperationException("Compression returned empty summary");

                // Reset circuit breaker on success
                _consecutiveFailures = 0;

                // Build result: system message + boundary + summary + preserved messages
                var result = new List<UnifiedMessage>();

                var systemMsg = messages.FirstOrDefault(m => m.Role == "system");
                if (systemMsg is not null) result.Add(systemMsg);

                result.Add(new UnifiedMessage
                {
                    Role = "user",
                    Content = new List<ContentBlock>
                    {
                        new TextBlock
                        {
                            Text = $"[Context Memory Compressed Summary]\n\nThis session continues from a previous conversation. The following summary covers {messagesToCompress.Count} earlier messages. Recent messages are preserved verbatim after this summary.\n\n{summary}"
                        }
                    }
                });

                result.AddRange(messagesToPreserve);
                return result;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                lastError = ex;
                if (attempt < MaxRetries)
                {
                    await Task.Delay(1500 * (int)Math.Pow(2, attempt), ct);
                }
            }
        }

        // All retries exhausted — circuit breaker
        _consecutiveFailures++;
        Console.Error.WriteLine(
            $"[ContextCompression] All retries failed (consecutive: {_consecutiveFailures}/{MaxConsecutiveFailures}): {lastError?.Message}");

        return messages;
    }

    /// <summary>
    /// Find a safe boundary that doesn't split tool_use/tool_result pairs.
    /// </summary>
    private static int FindSafeCompactBoundary(List<UnifiedMessage> messages, int initialBoundary)
    {
        var boundary = Math.Max(1, Math.Min(initialBoundary, messages.Count - 1));

        for (var attempts = 0; attempts < 10; attempts++)
        {
            var compressedToolUseIds = new HashSet<string>();
            for (var i = 0; i < boundary; i++)
            {
                var msg = messages[i];
                if (msg.Content is null) continue;
                foreach (var block in msg.Content)
                {
                    if (block is ToolUseBlock tub && tub.Id is not null)
                        compressedToolUseIds.Add(tub.Id);
                }
            }

            var hasSplit = false;
            for (var i = boundary; i < messages.Count && !hasSplit; i++)
            {
                var msg = messages[i];
                if (msg.Content is null) continue;
                foreach (var block in msg.Content)
                {
                    if (block is ToolResultBlock trb && trb.ToolUseId is not null
                        && compressedToolUseIds.Contains(trb.ToolUseId))
                    {
                        hasSplit = true;
                        break;
                    }
                }
            }

            if (!hasSplit) return boundary;
            boundary = Math.Max(1, boundary - 1);
        }

        return boundary;
    }

    /// <summary>
    /// Truncate oldest non-system messages for retry attempts.
    /// </summary>
    private static List<UnifiedMessage> TruncateOldestMessages(List<UnifiedMessage> messages, int attempt)
    {
        var dropCount = (int)Math.Ceiling(messages.Count * 0.25 * attempt);
        var result = new List<UnifiedMessage>();
        var dropped = 0;
        var isFirst = true;
        foreach (var msg in messages)
        {
            if (msg.Role == "system" || (isFirst && msg.Role == "user"))
            {
                result.Add(msg);
                isFirst = false;
                continue;
            }
            isFirst = false;
            if (dropped < dropCount)
            {
                dropped++;
                continue;
            }
            result.Add(msg);
        }
        return result.Count >= 2 ? result : messages;
    }

    /// <summary>
    /// Strip analysis drafting scratchpad and extract summary content.
    /// </summary>
    private static string FormatCompactSummary(string rawSummary)
    {
        var result = rawSummary;

        // Strip <analysis> section
        result = Regex.Replace(result, @"<analysis>[\s\S]*?</analysis>", "", RegexOptions.IgnoreCase);

        // Extract <summary> content
        var match = Regex.Match(result, @"<summary>([\s\S]*?)</summary>", RegexOptions.IgnoreCase);
        if (match.Success)
        {
            result = match.Groups[1].Value;
        }

        // Clean up whitespace
        result = Regex.Replace(result, @"\n\n+", "\n\n").Trim();
        return result;
    }

    private static string SerializeMessages(List<UnifiedMessage> messages)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var msg in messages)
        {
            sb.Append($"[{msg.Role.ToUpperInvariant()}]: ");
            sb.AppendLine(msg.GetTextContent());
        }
        return sb.ToString();
    }

    private const string CompactSystemPrompt = """
        You are a precision memory compressor for an AI coding assistant.
        Your job is to create an EXTREMELY DETAILED structured summary of a conversation history.
        This summary will REPLACE the original messages, so NOTHING important can be lost.

        ## Critical Rules
        1. You MUST preserve ALL file paths, function names, variable names, and code snippets mentioned.
        2. You MUST preserve the COMPLETE current task status — what is done, what is in progress, what is pending.
        3. You MUST preserve ALL technical decisions and their reasoning.
        4. You MUST preserve ALL errors encountered and their resolutions.
        5. You MUST preserve any Todo/task list with exact status of each item.
        6. If code was written or modified, summarize the EXACT changes (function signatures, logic, imports added).
        7. Do NOT generalize or hand-wave. Be specific. Use exact names, paths, and values.
        8. Write in the same language as the conversation.
        9. Pay special attention to specific user feedback — especially if the user told you to do something differently.

        ## Process

        Before providing your final summary, wrap your detailed analysis in <analysis> tags:

        1. Chronologically analyze each section of the conversation. For each section identify:
           - The user's explicit requests and intents
           - Key decisions, technical concepts and code patterns
           - Specific details: file names, code snippets, function signatures
           - Errors encountered and how they were fixed
           - User feedback, especially corrections
        2. Double-check for technical accuracy and completeness.

        Then provide your final summary inside <summary> tags.

        ## Output Format

        <analysis>
        [Your detailed thought process]
        </analysis>

        <summary>
        ## 1. Primary Request and Intent
        Capture ALL of the user's explicit requests and intents.

        ## 2. Key Technical Concepts
        List all important technical concepts, technologies, and frameworks.

        ## 3. Files and Code Sections
        Enumerate specific files and code sections with code snippets.

        ## 4. Errors and Fixes
        List all errors encountered and their resolutions.

        ## 5. Problem Solving
        Document problems solved and ongoing troubleshooting.

        ## 6. All User Messages
        List ALL user messages that are NOT tool results.

        ## 7. Pending Tasks
        Outline pending tasks with exact status.

        ## 8. Current Work
        Describe precisely what was being worked on before this summary.

        ## 9. Optional Next Step
        List the next step in line with the user's most recent request.
        Include direct quotes from the conversation.
        </summary>
        """;
}
