using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using OpenCowork.Agent.Providers;
using OpenCowork.Agent.Serialization;

namespace OpenCowork.Agent.Engine;

/// <summary>
/// Configuration for an agent loop run.
/// </summary>
public sealed class AgentLoopRunConfig
{
    public required ILlmProvider Provider { get; init; }
    public required ProviderConfig ProviderConfig { get; init; }
    public required List<ToolDefinition> Tools { get; init; }
    public required ToolRegistry ToolRegistry { get; init; }
    public required ToolContext ToolContext { get; init; }
    public int MaxIterations { get; init; } = 25;
    public bool ForceApproval { get; init; }
    public CompressionConfig? Compression { get; init; }
    public bool EnableParallelToolExecution { get; init; } = true;
    public int MaxParallelTools { get; init; } = 5;
}

/// <summary>
/// Delegate for requesting approval from the UI via JSON-RPC.
/// Returns true if approved, false if denied.
/// </summary>
public delegate Task<bool> ApprovalHandler(ToolCallState toolCall);

/// <summary>
/// Core agent loop ported from TypeScript, with parallel tool execution.
///
/// Key improvements over the TS version:
/// 1. Tools execute in parallel via Task.WhenAll (configurable)
/// 2. Zero-copy SSE parsing (via provider layer)
/// 3. Context compression runs in .NET (no IPC round-trip)
/// </summary>
public static class AgentLoop
{
    public static async IAsyncEnumerable<AgentEvent> RunAsync(
        List<UnifiedMessage> initialMessages,
        AgentLoopRunConfig config,
        ApprovalHandler? onApproval = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var conversationMessages = new List<UnifiedMessage>(initialMessages);
        var iteration = 0;
        var lastInputTokens = 0;
        var hasLimit = config.MaxIterations > 0 && config.MaxIterations < int.MaxValue;

        yield return new LoopStartEvent
        {
            TotalMessages = conversationMessages.Count
        };

        while (!hasLimit || iteration < config.MaxIterations)
        {
            if (ct.IsCancellationRequested)
            {
                yield return new LoopEndEvent { Reason = "aborted" };
                yield break;
            }

            // --- Context compression between iterations ---
            if (lastInputTokens > 0 && config.Compression is not null && !ct.IsCancellationRequested)
            {
                if (ContextCompression.ShouldCompress(lastInputTokens, config.Compression))
                {
                    yield return new ContextCompressionStartEvent();

                    var compressed = await ContextCompression.CompressMessagesAsync(
                        conversationMessages, config.Provider, config.ProviderConfig, ct);

                    var removedCount = conversationMessages.Count - compressed.Count;
                    conversationMessages = compressed;

                    yield return new ContextCompressedEvent
                    {
                        OriginalCount = conversationMessages.Count + removedCount,
                        CompressedCount = compressed.Count
                    };
                }
                else if (ContextCompression.ShouldPreCompress(lastInputTokens, config.Compression))
                {
                    conversationMessages = ContextCompression.PreCompressMessages(conversationMessages);
                }
            }

            iteration++;

            yield return new IterationStartEvent { Iteration = iteration };

            // --- Stream from LLM provider ---
            var textBuilder = new StringBuilder();
            var thinkingBuilder = new StringBuilder();
            var toolCalls = new List<ToolCallState>();
            var activeToolArgs = new Dictionary<string, StringBuilder>();
            var lastParsedArgLen = new Dictionary<string, int>(); // Debounce partial JSON parse
            TokenUsage? usage = null;
            RequestTiming? timing = null;
            string? stopReason = null;
            string? providerResponseId = null;
            string? thinkingEncryptedContent = null;
            string? thinkingEncryptedProvider = null;

            // Micro-batch buffers: accumulate rapid deltas and flush less frequently.
            // Reduces JSON-RPC messages from ~100/sec to ~10/sec while keeping smooth UI.
            const int DeltaFlushThreshold = 64; // chars
            var pendingTextDelta = new StringBuilder();
            var pendingThinkingDelta = new StringBuilder();

            await foreach (var evt in config.Provider.SendMessageAsync(
                conversationMessages, config.Tools, config.ProviderConfig, ct))
            {
                // Flush accumulated deltas before processing any non-delta event
                if (evt.Type != "text_delta" && pendingTextDelta.Length > 0)
                {
                    yield return new TextDeltaEvent { Text = pendingTextDelta.ToString() };
                    pendingTextDelta.Clear();
                }
                if (evt.Type != "thinking_delta" && pendingThinkingDelta.Length > 0)
                {
                    yield return new ThinkingDeltaEvent { Thinking = pendingThinkingDelta.ToString() };
                    pendingThinkingDelta.Clear();
                }

                switch (evt.Type)
                {
                    case "text_delta":
                        textBuilder.Append(evt.Text);
                        pendingTextDelta.Append(evt.Text);
                        if (pendingTextDelta.Length >= DeltaFlushThreshold)
                        {
                            yield return new TextDeltaEvent { Text = pendingTextDelta.ToString() };
                            pendingTextDelta.Clear();
                        }
                        break;

                    case "thinking_delta":
                        thinkingBuilder.Append(evt.Thinking);
                        pendingThinkingDelta.Append(evt.Thinking);
                        if (pendingThinkingDelta.Length >= DeltaFlushThreshold)
                        {
                            yield return new ThinkingDeltaEvent { Thinking = pendingThinkingDelta.ToString() };
                            pendingThinkingDelta.Clear();
                        }
                        break;

                    case "thinking_encrypted":
                        if (!string.IsNullOrWhiteSpace(evt.ThinkingEncryptedContent)
                            && !string.IsNullOrWhiteSpace(evt.ThinkingEncryptedProvider))
                        {
                            thinkingEncryptedContent = evt.ThinkingEncryptedContent;
                            thinkingEncryptedProvider = evt.ThinkingEncryptedProvider;
                            yield return new ThinkingEncryptedEvent
                            {
                                ThinkingEncryptedContent = evt.ThinkingEncryptedContent,
                                ThinkingEncryptedProvider = evt.ThinkingEncryptedProvider
                            };
                        }
                        break;

                    case "tool_call_start":
                        var tc = new ToolCallState
                        {
                            Id = evt.ToolCallId ?? Guid.NewGuid().ToString("N")[..12],
                            Name = evt.ToolName ?? "",
                            Input = new Dictionary<string, JsonElement>(),
                            Status = ToolCallStatus.Streaming,
                            RequiresApproval = config.ForceApproval,
                            ExtraContent = evt.ToolCallExtraContent,
                            StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        };
                        toolCalls.Add(tc);
                        activeToolArgs[tc.Id] = new StringBuilder();

                        yield return new ToolUseStreamingStartEvent
                        {
                            ToolCallId = tc.Id,
                            ToolName = tc.Name,
                            ToolCallExtraContent = evt.ToolCallExtraContent
                        };
                        break;

                    case "tool_call_delta":
                        if (evt.ToolCallId is not null &&
                            activeToolArgs.TryGetValue(evt.ToolCallId, out var argBuf))
                        {
                            argBuf.Append(evt.ArgumentsDelta);

                            // Debounce: only attempt partial JSON parse every 512 bytes
                            // to avoid O(n²) ToString+parse on every tiny delta chunk
                            var lastLen = lastParsedArgLen.GetValueOrDefault(evt.ToolCallId, 0);
                            if (argBuf.Length - lastLen >= 512)
                            {
                                lastParsedArgLen[evt.ToolCallId] = argBuf.Length;
                                if (PartialJsonParser.TryParsePartial(argBuf.ToString(), out var partialInput) && partialInput is not null)
                                {
                                    yield return new ToolUseArgsDeltaEvent
                                    {
                                        ToolCallId = evt.ToolCallId,
                                        PartialInput = ProviderMessageFormatter.NormalizeToolInputObject(partialInput)
                                    };
                                }
                            }
                        }
                        break;

                    case "tool_call_end":
                        if (evt.ToolCallId is not null)
                        {
                            var matching = toolCalls.FirstOrDefault(t => t.Id == evt.ToolCallId);
                            if (matching is not null)
                            {
                                matching.Input = ProviderMessageFormatter.NormalizeToolInputObject(
                                    evt.ToolCallInput ?? new Dictionary<string, JsonElement>());
                                matching.Name = evt.ToolName ?? matching.Name;
                                matching.ExtraContent = evt.ToolCallExtraContent ?? matching.ExtraContent;
                                matching.Status = ToolCallStatus.Streaming;
                                yield return new ToolUseGeneratedEvent
                                {
                                    Id = matching.Id,
                                    Name = matching.Name,
                                    Input = matching.Input,
                                    ExtraContent = evt.ToolCallExtraContent
                                };
                            }
                            activeToolArgs.Remove(evt.ToolCallId);
                        }
                        break;

                    case "message_end":
                        usage = evt.Usage;
                        timing = evt.Timing;
                        stopReason = evt.StopReason;
                        providerResponseId = evt.ProviderResponseId;
                        if (usage is not null)
                            lastInputTokens = usage.InputTokens;
                        break;

                    case "request_debug":
                        if (evt.DebugInfo is not null)
                        {
                            yield return new RequestDebugEvent
                            {
                                DebugInfo = new RequestDebugInfo
                                {
                                    Url = evt.DebugInfo.Url,
                                    Method = evt.DebugInfo.Method,
                                    Headers = evt.DebugInfo.Headers,
                                    Body = evt.DebugInfo.Body,
                                    Timestamp = evt.DebugInfo.Timestamp,
                                    ProviderId = evt.DebugInfo.ProviderId,
                                    ProviderBuiltinId = evt.DebugInfo.ProviderBuiltinId,
                                    Model = evt.DebugInfo.Model,
                                    ExecutionPath = "sidecar"
                                }
                            };
                        }
                        break;

                    case "error":
                        yield return new AgentErrorEvent
                        {
                            Message = evt.Error?.Message ?? "Unknown error",
                            ErrorType = evt.Error?.Type
                        };
                        yield return new LoopEndEvent { Reason = "error" };
                        yield break;
                }
            }

            // Flush any remaining micro-batched deltas after stream ends
            if (pendingTextDelta.Length > 0)
                yield return new TextDeltaEvent { Text = pendingTextDelta.ToString() };
            if (pendingThinkingDelta.Length > 0)
                yield return new ThinkingDeltaEvent { Thinking = pendingThinkingDelta.ToString() };

            // --- Build assistant message ---
            var assistantContent = new List<ContentBlock>();
            if (thinkingBuilder.Length > 0)
                assistantContent.Add(new ThinkingBlock
                {
                    Thinking = thinkingBuilder.ToString(),
                    EncryptedContent = thinkingEncryptedContent,
                    EncryptedContentProvider = thinkingEncryptedProvider
                });
            if (textBuilder.Length > 0)
                assistantContent.Add(new TextBlock { Text = textBuilder.ToString() });
            foreach (var tc in toolCalls)
            {
                assistantContent.Add(new ToolUseBlock
                {
                    Id = tc.Id,
                    Name = tc.Name,
                    Input = tc.Input,
                    ExtraContent = tc.ExtraContent
                });
            }

            conversationMessages.Add(new UnifiedMessage
            {
                Role = "assistant",
                Content = assistantContent,
                ProviderResponseId = providerResponseId
            });

            yield return new MessageEndEvent
            {
                Usage = usage,
                Timing = timing,
                ProviderResponseId = providerResponseId,
                StopReason = stopReason
            };

            // --- No tool calls → done ---
            if (toolCalls.Count == 0)
            {
                yield return new LoopEndEvent { Reason = "completed" };
                yield break;
            }

            // --- Execute tool calls (PARALLEL - key perf improvement) ---
            var toolResults = new ContentBlock[toolCalls.Count];

            if (config.EnableParallelToolExecution && toolCalls.Count > 1)
            {
                // Parallel execution with semaphore for concurrency limit
                var semaphore = new SemaphoreSlim(config.MaxParallelTools);

                var tasks = toolCalls.Select(async (tc, index) =>
                {
                    await semaphore.WaitAsync(ct);
                    try
                    {
                        var result = await ExecuteToolWithApproval(
                            tc, config, onApproval, ct);
                        toolResults[index] = result;
                    }
                    finally
                    {
                        semaphore.Release();
                    }
                }).ToArray();

                // Yield individual tool events as they complete
                foreach (var tc in toolCalls)
                {
                    tc.Status = ToolCallStatus.Running;
                    yield return new ToolCallStartEvent
                    {
                        ToolCallId = tc.Id,
                        ToolName = tc.Name,
                        ToolCall = CloneToolCallState(tc)
                    };
                }

                await Task.WhenAll(tasks);
            }
            else
            {
                // Sequential execution (for single tool or when parallel disabled)
                for (var i = 0; i < toolCalls.Count; i++)
                {
                    toolCalls[i].Status = ToolCallStatus.Running;
                    yield return new ToolCallStartEvent
                    {
                        ToolCallId = toolCalls[i].Id,
                        ToolName = toolCalls[i].Name,
                        ToolCall = CloneToolCallState(toolCalls[i])
                    };

                    toolResults[i] = await ExecuteToolWithApproval(
                        toolCalls[i], config, onApproval, ct);
                }
            }

            // Yield tool results
            for (var i = 0; i < toolCalls.Count; i++)
            {
                var resultBlock = toolResults[i] as ToolResultBlock;
                yield return new ToolCallResultEvent
                {
                    ToolCallId = toolCalls[i].Id,
                    ToolName = toolCalls[i].Name,
                    Result = resultBlock?.GetTextContent(),
                    IsError = resultBlock?.IsError == true,
                    ToolCall = CloneToolCallState(toolCalls[i])
                };
            }

            // --- Append tool results as user message ---
            conversationMessages.Add(new UnifiedMessage
            {
                Role = "user",
                Content = [.. toolResults]
            });

            yield return new IterationEndEvent
            {
                Iteration = iteration,
                StopReason = "tool_use",
                ToolResults = toolResults
                    .OfType<ToolResultBlock>()
                    .Select(block => new ToolResultSummary
                    {
                        ToolUseId = block.ToolUseId,
                        Content = ToJsonElement(block.GetContentValue()),
                        IsError = block.IsError
                    })
                    .ToList()
            };
        }

        yield return new LoopEndEvent { Reason = "max_iterations" };
    }

