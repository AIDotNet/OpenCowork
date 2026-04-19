using System.Text;
using System.Text.Json;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Providers;
using OpenCowork.Agent;

namespace OpenCowork.Agent.SubAgents;

public sealed class SubAgentExecutionResult
{
    public required SubAgentResult Result { get; init; }
    public long ElapsedMs { get; init; }
    public required List<ToolCallState> ToolCalls { get; init; }
}

/// <summary>
/// Sub-agent runner with concurrency limiting via SemaphoreSlim.
/// </summary>
public sealed class SubAgentRunner
{
    private static readonly SemaphoreSlim SubAgentLimiter = new(2, 2);

    private const string DefaultFallbackReportPrompt =
        "Your previous turn ended without producing any visible text. Your caller has no way to see what you did. " +
        "Now, based on everything you executed in this conversation (tool calls, findings, analysis, attempts, and " +
        "failures), write a detailed work report. The report MUST include:\n" +
        "1. What you were asked to do and your interpretation of the task.\n" +
        "2. The concrete steps you took, in order, with the key evidence you gathered from each tool call.\n" +
        "3. Your findings, conclusions, or the artifacts you produced (paste or quote the important parts directly).\n" +
        "4. Anything you could NOT finish, and the reason (blocker, missing info, unclear scope, etc.).\n" +
        "5. Concrete next steps or recommendations for the caller.\n\n" +
        "Respond in the same language the task was given in. Output the report body only — do NOT call any tools, " +
        "do NOT ask clarifying questions, do NOT add preamble like \"Here is the report\". Just the report.";

    private static readonly HashSet<string> ReadOnlyTools = new(StringComparer.Ordinal)
    {
        "Read",
        "LS",
        "Glob",
        "Grep",
        "TaskList",
        "TaskGet",
        "Skill",
        SubmitReportTool.ToolName
    };

    private static readonly HashSet<string> MandatoryDisallowedTools = new(StringComparer.Ordinal)
    {
        "AskUserQuestion"
    };

    private static Dictionary<string, ToolHandler> MergeInlineHandlers(
        Dictionary<string, ToolHandler>? existing,
        ToolHandler extra)
    {
        var merged = new Dictionary<string, ToolHandler>(StringComparer.Ordinal);
        if (existing is not null)
        {
            foreach (var (key, value) in existing)
            {
                merged[key] = value;
            }
        }
        merged[extra.Definition.Name] = extra;
        return merged;
    }

    private readonly ToolRegistry _toolRegistry;
    private readonly Dictionary<string, SubAgentDefinition> _definitions = new();

    public SubAgentRunner(ToolRegistry toolRegistry)
    {
        _toolRegistry = toolRegistry;
    }

    public void Register(SubAgentDefinition definition)
    {
        _definitions[definition.Name] = definition;
    }

    public SubAgentDefinition? Get(string name) =>
        _definitions.GetValueOrDefault(name);

    public IReadOnlyList<SubAgentDefinition> GetAll() =>
        _definitions.Values.ToList();

    public async Task<SubAgentExecutionResult> RunAsync(
        SubAgentDefinition definition,
        Dictionary<string, JsonElement> input,
        ILlmProvider provider,
        ProviderConfig baseConfig,
        ToolContext toolContext,
        ApprovalHandler? onApproval = null,
        CancellationToken ct = default)
    {
        await SubAgentLimiter.WaitAsync(ct);
        try
        {
            return await RunInternalAsync(definition, input, provider, baseConfig, toolContext, onApproval, ct);
        }
        finally
        {
            SubAgentLimiter.Release();
        }
    }

