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
        var requestedTeamName = JsonHelpers.GetString(call.Input, "team_name")?.Trim();
        if (string.IsNullOrWhiteSpace(requestedTeamName))
        {
            requestedTeamName = JsonHelpers.GetString(call.Input, "teamName")?.Trim();
        }
        if (string.IsNullOrWhiteSpace(requestedTeamName))
        {
            requestedTeamName = JsonHelpers.GetString(parameters, "activeTeamName")?.Trim();
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

        var taskId = ReadTaskId(call.Input);
        var provider = BuildProvider(
            parameters,
            definition,
            JsonHelpers.GetString(call.Input, "model")?.Trim());
        var promptMessage = BuildPromptMessage(call.Input, definition.InitialPrompt);
        var innerTools = ResolveSubAgentTools(parameters, definition);
        AddSubmitReportToolDefinition(innerTools);

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
            SuppressTransportEvents = true
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

        // The child owns its lifecycle. The parent loop observes this stop only
        // after every tool call already emitted in the current assistant message
        // has been processed, so multiple background launches still all start.
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
        AddSubmitReportToolDefinition(innerTools);

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
            SuppressTransportEvents = true
        };
        childState.ReplaceParameters(childParameters);
        var collector = new BackgroundSubAgentRunCollector();
        childState.EventObserver = collector.ObserveAsync;

        await AgentRuntimeTools.EmitAsync(
            parentState,
            context,
            new AgentRuntimeStreamEvent(
                "sub_agent_start",
                SubAgentName: definition.Name,
                ToolUseId: call.Id,
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
        catch (OperationCanceledException)
        {
            collector.SetError("Background sub-agent was cancelled.");
            childState.RequestStop("aborted");
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
                var result = collector.BuildResult(childState.SubmittedReport);
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
        var result = collector.BuildResult(childState.SubmittedReport);
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
        private string? error;

        public async ValueTask ObserveAsync(AgentRuntimeStreamEvent[] events)
        {
            foreach (var item in events)
            {
                ObserveOne(item);
            }
            await ValueTask.CompletedTask;
        }

        public void SetError(string message)
        {
            error = message;
        }

        public SubAgentResultNative BuildResult(string? submittedReport)
        {
            var output = submittedReport?.Trim();
            if (string.IsNullOrWhiteSpace(output))
            {
                output = GetLastAssistantText(finalMessages);
            }
            if (string.IsNullOrWhiteSpace(output))
            {
                output = currentAssistantText.ToString().Trim();
            }
            if (string.IsNullOrWhiteSpace(output))
            {
                output = aggregatedText.ToString().Trim();
            }

            return new SubAgentResultNative(
                string.IsNullOrWhiteSpace(error),
                output ?? string.Empty,
                !string.IsNullOrWhiteSpace(output),
                toolCallCount,
                iterations,
                usage,
                error);
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
                    break;
                case "error":
                    error = item.Message;
                    break;
            }
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
