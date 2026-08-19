using System.Buffers;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class AgentRuntimePlanExecutor
{
    private const string PlanDirectoryName = ".plan";
    private const string IdAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

    private static readonly HashSet<string> PlanToolNames = new(StringComparer.Ordinal)
    {
        "EnterPlanMode", "ExitPlanMode"
    };

    private static readonly ConcurrentDictionary<string, PlanRunState> RunStates = new(StringComparer.Ordinal);

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsPlanTool(string toolName)
    {
        return PlanToolNames.Contains(toolName);
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "EnterPlanMode" => await EnterPlanModeAsync(call.Input, parameters, runId, context, cancellationToken),
            "ExitPlanMode" => await ExitPlanModeAsync(call.Input, parameters, runId, context, cancellationToken),
            _ => EncodeError($"Native plan tool not registered: {call.Name}")
        };
    }

    public static void ClearRun(string runId)
    {
        RunStates.TryRemove(runId, out _);
    }

    public static bool IsPlanModeActiveForRun(string runId, JsonElement parameters)
    {
        return IsPlanModeActive(runId, parameters);
    }

    private static async Task<string> EnterPlanModeAsync(
        JsonElement input,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId(parameters);
        if (sessionId.Length == 0)
        {
            return EncodeError("No active session.");
        }

        PlanRow? existingPlan;
        using (var connection = DbConnectionFactory.OpenReadWrite(parameters))
        {
            existingPlan = LoadPlanBySession(connection, null, sessionId);
        }

        PlanRow plan;
        string status;
        if (existingPlan is { FilePath.Length: > 0 } && IsResumablePlanStatus(existingPlan.Status))
        {
            plan = existingPlan;
            status = "resumed";
            try
            {
                await EnsurePlanFileAsync(plan.FilePath!, parameters, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return AgentRuntimeToolError.Encode(ex);
            }

            // Reopening a finalized plan means it is about to be rewritten, so put it back into
            // drafting. Leaving it at awaiting_review would keep offering "implement this plan"
            // on content the agent is in the middle of replacing.
            if (!IsDraftPlanStatus(plan.Status))
            {
                plan.Status = "drafting";
                plan.UpdatedAt = Now();
                ResetPlanToDrafting(parameters, plan.Id, plan.UpdatedAt);
            }
        }
        else
        {
            // A row without a plan file is repairable: give it a file instead of rejecting the
            // whole session, which used to leave the agent with no way to reach plan review.
            var repairTarget = existingPlan is not null && string.IsNullOrWhiteSpace(existingPlan.FilePath)
                ? existingPlan
                : null;
            var provisioned = await ProvisionPlanAsync(
                sessionId,
                repairTarget,
                JsonHelpers.GetString(input, "reason"),
                parameters,
                cancellationToken);
            if (provisioned.Error is not null)
            {
                return provisioned.Error;
            }

            plan = provisioned.Plan!;
            status = "entered";
        }

        RunStates[runId] = new PlanRunState(true, plan.FilePath);
        await NotifyPlanUiAsync("enter", plan, null, parameters, context, cancellationToken);

        return EncodeJsonObject(writer =>
        {
            writer.WriteString("status", status);
            writer.WriteString("plan_id", plan.Id);
            writer.WriteString("plan_file_path", plan.FilePath);
            writer.WriteString(
                "message",
                status == "resumed"
                    ? "Resumed existing plan draft. Update the current plan file with Write/Edit, then call ExitPlanMode."
                    : "Plan mode activated. Write the plan into the current plan file with Write/Edit, then call ExitPlanMode.");
        });
    }

    private static async Task<string> ExitPlanModeAsync(
        JsonElement input,
        JsonElement parameters,
        string runId,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var sessionId = GetSessionId(parameters);
        if (sessionId.Length == 0)
        {
            return EncodeError("No active session.");
        }

        var suppliedContent = JsonHelpers.GetString(input, "plan")?.Trim() ?? string.Empty;

        PlanRow? plan;
        using (var connection = DbConnectionFactory.OpenReadWrite(parameters))
        {
            plan = LoadPlanBySession(connection, null, sessionId);
        }

        var isPlanMode = IsPlanModeActive(runId, parameters);
        var canFinalizeExistingDraft = plan?.FilePath is { Length: > 0 } && IsDraftPlanStatus(plan.Status);
        if (!isPlanMode && !canFinalizeExistingDraft)
        {
            if (plan?.Status == "awaiting_review" && !string.IsNullOrWhiteSpace(plan.FilePath))
            {
                return EncodeJsonObject(writer =>
                {
                    writer.WriteString("status", "awaiting_review");
                    writer.WriteBoolean("awaiting_user_review", true);
                    writer.WriteString("plan_id", plan.Id);
                    writer.WriteString("plan_file_path", plan.FilePath);
                    writer.WriteString("title", plan.Title);
                    writer.WriteString("message", "Plan is already finalized and awaiting user review.");
                });
            }

            return EncodeJsonObject(writer =>
            {
                writer.WriteString("status", "not_in_plan_mode");
                writer.WriteString("message", "You are not currently in plan mode.");
            });
        }

        PlanRow activePlan;
        if (plan?.FilePath is { Length: > 0 })
        {
            activePlan = plan;
        }
        else
        {
            // Plan mode toggled from the UI never runs EnterPlanMode, so the agent was never
            // handed a plan file. Provision one here so the review handoff still completes.
            var provisioned = await ProvisionPlanAsync(
                sessionId,
                plan,
                suppliedContent.Length > 0 ? InferTitleFromContent(suppliedContent) : null,
                parameters,
                cancellationToken);
            if (provisioned.Error is not null)
            {
                return provisioned.Error;
            }

            activePlan = provisioned.Plan!;
            RunStates[runId] = new PlanRunState(true, activePlan.FilePath);
            await NotifyPlanUiAsync("enter", activePlan, null, parameters, context, cancellationToken);
        }

        var planFilePath = activePlan.FilePath!;
        if (suppliedContent.Length > 0)
        {
            try
            {
                await WritePlanFileAsync(planFilePath, suppliedContent, parameters, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return EncodeError($"Failed to write the plan file '{planFilePath}': {ex.Message}");
            }
        }

        string content;
        try
        {
            content = await ReadPlanFileAsync(planFilePath, parameters, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return EncodeError($"Failed to read the current plan file before exiting plan mode: {ex.Message}");
        }

        if (string.IsNullOrWhiteSpace(content))
        {
            return EncodeError(
                $"Plan file '{planFilePath}' is empty. Write the plan into that file with Write/Edit, " +
                "or pass the full plan markdown as the `plan` argument, then call ExitPlanMode again.");
        }

        var title = InferTitleFromContent(content);
        var now = Now();
        var planId = activePlan.Id;
        activePlan.Title = title;
        activePlan.Status = "awaiting_review";
        activePlan.UpdatedAt = now;
        UpdatePlanForReview(parameters, planId, title, now);
        RunStates[runId] = new PlanRunState(false, planFilePath);
        await NotifyPlanUiAsync("exit", activePlan, content, parameters, context, cancellationToken);

        return EncodeJsonObject(writer =>
        {
            writer.WriteString("status", "awaiting_review");
            writer.WriteBoolean("awaiting_user_review", true);
            writer.WriteString("plan_id", planId);
            writer.WriteString("plan_file_path", planFilePath);
            writer.WriteString("title", title);
            writer.WriteString("content", content);
            writer.WriteString("message", "Plan finalized and ready for user review. Wait for approval before implementing.");
        });
    }

    private static bool IsPlanModeActive(string runId, JsonElement parameters)
    {
        if (RunStates.TryGetValue(runId, out var state) && state.Active)
        {
            return true;
        }

        return JsonHelpers.GetBool(parameters, "planMode", false);
    }

    private static async Task NotifyPlanUiAsync(
        string action,
        PlanRow plan,
        string? content,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        try
        {
            var request = CreateJsonElement(writer =>
            {
                writer.WriteString("action", action);
                writer.WriteString("sessionId", plan.SessionId);
                writer.WritePropertyName("plan");
                WritePlanSnapshot(writer, plan, content);
                WriteNullableString(writer, "activeSessionId", JsonHelpers.GetString(parameters, "sessionId"));
            });

            await AgentRuntimeReverseRequests.RequestAsync(
                context,
                "plan/ui-update",
                request,
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            WorkerLog.Warn($"plan ui update failed action={action} planId={plan.Id} error={ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// Guarantees the session has a plan row backed by a real plan file. Repairs a row that lost
    /// its file path instead of creating a duplicate, so a session never ends up with a plan the
    /// agent cannot finalize.
    /// </summary>
    private static async Task<PlanProvisionResult> ProvisionPlanAsync(
        string sessionId,
        PlanRow? repairTarget,
        string? titleHint,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim() ?? string.Empty;
        if (workingFolder.Length == 0)
        {
            return new PlanProvisionResult(
                null,
                EncodeError(
                    "Plan mode requires an active working folder. Set a working folder for this session, " +
                    "or present the plan directly in your reply instead of using the plan tools."));
        }

        PlanRow plan;
        var created = false;
        if (repairTarget is not null)
        {
            plan = repairTarget;
            plan.FilePath = GetPlanFilePath(workingFolder, plan.Id);
            plan.UpdatedAt = Now();
            UpdatePlanFilePath(parameters, plan.Id, plan.FilePath, plan.UpdatedAt);
        }
        else
        {
            var title = titleHint?.Trim();
            if (string.IsNullOrEmpty(title))
            {
                title = "Implementation planning";
            }

            var now = Now();
            plan = new PlanRow
            {
                Id = CreatePlanId(),
                SessionId = sessionId,
                Title = title,
                Status = "drafting",
                FilePath = null,
                Content = null,
                SpecJson = null,
                CreatedAt = now,
                UpdatedAt = now
            };
            plan.FilePath = GetPlanFilePath(workingFolder, plan.Id);
            InsertPlanRow(parameters, plan);
            created = true;
        }

        try
        {
            await EnsurePlanFileAsync(plan.FilePath!, parameters, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (created)
            {
                DeletePlan(parameters, plan.Id);
            }
            return new PlanProvisionResult(null, AgentRuntimeToolError.Encode(ex));
        }

        return new PlanProvisionResult(plan, null);
    }

    private static async Task EnsurePlanFileAsync(
        string planFilePath,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var workingFolder = JsonHelpers.GetString(parameters, "workingFolder")?.Trim() ?? string.Empty;
        var planDirectory = JoinPath(workingFolder, PlanDirectoryName);
        if (AgentRuntimeSshToolExecutor.ShouldRoute(parameters))
        {
            var command =
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(planDirectory)} && " +
                $"([ -e {SshOpenSsh.ShellPathExpr(planFilePath)} ] || : > {SshOpenSsh.ShellPathExpr(planFilePath)})";
            var result = await SshOpenSsh.ExecuteAsync(parameters, command, 60_000);
            cancellationToken.ThrowIfCancellationRequested();
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException($"Failed to initialize plan file: {result.Stderr}");
            }
            return;
        }

        Directory.CreateDirectory(planDirectory);
        if (!File.Exists(planFilePath))
        {
            await File.WriteAllTextAsync(planFilePath, string.Empty, cancellationToken);
        }
    }

    private static async Task WritePlanFileAsync(
        string planFilePath,
        string content,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var normalized = content.EndsWith('\n') ? content : content + "\n";
        if (AgentRuntimeSshToolExecutor.ShouldRoute(parameters))
        {
            var command =
                $"mkdir -p -- {SshOpenSsh.ShellPathExpr(PosixDirname(planFilePath))} && " +
                $"cat > {SshOpenSsh.ShellPathExpr(planFilePath)}";
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                command,
                60_000,
                Encoding.UTF8.GetBytes(normalized));
            cancellationToken.ThrowIfCancellationRequested();
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    result.Stderr.Length > 0 ? result.Stderr : $"Remote plan file write failed: {planFilePath}");
            }
            return;
        }

        var directory = Path.GetDirectoryName(planFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
        await File.WriteAllTextAsync(planFilePath, normalized, cancellationToken);
    }

    private static string PosixDirname(string path)
    {
        var index = path.LastIndexOf('/');
        return index <= 0 ? "/" : path[..index];
    }

    private static async Task<string> ReadPlanFileAsync(
        string planFilePath,
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        if (AgentRuntimeSshToolExecutor.ShouldRoute(parameters))
        {
            var result = await SshOpenSsh.ExecuteAsync(
                parameters,
                $"cat -- {SshOpenSsh.ShellPathExpr(planFilePath)}",
                60_000,
                maxStdoutChars: 4 * 1024 * 1024);
            cancellationToken.ThrowIfCancellationRequested();
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(result.Stderr);
            }
            return result.Stdout;
        }

        return await File.ReadAllTextAsync(planFilePath, cancellationToken);
    }

    private static PlanRow? LoadPlanBySession(SqliteConnection connection, SqliteTransaction? transaction, string sessionId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT id, session_id, title, status, file_path, content, spec_json, created_at, updated_at
              FROM plans
             WHERE session_id = $sessionId
             ORDER BY updated_at DESC
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadPlan(reader) : null;
    }

    private static PlanRow ReadPlan(SqliteDataReader reader)
    {
        return new PlanRow
        {
            Id = reader.GetString(0),
            SessionId = reader.GetString(1),
            Title = reader.GetString(2),
            Status = reader.GetString(3),
            FilePath = reader.IsDBNull(4) ? null : reader.GetString(4),
            Content = reader.IsDBNull(5) ? null : reader.GetString(5),
            SpecJson = reader.IsDBNull(6) ? null : reader.GetString(6),
            CreatedAt = reader.GetInt64(7),
            UpdatedAt = reader.GetInt64(8)
        };
    }

    private static void InsertPlan(SqliteConnection connection, SqliteTransaction transaction, PlanRow plan)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO plans (id, session_id, title, status, file_path, content, spec_json, created_at, updated_at)
            VALUES ($id, $sessionId, $title, $status, $filePath, $content, $specJson, $createdAt, $updatedAt)
            """;
        command.Parameters.AddWithValue("$id", plan.Id);
        command.Parameters.AddWithValue("$sessionId", plan.SessionId);
        command.Parameters.AddWithValue("$title", plan.Title);
        command.Parameters.AddWithValue("$status", plan.Status);
        command.Parameters.AddWithValue("$filePath", plan.FilePath ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$content", plan.Content ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$specJson", plan.SpecJson ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("$createdAt", plan.CreatedAt);
        command.Parameters.AddWithValue("$updatedAt", plan.UpdatedAt);
        command.ExecuteNonQuery();
    }

    private static void InsertPlanRow(JsonElement parameters, PlanRow plan)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        InsertPlan(connection, transaction, plan);
        transaction.Commit();
    }

    private static void UpdatePlanFilePath(
        JsonElement parameters,
        string planId,
        string filePath,
        long updatedAt)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE plans
               SET file_path = $filePath,
                   updated_at = $updatedAt
             WHERE id = $id
            """;
        command.Parameters.AddWithValue("$filePath", filePath);
        command.Parameters.AddWithValue("$updatedAt", updatedAt);
        command.Parameters.AddWithValue("$id", planId);
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    private static void ResetPlanToDrafting(JsonElement parameters, string planId, long updatedAt)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE plans
               SET status = 'drafting',
                   updated_at = $updatedAt
             WHERE id = $id
            """;
        command.Parameters.AddWithValue("$updatedAt", updatedAt);
        command.Parameters.AddWithValue("$id", planId);
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    private static void UpdatePlanForReview(JsonElement parameters, string planId, string title, long updatedAt)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            UPDATE plans
               SET title = $title,
                   status = 'awaiting_review',
                   updated_at = $updatedAt
             WHERE id = $id
            """;
        command.Parameters.AddWithValue("$title", title);
        command.Parameters.AddWithValue("$updatedAt", updatedAt);
        command.Parameters.AddWithValue("$id", planId);
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    private static void DeletePlan(JsonElement parameters, string planId)
    {
        using var connection = DbConnectionFactory.OpenReadWrite(parameters);
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "DELETE FROM plans WHERE id = $id";
        command.Parameters.AddWithValue("$id", planId);
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    private static string GetPlanFilePath(string workingFolder, string planId)
    {
        return JoinPath(JoinPath(workingFolder, PlanDirectoryName), $"{planId}.md");
    }

    private static string JoinPath(string left, string right)
    {
        if (left.Contains('\\', StringComparison.Ordinal))
        {
            return Path.Combine(left, right);
        }

        return left.TrimEnd('/') + "/" + right.TrimStart('/');
    }

    private static bool IsDraftPlanStatus(string status)
    {
        return status is "drafting" or "rejected";
    }

    /// <summary>
    /// Statuses whose plan file EnterPlanMode reopens instead of starting a second plan for the
    /// session. A plan still waiting for review — or approved but not yet started — remains the
    /// session's current plan, so re-entering plan mode means the agent is reworking it. That is
    /// exactly what happens when a run dies after ExitPlanMode (rate limit, network fault) and the
    /// user resumes the turn: forking a fresh row there left the session with two plan files and a
    /// review card pointing at the abandoned one.
    /// </summary>
    private static bool IsResumablePlanStatus(string status)
    {
        return IsDraftPlanStatus(status) || status is "awaiting_review" or "approved";
    }

    private static string InferTitleFromContent(string content)
    {
        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var title = System.Text.RegularExpressions.Regex
                .Replace(line, "^#+\\s*", string.Empty)
                .Trim();
            title = System.Text.RegularExpressions.Regex
                .Replace(title, "^plan:\\s*", string.Empty, System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                .Trim();
            return title.Length > 80 ? title[..80] : title.Length > 0 ? title : "Plan";
        }

        return "Plan";
    }

    private static string GetSessionId(JsonElement parameters)
    {
        return JsonHelpers.GetString(parameters, "sessionId")?.Trim() ?? string.Empty;
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static string CreatePlanId()
    {
        Span<byte> bytes = stackalloc byte[12];
        RandomNumberGenerator.Fill(bytes);
        Span<char> chars = stackalloc char[12];
        for (var i = 0; i < bytes.Length; i++)
        {
            chars[i] = IdAlphabet[bytes[i] % IdAlphabet.Length];
        }
        return new string(chars);
    }

    private static JsonElement CreateJsonElement(Action<Utf8JsonWriter> writeProperties)
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

    private static string EncodeError(string message)
    {
        return AgentRuntimeToolError.Encode(message);
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

    private static void WritePlanSnapshot(Utf8JsonWriter writer, PlanRow plan, string? content)
    {
        writer.WriteStartObject();
        writer.WriteString("id", plan.Id);
        writer.WriteString("sessionId", plan.SessionId);
        writer.WriteString("title", plan.Title);
        writer.WriteString("status", plan.Status);
        WriteNullableString(writer, "filePath", plan.FilePath);
        WriteNullableString(writer, "content", content ?? plan.Content);
        WriteNullableString(writer, "specJson", plan.SpecJson);
        writer.WriteNumber("createdAt", plan.CreatedAt);
        writer.WriteNumber("updatedAt", plan.UpdatedAt);
        writer.WriteEndObject();
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (!string.IsNullOrEmpty(value))
        {
            writer.WriteString(name, value);
        }
    }

    private sealed record PlanRunState(bool Active, string? PlanFilePath);

    private readonly record struct PlanProvisionResult(PlanRow? Plan, string? Error);
}