    private async Task<SubAgentExecutionResult> RunInternalAsync(
        SubAgentDefinition definition,
        Dictionary<string, JsonElement> input,
        ILlmProvider provider,
        ProviderConfig baseConfig,
        ToolContext toolContext,
        ApprovalHandler? onApproval,
        CancellationToken ct)
    {
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var toolUseId = toolContext.CurrentToolUseId ?? string.Empty;
        var promptMessage = CreatePromptMessage(input, definition.InitialPrompt);

        await EmitEventAsync(toolContext, new SubAgentStartEvent
        {
            SubAgentName = definition.Name,
            ToolUseId = toolUseId,
            Input = CloneJsonDictionary(input),
            PromptMessage = promptMessage
        }, ct);

        var resolvedTools = ResolveTools(definition, out var invalidTools);
        // Inject the SubmitReport tool so the sub-agent can explicitly end its
        // own session with a report payload. Without this, some models keep
        // calling tools indefinitely after the task is logically done, or stop
        // emitting tool calls without ever producing visible text — both leave
        // the parent agent with no usable result.
        var submitReportTool = new SubmitReportTool();
        var tools = resolvedTools.Count > 0
            ? new List<ToolDefinition>(resolvedTools) { submitReportTool.Definition }
            : new List<ToolDefinition>();
        if (tools.Count == 0)
        {
            return await FinalizeAsync(
                definition,
                toolUseId,
                toolContext,
                startedAt,
                finalOutput: string.Empty,
                aggregatedText: string.Empty,
                trackedToolCalls: new List<ToolCallState>(),
                iterations: 0,
                usage: new TokenUsage { InputTokens = 0, OutputTokens = 0 },
                success: false,
                error: invalidTools.Count > 0
                    ? $"No tools available for sub-agent. Requested: {string.Join(", ", invalidTools)}"
                    : "No tools available for sub-agent.",
                ct: ct);
        }

        var config = new ProviderConfig
        {
            Type = baseConfig.Type,
            ApiKey = baseConfig.ApiKey,
            BaseUrl = baseConfig.BaseUrl,
            Model = definition.Model ?? baseConfig.Model,
            Category = baseConfig.Category,
            MaxTokens = baseConfig.MaxTokens,
            Temperature = definition.Temperature ?? baseConfig.Temperature,
            SystemPrompt = definition.SystemPrompt ?? baseConfig.SystemPrompt,
            UseSystemProxy = baseConfig.UseSystemProxy,
            AllowInsecureTls = baseConfig.AllowInsecureTls,
            ThinkingEnabled = baseConfig.ThinkingEnabled,
            ThinkingConfig = baseConfig.ThinkingConfig,
            ReasoningEffort = baseConfig.ReasoningEffort,
            ProviderId = baseConfig.ProviderId,
            ProviderBuiltinId = baseConfig.ProviderBuiltinId,
            UserAgent = baseConfig.UserAgent,
            SessionId = baseConfig.SessionId,
            ResponsesSessionScope = $"sub-agent:{toolUseId}",
            ServiceTier = baseConfig.ServiceTier,
            EnablePromptCache = baseConfig.EnablePromptCache,
            EnableSystemPromptCache = baseConfig.EnableSystemPromptCache,
            PromptCacheKey = baseConfig.PromptCacheKey,
            RequestOverrides = baseConfig.RequestOverrides,
            InstructionsPrompt = baseConfig.InstructionsPrompt,
            ResponseSummary = baseConfig.ResponseSummary,
            ComputerUseEnabled = baseConfig.ComputerUseEnabled,
            Organization = baseConfig.Organization,
            Project = baseConfig.Project,
            AccountId = baseConfig.AccountId,
            WebsocketUrl = baseConfig.WebsocketUrl,
            WebsocketMode = baseConfig.WebsocketMode
        };

        var innerToolContext = new ToolContext
        {
            SessionId = toolContext.SessionId,
            WorkingFolder = toolContext.WorkingFolder,
            CurrentToolUseId = toolUseId,
            AgentRunId = toolContext.AgentRunId,
            ProviderConfig = config,
            ElectronInvokeAsync = toolContext.ElectronInvokeAsync,
            RendererToolInvokeAsync = toolContext.RendererToolInvokeAsync,
            RendererToolRequiresApprovalAsync = toolContext.RendererToolRequiresApprovalAsync,
            EmitAgentEventAsync = toolContext.EmitAgentEventAsync,
            InlineToolHandlers = MergeInlineHandlers(toolContext.InlineToolHandlers, submitReportTool.Handler),
            LocalToolHandlers = toolContext.LocalToolHandlers,
            ReadFileHistory = toolContext.ReadFileHistory
        };

        List<UnifiedMessage>? capturedFinalMessages = null;
        var runConfig = new AgentLoopRunConfig
        {
            Provider = provider,
            ProviderConfig = config,
            Tools = tools,
            ToolRegistry = _toolRegistry,
            ToolContext = innerToolContext,
            MaxIterations = SubAgentDefinition.ResolveMaxTurns(definition.MaxTurns),
            EnableParallelToolExecution = true,
            CaptureFinalMessages = messages => capturedFinalMessages = messages
        };

        var aggregatedText = new StringBuilder();
        var currentAssistantText = new StringBuilder();
        var lastAssistantText = string.Empty;
        var trackedToolCalls = new List<ToolCallState>();
        var usage = new TokenUsage { InputTokens = 0, OutputTokens = 0 };
        var iterations = 0;
        var toolCallCount = 0;
        var finalReason = "completed";
        string? errorMessage = null;
        var submitReportTerminated = false;

        ApprovalHandler? approvalHandler = onApproval is null
            ? null
            : async toolCall => ReadOnlyTools.Contains(toolCall.Name) || await onApproval(toolCall);

        try
        {
            await foreach (var evt in AgentLoop.RunAsync(new List<UnifiedMessage> { promptMessage }, runConfig, approvalHandler, ct))
            {
                switch (evt)
                {
                    case IterationStartEvent iterationEvt:
                        CommitAssistantText(currentAssistantText, ref lastAssistantText);
                        iterations = iterationEvt.Iteration;
                        await EmitEventAsync(toolContext, new SubAgentIterationEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            Iteration = iterationEvt.Iteration,
                            AssistantMessage = CreateAssistantPlaceholderMessage()
                        }, ct);
                        break;

                    case ThinkingDeltaEvent thinkingEvt:
                        await EmitEventAsync(toolContext, new SubAgentThinkingDeltaEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            Thinking = thinkingEvt.Thinking
                        }, ct);
                        break;

                    case ThinkingEncryptedEvent thinkingEncryptedEvt:
                        await EmitEventAsync(toolContext, new SubAgentThinkingEncryptedEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            ThinkingEncryptedContent = thinkingEncryptedEvt.ThinkingEncryptedContent,
                            ThinkingEncryptedProvider = thinkingEncryptedEvt.ThinkingEncryptedProvider
                        }, ct);
                        break;

                    case TextDeltaEvent textEvt:
                        aggregatedText.Append(textEvt.Text);
                        currentAssistantText.Append(textEvt.Text);
                        await EmitEventAsync(toolContext, new SubAgentTextDeltaEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            Text = textEvt.Text
                        }, ct);
                        break;