    private static async Task<ContentBlock> ExecuteToolWithApproval(
        ToolCallState tc,
        AgentLoopRunConfig config,
        ApprovalHandler? onApproval,
        CancellationToken ct)
    {
        var toolContext = new ToolContext
        {
            SessionId = config.ToolContext.SessionId,
            WorkingFolder = config.ToolContext.WorkingFolder,
            CurrentToolUseId = tc.Id,
            AgentRunId = config.ToolContext.AgentRunId,
            ElectronInvokeAsync = config.ToolContext.ElectronInvokeAsync,
            RendererToolInvokeAsync = config.ToolContext.RendererToolInvokeAsync,
            RendererToolRequiresApprovalAsync = config.ToolContext.RendererToolRequiresApprovalAsync,
            InlineToolHandlers = config.ToolContext.InlineToolHandlers,
            LocalToolHandlers = config.ToolContext.LocalToolHandlers,
            ReadFileHistory = config.ToolContext.ReadFileHistory
        };

        // Check if approval is needed
        var rendererApproval = false;
        if (toolContext.RendererToolRequiresApprovalAsync is not null)
        {
            rendererApproval = await toolContext.RendererToolRequiresApprovalAsync(tc.Name, tc.Input, toolContext, ct);
        }

        var requiresApproval = config.ForceApproval ||
            rendererApproval ||
            config.ToolRegistry.CheckRequiresApproval(tc.Name, tc.Input, toolContext);

        if (requiresApproval && onApproval is not null)
        {
            tc.Status = ToolCallStatus.PendingApproval;
            var approved = await onApproval(tc);
            if (!approved)
            {
                tc.Status = ToolCallStatus.Error;
                tc.Error = "User denied permission to execute this tool.";
                tc.CompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return new ToolResultBlock
                {
                    ToolUseId = tc.Id,
                    Content = tc.Error,
                    IsError = true
                };
            }
        }

        tc.Status = ToolCallStatus.Running;
        try
        {
            var result = await config.ToolRegistry.Execute(
                tc.Name, tc.Input, toolContext, ct);

            tc.Status = result.IsError ? ToolCallStatus.Error : ToolCallStatus.Completed;
            tc.Error = result.IsError ? result.AsText() : null;
            tc.Output = ToNullableJsonElement(result.Content);
            tc.CompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return new ToolResultBlock
            {
                ToolUseId = tc.Id,
                Content = result.Content,
                RawContent = tc.Output,
                IsError = result.IsError
            };
        }
        catch (Exception ex)
        {
            tc.Status = ToolCallStatus.Error;
            tc.Error = $"Tool execution error: {ex.Message}";
            tc.CompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return new ToolResultBlock
            {
                ToolUseId = tc.Id,
                Content = tc.Error,
                IsError = true
            };
        }
    }

