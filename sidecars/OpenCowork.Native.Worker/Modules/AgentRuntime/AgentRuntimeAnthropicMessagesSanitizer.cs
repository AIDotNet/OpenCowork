using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private static IReadOnlyList<AgentRuntimeChatMessage> SanitizeAnthropicConversation(
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        out AnthropicConversationValidationStats stats)
    {
        stats = new AnthropicConversationValidationStats(conversation.Count);
        if (conversation.Count == 0)
        {
            return conversation;
        }

        var matchedToolUseIds = FindMatchedAnthropicToolUseIds(conversation);
        var emittedToolUseIds = new HashSet<string>(StringComparer.Ordinal);
        var emittedToolResultIds = new HashSet<string>(StringComparer.Ordinal);
        var sanitized = new List<AgentRuntimeChatMessage>(conversation.Count);

        foreach (var message in conversation)
        {
            if (message.Role == "system")
            {
                sanitized.Add(message);
                continue;
            }

            var role = message.Role == "assistant" ? "assistant" : "user";
            var sanitizedMessage = message.ContentBlocks is { Count: > 0 } blocks
                ? SanitizeAnthropicContentBlocksMessage(
                    message,
                    role,
                    blocks,
                    matchedToolUseIds,
                    emittedToolUseIds,
                    emittedToolResultIds,
                    stats)
                : SanitizeAnthropicLegacyMessage(
                    message,
                    role,
                    matchedToolUseIds,
                    emittedToolUseIds,
                    emittedToolResultIds,
                    stats);

            if (sanitizedMessage is not null)
            {
                sanitized.Add(sanitizedMessage);
                continue;
            }

            stats.DroppedEmptyMessages++;
        }

        var normalized = MergeAnthropicToolResultBatches(sanitized, stats);
        stats.OutputMessages = normalized.Count;
        return stats.HasDrops || stats.MergedToolResultMessages > 0 ? normalized : conversation;
    }

    private static HashSet<string> FindMatchedAnthropicToolUseIds(
        IReadOnlyList<AgentRuntimeChatMessage> conversation)
    {
        var matchedToolUseIds = new HashSet<string>(StringComparer.Ordinal);

        for (var index = 0; index < conversation.Count; index++)
        {
            var message = conversation[index];
            var role = message.Role == "assistant" ? "assistant" : "user";
            if (role != "assistant")
            {
                continue;
            }

            var toolUseIds = EnumerateAnthropicAssistantToolUseIds(message).ToHashSet(StringComparer.Ordinal);
            if (toolUseIds.Count == 0)
            {
                continue;
            }

            for (var candidateIndex = index + 1; candidateIndex < conversation.Count; candidateIndex++)
            {
                var candidate = conversation[candidateIndex];
                if (candidate.Role == "system")
                {
                    continue;
                }

                var candidateRole = candidate.Role == "assistant" ? "assistant" : "user";
                if (candidateRole != "user" || !HasAnthropicToolResultContent(candidate))
                {
                    break;
                }

                foreach (var id in EnumerateAnthropicUserToolResultIds(candidate))
                {
                    if (toolUseIds.Contains(id))
                    {
                        matchedToolUseIds.Add(id);
                    }
                }
            }
        }

        return matchedToolUseIds;
    }

    private static IReadOnlyList<AgentRuntimeChatMessage> MergeAnthropicToolResultBatches(
        IReadOnlyList<AgentRuntimeChatMessage> conversation,
        AnthropicConversationValidationStats stats)
    {
        var merged = new List<AgentRuntimeChatMessage>(conversation.Count);
        for (var index = 0; index < conversation.Count; index++)
        {
            var message = conversation[index];
            merged.Add(message);
            if ((message.Role == "assistant" ? "assistant" : "user") != "assistant")
            {
                continue;
            }

            var expectedToolUseIds = EnumerateAnthropicAssistantToolUseIds(message)
                .ToHashSet(StringComparer.Ordinal);
            if (expectedToolUseIds.Count == 0)
            {
                continue;
            }

            var batch = new List<AgentRuntimeToolResult>();
            var batchText = new StringBuilder();
            var batchIds = new HashSet<string>(StringComparer.Ordinal);
            var scanIndex = index + 1;
            var consumedMessages = 0;
            for (; scanIndex < conversation.Count; scanIndex++)
            {
                var candidate = conversation[scanIndex];
                if (candidate.Role == "system")
                {
                    merged.Add(candidate);
                    consumedMessages++;
                    continue;
                }

                var candidateRole = candidate.Role == "assistant" ? "assistant" : "user";
                if (candidateRole != "user" || !HasAnthropicToolResultContent(candidate))
                {
                    break;
                }

                foreach (var toolResult in ExtractAnthropicToolResults(candidate))
                {
                    if (expectedToolUseIds.Contains(toolResult.ToolUseId) &&
                        batchIds.Add(toolResult.ToolUseId))
                    {
                        batch.Add(toolResult);
                    }
                }

                if (!string.IsNullOrWhiteSpace(candidate.Text))
                {
                    if (batchText.Length > 0)
                    {
                        batchText.Append('\n');
                    }
                    batchText.Append(candidate.Text);
                }
                consumedMessages++;
            }

            if (batch.Count == 0)
            {
                index += consumedMessages;
                continue;
            }

            merged.Add(new AgentRuntimeChatMessage(
                "user",
                batchText.ToString(),
                [],
                batch));
            if (consumedMessages > 1)
            {
                stats.MergedToolResultMessages += consumedMessages - 1;
            }
            index = scanIndex - 1;
        }

        return stats.MergedToolResultMessages > 0 ? merged : conversation;
    }

    private static IEnumerable<string> EnumerateAnthropicAssistantToolUseIds(
        AgentRuntimeChatMessage message)
    {
        if (message.ContentBlocks is { Count: > 0 } blocks)
        {
            foreach (var block in blocks)
            {
                if (JsonHelpers.GetString(block, "type") == "tool_use" &&
                    JsonHelpers.GetString(block, "id") is { Length: > 0 } id &&
                    JsonHelpers.GetString(block, "name") is { Length: > 0 })
                {
                    yield return id;
                }
            }
            yield break;
        }

        foreach (var toolUse in message.ToolUses)
        {
            if (!string.IsNullOrWhiteSpace(toolUse.Id) &&
                !string.IsNullOrWhiteSpace(toolUse.Name))
            {
                yield return toolUse.Id;
            }
        }
    }

    private static bool HasAnthropicToolResultContent(AgentRuntimeChatMessage message)
    {
        if (message.ContentBlocks is { Count: > 0 } blocks)
        {
            foreach (var block in blocks)
            {
                if (JsonHelpers.GetString(block, "type") == "tool_result")
                {
                    return true;
                }
            }
            return false;
        }

        return message.ToolResults.Count > 0;
    }

    private static IEnumerable<string> EnumerateAnthropicUserToolResultIds(
        AgentRuntimeChatMessage message)
    {
        if (message.ContentBlocks is { Count: > 0 } blocks)
        {
            foreach (var block in blocks)
            {
                if (JsonHelpers.GetString(block, "type") == "tool_result" &&
                    ReadAnthropicToolResultId(block) is { Length: > 0 } id)
                {
                    yield return id;
                }
            }
            yield break;
        }

        foreach (var toolResult in message.ToolResults)
        {
            if (!string.IsNullOrWhiteSpace(toolResult.ToolUseId))
            {
                yield return toolResult.ToolUseId;
            }
        }
    }

    private static IEnumerable<AgentRuntimeToolResult> ExtractAnthropicToolResults(
        AgentRuntimeChatMessage message)
    {
        if (message.ContentBlocks is { Count: > 0 } blocks)
        {
            foreach (var block in blocks)
            {
                if (JsonHelpers.GetString(block, "type") != "tool_result" ||
                    ReadAnthropicToolResultId(block) is not { Length: > 0 } id)
                {
                    continue;
                }

                var content = block.TryGetProperty("content", out var contentElement)
                    ? contentElement.Clone()
                    : AgentRuntimeProviderSupport.CreateStringElement(string.Empty);
                yield return new AgentRuntimeToolResult(
                    id,
                    content,
                    JsonHelpers.GetBool(block, "isError", false) ? true : null);
            }
            yield break;
        }

        foreach (var toolResult in message.ToolResults)
        {
            yield return toolResult;
        }
    }

    private static AgentRuntimeChatMessage? SanitizeAnthropicContentBlocksMessage(
        AgentRuntimeChatMessage message,
        string role,
        IReadOnlyList<JsonElement> blocks,
        HashSet<string> matchedToolUseIds,
        HashSet<string> emittedToolUseIds,
        HashSet<string> emittedToolResultIds,
        AnthropicConversationValidationStats stats)
    {
        var sanitizedBlocks = new List<JsonElement>(blocks.Count);
        foreach (var block in blocks)
        {
            switch (JsonHelpers.GetString(block, "type"))
            {
                case "tool_use":
                    if (role != "assistant")
                    {
                        stats.DroppedInvalidRoleToolBlocks++;
                        continue;
                    }
                    if (ReadAnthropicToolUse(block) is not { } toolUse)
                    {
                        stats.DroppedInvalidToolUses++;
                        continue;
                    }
                    if (!matchedToolUseIds.Contains(toolUse.Id))
                    {
                        stats.DroppedUnpairedToolUses++;
                        stats.AddDroppedToolUseId(toolUse.Id);
                        continue;
                    }
                    if (!emittedToolUseIds.Add(toolUse.Id))
                    {
                        stats.DroppedDuplicateToolUses++;
                        stats.AddDroppedToolUseId(toolUse.Id);
                        continue;
                    }
                    sanitizedBlocks.Add(block);
                    stats.ToolUses++;
                    continue;
                case "tool_result":
                    if (role != "user")
                    {
                        stats.DroppedInvalidRoleToolBlocks++;
                        continue;
                    }
                    if (!TryKeepAnthropicToolResultBlock(
                            block,
                            matchedToolUseIds,
                            emittedToolUseIds,
                            emittedToolResultIds,
                            stats))
                    {
                        continue;
                    }
                    sanitizedBlocks.Add(block);
                    stats.ToolResults++;
                    continue;
                default:
                    if (IsAnthropicWritableNonToolBlock(block))
                    {
                        sanitizedBlocks.Add(block);
                    }
                    continue;
            }
        }

        if (sanitizedBlocks.Count == 0)
        {
            return null;
        }

        return new AgentRuntimeChatMessage(
            message.Role,
            message.Text,
            [],
            [],
            message.ProviderResponseId,
            sanitizedBlocks);
    }

    private static AgentRuntimeChatMessage? SanitizeAnthropicLegacyMessage(
        AgentRuntimeChatMessage message,
        string role,
        HashSet<string> matchedToolUseIds,
        HashSet<string> emittedToolUseIds,
        HashSet<string> emittedToolResultIds,
        AnthropicConversationValidationStats stats)
    {
        var toolUses = new List<AgentRuntimeChatToolUse>();
        var toolResults = new List<AgentRuntimeToolResult>();
        var hasText = !string.IsNullOrWhiteSpace(message.Text);

        if (role == "assistant")
        {
            foreach (var toolUse in message.ToolUses)
            {
                if (string.IsNullOrWhiteSpace(toolUse.Id) ||
                    string.IsNullOrWhiteSpace(toolUse.Name))
                {
                    stats.DroppedInvalidToolUses++;
                    continue;
                }
                if (!matchedToolUseIds.Contains(toolUse.Id))
                {
                    stats.DroppedUnpairedToolUses++;
                    stats.AddDroppedToolUseId(toolUse.Id);
                    continue;
                }
                if (!emittedToolUseIds.Add(toolUse.Id))
                {
                    stats.DroppedDuplicateToolUses++;
                    stats.AddDroppedToolUseId(toolUse.Id);
                    continue;
                }
                toolUses.Add(toolUse);
                stats.ToolUses++;
            }
        }
        else
        {
            foreach (var toolResult in message.ToolResults)
            {
                if (!TryKeepAnthropicToolResult(
                        toolResult,
                        matchedToolUseIds,
                        emittedToolUseIds,
                        emittedToolResultIds,
                        stats))
                {
                    continue;
                }
                toolResults.Add(toolResult);
                stats.ToolResults++;
            }
            if (message.ToolUses.Count > 0)
            {
                stats.DroppedInvalidRoleToolBlocks += message.ToolUses.Count;
            }
        }

        if (!hasText && toolUses.Count == 0 && toolResults.Count == 0)
        {
            return null;
        }

        return new AgentRuntimeChatMessage(
            message.Role,
            hasText ? message.Text : string.Empty,
            toolUses,
            toolResults,
            message.ProviderResponseId);
    }

    private static bool TryKeepAnthropicToolResultBlock(
        JsonElement block,
        HashSet<string> matchedToolUseIds,
        HashSet<string> emittedToolUseIds,
        HashSet<string> emittedToolResultIds,
        AnthropicConversationValidationStats stats)
    {
        var toolUseId = ReadAnthropicToolResultId(block);
        if (string.IsNullOrWhiteSpace(toolUseId))
        {
            stats.DroppedInvalidToolResults++;
            return false;
        }

        return TryKeepAnthropicToolResultId(
            toolUseId,
            matchedToolUseIds,
            emittedToolUseIds,
            emittedToolResultIds,
            stats);
    }

    private static bool TryKeepAnthropicToolResult(
        AgentRuntimeToolResult toolResult,
        HashSet<string> matchedToolUseIds,
        HashSet<string> emittedToolUseIds,
        HashSet<string> emittedToolResultIds,
        AnthropicConversationValidationStats stats)
    {
        if (string.IsNullOrWhiteSpace(toolResult.ToolUseId))
        {
            stats.DroppedInvalidToolResults++;
            return false;
        }

        return TryKeepAnthropicToolResultId(
            toolResult.ToolUseId,
            matchedToolUseIds,
            emittedToolUseIds,
            emittedToolResultIds,
            stats);
    }

    private static bool TryKeepAnthropicToolResultId(
        string toolUseId,
        HashSet<string> matchedToolUseIds,
        HashSet<string> emittedToolUseIds,
        HashSet<string> emittedToolResultIds,
        AnthropicConversationValidationStats stats)
    {
        if (!matchedToolUseIds.Contains(toolUseId) || !emittedToolUseIds.Contains(toolUseId))
        {
            stats.DroppedOrphanToolResults++;
            stats.AddDroppedToolResultId(toolUseId);
            return false;
        }

        if (!emittedToolResultIds.Add(toolUseId))
        {
            stats.DroppedDuplicateToolResults++;
            stats.AddDroppedToolResultId(toolUseId);
            return false;
        }

        return true;
    }

    private static string? ReadAnthropicToolResultId(JsonElement block)
    {
        return JsonHelpers.GetString(block, "toolUseId") ??
            JsonHelpers.GetString(block, "tool_use_id");
    }

    private static bool IsAnthropicWritableNonToolBlock(JsonElement block)
    {
        return JsonHelpers.GetString(block, "type") switch
        {
            "text" => !string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "text")),
            "thinking" => !string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "thinking")) ||
                !string.IsNullOrWhiteSpace(JsonHelpers.GetString(block, "encryptedContent")),
            "image" => block.TryGetProperty("source", out var source) &&
                source.ValueKind == JsonValueKind.Object,
            _ => false
        };
    }

    private static void LogAnthropicConversationValidation(
        AnthropicConversationValidationStats stats,
        string model)
    {
        if (!stats.HasDrops)
        {
            WorkerLog.Debug(
                $"anthropic messages shape model={FormatAnthropicLogValue(model)} " +
                $"messages={stats.InputMessages}->{stats.OutputMessages} " +
                $"writtenMessages={stats.WrittenMessages} " +
                $"toolUses={stats.ToolUses} toolResults={stats.ToolResults} " +
                $"writtenToolUses={stats.WrittenToolUses} writtenToolResults={stats.WrittenToolResults} " +
                $"mergedToolResultMessages={stats.MergedToolResultMessages}");
            return;
        }

        WorkerLog.Warn(
            $"anthropic messages sanitized model={FormatAnthropicLogValue(model)} " +
            $"messages={stats.InputMessages}->{stats.OutputMessages} " +
            $"writtenMessages={stats.WrittenMessages} " +
            $"toolUses={stats.ToolUses} toolResults={stats.ToolResults} " +
            $"writtenToolUses={stats.WrittenToolUses} writtenToolResults={stats.WrittenToolResults} " +
            $"droppedOrphanToolResults={stats.DroppedOrphanToolResults} " +
            $"droppedUnpairedToolUses={stats.DroppedUnpairedToolUses} " +
            $"droppedDuplicateToolResults={stats.DroppedDuplicateToolResults} " +
            $"droppedDuplicateToolUses={stats.DroppedDuplicateToolUses} " +
            $"droppedInvalidToolResults={stats.DroppedInvalidToolResults} " +
            $"droppedInvalidToolUses={stats.DroppedInvalidToolUses} " +
            $"droppedInvalidRoleToolBlocks={stats.DroppedInvalidRoleToolBlocks} " +
            $"droppedEmptyMessages={stats.DroppedEmptyMessages} " +
            $"mergedToolResultMessages={stats.MergedToolResultMessages} " +
            $"writerDroppedOrphanToolResults={stats.WriterDroppedOrphanToolResults} " +
            $"writerDroppedDuplicateToolResults={stats.WriterDroppedDuplicateToolResults} " +
            $"writerDroppedDuplicateToolUses={stats.WriterDroppedDuplicateToolUses} " +
            $"writerDroppedInvalidToolResults={stats.WriterDroppedInvalidToolResults} " +
            $"writerDroppedInvalidRoleToolBlocks={stats.WriterDroppedInvalidRoleToolBlocks} " +
            $"writerDroppedEmptyMessages={stats.WriterDroppedEmptyMessages} " +
            $"toolResultIds={stats.FormatDroppedToolResultIds()} " +
            $"toolUseIds={stats.FormatDroppedToolUseIds()}");
    }

    private static string FormatAnthropicLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "<empty>" : value;
    }

    private sealed class AnthropicConversationValidationStats
    {
        private const int MaxLoggedIds = 8;
        private readonly List<string> droppedToolResultIds = [];
        private readonly List<string> droppedToolUseIds = [];

        public AnthropicConversationValidationStats(int inputMessages)
        {
            InputMessages = inputMessages;
            OutputMessages = inputMessages;
        }

        public int InputMessages { get; }

        public int OutputMessages { get; set; }

        public int WrittenMessages { get; set; }

        public int ToolUses { get; set; }

        public int ToolResults { get; set; }

        public int WrittenToolUses { get; set; }

        public int WrittenToolResults { get; set; }

        public int DroppedOrphanToolResults { get; set; }

        public int DroppedUnpairedToolUses { get; set; }

        public int DroppedDuplicateToolResults { get; set; }

        public int DroppedDuplicateToolUses { get; set; }

        public int DroppedInvalidToolResults { get; set; }

        public int DroppedInvalidToolUses { get; set; }

        public int DroppedInvalidRoleToolBlocks { get; set; }

        public int DroppedEmptyMessages { get; set; }

        public int MergedToolResultMessages { get; set; }

        public int WriterDroppedOrphanToolResults { get; set; }

        public int WriterDroppedDuplicateToolResults { get; set; }

        public int WriterDroppedDuplicateToolUses { get; set; }

        public int WriterDroppedInvalidToolResults { get; set; }

        public int WriterDroppedInvalidRoleToolBlocks { get; set; }

        public int WriterDroppedEmptyMessages { get; set; }

        public bool HasDrops =>
            DroppedOrphanToolResults > 0 ||
            DroppedUnpairedToolUses > 0 ||
            DroppedDuplicateToolResults > 0 ||
            DroppedDuplicateToolUses > 0 ||
            DroppedInvalidToolResults > 0 ||
            DroppedInvalidToolUses > 0 ||
            DroppedInvalidRoleToolBlocks > 0 ||
            DroppedEmptyMessages > 0 ||
            WriterDroppedOrphanToolResults > 0 ||
            WriterDroppedDuplicateToolResults > 0 ||
            WriterDroppedDuplicateToolUses > 0 ||
            WriterDroppedInvalidToolResults > 0 ||
            WriterDroppedInvalidRoleToolBlocks > 0 ||
            WriterDroppedEmptyMessages > 0;

        public void AddDroppedToolResultId(string id)
        {
            AddDroppedId(droppedToolResultIds, id);
        }

        public void AddDroppedToolUseId(string id)
        {
            AddDroppedId(droppedToolUseIds, id);
        }

        public string FormatDroppedToolResultIds()
        {
            return FormatDroppedIds(droppedToolResultIds);
        }

        public string FormatDroppedToolUseIds()
        {
            return FormatDroppedIds(droppedToolUseIds);
        }

        private static void AddDroppedId(List<string> ids, string id)
        {
            if (ids.Count >= MaxLoggedIds || ids.Contains(id, StringComparer.Ordinal))
            {
                return;
            }
            ids.Add(id);
        }

        private static string FormatDroppedIds(IReadOnlyList<string> ids)
        {
            return ids.Count == 0 ? "[]" : $"[{string.Join(",", ids)}]";
        }
    }
}
