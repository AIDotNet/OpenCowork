using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class AgentRuntimeSubAgentExecutor
{
    private const string TaskToolName = "Task";
    private const string SubmitReportToolName = "SubmitReport";
    private const int DefaultMaxTurns = 12;
    private const string AgentsDirectoryName = ".open-cowork/agents";
    private const string CustomSubAgentType = "custom";

    private static readonly string[] DefaultTools = ["Read", "Glob", "Grep", "LS", "Skill"];
    private static readonly HashSet<string> PlanModeInvestigationTools = new(StringComparer.Ordinal)
    {
        "Read",
        "Glob",
        "Grep",
        "LS",
        "Skill",
        "WebSearch",
        "WebFetch"
    };
    private static readonly string[] MandatoryDisallowedTools =
    [
        "Task",
        "AskUserQuestion",
        "EnterPlanMode",
        "ExitPlanMode"
    ];
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsTaskTool(string toolName)
    {
        return string.Equals(toolName, TaskToolName, StringComparison.Ordinal);
    }

    public static bool IsSubmitReportTool(string toolName)
    {
        return string.Equals(toolName, SubmitReportToolName, StringComparison.Ordinal);
    }

    public static bool CanExecute(string toolName, JsonElement parameters)
    {
        return IsTaskTool(toolName) ||
            (IsSubmitReportTool(toolName) && JsonHelpers.GetBool(parameters, "submitReportEnabled", false));
    }

    public static bool IsSubAgentRun(JsonElement parameters)
    {
        return JsonHelpers.GetBool(parameters, "submitReportEnabled", false) &&
            !string.IsNullOrWhiteSpace(JsonHelpers.GetString(parameters, "callerAgent"));
    }

    public static bool RequiresApproval(string toolName, JsonElement input)
    {
        _ = input;
        return IsTaskTool(toolName) ? false : false;
    }

    public static async Task<RendererToolResult> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        if (IsSubmitReportTool(call.Name))
        {
            return ExecuteSubmitReport(call, state);
        }

        if (!IsTaskTool(call.Name))
        {
            return ErrorResult($"Native sub-agent tool not registered: {call.Name}");
        }

        return await ExecuteTaskAsync(call, parameters, state, context, cancellationToken);
    }

    private static RendererToolResult ExecuteSubmitReport(
        NativeToolCallView call,
        AgentRuntimeTools.AgentRuntimeRunState state)
    {
        var report = JsonHelpers.GetString(call.Input, "report")?.Trim() ?? string.Empty;
        if (report.Length == 0)
        {
            var error =
                "SubmitReport rejected: the `report` argument was empty. " +
                "Call SubmitReport again with the full report body.";
            return new RendererToolResult(StringElement(error), true, error);
        }

        state.TrySubmitReport(report);
        return new RendererToolResult(
            StringElement("Report submitted. This sub-agent session will now terminate."),
            false,
            null);
    }

    private static async Task<RendererToolResult> ExecuteTaskAsync(
        NativeToolCallView call,
        JsonElement parameters,
        AgentRuntimeTools.AgentRuntimeRunState parentState,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        if (JsonHelpers.GetBool(call.Input, "run_in_background", false))
        {
            return await ExecuteBackgroundTaskAsync(call, parameters, parentState, context, cancellationToken);
        }

        var subAgentType = JsonHelpers.GetString(call.Input, "subagent_type")?.Trim() ?? string.Empty;
        if (subAgentType.Length == 0)
        {
            return ErrorResult("`subagent_type` is required for synchronous Task.");
        }

        var definition = ResolveDefinition(subAgentType, parameters, call.Input);
        if (definition is null)
        {
            return ErrorResult($"Unknown subagent_type \"{subAgentType}\".");
        }

        var dedupKey = BuildTaskDedupKey(call.Input);
        if (!string.IsNullOrWhiteSpace(parentState.SessionId) &&
            parentState.TryGetDuplicateTaskInvocation(
                dedupKey,
                call.Id,
                out var duplicateInvocation) &&
            duplicateInvocation is not null)
        {
            return DuplicateTaskResult(subAgentType, duplicateInvocation.Output);
        }

        var promptMessage = BuildPromptMessage(call.Input, definition.InitialPrompt);
        var parentTools = ReadToolDefinitions(parameters);
        var innerTools = ResolveTools(
            definition,
            parentTools,
            JsonHelpers.GetBool(parameters, "planMode", false));
        innerTools.Add(BuildSubmitReportToolDefinition());

        var provider = BuildProvider(parameters, definition);
        var childParameters = BuildChildParameters(
            parameters,
            provider,
            promptMessage,
            innerTools,
            definition,
            call.Id);
        var childState = new AgentRuntimeTools.AgentRuntimeRunState(
            $"subagent-{call.Id}-{Guid.NewGuid():N}",
            parentState.SessionId)
        {
            SuppressTransportEvents = true
        };
        childState.ReplaceParameters(childParameters);

        var collector = new SubAgentRunCollector(
            definition.Name,
            call.Id,
            call.Input.Clone(),
            promptMessage,
            provider,
            parentState,
            context);
        childState.EventObserver = collector.ObserveAsync;
        using var parentCancellationRegistration = parentState.CancellationToken.Register(
            static state => ((AgentRuntimeTools.AgentRuntimeRunState)state!).Cancel("parent"),
            childState);

        var startHook = await AgentRuntimeHooks.RunSubagentAsync(
            parameters,
            parentState,
            context,
            "SubagentStart",
            childState.RunId,
            definition.Name,
            call.Id);
        if (startHook.Blocked)
        {
            childState.Dispose();
            return ErrorResult(startHook.Reason ?? "SubagentStart hook blocked sub-agent run");
        }
        if (startHook.HasContext)
        {
            childParameters = AppendHookRequestContexts(childParameters, startHook);
            childState.ReplaceParameters(childParameters);
        }

        await AgentRuntimeTools.EmitAsync(
            parentState,
            context,
            new AgentRuntimeStreamEvent(
                "sub_agent_start",
                SubAgentName: definition.Name,
                ToolUseId: call.Id,
                Input: call.Input.Clone(),
                PromptMessage: promptMessage));

        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            parentState.CancellationToken.ThrowIfCancellationRequested();
            await OpenAIChatRuntime.ExecuteLoopAsync(childParameters, childState, context);
        }
        catch (OperationCanceledException)
        {
            childState.RequestStop("aborted");
        }
        catch (Exception ex)
        {
            collector.SetError(ex.Message);
            WorkerLog.Warn(
                $"sub-agent run failed parentRunId={parentState.RunId} toolUseId={call.Id} " +
                $"agent={definition.Name} error={ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            childState.Dispose();
        }

        var result = collector.BuildResult(childState.SubmittedReport);
        var stopHook = await AgentRuntimeHooks.RunSubagentAsync(
            parameters,
            parentState,
            context,
            "SubagentStop",
            childState.RunId,
            definition.Name,
            call.Id);
        if (stopHook.Blocked)
        {
            var reason = stopHook.Reason ?? "SubagentStop hook blocked sub-agent result";
            result = result with { Success = false, Output = reason, Error = reason };
        }
        await AgentRuntimeTools.EmitAsync(
            parentState,
            context,
            new AgentRuntimeStreamEvent(
                "sub_agent_report_update",
                SubAgentName: definition.Name,
                ToolUseId: call.Id,
                Report: result.Output,
                Status: result.ReportSubmitted ? "submitted" : "missing"),
            new AgentRuntimeStreamEvent(
                "sub_agent_end",
                SubAgentName: definition.Name,
                ToolUseId: call.Id,
                Result: result.ToJson()));

        if (result.Success && !string.IsNullOrWhiteSpace(parentState.SessionId))
        {
            parentState.RememberTaskInvocation(dedupKey, result.Output, call.Id);
        }

        return result.Success
            ? new RendererToolResult(StringElement(result.Output), false, null)
            : new RendererToolResult(StringElement(EncodeError(result.Error ?? "SubAgent failed")), true, result.Error);
    }

    private static SubAgentDefinitionNative? ResolveDefinition(
        string subAgentType,
        JsonElement parameters,
        JsonElement input)
    {
        if (string.Equals(subAgentType, CustomSubAgentType, StringComparison.Ordinal))
        {
            return new SubAgentDefinitionNative(
                CustomSubAgentType,
                JsonHelpers.GetString(input, "description")?.Trim() ?? "Custom sub-agent",
                BuildDefaultSystemPrompt(JsonHelpers.GetString(parameters, "workingFolder")),
                ["*"],
                MandatoryDisallowedTools,
                DefaultMaxTurns,
                null,
                null,
                null);
        }

        foreach (var agent in LoadAgentDefinitions())
        {
            if (string.Equals(agent.Name, subAgentType, StringComparison.OrdinalIgnoreCase))
            {
                return agent;
            }
        }

        return null;
    }

    private static List<SubAgentDefinitionNative> LoadAgentDefinitions()
    {
        var result = new List<SubAgentDefinitionNative>();
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            AgentsDirectoryName);
        if (!Directory.Exists(root))
        {
            return result;
        }

        foreach (var file in Directory.EnumerateFiles(root, "*.md", SearchOption.TopDirectoryOnly))
        {
            try
            {
                var parsed = ParseAgentFile(File.ReadAllText(file), Path.GetFileName(file));
                if (parsed is not null)
                {
                    result.Add(parsed);
                }
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"failed to load sub-agent file={file} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        return result;
    }

    private static SubAgentDefinitionNative? ParseAgentFile(string content, string filename)
    {
        var match = FrontmatterRegex().Match(content);
        if (!match.Success)
        {
            return null;
        }

        var frontmatter = match.Groups[1].Value;
        var body = content[match.Length..].TrimStart();
        var name = GetFrontmatterString(frontmatter, "name");
        var description = GetFrontmatterString(frontmatter, "description");
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(description))
        {
            WorkerLog.Warn($"sub-agent skipped filename={filename} reason=missing name/description");
            return null;
        }

        var tools = GetFrontmatterStringList(frontmatter, "tools") ??
            GetFrontmatterStringList(frontmatter, "allowedTools") ??
            ["Read", "Glob", "Grep", "LS", "Bash"];
        var disallowedTools = GetFrontmatterStringList(frontmatter, "disallowedTools") ?? [];
        var maxTurns = GetFrontmatterInt(frontmatter, "maxTurns") ??
            GetFrontmatterInt(frontmatter, "maxIterations") ??
            DefaultMaxTurns;
        if (maxTurns <= 0)
        {
            maxTurns = DefaultMaxTurns;
        }

        return new SubAgentDefinitionNative(
            name.Trim(),
            description.Trim(),
            body.Length == 0 ? $"You are {name}, a specialized agent." : body,
            tools,
            disallowedTools,
            maxTurns,
            GetFrontmatterString(frontmatter, "initialPrompt"),
            GetFrontmatterString(frontmatter, "model"),
            GetFrontmatterDouble(frontmatter, "temperature"));
    }

    private static JsonElement BuildPromptMessage(JsonElement input, string? initialPrompt)
    {
        var promptText = BuildPromptText(input, initialPrompt);
        return CreateObject(writer =>
        {
            writer.WriteString("id", $"oc_subagent_prompt_{Guid.NewGuid():N}");
            writer.WriteString("role", "user");
            writer.WritePropertyName("content");
            writer.WriteStartArray();
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString("text", promptText);
            writer.WriteEndObject();
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString(
                "text",
                "<system-remind>\n" +
                "Session termination protocol:\n" +
                "- When you are done with the task, you MUST end the session by calling the `SubmitReport` tool exactly once.\n" +
                "- Calling `SubmitReport` terminates this sub-agent session immediately -- do NOT call any other tools afterwards.\n" +
                "- Do NOT stop by simply emitting an assistant message.\n" +
                "- Do NOT call `SubmitReport` with an empty `report` argument.\n" +
                "- Write the report in the same language as the user's request.\n" +
                "\nStructure the `report` argument with these sections:\n" +
                "## Conclusion\n## Key Findings\n## Evidence\n## Validation\n## Risks / Unknowns\n## Next Steps\n" +
                "</system-remind>");
            writer.WriteEndObject();
            writer.WriteEndArray();
            writer.WriteNumber("createdAt", NowMs());
        });
    }

    private static string BuildPromptText(JsonElement input, string? initialPrompt)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(initialPrompt))
        {
            parts.Add(initialPrompt.Trim());
        }

        var prompt =
            JsonHelpers.GetString(input, "prompt") ??
            JsonHelpers.GetString(input, "query") ??
            JsonHelpers.GetString(input, "task");
        if (!string.IsNullOrWhiteSpace(prompt))
        {
            parts.Add(prompt.Trim());
        }
        else if (JsonHelpers.GetString(input, "target") is { Length: > 0 } target)
        {
            parts.Add($"Analyze: {target}");
            if (JsonHelpers.GetString(input, "focus") is { Length: > 0 } focus)
            {
                parts.Add($"Focus: {focus}");
            }
        }
        else
        {
            parts.Add(input.GetRawText());
        }

        if (JsonHelpers.GetString(input, "scope") is { Length: > 0 } scope)
        {
            parts.Add($"\nScope: {scope}");
        }
        if (JsonHelpers.GetString(input, "constraints") is { Length: > 0 } constraints)
        {
            parts.Add($"\nConstraints: {constraints}");
        }

        return string.Join('\n', parts);
    }

    private static string BuildTaskDedupKey(JsonElement input)
    {
        var subType = JsonHelpers.GetString(input, "subagent_type")?.Trim() ?? string.Empty;
        var prompt =
            NormalizeTaskPrompt(JsonHelpers.GetString(input, "prompt")) ??
            NormalizeTaskPrompt(JsonHelpers.GetString(input, "query")) ??
            NormalizeTaskPrompt(JsonHelpers.GetString(input, "task")) ??
            NormalizeTaskPrompt(JsonHelpers.GetString(input, "target")) ??
            string.Empty;
        return $"{subType}::{prompt}";
    }

    private static string? NormalizeTaskPrompt(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        return WhitespaceRegex().Replace(value.Trim(), " ");
    }

    private static JsonElement BuildProvider(
        JsonElement parameters,
        SubAgentDefinitionNative definition,
        string? modelOverride = null)
    {
        var parentProvider = parameters.TryGetProperty("provider", out var provider) &&
            provider.ValueKind == JsonValueKind.Object
                ? provider
                : throw new InvalidOperationException("Task requires a provider config.");

        return CreateObject(writer =>
        {
            foreach (var property in parentProvider.EnumerateObject())
            {
                if (property.NameEquals("systemPrompt") ||
                    property.NameEquals("temperature") ||
                    property.NameEquals("model") ||
                    property.NameEquals("promptCacheKey"))
                {
                    continue;
                }
                property.WriteTo(writer);
            }

            if (ShouldSetSubAgentPromptCacheKey(parentProvider) &&
                JsonHelpers.GetString(parentProvider, "promptCacheKey") is { Length: > 0 } parentPromptCacheKey)
            {
                writer.WriteString(
                    "promptCacheKey",
                    BuildSubAgentPromptCacheKey(parentPromptCacheKey, definition.Name));
            }

            writer.WriteString("systemPrompt", definition.SystemPrompt);
            if (!string.IsNullOrWhiteSpace(modelOverride))
            {
                writer.WriteString("model", modelOverride);
            }
            else if (!string.IsNullOrWhiteSpace(definition.Model))
            {
                writer.WriteString("model", definition.Model);
            }
            else if (JsonHelpers.GetString(parentProvider, "model") is { Length: > 0 } model)
            {
                writer.WriteString("model", model);
            }
            if (definition.Temperature.HasValue)
            {
                writer.WriteNumber("temperature", definition.Temperature.Value);
            }
            else if (parentProvider.TryGetProperty("temperature", out var temperature))
            {
                writer.WritePropertyName("temperature");
                temperature.WriteTo(writer);
            }
        });
    }

    private static bool ShouldSetSubAgentPromptCacheKey(JsonElement provider)
    {
        if (JsonHelpers.GetString(provider, "type") != "openai-responses")
        {
            return false;
        }

        return !provider.TryGetProperty("requestOverrides", out var overrides) ||
            overrides.ValueKind != JsonValueKind.Object ||
            !overrides.TryGetProperty("body", out var body) ||
            body.ValueKind != JsonValueKind.Object ||
            !body.TryGetProperty("prompt_cache_key", out var promptCacheKey) ||
            promptCacheKey.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(promptCacheKey.GetString());
    }

    private static string BuildSubAgentPromptCacheKey(string parentPromptCacheKey, string agentName)
    {
        var parent = ClampPromptCacheKey(parentPromptCacheKey);
        var agentHash = ShortHash(agentName, 8);
        var candidate = $"{parent}-sa-{agentHash}";
        if (CountRunes(candidate) <= 64)
        {
            return candidate;
        }
        return $"ocw-sa-{ShortHash(parent, 16)}-{agentHash}";
    }

    private static string ClampPromptCacheKey(string value)
    {
        var builder = new StringBuilder();
        var count = 0;
        foreach (var rune in value.Trim().EnumerateRunes())
        {
            if (count >= 64)
            {
                break;
            }
            builder.Append(rune.ToString());
            count++;
        }
        return builder.ToString();
    }

    private static int CountRunes(string value)
    {
        var count = 0;
        foreach (var _ in value.EnumerateRunes())
        {
            count++;
        }
        return count;
    }

    private static string ShortHash(string value, int length)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(hash).ToLowerInvariant()[..length];
    }

    private static JsonElement BuildChildParameters(
        JsonElement parentParameters,
        JsonElement provider,
        JsonElement promptMessage,
        IReadOnlyList<JsonElement> tools,
        SubAgentDefinitionNative definition,
        string toolUseId,
        string? runIdOverride = null,
        string? activeTeamName = null)
    {
        var omitted = new HashSet<string>(StringComparer.Ordinal)
        {
            "messages",
            "provider",
            "tools",
            "runId",
            "maxIterations",
            "forceApproval",
            "callerAgent",
            "captureFinalMessages",
            "submitReportEnabled",
            "planMode",
            "planModeAllowedTools",
            "planRevision",
            "planExecution"
        };
        if (!string.IsNullOrWhiteSpace(activeTeamName))
        {
            omitted.Add("activeTeamName");
        }

        return CreateObject(writer =>
        {
            foreach (var property in parentParameters.EnumerateObject())
            {
                if (omitted.Contains(property.Name))
                {
                    continue;
                }
                property.WriteTo(writer);
            }

            writer.WriteString("runId", string.IsNullOrWhiteSpace(runIdOverride)
                ? $"subagent-{toolUseId}"
                : runIdOverride);
            if (!string.IsNullOrWhiteSpace(activeTeamName))
            {
                writer.WriteString("activeTeamName", activeTeamName);
            }
            writer.WritePropertyName("messages");
            writer.WriteStartArray();
            promptMessage.WriteTo(writer);
            writer.WriteEndArray();
            writer.WritePropertyName("provider");
            provider.WriteTo(writer);
            writer.WritePropertyName("tools");
            writer.WriteStartArray();
            foreach (var tool in tools)
            {
                tool.WriteTo(writer);
            }
            writer.WriteEndArray();
            writer.WriteNumber("maxIterations", Math.Max(1, definition.MaxTurns));
            writer.WriteBoolean("forceApproval", false);
            writer.WriteString("callerAgent", definition.Name);
            writer.WriteBoolean("captureFinalMessages", true);
            writer.WriteBoolean("submitReportEnabled", true);
        });
    }

    private static JsonElement AppendHookRequestContexts(
        JsonElement parameters,
        AgentRuntimeHookResult hookResult)
    {
        return CreateObject(writer =>
        {
            foreach (var property in parameters.EnumerateObject())
            {
                if (property.NameEquals("requestContextTexts"))
                {
                    continue;
                }
                property.WriteTo(writer);
            }

            writer.WritePropertyName("requestContextTexts");
            writer.WriteStartArray();
            if (parameters.TryGetProperty("requestContextTexts", out var contexts) &&
                contexts.ValueKind == JsonValueKind.Array)
            {
                foreach (var context in contexts.EnumerateArray())
                {
                    if (context.ValueKind == JsonValueKind.String &&
                        context.GetString() is { Length: > 0 })
                    {
                        context.WriteTo(writer);
                    }
                }
            }
            WriteHookRequestContextItems(writer, hookResult);
            writer.WriteEndArray();
        });
    }

    private static void WriteHookRequestContextItems(
        Utf8JsonWriter writer,
        AgentRuntimeHookResult hookResult)
    {
        foreach (var systemMessage in hookResult.SystemMessages)
        {
            if (!string.IsNullOrWhiteSpace(systemMessage))
            {
                writer.WriteStringValue($"<hook-system-message>\n{systemMessage.Trim()}\n</hook-system-message>");
            }
        }
        foreach (var additionalContext in hookResult.AdditionalContext)
        {
            if (!string.IsNullOrWhiteSpace(additionalContext))
            {
                writer.WriteStringValue($"<hook-additional-context>\n{additionalContext.Trim()}\n</hook-additional-context>");
            }
        }
    }

    private static List<JsonElement> ReadToolDefinitions(JsonElement parameters)
    {
        var result = new List<JsonElement>();
        if (!parameters.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var tool in tools.EnumerateArray())
        {
            if (tool.ValueKind == JsonValueKind.Object &&
                JsonHelpers.GetString(tool, "name") is { Length: > 0 })
            {
                result.Add(tool.Clone());
            }
        }
        return result;
    }

    private static List<JsonElement> ResolveTools(
        SubAgentDefinitionNative definition,
        IReadOnlyList<JsonElement> allTools,
        bool restrictToPlanModeInvestigation = false)
    {
        var requested = definition.Tools.Count > 0 ? definition.Tools : DefaultTools;
        var requestedSet = new HashSet<string>(requested, StringComparer.Ordinal);
        var disallowedSet = new HashSet<string>(MandatoryDisallowedTools, StringComparer.Ordinal);
        foreach (var toolName in definition.DisallowedTools)
        {
            disallowedSet.Add(toolName);
        }

        var allowAll = requestedSet.Contains("*");
        var resolved = new List<JsonElement>();
        foreach (var tool in allTools)
        {
            var name = JsonHelpers.GetString(tool, "name");
            if (string.IsNullOrWhiteSpace(name) ||
                disallowedSet.Contains(name) ||
                AgentRuntimePlanExecutor.IsPlanTool(name))
            {
                continue;
            }
            if (restrictToPlanModeInvestigation && !PlanModeInvestigationTools.Contains(name))
            {
                continue;
            }
            if (allowAll || requestedSet.Contains(name))
            {
                resolved.Add(tool.Clone());
            }
        }
        return resolved;
    }

    private static JsonElement BuildSubmitReportToolDefinition()
    {
        return CreateObject(writer =>
        {
            writer.WriteString("name", SubmitReportToolName);
            writer.WriteString(
                "description",
                "Submit your final work report and end this sub-agent session. " +
                "You MUST call this tool exactly once when you have finished the task.");
            writer.WritePropertyName("inputSchema");
            writer.WriteStartObject();
            writer.WriteString("type", "object");
            writer.WritePropertyName("properties");
            writer.WriteStartObject();
            writer.WritePropertyName("report");
            writer.WriteStartObject();
            writer.WriteString("type", "string");
            writer.WriteString("description", "The complete final report body. Must be non-empty.");
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WritePropertyName("required");
            writer.WriteStartArray();
            writer.WriteStringValue("report");
            writer.WriteEndArray();
            writer.WriteEndObject();
        });
    }

    private static string BuildDefaultSystemPrompt(string? workingFolder)
    {
        var builder = new StringBuilder();
        builder.AppendLine("You are a specialized OpenCowork sub-agent dispatched by a parent agent.");
        builder.AppendLine("Complete exactly one focused task. You do not see the earlier conversation.");
        builder.AppendLine("Use available tools decisively, verify your work, and keep changes scoped to the delegated task.");
        builder.AppendLine("You have broad tool access except Task, AskUserQuestion, and plan-mode tools.");
        builder.AppendLine("Do not create, finalize, approve, or execute plans; report plan suggestions to the parent agent.");
        if (!string.IsNullOrWhiteSpace(workingFolder))
        {
            builder.AppendLine($"Working folder: {workingFolder}");
        }
        builder.AppendLine("When complete, call SubmitReport exactly once with a concise but complete report.");
        return builder.ToString();
    }

    private static string? GetFrontmatterString(string frontmatter, string key)
    {
        var match = Regex.Match(
            frontmatter,
            $"^{Regex.Escape(key)}:\\s*(.+)$",
            RegexOptions.Multiline);
        return match.Success ? match.Groups[1].Value.Trim().Trim('"', '\'') : null;
    }

    private static int? GetFrontmatterInt(string frontmatter, string key)
    {
        return int.TryParse(GetFrontmatterString(frontmatter, key), out var value) ? value : null;
    }

    private static double? GetFrontmatterDouble(string frontmatter, string key)
    {
        return double.TryParse(GetFrontmatterString(frontmatter, key), out var value) ? value : null;
    }

    private static IReadOnlyList<string>? GetFrontmatterStringList(string frontmatter, string key)
    {
        var raw = GetFrontmatterString(frontmatter, key);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var normalized = raw.Trim();
        if (normalized.StartsWith("[", StringComparison.Ordinal) &&
            normalized.EndsWith("]", StringComparison.Ordinal))
        {
            normalized = normalized[1..^1];
        }

        var values = normalized
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(item => item.Trim().Trim('"', '\''))
            .Where(item => item.Length > 0)
            .ToArray();
        return values.Length == 0 ? null : values;
    }

    private static RendererToolResult ErrorResult(string message)
    {
        return new RendererToolResult(StringElement(EncodeError(message)), true, message);
    }

    private static RendererToolResult DuplicateTaskResult(string subAgentType, string previousReport)
    {
        var content = CreateObject(writer =>
        {
            writer.WriteString(
                "error",
                $"Duplicate Task call blocked: the previous Task invocation to \"{subAgentType}\" " +
                "used an identical prompt and already returned a report. Do NOT re-launch the " +
                "same sub-agent with the same prompt. Use the previous report below to continue " +
                "your work, or call Task with a different sub-agent or a materially different " +
                "prompt if you need new information.");
            writer.WriteString("previous_report", previousReport);
        }).GetRawText();
        return new RendererToolResult(StringElement(content), false, null);
    }

    private static string EncodeError(string message)
    {
        return CreateObject(writer => writer.WriteString("error", message)).GetRawText();
    }

    private static JsonElement StringElement(string value)
    {
        return AgentRuntimeProviderSupport.CreateStringElement(value);
    }

    private static JsonElement CreateObject(Action<Utf8JsonWriter> writeProperties)
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

    private static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    [GeneratedRegex("^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---\\s*(?:\\r?\\n)?")]
    private static partial Regex FrontmatterRegex();

    [GeneratedRegex("\\s+")]
    private static partial Regex WhitespaceRegex();

    private sealed record SubAgentDefinitionNative(
        string Name,
        string Description,
        string SystemPrompt,
        IReadOnlyList<string> Tools,
        IReadOnlyList<string> DisallowedTools,
        int MaxTurns,
        string? InitialPrompt,
        string? Model,
        double? Temperature);

    private sealed class SubAgentRunCollector
    {
        private readonly string subAgentName;
        private readonly string toolUseId;
        private readonly JsonElement input;
        private readonly JsonElement provider;
        private readonly AgentRuntimeTools.AgentRuntimeRunState parentState;
        private readonly WorkerRequestContext context;
        private readonly JsonElement requestModel;
        private readonly List<AgentRuntimeToolCallState> toolCalls = [];
        private readonly StringBuilder currentAssistantText = new();
        private readonly StringBuilder aggregatedText = new();
        private JsonElement[] finalMessages = [];
        private AgentRuntimeTokenUsage usage = new(0, 0);
        private int iterations;
        private int toolCallCount;
        private string? error;

        public SubAgentRunCollector(
            string subAgentName,
            string toolUseId,
            JsonElement input,
            JsonElement promptMessage,
            JsonElement provider,
            AgentRuntimeTools.AgentRuntimeRunState parentState,
            WorkerRequestContext context)
        {
            this.subAgentName = subAgentName;
            this.toolUseId = toolUseId;
            this.input = input;
            _ = promptMessage;
            this.provider = provider;
            this.parentState = parentState;
            this.context = context;
            requestModel = BuildRequestModel(provider);
        }

        public async ValueTask ObserveAsync(AgentRuntimeStreamEvent[] events)
        {
            foreach (var item in events)
            {
                await ObserveOneAsync(item);
            }
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

            var success = string.IsNullOrWhiteSpace(error);
            return new SubAgentResultNative(
                success,
                output ?? string.Empty,
                !string.IsNullOrWhiteSpace(output),
                toolCallCount,
                iterations,
                usage,
                error);
        }

        private async Task ObserveOneAsync(AgentRuntimeStreamEvent item)
        {
            switch (item.Type)
            {
                case "iteration_start":
                    iterations = item.Iteration ?? iterations;
                    currentAssistantText.Clear();
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_iteration",
                        Iteration: iterations,
                        AssistantMessage: BuildAssistantPlaceholder(),
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "text_delta":
                    if (!string.IsNullOrEmpty(item.Text))
                    {
                        currentAssistantText.Append(item.Text);
                        aggregatedText.Append(item.Text);
                    }
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_text_delta",
                        Text: item.Text,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "thinking_delta":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_thinking_delta",
                        Thinking: item.Thinking,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "thinking_encrypted":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_thinking_encrypted",
                        ThinkingEncryptedContent: item.Content,
                        ThinkingEncryptedProvider: item.Provider,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "tool_use_streaming_start":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_tool_use_streaming_start",
                        ToolCallId: item.ToolCallId,
                        ToolName: item.ToolName,
                        SubAgentToolCallExtraContent: item.ToolCallExtraContent,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "tool_use_args_delta":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_tool_use_args_delta",
                        ToolCallId: item.ToolCallId,
                        PartialInput: item.PartialInput,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "tool_use_generated":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_tool_use_generated",
                        ToolUseBlock: item.ToolUseBlock,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "image_generated":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_image_generated",
                        ImageBlock: item.ImageBlock,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "image_error":
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_image_error",
                        ImageError: item.ImageError,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "message_end":
                    if (item.Usage is not null)
                    {
                        usage = MergeUsage(usage, item.Usage);
                    }
                    await EmitAsync(new AgentRuntimeStreamEvent(
                        "sub_agent_message_end",
                        Usage: item.Usage,
                        ProviderResponseId: item.ProviderResponseId,
                        RequestModel: requestModel,
                        SubAgentName: subAgentName,
                        ToolUseId: toolUseId));
                    break;
                case "tool_call_start":
                case "tool_call_result":
                    if (item.ToolCall is not null)
                    {
                        UpsertToolCall(item.ToolCall);
                        if (item.Type == "tool_call_result")
                        {
                            toolCallCount++;
                        }
                        await EmitAsync(new AgentRuntimeStreamEvent(
                            "sub_agent_tool_call",
                            ToolCall: item.ToolCall,
                            SubAgentName: subAgentName,
                            ToolUseId: toolUseId));
                    }
                    break;
                case "iteration_end":
                    if (item.ToolResults is { Length: > 0 } toolResults)
                    {
                        await EmitAsync(new AgentRuntimeStreamEvent(
                            "sub_agent_tool_result_message",
                            EventMessage: BuildToolResultMessage(toolResults),
                            SubAgentName: subAgentName,
                            ToolUseId: toolUseId));
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

        private async Task EmitAsync(params AgentRuntimeStreamEvent[] events)
        {
            await AgentRuntimeTools.EmitAsync(parentState, context, events);
        }

        private void UpsertToolCall(AgentRuntimeToolCallState toolCall)
        {
            var index = toolCalls.FindIndex(item => item.Id == toolCall.Id);
            if (index >= 0)
            {
                toolCalls[index] = toolCall;
            }
            else
            {
                toolCalls.Add(toolCall);
            }
        }

        private JsonElement BuildAssistantPlaceholder()
        {
            return CreateObject(writer =>
            {
                writer.WriteString("id", $"oc_subagent_assistant_{Guid.NewGuid():N}");
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

        private static JsonElement BuildRequestModel(JsonElement provider)
        {
            return CreateObject(writer =>
            {
                WriteNullableString(writer, "providerId", JsonHelpers.GetString(provider, "providerId"));
                WriteNullableString(writer, "providerBuiltinId", JsonHelpers.GetString(provider, "providerBuiltinId"));
                writer.WriteString("modelId", JsonHelpers.GetString(provider, "model") ?? string.Empty);
                writer.WriteString("modelName", JsonHelpers.GetString(provider, "model") ?? string.Empty);
            });
        }

        private static JsonElement BuildToolResultMessage(IReadOnlyList<AgentRuntimeToolResult> toolResults)
        {
            return CreateObject(writer =>
            {
                writer.WriteString("id", $"oc_subagent_tool_result_{Guid.NewGuid():N}");
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

    private sealed record SubAgentResultNative(
        bool Success,
        string Output,
        bool ReportSubmitted,
        int ToolCallCount,
        int Iterations,
        AgentRuntimeTokenUsage Usage,
        string? Error)
    {
        public JsonElement ToJson()
        {
            return CreateObject(writer =>
            {
                writer.WriteBoolean("success", Success);
                writer.WriteString("output", Output);
                writer.WriteBoolean("reportSubmitted", ReportSubmitted);
                writer.WriteNumber("toolCallCount", ToolCallCount);
                writer.WriteNumber("iterations", Iterations);
                writer.WritePropertyName("usage");
                WriteUsage(writer, Usage);
                if (!string.IsNullOrWhiteSpace(Error))
                {
                    writer.WriteString("error", Error);
                }
            });
        }
    }

    private static AgentRuntimeTokenUsage MergeUsage(
        AgentRuntimeTokenUsage current,
        AgentRuntimeTokenUsage patch)
    {
        var cacheReadTokens = AddNullable(current.CacheReadTokens, patch.CacheReadTokens);
        double? cacheReadRatio = null;
        var totalInput = current.InputTokens + patch.InputTokens;
        if (cacheReadTokens.HasValue && totalInput > 0)
        {
            cacheReadRatio = Math.Round((double)cacheReadTokens.Value / totalInput, 4);
        }

        return new AgentRuntimeTokenUsage(
            current.InputTokens + patch.InputTokens,
            current.OutputTokens + patch.OutputTokens,
            AddNullable(current.BillableInputTokens, patch.BillableInputTokens),
            cacheReadTokens,
            AddNullable(current.ReasoningTokens, patch.ReasoningTokens),
            patch.ContextTokens ?? current.ContextTokens,
            AddNullable(current.CacheCreationTokens, patch.CacheCreationTokens),
            AddNullable(current.CacheCreation5mTokens, patch.CacheCreation5mTokens),
            AddNullable(current.CacheCreation1hTokens, patch.CacheCreation1hTokens),
            cacheReadRatio);
    }

    private static int? AddNullable(int? left, int? right)
    {
        if (!left.HasValue && !right.HasValue)
        {
            return null;
        }
        return (left ?? 0) + (right ?? 0);
    }

    private static void WriteUsage(Utf8JsonWriter writer, AgentRuntimeTokenUsage usage)
    {
        writer.WriteStartObject();
        writer.WriteNumber("inputTokens", usage.InputTokens);
        writer.WriteNumber("outputTokens", usage.OutputTokens);
        WriteNullableNumber(writer, "billableInputTokens", usage.BillableInputTokens);
        WriteNullableNumber(writer, "cacheReadTokens", usage.CacheReadTokens);
        WriteNullableNumber(writer, "reasoningTokens", usage.ReasoningTokens);
        WriteNullableNumber(writer, "contextTokens", usage.ContextTokens);
        WriteNullableNumber(writer, "cacheCreationTokens", usage.CacheCreationTokens);
        WriteNullableNumber(writer, "cacheCreation5mTokens", usage.CacheCreation5mTokens);
        WriteNullableNumber(writer, "cacheCreation1hTokens", usage.CacheCreation1hTokens);
        if (usage.CacheReadRatio.HasValue)
        {
            writer.WriteNumber("cacheReadRatio", usage.CacheReadRatio.Value);
        }
        writer.WriteEndObject();
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string propertyName, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            writer.WriteString(propertyName, value);
        }
    }

    private static void WriteNullableNumber(Utf8JsonWriter writer, string propertyName, int? value)
    {
        if (value.HasValue)
        {
            writer.WriteNumber(propertyName, value.Value);
        }
    }
}
