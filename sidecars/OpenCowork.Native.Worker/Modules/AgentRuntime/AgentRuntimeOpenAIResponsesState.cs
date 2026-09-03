using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeOpenAIResponsesProvider
{
    private static string ToolResultToString(JsonElement content)
    {
        return content.ValueKind == JsonValueKind.String
            ? content.GetString() ?? string.Empty
            : content.GetRawText();
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

    private static string BuildToolCallKey(AgentRuntimeNativeToolCall call)
    {
        return $"{call.Id}:{call.Name}:{call.Input.GetRawText()}";
    }

    private static int ReadInt(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty(propertyName, out var property))
        {
            return 0;
        }
        if (property.ValueKind == JsonValueKind.Number &&
            property.TryGetInt64(out var longValue))
        {
            return longValue > int.MaxValue ? int.MaxValue : (int)Math.Max(0, longValue);
        }
        if (property.ValueKind == JsonValueKind.String &&
            long.TryParse(property.GetString(), out longValue))
        {
            return longValue > int.MaxValue ? int.MaxValue : (int)Math.Max(0, longValue);
        }
        return 0;
    }

    private static void MarkFirstToken(ResponsesParseState parseState, long startedAt)
    {
        parseState.FirstTokenMs ??= ElapsedMs(startedAt);
    }

    private static int EstimateTokenCount(string text)
    {
        return AgentRuntimeThroughput.EstimateTokens(text);
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed class ResponsesParseState
    {
        public StringBuilder AssistantText { get; } = new();
        public StringBuilder StreamedThinking { get; } = new();
        /// <summary>
        /// Assistant content in emission order, so the turn this run appends to its own
        /// conversation carries reasoning the way renderer-supplied history does. Without
        /// it the tool loop replays every earlier iteration as bare text plus function
        /// calls and the model never sees the reasoning that chose those calls.
        /// </summary>
        public List<ResponsesContentDraft> ContentDrafts { get; } = new();
        public List<AgentRuntimeNativeToolCall> ToolCalls { get; } = new();
        public Dictionary<string, ResponsesToolBuffer> ToolBuffers { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> CallIdAliases { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedToolCallKeys { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedEncryptedReasoning { get; } = new(StringComparer.Ordinal);
        public HashSet<string> DraftedReasoningItemIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedComputerCallIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedImageGenerationStartIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedImageOutputItemIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> EmittedWebSearchCallIds { get; } = new(StringComparer.Ordinal);
        public bool ImageGenerationStarted { get; set; }
        public bool EmittedThinkingDelta { get; set; }
        /// <summary>
        /// True only when reasoning summary text streamed live (during the reasoning
        /// phase). Summaries surfaced at output_item.done arrive after reasoning ended,
        /// so they do not prove the TPS window covered reasoning generation.
        /// </summary>
        public bool ReasoningStreamedLive { get; set; }
        public bool ReceivedAnyMessage { get; set; }
        public long? FirstTokenMs { get; set; }
        public int EstimatedOutputTokens { get; set; }
        public AgentRuntimeTokenUsage? Usage { get; set; }
        public string StopReason { get; set; } = "completed";
        public string? ProviderResponseId { get; set; }
    }

    /// <summary>
    /// One assistant content block under construction. Kinds mirror the app's unified
    /// block shape ("text" / "thinking" / "tool_use") because the same input writer
    /// consumes both these and the blocks the renderer sends back as history.
    /// </summary>
    private sealed class ResponsesContentDraft
    {
        public required string Kind { get; init; }
        public StringBuilder Text { get; } = new();
        public string? EncryptedContent { get; set; }
        /// <summary>
        /// The reasoning item's own id. Endpoints that do not return
        /// `reasoning.encrypted_content` still accept a reasoning item replayed by id,
        /// which is otherwise the only handle on server-side reasoning.
        /// </summary>
        public string? ReasoningItemId { get; set; }
        public bool Closed { get; set; }
        public AgentRuntimeNativeToolCall? ToolCall { get; init; }
    }

    private readonly record struct ResponsesPreviousResponseAnchor(
        string ResponseId,
        int NextMessageIndex);

    private static void DraftText(ResponsesParseState parseState, string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }
        var last = parseState.ContentDrafts.Count > 0
            ? parseState.ContentDrafts[^1]
            : null;
        if (last is { Kind: "text" })
        {
            last.Text.Append(text);
            return;
        }
        var draft = new ResponsesContentDraft { Kind = "text" };
        draft.Text.Append(text);
        parseState.ContentDrafts.Add(draft);
    }

    /// <param name="backfill">
    /// The summary was only disclosed after the answer streamed, so it belongs in front
    /// of the trailing text run rather than after it — same placement rule the host uses
    /// for the `thinking_backfill` stream event.
    /// </param>
    private static void DraftThinking(ResponsesParseState parseState, string thinking, bool backfill)
    {
        if (string.IsNullOrEmpty(thinking))
        {
            return;
        }
        var drafts = parseState.ContentDrafts;
        if (!backfill)
        {
            var last = drafts.Count > 0 ? drafts[^1] : null;
            if (last is { Kind: "thinking", Closed: false })
            {
                last.Text.Append(thinking);
                return;
            }
            CloseOpenThinkingDrafts(parseState);
            var appended = new ResponsesContentDraft { Kind = "thinking" };
            appended.Text.Append(thinking);
            drafts.Add(appended);
            return;
        }

        CloseOpenThinkingDrafts(parseState);
        var insertAt = drafts.Count;
        while (insertAt > 0 && drafts[insertAt - 1].Kind == "text")
        {
            insertAt--;
        }
        var preceding = insertAt > 0 ? drafts[insertAt - 1] : null;
        if (preceding is { Kind: "thinking" })
        {
            if (preceding.Text.Length > 0)
            {
                preceding.Text.Append('\n');
            }
            preceding.Text.Append(thinking);
            return;
        }
        var inserted = new ResponsesContentDraft { Kind = "thinking", Closed = true };
        inserted.Text.Append(thinking);
        drafts.Insert(insertAt, inserted);
    }

    private static void CloseOpenThinkingDrafts(ResponsesParseState parseState)
    {
        foreach (var draft in parseState.ContentDrafts)
        {
            if (draft.Kind == "thinking")
            {
                draft.Closed = true;
            }
        }
    }

    /// <summary>
    /// Attach reasoning identity to the block it belongs to: the newest thinking draft
    /// that does not have one yet, mirroring the host's signature-attachment rule so a
    /// later item cannot steal an earlier block's handle.
    /// </summary>
    private static void DraftReasoningIdentity(
        ResponsesParseState parseState,
        string? encryptedContent,
        string? reasoningItemId)
    {
        if (string.IsNullOrWhiteSpace(encryptedContent) && string.IsNullOrWhiteSpace(reasoningItemId))
        {
            return;
        }
        var drafts = parseState.ContentDrafts;
        for (var index = drafts.Count - 1; index >= 0; index--)
        {
            var draft = drafts[index];
            if (draft.Kind != "thinking")
            {
                continue;
            }
            if (draft.EncryptedContent is null && draft.ReasoningItemId is null)
            {
                draft.EncryptedContent = encryptedContent;
                draft.ReasoningItemId = reasoningItemId;
            }
            return;
        }

        // Reasoning with no summary text at all: keep the handle so the turn can still be
        // replayed, the same way a redacted thinking block carries only its signature.
        var placeholder = new ResponsesContentDraft
        {
            Kind = "thinking",
            Closed = true,
            EncryptedContent = encryptedContent,
            ReasoningItemId = reasoningItemId
        };
        drafts.Insert(0, placeholder);
    }

    private static void DraftToolCall(ResponsesParseState parseState, AgentRuntimeNativeToolCall call)
    {
        parseState.ContentDrafts.Add(new ResponsesContentDraft { Kind = "tool_use", ToolCall = call });
    }

    /// <summary>
    /// Materialize the drafted blocks, but only when they reproduce exactly the text and
    /// tool calls the flat turn result already carries. The blocks path replaces the flat
    /// path in the input writer, so a reconstruction that drifted would silently drop
    /// content from every later request in the loop; falling back to null keeps the
    /// previous behaviour instead. Returns null when there is no reasoning to add.
    /// </summary>
    private static List<JsonElement>? BuildResponsesContentBlocks(ResponsesParseState parseState)
    {
        var drafts = parseState.ContentDrafts;
        if (drafts.Count == 0)
        {
            return null;
        }

        var draftedText = new StringBuilder();
        var draftedCalls = new List<AgentRuntimeNativeToolCall>();
        var hasReasoning = false;
        foreach (var draft in drafts)
        {
            switch (draft.Kind)
            {
                case "text":
                    draftedText.Append(draft.Text);
                    break;
                case "thinking":
                    hasReasoning = true;
                    break;
                case "tool_use" when draft.ToolCall is { } call:
                    draftedCalls.Add(call);
                    break;
            }
        }

        if (!hasReasoning)
        {
            return null;
        }
        if (!string.Equals(draftedText.ToString(), parseState.AssistantText.ToString(), StringComparison.Ordinal))
        {
            WorkerLog.Debug("responses content blocks skipped: drafted text diverged from turn text");
            return null;
        }
        if (draftedCalls.Count != parseState.ToolCalls.Count)
        {
            WorkerLog.Debug(
                $"responses content blocks skipped: drafted tool calls {draftedCalls.Count} != {parseState.ToolCalls.Count}");
            return null;
        }
        for (var index = 0; index < draftedCalls.Count; index++)
        {
            if (!string.Equals(draftedCalls[index].Id, parseState.ToolCalls[index].Id, StringComparison.Ordinal))
            {
                WorkerLog.Debug("responses content blocks skipped: drafted tool call order diverged");
                return null;
            }
        }

        var blocks = new List<JsonElement>(drafts.Count);
        foreach (var draft in drafts)
        {
            switch (draft.Kind)
            {
                case "text":
                    if (draft.Text.Length == 0)
                    {
                        break;
                    }
                    blocks.Add(AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                    {
                        writer.WriteString("type", "text");
                        writer.WriteString("text", draft.Text.ToString());
                    }));
                    break;
                case "thinking":
                    if (draft.Text.Length == 0 &&
                        draft.EncryptedContent is null &&
                        draft.ReasoningItemId is null)
                    {
                        break;
                    }
                    blocks.Add(AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                    {
                        writer.WriteString("type", "thinking");
                        writer.WriteString("thinking", draft.Text.ToString());
                        if (draft.EncryptedContent is { Length: > 0 } encrypted)
                        {
                            writer.WriteString("encryptedContent", encrypted);
                            writer.WriteString("encryptedContentProvider", "openai-responses");
                        }
                        if (draft.ReasoningItemId is { Length: > 0 } reasoningItemId)
                        {
                            writer.WriteString("reasoningItemId", reasoningItemId);
                        }
                    }));
                    break;
                case "tool_use" when draft.ToolCall is { } call:
                    blocks.Add(AgentRuntimeProviderSupport.CreateObjectElement(writer =>
                    {
                        writer.WriteString("type", "tool_use");
                        writer.WriteString("id", call.Id);
                        writer.WriteString("name", call.Name);
                        writer.WritePropertyName("input");
                        call.Input.WriteTo(writer);
                        if (call.ExtraContent is { } extraContent)
                        {
                            writer.WritePropertyName("extraContent");
                            extraContent.WriteTo(writer);
                        }
                    }));
                    break;
            }
        }

        return blocks.Count > 0 ? blocks : null;
    }


    private sealed class ResponsesToolBuffer
    {
        public ResponsesToolBuffer(string callId, string name)
        {
            CallId = callId;
            Name = name;
        }

        public string CallId { get; }
        public string Name { get; set; }
        public StringBuilder Arguments { get; } = new();
        public AgentRuntimeToolArgumentStreamState ArgumentStream { get; } = new();
    }

    private static class NativeGlobalPromptCacheKey
    {
        public static readonly string Value = $"ocw-global-{Guid.NewGuid():N}";
    }
}
