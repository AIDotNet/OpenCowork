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
        var teamName = AgentRuntimeTeamRuntimeStore.ResolveTeamName(call.Input, parameters);
        if (teamName.Length == 0)
        {
            return ErrorResult("Background Task requires an active team. Call TeamCreate first.");
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
        var parentTools = ReadToolDefinitions(parameters);
        var innerTools = ResolveTools(definition, parentTools);
        innerTools.Add(BuildSubmitReportToolDefinition());

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

        return new RendererToolResult(
            StringElement(CreateObject(writer =>
            {
                writer.WriteBoolean("success", true);
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
                    "Background teammate started in the .NET Native Worker. End your turn and use TeamStatus to check progress.");
            }).GetRawText()),
            false,
            null);
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
