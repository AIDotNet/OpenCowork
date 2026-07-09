using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbHookTools
{
    private const int DefaultRunHistoryLimit = 50;
    private const int MaxRunHistoryLimit = 200;
    private const int MaxRetainedRunRows = 1000;

    private static SqliteConnection OpenDefaultConnection()
    {
        return DbConnectionFactory.OpenReadWrite(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "data.db"));
    }

    public static WorkerResponse ListTrusts(JsonElement parameters)
    {
        _ = parameters;
        try
        {
            using var connection = OpenDefaultConnection();
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id,
                       identity_key,
                       trust_key,
                       source_kind,
                       source_path,
                       source_real_path,
                       source_config_hash,
                       project_id,
                       project_root,
                       project_root_real_path,
                       event_name,
                       matcher,
                       handler_type,
                       command,
                       resolved_cwd,
                       env_fingerprint,
                       definition_hash,
                       artifact_hashes_json,
                       status,
                       local_disabled,
                       snapshot_json,
                       last_reviewed_at,
                       created_at,
                       updated_at
                  FROM hook_trusts
                ORDER BY updated_at DESC
                """;
            var rows = new List<HookTrustRow>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadTrustRow(reader));
            }
            return WorkerResponse.Json(
                new HookTrustListResult(true, rows, null),
                WorkerJsonContext.Default.HookTrustListResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new HookTrustListResult(false, [], ex.Message),
                WorkerJsonContext.Default.HookTrustListResult);
        }
    }

    public static WorkerResponse UpsertTrust(JsonElement parameters)
    {
        try
        {
            var row = ReadTrustInput(parameters);
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO hook_trusts (
                  id, identity_key, trust_key, source_kind, source_path, source_real_path,
                  source_config_hash, project_id, project_root, project_root_real_path,
                  event_name, matcher, handler_type, command, resolved_cwd, env_fingerprint,
                  definition_hash, artifact_hashes_json, status, local_disabled, snapshot_json,
                  last_reviewed_at, created_at, updated_at
                ) VALUES (
                  $id, $identityKey, $trustKey, $sourceKind, $sourcePath, $sourceRealPath,
                  $sourceConfigHash, $projectId, $projectRoot, $projectRootRealPath,
                  $eventName, $matcher, $handlerType, $command, $resolvedCwd, $envFingerprint,
                  $definitionHash, $artifactHashesJson, $status, $localDisabled, $snapshotJson,
                  $lastReviewedAt, $createdAt, $updatedAt
                )
                ON CONFLICT(trust_key) DO UPDATE SET
                  identity_key = excluded.identity_key,
                  source_kind = excluded.source_kind,
                  source_path = excluded.source_path,
                  source_real_path = excluded.source_real_path,
                  source_config_hash = excluded.source_config_hash,
                  project_id = excluded.project_id,
                  project_root = excluded.project_root,
                  project_root_real_path = excluded.project_root_real_path,
                  event_name = excluded.event_name,
                  matcher = excluded.matcher,
                  handler_type = excluded.handler_type,
                  command = excluded.command,
                  resolved_cwd = excluded.resolved_cwd,
                  env_fingerprint = excluded.env_fingerprint,
                  definition_hash = excluded.definition_hash,
                  artifact_hashes_json = excluded.artifact_hashes_json,
                  status = excluded.status,
                  local_disabled = excluded.local_disabled,
                  snapshot_json = excluded.snapshot_json,
                  last_reviewed_at = excluded.last_reviewed_at,
                  updated_at = excluded.updated_at
                """,
                TrustParams(row));
            transaction.Commit();
            return WorkerResponse.Json(
                new HookTrustMutationResult(true, changed, row, null),
                WorkerJsonContext.Default.HookTrustMutationResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new HookTrustMutationResult(false, 0, null, ex.Message),
                WorkerJsonContext.Default.HookTrustMutationResult);
        }
    }

    public static WorkerResponse InsertRun(JsonElement parameters)
    {
        try
        {
            var row = ReadRunInput(parameters);
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO hook_runs (
                  id, trust_key, run_id, session_id, event_name, started_at, completed_at,
                  duration_ms, status, exit_code, skipped_reason, stdout_preview, stderr_preview,
                  decision_json, error, retained_until
                ) VALUES (
                  $id, $trustKey, $runId, $sessionId, $eventName, $startedAt, $completedAt,
                  $durationMs, $status, $exitCode, $skippedReason, $stdoutPreview, $stderrPreview,
                  $decisionJson, $error, $retainedUntil
                )
                """,
                RunParams(row));
            transaction.Commit();
            return WorkerResponse.Json(
                new HookRunMutationResult(true, changed, null),
                WorkerJsonContext.Default.HookRunMutationResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new HookRunMutationResult(false, 0, ex.Message),
                WorkerJsonContext.Default.HookRunMutationResult);
        }
    }

    public static WorkerResponse ListRuns(JsonElement parameters)
    {
        try
        {
            var trustKey = JsonHelpers.GetString(parameters, "trustKey") ?? string.Empty;
            if (string.IsNullOrWhiteSpace(trustKey))
            {
                throw new InvalidOperationException("trustKey is required");
            }

            var limit = Math.Clamp(
                JsonHelpers.GetInt(parameters, "limit", DefaultRunHistoryLimit),
                1,
                MaxRunHistoryLimit);
            using var connection = OpenDefaultConnection();
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id,
                       trust_key,
                       run_id,
                       session_id,
                       event_name,
                       started_at,
                       completed_at,
                       duration_ms,
                       status,
                       exit_code,
                       skipped_reason,
                       stdout_preview,
                       stderr_preview,
                       decision_json,
                       error,
                       retained_until
                  FROM hook_runs
                 WHERE trust_key = $trustKey
                ORDER BY started_at DESC
                 LIMIT $limit
                """;
            command.Parameters.AddWithValue("$trustKey", trustKey);
            command.Parameters.AddWithValue("$limit", limit);
            var rows = new List<HookRunRow>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadRunRow(reader));
            }
            return WorkerResponse.Json(
                new HookRunListResult(true, rows, null),
                WorkerJsonContext.Default.HookRunListResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new HookRunListResult(false, [], ex.Message),
                WorkerJsonContext.Default.HookRunListResult);
        }
    }

    public static WorkerResponse CleanupRuns(JsonElement parameters)
    {
        try
        {
            var cutoff = JsonHelpers.GetLong(parameters, "cutoff", DateTimeOffset.UtcNow.AddDays(-30).ToUnixTimeMilliseconds());
            using var connection = OpenDefaultConnection();
            using var transaction = connection.BeginTransaction();
            var deletedOld = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM hook_runs WHERE started_at < $cutoff",
                new DbSql.SqlParam("$cutoff", cutoff));
            var deletedOverflow = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                $"""
                DELETE FROM hook_runs
                 WHERE id NOT IN (
                   SELECT id FROM hook_runs ORDER BY started_at DESC LIMIT {MaxRetainedRunRows}
                 )
                """);
            transaction.Commit();
            return WorkerResponse.Json(
                new HookRunMutationResult(true, deletedOld + deletedOverflow, null),
                WorkerJsonContext.Default.HookRunMutationResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new HookRunMutationResult(false, 0, ex.Message),
                WorkerJsonContext.Default.HookRunMutationResult);
        }
    }

    private static HookTrustRow ReadTrustInput(JsonElement parameters)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var id = RequiredString(parameters, "id");
        return new HookTrustRow(
            id,
            RequiredString(parameters, "identityKey"),
            RequiredString(parameters, "trustKey"),
            RequiredString(parameters, "sourceKind"),
            RequiredString(parameters, "sourcePath"),
            RequiredString(parameters, "sourceRealPath"),
            RequiredString(parameters, "sourceConfigHash"),
            JsonHelpers.GetString(parameters, "projectId"),
            JsonHelpers.GetString(parameters, "projectRoot"),
            JsonHelpers.GetString(parameters, "projectRootRealPath"),
            RequiredString(parameters, "eventName"),
            RequiredString(parameters, "matcher"),
            RequiredString(parameters, "handlerType"),
            RequiredString(parameters, "command"),
            RequiredString(parameters, "resolvedCwd"),
            RequiredString(parameters, "envFingerprint"),
            RequiredString(parameters, "definitionHash"),
            JsonHelpers.GetString(parameters, "artifactHashesJson"),
            RequiredString(parameters, "status"),
            JsonHelpers.GetBool(parameters, "localDisabled", false),
            RequiredString(parameters, "snapshotJson"),
            JsonHelpers.GetLongNullable(parameters, "lastReviewedAt"),
            JsonHelpers.GetLong(parameters, "createdAt", now),
            JsonHelpers.GetLong(parameters, "updatedAt", now));
    }

    private static HookRunRow ReadRunInput(JsonElement parameters)
    {
        return new HookRunRow(
            RequiredString(parameters, "id"),
            RequiredString(parameters, "trustKey"),
            JsonHelpers.GetString(parameters, "runId"),
            JsonHelpers.GetString(parameters, "sessionId"),
            RequiredString(parameters, "eventName"),
            JsonHelpers.GetLong(parameters, "startedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            JsonHelpers.GetLongNullable(parameters, "completedAt"),
            JsonHelpers.GetLongNullable(parameters, "durationMs"),
            RequiredString(parameters, "status"),
            JsonHelpers.GetIntNullable(parameters, "exitCode"),
            JsonHelpers.GetString(parameters, "skippedReason"),
            JsonHelpers.GetString(parameters, "stdoutPreview"),
            JsonHelpers.GetString(parameters, "stderrPreview"),
            JsonHelpers.GetString(parameters, "decisionJson"),
            JsonHelpers.GetString(parameters, "error"),
            JsonHelpers.GetLongNullable(parameters, "retainedUntil"));
    }

    private static HookTrustRow ReadTrustRow(SqliteDataReader reader)
    {
        return new HookTrustRow(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            ReadNullableString(reader, 7),
            ReadNullableString(reader, 8),
            ReadNullableString(reader, 9),
            reader.GetString(10),
            reader.GetString(11),
            reader.GetString(12),
            reader.GetString(13),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetString(16),
            ReadNullableString(reader, 17),
            reader.GetString(18),
            reader.GetInt64(19) != 0,
            reader.GetString(20),
            ReadNullableLong(reader, 21),
            reader.GetInt64(22),
            reader.GetInt64(23));
    }

    private static HookRunRow ReadRunRow(SqliteDataReader reader)
    {
        return new HookRunRow(
            reader.GetString(0),
            reader.GetString(1),
            ReadNullableString(reader, 2),
            ReadNullableString(reader, 3),
            reader.GetString(4),
            reader.GetInt64(5),
            ReadNullableLong(reader, 6),
            ReadNullableLong(reader, 7),
            reader.GetString(8),
            ReadNullableInt(reader, 9),
            ReadNullableString(reader, 10),
            ReadNullableString(reader, 11),
            ReadNullableString(reader, 12),
            ReadNullableString(reader, 13),
            ReadNullableString(reader, 14),
            ReadNullableLong(reader, 15));
    }

    private static DbSql.SqlParam[] TrustParams(HookTrustRow row)
    {
        return
        [
            new("$id", row.Id),
            new("$identityKey", row.IdentityKey),
            new("$trustKey", row.TrustKey),
            new("$sourceKind", row.SourceKind),
            new("$sourcePath", row.SourcePath),
            new("$sourceRealPath", row.SourceRealPath),
            new("$sourceConfigHash", row.SourceConfigHash),
            new("$projectId", row.ProjectId),
            new("$projectRoot", row.ProjectRoot),
            new("$projectRootRealPath", row.ProjectRootRealPath),
            new("$eventName", row.EventName),
            new("$matcher", row.Matcher),
            new("$handlerType", row.HandlerType),
            new("$command", row.Command),
            new("$resolvedCwd", row.ResolvedCwd),
            new("$envFingerprint", row.EnvFingerprint),
            new("$definitionHash", row.DefinitionHash),
            new("$artifactHashesJson", row.ArtifactHashesJson),
            new("$status", row.Status),
            new("$localDisabled", row.LocalDisabled ? 1 : 0),
            new("$snapshotJson", row.SnapshotJson),
            new("$lastReviewedAt", row.LastReviewedAt),
            new("$createdAt", row.CreatedAt),
            new("$updatedAt", row.UpdatedAt)
        ];
    }

    private static DbSql.SqlParam[] RunParams(HookRunRow row)
    {
        return
        [
            new("$id", row.Id),
            new("$trustKey", row.TrustKey),
            new("$runId", row.RunId),
            new("$sessionId", row.SessionId),
            new("$eventName", row.EventName),
            new("$startedAt", row.StartedAt),
            new("$completedAt", row.CompletedAt),
            new("$durationMs", row.DurationMs),
            new("$status", row.Status),
            new("$exitCode", row.ExitCode),
            new("$skippedReason", row.SkippedReason),
            new("$stdoutPreview", row.StdoutPreview),
            new("$stderrPreview", row.StderrPreview),
            new("$decisionJson", row.DecisionJson),
            new("$error", row.Error),
            new("$retainedUntil", row.RetainedUntil)
        ];
    }

    private static string RequiredString(JsonElement parameters, string name)
    {
        var value = JsonHelpers.GetString(parameters, name)?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException($"{name} is required");
        }
        return value;
    }

    private static string? ReadNullableString(SqliteDataReader reader, int index)
    {
        return reader.IsDBNull(index) ? null : reader.GetString(index);
    }

    private static long? ReadNullableLong(SqliteDataReader reader, int index)
    {
        return reader.IsDBNull(index) ? null : reader.GetInt64(index);
    }

    private static int? ReadNullableInt(SqliteDataReader reader, int index)
    {
        return reader.IsDBNull(index) ? null : reader.GetInt32(index);
    }
}
