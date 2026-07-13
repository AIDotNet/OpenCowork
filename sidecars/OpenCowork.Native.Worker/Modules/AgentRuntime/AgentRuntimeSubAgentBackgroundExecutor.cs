using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

internal static partial class AgentRuntimeSubAgentExecutor
{
    private static readonly ConcurrentDictionary<string, BackgroundTeamRunHandle> BackgroundTeamRuns =
        new(StringComparer.Ordinal);

    internal static void CancelBackgroundTeamRuns(string teamName)
    {
        var normalizedTeamName = teamName.Trim();
        if (normalizedTeamName.Length == 0)
        {
            return;
        }

        foreach (var item in BackgroundTeamRuns.Values)
        {
            if (!string.Equals(item.TeamName, normalizedTeamName, StringComparison.Ordinal))
            {
                continue;
            }

            item.State.Cancel("team-delete");
            WorkerLog.Info(
                $"background teammate cancel requested team={normalizedTeamName} " +
                $"memberId={item.MemberId} runId={item.State.RunId}");
        }
    }

    private static async Task<RendererToolResult> ExecuteBackgroundTaskAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState parentState,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        // A background Task may only register a teammate when team tools are active for this
        // run (teams enabled in settings and a team scoped to this session). Without that, any
        // team_name the model passes is ignored -- spawning a background sub-agent must never
        // implicitly create a team.
        string? requestedTeamName = null;
        if (JsonHelpers.GetBool(parameters, "teamToolsActive", false))
        {
            requestedTeamName = JsonHelpers.GetString(call.Input, "team_name")?.Trim();
            if (string.IsNullOrWhiteSpace(requestedTeamName))
            {
                requestedTeamName = JsonHelpers.GetString(call.Input, "teamName")?.Trim();
            }
            if (string.IsNullOrWhiteSpace(requestedTeamName))
            {
                requestedTeamName = JsonHelpers.GetString(parameters, "activeTeamName")?.Trim();
            }
        }
        if (string.IsNullOrWhiteSpace(requestedTeamName))
        {
            return await ExecuteStandaloneBackgroundTaskAsync(
                call,
                parameters,
                parentState,
                context,
                cancellationToken);
        }

        var teamName = AgentRuntimeTeamRuntimeStore.ResolveTeamName(call.Input, parameters);
        if (teamName.Length == 0)
        {
            return ErrorResult("Background Task received an invalid team name.");
        }

        var memberName = JsonHelpers.GetString(call.Input, "name")?.Trim() ?? string.Empty;
        if (memberName.Length == 0)
        {
            return ErrorResult("Background Task requires a unique `name`.");
        }

        var prompt = JsonHelpers.GetString(call.Input, "prompt")?.Trim() ?? string.Empty;
        if (prompt.Length == 0)
        {
            return ErrorResult("Background Task requires a non-empty `prompt`.");
        }

        var subAgentType = JsonHelpers.GetString(call.Input, "subagent_type")?.Trim();
        if (string.IsNullOrWhiteSpace(subAgentType))
        {
            subAgentType = CustomSubAgentType;
        }

        var definition = ResolveDefinition(subAgentType, parameters, call.Input);
        if (definition is null)
        {
            return ErrorResult($"Unknown subagent_type \"{subAgentType}\".");
        }

        var parentLeaseWasYielded = YieldSubAgentConcurrencyLease(parentState);
        AgentRuntimeSubAgentConcurrencyLease? concurrencyLease = null;
        var concurrencyLeaseTransferred = false;
        try
        {
            var acquiredConcurrencyLease = await AcquireSubAgentConcurrencyLeaseAsync(
                definition.Name,
                call.Id,
                call.Input,
                parameters,
                parentState,
                context,
                cancellationToken);
            concurrencyLease = acquiredConcurrencyLease;
            var taskId = ReadTaskId(call.Input);
            var provider = BuildProvider(
                parameters,
                definition,
                JsonHelpers.GetString(call.Input, "model")?.Trim());
            var promptMessage = BuildPromptMessage(call.Input, definition.InitialPrompt);
            var innerTools = ResolveSubAgentTools(parameters, definition);

            var snapshot = AgentRuntimeTeamRuntimeStore.AddWorkerMember(
                teamName,
                memberName,
                JsonHelpers.GetString(provider, "model"),
                definition.Name,
                JsonHelpers.GetString(call.Input, "backend_type"),
                taskId.Length == 0 ? null : taskId,
                out var member);
            var memberId = AgentRuntimeTeamRuntimeStore.GetString(member, "agentId");

            if (taskId.Length > 0)
            {
                snapshot = AgentRuntimeTeamRuntimeStore.ClaimTask(teamName, taskId, memberName);
            }

            await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
                context,
                parameters,
                snapshot,
                openPanel: false,
                cancellationToken);