    /// <summary>
    /// Shallow clone for event reporting — avoids deep-copying Dictionary/JsonElement
    /// since events are serialized immediately and the source is not mutated concurrently.
    /// </summary>
    private static ToolCallState CloneToolCallState(ToolCallState source)
    {
        return new ToolCallState
        {
            Id = source.Id,
            Name = source.Name,
            Input = source.Input, // Shared ref — safe because source Input is replaced, not mutated
            Status = source.Status,
            Output = source.Output,
            Error = source.Error,
            RequiresApproval = source.RequiresApproval,
            StartedAt = source.StartedAt,
            CompletedAt = source.CompletedAt
        };
    }

    private static JsonElement? ToNullableJsonElement(object? value)
    {
        if (value is null)
            return null;

        return ToJsonElement(value);
    }

    private static JsonElement ToJsonElement(object value)
    {
        switch (value)
        {
            case JsonElement element:
                return element.Clone();
            case string text:
                return JsonSerializer.SerializeToElement(text, AppJsonContext.Default.String);
            case bool boolean:
                return JsonSerializer.SerializeToElement(boolean, AppJsonContext.Default.Boolean);
            case int int32:
                return JsonSerializer.SerializeToElement(int32, AppJsonContext.Default.Int32);
            case long int64:
                return JsonSerializer.SerializeToElement(int64, AppJsonContext.Default.Int64);
            case double float64:
                return JsonSerializer.SerializeToElement(float64, AppJsonContext.Default.Double);
            case IEnumerable<ContentBlock> blocks:
                return JsonSerializer.SerializeToElement(blocks.ToList(), AppJsonContext.Default.ListContentBlock);
            case JsonNode node:
            {
                using var document = JsonDocument.Parse(node.ToJsonString());
                return document.RootElement.Clone();
            }
            default:
                return JsonSerializer.SerializeToElement(value.ToString() ?? string.Empty, AppJsonContext.Default.String);
        }
    }
}
