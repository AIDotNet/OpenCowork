using System.Text.Json;

internal sealed class RuntimeJobModule : IWorkerModule
{
    public string Name => "runtime-jobs";

    public void Register(WorkerModuleContext context)
    {
        RuntimeJobCoordinator.BindDispatcher(context.Dispatcher);
        context.Register("jobs/submit", Submit);
        context.Register("jobs/status", Status);
        context.Register("jobs/result", Status);
        context.Register("jobs/list", List);
        context.Register("jobs/cancel", Cancel);
        context.Register("jobs/command", Command);
        context.Register("events/subscribe", SubscribeAsync);
        context.Register("events/ack", Ack);
        context.Register("events/replay", ReplayAsync);
    }

    private static WorkerResponse Submit(JsonElement parameters)
    {
        try
        {
            var method = JsonHelpers.GetString(parameters, "method")?.Trim();
            if (string.IsNullOrEmpty(method))
            {
                return WorkerResponse.Error("jobs/submit requires method");
            }
            var routeParameters = parameters.ValueKind == JsonValueKind.Object &&
                parameters.TryGetProperty("params", out var value)
                ? value
                : default;
            var submission = RuntimeJobCoordinator.Submit(
                method,
                routeParameters,
                JsonHelpers.GetString(parameters, "jobId"),
                JsonHelpers.GetString(parameters, "idempotencyKey"),
                JsonHelpers.GetString(parameters, "laneKey"));
            return WriteSubmission(submission);
        }
        catch (Exception ex)
        {
            return WorkerResponse.FromWriter(writer =>
            {
                writer.WriteStartObject();
                writer.WriteBoolean("accepted", false);
                writer.WriteBoolean("duplicate", false);
                writer.WriteString("state", "queue_unavailable");
                writer.WriteString("errorCode", "queue_unavailable");
                writer.WriteString("error", ex.Message);
                writer.WriteEndObject();
            });
        }
    }

    private static WorkerResponse Status(JsonElement parameters)
    {
        var jobId = JsonHelpers.GetString(parameters, "jobId")?.Trim();
        if (string.IsNullOrEmpty(jobId))
        {
            return WorkerResponse.Error("jobs/status requires jobId");
        }
        return WriteJob(RuntimeJobCoordinator.Get(jobId));
    }