            var childRunId = $"team-worker-{memberId}-{Guid.NewGuid():N}";
            var childParameters = BuildChildParameters(
                parameters,
                provider,
                promptMessage,
                innerTools,
                definition,
                call.Id,
                childRunId,
                teamName);
            var childState = new AgentRuntimeTools.AgentRuntimeRunState(childRunId, parentState.SessionId)
            {
                SuppressTransportEvents = true,
                SubAgentConcurrencyLease = acquiredConcurrencyLease
            };
            childState.ReplaceParameters(childParameters);
            var collector = new BackgroundSubAgentRunCollector();
            childState.EventObserver = collector.ObserveAsync;

            var handle = new BackgroundTeamRunHandle(teamName, memberId, childState);
            BackgroundTeamRuns[childRunId] = handle;

            WorkerLog.Info(
                $"background teammate accepted team={teamName} member={memberName} memberId={memberId} " +
                $"runId={childRunId} taskId={FormatOptionalLogValue(taskId)} agent={definition.Name}");

            _ = Task.Run(
                async () => await RunBackgroundTaskAsync(
                    teamName,
                    memberName,
                    memberId,
                    taskId,
                    definition.Name,
                    childState,
                    collector,
                    context,
                    parameters.Clone()),
                CancellationToken.None);
            concurrencyLeaseTransferred = true;

            // The child owns its lifecycle. The parent loop observes this stop only
            // after every tool call already emitted in the current assistant message
            // has been processed; additional launches join the same global FIFO gate.
            parentState.RequestStop("completed");

