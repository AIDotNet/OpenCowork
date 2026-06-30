using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

internal static class AgentRuntimeTaskExecutor
{
    private const string IdAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    private const string TitleTerminalPunctuation = ":\uFF1A;\uFF1B,.\uFF0C\u3002!?\uFF01\uFF1F";

    private static readonly HashSet<string> TaskToolNames = new(StringComparer.Ordinal)
    {
        "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"
    };

    public static bool IsTaskTool(string toolName)
    {
        return TaskToolNames.Contains(toolName);
    }

    public static bool CanExecute(JsonElement parameters)
    {
        return !JsonHelpers.GetBool(parameters, "teamToolsActive", false);
    }

    public static string Execute(NativeToolCallView call, JsonElement parameters)
    {
        return call.Name switch
        {
            "TaskCreate" => ExecuteCreate(call.Input, parameters),
            "TaskGet" => ExecuteGet(call.Input, parameters),
            "TaskUpdate" => ExecuteUpdate(call.Input, parameters),
            "TaskList" => ExecuteList(parameters),
            _ => EncodeError($"Native task tool not registered: {call.Name}")
        };
    }

    private static string ExecuteCreate(JsonElement input, JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId))
        {
            return EncodeError("No active session context for TaskCreate.");
        }

        var subject = ResolveTaskTitle(input);
        if (subject.Length == 0)
        {
            return EncodeError("TaskCreate requires a non-empty title.");
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var task = new NativeTaskRow
        {
            Id = CreateTaskId(),
            SessionId = sessionId,
            Subject = subject,
            Description = string.Empty,
            ActiveForm = JsonHelpers.GetString(input, "activeForm"),
            Status = "pending",
            Owner = null,
            Blocks = [],
            BlockedBy = [],
            MetadataJson = GetObjectRawJson(input, "metadata"),
            SortOrder = 0,
            CreatedAt = now,
            UpdatedAt = now
        };

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        task.SortOrder = CountSessionTasks(connection, transaction, sessionId);
        InsertTask(connection, transaction, task);
        transaction.Commit();

        using var readConnection = DbConnectionFactory.OpenReadWrite(parameters);
        var tasks = LoadTasksBySession(readConnection, sessionId);
        return EncodeTaskCreateResult(task, tasks);
    }

    private static string ExecuteGet(JsonElement input, JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        var taskId = GetTaskId(input);
        if (taskId.Length == 0)
        {
            return EncodeError("TaskGet requires taskId.");
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        var task = LoadTask(connection, taskId, sessionId);
        return task is null
            ? EncodeError($"Task \"{taskId}\" not found")
            : EncodeTaskGetResult(task);
    }

    private static string ExecuteUpdate(JsonElement input, JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        var taskId = GetTaskId(input);
        if (taskId.Length == 0)
        {
            return EncodeError("TaskUpdate requires taskId.");
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        var task = LoadTask(connection, transaction, taskId, sessionId);
        if (task is null)
        {
            return EncodeError($"Task \"{taskId}\" not found");
        }

        var newStatus = JsonHelpers.GetString(input, "status");
        if (newStatus == "deleted")
        {
            DeleteTaskAndReferences(connection, transaction, taskId, task.SessionId);
            transaction.Commit();
            return EncodeJsonObject(writer =>
            {
                writer.WriteBoolean("success", true);
                writer.WriteString("task_id", taskId);
                writer.WriteBoolean("deleted", true);
            });
        }

        var updated = task;
        var changedFields = new List<string>();
        if (newStatus is "pending" or "in_progress" or "completed")
        {
            updated.Status = newStatus;
            changedFields.Add("status");
        }

        if (HasAnyProperty(input, "title", "subject", "description"))
        {
            var nextTitle = ResolveTaskTitle(input, updated.Subject);
            if (nextTitle.Length > 0 && nextTitle != updated.Subject)
            {
                updated.Subject = nextTitle;
                changedFields.Add("subject");
            }
        }

        if (input.TryGetProperty("activeForm", out var activeForm))
        {
            updated.ActiveForm = activeForm.ValueKind == JsonValueKind.Null ? null : activeForm.ToString();
            changedFields.Add("activeForm");
        }

        if (input.TryGetProperty("owner", out var owner))
        {
            updated.Owner = owner.ValueKind == JsonValueKind.Null ? null : owner.ToString();
            changedFields.Add("owner");
        }

        var addBlocks = GetStringArray(input, "addBlocks");
        if (addBlocks.Length > 0)
        {
            updated.Blocks = Union(updated.Blocks, addBlocks);
            changedFields.Add("blocks");
            foreach (var blockedId in addBlocks)
            {
                if (LoadTask(connection, transaction, blockedId, updated.SessionId) is { } blocked)
                {
                    blocked.BlockedBy = Union(blocked.BlockedBy, [taskId]);
                    blocked.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    UpdateTask(connection, transaction, blocked);
                }
            }
        }

        var addBlockedBy = GetStringArray(input, "addBlockedBy");
        if (addBlockedBy.Length > 0)
        {
            updated.BlockedBy = Union(updated.BlockedBy, addBlockedBy);
            changedFields.Add("blockedBy");
            foreach (var dependencyId in addBlockedBy)
            {
                if (LoadTask(connection, transaction, dependencyId, updated.SessionId) is { } dependency)
                {
                    dependency.Blocks = Union(dependency.Blocks, [taskId]);
                    dependency.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    UpdateTask(connection, transaction, dependency);
                }
            }
        }

        if (input.TryGetProperty("metadata", out var metadata) && metadata.ValueKind == JsonValueKind.Object)
        {
            updated.MetadataJson = MergeMetadataJson(updated.MetadataJson, metadata);
            changedFields.Add("metadata");
        }

        updated.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        UpdateTask(connection, transaction, updated);
        transaction.Commit();

        using var readConnection = DbConnectionFactory.OpenReadWrite(parameters);
        var refreshed = LoadTask(readConnection, taskId, sessionId) ?? updated;
        var tasks = LoadTasksBySession(readConnection, updated.SessionId);
        return EncodeTaskUpdateResult(refreshed, tasks, changedFields);
    }

    private static string ExecuteList(JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId))
        {
            return EncodeJsonObject(writer =>
            {
                writer.WriteString("mode", "standalone");
                writer.WriteNumber("total", 0);
                writer.WriteStartArray("tasks");
                writer.WriteEndArray();
            });
        }

        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        return EncodeTaskListResult(LoadTasksBySession(connection, sessionId));
    }

    private static void InsertTask(
        SqliteConnection connection,
        SqliteTransaction transaction,
        NativeTaskRow task)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO tasks (
                id, session_id, plan_id, subject, description, active_form, status, owner,
                blocks, blocked_by, metadata, sort_order, created_at, updated_at
            ) VALUES (
                $id, $sessionId, $planId, $subject, $description, $activeForm, $status, $owner,
                $blocks, $blockedBy, $metadata, $sortOrder, $createdAt, $updatedAt
            )
            """,
            new DbSql.SqlParam("$id", task.Id),
            new DbSql.SqlParam("$sessionId", task.SessionId),
            new DbSql.SqlParam("$planId", task.PlanId),
            new DbSql.SqlParam("$subject", task.Subject),
            new DbSql.SqlParam("$description", task.Description),
            new DbSql.SqlParam("$activeForm", task.ActiveForm),
            new DbSql.SqlParam("$status", task.Status),
            new DbSql.SqlParam("$owner", task.Owner),
            new DbSql.SqlParam("$blocks", SerializeStringArray(task.Blocks)),
            new DbSql.SqlParam("$blockedBy", SerializeStringArray(task.BlockedBy)),
            new DbSql.SqlParam("$metadata", task.MetadataJson),
            new DbSql.SqlParam("$sortOrder", task.SortOrder),
            new DbSql.SqlParam("$createdAt", task.CreatedAt),
            new DbSql.SqlParam("$updatedAt", task.UpdatedAt));
    }

    private static void UpdateTask(
        SqliteConnection connection,
        SqliteTransaction transaction,
        NativeTaskRow task)
    {
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            UPDATE tasks
               SET subject = $subject,
                   description = $description,
                   active_form = $activeForm,
                   status = $status,
                   owner = $owner,
                   blocks = $blocks,
                   blocked_by = $blockedBy,
                   metadata = $metadata,
                   updated_at = $updatedAt
             WHERE id = $id
            """,
            new DbSql.SqlParam("$subject", task.Subject),
            new DbSql.SqlParam("$description", task.Description),
            new DbSql.SqlParam("$activeForm", task.ActiveForm),
            new DbSql.SqlParam("$status", task.Status),
            new DbSql.SqlParam("$owner", task.Owner),
            new DbSql.SqlParam("$blocks", SerializeStringArray(task.Blocks)),
            new DbSql.SqlParam("$blockedBy", SerializeStringArray(task.BlockedBy)),
            new DbSql.SqlParam("$metadata", task.MetadataJson),
            new DbSql.SqlParam("$updatedAt", task.UpdatedAt),
            new DbSql.SqlParam("$id", task.Id));
    }

    private static void DeleteTaskAndReferences(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string taskId,
        string sessionId)
    {
        var sessionTasks = LoadTasksBySession(connection, transaction, sessionId);
        DbSql.ExecuteNonQuery(
            connection,
            transaction,
            "DELETE FROM tasks WHERE id = $id",
            new DbSql.SqlParam("$id", taskId));

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var task in sessionTasks)
        {
            if (task.Id == taskId)
            {
                continue;
            }

            var nextBlocks = RemoveTaskId(task.Blocks, taskId);
            var nextBlockedBy = RemoveTaskId(task.BlockedBy, taskId);
            if (nextBlocks.Length == task.Blocks.Length && nextBlockedBy.Length == task.BlockedBy.Length)
            {
                continue;
            }

            task.Blocks = nextBlocks;
            task.BlockedBy = nextBlockedBy;
            task.UpdatedAt = now;
            UpdateTask(connection, transaction, task);
        }
    }

    private static int CountSessionTasks(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*) FROM tasks WHERE session_id = $sessionId";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        return Convert.ToInt32(command.ExecuteScalar());
    }

    private static List<NativeTaskRow> LoadTasksBySession(SqliteConnection connection, string sessionId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"{TaskSelectSql} WHERE session_id = $sessionId ORDER BY sort_order ASC";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        return ReadTasks(command);
    }

    private static List<NativeTaskRow> LoadTasksBySession(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{TaskSelectSql} WHERE session_id = $sessionId ORDER BY sort_order ASC";
        command.Parameters.AddWithValue("$sessionId", sessionId);
        return ReadTasks(command);
    }

    private static NativeTaskRow? LoadTask(SqliteConnection connection, string taskId, string? sessionId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = string.IsNullOrEmpty(sessionId)
            ? $"{TaskSelectSql} WHERE id = $id LIMIT 1"
            : $"{TaskSelectSql} WHERE id = $id AND session_id = $sessionId LIMIT 1";
        command.Parameters.AddWithValue("$id", taskId);
        if (!string.IsNullOrEmpty(sessionId))
        {
            command.Parameters.AddWithValue("$sessionId", sessionId);
        }
        return ReadTasks(command).FirstOrDefault();
    }

    private static NativeTaskRow? LoadTask(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string taskId,
        string? sessionId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = string.IsNullOrEmpty(sessionId)
            ? $"{TaskSelectSql} WHERE id = $id LIMIT 1"
            : $"{TaskSelectSql} WHERE id = $id AND session_id = $sessionId LIMIT 1";
        command.Parameters.AddWithValue("$id", taskId);
        if (!string.IsNullOrEmpty(sessionId))
        {
            command.Parameters.AddWithValue("$sessionId", sessionId);
        }
        return ReadTasks(command).FirstOrDefault();
    }

    private static List<NativeTaskRow> ReadTasks(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var tasks = new List<NativeTaskRow>();
        while (reader.Read())
        {
            tasks.Add(new NativeTaskRow
            {
                Id = reader.GetString(0),
                SessionId = reader.GetString(1),
                PlanId = reader.IsDBNull(2) ? null : reader.GetString(2),
                Subject = reader.GetString(3),
                Description = reader.GetString(4),
                ActiveForm = reader.IsDBNull(5) ? null : reader.GetString(5),
                Status = NormalizeStatus(reader.GetString(6)),
                Owner = reader.IsDBNull(7) ? null : reader.GetString(7),
                Blocks = ParseStringArray(reader.IsDBNull(8) ? "[]" : reader.GetString(8)),
                BlockedBy = ParseStringArray(reader.IsDBNull(9) ? "[]" : reader.GetString(9)),
                MetadataJson = reader.IsDBNull(10) ? null : reader.GetString(10),
                SortOrder = reader.GetInt32(11),
                CreatedAt = reader.GetInt64(12),
                UpdatedAt = reader.GetInt64(13)
            });
        }
        return tasks;
    }

    private static string EncodeTaskCreateResult(NativeTaskRow task, List<NativeTaskRow> tasks)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("task_id", task.Id);
            writer.WriteString("title", task.Subject);
            writer.WriteString("subject", task.Subject);
            writer.WritePropertyName("task");
            WriteTaskSnapshot(writer, task);
            WriteStandaloneSummary(writer, tasks, includeCompleted: true);
        });
    }

    private static string EncodeTaskGetResult(NativeTaskRow task)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WriteString("id", task.Id);
            writer.WriteString("title", task.Subject);
            writer.WriteString("subject", task.Subject);
            writer.WriteString("status", task.Status);
            WriteNullableString(writer, "owner", task.Owner);
            WriteNullableString(writer, "activeForm", task.ActiveForm);
            WriteStringArray(writer, "blocks", task.Blocks);
            WriteStringArray(writer, "blockedBy", task.BlockedBy);
            if (!string.IsNullOrWhiteSpace(task.MetadataJson))
            {
                writer.WritePropertyName("metadata");
                writer.WriteRawValue(task.MetadataJson, skipInputValidation: true);
            }
        });
    }

    private static string EncodeTaskUpdateResult(
        NativeTaskRow task,
        List<NativeTaskRow> tasks,
        List<string> changedFields)
    {
        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("task_id", task.Id);
            writer.WritePropertyName("updated");
            writer.WriteStartObject();
            foreach (var field in changedFields.Distinct(StringComparer.Ordinal))
            {
                WriteUpdatedField(writer, field, task);
            }
            writer.WriteEndObject();
            writer.WritePropertyName("task");
            WriteTaskSnapshot(writer, task);
            WriteStandaloneSummary(writer, tasks, includeCompleted: true);
        });
    }

    private static string EncodeTaskListResult(List<NativeTaskRow> tasks)
    {
        return EncodeJsonObject(writer =>
        {
            var statusById = tasks.ToDictionary(static task => task.Id, static task => task.Status, StringComparer.Ordinal);
            writer.WriteString("mode", "standalone");
            writer.WriteNumber("total", tasks.Count);
            writer.WritePropertyName("tasks");
            writer.WriteStartArray();
            foreach (var task in tasks)
            {
                writer.WriteStartObject();
                writer.WriteString("id", task.Id);
                writer.WriteString("title", task.Subject);
                writer.WriteString("subject", task.Subject);
                writer.WriteString("status", task.Status);
                WriteNullableString(writer, "owner", task.Owner);
                WriteStringArray(
                    writer,
                    "blockedBy",
                    task.BlockedBy
                        .Where(id => !statusById.TryGetValue(id, out var status) || status != "completed")
                        .ToArray());
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        });
    }

    private static void WriteStandaloneSummary(
        Utf8JsonWriter writer,
        List<NativeTaskRow> tasks,
        bool includeCompleted)
    {
        writer.WriteNumber("total", tasks.Count);
        if (includeCompleted)
        {
            writer.WriteNumber("completed", tasks.Count(static task => task.Status == "completed"));
        }

        writer.WritePropertyName("tasks");
        writer.WriteStartArray();
        foreach (var task in tasks)
        {
            WriteTaskSnapshot(writer, task);
        }
        writer.WriteEndArray();
    }

    private static void WriteTaskSnapshot(Utf8JsonWriter writer, NativeTaskRow task)
    {
        writer.WriteStartObject();
        writer.WriteString("id", task.Id);
        writer.WriteString("title", task.Subject);
        writer.WriteString("subject", task.Subject);
        WriteNullableString(writer, "activeForm", task.ActiveForm);
        writer.WriteString("status", task.Status);
        WriteNullableString(writer, "owner", task.Owner);
        writer.WriteEndObject();
    }

    private static void WriteUpdatedField(Utf8JsonWriter writer, string field, NativeTaskRow task)
    {
        switch (field)
        {
            case "subject":
                writer.WriteString("subject", task.Subject);
                break;
            case "activeForm":
                WriteNullableString(writer, "activeForm", task.ActiveForm);
                break;
            case "status":
                writer.WriteString("status", task.Status);
                break;
            case "owner":
                WriteNullableString(writer, "owner", task.Owner);
                break;
            case "blocks":
                WriteStringArray(writer, "blocks", task.Blocks);
                break;
            case "blockedBy":
                WriteStringArray(writer, "blockedBy", task.BlockedBy);
                break;
            case "metadata":
                writer.WritePropertyName("metadata");
                if (string.IsNullOrWhiteSpace(task.MetadataJson))
                {
                    writer.WriteNullValue();
                }
                else
                {
                    writer.WriteRawValue(task.MetadataJson, skipInputValidation: true);
                }
                break;
        }
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null)
        {
            writer.WriteNull(name);
            return;
        }
        writer.WriteString(name, value);
    }

    private static void WriteStringArray(Utf8JsonWriter writer, string name, IReadOnlyList<string> values)
    {
        writer.WritePropertyName(name);
        writer.WriteStartArray();
        foreach (var value in values)
        {
            writer.WriteStringValue(value);
        }
        writer.WriteEndArray();
    }

    private static string ResolveTaskTitle(JsonElement input, string fallbackTitle = "")
    {
        var title = NormalizeTaskTitlePart(GetOptionalInputString(input, "title") ?? GetOptionalInputString(input, "subject"));
        var description = NormalizeTaskTitlePart(GetOptionalInputString(input, "description"));
        if (title.Length > 0)
        {
            return MergeTaskTitle(title, description);
        }
        return description.Length > 0 ? description : NormalizeTaskTitlePart(fallbackTitle);
    }

    private static string NormalizeTaskTitlePart(string? value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : Regex.Replace(value, "\\s+", " ").Trim();
    }

    private static string MergeTaskTitle(string title, string description)
    {
        if (title.Length == 0)
        {
            return description;
        }
        if (description.Length == 0 || title == description || title.Contains(description, StringComparison.Ordinal))
        {
            return title;
        }
        if (description.Contains(title, StringComparison.Ordinal))
        {
            return description;
        }

        var last = title[^1];
        return TitleTerminalPunctuation.Contains(last, StringComparison.Ordinal)
            ? $"{title} {description}"
            : $"{title}\uFF1A{description}";
    }

    private static bool HasAnyProperty(JsonElement input, params string[] names)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (var name in names)
        {
            if (input.TryGetProperty(name, out _))
            {
                return true;
            }
        }
        return false;
    }

    private static string? GetOptionalInputString(JsonElement input, string propertyName)
    {
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty(propertyName, out var value))
        {
            return null;
        }
        return value.ValueKind == JsonValueKind.Null ? null : value.ToString();
    }

    private static string GetTaskId(JsonElement input)
    {
        return (JsonHelpers.GetString(input, "taskId") ?? JsonHelpers.GetString(input, "task_id") ?? string.Empty).Trim();
    }

    private static string[] GetStringArray(JsonElement input, string propertyName)
    {
        if (input.ValueKind != JsonValueKind.Object || !input.TryGetProperty(propertyName, out var value))
        {
            return [];
        }
        if (value.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return value.EnumerateArray()
            .Select(static item => item.ValueKind == JsonValueKind.String ? item.GetString() : item.ToString())
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Select(static item => item!.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static string[] ParseStringArray(string rawJson)
    {
        try
        {
            using var document = JsonDocument.Parse(rawJson);
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                return [];
            }
            return document.RootElement.EnumerateArray()
                .Select(static item => item.ValueKind == JsonValueKind.String ? item.GetString() : item.ToString())
                .Where(static item => !string.IsNullOrWhiteSpace(item))
                .Select(static item => item!.Trim())
                .Distinct(StringComparer.Ordinal)
                .ToArray();
        }
        catch
        {
            return [];
        }
    }

    private static string SerializeStringArray(IReadOnlyList<string> values)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var value in values)
            {
                writer.WriteStringValue(value);
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string[] Union(IReadOnlyList<string> existing, IReadOnlyList<string> additions)
    {
        return existing.Concat(additions)
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static string[] RemoveTaskId(IReadOnlyList<string> existing, string taskId)
    {
        return existing
            .Where(value => value != taskId)
            .ToArray();
    }

    private static string? GetObjectRawJson(JsonElement input, string propertyName)
    {
        return input.ValueKind == JsonValueKind.Object &&
            input.TryGetProperty(propertyName, out var value) &&
            value.ValueKind == JsonValueKind.Object
                ? value.GetRawText()
                : null;
    }

    private static string? MergeMetadataJson(string? existingJson, JsonElement patch)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!string.IsNullOrWhiteSpace(existingJson))
        {
            try
            {
                using var existing = JsonDocument.Parse(existingJson);
                if (existing.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (var property in existing.RootElement.EnumerateObject())
                    {
                        values[property.Name] = property.Value.GetRawText();
                    }
                }
            }
            catch
            {
                values.Clear();
            }
        }

        foreach (var property in patch.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.Null)
            {
                values.Remove(property.Name);
            }
            else
            {
                values[property.Name] = property.Value.GetRawText();
            }
        }

        if (values.Count == 0)
        {
            return null;
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var item in values)
            {
                writer.WritePropertyName(item.Key);
                writer.WriteRawValue(item.Value, skipInputValidation: true);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static string NormalizeStatus(string status)
    {
        return status is "pending" or "in_progress" or "completed" ? status : "pending";
    }

    private static string CreateTaskId()
    {
        Span<char> chars = stackalloc char[8];
        for (var index = 0; index < chars.Length; index++)
        {
            chars[index] = IdAlphabet[RandomNumberGenerator.GetInt32(IdAlphabet.Length)];
        }
        return new string(chars);
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

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private const string TaskSelectSql = """
        SELECT id,
               session_id,
               plan_id,
               subject,
               description,
               active_form,
               status,
               owner,
               blocks,
               blocked_by,
               metadata,
               sort_order,
               created_at,
               updated_at
          FROM tasks
        """;

    private sealed class NativeTaskRow
    {
        public string Id { get; set; } = string.Empty;
        public string SessionId { get; set; } = string.Empty;
        public string? PlanId { get; set; }
        public string Subject { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
        public string? ActiveForm { get; set; }
        public string Status { get; set; } = "pending";
        public string? Owner { get; set; }
        public string[] Blocks { get; set; } = [];
        public string[] BlockedBy { get; set; } = [];
        public string? MetadataJson { get; set; }
        public int SortOrder { get; set; }
        public long CreatedAt { get; set; }
        public long UpdatedAt { get; set; }
    }
}