    private static WorkerResponse List(JsonElement parameters)
    {
        var limit = JsonHelpers.GetInt(parameters, "limit", 100);
        var jobs = RuntimeJobCoordinator.List(limit, JsonHelpers.GetString(parameters, "state"));
        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WritePropertyName("jobs");
            writer.WriteStartArray();
            foreach (var job in jobs)
            {
                WriteJobValue(writer, job, includeResult: false);
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        });
    }

    private static WorkerResponse Cancel(JsonElement parameters)
    {
        var jobId = JsonHelpers.GetString(parameters, "jobId")?.Trim();
        if (string.IsNullOrEmpty(jobId))
        {
            return WorkerResponse.Error("jobs/cancel requires jobId");
        }
        var state = RuntimeJobCoordinator.Cancel(jobId);
        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteBoolean("cancelled", state is "cancelled" or "cancelling");
            writer.WriteString("jobId", jobId);
            if (state is not null) writer.WriteString("state", state);
            writer.WriteEndObject();
        });
    }

    private static WorkerResponse Command(JsonElement parameters)
    {
        var jobId = JsonHelpers.GetString(parameters, "jobId")?.Trim();
        var kind = JsonHelpers.GetString(parameters, "kind")?.Trim();
        if (string.IsNullOrEmpty(jobId) || string.IsNullOrEmpty(kind))
        {
            return WorkerResponse.Error("jobs/command requires jobId and kind");
        }
        var payload = parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty("payload", out var value)
            ? value
            : default;
        var seq = RuntimeJobCoordinator.AppendCommand(jobId, kind, payload);
        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteBoolean("accepted", true);
            writer.WriteString("jobId", jobId);
            writer.WriteNumber("seq", seq);
            writer.WriteEndObject();
        });
    }

    private static async Task<WorkerResponse> SubscribeAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        return await ReplayCoreAsync(parameters, context);
    }

    private static WorkerResponse Ack(JsonElement parameters)
    {
        var consumerId = JsonHelpers.GetString(parameters, "consumerId")?.Trim();
        var jobId = JsonHelpers.GetString(parameters, "jobId")?.Trim();
        var throughSeq = JsonHelpers.GetLong(parameters, "throughSeq", 0);
        if (string.IsNullOrEmpty(consumerId) || string.IsNullOrEmpty(jobId) || throughSeq <= 0)
        {
            return WorkerResponse.Error("events/ack requires consumerId, jobId and throughSeq");
        }
        RuntimeJobCoordinator.Ack(consumerId, jobId, throughSeq);
        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteBoolean("acked", true);
            writer.WriteString("jobId", jobId);
            writer.WriteNumber("throughSeq", throughSeq);
            writer.WriteEndObject();
        });
    }

    private static async Task<WorkerResponse> ReplayAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        return await ReplayCoreAsync(parameters, context);
    }

    private static async Task<WorkerResponse> ReplayCoreAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var consumerId = JsonHelpers.GetString(parameters, "consumerId")?.Trim();
        if (string.IsNullOrEmpty(consumerId))
        {
            return WorkerResponse.Error("events/subscribe requires consumerId");
        }
        var count = await RuntimeJobCoordinator.ReplayAsync(
            consumerId,
            JsonHelpers.GetString(parameters, "jobId"),
            JsonHelpers.GetLongNullable(parameters, "sinceSeq"),
            JsonHelpers.GetInt(parameters, "limit", 4096),
            context.CancellationToken);
        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteBoolean("subscribed", true);
            writer.WriteNumber("published", count);
            writer.WriteEndObject();
        });
    }

    private static WorkerResponse WriteSubmission(RuntimeJobSubmission submission)
    {
        return WorkerResponse.FromWriter(writer =>
        {
            writer.WriteStartObject();
            writer.WriteBoolean("accepted", submission.Accepted);
            writer.WriteBoolean("duplicate", submission.Duplicate);
            writer.WriteString("jobId", submission.Job.JobId);
            if (submission.Job.RunId is not null) writer.WriteString("runId", submission.Job.RunId);
            writer.WriteString("state", submission.Job.State);
            writer.WriteEndObject();
        });
    }

    private static WorkerResponse WriteJob(RuntimeJobRecord? job)
    {
        return WorkerResponse.FromWriter(writer =>
        {
            if (job is null)
            {
                writer.WriteStartObject();
                writer.WriteBoolean("found", false);
                writer.WriteEndObject();
                return;
            }
            WriteJobValue(writer, job, includeResult: true);
        });
    }

    private static void WriteJobValue(
        Utf8JsonWriter writer,
        RuntimeJobRecord job,
        bool includeResult)
    {
        writer.WriteStartObject();
        writer.WriteBoolean("found", true);
        writer.WriteString("jobId", job.JobId);
        writer.WriteString("method", job.Method);
        writer.WriteString("state", job.State);
        if (job.SessionId is not null) writer.WriteString("sessionId", job.SessionId);
        if (job.RunId is not null) writer.WriteString("runId", job.RunId);
        writer.WriteString("laneKey", job.LaneKey);
        writer.WriteNumber("createdAt", job.CreatedAt);
        writer.WriteNumber("updatedAt", job.UpdatedAt);
        if (job.StartedAt.HasValue) writer.WriteNumber("startedAt", job.StartedAt.Value);
        if (job.FinishedAt.HasValue) writer.WriteNumber("finishedAt", job.FinishedAt.Value);
        if (includeResult && job.ResultJson is not null)
        {
            writer.WritePropertyName("result");
            using var result = JsonDocument.Parse(job.ResultJson);
            result.RootElement.WriteTo(writer);
        }
        if (job.ErrorCode is not null) writer.WriteString("errorCode", job.ErrorCode);
        if (job.ErrorMessage is not null) writer.WriteString("error", job.ErrorMessage);
        writer.WriteEndObject();
    }
}
