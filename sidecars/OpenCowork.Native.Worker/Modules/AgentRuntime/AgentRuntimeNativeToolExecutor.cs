using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal static class AgentRuntimeNativeToolExecutor
{
    private const int ReadDefaultLimit = 2_000;
    private const int LsPromptMaxItems = 100;
    private const int LsBackendFetchLimit = LsPromptMaxItems + 1;
    private const int LsPromptMaxOutputBytes = 8 * 1024;
    private const int GlobDefaultLimit = 100;
    private const int GlobPromptMaxChars = 64 * 1024;
    private const int GrepPromptMaxChars = 64 * 1024;
    private const int ShellDefaultTimeoutMs = 600_000;
    private const int ShellMaxTimeoutMs = 3_600_000;
    private const int ShellMaxOutputChars = 12_000;
    private const int InlineTextSnapshotLimitBytes = 64 * 1024;
    private const int SnapshotPreviewHeadChars = 1_200;
    private const int SnapshotPreviewTailChars = 400;
    private static readonly JsonSerializerOptions NotebookJsonOptions = new()
    {
        WriteIndented = true
    };

    private static readonly HashSet<string> NativeToolNames = new(StringComparer.Ordinal)
    {
        "Read", "Write", "Edit", "NotebookEdit", "LS", "Glob", "Grep", "Bash", "Shell"
    };

    private static readonly Dictionary<string, Dictionary<string, FileSnapshot>> ReadSnapshotsByRun =
        new(StringComparer.Ordinal);

    public static bool CanExecute(string toolName, JsonElement parameters)
    {
        if (AgentRuntimeTranslationExecutor.CanExecute(toolName, parameters))
        {
            return true;
        }

        if (AgentRuntimeSubAgentExecutor.CanExecute(toolName, parameters))
        {
            return true;
        }

        if (AgentRuntimeGoalExecutor.IsGoalTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeTeamExecutor.IsTeamTaskTool(toolName) &&
            AgentRuntimeTeamExecutor.ShouldRouteTeamTask(parameters))
        {
            return true;
        }

        if (AgentRuntimeTaskExecutor.IsTaskTool(toolName))
        {
            return AgentRuntimeTaskExecutor.CanExecute(parameters);
        }

        if (AgentRuntimeTeamExecutor.IsTeamTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeMemoryExecutor.IsMemoryTool(toolName))
        {
            return AgentRuntimeMemoryExecutor.CanExecute(parameters);
        }

        if (AgentRuntimeCodeCompatibleExecutor.IsCodeCompatibleTool(toolName))
        {
            return AgentRuntimeCodeCompatibleExecutor.CanExecute(parameters);
        }

        if (AgentRuntimeSkillExecutor.IsSkillTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeWidgetExecutor.IsWidgetTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeAskUserExecutor.IsAskUserTool(toolName))
        {
            return true;
        }

        if (AgentRuntimePlanExecutor.IsPlanTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeNotifyExecutor.IsNotifyTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeCronExecutor.IsCronTool(toolName))
        {
            return true;
        }

        if (AgentRuntimePluginExecutor.IsPluginTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeChannelPluginExecutor.IsChannelPluginTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeImageGenerateExecutor.IsImageGenerateTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeDesktopExecutor.IsDesktopTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeBrowserExecutor.IsBrowserTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeMcpExecutor.IsMcpTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeExtensionExecutor.IsExtensionTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeWebFetchExecutor.IsWebFetchTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeWebSearchExecutor.IsWebSearchTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeCodeGraphExecutor.IsCodeGraphTool(toolName))
        {
            return true;
        }

        if (!NativeToolNames.Contains(toolName))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "pluginId")))
        {
            return false;
        }

        if (AgentRuntimeSshToolExecutor.ShouldRoute(parameters))
        {
            return AgentRuntimeSshToolExecutor.CanExecute(toolName, parameters);
        }

        return true;
    }

    public static bool RequiresApproval(string toolName, JsonElement input, JsonElement parameters)
    {
        if (AgentRuntimeTranslationExecutor.CanExecute(toolName, parameters))
        {
            return false;
        }

        if (AgentRuntimeSubAgentExecutor.CanExecute(toolName, parameters))
        {
            return AgentRuntimeSubAgentExecutor.RequiresApproval(toolName, input);
        }

        if (AgentRuntimeGoalExecutor.IsGoalTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeTeamExecutor.IsTeamTaskTool(toolName) &&
            AgentRuntimeTeamExecutor.ShouldRouteTeamTask(parameters))
        {
            return false;
        }

        if (AgentRuntimeTaskExecutor.IsTaskTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeTeamExecutor.IsTeamTool(toolName))
        {
            return AgentRuntimeTeamExecutor.RequiresApproval(toolName);
        }

        if (AgentRuntimeMemoryExecutor.IsMemoryTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeCodeCompatibleExecutor.IsCodeCompatibleTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeSkillExecutor.IsSkillTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeWidgetExecutor.IsWidgetTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeAskUserExecutor.IsAskUserTool(toolName))
        {
            return false;
        }

        if (AgentRuntimePlanExecutor.IsPlanTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeNotifyExecutor.IsNotifyTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeCronExecutor.IsCronTool(toolName))
        {
            return AgentRuntimeCronExecutor.RequiresApproval(toolName);
        }

        if (AgentRuntimePluginExecutor.IsPluginTool(toolName))
        {
            return AgentRuntimePluginExecutor.RequiresApproval(toolName);
        }

        if (AgentRuntimeChannelPluginExecutor.IsChannelPluginTool(toolName))
        {
            return AgentRuntimeChannelPluginExecutor.RequiresApproval(toolName);
        }

        if (AgentRuntimeImageGenerateExecutor.IsImageGenerateTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeDesktopExecutor.IsDesktopTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeBrowserExecutor.IsBrowserTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeMcpExecutor.IsMcpTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeExtensionExecutor.IsExtensionTool(toolName))
        {
            return true;
        }

        if (AgentRuntimeWebFetchExecutor.IsWebFetchTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeWebSearchExecutor.IsWebSearchTool(toolName))
        {
            return false;
        }

        if (AgentRuntimeSshToolExecutor.ShouldRoute(parameters) &&
            AgentRuntimeSshToolExecutor.IsSshTool(toolName))
        {
            return AgentRuntimeSshToolExecutor.RequiresApproval(toolName, input, parameters);
        }

        return toolName switch
        {
            "Bash" or "Shell" => true,
            "Write" or "Edit" => IsWriteOutsideWorkingFolder(input, parameters),
            "NotebookEdit" => IsNotebookWriteOutsideWorkingFolder(input, parameters),
            _ => false
        };
    }

    public static async Task<RendererToolResult> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        try
        {
            if (AgentRuntimeTranslationExecutor.CanExecute(call.Name, parameters))
            {
                return await AgentRuntimeTranslationExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state,
                    context,
                    cancellationToken);
            }

            if (AgentRuntimeSubAgentExecutor.CanExecute(call.Name, parameters))
            {
                return await AgentRuntimeSubAgentExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state,
                    context,
                    cancellationToken);
            }

            if (AgentRuntimeGoalExecutor.IsGoalTool(call.Name))
            {
                var goalContent = AgentRuntimeGoalExecutor.Execute(call, parameters);
                return new RendererToolResult(CreateStringElement(goalContent), false, null);
            }

            if (AgentRuntimeTeamExecutor.IsTeamTaskTool(call.Name) &&
                AgentRuntimeTeamExecutor.ShouldRouteTeamTask(parameters))
            {
                var teamTaskContent = await AgentRuntimeTeamExecutor.ExecuteAsync(
                    call,
                    parameters,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(teamTaskContent), false, null);
            }

            if (AgentRuntimeTaskExecutor.IsTaskTool(call.Name))
            {
                var taskContent = AgentRuntimeTaskExecutor.Execute(call, parameters);
                return new RendererToolResult(CreateStringElement(taskContent), false, null);
            }

            if (AgentRuntimeTeamExecutor.IsTeamTool(call.Name))
            {
                var teamContent = await AgentRuntimeTeamExecutor.ExecuteAsync(
                    call,
                    parameters,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(teamContent), false, null);
            }

            if (AgentRuntimeMemoryExecutor.IsMemoryTool(call.Name))
            {
                var memoryContent = await AgentRuntimeMemoryExecutor.ExecuteAsync(
                    call,
                    parameters,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(memoryContent), false, null);
            }

            if (AgentRuntimeCodeCompatibleExecutor.IsCodeCompatibleTool(call.Name))
            {
                var codeCompatibleContent = await AgentRuntimeCodeCompatibleExecutor.ExecuteAsync(
                    call,
                    parameters,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(codeCompatibleContent), false, null);
            }

            if (AgentRuntimeSkillExecutor.IsSkillTool(call.Name))
            {
                var skillContent = await AgentRuntimeSkillExecutor.ExecuteAsync(call, cancellationToken);
                return new RendererToolResult(CreateStringElement(skillContent), false, null);
            }

            if (AgentRuntimeWidgetExecutor.IsWidgetTool(call.Name))
            {
                var widgetContent = AgentRuntimeWidgetExecutor.Execute(call);
                return new RendererToolResult(CreateStringElement(widgetContent), false, null);
            }

            if (AgentRuntimeAskUserExecutor.IsAskUserTool(call.Name))
            {
                var askUserContent = await AgentRuntimeAskUserExecutor.ExecuteAsync(
                    call,
                    parameters,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(askUserContent), false, null);
            }

            if (AgentRuntimePlanExecutor.IsPlanTool(call.Name))
            {
                var planContent = await AgentRuntimePlanExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state.RunId,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(planContent), false, null);
            }

            if (AgentRuntimeNotifyExecutor.IsNotifyTool(call.Name))
            {
                var notifyContent = await AgentRuntimeNotifyExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state.RunId,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(notifyContent), false, null);
            }

            if (AgentRuntimeCronExecutor.IsCronTool(call.Name))
            {
                var cronContent = await AgentRuntimeCronExecutor.ExecuteAsync(
                    call,
                    parameters,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(cronContent), false, null);
            }

            if (AgentRuntimePluginExecutor.IsPluginTool(call.Name))
            {
                var pluginContent = await AgentRuntimePluginExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state.RunId,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(pluginContent), false, null);
            }

            if (AgentRuntimeChannelPluginExecutor.IsChannelPluginTool(call.Name))
            {
                var channelPluginContent = await AgentRuntimeChannelPluginExecutor.ExecuteAsync(
                    call,
                    parameters,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(channelPluginContent), false, null);
            }

            if (AgentRuntimeImageGenerateExecutor.IsImageGenerateTool(call.Name))
            {
                return await AgentRuntimeImageGenerateExecutor.ExecuteAsync(
                    call,
                    parameters,
                    cancellationToken);
            }

            if (AgentRuntimeDesktopExecutor.IsDesktopTool(call.Name))
            {
                return await AgentRuntimeDesktopExecutor.ExecuteAsync(
                    call,
                    context,
                    cancellationToken);
            }

            if (AgentRuntimeBrowserExecutor.IsBrowserTool(call.Name))
            {
                return await AgentRuntimeBrowserExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state.RunId,
                    context,
                    cancellationToken);
            }

            if (AgentRuntimeMcpExecutor.IsMcpTool(call.Name))
            {
                var mcpContent = await AgentRuntimeMcpExecutor.ExecuteAsync(
                    call,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(mcpContent), false, null);
            }

            if (AgentRuntimeExtensionExecutor.IsExtensionTool(call.Name))
            {
                var extensionContent = await AgentRuntimeExtensionExecutor.ExecuteAsync(
                    call,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(extensionContent), false, null);
            }

            if (AgentRuntimeWebFetchExecutor.IsWebFetchTool(call.Name))
            {
                var webFetchContent = await AgentRuntimeWebFetchExecutor.ExecuteAsync(
                    call,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(webFetchContent), false, null);
            }

            if (AgentRuntimeWebSearchExecutor.IsWebSearchTool(call.Name))
            {
                var webSearchContent = await AgentRuntimeWebSearchExecutor.ExecuteAsync(
                    call,
                    parameters,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(webSearchContent), false, null);
            }

            if (AgentRuntimeCodeGraphExecutor.IsCodeGraphTool(call.Name))
            {
                var codegraphContent = await AgentRuntimeCodeGraphExecutor.ExecuteAsync(
                    call,
                    parameters,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(codegraphContent), false, null);
            }

            if (AgentRuntimeSshToolExecutor.ShouldRoute(parameters) &&
                AgentRuntimeSshToolExecutor.IsSshTool(call.Name))
            {
                var sshContent = await AgentRuntimeSshToolExecutor.ExecuteAsync(
                    call,
                    parameters,
                    state,
                    context,
                    cancellationToken);
                return new RendererToolResult(CreateStringElement(sshContent), false, null);
            }

            var content = call.Name switch
            {
                "Read" => await ReadAsync(call.Input, parameters, context, cancellationToken),
                "Write" => await WriteAsync(call, parameters, context, cancellationToken),
                "Edit" => await EditAsync(call, parameters, context, cancellationToken),
                "NotebookEdit" => await NotebookEditAsync(call, parameters, context, cancellationToken),
                "LS" => await ExecuteLsAsync(call.Input, parameters, context, cancellationToken),
                "Glob" => await ExecuteGlobAsync(call.Input, parameters, context, cancellationToken),
                "Grep" => await GrepAsync(call.Input, parameters, context, cancellationToken),
                "Bash" or "Shell" => await ExecuteShellAsync(
                    call,
                    parameters,
                    state,
                    context,
                    cancellationToken),
                _ => throw new InvalidOperationException($"Native tool not registered: {call.Name}")
            };
            return new RendererToolResult(CreateStringElement(content), false, null);
        }
        catch (Exception ex)
        {
            return new RendererToolResult(CreateStringElement(EncodeError(ex.Message)), true, ex.Message);
        }
    }

    public static void ClearRun(string runId)
    {
        lock (ReadSnapshotsByRun)
        {
            ReadSnapshotsByRun.Remove(runId);
        }
        AgentRuntimeSshToolExecutor.ClearRun(runId);
        AgentRuntimeNotifyExecutor.ClearRun(runId);
        AgentRuntimePlanExecutor.ClearRun(runId);
        AgentRuntimeTranslationExecutor.ClearRun(runId);
    }

    private static async Task<string> ReadAsync(
        JsonElement input,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var path = ResolveInputPath(input, parameters);
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Read requires a non-empty file_path");
        }
        if (Directory.Exists(path))
        {
            throw new InvalidOperationException($"Read expected a file but found a directory. Use LS for: {path}");
        }

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            path,
            "read",
            parameters,
            context,
            cancellationToken,
            async () =>
            {
                var content = await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
                RecordRead(parameters, path);
                var offset = Math.Max(1, JsonHelpers.GetInt(input, "offset", 1));
                var limit = Math.Max(1, Math.Min(JsonHelpers.GetInt(input, "limit", ReadDefaultLimit), ReadDefaultLimit));
                var lines = content.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
                var start = Math.Min(offset - 1, lines.Length);
                var end = Math.Min(start + limit, lines.Length);
                var width = Math.Max(6, end.ToString(System.Globalization.CultureInfo.InvariantCulture).Length);
                var builder = new StringBuilder();
                for (var index = start; index < end; index++)
                {
                    if (builder.Length > 0)
                    {
                        builder.Append('\n');
                    }
                    builder.Append((index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture).PadLeft(width));
                    builder.Append('\t');
                    builder.Append(lines[index]);
                }

                return builder.ToString();
            });
    }

    private static async Task<string> WriteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var path = ResolveInputPath(input, parameters);
        var content = JsonHelpers.GetString(input, "content");
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new InvalidOperationException("Write requires a non-empty file_path");
        }
        if (content is null)
        {
            throw new InvalidOperationException("Write requires a content string");
        }

        var guardError = AssertCurrentFileMatchesLastRead(parameters, path, "Write", allowMissingFile: true);
        if (guardError is not null)
        {
            throw new InvalidOperationException(guardError);
        }

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            path,
            "write",
            parameters,
            context,
            cancellationToken,
            async () =>
            {
                var before = await CaptureFullTextSnapshotAsync(path, cancellationToken);
                var directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                await File.WriteAllTextAsync(path, content, Encoding.UTF8, cancellationToken);
                var tracked = RecordTextWriteChange(parameters, call, path, before, BuildLightTextSnapshot(content));
                RecordRead(parameters, path);
                return EncodeJsonObject(writer =>
                {
                    writer.WriteBoolean("success", true);
                    writer.WriteString("path", path);
                    writer.WriteString("op", before.Exists ? "modify" : "create");
                    writer.WriteBoolean("tracked", tracked);
                });
            });
    }

    private static async Task<string> EditAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var path = ResolveInputPath(input, parameters);
        var oldString = JsonHelpers.GetString(input, "old_string") ?? string.Empty;
        var newString = JsonHelpers.GetString(input, "new_string") ?? string.Empty;
        var replaceAll = JsonHelpers.GetBool(input, "replace_all", false);
        if (string.IsNullOrWhiteSpace(path))
        {
            return EncodeError("Edit requires a non-empty file_path");
        }
        if (oldString.Length == 0)
        {
            return EncodeError("old_string must be non-empty");
        }
        if (oldString == newString)
        {
            return EncodeError("new_string must be different from old_string");
        }

        var guardError = AssertCurrentFileMatchesLastRead(parameters, path, "Edit", allowMissingFile: false);
        if (guardError is not null)
        {
            return EncodeError(guardError);
        }

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            path,
            "edit",
            parameters,
            context,
            cancellationToken,
            async () =>
            {
                var content = await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
                var before = BuildFullTextSnapshot(content);
                var matchedVariant = FindOldStringVariant(oldString, content);
                if (matchedVariant is null)
                {
                    return EncodeError($"String to replace not found in file.\nString: {oldString}");
                }

                var occurrences = CountOccurrences(content, matchedVariant.Value.Text);
                if (occurrences == 0)
                {
                    return EncodeError($"String to replace not found in file.\nString: {oldString}");
                }
                if (!replaceAll && occurrences > 1)
                {
                    return EncodeError(
                        $"Found {occurrences} matches of the string to replace, but replace_all is false. " +
                        $"To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context.\nString: {oldString}");
                }

                var replacementText = ApplyEolStyle(
                    newString,
                    GetReplacementEolStyle(matchedVariant.Value, content));
                var updated = replaceAll
                    ? content.Replace(matchedVariant.Value.Text, replacementText, StringComparison.Ordinal)
                    : ReplaceFirst(content, matchedVariant.Value.Text, replacementText);
                await File.WriteAllTextAsync(path, updated, Encoding.UTF8, cancellationToken);
                var tracked = RecordTextWriteChange(parameters, call, path, before, BuildLightTextSnapshot(updated));
                RecordRead(parameters, path);
                return EncodeJsonObject(writer =>
                {
                    writer.WriteBoolean("success", true);
                    writer.WriteString("path", path);
                    writer.WriteBoolean("replaceAll", replaceAll);
                    writer.WriteBoolean("tracked", tracked);
                });
            });
    }

    private static async Task<string> NotebookEditAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var path = ResolveNotebookInputPath(input, parameters);
        if (string.IsNullOrWhiteSpace(path))
        {
            return EncodeError("NotebookEdit requires notebook_path or file_path");
        }

        var guardError = AssertCurrentFileMatchesLastRead(parameters, path, "NotebookEdit", allowMissingFile: false);
        if (guardError is not null)
        {
            return EncodeError(guardError);
        }

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            path,
            "edit",
            parameters,
            context,
            cancellationToken,
            async () =>
            {
                var content = await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
                var before = BuildFullTextSnapshot(content);
                JsonNode? notebookNode;
                try
                {
                    notebookNode = JsonNode.Parse(content);
                }
                catch (JsonException ex)
                {
                    return EncodeError($"Invalid notebook JSON: {ex.Message}");
                }

                if (notebookNode is not JsonObject notebook ||
                    notebook["cells"] is not JsonArray cells)
                {
                    return EncodeError("Notebook does not contain a cells array");
                }

                var mode = JsonHelpers.GetString(input, "mode") switch
                {
                    "insert" => "insert",
                    "delete" => "delete",
                    _ => "replace"
                };
                var cellIndex = ResolveNotebookCellIndex(input, cells, mode);
                if (mode != "insert" && (cellIndex < 0 || cellIndex >= cells.Count))
                {
                    return EncodeError("Notebook cell not found");
                }
                if (mode == "insert" && (cellIndex < -1 || cellIndex >= cells.Count))
                {
                    return EncodeError("Insert cell_index is out of range");
                }

                if (mode == "delete")
                {
                    cells.RemoveAt(cellIndex);
                }
                else
                {
                    var nextCell = BuildNotebookCell(input);
                    if (mode == "insert")
                    {
                        cells.Insert(cellIndex + 1, nextCell);
                    }
                    else
                    {
                        cells[cellIndex] = MergeNotebookCell(cells[cellIndex] as JsonObject, nextCell);
                    }
                }

                var updated = notebook.ToJsonString(NotebookJsonOptions) + "\n";
                await File.WriteAllTextAsync(path, updated, Encoding.UTF8, cancellationToken);
                var tracked = RecordTextWriteChange(parameters, call, path, before, BuildLightTextSnapshot(updated));
                RecordRead(parameters, path);
                return EncodeJsonObject(writer =>
                {
                    writer.WriteBoolean("success", true);
                    writer.WriteString("path", path);
                    writer.WriteString("mode", mode);
                    writer.WriteBoolean("tracked", tracked);
                });
            });
    }

    private static async Task<string> ExecuteLsAsync(
        JsonElement input,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var rawPath = JsonHelpers.GetString(input, "path")?.Trim() ?? string.Empty;
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim();
        if ((rawPath.Length == 0 || rawPath == ".") && string.IsNullOrWhiteSpace(workingFolder))
        {
            return EncodeError("LS requires an active working folder when path is omitted or set to `.`");
        }

        var root = ResolveSearchRoot(input, parameters);
        if (!Directory.Exists(root))
        {
            return EncodeError($"Directory not found: {root}");
        }

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            root,
            "list",
            parameters,
            context,
            cancellationToken,
            () =>
            {
                var hidden = JsonHelpers.GetBool(input, "hidden", true);
                var respectGitignore = JsonHelpers.GetBool(input, "respectGitignore", true);
                var matcher = IgnoreMatcher.Create(root, JsonHelpers.GetStringArray(input, "ignore"), respectGitignore);
                var entries = new List<LsEntry>();
                var hasMore = false;
                foreach (var entry in Directory.EnumerateFileSystemEntries(root))
                {
                    FileAttributes attributes;
                    try
                    {
                        attributes = File.GetAttributes(entry);
                    }
                    catch
                    {
                        continue;
                    }

                    var isDirectory = attributes.HasFlag(FileAttributes.Directory);
                    if ((!hidden && Path.GetFileName(entry).StartsWith('.')) ||
                        matcher.IsIgnored(entry, isDirectory))
                    {
                        continue;
                    }

                    if (entries.Count >= LsBackendFetchLimit)
                    {
                        hasMore = true;
                        break;
                    }
                    entries.Add(new LsEntry(Path.GetFileName(entry), isDirectory ? "directory" : "file", entry));
                }

                return Task.FromResult(FormatLsResultForPrompt(entries, hasMore));
            });
    }

    private static async Task<string> ExecuteGlobAsync(
        JsonElement input,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var root = ResolveSearchRoot(input, parameters);
        using var searchParameters = AgentRuntimeGlobInputNormalizer.BuildSearchParameters(input, root);

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            root,
            "search",
            parameters,
            context,
            cancellationToken,
            () =>
            {
                var response = FileTools.Glob(searchParameters.RootElement);
                var resultJson = ExtractWorkerResultJson(response);
                ThrowIfAccessDeniedWorkerResult(resultJson);
                return Task.FromResult(AgentRuntimeGlobResultFormatter.CompactForPrompt(
                    resultJson,
                    GlobPromptMaxChars));
            });
    }

    private static async Task<string> GrepAsync(
        JsonElement input,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        if (!FileGrepInputNormalizer.HasUsablePattern(input))
        {
            throw new InvalidOperationException("Grep requires a pattern");
        }

        var root = ResolveSearchRoot(input, parameters);
        using var searchParameters = FileGrepInputNormalizer.BuildSearchParameters(input, root);

        return await FileSystemAccess.RetryOnAccessDeniedAsync(
            root,
            "search",
            parameters,
            context,
            cancellationToken,
            async () =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                var response = await FileTools.GrepAsync(searchParameters.RootElement);
                var resultJson = ExtractWorkerResultJson(response);
                ThrowIfAccessDeniedWorkerResult(resultJson);
                return AgentRuntimeGrepResultFormatter.CompactForPrompt(
                    resultJson,
                    GrepPromptMaxChars);
            });
    }

    private static async Task<string> ExecuteShellAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var input = call.Input;
        var command = JsonHelpers.GetString(input, "command");
        if (string.IsNullOrWhiteSpace(command))
        {
            return EncodeJsonObject(writer =>
            {
                writer.WriteNumber("exitCode", 1);
                writer.WriteString("stderr", "Missing command");
            });
        }

        var cwd = ResolveWorkingFolder(parameters);
        var liveInput = BuildShellInputElement(input, cwd, command);
        var timeoutMs = Math.Clamp(
            JsonHelpers.GetInt(input, "timeout", ShellDefaultTimeoutMs),
            1,
            ShellMaxTimeoutMs);
        var startedAt = Stopwatch.GetTimestamp();
        var artifactsBefore = SnapshotArtifactFiles(cwd);
        using var process = CreateShellProcess(command, cwd);
        process.Start();

        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            timeoutCts.Token);
        var stdout = new ShellOutputCollector(ShellMaxOutputChars);
        var stderr = new ShellOutputCollector(ShellMaxOutputChars);
        var combinedOutput = new ShellOutputCollector(ShellMaxOutputChars);
        var outputLock = new object();
        using var emitLock = new SemaphoreSlim(1, 1);

        async Task EmitLiveUpdateAsync()
        {
            await emitLock.WaitAsync(CancellationToken.None);
            try
            {
                string stdoutSnapshot;
                string stderrSnapshot;
                string combinedSnapshot;
                lock (outputLock)
                {
                    stdoutSnapshot = stdout.ToString();
                    stderrSnapshot = stderr.ToString();
                    combinedSnapshot = combinedOutput.ToString();
                }

                await EmitShellToolUpdateAsync(
                    call,
                    liveInput,
                    stdoutSnapshot,
                    stderrSnapshot,
                    combinedSnapshot,
                    cwd,
                    command,
                    state,
                    context);
            }
            finally
            {
                emitLock.Release();
            }
        }

        await EmitLiveUpdateAsync();

        var stdoutTask = ReadShellStreamAsync(
            process.StandardOutput,
            stdout,
            combinedOutput,
            outputLock,
            call.Id,
            "stdout",
            context,
            EmitLiveUpdateAsync,
            linkedCts.Token);
        var stderrTask = ReadShellStreamAsync(
            process.StandardError,
            stderr,
            combinedOutput,
            outputLock,
            call.Id,
            "stderr",
            context,
            EmitLiveUpdateAsync,
            linkedCts.Token);
        var timedOut = false;

        try
        {
            await process.WaitForExitAsync(linkedCts.Token);
        }
        catch (OperationCanceledException)
        {
            timedOut = timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested;
            TryKillProcessTree(process);
            if (!timedOut)
            {
                throw;
            }
        }

        await CompleteShellReadTaskAsync(stdoutTask);
        await CompleteShellReadTaskAsync(stderrTask);
        var exitCode = timedOut ? 124 : process.ExitCode;
        await EmitLiveUpdateAsync();

        List<(string Path, long Size)>? artifacts = null;
        var artifactsOverflow = 0;
        try
        {
            var changed = DiffArtifactFiles(artifactsBefore, SnapshotArtifactFiles(cwd));
            if (changed.Count > ArtifactMaxResults)
            {
                artifactsOverflow = changed.Count - ArtifactMaxResults;
                changed = changed.GetRange(0, ArtifactMaxResults);
            }
            artifacts = changed;
        }
        catch
        {
            // ponytail: artifact detection is best-effort only; never let it fail the Bash result
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteNumber("exitCode", exitCode);
            writer.WriteString("stdout", stdout.ToString());
            writer.WriteString("stderr", stderr.ToString());
            writer.WriteString("output", combinedOutput.ToString());
            writer.WriteBoolean("timedOut", timedOut);
            writer.WriteString("cwd", cwd);
            writer.WriteString("command", command);
            writer.WriteNumber("totalMs", ElapsedMs(startedAt));

            if (artifacts is { Count: > 0 })
            {
                writer.WriteStartArray("artifacts");
                foreach (var artifact in artifacts)
                {
                    writer.WriteStartObject();
                    writer.WriteString("path", artifact.Path);
                    writer.WriteNumber("size", artifact.Size);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();

                if (artifactsOverflow > 0)
                {
                    writer.WriteNumber("artifactsTruncated", artifactsOverflow);
                }
            }
        });
    }

    private const int ArtifactScanMaxDepth = 3;
    private const int ArtifactScanMaxFiles = 5_000;
    private const int ArtifactMaxResults = 20;

    private static readonly HashSet<string> ArtifactExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".docx", ".xlsx", ".pptx", ".pdf", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".zip"
    };

    private static Dictionary<string, (DateTime MtimeUtc, long Size)> SnapshotArtifactFiles(string root)
    {
        var snapshot = new Dictionary<string, (DateTime, long)>(StringComparer.Ordinal);
        try
        {
            var visited = 0;
            WalkArtifactFiles(new DirectoryInfo(root), 0, snapshot, ref visited);
        }
        catch
        {
            // ponytail: best-effort scan; a broken root just yields an empty snapshot
        }
        return snapshot;
    }

    // ponytail: known accepted limitation — a concurrent writer touching this
    // folder during the command window can be misattributed to this command's
    // artifacts. Single-user desktop app; not worth cross-process locking.
    private static void WalkArtifactFiles(
        DirectoryInfo dir,
        int depth,
        Dictionary<string, (DateTime, long)> snapshot,
        ref int visited)
    {
        if (depth > ArtifactScanMaxDepth)
        {
            return;
        }

        IEnumerable<FileSystemInfo> entries;
        try
        {
            entries = dir.EnumerateFileSystemInfos();
        }
        catch
        {
            // one unreadable directory skips only this subtree, not the whole walk
            return;
        }

        foreach (var entry in entries)
        {
            if (visited >= ArtifactScanMaxFiles)
            {
                return;
            }
            visited++;

            try
            {
                if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                {
                    continue; // never follow symlinks/reparse points
                }

                if (entry is DirectoryInfo subDir)
                {
                    if (subDir.Name.StartsWith('.') ||
                        subDir.Name.Equals("node_modules", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    WalkArtifactFiles(subDir, depth + 1, snapshot, ref visited);
                }
                else if (entry is FileInfo file && ArtifactExtensions.Contains(file.Extension))
                {
                    snapshot[file.FullName] = (file.LastWriteTimeUtc, file.Length);
                }
            }
            catch
            {
                // per-entry resilience: permission error or the file/dir vanishing
                // mid-walk (TOCTOU on attributes/length/mtime reads) skips just this
                // entry, never discards the rest of the snapshot
            }
        }
    }

    private static List<(string Path, long Size)> DiffArtifactFiles(
        Dictionary<string, (DateTime MtimeUtc, long Size)> before,
        Dictionary<string, (DateTime MtimeUtc, long Size)> after)
    {
        var changed = new List<(string, long)>();
        foreach (var (path, info) in after)
        {
            if (!before.TryGetValue(path, out var previous) || previous.MtimeUtc != info.MtimeUtc)
            {
                changed.Add((path, info.Size));
            }
        }
        return changed;
    }

    private static async Task EmitShellToolUpdateAsync(
        NativeToolCallView call,
        JsonElement input,
        string stdout,
        string stderr,
        string output,
        string cwd,
        string command,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context)
    {
        var content = EncodeJsonObject(writer =>
        {
            writer.WriteString("stdout", stdout);
            writer.WriteString("stderr", stderr);
            writer.WriteString("output", output);
            writer.WriteString("cwd", cwd);
            writer.WriteString("command", command);
        });

        await AgentRuntimeTools.EmitAsync(
            state,
            context,
            new AgentRuntimeStreamEvent(
                "tool_call_update",
                ToolCall: new AgentRuntimeToolCallState(
                    call.Id,
                    call.Name,
                    input,
                    "running",
                    CreateStringElement(content))));
    }

    private static async Task ReadShellStreamAsync(
        StreamReader reader,
        ShellOutputCollector streamOutput,
        ShellOutputCollector combinedOutput,
        object outputLock,
        string execId,
        string streamName,
        WorkerRequestContext context,
        Func<Task> emitUpdateAsync,
        CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        while (true)
        {
            int read;
            try
            {
                read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (read <= 0)
            {
                return;
            }

            var chunk = new string(buffer, 0, read);
            if (!string.IsNullOrWhiteSpace(execId))
            {
                await context.EmitEventAsync(
                    "shell/output",
                    new ShellOutputEvent(execId, chunk, streamName),
                    WorkerJsonContext.Default.ShellOutputEvent);
            }

            bool changed;
            lock (outputLock)
            {
                changed = streamOutput.Append(chunk) | combinedOutput.Append(chunk);
            }

            if (changed)
            {
                await emitUpdateAsync();
            }
        }
    }

    private static Process CreateShellProcess(string command, string cwd)
    {
        var isWindows = OperatingSystem.IsWindows();
        var startInfo = new ProcessStartInfo
        {
            FileName = isWindows ? "cmd.exe" : "/bin/zsh",
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true
        };
        if (isWindows)
        {
            startInfo.ArgumentList.Add("/d");
            startInfo.ArgumentList.Add("/s");
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(command);
        }
        else
        {
            startInfo.ArgumentList.Add("-lc");
            startInfo.ArgumentList.Add(command);
        }
        return new Process { StartInfo = startInfo };
    }

    private static JsonElement BuildShellInputElement(JsonElement input, string cwd, string command)
    {
        var json = EncodeJsonObject(writer =>
        {
            if (input.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in input.EnumerateObject())
                {
                    if (property.NameEquals("cwd"))
                    {
                        continue;
                    }
                    property.WriteTo(writer);
                }
            }
            else
            {
                writer.WriteString("command", command);
            }

            writer.WriteString("cwd", cwd);
        });

        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static async Task CompleteShellReadTaskAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static bool IsWriteOutsideWorkingFolder(JsonElement input, JsonElement parameters)
    {
        var target = ResolveInputPath(input, parameters);
        return IsPathOutsideWorkingFolder(target, parameters);
    }

    private static bool IsNotebookWriteOutsideWorkingFolder(JsonElement input, JsonElement parameters)
    {
        var target = ResolveNotebookInputPath(input, parameters);
        return IsPathOutsideWorkingFolder(target, parameters);
    }

    private static bool IsPathOutsideWorkingFolder(string target, JsonElement parameters)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder");
        if (string.IsNullOrWhiteSpace(target) || string.IsNullOrWhiteSpace(workingFolder))
        {
            return true;
        }

        var normalizedTarget = Path.GetFullPath(target);
        var normalizedWorkingFolder = Path.GetFullPath(workingFolder);
        return !normalizedTarget.StartsWith(
            normalizedWorkingFolder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveInputPath(JsonElement input, JsonElement parameters)
    {
        var raw = JsonHelpers.GetString(input, "file_path") ??
            JsonHelpers.GetString(input, "path") ??
            string.Empty;
        return ResolvePath(raw, ResolveWorkingFolder(parameters));
    }

    private static string ResolveNotebookInputPath(JsonElement input, JsonElement parameters)
    {
        var raw = JsonHelpers.GetString(input, "notebook_path") ??
            JsonHelpers.GetString(input, "file_path") ??
            string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }
        return ResolvePath(raw, ResolveWorkingFolder(parameters));
    }

    private static string ResolveSearchRoot(JsonElement input, JsonElement parameters)
    {
        var raw = JsonHelpers.GetString(input, "path") ?? string.Empty;
        return ResolvePath(raw, ResolveWorkingFolder(parameters));
    }

    private static string ResolveWorkingFolder(JsonElement parameters)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder");
        return string.IsNullOrWhiteSpace(workingFolder)
            ? Environment.CurrentDirectory
            : Path.GetFullPath(workingFolder);
    }

    private static string ResolvePath(string rawPath, string workingFolder)
    {
        var path = string.IsNullOrWhiteSpace(rawPath) ? workingFolder : rawPath.Trim();
        if (!Path.IsPathRooted(path))
        {
            path = Path.Combine(workingFolder, path);
        }
        return Path.GetFullPath(path);
    }

    private static string NormalizePath(string path)
    {
        return path.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');
    }

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }
        return count;
    }

    private static string ReplaceFirst(string source, string oldValue, string newValue)
    {
        var index = source.IndexOf(oldValue, StringComparison.Ordinal);
        return index < 0
            ? source
            : source[..index] + newValue + source[(index + oldValue.Length)..];
    }

    private static bool ShouldIgnoreLsEntry(string root, string entry, Regex[] ignorePatterns)
    {
        if (ignorePatterns.Length == 0)
        {
            return false;
        }

        var relative = NormalizePath(Path.GetRelativePath(root, entry));
        var name = Path.GetFileName(entry);
        foreach (var regex in ignorePatterns)
        {
            if (regex.IsMatch(relative) || regex.IsMatch(name))
            {
                return true;
            }
        }

        return false;
    }

    private static string FormatLsResultForPrompt(List<LsEntry> entries, bool hasMore)
    {
        var limited = new List<LsEntry>();
        var totalBytes = 2;
        string? limitReason = hasMore ? "max_results" : null;

        foreach (var entry in entries)
        {
            if (limited.Count >= LsPromptMaxItems)
            {
                limitReason = "max_results";
                break;
            }

            var candidateBytes = EstimateJsonUtf8Bytes(entry) + 1;
            if (totalBytes + candidateBytes > LsPromptMaxOutputBytes)
            {
                limitReason = "max_output_bytes";
                break;
            }

            limited.Add(entry);
            totalBytes += candidateBytes;
        }

        return limitReason is null
            ? SerializeLsEntries(limited)
            : SerializeTruncatedLsEntries(limited, limitReason);
    }

    private static int EstimateJsonUtf8Bytes(LsEntry entry)
    {
        return Encoding.UTF8.GetByteCount(SerializeLsEntry(entry));
    }

    private static string SerializeLsEntries(List<LsEntry> entries)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var entry in entries)
            {
                WriteLsEntry(writer, entry);
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string SerializeTruncatedLsEntries(List<LsEntry> entries, string limitReason)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WritePropertyName("items");
            writer.WriteStartArray();
            foreach (var entry in entries)
            {
                WriteLsEntry(writer, entry);
            }
            writer.WriteEndArray();
            writer.WriteBoolean("truncated", true);
            writer.WriteString("limitReason", limitReason);
        });
    }

    private static string SerializeLsEntry(LsEntry entry)
    {
        return EncodeJsonObject(writer => WriteLsEntryProperties(writer, entry));
    }

    private static void WriteLsEntry(Utf8JsonWriter writer, LsEntry entry)
    {
        writer.WriteStartObject();
        WriteLsEntryProperties(writer, entry);
        writer.WriteEndObject();
    }

    private static void WriteLsEntryProperties(Utf8JsonWriter writer, LsEntry entry)
    {
        writer.WriteString("name", entry.Name);
        writer.WriteString("type", entry.Type);
        writer.WriteString("path", entry.Path);
    }

    private static int ResolveNotebookCellIndex(JsonElement input, JsonArray cells, string mode)
    {
        if (JsonHelpers.GetIntNullable(input, "cell_index") is { } cellIndex)
        {
            return cellIndex;
        }

        var cellId = JsonHelpers.GetString(input, "cell_id");
        if (!string.IsNullOrEmpty(cellId))
        {
            for (var index = 0; index < cells.Count; index++)
            {
                if (cells[index] is JsonObject cell &&
                    string.Equals(GetJsonString(cell, "id"), cellId, StringComparison.Ordinal))
                {
                    return index;
                }
            }
            return -1;
        }

        return mode == "insert" ? cells.Count - 1 : -1;
    }

    private static JsonObject BuildNotebookCell(JsonElement input)
    {
        var cellType = JsonHelpers.GetString(input, "cell_type") switch
        {
            "markdown" => "markdown",
            "raw" => "raw",
            _ => "code"
        };
        var source = JsonHelpers.GetString(input, "new_source") ??
            JsonHelpers.GetString(input, "source") ??
            string.Empty;
        var cell = new JsonObject
        {
            ["cell_type"] = cellType,
            ["metadata"] = new JsonObject(),
            ["source"] = BuildNotebookSourceArray(source)
        };
        if (cellType == "code")
        {
            cell["outputs"] = new JsonArray();
            cell["execution_count"] = null;
        }
        return cell;
    }

    private static JsonObject MergeNotebookCell(JsonObject? existingCell, JsonObject nextCell)
    {
        var merged = new JsonObject();
        if (existingCell is not null)
        {
            foreach (var property in existingCell)
            {
                merged[property.Key] = property.Value?.DeepClone();
            }
        }

        foreach (var property in nextCell)
        {
            merged[property.Key] = property.Value?.DeepClone();
        }
        return merged;
    }

    private static JsonArray BuildNotebookSourceArray(string source)
    {
        var lines = new JsonArray();
        if (source.Length == 0)
        {
            return lines;
        }

        var start = 0;
        for (var index = 0; index < source.Length; index++)
        {
            if (source[index] != '\n')
            {
                continue;
            }
            lines.Add((JsonNode?)JsonValue.Create(source[start..(index + 1)]));
            start = index + 1;
        }

        if (start < source.Length)
        {
            lines.Add((JsonNode?)JsonValue.Create(source[start..]));
        }
        else if (source.EndsWith('\n'))
        {
            lines.Add((JsonNode?)JsonValue.Create(string.Empty));
        }

        return lines;
    }

    private static string? GetJsonString(JsonObject jsonObject, string propertyName)
    {
        return jsonObject.TryGetPropertyValue(propertyName, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    private static OldStringVariant? FindOldStringVariant(string oldString, string content)
    {
        foreach (var variant in BuildOldStringVariants(oldString, content))
        {
            if (variant.Text.Length > 0 && content.Contains(variant.Text, StringComparison.Ordinal))
            {
                return variant;
            }
        }

        return null;
    }

    private static List<OldStringVariant> BuildOldStringVariants(string oldString, string content)
    {
        var variants = new List<OldStringVariant>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        AddOldStringVariant(variants, seen, oldString, DetectEolStyle(oldString));

        if (oldString.Contains('\n', StringComparison.Ordinal))
        {
            var lfText = NormalizeToLf(oldString);
            AddOldStringVariant(variants, seen, lfText, "\n");
            if (content.Contains("\r\n", StringComparison.Ordinal))
            {
                AddOldStringVariant(
                    variants,
                    seen,
                    lfText.Replace("\n", "\r\n", StringComparison.Ordinal),
                    "\r\n");
            }
        }

        return variants;
    }

    private static void AddOldStringVariant(
        List<OldStringVariant> variants,
        HashSet<string> seen,
        string text,
        string? eol)
    {
        if (seen.Add(text))
        {
            variants.Add(new OldStringVariant(text, eol));
        }
    }

    private static string? DetectEolStyle(string value)
    {
        if (value.Contains("\r\n", StringComparison.Ordinal))
        {
            return "\r\n";
        }
        return value.Contains('\n', StringComparison.Ordinal) ? "\n" : null;
    }

    private static string? DetectDominantEolStyle(string value)
    {
        var crlf = 0;
        var lf = 0;
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] == '\r' && index + 1 < value.Length && value[index + 1] == '\n')
            {
                crlf++;
                index++;
            }
            else if (value[index] == '\n')
            {
                lf++;
            }
        }

        if (crlf == 0 && lf == 0)
        {
            return null;
        }
        return crlf >= lf ? "\r\n" : "\n";
    }

    private static string NormalizeToLf(string value)
    {
        return value.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string ApplyEolStyle(string value, string? eol)
    {
        if (eol is null)
        {
            return value;
        }

        var normalized = NormalizeToLf(value);
        return eol == "\n"
            ? normalized
            : normalized.Replace("\n", "\r\n", StringComparison.Ordinal);
    }

    private static string? GetReplacementEolStyle(OldStringVariant matchedVariant, string content)
    {
        return matchedVariant.Eol ?? DetectDominantEolStyle(content);
    }

    private static void RecordRead(JsonElement parameters, string path)
    {
        var runId = JsonHelpers.GetString(parameters, "runId");
        if (string.IsNullOrWhiteSpace(runId))
        {
            return;
        }

        var fullPath = Path.GetFullPath(path);
        var snapshot = CaptureSnapshot(fullPath);
        var key = NormalizeReadHistoryPath(fullPath);
        lock (ReadSnapshotsByRun)
        {
            if (!ReadSnapshotsByRun.TryGetValue(runId, out var snapshots))
            {
                snapshots = new Dictionary<string, FileSnapshot>(StringComparer.Ordinal);
                ReadSnapshotsByRun[runId] = snapshots;
            }
            snapshots[key] = snapshot;
        }
    }

    private static string? AssertCurrentFileMatchesLastRead(
        JsonElement parameters,
        string path,
        string toolName,
        bool allowMissingFile)
    {
        var runId = JsonHelpers.GetString(parameters, "runId");
        if (string.IsNullOrWhiteSpace(runId))
        {
            return $"{toolName} requires an active native run id.";
        }

        var fullPath = Path.GetFullPath(path);
        var current = CaptureSnapshot(fullPath);
        if (!current.Exists && allowMissingFile)
        {
            return null;
        }

        FileSnapshot? previous = null;
        lock (ReadSnapshotsByRun)
        {
            if (ReadSnapshotsByRun.TryGetValue(runId, out var snapshots) &&
                snapshots.TryGetValue(NormalizeReadHistoryPath(fullPath), out var snapshot))
            {
                previous = snapshot;
            }
        }

        if (previous is null)
        {
            return $"{toolName} requires the file to be read in this agent turn first. Call Read on {fullPath} and retry.";
        }

        if (!previous.Value.Equals(current))
        {
            return $"{toolName} refused to edit because the file changed since it was last read in this turn. Call Read on {fullPath} again and retry.";
        }

        return null;
    }

    private static FileSnapshot CaptureSnapshot(string path)
    {
        if (!File.Exists(path))
        {
            return new FileSnapshot(false, null, null, null);
        }

        var info = new FileInfo(path);
        return new FileSnapshot(
            true,
            "file",
            info.Length,
            new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds());
    }

    private static async Task<StoredFileSnapshot> CaptureFullTextSnapshotAsync(
        string path,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
        {
            return new StoredFileSnapshot
            {
                Exists = false,
                Hash = null,
                Size = 0
            };
        }

        var text = await File.ReadAllTextAsync(path, Encoding.UTF8, cancellationToken);
        return BuildFullTextSnapshot(text);
    }

    private static StoredFileSnapshot BuildFullTextSnapshot(string text)
    {
        var size = Encoding.UTF8.GetByteCount(text);
        var lineCount = CountLines(text);
        var snapshot = new StoredFileSnapshot
        {
            Exists = true,
            FullText = text,
            Hash = HashText(text),
            Size = size,
            LineCount = lineCount
        };

        if (size <= InlineTextSnapshotLimitBytes)
        {
            snapshot.Text = text;
            return snapshot;
        }

        snapshot.PreviewText = text[..Math.Min(text.Length, SnapshotPreviewHeadChars)];
        if (text.Length > SnapshotPreviewTailChars)
        {
            snapshot.TailPreviewText = text[^SnapshotPreviewTailChars..];
        }
        snapshot.TextOmitted = true;
        return snapshot;
    }

    private static StoredFileSnapshot BuildLightTextSnapshot(string text)
    {
        var size = Encoding.UTF8.GetByteCount(text);
        var lineCount = CountLines(text);
        var snapshot = new StoredFileSnapshot
        {
            Exists = true,
            Hash = HashText(text),
            Size = size,
            LineCount = lineCount
        };

        if (size <= InlineTextSnapshotLimitBytes)
        {
            snapshot.Text = text;
            snapshot.FullText = text;
            return snapshot;
        }

        snapshot.PreviewText = text[..Math.Min(text.Length, SnapshotPreviewHeadChars)];
        if (text.Length > SnapshotPreviewTailChars)
        {
            snapshot.TailPreviewText = text[^SnapshotPreviewTailChars..];
        }
        snapshot.TextOmitted = true;
        return snapshot;
    }

    private static bool RecordTextWriteChange(
        JsonElement parameters,
        NativeToolCallView call,
        string path,
        StoredFileSnapshot before,
        StoredFileSnapshot after)
    {
        if (before.Exists == after.Exists &&
            string.Equals(before.Hash, after.Hash, StringComparison.OrdinalIgnoreCase))
        {
            WorkerLog.Debug($"agent native tool change skipped reason=unchanged tool={call.Name} path={path}");
            return false;
        }

        var runId = ResolveChangeRunId(parameters, call);
        if (string.IsNullOrWhiteSpace(runId))
        {
            WorkerLog.Warn($"agent native tool change dropped reason=missing-run-id tool={call.Name} path={path}");
            return false;
        }

        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
            if (string.IsNullOrEmpty(sessionId))
            {
                sessionId = null;
            }

            var parameterRunId = JsonHelpers.GetString(parameters, "runId")?.Trim();
            var assistantMessageId = string.IsNullOrEmpty(parameterRunId) ? runId : parameterRunId;
            var change = new StoredTrackedFileChange
            {
                RunId = runId,
                SessionId = sessionId,
                ToolUseId = string.IsNullOrWhiteSpace(call.Id) ? null : call.Id,
                ToolName = call.Name,
                FilePath = path,
                Transport = "local",
                Op = before.Exists ? "modify" : "create",
                Status = "open",
                Before = before,
                After = after,
                CreatedAt = now
            };

            DbAgentChangeTools.AppendTrackedFileChange(
                parameters,
                runId,
                sessionId,
                assistantMessageId,
                change,
                now);
            WorkerLog.Debug(
                $"agent native tool change recorded runId={runId} tool={call.Name} " +
                $"op={change.Op} path={path}");
            return true;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn(
                $"agent native tool change record failed runId={runId} tool={call.Name} " +
                $"path={path} error={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static string? ResolveChangeRunId(JsonElement parameters, NativeToolCallView call)
    {
        var runId = JsonHelpers.GetString(parameters, "runId")?.Trim();
        if (!string.IsNullOrEmpty(runId))
        {
            return runId;
        }

        var toolUseId = call.Id.Trim();
        return string.IsNullOrEmpty(toolUseId) ? null : toolUseId;
    }

    private static string HashText(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static int CountLines(string text)
    {
        return text.Length == 0 ? 0 : text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Length;
    }

    private static string NormalizeReadHistoryPath(string path)
    {
        return NormalizePath(Path.GetFullPath(path)).ToLowerInvariant();
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string ExtractWorkerResultJson(WorkerResponse response)
    {
        using var document = JsonDocument.Parse(response.ToJsonBytes(null));
        return document.RootElement.TryGetProperty("result", out var result)
            ? result.GetRawText()
            : "{}";
    }

    private static void ThrowIfAccessDeniedWorkerResult(string resultJson)
    {
        using var document = JsonDocument.Parse(resultJson);
        if (document.RootElement.ValueKind != JsonValueKind.Object ||
            !document.RootElement.TryGetProperty("error", out var errorElement) ||
            errorElement.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var message = errorElement.GetString() ?? string.Empty;
        if (message.Contains("permission denied", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("access denied", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("operation not permitted", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("EACCES", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("EPERM", StringComparison.OrdinalIgnoreCase))
        {
            throw new UnauthorizedAccessException(message);
        }
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static JsonElement CreateStringElement(string value)
    {
        return JsonSerializer.SerializeToElement(value, WorkerJsonContext.Default.String);
    }

    private static string Truncate(string value, int maxChars)
    {
        if (value.Length <= maxChars)
        {
            return value;
        }
        return value[..maxChars] + $"\n... [truncated, {value.Length} chars total]";
    }

    private static void TryKillProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best-effort process cleanup.
        }
    }

    private static long ElapsedMs(long startedAt)
    {
        return (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
    }

    private sealed class ShellOutputCollector
    {
        private readonly int maxChars;
        private readonly StringBuilder builder = new();
        private bool truncated;

        public ShellOutputCollector(int maxChars)
        {
            this.maxChars = maxChars;
        }

        public bool Append(string chunk)
        {
            if (truncated)
            {
                return false;
            }

            var remaining = maxChars - builder.Length;
            if (remaining <= 0)
            {
                truncated = true;
                return false;
            }

            if (chunk.Length <= remaining)
            {
                builder.Append(chunk);
                return true;
            }

            builder.Append(chunk.AsSpan(0, remaining));
            builder.AppendLine();
            builder.Append("[Native shell output truncated]");
            truncated = true;
            return true;
        }

        public override string ToString()
        {
            return builder.ToString();
        }
    }
}

internal readonly record struct NativeToolCallView(string Id, string Name, JsonElement Input);

internal readonly record struct RendererToolResult(JsonElement Content, bool IsError, string? Error);

internal readonly record struct FileSnapshot(bool Exists, string? Type, long? Size, long? MtimeMs);

internal readonly record struct OldStringVariant(string Text, string? Eol);

internal readonly record struct LsEntry(string Name, string Type, string Path);
