internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private sealed class AnthropicMessageWriteState
    {
        private readonly AnthropicConversationValidationStats stats;
        private readonly HashSet<string> writtenToolUseIds = new(StringComparer.Ordinal);
        private readonly HashSet<string> writtenToolResultIds = new(StringComparer.Ordinal);
        private readonly HashSet<string> pendingToolUseIds = new(StringComparer.Ordinal);

        public AnthropicMessageWriteState(AnthropicConversationValidationStats stats)
        {
            this.stats = stats;
        }

        public void BeginMessage(string role)
        {
            if (role == "assistant")
            {
                pendingToolUseIds.Clear();
            }
        }

        public void EndMessage(string role)
        {
            if (role == "user")
            {
                pendingToolUseIds.Clear();
            }
        }

        public bool TryRecordToolUse(string toolUseId)
        {
            if (string.IsNullOrWhiteSpace(toolUseId))
            {
                stats.DroppedInvalidToolUses++;
                return false;
            }

            if (!writtenToolUseIds.Add(toolUseId))
            {
                stats.WriterDroppedDuplicateToolUses++;
                stats.AddDroppedToolUseId(toolUseId);
                return false;
            }

            stats.WrittenToolUses++;
            pendingToolUseIds.Add(toolUseId);
            return true;
        }

        public bool TryRecordToolResult(string toolUseId)
        {
            if (string.IsNullOrWhiteSpace(toolUseId))
            {
                DropInvalidToolResult();
                return false;
            }

            if (!pendingToolUseIds.Contains(toolUseId))
            {
                stats.WriterDroppedOrphanToolResults++;
                stats.AddDroppedToolResultId(toolUseId);
                return false;
            }

            if (!writtenToolResultIds.Add(toolUseId))
            {
                stats.WriterDroppedDuplicateToolResults++;
                stats.AddDroppedToolResultId(toolUseId);
                return false;
            }

            stats.WrittenToolResults++;
            return true;
        }

        public void DropInvalidToolResult()
        {
            stats.WriterDroppedInvalidToolResults++;
        }

        public void DropInvalidRoleToolBlocks(int count)
        {
            stats.WriterDroppedInvalidRoleToolBlocks += Math.Max(0, count);
        }
    }
}
