using System.Text.Json;

internal static partial class AgentRuntimeAnthropicMessagesProvider
{
    private static readonly bool ValidateAnthropicRequestBody =
        ReadAnthropicValidationBooleanEnvironment("OPEN_COWORK_NATIVE_VALIDATE_ANTHROPIC_BODY") ?? true;

    private static void ValidateAnthropicRequestBodyToolReplay(string body)
    {
        if (!ValidateAnthropicRequestBody)
        {
            return;
        }

        using var document = JsonDocument.Parse(body);
        if (!document.RootElement.TryGetProperty("messages", out var messages) ||
            messages.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        var pendingToolUseIds = new HashSet<string>(StringComparer.Ordinal);
        var orphanToolResultIds = new List<string>();
        var missingToolResultIds = new List<string>();
        var pendingMessageIndex = -1;
        var messageIndex = 0;
        foreach (var message in messages.EnumerateArray())
        {
            var role = JsonHelpers.GetString(message, "role") ?? "user";
            if (role == "assistant")
            {
                AddMissingToolResults(missingToolResultIds, pendingMessageIndex, pendingToolUseIds);
                pendingToolUseIds.Clear();
                if (message.TryGetProperty("content", out var assistantContent) &&
                    assistantContent.ValueKind == JsonValueKind.Array)
                {
                    foreach (var block in assistantContent.EnumerateArray())
                    {
                        if (JsonHelpers.GetString(block, "type") == "tool_use" &&
                            JsonHelpers.GetString(block, "id") is { Length: > 0 } id)
                        {
                            pendingToolUseIds.Add(id);
                        }
                    }
                }
                pendingMessageIndex = pendingToolUseIds.Count > 0 ? messageIndex : -1;
                messageIndex++;
                continue;
            }

            var sawToolResult = false;
            var currentToolResultIds = new HashSet<string>(StringComparer.Ordinal);
            if (message.TryGetProperty("content", out var userContent) &&
                userContent.ValueKind == JsonValueKind.Array)
            {
                foreach (var block in userContent.EnumerateArray())
                {
                    if (JsonHelpers.GetString(block, "type") != "tool_result")
                    {
                        continue;
                    }
                    sawToolResult = true;
                    var toolUseId = JsonHelpers.GetString(block, "tool_use_id") ?? string.Empty;
                    if (toolUseId.Length > 0)
                    {
                        currentToolResultIds.Add(toolUseId);
                    }
                    if (pendingToolUseIds.Count == 0 || !pendingToolUseIds.Contains(toolUseId))
                    {
                        AddValidationId(orphanToolResultIds, $"{messageIndex}:{toolUseId}");
                    }
                }
            }

            if (pendingToolUseIds.Count > 0)
            {
                foreach (var id in pendingToolUseIds)
                {
                    if (!currentToolResultIds.Contains(id))
                    {
                        AddValidationId(missingToolResultIds, $"{pendingMessageIndex}:{id}");
                    }
                }
                pendingToolUseIds.Clear();
                pendingMessageIndex = -1;
            }
            else if (sawToolResult)
            {
                pendingMessageIndex = -1;
            }
            messageIndex++;
        }

        AddMissingToolResults(missingToolResultIds, pendingMessageIndex, pendingToolUseIds);

        if (orphanToolResultIds.Count == 0 && missingToolResultIds.Count == 0)
        {
            return;
        }

        var orphanDetails = string.Join(",", orphanToolResultIds);
        var missingDetails = string.Join(",", missingToolResultIds);
        WorkerLog.Warn(
            $"anthropic messages request body rejected locally " +
            $"orphanToolResults=[{orphanDetails}] missingToolResults=[{missingDetails}]");
        throw new InvalidOperationException(
            "Anthropic Messages request validation failed before send: " +
            $"orphan tool_result ids [{orphanDetails}], missing tool_result ids [{missingDetails}]");
    }

    private static void AddMissingToolResults(
        List<string> missingToolResultIds,
        int messageIndex,
        HashSet<string> pendingToolUseIds)
    {
        if (pendingToolUseIds.Count == 0)
        {
            return;
        }

        foreach (var id in pendingToolUseIds)
        {
            AddValidationId(missingToolResultIds, $"{messageIndex}:{id}");
        }
    }

    private static void AddValidationId(List<string> ids, string id)
    {
        if (ids.Count >= 8 || ids.Contains(id, StringComparer.Ordinal))
        {
            return;
        }
        ids.Add(id);
    }

    private static bool? ReadAnthropicValidationBooleanEnvironment(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (raw is null)
        {
            return null;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => null
        };
    }
}
