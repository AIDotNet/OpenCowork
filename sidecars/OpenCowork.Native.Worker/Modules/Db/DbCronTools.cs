using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbCronTools
{
    private static SqliteConnection OpenDefaultConnection()
    {
        return DbConnectionFactory.OpenReadWrite(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "data.db"));
    }

    private const string CronJobSelectSql = """
        SELECT id,
               name,
               schedule_kind,
               schedule_at,
               schedule_every,
               schedule_expr,
               schedule_tz,
               prompt,
               agent_id,
               model,
               working_folder,
               ssh_connection_id,
               session_id,
               source_session_title,
               source_project_id,
               source_project_name,
               source_provider_id,
               delivery_mode,
               delivery_target,
               plugin_id,
               plugin_chat_id,
               enabled,
               delete_after_run,
               max_iterations,
               deleted_at,
               last_fired_at,
               fire_count,
               created_at,
               updated_at
          FROM cron_jobs
        """;

    private const string CronRunSelectSql = """
        SELECT id,
               job_id,
               started_at,
               finished_at,
               status,
               tool_call_count,
               output_summary,
               error,
               scheduled_for,
               job_name_snapshot,
               prompt_snapshot,
               source_session_id_snapshot,
               source_session_title_snapshot,
               source_project_id_snapshot,
               source_project_name_snapshot,
               source_provider_id_snapshot,
               model_snapshot,
               working_folder_snapshot,
               delivery_mode_snapshot,
               delivery_target_snapshot
          FROM cron_runs
        """;

    internal static CronMutationResult CreateJobRecord(CronJobRow job)
    {
        try
        {
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO cron_jobs (
                  id, name, session_id, schedule_kind, schedule_at, schedule_every, schedule_expr, schedule_tz,
                  prompt, agent_id, model, working_folder, ssh_connection_id,
                  source_session_title, source_project_id, source_project_name, source_provider_id,
                  delivery_mode, delivery_target, plugin_id, plugin_chat_id,
                  enabled, delete_after_run, max_iterations, deleted_at,
                  last_fired_at, fire_count, created_at, updated_at
                )
                VALUES (
                  $id, $name, $sessionId, $scheduleKind, $scheduleAt, $scheduleEvery, $scheduleExpr, $scheduleTz,
                  $prompt, $agentId, $model, $workingFolder, $sshConnectionId,
                  $sourceSessionTitle, $sourceProjectId, $sourceProjectName, $sourceProviderId,
                  $deliveryMode, $deliveryTarget, $pluginId, $pluginChatId,
                  $enabled, $deleteAfterRun, $maxIterations, $deletedAt,
                  $lastFiredAt, $fireCount, $createdAt, $updatedAt
                )
                """,
                JobParams(job));
            transaction.Commit();
            return new CronMutationResult(true, changed, null);
        }
        catch (Exception ex)
        {
            return new CronMutationResult(false, 0, ex.Message);
        }
    }

    internal static CronMutationResult UpdateJobRecord(CronJobRow job)
    {
        try
        {
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE cron_jobs SET
                  name = $name,
                  session_id = $sessionId,
                  schedule_kind = $scheduleKind,
                  schedule_at = $scheduleAt,
                  schedule_every = $scheduleEvery,
                  schedule_expr = $scheduleExpr,
                  schedule_tz = $scheduleTz,
                  prompt = $prompt,
                  agent_id = $agentId,
                  model = $model,
                  working_folder = $workingFolder,
                  ssh_connection_id = $sshConnectionId,
                  source_session_title = $sourceSessionTitle,
                  source_project_id = $sourceProjectId,
                  source_project_name = $sourceProjectName,
                  source_provider_id = $sourceProviderId,
                  delivery_mode = $deliveryMode,
                  delivery_target = $deliveryTarget,
                  plugin_id = $pluginId,
                  plugin_chat_id = $pluginChatId,
                  enabled = $enabled,
                  delete_after_run = $deleteAfterRun,
                  max_iterations = $maxIterations,
                  deleted_at = $deletedAt,
                  last_fired_at = $lastFiredAt,
                  fire_count = $fireCount,
                  updated_at = $updatedAt
                WHERE id = $id
                """,
                JobParams(job));
            transaction.Commit();
            return new CronMutationResult(true, changed, null);
        }
        catch (Exception ex)
        {
            return new CronMutationResult(false, 0, ex.Message);
        }
    }

    internal static CronJobFindResult FindJobRecord(string jobId)
    {
        try
        {
            using var connection = OpenDefaultConnection();
            var job = GetJob(connection, null, jobId);
            return new CronJobFindResult(true, job, null);
        }
        catch (Exception ex)
        {
            return new CronJobFindResult(false, null, ex.Message);
        }
    }

    internal static CronJobListResult ListJobRecords(string? sessionId = null, bool includeDeleted = false)
    {
        try
        {
            var where = new List<string>();
            var values = new List<DbSql.SqlParam>();

            if (!string.IsNullOrEmpty(sessionId))
            {
                where.Add("session_id = $sessionId");
                values.Add(new DbSql.SqlParam("$sessionId", sessionId));
            }
            if (!includeDeleted)
            {
                where.Add("deleted_at IS NULL");
            }

            using var connection = OpenDefaultConnection();
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {CronJobSelectSql}
                {(where.Count > 0 ? $"WHERE {string.Join(" AND ", where)}" : string.Empty)}
                 ORDER BY created_at DESC
                """;
            AddParameters(command, values);
            return new CronJobListResult(true, ReadJobRows(command), null);
        }
        catch (Exception ex)
        {
            return new CronJobListResult(false, new List<CronJobRow>(), ex.Message);
        }
    }

    internal static CronMutationResult SoftDeleteJobRecord(string jobId, long? deletedAt = null, long? updatedAt = null)
    {
        try
        {
            var resolvedDeletedAt = deletedAt ?? Now();
            var resolvedUpdatedAt = updatedAt ?? resolvedDeletedAt;
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "UPDATE cron_jobs SET enabled = 0, deleted_at = $deletedAt, updated_at = $updatedAt WHERE id = $jobId",
                new DbSql.SqlParam("$deletedAt", resolvedDeletedAt),
                new DbSql.SqlParam("$updatedAt", resolvedUpdatedAt),
                new DbSql.SqlParam("$jobId", jobId));
            transaction.Commit();
            return new CronMutationResult(true, changed, null);
        }
        catch (Exception ex)
        {
            return new CronMutationResult(false, 0, ex.Message);
        }
    }

    internal static CronMutationResult DeleteJobRecord(string jobId)
    {
        try
        {
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM cron_jobs WHERE id = $jobId",
                new DbSql.SqlParam("$jobId", jobId));
            transaction.Commit();
            return new CronMutationResult(true, changed, null);
        }
        catch (Exception ex)
        {
            return new CronMutationResult(false, 0, ex.Message);
        }
    }

    public static WorkerResponse CreateJob(JsonElement parameters)
    {
        try
        {
            return Mutation(CreateJobRecord(ReadJobInput(GetObject(parameters, "job"))));
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse UpdateJob(JsonElement parameters)
    {
        try
        {
            return Mutation(UpdateJobRecord(ReadJobInput(GetObject(parameters, "job"))));
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse GetJob(JsonElement parameters)
    {
        try
        {
            return WorkerResponse.Json(
                FindJobRecord(RequireString(parameters, "jobId")),
                WorkerJsonContext.Default.CronJobFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new CronJobFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.CronJobFindResult);
        }
    }

    public static WorkerResponse ListJobs(JsonElement parameters)
    {
        return WorkerResponse.Json(
            ListJobRecords(
                JsonHelpers.GetString(parameters, "sessionId"),
                JsonHelpers.GetBool(parameters, "includeDeleted", false)),
            WorkerJsonContext.Default.CronJobListResult);
    }

    public static WorkerResponse SoftDeleteJob(JsonElement parameters)
    {
        try
        {
            var deletedAt = JsonHelpers.GetLong(parameters, "deletedAt", Now());
            var updatedAt = JsonHelpers.GetLong(parameters, "updatedAt", deletedAt);
            return Mutation(SoftDeleteJobRecord(RequireString(parameters, "jobId"), deletedAt, updatedAt));
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse DeleteJob(JsonElement parameters)
    {
        try
        {
            return Mutation(DeleteJobRecord(RequireString(parameters, "jobId")));
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse SetJobEnabled(JsonElement parameters)
    {
        try
        {
            var jobId = RequireString(parameters, "jobId");
            var enabled = JsonHelpers.GetBool(parameters, "enabled", false) ? 1 : 0;
            var updatedAt = JsonHelpers.GetLong(parameters, "updatedAt", Now());
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "UPDATE cron_jobs SET enabled = $enabled, updated_at = $updatedAt WHERE id = $jobId",
                new DbSql.SqlParam("$enabled", enabled),
                new DbSql.SqlParam("$updatedAt", updatedAt),
                new DbSql.SqlParam("$jobId", jobId));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse MarkJobFired(JsonElement parameters)
    {
        try
        {
            var jobId = RequireString(parameters, "jobId");
            var firedAt = JsonHelpers.GetLong(parameters, "firedAt", Now());
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "UPDATE cron_jobs SET last_fired_at = $firedAt, fire_count = fire_count + 1 WHERE id = $jobId",
                new DbSql.SqlParam("$firedAt", firedAt),
                new DbSql.SqlParam("$jobId", jobId));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse LoadPersistedJobs(JsonElement parameters)
    {
        try
        {
            var now = JsonHelpers.GetLong(parameters, "now", Now());
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var abortedRuns = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE cron_runs
                   SET finished_at = COALESCE(finished_at, $now),
                       status = 'aborted',
                       error = COALESCE(error, 'Cron run interrupted before completion')
                 WHERE status = 'running' AND finished_at IS NULL
                """,
                new DbSql.SqlParam("$now", now));
            var expiredJobs = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE cron_jobs
                   SET enabled = 0,
                       deleted_at = COALESCE(deleted_at, $now),
                       updated_at = $now
                 WHERE schedule_kind = 'at'
                   AND schedule_at < $now
                   AND delete_after_run = 1
                   AND deleted_at IS NULL
                """,
                new DbSql.SqlParam("$now", now));

            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"{CronJobSelectSql} WHERE enabled = 1 AND deleted_at IS NULL";
            var rows = ReadJobRows(command);
            transaction.Commit();

            return WorkerResponse.Json(
                new CronStartupLoadResult(true, rows, abortedRuns, expiredJobs, null),
                WorkerJsonContext.Default.CronStartupLoadResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new CronStartupLoadResult(false, new List<CronJobRow>(), 0, 0, ex.Message),
                WorkerJsonContext.Default.CronStartupLoadResult);
        }
    }

    public static WorkerResponse ListRuns(JsonElement parameters)
    {
        try
        {
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 200), 1, 1000);
            var filters = new List<string>();
            var values = new List<DbSql.SqlParam>();
            var sessionId = JsonHelpers.GetString(parameters, "sessionId");
            var needsSessionJoin = !string.IsNullOrEmpty(sessionId);

            if (JsonHelpers.GetString(parameters, "jobId") is { Length: > 0 } jobId)
            {
                filters.Add("r.job_id = $jobId");
                values.Add(new DbSql.SqlParam("$jobId", jobId));
            }
            if (needsSessionJoin)
            {
                filters.Add("COALESCE(r.source_session_id_snapshot, j.session_id) = $sessionId");
                values.Add(new DbSql.SqlParam("$sessionId", sessionId));
            }
            if (JsonHelpers.GetLongNullable(parameters, "start") is { } start)
            {
                filters.Add("r.started_at >= $start");
                values.Add(new DbSql.SqlParam("$start", start));
            }
            if (JsonHelpers.GetLongNullable(parameters, "end") is { } end)
            {
                filters.Add("r.started_at <= $end");
                values.Add(new DbSql.SqlParam("$end", end));
            }

            var fromClause = needsSessionJoin
                ? "FROM cron_runs r LEFT JOIN cron_jobs j ON j.id = r.job_id"
                : "FROM cron_runs r";
            var whereClause = filters.Count > 0 ? $" WHERE {string.Join(" AND ", filters)}" : string.Empty;

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                SELECT r.id,
                       r.job_id,
                       r.started_at,
                       r.finished_at,
                       r.status,
                       r.tool_call_count,
                       r.output_summary,
                       r.error,
                       r.scheduled_for,
                       r.job_name_snapshot,
                       r.prompt_snapshot,
                       r.source_session_id_snapshot,
                       r.source_session_title_snapshot,
                       r.source_project_id_snapshot,
                       r.source_project_name_snapshot,
                       r.source_provider_id_snapshot,
                       r.model_snapshot,
                       r.working_folder_snapshot,
                       r.delivery_mode_snapshot,
                       r.delivery_target_snapshot
                  {fromClause}{whereClause}
                 ORDER BY r.started_at DESC
                 LIMIT $limit
                """;
            AddParameters(command, values);
            command.Parameters.AddWithValue("$limit", limit);

            return WorkerResponse.Json(
                new CronRunListResult(true, ReadRunRows(command), null),
                WorkerJsonContext.Default.CronRunListResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new CronRunListResult(false, new List<CronRunRow>(), ex.Message),
                WorkerJsonContext.Default.CronRunListResult);
        }
    }

    public static WorkerResponse CreateRun(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO cron_runs (
                  id, job_id, started_at, finished_at, status, tool_call_count, output_summary, error,
                  scheduled_for, job_name_snapshot, prompt_snapshot,
                  source_session_id_snapshot, source_session_title_snapshot,
                  source_project_id_snapshot, source_project_name_snapshot, source_provider_id_snapshot,
                  model_snapshot, working_folder_snapshot,
                  delivery_mode_snapshot, delivery_target_snapshot
                ) VALUES (
                  $runId, $jobId, $startedAt, NULL, 'running', 0, NULL, NULL,
                  $scheduledFor, $jobNameSnapshot, $promptSnapshot,
                  $sourceSessionIdSnapshot, $sourceSessionTitleSnapshot,
                  $sourceProjectIdSnapshot, $sourceProjectNameSnapshot, $sourceProviderIdSnapshot,
                  $modelSnapshot, $workingFolderSnapshot,
                  $deliveryModeSnapshot, $deliveryTargetSnapshot
                )
                """,
                new DbSql.SqlParam("$runId", RequireString(parameters, "runId")),
                new DbSql.SqlParam("$jobId", RequireString(parameters, "jobId")),
                new DbSql.SqlParam("$startedAt", JsonHelpers.GetLong(parameters, "startedAt", Now())),
                new DbSql.SqlParam("$scheduledFor", JsonHelpers.GetLongNullable(parameters, "scheduledFor")),
                new DbSql.SqlParam("$jobNameSnapshot", JsonHelpers.GetString(parameters, "jobNameSnapshot")),
                new DbSql.SqlParam("$promptSnapshot", JsonHelpers.GetString(parameters, "promptSnapshot")),
                new DbSql.SqlParam("$sourceSessionIdSnapshot", JsonHelpers.GetString(parameters, "sourceSessionIdSnapshot")),
                new DbSql.SqlParam("$sourceSessionTitleSnapshot", JsonHelpers.GetString(parameters, "sourceSessionTitleSnapshot")),
                new DbSql.SqlParam("$sourceProjectIdSnapshot", JsonHelpers.GetString(parameters, "sourceProjectIdSnapshot")),
                new DbSql.SqlParam("$sourceProjectNameSnapshot", JsonHelpers.GetString(parameters, "sourceProjectNameSnapshot")),
                new DbSql.SqlParam("$sourceProviderIdSnapshot", JsonHelpers.GetString(parameters, "sourceProviderIdSnapshot")),
                new DbSql.SqlParam("$modelSnapshot", JsonHelpers.GetString(parameters, "modelSnapshot")),
                new DbSql.SqlParam("$workingFolderSnapshot", JsonHelpers.GetString(parameters, "workingFolderSnapshot")),
                new DbSql.SqlParam("$deliveryModeSnapshot", JsonHelpers.GetString(parameters, "deliveryModeSnapshot")),
                new DbSql.SqlParam("$deliveryTargetSnapshot", JsonHelpers.GetString(parameters, "deliveryTargetSnapshot")));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse UpdateRun(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            var patch = GetObject(parameters, "patch");
            var sets = new List<string>();
            var values = new List<DbSql.SqlParam>();
            AddLongPatch(patch, sets, values, "finishedAt", "finished_at");
            AddStringPatch(patch, sets, values, "status", "status");
            AddIntPatch(patch, sets, values, "toolCallCount", "tool_call_count");
            AddStringPatch(patch, sets, values, "outputSummary", "output_summary");
            AddStringPatch(patch, sets, values, "error", "error");
            if (sets.Count == 0)
            {
                return Mutation(0);
            }

            values.Add(new DbSql.SqlParam("$runId", runId));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"UPDATE cron_runs SET {string.Join(", ", sets)} WHERE id = $runId";
            AddParameters(command, values);
            var changed = command.ExecuteNonQuery();
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse GetRun(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var run = GetRun(connection, null, runId);
            return WorkerResponse.Json(
                new CronRunFindResult(true, run, null),
                WorkerJsonContext.Default.CronRunFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new CronRunFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.CronRunFindResult);
        }
    }

    public static WorkerResponse ReplaceRunMessages(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            var messages = GetArray(parameters, "messages");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM cron_run_messages WHERE run_id = $runId",
                new DbSql.SqlParam("$runId", runId));

            var changed = 0;
            var index = 0;
            foreach (var message in messages.EnumerateArray())
            {
                changed += DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    """
                    INSERT INTO cron_run_messages (id, run_id, role, content, usage, message_source, sort_order, created_at)
                    VALUES ($id, $runId, $role, $content, $usage, $source, $sortOrder, $createdAt)
                    """,
                    new DbSql.SqlParam("$id", RequireString(message, "id")),
                    new DbSql.SqlParam("$runId", runId),
                    new DbSql.SqlParam("$role", RequireString(message, "role")),
                    new DbSql.SqlParam("$content", GetRawJson(message, "content") ?? "null"),
                    new DbSql.SqlParam("$usage", GetRawJson(message, "usage")),
                    new DbSql.SqlParam("$source", JsonHelpers.GetString(message, "source")),
                    new DbSql.SqlParam("$sortOrder", index),
                    new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(message, "createdAt", Now())));
                index++;
            }

            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse AppendRunLog(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var nextSortOrder = GetNextLogSortOrder(connection, transaction, runId);
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO cron_run_logs (id, run_id, timestamp, type, content, sort_order)
                VALUES ($id, $runId, $timestamp, $type, $content, $sortOrder)
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$runId", runId),
                new DbSql.SqlParam("$timestamp", JsonHelpers.GetLong(parameters, "timestamp", Now())),
                new DbSql.SqlParam("$type", RequireString(parameters, "type")),
                new DbSql.SqlParam("$content", JsonHelpers.GetString(parameters, "content") ?? string.Empty),
                new DbSql.SqlParam("$sortOrder", nextSortOrder));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse RunDetail(JsonElement parameters)
    {
        try
        {
            var runId = RequireString(parameters, "runId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var run = GetRun(connection, null, runId);
            if (run is null)
            {
                return WorkerResponse.Json(
                    new CronRunDetailResult(false, null, null, new List<CronRunMessageRow>(), new List<CronRunLogRow>(), $"Run \"{runId}\" not found"),
                    WorkerJsonContext.Default.CronRunDetailResult);
            }

            var job = GetJob(connection, null, run.JobId);
            var messages = ListRunMessages(connection, runId);
            var logs = ListRunLogs(connection, runId);
            return WorkerResponse.Json(
                new CronRunDetailResult(true, run, job, messages, logs, null),
                WorkerJsonContext.Default.CronRunDetailResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new CronRunDetailResult(false, null, null, new List<CronRunMessageRow>(), new List<CronRunLogRow>(), ex.Message),
                WorkerJsonContext.Default.CronRunDetailResult);
        }
    }

    private static CronJobRow? GetJob(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string jobId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{CronJobSelectSql} WHERE id = $jobId LIMIT 1";
        command.Parameters.AddWithValue("$jobId", jobId);
        return ReadJobRows(command).FirstOrDefault();
    }

    private static CronRunRow? GetRun(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string runId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{CronRunSelectSql} WHERE id = $runId LIMIT 1";
        command.Parameters.AddWithValue("$runId", runId);
        return ReadRunRows(command).FirstOrDefault();
    }

    private static List<CronJobRow> ReadJobRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<CronJobRow>();
        while (reader.Read())
        {
            rows.Add(new CronJobRow
            {
                Id = reader.GetString(0),
                Name = reader.GetString(1),
                ScheduleKind = reader.GetString(2),
                ScheduleAt = reader.IsDBNull(3) ? null : reader.GetInt64(3),
                ScheduleEvery = reader.IsDBNull(4) ? null : reader.GetInt64(4),
                ScheduleExpr = reader.IsDBNull(5) ? null : reader.GetString(5),
                ScheduleTz = reader.IsDBNull(6) ? "UTC" : reader.GetString(6),
                Prompt = reader.GetString(7),
                AgentId = reader.IsDBNull(8) ? null : reader.GetString(8),
                Model = reader.IsDBNull(9) ? null : reader.GetString(9),
                WorkingFolder = reader.IsDBNull(10) ? null : reader.GetString(10),
                SshConnectionId = reader.IsDBNull(11) ? null : reader.GetString(11),
                SessionId = reader.IsDBNull(12) ? null : reader.GetString(12),
                SourceSessionTitle = reader.IsDBNull(13) ? null : reader.GetString(13),
                SourceProjectId = reader.IsDBNull(14) ? null : reader.GetString(14),
                SourceProjectName = reader.IsDBNull(15) ? null : reader.GetString(15),
                SourceProviderId = reader.IsDBNull(16) ? null : reader.GetString(16),
                DeliveryMode = reader.IsDBNull(17) ? "desktop" : reader.GetString(17),
                DeliveryTarget = reader.IsDBNull(18) ? null : reader.GetString(18),
                PluginId = reader.IsDBNull(19) ? null : reader.GetString(19),
                PluginChatId = reader.IsDBNull(20) ? null : reader.GetString(20),
                Enabled = reader.GetInt32(21),
                DeleteAfterRun = reader.GetInt32(22),
                MaxIterations = reader.GetInt32(23),
                DeletedAt = reader.IsDBNull(24) ? null : reader.GetInt64(24),
                LastFiredAt = reader.IsDBNull(25) ? null : reader.GetInt64(25),
                FireCount = reader.GetInt32(26),
                CreatedAt = reader.GetInt64(27),
                UpdatedAt = reader.GetInt64(28)
            });
        }

        return rows;
    }

    private static List<CronRunRow> ReadRunRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<CronRunRow>();
        while (reader.Read())
        {
            rows.Add(new CronRunRow
            {
                Id = reader.GetString(0),
                JobId = reader.GetString(1),
                StartedAt = reader.GetInt64(2),
                FinishedAt = reader.IsDBNull(3) ? null : reader.GetInt64(3),
                Status = reader.IsDBNull(4) ? "running" : reader.GetString(4),
                ToolCallCount = reader.GetInt32(5),
                OutputSummary = reader.IsDBNull(6) ? null : reader.GetString(6),
                Error = reader.IsDBNull(7) ? null : reader.GetString(7),
                ScheduledFor = reader.IsDBNull(8) ? null : reader.GetInt64(8),
                JobNameSnapshot = reader.IsDBNull(9) ? null : reader.GetString(9),
                PromptSnapshot = reader.IsDBNull(10) ? null : reader.GetString(10),
                SourceSessionIdSnapshot = reader.IsDBNull(11) ? null : reader.GetString(11),
                SourceSessionTitleSnapshot = reader.IsDBNull(12) ? null : reader.GetString(12),
                SourceProjectIdSnapshot = reader.IsDBNull(13) ? null : reader.GetString(13),
                SourceProjectNameSnapshot = reader.IsDBNull(14) ? null : reader.GetString(14),
                SourceProviderIdSnapshot = reader.IsDBNull(15) ? null : reader.GetString(15),
                ModelSnapshot = reader.IsDBNull(16) ? null : reader.GetString(16),
                WorkingFolderSnapshot = reader.IsDBNull(17) ? null : reader.GetString(17),
                DeliveryModeSnapshot = reader.IsDBNull(18) ? null : reader.GetString(18),
                DeliveryTargetSnapshot = reader.IsDBNull(19) ? null : reader.GetString(19)
            });
        }

        return rows;
    }

    private static List<CronRunMessageRow> ListRunMessages(SqliteConnection connection, string runId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, role, content, usage, message_source, created_at
              FROM cron_run_messages
             WHERE run_id = $runId
             ORDER BY sort_order ASC
            """;
        command.Parameters.AddWithValue("$runId", runId);
        using var reader = command.ExecuteReader();
        var rows = new List<CronRunMessageRow>();
        while (reader.Read())
        {
            rows.Add(new CronRunMessageRow
            {
                Id = reader.GetString(0),
                Role = reader.GetString(1),
                Content = reader.GetString(2),
                Usage = reader.IsDBNull(3) ? null : reader.GetString(3),
                MessageSource = reader.IsDBNull(4) ? null : reader.GetString(4),
                CreatedAt = reader.GetInt64(5)
            });
        }

        return rows;
    }

    private static List<CronRunLogRow> ListRunLogs(SqliteConnection connection, string runId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, timestamp, type, content
              FROM cron_run_logs
             WHERE run_id = $runId
             ORDER BY sort_order ASC
            """;
        command.Parameters.AddWithValue("$runId", runId);
        using var reader = command.ExecuteReader();
        var rows = new List<CronRunLogRow>();
        while (reader.Read())
        {
            rows.Add(new CronRunLogRow
            {
                Id = reader.GetString(0),
                Timestamp = reader.GetInt64(1),
                Type = reader.GetString(2),
                Content = reader.GetString(3)
            });
        }

        return rows;
    }

    private static int GetNextLogSortOrder(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string runId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT MAX(sort_order) FROM cron_run_logs WHERE run_id = $runId";
        command.Parameters.AddWithValue("$runId", runId);
        var value = command.ExecuteScalar();
        return value is null or DBNull ? 0 : Convert.ToInt32(value) + 1;
    }

    private static CronJobRow ReadJobInput(JsonElement element)
    {
        return new CronJobRow
        {
            Id = RequireString(element, "id"),
            Name = RequireString(element, "name"),
            ScheduleKind = RequireString(element, "schedule_kind"),
            ScheduleAt = JsonHelpers.GetLongNullable(element, "schedule_at"),
            ScheduleEvery = JsonHelpers.GetLongNullable(element, "schedule_every"),
            ScheduleExpr = JsonHelpers.GetString(element, "schedule_expr"),
            ScheduleTz = JsonHelpers.GetString(element, "schedule_tz") ?? "UTC",
            Prompt = RequireString(element, "prompt"),
            AgentId = JsonHelpers.GetString(element, "agent_id"),
            Model = JsonHelpers.GetString(element, "model"),
            WorkingFolder = JsonHelpers.GetString(element, "working_folder"),
            SshConnectionId = JsonHelpers.GetString(element, "ssh_connection_id"),
            SessionId = JsonHelpers.GetString(element, "session_id"),
            SourceSessionTitle = JsonHelpers.GetString(element, "source_session_title"),
            SourceProjectId = JsonHelpers.GetString(element, "source_project_id"),
            SourceProjectName = JsonHelpers.GetString(element, "source_project_name"),
            SourceProviderId = JsonHelpers.GetString(element, "source_provider_id"),
            DeliveryMode = JsonHelpers.GetString(element, "delivery_mode") ?? "desktop",
            DeliveryTarget = JsonHelpers.GetString(element, "delivery_target"),
            PluginId = JsonHelpers.GetString(element, "plugin_id"),
            PluginChatId = JsonHelpers.GetString(element, "plugin_chat_id"),
            Enabled = JsonHelpers.GetInt(element, "enabled", 1),
            DeleteAfterRun = JsonHelpers.GetInt(element, "delete_after_run", 0),
            MaxIterations = JsonHelpers.GetInt(element, "max_iterations", 15),
            DeletedAt = JsonHelpers.GetLongNullable(element, "deleted_at"),
            LastFiredAt = JsonHelpers.GetLongNullable(element, "last_fired_at"),
            FireCount = JsonHelpers.GetInt(element, "fire_count", 0),
            CreatedAt = JsonHelpers.GetLong(element, "created_at", Now()),
            UpdatedAt = JsonHelpers.GetLong(element, "updated_at", Now())
        };
    }

    private static DbSql.SqlParam[] JobParams(CronJobRow job)
    {
        return
        [
            new DbSql.SqlParam("$id", job.Id),
            new DbSql.SqlParam("$name", job.Name),
            new DbSql.SqlParam("$sessionId", job.SessionId),
            new DbSql.SqlParam("$scheduleKind", job.ScheduleKind),
            new DbSql.SqlParam("$scheduleAt", job.ScheduleAt),
            new DbSql.SqlParam("$scheduleEvery", job.ScheduleEvery),
            new DbSql.SqlParam("$scheduleExpr", job.ScheduleExpr),
            new DbSql.SqlParam("$scheduleTz", job.ScheduleTz),
            new DbSql.SqlParam("$prompt", job.Prompt),
            new DbSql.SqlParam("$agentId", job.AgentId),
            new DbSql.SqlParam("$model", job.Model),
            new DbSql.SqlParam("$workingFolder", job.WorkingFolder),
            new DbSql.SqlParam("$sshConnectionId", job.SshConnectionId),
            new DbSql.SqlParam("$sourceSessionTitle", job.SourceSessionTitle),
            new DbSql.SqlParam("$sourceProjectId", job.SourceProjectId),
            new DbSql.SqlParam("$sourceProjectName", job.SourceProjectName),
            new DbSql.SqlParam("$sourceProviderId", job.SourceProviderId),
            new DbSql.SqlParam("$deliveryMode", job.DeliveryMode),
            new DbSql.SqlParam("$deliveryTarget", job.DeliveryTarget),
            new DbSql.SqlParam("$pluginId", job.PluginId),
            new DbSql.SqlParam("$pluginChatId", job.PluginChatId),
            new DbSql.SqlParam("$enabled", job.Enabled),
            new DbSql.SqlParam("$deleteAfterRun", job.DeleteAfterRun),
            new DbSql.SqlParam("$maxIterations", job.MaxIterations),
            new DbSql.SqlParam("$deletedAt", job.DeletedAt),
            new DbSql.SqlParam("$lastFiredAt", job.LastFiredAt),
            new DbSql.SqlParam("$fireCount", job.FireCount),
            new DbSql.SqlParam("$createdAt", job.CreatedAt),
            new DbSql.SqlParam("$updatedAt", job.UpdatedAt)
        ];
    }

    private static void AddStringPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", value.ValueKind == JsonValueKind.Null ? null : value.GetString()));
    }

    private static void AddIntPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", value.ValueKind == JsonValueKind.Null ? null : value.GetInt32()));
    }

    private static void AddLongPatch(
        JsonElement patch,
        List<string> sets,
        List<DbSql.SqlParam> values,
        string jsonName,
        string columnName)
    {
        if (!patch.TryGetProperty(jsonName, out var value))
        {
            return;
        }

        sets.Add($"{columnName} = ${jsonName}");
        values.Add(new DbSql.SqlParam($"${jsonName}", value.ValueKind == JsonValueKind.Null ? null : value.GetInt64()));
    }

    private static void AddParameters(SqliteCommand command, IEnumerable<DbSql.SqlParam> values)
    {
        foreach (var value in values)
        {
            command.Parameters.AddWithValue(value.Name, value.Value ?? DBNull.Value);
        }
    }

    private static JsonElement GetObject(JsonElement parameters, string name)
    {
        if (parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.Object)
        {
            return value;
        }

        throw new InvalidOperationException($"Missing required cron object: {name}");
    }

    private static JsonElement GetArray(JsonElement parameters, string name)
    {
        if (parameters.ValueKind == JsonValueKind.Object &&
            parameters.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.Array)
        {
            return value;
        }

        throw new InvalidOperationException($"Missing required cron array: {name}");
    }

    private static string? GetRawJson(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value))
        {
            return null;
        }

        return value.ValueKind == JsonValueKind.Null ? null : value.GetRawText();
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new CronMutationResult(true, changed, null),
            WorkerJsonContext.Default.CronMutationResult);
    }

    private static WorkerResponse Mutation(CronMutationResult result)
    {
        return WorkerResponse.Json(result, WorkerJsonContext.Default.CronMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new CronMutationResult(false, 0, error),
            WorkerJsonContext.Default.CronMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required cron field: {name}");
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
