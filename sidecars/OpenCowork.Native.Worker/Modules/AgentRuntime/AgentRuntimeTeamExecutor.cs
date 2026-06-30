using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class AgentRuntimeTeamExecutor
{
    private static readonly HashSet<string> TeamToolNames = new(StringComparer.Ordinal)
    {
        "TeamCreate",
        "TeamStatus",
        "TeamDelete",
        "SendMessage"
    };

    private static readonly HashSet<string> TeamTaskToolNames = new(StringComparer.Ordinal)
    {
        "TaskCreate",
        "TaskGet",
        "TaskUpdate",
        "TaskList"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsTeamTool(string toolName)
    {
        return TeamToolNames.Contains(toolName);
    }

    public static bool IsTeamTaskTool(string toolName)
    {
        return TeamTaskToolNames.Contains(toolName);
    }

    public static bool ShouldRouteTeamTask(JsonElement parameters)
    {
        return JsonHelpers.GetBool(parameters, "teamToolsActive", false) ||
            AgentRuntimeTeamRuntimeStore.ResolveTeamName(parameters).Length > 0;
    }

    public static bool RequiresApproval(string toolName)
    {
        return toolName == "TeamDelete";
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        try
        {
            return call.Name switch
            {
                "TeamCreate" => await ExecuteTeamCreateAsync(call, parameters, context, cancellationToken),
                "TeamStatus" => await ExecuteTeamStatusAsync(call, parameters, context, cancellationToken),
                "TeamDelete" => await ExecuteTeamDeleteAsync(call, parameters, context, cancellationToken),
                "SendMessage" => await ExecuteSendMessageAsync(call, parameters, context, cancellationToken),
                "TaskCreate" => await ExecuteTaskCreateAsync(call, parameters, context, cancellationToken),
                "TaskGet" => ExecuteTaskGet(call, parameters),
                "TaskUpdate" => await ExecuteTaskUpdateAsync(call, parameters, context, cancellationToken),
                "TaskList" => ExecuteTaskList(call, parameters),
                _ => EncodeError($"Native team tool not registered: {call.Name}")
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return EncodeError(ex.Message);
        }
    }

    private static async Task<string> ExecuteTeamCreateAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var teamName = JsonHelpers.GetString(call.Input, "team_name")?.Trim() ?? string.Empty;
        var description = JsonHelpers.GetString(call.Input, "description")?.Trim() ?? string.Empty;
        if (teamName.Length == 0 || description.Length == 0)
        {
            return EncodeError("team_name and description are required");
        }

        var runtimePath = AgentRuntimeTeamRuntimeStore.CreateTeam(
            teamName,
            description,
            JsonHelpers.GetString(parameters, "sessionId"),
            JsonHelpers.GetString(parameters, "workingFolder"),
            JsonHelpers.GetString(call.Input, "default_backend"),
            out var safeTeamName,
            out _);
        var snapshot = AgentRuntimeTeamRuntimeStore.ReadSnapshot(safeTeamName, 10);
        await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
            context,
            parameters,
            snapshot,
            openPanel: true,
            cancellationToken);

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("team_name", safeTeamName);
            writer.WriteString("runtime_path", runtimePath);
            writer.WriteString("lead_agent_id", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "leadAgentId"));
            writer.WriteString("default_backend", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "defaultBackend"));
            writer.WriteString("permission_mode", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "permissionMode"));
            writer.WriteString(
                "message",
                $"Team \"{safeTeamName}\" created. Now create tasks with TaskCreate and spawn teammates with Task (run_in_background=true).");
        });
    }

    private static async Task<string> ExecuteTeamStatusAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var snapshot = AgentRuntimeTeamRuntimeStore.ReadSnapshot(teamName, 10);
        await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
            context,
            parameters,
            snapshot,
            openPanel: false,
            cancellationToken);
        return FormatTeamStatus(snapshot);
    }

    private static async Task<string> ExecuteTeamDeleteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var snapshot = AgentRuntimeTeamRuntimeStore.ReadSnapshot(teamName, 10);
        var taskCount = CountArray(snapshot.Manifest, "tasks");
        var memberCount = CountArray(snapshot.Manifest, "members");
        var completedCount = CountCompletedTasks(snapshot.Manifest);

        AgentRuntimeSubAgentExecutor.CancelBackgroundTeamRuns(teamName);

        AgentRuntimeTeamRuntimeStore.DeleteTeam(teamName);
        await AgentRuntimeTeamUiBridge.EmitEndAsync(context, parameters, cancellationToken);
        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("team_name", teamName);
            writer.WriteNumber("members_removed", memberCount);
            writer.WriteNumber("tasks_total", taskCount);
            writer.WriteNumber("tasks_completed", completedCount);
        });
    }

    private static async Task<string> ExecuteSendMessageAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var type = JsonHelpers.GetString(call.Input, "type")?.Trim() ?? string.Empty;
        var content = JsonHelpers.GetString(call.Input, "content");
        if (type.Length == 0 || string.IsNullOrEmpty(content))
        {
            return EncodeError("type and content are required");
        }

        TeamSnapshot snapshot;
        if (type is "mode_set_request" or "team_permission_update")
        {
            snapshot = AgentRuntimeTeamRuntimeStore.UpdatePermissionFromMessage(teamName, content);
        }

        snapshot = AgentRuntimeTeamRuntimeStore.AppendMessage(
            teamName,
            type,
            JsonHelpers.GetString(call.Input, "recipient")?.Trim() ?? string.Empty,
            content,
            JsonHelpers.GetString(call.Input, "sender")?.Trim() ?? "lead",
            JsonHelpers.GetString(call.Input, "summary"));
        await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
            context,
            parameters,
            snapshot,
            openPanel: false,
            cancellationToken);
        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("team_name", teamName);
            writer.WriteString("type", type);
            writer.WriteString("recipient", JsonHelpers.GetString(call.Input, "recipient") ?? "all");
        });
    }

    private static async Task<string> ExecuteTaskCreateAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var subject = ResolveTaskTitle(call.Input);
        if (subject.Length == 0)
        {
            return EncodeError("TaskCreate requires a non-empty title.");
        }

        var snapshot = AgentRuntimeTeamRuntimeStore.CreateTask(
            teamName,
            subject,
            JsonHelpers.GetString(call.Input, "activeForm"),
            AgentRuntimeTeamRuntimeStore.GetTaskDependencies(call.Input),
            out var task,
            out var existing);
        await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
            context,
            parameters,
            snapshot,
            openPanel: false,
            cancellationToken);
        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("task_id", AgentRuntimeTeamRuntimeStore.GetString(task, "id"));
            writer.WriteString("title", AgentRuntimeTeamRuntimeStore.GetString(task, "subject"));
            writer.WriteString("subject", AgentRuntimeTeamRuntimeStore.GetString(task, "subject"));
            if (existing)
            {
                writer.WriteString("note", "Task with this title already exists, returning existing task.");
            }
        });
    }

    private static string ExecuteTaskGet(NativeToolCallView call, JsonElement parameters)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var taskId = ReadTaskId(call.Input);
        if (taskId.Length == 0)
        {
            return EncodeError("TaskGet requires taskId.");
        }
        var task = AgentRuntimeTeamRuntimeStore.GetTask(teamName, taskId);
        return EncodeJsonObject(writer => WriteTaskProperties(writer, task));
    }

    private static async Task<string> ExecuteTaskUpdateAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var taskId = ReadTaskId(call.Input);
        if (taskId.Length == 0)
        {
            return EncodeError("TaskUpdate requires taskId.");
        }

        var snapshot = AgentRuntimeTeamRuntimeStore.UpdateTask(teamName, taskId, call.Input, out var patch);
        await AgentRuntimeTeamUiBridge.EmitSnapshotAsync(
            context,
            parameters,
            snapshot,
            openPanel: false,
            cancellationToken);
        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("task_id", taskId);
            writer.WritePropertyName("updated");
            patch.WriteTo(writer);
            if (patch["deleted"] is not null)
            {
                writer.WriteBoolean("deleted", true);
            }
        });
    }

    private static string ExecuteTaskList(NativeToolCallView call, JsonElement parameters)
    {
        var teamName = RequireTeamName(call.Input, parameters);
        var snapshot = AgentRuntimeTeamRuntimeStore.ReadSnapshot(teamName, 10);
        var statusFilter = JsonHelpers.GetString(call.Input, "status")?.Trim() ?? "all";
        return EncodeJsonObject(writer =>
        {
            writer.WriteString("mode", "team");
            writer.WriteString("team_name", teamName);
            var tasks = AgentRuntimeTeamRuntimeStore.EnsureArray(snapshot.Manifest, "tasks");
            writer.WriteNumber("total", tasks.Count);
            writer.WritePropertyName("tasks");
            writer.WriteStartArray();
            foreach (var item in tasks)
            {
                if (item is not JsonObject task) continue;
                var status = AgentRuntimeTeamRuntimeStore.GetString(task, "status");
                if (statusFilter != "all" && statusFilter.Length > 0 && status != statusFilter) continue;
                writer.WriteStartObject();
                WriteTaskProperties(writer, task);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        });
    }

    private static string FormatTeamStatus(TeamSnapshot snapshot)
    {
        return EncodeJsonObject(writer =>
        {
            var teamName = AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "name");
            writer.WriteString("team_name", teamName);
            writer.WriteString("description", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "description"));
            writer.WriteString("runtime_path", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "runtimePath"));
            writer.WriteString("lead_agent_id", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "leadAgentId"));
            writer.WriteString("default_backend", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "defaultBackend"));
            writer.WriteString("permission_mode", AgentRuntimeTeamRuntimeStore.GetString(snapshot.Manifest, "permissionMode"));
            writer.WriteNumber("members_total", CountArray(snapshot.Manifest, "members"));
            writer.WriteNumber("tasks_total", CountArray(snapshot.Manifest, "tasks"));
            writer.WriteNumber("tasks_completed", CountCompletedTasks(snapshot.Manifest));
            writer.WritePropertyName("snapshot");
            AgentRuntimeTeamRuntimeStore.WriteSnapshot(writer, snapshot);
        });
    }

    private static string RequireTeamName(JsonElement input, JsonElement parameters)
    {
        var teamName = AgentRuntimeTeamRuntimeStore.ResolveTeamName(input, parameters);
        if (teamName.Length == 0)
        {
            throw new InvalidOperationException("No active team. Call TeamCreate first.");
        }
        return teamName;
    }

    private static string ResolveTaskTitle(JsonElement input)
    {
        var title = NormalizeTaskTitlePart(JsonHelpers.GetString(input, "title") ??
            JsonHelpers.GetString(input, "subject"));
        var description = NormalizeTaskTitlePart(JsonHelpers.GetString(input, "description"));
        if (title.Length > 0)
        {
            return description.Length == 0 || title.Contains(description, StringComparison.Ordinal)
                ? title
                : $"{title}: {description}";
        }
        return description;
    }

    private static string NormalizeTaskTitlePart(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    private static string ReadTaskId(JsonElement input)
    {
        return (JsonHelpers.GetString(input, "taskId") ??
                JsonHelpers.GetString(input, "task_id") ??
                string.Empty)
            .Trim();
    }

    private static int CountArray(JsonObject obj, string propertyName)
    {
        return obj[propertyName] is JsonArray array ? array.Count : 0;
    }

    private static int CountCompletedTasks(JsonObject manifest)
    {
        var count = 0;
        if (manifest["tasks"] is not JsonArray tasks) return 0;
        foreach (var item in tasks)
        {
            if (item is JsonObject task &&
                AgentRuntimeTeamRuntimeStore.GetString(task, "status") == "completed")
            {
                count++;
            }
        }
        return count;
    }

    private static void WriteTaskProperties(Utf8JsonWriter writer, JsonObject task)
    {
        var id = AgentRuntimeTeamRuntimeStore.GetString(task, "id");
        var subject = AgentRuntimeTeamRuntimeStore.GetString(task, "subject");
        writer.WriteString("id", id);
        writer.WriteString("task_id", id);
        writer.WriteString("title", subject);
        writer.WriteString("subject", subject);
        writer.WriteString("status", AgentRuntimeTeamRuntimeStore.GetString(task, "status"));
        WriteNullableString(writer, "owner", AgentRuntimeTeamRuntimeStore.GetString(task, "owner"));
        if (task["activeForm"] is not null)
        {
            writer.WriteString("activeForm", AgentRuntimeTeamRuntimeStore.GetString(task, "activeForm"));
        }
        writer.WritePropertyName("dependsOn");
        (task["dependsOn"] as JsonArray ?? new JsonArray()).WriteTo(writer);
        writer.WritePropertyName("depends_on");
        (task["dependsOn"] as JsonArray ?? new JsonArray()).WriteTo(writer);
        if (task["report"] is not null)
        {
            writer.WriteString("report", AgentRuntimeTeamRuntimeStore.GetString(task, "report"));
        }
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, value);
        }
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }
}