                    case ToolUseStreamingStartEvent toolUseStartEvt:
                        await EmitEventAsync(toolContext, new SubAgentToolUseStreamingStartEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            ToolCallId = toolUseStartEvt.ToolCallId,
                            ToolName = toolUseStartEvt.ToolName,
                            ToolCallExtraContent = toolUseStartEvt.ToolCallExtraContent
                        }, ct);
                        break;

                    case ToolUseArgsDeltaEvent toolArgsEvt:
                        await EmitEventAsync(toolContext, new SubAgentToolUseArgsDeltaEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            ToolCallId = toolArgsEvt.ToolCallId,
                            PartialInput = CloneJsonDictionary(toolArgsEvt.PartialInput)
                        }, ct);
                        break;

                    case ToolUseGeneratedEvent toolGeneratedEvt:
                        await EmitEventAsync(toolContext, new SubAgentToolUseGeneratedEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            ToolUseBlock = new ToolUseBlock
                            {
                                Id = toolGeneratedEvt.Id,
                                Name = toolGeneratedEvt.Name,
                                Input = CloneJsonDictionary(toolGeneratedEvt.Input),
                                ExtraContent = toolGeneratedEvt.ExtraContent
                            }
                        }, ct);
                        break;

                    case ToolCallStartEvent toolCallStartEvt when toolCallStartEvt.ToolCall is not null:
                        UpsertToolCall(trackedToolCalls, toolCallStartEvt.ToolCall);
                        await EmitEventAsync(toolContext, new SubAgentToolCallEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            ToolCall = CloneToolCall(toolCallStartEvt.ToolCall)
                        }, ct);
                        break;

                    case ToolCallResultEvent toolCallResultEvt when toolCallResultEvt.ToolCall is not null:
                        toolCallCount++;
                        UpsertToolCall(trackedToolCalls, toolCallResultEvt.ToolCall);
                        await EmitEventAsync(toolContext, new SubAgentToolCallEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            ToolCall = CloneToolCall(toolCallResultEvt.ToolCall)
                        }, ct);
                        // If SubmitReport just completed, stop immediately —
                        // don't wait for any other tools in the same batch or
                        // for the iteration_end wrap-up. This is what flips
                        // the card from "in progress" to "done" as soon as
                        // the report is submitted.
                        if (string.Equals(toolCallResultEvt.ToolCall.Name, SubmitReportTool.ToolName, StringComparison.Ordinal)
                            && submitReportTool.GetReport() is not null)
                        {
                            finalReason = "completed";
                            submitReportTerminated = true;
                        }
                        break;

                    case MessageEndEvent messageEndEvt:
                        if (messageEndEvt.Usage is not null)
                        {
                            MergeUsage(usage, messageEndEvt.Usage);
                        }
                        await EmitEventAsync(toolContext, new SubAgentMessageEndEvent
                        {
                            SubAgentName = definition.Name,
                            ToolUseId = toolUseId,
                            Usage = messageEndEvt.Usage,
                            ProviderResponseId = messageEndEvt.ProviderResponseId
                        }, ct);
                        break;

                    case IterationEndEvent iterationEndEvt:
                        CommitAssistantText(currentAssistantText, ref lastAssistantText);
                        if (iterationEndEvt.ToolResults is { Count: > 0 })
                        {
                            await EmitEventAsync(toolContext, new SubAgentToolResultMessageEvent
                            {
                                SubAgentName = definition.Name,
                                ToolUseId = toolUseId,
                                Message = BuildToolResultMessage(iterationEndEvt.ToolResults)
                            }, ct);
                        }
                        // If the sub-agent called SubmitReport during this
                        // iteration, terminate the loop cleanly. We wait
                        // until iteration_end so any parallel tool calls in
                        // the same batch complete first.
                        if (submitReportTool.GetReport() is not null)
                        {
                            finalReason = "completed";
                            submitReportTerminated = true;
                        }
                        break;

                    case LoopEndEvent loopEndEvt:
                        CommitAssistantText(currentAssistantText, ref lastAssistantText);
                        finalReason = loopEndEvt.Reason;
                        break;

                    case AgentErrorEvent agentErrorEvt:
                        errorMessage = agentErrorEvt.Message;
                        finalReason = "error";
                        break;
                }

                if (submitReportTerminated)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            finalReason = "aborted";
        }
        catch (Exception ex)
        {
            errorMessage = ex.Message;
            finalReason = "error";
        }
        finally
        {
            CommitAssistantText(currentAssistantText, ref lastAssistantText);
        }

        var unavailableToolsSuffix = invalidTools.Count > 0
            ? $" Unavailable tools: {string.Join(", ", invalidTools)}."
            : string.Empty;

        // Primary path: the model called SubmitReport and gave us an explicit
        // report payload — always prefer this over scraped assistant text.
        var submittedReport = submitReportTool.GetReport();
        var finalOutput = !string.IsNullOrWhiteSpace(submittedReport)
            ? submittedReport.Trim()
            : (lastAssistantText.Trim() is { Length: > 0 } finalText
                ? finalText
                : aggregatedText.ToString().Trim());

        // Fallback report synthesis: if the loop ended without any visible text
        // AND no SubmitReport payload, replay the transcript with a
        // report-request message (no tools) so the caller always gets a usable
        // summary instead of an empty output.
        if (string.IsNullOrWhiteSpace(finalOutput)
            && capturedFinalMessages is { Count: > 0 }
            && !ct.IsCancellationRequested)
        {
            try
            {
                var fallback = await RunFallbackReportAsync(
                    capturedFinalMessages,
                    provider,
                    config,
                    innerToolContext,
                    ct);
                if (!string.IsNullOrWhiteSpace(fallback))
                {
                    finalOutput = fallback.Trim();
                }
            }
            catch (Exception fallbackErr)
            {
                Console.Error.WriteLine($"[SubAgentRunner] fallback report synthesis failed: {fallbackErr}");
            }
        }

        var success = finalReason is not "error" and not "aborted";
        var finalError = errorMessage is null ? null : $"{errorMessage}{unavailableToolsSuffix}";

        return await FinalizeAsync(
            definition,
            toolUseId,
            toolContext,
            startedAt,
            finalOutput,
            aggregatedText.ToString(),
            trackedToolCalls,
            iterations,
            usage,
            success,
            finalError,
            ct);
    }

    private async Task<string?> RunFallbackReportAsync(
        List<UnifiedMessage> capturedMessages,
        ILlmProvider provider,
        ProviderConfig config,
        ToolContext innerToolContext,
        CancellationToken ct)
    {
        var reportRequestMessage = new UnifiedMessage
        {
            Role = "user",
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Content = new List<ContentBlock> { new TextBlock { Text = DefaultFallbackReportPrompt } },
            RawContent = JsonSerializer.SerializeToElement(DefaultFallbackReportPrompt, AppJsonContext.Default.String)
        };

        var replayMessages = new List<UnifiedMessage>(capturedMessages.Count + 1);
        replayMessages.AddRange(capturedMessages);
        replayMessages.Add(reportRequestMessage);

        // Strip tools so the model cannot defer work into another tool call —
        // it has no choice but to emit the report as text. Single iteration is
        // enough; we only want a text response.
        var followUpConfig = new AgentLoopRunConfig
        {
            Provider = provider,
            ProviderConfig = config,
            Tools = new List<ToolDefinition>(),
            ToolRegistry = _toolRegistry,
            ToolContext = innerToolContext,
            MaxIterations = 1,
            EnableParallelToolExecution = false,
            CaptureFinalMessages = null
        };

        var reportText = new StringBuilder();
        await foreach (var evt in AgentLoop.RunAsync(replayMessages, followUpConfig, onApproval: null, ct))
        {
            if (evt is TextDeltaEvent textEvt)
            {
                reportText.Append(textEvt.Text);
            }
        }

        var text = reportText.ToString().Trim();
        return text.Length > 0 ? text : null;
    }

    private async Task<SubAgentExecutionResult> FinalizeAsync(
        SubAgentDefinition definition,
        string toolUseId,
        ToolContext toolContext,
        long startedAt,
        string finalOutput,
        string aggregatedText,
        List<ToolCallState> trackedToolCalls,
        int iterations,
        TokenUsage usage,
        bool success,
        string? error,
        CancellationToken ct)
    {
        var output = success
            ? finalOutput
            : string.IsNullOrWhiteSpace(finalOutput) ? aggregatedText.Trim() : finalOutput;
        var hasOutput = !string.IsNullOrWhiteSpace(output);
        var result = new SubAgentResult
        {
            Success = success,
            Output = output,
            ReportSubmitted = hasOutput,
            ToolCallCount = trackedToolCalls.Count(tc => tc.Status is ToolCallStatus.Completed or ToolCallStatus.Error),
            Iterations = iterations,
            Usage = usage,
            Error = error
        };

        await EmitEventAsync(toolContext, new SubAgentReportUpdateEvent
        {
            SubAgentName = definition.Name,
            ToolUseId = toolUseId,
            Report = output,
            Status = hasOutput ? "submitted" : "missing"
        }, ct);

        await EmitEventAsync(toolContext, new SubAgentEndEvent
        {
            SubAgentName = definition.Name,
            ToolUseId = toolUseId,
            Result = result
        }, ct);

        return new SubAgentExecutionResult
        {
            Result = result,
            ElapsedMs = Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - startedAt),
            ToolCalls = trackedToolCalls.Select(CloneToolCall).ToList()
        };
    }

    private List<ToolDefinition> ResolveTools(SubAgentDefinition definition, out List<string> invalidTools)
    {
        var allTools = _toolRegistry.GetDefinitions();
        invalidTools = new List<string>();
        var disallowed = definition.DisallowedTools is { Count: > 0 }
            ? new HashSet<string>(definition.DisallowedTools, StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);
        disallowed.UnionWith(MandatoryDisallowedTools);

        if (definition.Tools is null || definition.Tools.Count == 0)
            return allTools.Where(t => !disallowed.Contains(t.Name)).ToList();

        if (definition.Tools.Count == 1 && definition.Tools[0] == "*")
            return allTools.Where(t => !disallowed.Contains(t.Name)).ToList();

        var allowedNames = new HashSet<string>(definition.Tools);
        invalidTools = definition.Tools
            .Where(name => allTools.All(tool => !string.Equals(tool.Name, name, StringComparison.Ordinal)))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var resolved = allTools.Where(t => allowedNames.Contains(t.Name)).ToList();

        resolved = resolved.Where(t => !disallowed.Contains(t.Name)).ToList();

        return resolved;
    }

    private static async Task EmitEventAsync(ToolContext toolContext, AgentEvent evt, CancellationToken ct)
    {
        if (toolContext.EmitAgentEventAsync is null)
            return;

        await toolContext.EmitAgentEventAsync(evt, ct);
    }

    private static UnifiedMessage CreatePromptMessage(Dictionary<string, JsonElement> input, string? initialPrompt)
    {
        var createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var promptText = BuildPromptText(input, initialPrompt);
        return new UnifiedMessage
        {
            Role = "user",
            CreatedAt = createdAt,
            Content = new List<ContentBlock> { new TextBlock { Text = promptText } },
            RawContent = JsonSerializer.SerializeToElement(promptText, AppJsonContext.Default.String)
        };
    }

    private static UnifiedMessage CreateAssistantPlaceholderMessage()
    {
        return new UnifiedMessage
        {
            Role = "assistant",
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Content = new List<ContentBlock>(),
            RawContent = JsonSerializer.SerializeToElement(string.Empty, AppJsonContext.Default.String)
        };
    }

    private static UnifiedMessage BuildToolResultMessage(IEnumerable<ToolResultSummary> summaries)
    {
        var content = summaries
            .Select(summary => (ContentBlock)new ToolResultBlock
            {
                ToolUseId = summary.ToolUseId,
                RawContent = summary.Content,
                IsError = summary.IsError
            })
            .ToList();

        return new UnifiedMessage
        {
            Role = "user",
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Content = content,
            RawContent = JsonSerializer.SerializeToElement(content, AppJsonContext.Default.ListContentBlock)
        };
    }

    private static string BuildPromptText(Dictionary<string, JsonElement> input, string? initialPrompt)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(initialPrompt))
            parts.Add(initialPrompt.Trim());

        if (TryGetString(input, "prompt", out var prompt))
            parts.Add(prompt);
        else if (TryGetString(input, "query", out var query))
            parts.Add(query);
        else if (TryGetString(input, "task", out var task))
            parts.Add(task);
        else if (TryGetString(input, "target", out var target))
        {
            parts.Add($"Analyze: {target}");
            if (TryGetString(input, "focus", out var focus))
                parts.Add($"Focus: {focus}");
        }
        else
        {
            parts.Add(JsonSerializer.Serialize(input, AppJsonContext.Default.DictionaryStringJsonElement));
        }

        if (TryGetString(input, "scope", out var scope))
            parts.Add($"\nScope: {scope}");
        if (TryGetString(input, "constraints", out var constraints))
            parts.Add($"\nConstraints: {constraints}");

        parts.Add(@"
Session termination protocol:
- When you are done with the task, you MUST end the session by calling the `SubmitReport` tool exactly once.
- Calling `SubmitReport` terminates this sub-agent session immediately — do NOT call any other tools afterwards.
- Do NOT stop by simply emitting an assistant message. Plain-text endings are treated as ""session ran out"" and trigger a fallback report synthesis you cannot control.
- Do NOT call `SubmitReport` with an empty `report` argument; empty submissions are rejected and you will be asked to retry.
- Write the report in the same language as the user's request.
- If evidence is incomplete, state the uncertainty inside the report, but still submit it.
- Even when nothing useful is found, submit a short report instead of leaving the session dangling.

Structure the `report` argument with these sections:
## Conclusion
## Key Findings
## Evidence
## Risks / Unknowns
## Next Steps");

        return string.Join("\n", parts);
    }

    private static void CommitAssistantText(StringBuilder currentAssistantText, ref string lastAssistantText)
    {
        var trimmed = currentAssistantText.ToString().Trim();
        if (!string.IsNullOrWhiteSpace(trimmed))
            lastAssistantText = trimmed;
        currentAssistantText.Clear();
    }

    private static void UpsertToolCall(List<ToolCallState> trackedToolCalls, ToolCallState toolCall)
    {
        var idx = trackedToolCalls.FindIndex(existing => existing.Id == toolCall.Id);
        if (idx >= 0)
            trackedToolCalls[idx] = CloneToolCall(toolCall);
        else
            trackedToolCalls.Add(CloneToolCall(toolCall));
    }

    private static ToolCallState CloneToolCall(ToolCallState toolCall)
    {
        return new ToolCallState
        {
            Id = toolCall.Id,
            Name = toolCall.Name,
            Input = CloneJsonDictionary(toolCall.Input),
            Status = toolCall.Status,
            Output = toolCall.Output?.Clone(),
            Error = toolCall.Error,
            RequiresApproval = toolCall.RequiresApproval,
            ExtraContent = toolCall.ExtraContent,
            StartedAt = toolCall.StartedAt,
            CompletedAt = toolCall.CompletedAt
        };
    }

    private static Dictionary<string, JsonElement> CloneJsonDictionary(Dictionary<string, JsonElement> input)
    {
        var clone = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, value) in input)
        {
            clone[key] = value.Clone();
        }
        return clone;
    }

    private static void MergeUsage(TokenUsage target, TokenUsage usage)
    {
        target.InputTokens += usage.InputTokens;
        target.OutputTokens += usage.OutputTokens;
        if (usage.BillableInputTokens is not null)
            target.BillableInputTokens = (target.BillableInputTokens ?? 0) + usage.BillableInputTokens;
        if (usage.CacheCreationTokens is not null)
            target.CacheCreationTokens = (target.CacheCreationTokens ?? 0) + usage.CacheCreationTokens;
        if (usage.CacheReadTokens is not null)
            target.CacheReadTokens = (target.CacheReadTokens ?? 0) + usage.CacheReadTokens;
        if (usage.ReasoningTokens is not null)
            target.ReasoningTokens = (target.ReasoningTokens ?? 0) + usage.ReasoningTokens;
        if (usage.ContextTokens is not null)
            target.ContextTokens = usage.ContextTokens;
        if (usage.ContextLength is not null)
            target.ContextLength = usage.ContextLength;
        if (usage.TotalDurationMs is not null)
            target.TotalDurationMs = (target.TotalDurationMs ?? 0) + usage.TotalDurationMs;
        if (usage.RequestTimings is { Count: > 0 })
        {
            target.RequestTimings ??= new List<RequestTiming>();
            target.RequestTimings.AddRange(usage.RequestTimings);
        }
    }

    private static bool TryGetString(Dictionary<string, JsonElement> input, string key, out string value)
    {
        value = string.Empty;
        if (!input.TryGetValue(key, out var raw))
            return false;
        if (raw.ValueKind != JsonValueKind.String)
            return false;
        var text = raw.GetString();
        if (string.IsNullOrWhiteSpace(text))
            return false;
        value = text;
        return true;
    }
}
