using System.Buffers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class AgentRuntimeContextCompression
{
    private const int MaxRetries = 2;
    private const int MaxConsecutiveFailures = 3;
    private const int SafeBoundaryScanLimit = 10;
    private const int SerializedToolUseInputLimit = 500;
    private const int SerializedToolResultLimit = 800;
    private const int RetryDelayMs = 1_500;
    private const int SummaryTimeoutMs = 120_000;
    private const int SummaryMaxOutputTokens = 8_192;
    private const int CircuitOpenCooldownMs = 60_000;
    // Upper bound for the serialized summarizer input (~100K tokens at ~4 chars/token).
    // The budget is halved on every retry so a summarizer model with a smaller context
    // window converges to a fitting input instead of failing all attempts.
    private const int SummaryInputBaseCharBudget = 400_000;
    private const string ResponsesSessionScope = "context-compression";
    private const string SystemPrompt =
        "You compress long AI coding-agent conversations into durable working memory. " +
        "Your summary becomes the ONLY context the agent keeps — everything not in it is lost. " +
        "Preserve exact user intent, constraints, decisions, files touched, errors, test results, " +
        "open tasks, in-progress work state, and any facts needed to continue safely. " +
        "Omit filler and obsolete details. " +
        "Return only a concise Markdown summary, with no preface.";

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private static readonly ConcurrentDictionary<string, CompressionCircuitState> CompressionCircuits =
        new(StringComparer.Ordinal);

    private sealed class CompressionCircuitState
    {
        public int ConsecutiveFailures { get; set; }

        public long OpenedAtUnixMs { get; set; }

        public bool ProbeInProgress { get; set; }
    }

    private sealed class ContextCompressionTimeoutException : TimeoutException
    {
        public ContextCompressionTimeoutException()
            : base($"Context compression summarizer timed out after {SummaryTimeoutMs}ms.")
        {
        }
    }

    public static async Task<WorkerResponse> CompressAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        using var operation = WorkerMemory.TrackOperation("context-compression");
        try
        {
            var messages = ReadMessages(parameters);
            var provider = GetObject(parameters, "provider");
            var focusPrompt = JsonHelpers.GetString(parameters, "focusPrompt");
            var pinnedContext = JsonHelpers.GetString(parameters, "pinnedContext");
            var preTokens = Math.Max(0, JsonHelpers.GetInt(parameters, "preTokens", 0));
            var preserveCount = Math.Max(0, JsonHelpers.GetInt(parameters, "preserveCount", 0));
            var trigger = JsonHelpers.GetString(parameters, "trigger") ?? "manual";
            var response = await CompressMessagesAsync(
                messages,
                provider,
                context,
                focusPrompt,
                preTokens,
                preserveCount,
                trigger,
                pinnedContext);
            return WorkerResponse.Json(
                response,
                WorkerJsonContext.Default.AgentRuntimeContextCompressionResponse);
        }
        finally
        {
            WorkerMemory.ReportCompletedWork("context-compression", pressureBytes: 0);
        }
    }

    internal static async Task<AgentRuntimeContextCompressionResponse> CompressMessagesAsync(
        List<JsonElement> messages,
        JsonElement provider,
        WorkerRequestContext context,
        string? focusPrompt,
        int preTokens,
        int preserveCount = 0,
        string trigger = "manual",
        string? pinnedContext = null)
    {
        var originalCount = messages.Count;
        var normalizedTrigger = trigger == "auto" ? "auto" : "manual";
        var minMessagesToCompress = normalizedTrigger == "manual" ? 1 : 2;
        // Zero-preserve semantics: the summary replaces the entire prior context.
        // FindSafeBoundary below still walks back only to avoid splitting a
        // tool_use/tool_result pair across the boundary.
        var effectivePreserveCount = Math.Min(
            Math.Max(0, preserveCount),
            Math.Max(0, originalCount - minMessagesToCompress));

        if (originalCount < effectivePreserveCount + minMessagesToCompress)
        {
            return new AgentRuntimeContextCompressionResponse(
                messages.ToArray(),
                new AgentRuntimeContextCompressionResult(false, originalCount, originalCount));
        }

        var boundaryIndex = FindSafeBoundary(messages, messages.Count - effectivePreserveCount);
        var messagesToCompress = messages.Take(boundaryIndex).ToList();
        var messagesToPreserve = messages.Skip(boundaryIndex).ToList();
        if (messagesToCompress.Count < minMessagesToCompress)
        {
            return new AgentRuntimeContextCompressionResponse(
                messages.ToArray(),
                new AgentRuntimeContextCompressionResult(false, originalCount, originalCount));
        }

        var circuit = CompressionCircuits.GetOrAdd(
            BuildCompressionCircuitKey(provider),
            static _ => new CompressionCircuitState());
        if (!TryEnterCompressionCircuit(circuit, out var retryAfterMs, out var enteredAsProbe))
        {
            var error =
                $"Context compression is cooling down after repeated failures. Retry in " +
                $"{Math.Max(1, (int)Math.Ceiling(retryAfterMs / 1_000d))}s.";
            WorkerLog.Warn($"context compression summarizer circuit open; preserving original context retryAfterMs={retryAfterMs}");
            return BuildCompressionFailureResult(messages, originalCount, error);
        }

        Exception? lastError = null;
        try
        {
            for (var attempt = 0; attempt <= MaxRetries; attempt++)
            {
                try
                {
                    var inputMessages = attempt == 0
                        ? messagesToCompress
                        : TruncateOldestMessages(messagesToCompress, attempt);
                    var originalTaskMessage = FindOriginalTaskMessage(inputMessages);
                    var serialized = SerializeCompressionInput(
                        inputMessages,
                        originalTaskMessage,
                        pinnedContext,
                        SummaryInputBaseCharBudget >> attempt);
                    var summary = await CallSummarizerAsync(
                        serialized,
                        provider,
                        context,
                        focusPrompt);
                    RegisterCompressionSuccess(circuit);
                    return BuildCompressedResult(
                        normalizedTrigger,
                        summary,
                        messagesToCompress,
                        messagesToPreserve,
                        originalCount,
                        preTokens);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    lastError = ex;
                    WorkerLog.Warn(
                        $"context compression attempt failed attempt={attempt + 1} error={ex.GetType().Name}: {ex.Message}");
                    if (attempt < MaxRetries && !IsContextWindowExceededError(ex))
                    {
                        // Context-window overflows are deterministic: retry immediately with the
                        // halved input budget instead of waiting out a backoff delay.
                        await Task.Delay(RetryDelayMs * (int)Math.Pow(2, attempt), context.CancellationToken);
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            ReleaseCompressionProbe(circuit, enteredAsProbe);
            throw;
        }

        var failures = RegisterCompressionFailure(circuit);
        var failureMessage = lastError?.Message ?? "Context compression summarizer failed.";
        WorkerLog.Warn(
            $"context compression all attempts failed consecutive={failures}/{MaxConsecutiveFailures} " +
            $"error={lastError?.GetType().Name}: {lastError?.Message}");
        return BuildCompressionFailureResult(messages, originalCount, failureMessage);
    }

    // Provider error strings that indicate the request input exceeded the model's
    // context window. Matched case-insensitively against the whole exception chain:
    // OpenAI Responses ("Your input exceeds the context window of this model",
    // code context_length_exceeded), OpenAI Chat ("maximum context length"),
    // Anthropic ("prompt is too long", "exceed context limit"), and Gemini
    // ("input token count ... exceeds the maximum number of tokens").
    private static readonly string[] ContextWindowExceededMarkers =
    [
        "context_length_exceeded",
        "context length exceeded",
        "exceeds the context window",
        "context window of this model",
        "maximum context length",
        "prompt is too long",
        "exceed context limit",
        "exceeds the maximum number of tokens",
        "input token count exceeds"
    ];

    internal static bool IsContextWindowExceededError(Exception exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            var message = current.Message;
            if (string.IsNullOrEmpty(message))
            {
                continue;
            }
            foreach (var marker in ContextWindowExceededMarkers)
            {
                if (message.Contains(marker, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }
        return false;
    }

    private static async Task<string> CallSummarizerAsync(
        string serializedMessages,
        JsonElement provider,
        WorkerRequestContext context,
        string? focusPrompt)
    {
        using var timeout = new CancellationTokenSource(SummaryTimeoutMs);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            context.CancellationToken,
            timeout.Token);

        var compressionProvider = BuildCompressionProvider(provider);
        var requestParameters = BuildProviderRequestParameters(
            compressionProvider,
            BuildSummarizerPrompt(serializedMessages, focusPrompt));
        var runId = $"native-compress-{Guid.NewGuid():N}";
        using var state = new AgentRuntimeTools.AgentRuntimeRunState(runId, string.Empty)
        {
            // Compression consumes provider deltas privately and returns one final
            // result. Publishing its synthetic run would both leak summarizer output
            // into the UI and violate the durable outbox FK (runId is not a Job id).
            SuppressTransportEvents = true
        };
        state.ReplaceParameters(requestParameters);
        using var cancelRegistration = linked.Token.Register(() => state.Cancel("context-compression"));

        WorkerLog.Info(
            $"context compression summarizer start runId={runId} provider={JsonHelpers.GetString(provider, "type")} " +
            $"model={JsonHelpers.GetString(provider, "model")} inputChars={serializedMessages.Length}");
        AgentRuntimeProviderTurnResult turn;
        try
        {
            turn = await OpenAIChatRuntime.ExecuteProviderTurnAsync(requestParameters, state, context);
        }
        catch (OperationCanceledException) when (
            timeout.IsCancellationRequested && !context.CancellationToken.IsCancellationRequested)
        {
            throw new ContextCompressionTimeoutException();
        }
        if (timeout.IsCancellationRequested && !context.CancellationToken.IsCancellationRequested)
        {
            throw new ContextCompressionTimeoutException();
        }
        if (context.CancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(context.CancellationToken);
        }

        var summary = FormatSummary(turn.AssistantMessage.Text);
        if (string.IsNullOrWhiteSpace(summary))
        {
            throw new InvalidOperationException("Context compression returned an empty summary.");
        }
        WorkerLog.Info(
            $"context compression summarizer ok runId={runId} summaryChars={summary.Length}");
        return summary;
    }

    private static AgentRuntimeContextCompressionResponse BuildCompressedResult(
        string trigger,
        string summary,
        IReadOnlyList<JsonElement> messagesToCompress,
        IReadOnlyList<JsonElement> messagesToPreserve,
        int originalCount,
        int preTokens)
    {
        var summaryId = $"oc_{Guid.NewGuid():N}";
        var summaryMessage = CreateSummaryMessage(summaryId, summary);

        var compressedMessages = new List<JsonElement>(1 + messagesToPreserve.Count) { summaryMessage };
        compressedMessages.AddRange(messagesToPreserve);
        return new AgentRuntimeContextCompressionResponse(
            compressedMessages.ToArray(),
            new AgentRuntimeContextCompressionResult(
                true,
                originalCount,
                compressedMessages.Count,
                messagesToCompress.Count,
                SummaryMessageId: summaryId,
                CompactedMessageIds: CollectMessageIds(messagesToCompress)));
    }

    /// <summary>
    /// Ids the host can match against its transcript. Messages the loop created
    /// itself carry ids the host never stored; reporting them anyway is harmless
    /// because the host resolves the cut from whichever ids it recognizes.
    /// </summary>
    private static string[] CollectMessageIds(IReadOnlyList<JsonElement> messages)
    {
        return messages
            .Select(message => JsonHelpers.GetString(message, "id"))
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .ToArray();
    }

    private static AgentRuntimeContextCompressionResponse BuildCompressionFailureResult(
        IReadOnlyList<JsonElement> messages,
        int originalCount,
        string error)
    {
        return new AgentRuntimeContextCompressionResponse(
            messages.Select(message => message.Clone()).ToArray(),
            new AgentRuntimeContextCompressionResult(
                false,
                originalCount,
                originalCount,
                SummarizerFailed: true,
                Error: error));
    }

    private static string BuildCompressionCircuitKey(JsonElement provider)
    {
        return string.Join(
            '\u001f',
            JsonHelpers.GetString(provider, "providerId") ?? string.Empty,
            JsonHelpers.GetString(provider, "type") ?? string.Empty,
            JsonHelpers.GetString(provider, "baseUrl") ?? string.Empty,
            JsonHelpers.GetString(provider, "model") ?? string.Empty);
    }

    private static bool TryEnterCompressionCircuit(
        CompressionCircuitState state,
        out int retryAfterMs,
        out bool enteredAsProbe)
    {
        lock (state)
        {
            retryAfterMs = 0;
            enteredAsProbe = false;
            if (state.ConsecutiveFailures < MaxConsecutiveFailures)
            {
                return true;
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var elapsedMs = Math.Max(0, now - state.OpenedAtUnixMs);
            if (elapsedMs < CircuitOpenCooldownMs)
            {
                retryAfterMs = (int)Math.Min(int.MaxValue, CircuitOpenCooldownMs - elapsedMs);
                return false;
            }
            if (state.ProbeInProgress)
            {
                retryAfterMs = 1_000;
                return false;
            }

            state.ProbeInProgress = true;
            enteredAsProbe = true;
            return true;
        }
    }

    private static void RegisterCompressionSuccess(CompressionCircuitState state)
    {
        lock (state)
        {
            state.ConsecutiveFailures = 0;
            state.OpenedAtUnixMs = 0;
            state.ProbeInProgress = false;
        }
    }

    private static int RegisterCompressionFailure(CompressionCircuitState state)
    {
        lock (state)
        {
            state.ProbeInProgress = false;
            state.ConsecutiveFailures = Math.Min(
                MaxConsecutiveFailures,
                state.ConsecutiveFailures + 1);
            if (state.ConsecutiveFailures >= MaxConsecutiveFailures)
            {
                state.OpenedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }
            return state.ConsecutiveFailures;
        }
    }

    private static void ReleaseCompressionProbe(CompressionCircuitState state, bool enteredAsProbe)
    {
        if (!enteredAsProbe)
        {
            return;
        }
        lock (state)
        {
            state.ProbeInProgress = false;
        }
    }

    private static int FindSafeBoundary(IReadOnlyList<JsonElement> messages, int initialBoundary)
    {
        var boundary = Math.Max(1, Math.Min(initialBoundary, messages.Count));
        for (var attempts = 0; attempts < SafeBoundaryScanLimit; attempts++)
        {
            var compressedToolUseIds = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < boundary; index++)
            {
                foreach (var block in EnumerateContentBlocks(messages[index]))
                {
                    if (JsonHelpers.GetString(block, "type") == "tool_use" &&
                        JsonHelpers.GetString(block, "id") is { Length: > 0 } id)
                    {
                        compressedToolUseIds.Add(id);
                    }
                }
            }

            var hasSplit = false;
            for (var index = boundary; index < messages.Count && !hasSplit; index++)
            {
                foreach (var block in EnumerateContentBlocks(messages[index]))
                {
                    if (JsonHelpers.GetString(block, "type") == "tool_result" &&
                        JsonHelpers.GetString(block, "toolUseId") is { Length: > 0 } toolUseId &&
                        compressedToolUseIds.Contains(toolUseId))
                    {
                        hasSplit = true;
                        break;
                    }
                }
            }

            if (!hasSplit)
            {
                return boundary;
            }
            boundary = Math.Max(1, boundary - 1);
        }
        return boundary;
    }

    private static List<JsonElement> TruncateOldestMessages(IReadOnlyList<JsonElement> messages, int attempt)
    {
        var dropCount = (int)Math.Ceiling(messages.Count * 0.25 * attempt);
        var result = new List<JsonElement>(messages.Count);
        var dropped = 0;
        var keptFirstUser = false;

        foreach (var message in messages)
        {
            var role = JsonHelpers.GetString(message, "role");
            if (role == "system")
            {
                result.Add(message);
                continue;
            }

            if (!keptFirstUser && role == "user")
            {
                result.Add(message);
                keptFirstUser = true;
                continue;
            }

            if (dropped < dropCount)
            {
                dropped++;
                continue;
            }
            result.Add(message);
        }
        return result.Count >= 2 ? result : messages.ToList();
    }

    private static string SerializeCompressionInput(
        IReadOnlyList<JsonElement> messages,
        JsonElement? originalTaskMessage,
        string? pinnedContext,
        int charBudget = SummaryInputBaseCharBudget)
    {
        var parts = new List<string>();
        if (originalTaskMessage.HasValue)
        {
            parts.Add("## Original Task");
            parts.Add(ExtractMessageText(originalTaskMessage.Value));
        }

        if (!string.IsNullOrWhiteSpace(pinnedContext))
        {
            parts.Add("## Pinned Plan Context");
            parts.Add(pinnedContext.Trim());
        }

        var reservedChars = parts.Sum(part => part.Length + 2);
        parts.Add("## Full Conversation History");
        parts.Add(SerializeMessages(messages, Math.Max(1_024, charBudget - reservedChars)));
        return string.Join("\n\n", parts);
    }

    private static string SerializeMessages(
        IReadOnlyList<JsonElement> messages,
        int charBudget = int.MaxValue)
    {
        var parts = new List<string>();
        foreach (var message in messages)
        {
            var role = (JsonHelpers.GetString(message, "role") ?? string.Empty).ToUpperInvariant();
            var content = ExtractMessageText(message);
            if (!string.IsNullOrWhiteSpace(content))
            {
                parts.Add($"[{role}]: {content}");
            }
        }

        // Enforce the summarizer input budget by dropping whole oldest entries first: the
        // recent conversation carries the working state the summary must preserve. A run
        // whose history exceeds the summarizer model's context window would otherwise fail
        // every attempt and silently keep the full uncompressed context.
        var totalChars = parts.Sum(part => part.Length + 2);
        if (totalChars > charBudget)
        {
            var dropped = 0;
            while (parts.Count > 1 && totalChars > charBudget)
            {
                totalChars -= parts[0].Length + 2;
                parts.RemoveAt(0);
                dropped++;
            }
            if (parts.Count == 1 && parts[0].Length > charBudget)
            {
                parts[0] = parts[0][^Math.Max(1, charBudget)..];
            }
            parts.Insert(
                0,
                $"[Note: {dropped} older messages were omitted here to fit the summarizer " +
                "context window; the summary below must still capture the current working state.]");
        }
        return string.Join("\n\n", parts);
    }

    private static string ExtractMessageText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content))
        {
            return string.Empty;
        }
        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString()?.Trim() ?? string.Empty;
        }
        if (content.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        foreach (var block in content.EnumerateArray())
        {
            var text = SerializeContentBlock(block);
            if (!string.IsNullOrWhiteSpace(text))
            {
                parts.Add(text);
            }
        }
        return string.Join("\n", parts).Trim();
    }

    private static string SerializeContentBlock(JsonElement block)
    {
        return JsonHelpers.GetString(block, "type") switch
        {
            "text" => JsonHelpers.GetString(block, "text") ?? string.Empty,
            "thinking" => string.Empty,
            "tool_use" => SerializeToolUseBlock(block),
            "tool_result" => SerializeToolResultBlock(block),
            "image" => "[image attachment]",
            "image_error" => $"[Image error: {JsonHelpers.GetString(block, "message") ?? string.Empty}]",
            "agent_error" => $"[Agent error: {JsonHelpers.GetString(block, "message") ?? string.Empty}]",
            _ => string.Empty
        };
    }

    private static string SerializeToolUseBlock(JsonElement block)
    {
        var name = JsonHelpers.GetString(block, "name") ?? string.Empty;
        var input = block.TryGetProperty("input", out var inputElement)
            ? inputElement.GetRawText()
            : "{}";
        return $"[Tool call: {name}] {Truncate(input, SerializedToolUseInputLimit)}";
    }

    private static string SerializeToolResultBlock(JsonElement block)
    {
        var result = block.TryGetProperty("content", out var content)
            ? (content.ValueKind == JsonValueKind.String ? content.GetString() ?? string.Empty : content.GetRawText())
            : string.Empty;
        var preview = result.Length > SerializedToolResultLimit
            ? $"{result[..SerializedToolResultLimit]}\n... [truncated, {result.Length} chars total]"
            : result;
        return $"[Tool result{(JsonHelpers.GetBool(block, "isError", false) ? " error" : string.Empty)}] {preview}";
    }

    private static JsonElement? FindOriginalTaskMessage(IEnumerable<JsonElement> messages)
    {
        foreach (var message in messages)
        {
            if (JsonHelpers.GetString(message, "role") != "user")
            {
                continue;
            }
            if (JsonHelpers.GetString(message, "source") == "team")
            {
                continue;
            }
            if (IsSummaryLikeMessage(message))
            {
                continue;
            }
            if (message.TryGetProperty("content", out var content) &&
                content.ValueKind == JsonValueKind.Array &&
                !content.EnumerateArray().Any(block =>
                    JsonHelpers.GetString(block, "type") is "text" or "image"))
            {
                continue;
            }
            return message;
        }
        return null;
    }

    private static bool IsSummaryLikeMessage(JsonElement message)
    {
        if (message.TryGetProperty("meta", out var meta) &&
            meta.ValueKind == JsonValueKind.Object &&
            meta.TryGetProperty("compactSummary", out _))
        {
            return true;
        }
        if (JsonHelpers.GetString(message, "role") != "user" ||
            !message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        return (content.GetString() ?? string.Empty)
            .TrimStart()
            .StartsWith("[Context Memory Compressed Summary", StringComparison.Ordinal);
    }

    private static JsonElement BuildCompressionProvider(JsonElement provider)
    {
        var supportsNoReasoning = SupportsReasoningEffort(provider, "none");
        var keepThinkingConfig = JsonHelpers.GetString(provider, "type") != "anthropic";
        var configuredMaxTokens = JsonHelpers.GetInt(provider, "maxTokens", SummaryMaxOutputTokens);
        var summaryMaxTokens = Math.Min(
            SummaryMaxOutputTokens,
            configuredMaxTokens > 0 ? configuredMaxTokens : SummaryMaxOutputTokens);
        return CreateObjectElement(writer =>
        {
            if (provider.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in provider.EnumerateObject())
                {
                    if (property.NameEquals("systemPrompt") ||
                        property.NameEquals("thinkingEnabled") ||
                        property.NameEquals("reasoningEffort") ||
                        property.NameEquals("responseSummary") ||
                        property.NameEquals("temperature") ||
                        property.NameEquals("maxTokens") ||
                        (property.NameEquals("thinkingConfig") && !keepThinkingConfig) ||
                        property.NameEquals("responsesSessionScope") ||
                        property.NameEquals("websocketMode"))
                    {
                        continue;
                    }
                    property.WriteTo(writer);
                }
            }

            writer.WriteString("systemPrompt", SystemPrompt);
            writer.WriteNumber("maxTokens", summaryMaxTokens);
            writer.WriteBoolean("thinkingEnabled", supportsNoReasoning);
            if (supportsNoReasoning)
            {
                writer.WriteString("reasoningEffort", "none");
            }
            if (JsonHelpers.GetString(provider, "type") == "openai-responses")
            {
                writer.WriteString("responsesSessionScope", ResponsesSessionScope);
                writer.WriteString("websocketMode", "disabled");
            }
        });
    }

    private static bool SupportsReasoningEffort(JsonElement provider, string effort)
    {
        if (!provider.TryGetProperty("thinkingConfig", out var thinkingConfig) ||
            thinkingConfig.ValueKind != JsonValueKind.Object ||
            !thinkingConfig.TryGetProperty("reasoningEffortLevels", out var levels) ||
            levels.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        return levels.EnumerateArray().Any(item =>
            item.ValueKind == JsonValueKind.String && item.GetString() == effort);
    }

    private static JsonElement BuildProviderRequestParameters(JsonElement provider, string prompt)
    {
        return CreateObjectElement(writer =>
        {
            writer.WritePropertyName("provider");
            provider.WriteTo(writer);
            writer.WritePropertyName("tools");
            writer.WriteStartArray();
            writer.WriteEndArray();
            writer.WriteNumber("maxIterations", 1);
            writer.WriteBoolean("forceApproval", false);
            writer.WriteBoolean("providerTurnOnly", true);
            writer.WritePropertyName("messages");
            writer.WriteStartArray();
            writer.WriteStartObject();
            writer.WriteString("id", "compress-req");
            writer.WriteString("role", "user");
            writer.WriteString("content", prompt);
            writer.WriteNumber("createdAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            writer.WriteEndObject();
            writer.WriteEndArray();
        });
    }

    private static string BuildSummarizerPrompt(string serializedMessages, string? focusPrompt)
    {
        var focusInstruction = string.IsNullOrWhiteSpace(focusPrompt)
            ? string.Empty
            : "\n\nSpecial focus requested by the user: " + focusPrompt.Trim();
        return
            "Summarize the conversation below so another agent can continue from the current state." +
            focusInstruction +
            "\n\nReturn only the summary.\n\n" +
            serializedMessages;
    }

    private static string FormatSummary(string rawSummary)
    {
        var result = rawSummary.Trim();
        result = ThinkBlockRegex().Replace(result, string.Empty);
        result = AnalysisBlockRegex().Replace(result, string.Empty);
        var summaryMatch = SummaryBlockRegex().Match(result);
        if (summaryMatch.Success)
        {
            result = summaryMatch.Groups[1].Value;
        }
        result = MultipleBlankLineRegex().Replace(result, "\n\n").Trim();
        return result;
    }

    /// <summary>
    /// The summary is an ordinary user message carrying nothing but the summary
    /// text — no marker role, no meta type, no lead-in describing that a
    /// compression happened. The compaction record identifies it by id, so
    /// nothing downstream has to recognize it by shape, and the UI draws the
    /// compaction divider from that record rather than from the message body.
    /// </summary>
    private static JsonElement CreateSummaryMessage(string id, string summary)
    {
        return CreateObjectElement(writer =>
        {
            writer.WriteString("id", id);
            writer.WriteString("role", "user");
            writer.WriteString("content", summary.Trim());
            writer.WriteNumber("createdAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        });
    }

    private static List<JsonElement> ReadMessages(JsonElement parameters)
    {
        var result = new List<JsonElement>();
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("messages", out var messages) ||
            messages.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var message in messages.EnumerateArray())
        {
            if (message.ValueKind == JsonValueKind.Object)
            {
                result.Add(message.Clone());
            }
        }
        return result;
    }

    private static IEnumerable<JsonElement> EnumerateContentBlocks(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind == JsonValueKind.Object)
            {
                yield return block;
            }
        }
    }

    private static JsonElement GetObject(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Object)
        {
            return property;
        }
        return default;
    }

    private static JsonElement CreateObjectElement(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    private static string Truncate(string value, int maxChars)
    {
        return value.Length <= maxChars ? value : value[..maxChars];
    }

    [GeneratedRegex("<think>[\\s\\S]*?</think>", RegexOptions.IgnoreCase)]
    private static partial Regex ThinkBlockRegex();

    [GeneratedRegex("<analysis>[\\s\\S]*?</analysis>", RegexOptions.IgnoreCase)]
    private static partial Regex AnalysisBlockRegex();

    [GeneratedRegex("<summary>([\\s\\S]*?)</summary>", RegexOptions.IgnoreCase)]
    private static partial Regex SummaryBlockRegex();

    [GeneratedRegex("\\n\\n+")]
    private static partial Regex MultipleBlankLineRegex();
}