            return new RendererToolResult(
                StringElement(CreateObject(writer =>
                {
                    writer.WriteBoolean("success", true);
                    writer.WriteBoolean("background", true);
                    writer.WriteString("team_name", teamName);
                    writer.WriteString("member_id", memberId);
                    writer.WriteString("name", memberName);
                    writer.WriteString("subagent_type", definition.Name);
                    if (taskId.Length > 0)
                    {
                        writer.WriteString("task_id", taskId);
                    }
                    writer.WriteString(
                        "message",
                        "Background teammate started in the .NET Native Worker. The main agent turn will resume automatically when the teammate reports completion.");
                }).GetRawText()),
                false,
                null);
        }
        finally
        {
            if (!concurrencyLeaseTransferred)
            {
                concurrencyLease?.Dispose();
                await RestoreSubAgentConcurrencyLeaseAsync(
                    parentLeaseWasYielded,
                    parameters,
                    parentState);
            }
        }
    }

    private static async Task<RendererToolResult> ExecuteStandaloneBackgroundTaskAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState parentState,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        parentState.CancellationToken.ThrowIfCancellationRequested();

        var prompt = JsonHelpers.GetString(call.Input, "prompt")?.Trim() ?? string.Empty;
        if (prompt.Length == 0)
        {
            return ErrorResult("Background Task requires a non-empty `prompt`.");
        }

        var subAgentType = JsonHelpers.GetString(call.Input, "subagent_type")?.Trim();
        if (string.IsNullOrWhiteSpace(subAgentType))
        {
            subAgentType = CustomSubAgentType;
        }

        var definition = ResolveDefinition(subAgentType, parameters, call.Input);
        if (definition is null)
        {
            return ErrorResult($"Unknown subagent_type \"{subAgentType}\".");
        }

        var parentLeaseWasYielded = YieldSubAgentConcurrencyLease(parentState);
        AgentRuntimeSubAgentConcurrencyLease? concurrencyLease = null;
        var concurrencyLeaseTransferred = false;
        try
        {
            var acquiredConcurrencyLease = await AcquireSubAgentConcurrencyLeaseAsync(
                definition.Name,
                call.Id,
                call.Input,
                parameters,
                parentState,
                context,
                cancellationToken);
            concurrencyLease = acquiredConcurrencyLease;
            var displayName = JsonHelpers.GetString(call.Input, "name")?.Trim();
            if (string.IsNullOrWhiteSpace(displayName))
            {
                displayName = definition.Name;
            }

            var provider = BuildProvider(
                parameters,
                definition,
                JsonHelpers.GetString(call.Input, "model")?.Trim());
            var promptMessage = BuildPromptMessage(call.Input, definition.InitialPrompt);
            var innerTools = ResolveSubAgentTools(parameters, definition);

            var childRunId = $"background-subagent-{call.Id}-{Guid.NewGuid():N}";
            var childParameters = BuildChildParameters(
                parameters,
                provider,
                promptMessage,
                innerTools,
                definition,
                call.Id,
                childRunId);
            var childState = new AgentRuntimeTools.AgentRuntimeRunState(childRunId, parentState.SessionId)
            {
                SuppressTransportEvents = true,
                SubAgentConcurrencyLease = acquiredConcurrencyLease
            };
            childState.ReplaceParameters(childParameters);
            var collector = new BackgroundSubAgentRunCollector(
                displayName,
                definition.Name,
                call.Id,
                parentState.SessionId,
                provider,
                context);
            childState.EventObserver = collector.ObserveAsync;

            await AgentRuntimeTools.EmitAsync(
                parentState,
                context,
                new AgentRuntimeStreamEvent(
                    "sub_agent_start",
                    SubAgentName: definition.Name,
                    ToolUseId: call.Id,
                    McpServerIds: ResolveMcpServerIds(innerTools),
                    PermissionMode: ResolvePermissionMode(parameters),
                    Input: call.Input.Clone(),
                    PromptMessage: promptMessage));

            WorkerLog.Info(
                $"standalone background sub-agent accepted name={displayName} runId={childRunId} " +
                $"toolUseId={call.Id} sessionId={parentState.SessionId} agent={definition.Name}");

            _ = Task.Run(
                async () => await RunStandaloneBackgroundTaskAsync(
                    displayName,
                    definition.Name,
                    call.Id,
                    childState,
                    collector,
                    context),
                CancellationToken.None);
            concurrencyLeaseTransferred = true;

            parentState.RequestStop("completed");

            return new RendererToolResult(
                StringElement(CreateObject(writer =>
                {
                    writer.WriteBoolean("success", true);
                    writer.WriteBoolean("background", true);
                    writer.WriteString("run_id", childRunId);
                    writer.WriteString("name", displayName);
                    writer.WriteString("subagent_type", definition.Name);
                    writer.WriteString(
                        "message",
                        "Standalone background sub-agent started. The main agent turn will resume automatically when it finishes.");
                }).GetRawText()),
                false,
                null);
        }
        finally
        {
            if (!concurrencyLeaseTransferred)
            {
                concurrencyLease?.Dispose();
                await RestoreSubAgentConcurrencyLeaseAsync(
                    parentLeaseWasYielded,
                    parameters,
                    parentState);
            }
        }
    }

    private static async Task RunStandaloneBackgroundTaskAsync(
        string displayName,
        string agentName,
        string toolUseId,
        AgentRuntimeTools.AgentRuntimeRunState childState,
        BackgroundSubAgentRunCollector collector,
        WorkerRequestContext context)
    {
        using var operation = WorkerMemory.TrackOperation("standalone-background-subagent");
        try
        {
            WorkerLog.Debug(
                $"standalone background sub-agent start name={displayName} runId={childState.RunId} " +
                $"toolUseId={toolUseId} agent={agentName}");
            await OpenAIChatRuntime.ExecuteLoopAsync(childState.Parameters, childState, context);
        }
        catch (OperationCanceledException) when (childState.IsCancellationRequested)
        {
            var reason = childState.CancellationReason ?? "unknown";
            collector.SetError($"Background sub-agent was cancelled ({reason}).");
            childState.RequestStop("aborted");
            WorkerLog.Warn(
                $"standalone background sub-agent cancelled name={displayName} " +
                $"runId={childState.RunId} toolUseId={toolUseId} reason={reason}");
        }
        catch (OperationCanceledException ex)
        {
            // HttpClient timeouts and interrupted tool operations also surface as
            // OperationCanceledException. They are failures, not user cancellations.
            collector.SetError(
                $"Background sub-agent operation was interrupted: {ex.Message}");
            childState.RequestStop("error");
            WorkerLog.Warn(
                $"standalone background sub-agent interrupted name={displayName} " +
                $"runId={childState.RunId} toolUseId={toolUseId} " +
                $"error={ex.GetType().Name}: {ex.Message}");
        }
        catch (Exception ex)
        {
            collector.SetError(ex.Message);
            WorkerLog.Warn(
                $"standalone background sub-agent failed name={displayName} runId={childState.RunId} " +
                $"toolUseId={toolUseId} error={ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            try
            {
                var result = collector.BuildResult(childState.StopReason);
                await EmitStandaloneBackgroundCompletionAsync(
                    childState.SessionId,
                    displayName,
                    agentName,
                    toolUseId,
                    result,
                    context);
                WorkerLog.Info(
                    $"standalone background sub-agent finalized name={displayName} runId={childState.RunId} " +
                    $"toolUseId={toolUseId} success={result.Success} reportChars={result.Output.Length}");
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"standalone background sub-agent completion delivery failed name={displayName} " +
                    $"runId={childState.RunId} toolUseId={toolUseId} " +
                    $"error={ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                AgentRuntimeNativeToolExecutor.ClearRun(childState.RunId);
                childState.SubAgentConcurrencyLease?.Dispose();
                childState.SubAgentConcurrencyLease = null;
                childState.Dispose();
                WorkerMemory.ReportCompletedWork(
                    "standalone-background-subagent",
                    pressureBytes: 0,
                    forceTrim: true);
            }
        }
    }

    private static async Task EmitStandaloneBackgroundCompletionAsync(
        string sessionId,
        string displayName,
        string agentName,
        string toolUseId,
        SubAgentResultNative result,
        WorkerRequestContext context)
    {
        var payload = CreateObject(writer =>
        {
            writer.WriteString("action", "completed");
            writer.WriteString("sessionId", sessionId);
            writer.WriteString("displayName", displayName);
            writer.WriteString("subAgentName", agentName);
            writer.WriteString("toolUseId", toolUseId);
            writer.WritePropertyName("result");
            result.ToJson().WriteTo(writer);
        });

        await AgentRuntimeReverseRequests.RequestAsync(
            context,
            "subagent/ui-update",
            payload,
            CancellationToken.None);
    }

    private static async Task RunBackgroundTaskAsync(
        string teamName,
        string memberName,
        string memberId,
        string taskId,
        string agentName,
        AgentRuntimeTools.AgentRuntimeRunState childState,
        BackgroundSubAgentRunCollector collector,
        WorkerRequestContext context,
        JsonElement parameters)
    {
        using var operation = WorkerMemory.TrackOperation("team-background-task");
        try
        {
            WorkerLog.Debug(
                $"background teammate start team={teamName} member={memberName} " +
                $"memberId={memberId} runId={childState.RunId} agent={agentName}");

            await OpenAIChatRuntime.ExecuteLoopAsync(childState.Parameters, childState, context);
        }
        catch (OperationCanceledException)
        {
            collector.SetError("Background teammate was cancelled.");
            childState.RequestStop("aborted");
        }
        catch (Exception ex)
        {
            collector.SetError(ex.Message);
            WorkerLog.Warn(
                $"background teammate failed team={teamName} memberId={memberId} " +
                $"runId={childState.RunId} error={ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            try
            {
                await FinalizeBackgroundTaskAsync(
                    teamName,
                    memberName,
                    memberId,
                    taskId,
                    childState,
                    collector,
                    context,
                    parameters);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"background teammate finalization failed team={teamName} memberId={memberId} " +
                    $"runId={childState.RunId} error={ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                BackgroundTeamRuns.TryRemove(childState.RunId, out _);
                AgentRuntimeNativeToolExecutor.ClearRun(childState.RunId);
                childState.SubAgentConcurrencyLease?.Dispose();
                childState.SubAgentConcurrencyLease = null;
                childState.Dispose();
                WorkerMemory.ReportCompletedWork("team-background-task", pressureBytes: 0, forceTrim: true);
            }
        }
    }

    private static async Task FinalizeBackgroundTaskAsync(
        string teamName,
        string memberName,
        string memberId,
        string taskId,
        AgentRuntimeTools.AgentRuntimeRunState childState,
        BackgroundSubAgentRunCollector collector,
        WorkerRequestContext context,
        JsonElement parameters)
    {
        var result = collector.BuildResult(childState.StopReason);
        var report = result.Output.Trim();
        if (report.Length == 0 && !string.IsNullOrWhiteSpace(result.Error))
        {
            report = $"Teammate failed: {result.Error}";
        }
        if (report.Length == 0)
        {
            report = "Teammate finished without a report.";
        }

        TeamSnapshot snapshot;
        if (taskId.Length > 0)
        {
            snapshot = AgentRuntimeTeamRuntimeStore.CompleteTask(teamName, taskId, memberName, report);
        }
        else
        {
            snapshot = AgentRuntimeTeamRuntimeStore.ReadSnapshot(teamName, 10);
        }

        snapshot = AgentRuntimeTeamRuntimeStore.UpdateMember(
            teamName,
            memberId,
            status: "stopped",
            clearCurrentTaskId: true,
            isActive: false,
            completedAt: NowMs());

        snapshot = AgentRuntimeTeamRuntimeStore.AppendMessage(
            teamName,
            "message",
            "lead",
            BuildCompletionMessage(memberName, taskId, result, report),
            memberName,
            result.Success ? "completed" : "failed");

        await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
            context,
            parameters,
            snapshot,
            openPanel: false,
            CancellationToken.None);

        WorkerLog.Info(
            $"background teammate finalized team={teamName} member={memberName} memberId={memberId} " +
            $"runId={childState.RunId} taskId={FormatOptionalLogValue(taskId)} " +
            $"success={result.Success} reportChars={report.Length} toolCalls={result.ToolCallCount}");
    }

    private static string BuildCompletionMessage(
        string memberName,
        string taskId,
        SubAgentResultNative result,
        string report)
    {
        var builder = new StringBuilder();
        builder.Append("Teammate ");
        builder.Append(memberName);
        builder.Append(result.Success ? " completed" : " stopped with an error");
        if (taskId.Length > 0)
        {
            builder.Append(" task ");
            builder.Append(taskId);
        }
        builder.Append('.');
        if (!result.Success && !string.IsNullOrWhiteSpace(result.Error))
        {
            builder.Append("\n\nError: ");
            builder.Append(result.Error);
        }
        builder.Append("\n\n");
        builder.Append(report);
        return builder.ToString();
    }

    private static string ReadTaskId(JsonElement input)
    {
        return (JsonHelpers.GetString(input, "task_id") ??
                JsonHelpers.GetString(input, "taskId") ??
                string.Empty)
            .Trim();
    }

    private static string FormatOptionalLogValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "<none>" : value;
    }

    private sealed record BackgroundTeamRunHandle(
        string TeamName,
        string MemberId,
        AgentRuntimeTools.AgentRuntimeRunState State);

    private sealed class BackgroundSubAgentRunCollector
    {
        private readonly StringBuilder currentAssistantText = new();
        private readonly StringBuilder aggregatedText = new();
        private JsonElement[] finalMessages = [];
        private AgentRuntimeTokenUsage usage = new(0, 0);
        private int iterations;
        private int toolCallCount;
        private string? endReason;
        private string? error;
        private readonly string? displayName;
        private readonly string? subAgentName;
        private readonly string? toolUseId;
        private readonly string? sessionId;
        private readonly JsonElement requestModel;
        private readonly WorkerRequestContext? context;

        public BackgroundSubAgentRunCollector()
        {
        }

        public BackgroundSubAgentRunCollector(
            string displayName,
            string subAgentName,
            string toolUseId,
            string sessionId,
            JsonElement provider,
            WorkerRequestContext context)
        {
            this.displayName = displayName;
            this.subAgentName = subAgentName;
            this.toolUseId = toolUseId;
            this.sessionId = sessionId;
            this.context = context;
            requestModel = BuildBackgroundRequestModel(provider);
        }

        public async ValueTask ObserveAsync(AgentRuntimeStreamEvent[] events)
        {
            List<AgentRuntimeStreamEvent>? uiEvents = context is null ? null : [];
            foreach (var item in events)
            {
                ObserveOne(item);
                if (uiEvents is not null && BuildBackgroundUiEvent(item) is { } uiEvent)
                {
                    uiEvents.Add(uiEvent);
                }
            }
            if (uiEvents is { Count: > 0 })
            {
                await EmitProgressAsync(uiEvents);
            }
        }

        public void SetError(string message)
        {
            error = message;
        }

        public SubAgentResultNative BuildResult(string? fallbackEndReason)
        {
            var output = GetLastAssistantText(finalMessages);
            if (string.IsNullOrWhiteSpace(output))
            {
                output = currentAssistantText.ToString().Trim();
            }
            if (string.IsNullOrWhiteSpace(output))
            {
                output = aggregatedText.ToString().Trim();
            }

            var resolvedEndReason = ResolveSubAgentEndReason(endReason, fallbackEndReason, error);
            var resolvedError = ResolveSubAgentResultError(error, resolvedEndReason);
            var reportCaptured = !string.IsNullOrWhiteSpace(output);
            return new SubAgentResultNative(
                resolvedEndReason == "completed" && string.IsNullOrWhiteSpace(resolvedError),
                output ?? string.Empty,
                reportCaptured,
                toolCallCount,
                iterations,
                resolvedEndReason,
                finalMessages.Select(message => message.Clone()).ToArray(),
                usage,
                resolvedError);
        }

        private void ObserveOne(AgentRuntimeStreamEvent item)
        {
            switch (item.Type)
            {
                case "iteration_start":
                    iterations = item.Iteration ?? iterations;
                    currentAssistantText.Clear();
                    break;
                case "text_delta":
                    if (!string.IsNullOrEmpty(item.Text))
                    {
                        currentAssistantText.Append(item.Text);
                        aggregatedText.Append(item.Text);
                    }
                    break;
                case "message_end":
                    if (item.Usage is not null)
                    {
                        usage = MergeUsage(usage, item.Usage);
                    }
                    break;
                case "tool_call_result":
                    if (item.ToolCall is not null)
                    {
                        toolCallCount++;
                    }
                    break;
                case "loop_end":
                    finalMessages = item.Messages ?? [];
                    endReason = item.Reason;
                    break;
                case "error":
                    error = item.Message;
                    break;
            }
        }

        private AgentRuntimeStreamEvent? BuildBackgroundUiEvent(AgentRuntimeStreamEvent item)
        {
            if (subAgentName is null || toolUseId is null)
            {
                return null;
            }

            return item.Type switch
            {
                "iteration_start" => new AgentRuntimeStreamEvent(
                    "sub_agent_iteration",
                    Iteration: item.Iteration,
                    AssistantMessage: BuildBackgroundAssistantPlaceholder(),
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "text_delta" => new AgentRuntimeStreamEvent(
                    "sub_agent_text_delta",
                    Text: item.Text,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "thinking_delta" => new AgentRuntimeStreamEvent(
                    "sub_agent_thinking_delta",
                    Thinking: item.Thinking,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "thinking_encrypted" => new AgentRuntimeStreamEvent(
                    "sub_agent_thinking_encrypted",
                    ThinkingEncryptedContent: item.Content,
                    ThinkingEncryptedProvider: item.Provider,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "tool_use_streaming_start" => new AgentRuntimeStreamEvent(
                    "sub_agent_tool_use_streaming_start",
                    ToolCallId: item.ToolCallId,
                    ToolName: item.ToolName,
                    SubAgentToolCallExtraContent: item.ToolCallExtraContent,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "tool_use_args_delta" => new AgentRuntimeStreamEvent(
                    "sub_agent_tool_use_args_delta",
                    ToolCallId: item.ToolCallId,
                    PartialInput: item.PartialInput,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "tool_use_generated" => new AgentRuntimeStreamEvent(
                    "sub_agent_tool_use_generated",
                    ToolUseBlock: item.ToolUseBlock,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "image_generated" => new AgentRuntimeStreamEvent(
                    "sub_agent_image_generated",
                    ImageBlock: item.ImageBlock,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "image_error" => new AgentRuntimeStreamEvent(
                    "sub_agent_image_error",
                    ImageError: item.ImageError,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "message_end" => new AgentRuntimeStreamEvent(
                    "sub_agent_message_end",
                    Usage: item.Usage,
                    ProviderResponseId: item.ProviderResponseId,
                    RequestModel: requestModel,
                    SubAgentName: subAgentName,
                    ToolUseId: toolUseId),
                "tool_call_start" or "tool_call_result" when item.ToolCall is not null =>
                    new AgentRuntimeStreamEvent(
                        "sub_agent_tool_call",
                        ToolCall: item.ToolCall,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId),
                "iteration_end" when item.ToolResults is { Length: > 0 } toolResults =>
                    new AgentRuntimeStreamEvent(
                        "sub_agent_tool_result_message",
                        EventMessage: BuildBackgroundToolResultMessage(toolResults),
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId),
                _ => null
            };
        }

        private async Task EmitProgressAsync(IReadOnlyList<AgentRuntimeStreamEvent> events)
        {
            if (context is null || sessionId is null || toolUseId is null || subAgentName is null)
            {
                return;
            }

            var payload = CreateObject(writer =>
            {
                writer.WriteString("action", "progress");
                writer.WriteString("sessionId", sessionId);
                writer.WriteString("displayName", displayName ?? subAgentName);
                writer.WriteString("subAgentName", subAgentName);
                writer.WriteString("toolUseId", toolUseId);
                writer.WritePropertyName("events");
                JsonSerializer.Serialize(
                    writer,
                    events.ToArray(),
                    WorkerJsonContext.Default.AgentRuntimeStreamEventArray);
            });

            try
            {
                await AgentRuntimeReverseRequests.RequestAsync(
                    context,
                    "subagent/ui-update",
                    payload,
                    CancellationToken.None);
            }
            catch (Exception ex)
            {
                // Losing a renderer or detached window must not terminate the background task.
                WorkerLog.Warn(
                    $"background sub-agent progress delivery failed runId={toolUseId} " +
                    $"error={ex.GetType().Name}: {ex.Message}");
            }
        }

        private JsonElement BuildBackgroundAssistantPlaceholder()
        {
            return CreateObject(writer =>
            {
                writer.WriteString("id", $"oc_background_subagent_assistant_{Guid.NewGuid():N}");
                writer.WriteString("role", "assistant");
                writer.WriteString("content", string.Empty);
                writer.WriteNumber("createdAt", NowMs());
                writer.WritePropertyName("meta");
                writer.WriteStartObject();
                writer.WritePropertyName("requestModel");
                requestModel.WriteTo(writer);
                writer.WriteEndObject();
            });
        }

        private static JsonElement BuildBackgroundRequestModel(JsonElement provider)
        {
            return CreateObject(writer =>
            {
                WriteNullableString(writer, "providerId", JsonHelpers.GetString(provider, "providerId"));
                WriteNullableString(
                    writer,
                    "providerBuiltinId",
                    JsonHelpers.GetString(provider, "providerBuiltinId"));
                writer.WriteString("modelId", JsonHelpers.GetString(provider, "model") ?? string.Empty);
                writer.WriteString("modelName", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            });
        }

        private static JsonElement BuildBackgroundToolResultMessage(
            IReadOnlyList<AgentRuntimeToolResult> toolResults)
        {
            return CreateObject(writer =>
            {
                writer.WriteString("id", $"oc_background_subagent_tool_result_{Guid.NewGuid():N}");
                writer.WriteString("role", "user");
                writer.WritePropertyName("content");
                writer.WriteStartArray();
                foreach (var result in toolResults)
                {
                    writer.WriteStartObject();
                    writer.WriteString("type", "tool_result");
                    writer.WriteString("toolUseId", result.ToolUseId);
                    writer.WritePropertyName("content");
                    result.Content.WriteTo(writer);
                    if (result.IsError.HasValue)
                    {
                        writer.WriteBoolean("isError", result.IsError.Value);
                    }
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
                writer.WriteNumber("createdAt", NowMs());
            });
        }

        private static string GetLastAssistantText(IReadOnlyList<JsonElement> messages)
        {
            for (var index = messages.Count - 1; index >= 0; index--)
            {
                var message = messages[index];
                if (JsonHelpers.GetString(message, "role") != "assistant" ||
                    !message.TryGetProperty("content", out var content))
                {
                    continue;
                }

                if (content.ValueKind == JsonValueKind.String)
                {
                    var text = content.GetString()?.Trim() ?? string.Empty;
                    if (text.Length > 0)
                    {
                        return text;
                    }
                }
                else if (content.ValueKind == JsonValueKind.Array)
                {
                    var builder = new StringBuilder();
                    foreach (var block in content.EnumerateArray())
                    {
                        if (JsonHelpers.GetString(block, "type") == "text" &&
                            JsonHelpers.GetString(block, "text") is { Length: > 0 } blockText)
                        {
                            builder.Append(blockText);
                        }
                    }
                    var combinedText = builder.ToString().Trim();
                    if (combinedText.Length > 0)
                    {
                        return combinedText;
                    }
                }
            }

            return string.Empty;
        }
    }
}
