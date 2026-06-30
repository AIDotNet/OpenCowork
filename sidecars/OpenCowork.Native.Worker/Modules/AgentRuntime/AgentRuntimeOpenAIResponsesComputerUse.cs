using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static async Task ProcessComputerCallAsync(
        JsonElement item,
        ResponsesParseState parseState,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var callId = JsonHelpers.GetString(item, "call_id");
        if (string.IsNullOrWhiteSpace(callId) ||
            !parseState.EmittedComputerCallIds.Add(callId))
        {
            return;
        }

        var actions = item.TryGetProperty("actions", out var actionArray) &&
            actionArray.ValueKind == JsonValueKind.Array
                ? actionArray
                : default;
        var toolCalls = BuildComputerToolCalls(callId, actions);
        foreach (var call in toolCalls)
        {
            parseState.ToolCalls.Add(call);
            await AgentRuntimeTools.EmitAsync(
                state,
                context,
                new AgentRuntimeStreamEvent(
                    "tool_use_streaming_start",
                    ToolCallId: call.Id,
                    ToolName: call.Name,
                    ToolCallExtraContent: call.ExtraContent));
        }
    }


    private static List<AgentRuntimeNativeToolCall> BuildComputerToolCalls(
        string callId,
        JsonElement actions)
    {
        var result = new List<AgentRuntimeNativeToolCall>();
        var sawScreenshot = false;
        if (actions.ValueKind == JsonValueKind.Array)
        {
            var actionIndex = 0;
            foreach (var action in actions.EnumerateArray())
            {
                var actionType = NormalizeComputerActionType(JsonHelpers.GetString(action, "type"));
                if (actionType is null)
                {
                    actionIndex++;
                    continue;
                }
                if (actionType == "screenshot")
                {
                    sawScreenshot = true;
                }
                result.AddRange(BuildComputerActionToolCalls(callId, action, actionType, actionIndex, result.Count));
                actionIndex++;
            }
        }

        if (!sawScreenshot)
        {
            result.Add(CreateComputerToolCall(
                callId,
                "DesktopScreenshot",
                result.Count,
                actions.ValueKind == JsonValueKind.Array ? actions.GetArrayLength() : 0,
                "screenshot",
                AgentRuntimeProviderSupport.CreateEmptyObjectElement(),
                autoAddedScreenshot: true));
        }
        return result;
    }

    private static IEnumerable<AgentRuntimeNativeToolCall> BuildComputerActionToolCalls(
        string callId,
        JsonElement action,
        string actionType,
        int actionIndex,
        int suffix)
    {
        switch (actionType)
        {
            case "screenshot":
                yield return CreateComputerToolCall(
                    callId,
                    "DesktopScreenshot",
                    suffix,
                    actionIndex,
                    actionType,
                    AgentRuntimeProviderSupport.CreateEmptyObjectElement());
                yield break;
            case "click":
            case "double_click":
                yield return CreateComputerToolCall(
                    callId,
                    "DesktopClick",
                    suffix,
                    actionIndex,
                    actionType,
                    AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                    {
                        writer.WriteNumber("x", JsonHelpers.GetDoubleNullable(action, "x") ?? 0);
                        writer.WriteNumber("y", JsonHelpers.GetDoubleNullable(action, "y") ?? 0);
                        writer.WriteString("button", JsonHelpers.GetString(action, "button") ?? "left");
                        writer.WriteString("action", actionType == "double_click" ? "double_click" : "click");
                    }));
                yield break;
            case "scroll":
                yield return CreateComputerToolCall(
                    callId,
                    "DesktopScroll",
                    suffix,
                    actionIndex,
                    actionType,
                    AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                    {
                        if (JsonHelpers.GetDoubleNullable(action, "x") is { } x)
                        {
                            writer.WriteNumber("x", x);
                        }
                        if (JsonHelpers.GetDoubleNullable(action, "y") is { } y)
                        {
                            writer.WriteNumber("y", y);
                        }
                        writer.WriteNumber("scrollX", JsonHelpers.GetDoubleNullable(action, "scrollX") ?? 0);
                        writer.WriteNumber("scrollY", JsonHelpers.GetDoubleNullable(action, "scrollY") ?? 0);
                    }));
                yield break;
            case "type":
                yield return CreateComputerToolCall(
                    callId,
                    "DesktopType",
                    suffix,
                    actionIndex,
                    actionType,
                    AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                    {
                        writer.WriteString("text", JsonHelpers.GetString(action, "text") ?? string.Empty);
                    }));
                yield break;
            case "wait":
                yield return CreateComputerToolCall(
                    callId,
                    "DesktopWait",
                    suffix,
                    actionIndex,
                    actionType,
                    AgentRuntimeProviderSupport.CreateObjectElement(writer => writer.WriteNumber("delayMs", 2000)));
                yield break;
            case "keypress":
                foreach (var keyCall in BuildKeypressToolCalls(callId, action, actionIndex, suffix))
                {
                    yield return keyCall;
                }
                yield break;
        }
    }

    private static IEnumerable<AgentRuntimeNativeToolCall> BuildKeypressToolCalls(
        string callId,
        JsonElement action,
        int actionIndex,
        int suffix)
    {
        if (!action.TryGetProperty("keys", out var keysElement) ||
            keysElement.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        var keys = keysElement
            .EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? NormalizeComputerKey(item.GetString()) : null)
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .ToList();
        if (keys.Count == 0)
        {
            yield break;
        }

        if (keys.Count == 1)
        {
            yield return CreateComputerToolCall(
                callId,
                "DesktopType",
                suffix,
                actionIndex,
                "keypress",
                AgentRuntimeProviderSupport.CreateObjectElement(writer => writer.WriteString("key", keys[0])));
            yield break;
        }

        var modifiers = keys.Take(keys.Count - 1).ToList();
        var mainKey = keys[^1];
        var modifierSet = new HashSet<string>(StringComparer.Ordinal)
        {
            "Control",
            "Meta",
            "Alt",
            "Shift"
        };
        if (modifiers.All(modifierSet.Contains))
        {
            yield return CreateComputerToolCall(
                callId,
                "DesktopType",
                suffix,
                actionIndex,
                "keypress",
                AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                {
                    writer.WritePropertyName("hotkey");
                    writer.WriteStartArray();
                    foreach (var key in modifiers)
                    {
                        writer.WriteStringValue(key);
                    }
                    writer.WriteStringValue(mainKey);
                    writer.WriteEndArray();
                }));
            yield break;
        }

        for (var keyIndex = 0; keyIndex < keys.Count; keyIndex++)
        {
            var key = keys[keyIndex];
            yield return CreateComputerToolCall(
                callId,
                "DesktopType",
                suffix + keyIndex,
                actionIndex * 100 + keyIndex,
                "keypress",
                AgentRuntimeProviderSupport.CreateObjectElement(writer => writer.WriteString("key", key)));
        }
    }

    private static AgentRuntimeNativeToolCall CreateComputerToolCall(
        string callId,
        string toolName,
        int suffix,
        int actionIndex,
        string actionType,
        JsonElement input,
        bool autoAddedScreenshot = false)
    {
        var id = $"{callId}__{actionIndex}__{NormalizeToolNameForId(toolName)}__{suffix}";
        var extraContent = AgentRuntimeProviderSupport.CreateObjectElement(writer =>
        {
            writer.WritePropertyName("openaiResponses");
            writer.WriteStartObject();
            writer.WritePropertyName("computerUse");
            writer.WriteStartObject();
            writer.WriteString("kind", "computer_use");
            writer.WriteString("computerCallId", callId);
            writer.WriteString("computerActionType", actionType);
            writer.WriteNumber("computerActionIndex", actionIndex);
            if (autoAddedScreenshot)
            {
                writer.WriteBoolean("autoAddedScreenshot", true);
            }
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
        return new AgentRuntimeNativeToolCall(id, toolName, input, extraContent);
    }

    private static string? NormalizeComputerActionType(string? value)
    {
        return value switch
        {
            "click" or "double_click" or "scroll" or "keypress" or "type" or "wait" or "screenshot" => value,
            _ => null
        };
    }

    private static string? NormalizeComputerKey(string? key)
    {
        var normalized = key?.Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(normalized))
        {
            return null;
        }

        return normalized switch
        {
            "ENTER" => "Enter",
            "TAB" => "Tab",
            "ESCAPE" or "ESC" => "Escape",
            "BACKSPACE" => "Backspace",
            "DELETE" => "Delete",
            "UP" or "ARROWUP" => "ArrowUp",
            "DOWN" or "ARROWDOWN" => "ArrowDown",
            "LEFT" or "ARROWLEFT" => "ArrowLeft",
            "RIGHT" or "ARROWRIGHT" => "ArrowRight",
            "HOME" => "Home",
            "END" => "End",
            "PAGEUP" => "PageUp",
            "PAGEDOWN" => "PageDown",
            "SPACE" => "Space",
            "CTRL" or "CONTROL" => "Control",
            "CMD" or "COMMAND" or "META" => "Meta",
            "ALT" or "OPTION" => "Alt",
            "SHIFT" => "Shift",
            _ when normalized.Length == 1 && char.IsLetterOrDigit(normalized[0]) => normalized,
            _ when normalized.Length is 2 or 3 &&
                normalized[0] == 'F' &&
                int.TryParse(normalized[1..], out var fKey) &&
                fKey is >= 1 and <= 12 => $"F{fKey}",
            _ => null
        };
    }

    private static string NormalizeToolNameForId(string toolName)
    {
        var chars = toolName
            .Select(ch => char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : '_')
            .ToArray();
        return new string(chars).Trim('_');
    }

}
