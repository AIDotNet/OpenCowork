using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class AgentRuntimeCronExecutor
{
    private static readonly HashSet<string> CronToolNames = new(StringComparer.Ordinal)
    {
        "CronAdd",
        "CronCreate",
        "CronUpdate",
        "CronRemove",
        "CronDelete",
        "CronList"
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static bool IsCronTool(string toolName)
    {
        return CronToolNames.Contains(toolName);
    }

    public static bool RequiresApproval(string toolName)
    {
        return toolName is "CronAdd" or "CronCreate" or "CronUpdate";
    }

    public static async Task<string> ExecuteAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        return call.Name switch
        {
            "CronAdd" or "CronCreate" => await ExecuteAddAsync(call, parameters, context, cancellationToken),
            "CronUpdate" => await ExecuteUpdateAsync(call, parameters, context, cancellationToken),
            "CronRemove" or "CronDelete" => await ExecuteDeleteAsync(call, context, cancellationToken),
            "CronList" => await ExecuteListAsync(context, cancellationToken),
            _ => EncodeError($"Unsupported cron tool: {call.Name}")
        };
    }

    private static async Task<string> ExecuteAddAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var name = JsonHelpers.GetString(call.Input, "name")?.Trim() ?? string.Empty;
        var prompt = JsonHelpers.GetString(call.Input, "prompt")?.Trim() ?? string.Empty;
        if (name.Length == 0)
        {
            return EncodeError("name is required");
        }
        if (prompt.Length == 0)
        {
            return EncodeError("prompt is required");
        }

        if (!call.Input.TryGetProperty("schedule", out var schedule) ||
            schedule.ValueKind != JsonValueKind.Object)
        {
            return EncodeError("schedule.kind is required");
        }

        if (!TryReadSchedule(schedule, out var scheduleValues, out var scheduleError))
        {
            return EncodeError(scheduleError ?? "schedule is invalid");
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var job = new CronJobRow
        {
            Id = NewJobId(),
            Name = name,
            SessionId = JsonHelpers.GetString(parameters, "sessionId"),
            ScheduleKind = scheduleValues.Kind,
            ScheduleAt = scheduleValues.At,
            ScheduleEvery = scheduleValues.Every,
            ScheduleExpr = scheduleValues.Expr,
            ScheduleTz = scheduleValues.Tz,
            Prompt = prompt,
            AgentId = ReadOptionalString(call.Input, "agentId"),
            Model = ReadOptionalString(call.Input, "model"),
            WorkingFolder = ReadOptionalString(call.Input, "workingFolder") ??
                JsonHelpers.GetString(parameters, "workingFolder"),
            SshConnectionId = JsonHelpers.GetString(parameters, "sshConnectionId"),
            SourceSessionTitle = ReadOptionalString(call.Input, "sourceSessionTitle"),
            SourceProjectId = ReadOptionalString(call.Input, "sourceProjectId"),
            SourceProjectName = ReadOptionalString(call.Input, "sourceProjectName"),
            SourceProviderId = ReadOptionalString(call.Input, "sourceProviderId") ??
                ReadProviderId(parameters),
            DeliveryMode = NormalizeDeliveryMode(ReadOptionalString(call.Input, "deliveryMode")),
            DeliveryTarget = ReadOptionalString(call.Input, "deliveryTarget") ??
                JsonHelpers.GetString(parameters, "sessionId"),
            PluginId = ReadOptionalString(call.Input, "pluginId") ??
                JsonHelpers.GetString(parameters, "pluginId"),
            PluginChatId = ReadOptionalString(call.Input, "pluginChatId") ??
                JsonHelpers.GetString(parameters, "pluginChatId"),
            Enabled = 1,
            DeleteAfterRun = (ReadOptionalBool(call.Input, "deleteAfterRun") ?? (scheduleValues.Kind == "at")) ? 1 : 0,
            MaxIterations = ReadOptionalInt(call.Input, "maxIterations") ?? 15,
            DeletedAt = null,
            LastFiredAt = null,
            FireCount = 0,
            CreatedAt = now,
            UpdatedAt = now
        };

        var mutation = DbCronTools.CreateJobRecord(job);
        if (!mutation.Success)
        {
            return EncodeError($"DB error: {mutation.Error ?? "failed to create cron job"}");
        }

        var scheduled = await ScheduleJobAsync(context, job, cancellationToken);
        if (!scheduled.Success)
        {
            DbCronTools.DeleteJobRecord(job.Id);
            return EncodeError(scheduled.Error ?? $"Failed to schedule job (kind={job.ScheduleKind})");
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("jobId", job.Id);
            writer.WriteString("name", name);
            writer.WriteString("scheduleKind", scheduleValues.Kind);
            writer.WriteString("message", $"Job \"{name}\" created (id={job.Id}, kind={scheduleValues.Kind}).");
        });
    }

    private static async Task<string> ExecuteUpdateAsync(
        NativeToolCallView call,
        JsonElement parameters,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var jobId = JsonHelpers.GetString(call.Input, "jobId")?.Trim() ?? string.Empty;
        if (jobId.Length == 0)
        {
            return EncodeError("jobId is required");
        }
        if (!call.Input.TryGetProperty("patch", out var patch) ||
            patch.ValueKind != JsonValueKind.Object ||
            !patch.EnumerateObject().Any())
        {
            return EncodeError("patch is required");
        }

        var found = DbCronTools.FindJobRecord(jobId);
        if (!found.Success)
        {
            return EncodeError($"DB error: {found.Error ?? "failed to load cron job"}");
        }
        if (found.Job is not { } job)
        {
            return EncodeError($"Job \"{jobId}\" not found");
        }

        if (!ApplyPatch(job, patch, parameters, out var patchError))
        {
            return EncodeError(patchError ?? "patch is invalid");
        }
        job.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var mutation = DbCronTools.UpdateJobRecord(job);
        if (!mutation.Success)
        {
            return EncodeError($"DB error: {mutation.Error ?? "failed to update cron job"}");
        }

        var cancel = await CancelJobAsync(context, job.Id, cancellationToken);
        if (!cancel.Success)
        {
            return EncodeError(cancel.Error ?? $"Failed to cancel existing schedule for {job.Id}");
        }

        if (job.Enabled != 0 && job.DeletedAt is null)
        {
            var scheduled = await ScheduleJobAsync(context, job, cancellationToken);
            if (!scheduled.Success)
            {
                return EncodeError(scheduled.Error ?? $"Failed to schedule job (kind={job.ScheduleKind})");
            }
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("jobId", jobId);
            writer.WriteString("message", $"Job {jobId} updated.");
        });
    }

    private static async Task<string> ExecuteDeleteAsync(
        NativeToolCallView call,
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var jobId = (JsonHelpers.GetString(call.Input, "jobId") ??
                JsonHelpers.GetString(call.Input, "id") ??
                string.Empty)
            .Trim();
        if (jobId.Length == 0)
        {
            return EncodeError("jobId is required");
        }

        var found = DbCronTools.FindJobRecord(jobId);
        if (!found.Success)
        {
            return EncodeError($"DB error: {found.Error ?? "failed to load cron job"}");
        }
        if (found.Job is null)
        {
            return EncodeError($"Job \"{jobId}\" not found");
        }

        var cancel = await CancelJobAsync(context, jobId, cancellationToken);
        if (!cancel.Success)
        {
            return EncodeError(cancel.Error ?? $"Failed to cancel schedule for {jobId}");
        }

        var mutation = DbCronTools.DeleteJobRecord(jobId);
        if (!mutation.Success)
        {
            return EncodeError($"DB error: {mutation.Error ?? "failed to delete cron job"}");
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteBoolean("success", true);
            writer.WriteString("jobId", jobId);
            writer.WriteString("message", $"Job {jobId} removed.");
        });
    }

    private static async Task<string> ExecuteListAsync(
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        var list = DbCronTools.ListJobRecords();
        if (!list.Success)
        {
            return EncodeError($"DB error: {list.Error ?? "failed to list cron jobs"}");
        }

        var runtimeState = await ReadRuntimeStateAsync(context, cancellationToken);
        if (!runtimeState.Success)
        {
            return EncodeError(runtimeState.Error ?? "Failed to read cron runtime state");
        }

        if (list.Jobs.Count == 0)
        {
            return EncodeJsonObject(writer =>
            {
                writer.WriteNumber("total", 0);
                writer.WritePropertyName("jobs");
                writer.WriteStartArray();
                writer.WriteEndArray();
                writer.WriteString("message", "No cron jobs scheduled.");
            });
        }

        return EncodeJsonObject(writer =>
        {
            writer.WriteNumber("total", list.Jobs.Count);
            writer.WritePropertyName("jobs");
            writer.WriteStartArray();
            foreach (var job in list.Jobs)
            {
                WriteJobForPrompt(writer, job, runtimeState);
            }
            writer.WriteEndArray();
        });
    }

    private static bool ApplyPatch(
        CronJobRow job,
        JsonElement patch,
        JsonElement parameters,
        out string? error)
    {
        error = null;

        ApplyStringPatch(patch, "name", value => job.Name = value ?? string.Empty);
        ApplyStringPatch(patch, "prompt", value => job.Prompt = value ?? string.Empty);
        ApplyStringPatch(patch, "agentId", value => job.AgentId = value);
        ApplyStringPatch(patch, "model", value => job.Model = value);
        ApplyStringPatch(patch, "workingFolder", value => job.WorkingFolder = value);
        ApplyStringPatch(patch, "sshConnectionId", value => job.SshConnectionId = value);
        ApplyStringPatch(patch, "deliveryMode", value => job.DeliveryMode = NormalizeDeliveryMode(value));
        ApplyStringPatch(patch, "deliveryTarget", value => job.DeliveryTarget = value);
        ApplyStringPatch(patch, "sessionId", value => job.SessionId = value);
        ApplyStringPatch(patch, "sourceSessionTitle", value => job.SourceSessionTitle = value);
        ApplyStringPatch(patch, "sourceProjectId", value => job.SourceProjectId = value);
        ApplyStringPatch(patch, "sourceProjectName", value => job.SourceProjectName = value);
        ApplyStringPatch(patch, "sourceProviderId", value => job.SourceProviderId = value);

        if (patch.TryGetProperty("enabled", out var enabled) &&
            enabled.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            job.Enabled = enabled.GetBoolean() ? 1 : 0;
        }
        if (patch.TryGetProperty("deleteAfterRun", out var deleteAfterRun) &&
            deleteAfterRun.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            job.DeleteAfterRun = deleteAfterRun.GetBoolean() ? 1 : 0;
        }
        if (ReadOptionalInt(patch, "maxIterations") is { } maxIterations)
        {
            job.MaxIterations = maxIterations;
        }

        if (patch.TryGetProperty("workingFolder", out _) &&
            !patch.TryGetProperty("sshConnectionId", out _) &&
            JsonHelpers.GetString(parameters, "sshConnectionId") is { Length: > 0 } sshConnectionId)
        {
            job.SshConnectionId = sshConnectionId;
        }

        if (patch.TryGetProperty("schedule", out var schedule))
        {
            if (schedule.ValueKind != JsonValueKind.Object)
            {
                error = "schedule must be an object";
                return false;
            }
            if (!TryReadSchedule(schedule, out var scheduleValues, out error))
            {
                return false;
            }

            job.ScheduleKind = scheduleValues.Kind;
            job.ScheduleAt = scheduleValues.At;
            job.ScheduleEvery = scheduleValues.Every;
            job.ScheduleExpr = scheduleValues.Expr;
            job.ScheduleTz = scheduleValues.Kind == "cron" ? scheduleValues.Tz : "UTC";
        }

        return true;
    }

    private static async Task<CronBridgeResult> ScheduleJobAsync(
        WorkerRequestContext context,
        CronJobRow job,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await RequestMainAsync(
                context,
                "cron/schedule-job",
                writer =>
                {
                    writer.WritePropertyName("job");
                    JsonSerializer.Serialize(writer, job, WorkerJsonContext.Default.CronJobRow);
                },
                cancellationToken);

            if (TryReadError(response, out var error))
            {
                return CronBridgeResult.Failed(error);
            }
            return JsonHelpers.GetBool(response, "success", false) &&
                JsonHelpers.GetBool(response, "scheduled", false)
                ? CronBridgeResult.Ok()
                : CronBridgeResult.Failed($"Failed to schedule job (kind={job.ScheduleKind})");
        }
        catch (Exception ex)
        {
            return CronBridgeResult.Failed(ex.Message);
        }
    }

    private static async Task<CronBridgeResult> CancelJobAsync(
        WorkerRequestContext context,
        string jobId,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await RequestMainAsync(
                context,
                "cron/cancel-job",
                writer => writer.WriteString("jobId", jobId),
                cancellationToken);

            if (TryReadError(response, out var error))
            {
                return CronBridgeResult.Failed(error);
            }
            return JsonHelpers.GetBool(response, "success", false)
                ? CronBridgeResult.Ok()
                : CronBridgeResult.Failed($"Failed to cancel job {jobId}");
        }
        catch (Exception ex)
        {
            return CronBridgeResult.Failed(ex.Message);
        }
    }

    private static async Task<CronRuntimeState> ReadRuntimeStateAsync(
        WorkerRequestContext context,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await RequestMainAsync(
                context,
                "cron/runtime-state",
                _ => { },
                cancellationToken);

            if (TryReadError(response, out var error))
            {
                return CronRuntimeState.Failed(error);
            }

            return CronRuntimeState.FromJson(response);
        }
        catch (Exception ex)
        {
            return CronRuntimeState.Failed(ex.Message);
        }
    }

    private static async Task<JsonElement> RequestMainAsync(
        WorkerRequestContext context,
        string method,
        Action<Utf8JsonWriter> writeProperties,
        CancellationToken cancellationToken)
    {
        return await AgentRuntimeReverseRequests.RequestAsync(
            context,
            method,
            CreateJsonObject(writeProperties),
            cancellationToken);
    }

    private static bool TryReadSchedule(
        JsonElement schedule,
        out CronScheduleValues values,
        out string? error)
    {
        values = default;
        error = null;

        var kind = JsonHelpers.GetString(schedule, "kind")?.Trim();
        if (string.IsNullOrEmpty(kind))
        {
            error = "schedule.kind is required (at | every | cron)";
            return false;
        }

        if (kind == "at")
        {
            if (!schedule.TryGetProperty("at", out var at) ||
                !TryResolveAtTimestamp(at, out var timestamp, out error))
            {
                return false;
            }

            values = new CronScheduleValues("at", timestamp, null, null, ReadScheduleTimeZone(schedule));
            return true;
        }

        if (kind == "every")
        {
            if (!schedule.TryGetProperty("every", out var everyElement) ||
                TryReadLong(everyElement) is not { } every ||
                every < 1000)
            {
                error = "schedule.every must be >= 1000 ms";
                return false;
            }

            values = new CronScheduleValues("every", null, every, null, ReadScheduleTimeZone(schedule));
            return true;
        }

        if (kind == "cron")
        {
            var expr = JsonHelpers.GetString(schedule, "expr")?.Trim();
            if (string.IsNullOrEmpty(expr))
            {
                error = "schedule.expr is required for kind=cron";
                return false;
            }

            var parts = Regex.Split(expr, "\\s+").Where(part => part.Length > 0).ToArray();
            if (parts.Length < 5 || parts.Length > 6)
            {
                error = "schedule.expr must have 5 or 6 fields";
                return false;
            }

            var timeZone = ReadScheduleTimeZone(schedule);
            if (!ValidateTimeZone(timeZone, out error))
            {
                return false;
            }

            values = new CronScheduleValues("cron", null, null, expr, timeZone);
            return true;
        }

        error = $"Unknown schedule.kind: \"{kind}\"";
        return false;
    }

    private static bool TryResolveAtTimestamp(
        JsonElement value,
        out long timestamp,
        out string? error)
    {
        timestamp = 0;
        error = null;

        if (TryReadLong(value) is { } numericTimestamp)
        {
            timestamp = numericTimestamp;
            return ValidateFutureTimestamp(timestamp, numericTimestamp.ToString(CultureInfo.InvariantCulture), out error);
        }

        if (value.ValueKind != JsonValueKind.String)
        {
            error = "schedule.at must be a valid timestamp (ms), ISO 8601 string, or relative offset";
            return false;
        }

        var trimmed = value.GetString()?.Trim() ?? string.Empty;
        if (long.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedNumber))
        {
            timestamp = parsedNumber;
            return ValidateFutureTimestamp(timestamp, trimmed, out error);
        }

        var relative = RelativeAtRegex().Match(trimmed);
        if (relative.Success)
        {
            var amount = long.Parse(relative.Groups[1].Value, CultureInfo.InvariantCulture);
            var unit = relative.Groups[2].Value.ToLowerInvariant();
            var multiplier = unit switch
            {
                "s" or "sec" => 1_000,
                "m" or "min" => 60_000,
                "h" or "hr" => 3_600_000,
                "d" or "day" => 86_400_000,
                _ => 60_000
            };
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + amount * multiplier;
            return true;
        }

        if (DateTimeOffset.TryParse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var parsed))
        {
            timestamp = parsed.ToUnixTimeMilliseconds();
            return ValidateFutureTimestamp(timestamp, trimmed, out error);
        }

        error = $"Invalid schedule.at value: \"{trimmed}\". Use relative offset format: \"+1m\", \"+10m\", \"+2h\", \"+1d\".";
        return false;
    }

    private static bool ValidateFutureTimestamp(long timestamp, string original, out string? error)
    {
        error = null;
        if (timestamp < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 30_000)
        {
            error =
                $"The timestamp \"{original}\" is in the past. Use relative offset format instead: \"+1m\", \"+10m\", \"+1h\", \"+1d\".";
            return false;
        }
        return true;
    }

    private static bool ValidateTimeZone(string timeZone, out string? error)
    {
        error = null;
        try
        {
            TimeZoneInfo.FindSystemTimeZoneById(timeZone);
            return true;
        }
        catch (Exception)
        {
            error = $"schedule.tz is not a valid timezone: \"{timeZone}\"";
            return false;
        }
    }

    private static string ReadScheduleTimeZone(JsonElement schedule)
    {
        return JsonHelpers.GetString(schedule, "tz")?.Trim() is { Length: > 0 } timeZone
            ? timeZone
            : "UTC";
    }

    private static string? ReadProviderId(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("provider", out var provider) &&
            provider.ValueKind == JsonValueKind.Object
            ? JsonHelpers.GetString(provider, "providerId")
            : null;
    }

    private static string? ReadOptionalString(JsonElement source, string name)
    {
        return JsonHelpers.GetString(source, name) is { } value && !string.IsNullOrWhiteSpace(value)
            ? value
            : null;
    }

    private static bool? ReadOptionalBool(JsonElement source, string name)
    {
        if (source.ValueKind != JsonValueKind.Object ||
            !source.TryGetProperty(name, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static int? ReadOptionalInt(JsonElement source, string name)
    {
        if (source.ValueKind != JsonValueKind.Object ||
            !source.TryGetProperty(name, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt32(out var number) => number,
            JsonValueKind.String when int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) => number,
            _ => null
        };
    }

    private static long? TryReadLong(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt64(out var number) => number,
            JsonValueKind.String when long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) => number,
            _ => null
        };
    }

    private static void ApplyStringPatch(
        JsonElement patch,
        string name,
        Action<string?> apply)
    {
        if (patch.ValueKind != JsonValueKind.Object ||
            !patch.TryGetProperty(name, out var value))
        {
            return;
        }

        apply(value.ValueKind == JsonValueKind.String ? value.GetString() : null);
    }

    private static string NormalizeDeliveryMode(string? value)
    {
        return value is "session" or "none" ? value : "desktop";
    }

    private static string NewJobId()
    {
        return $"cron-{Guid.NewGuid():N}"[..13];
    }

    private static JsonElement CreateJsonObject(Action<Utf8JsonWriter> writeProperties)
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

    private static bool TryReadError(JsonElement response, out string error)
    {
        error = JsonHelpers.GetString(response, "error") ?? string.Empty;
        return error.Length > 0;
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

    private static void WriteJobForPrompt(
        Utf8JsonWriter writer,
        CronJobRow job,
        CronRuntimeState runtimeState)
    {
        writer.WriteStartObject();
        writer.WriteString("id", job.Id);
        writer.WriteString("name", job.Name);
        writer.WritePropertyName("schedule");
        writer.WriteStartObject();
        writer.WriteString("kind", job.ScheduleKind);
        WriteNullableNumber(writer, "at", job.ScheduleAt);
        WriteNullableNumber(writer, "every", job.ScheduleEvery);
        WriteNullableString(writer, "expr", job.ScheduleExpr);
        writer.WriteString("tz", job.ScheduleTz);
        writer.WriteEndObject();
        writer.WriteString("prompt", Truncate(job.Prompt, 100));
        WriteNullableString(writer, "agentId", job.AgentId);
        writer.WriteBoolean("enabled", job.Enabled != 0);
        writer.WriteBoolean("scheduled", runtimeState.ScheduledIds.Contains(job.Id));
        writer.WriteBoolean("executing", runtimeState.RunningIds.Contains(job.Id));
        writer.WriteNumber("fireCount", job.FireCount);
        if (job.LastFiredAt is { } lastFiredAt && lastFiredAt > 0)
        {
            writer.WriteString(
                "lastFiredAt",
                DateTimeOffset.FromUnixTimeMilliseconds(lastFiredAt).UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
        }
        else
        {
            writer.WriteNull("lastFiredAt");
        }
        writer.WriteEndObject();
    }

    private static void WriteNullableNumber(Utf8JsonWriter writer, string name, long? value)
    {
        if (value is { } number)
        {
            writer.WriteNumber(name, number);
        }
        else
        {
            writer.WriteNull(name);
        }
    }

    private static string EncodeError(string message)
    {
        return EncodeJsonObject(writer => writer.WriteString("error", message));
    }

    private static string EncodeJsonObject(Action<Utf8JsonWriter> writeProperties)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            writeProperties(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string Truncate(string value, int maxChars)
    {
        return value.Length <= maxChars ? value : value[..maxChars];
    }

    private readonly record struct CronScheduleValues(
        string Kind,
        long? At,
        long? Every,
        string? Expr,
        string Tz);

    private readonly record struct CronBridgeResult(bool Success, string? Error)
    {
        public static CronBridgeResult Ok()
        {
            return new CronBridgeResult(true, null);
        }

        public static CronBridgeResult Failed(string error)
        {
            return new CronBridgeResult(false, error);
        }
    }

    private sealed class CronRuntimeState
    {
        private CronRuntimeState(
            bool success,
            HashSet<string> scheduledIds,
            HashSet<string> runningIds,
            string? error)
        {
            Success = success;
            ScheduledIds = scheduledIds;
            RunningIds = runningIds;
            Error = error;
        }

        public bool Success { get; }

        public HashSet<string> ScheduledIds { get; }

        public HashSet<string> RunningIds { get; }

        public string? Error { get; }

        public static CronRuntimeState FromJson(JsonElement element)
        {
            return new CronRuntimeState(
                JsonHelpers.GetBool(element, "success", true),
                ReadStringSet(element, "scheduledIds"),
                ReadStringSet(element, "runningIds"),
                null);
        }

        public static CronRuntimeState Failed(string error)
        {
            return new CronRuntimeState(false, new HashSet<string>(StringComparer.Ordinal), new HashSet<string>(StringComparer.Ordinal), error);
        }

        private static HashSet<string> ReadStringSet(JsonElement element, string name)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            if (element.ValueKind != JsonValueKind.Object ||
                !element.TryGetProperty(name, out var array) ||
                array.ValueKind != JsonValueKind.Array)
            {
                return set;
            }

            foreach (var item in array.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String &&
                    item.GetString() is { Length: > 0 } value)
                {
                    set.Add(value);
                }
            }
            return set;
        }
    }

    [GeneratedRegex("^\\+(\\d+)\\s*(s|sec|m|min|h|hr|d|day)s?$", RegexOptions.IgnoreCase)]
    private static partial Regex RelativeAtRegex();
}
