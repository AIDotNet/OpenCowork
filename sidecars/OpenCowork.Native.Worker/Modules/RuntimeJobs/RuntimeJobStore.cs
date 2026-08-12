using Microsoft.Data.Sqlite;

internal static class RuntimeJobStore
{
    private static readonly object SchemaSync = new();
    private static bool schemaReady;

    public static string DbPath
    {
        get
        {
            var overridePath = Environment.GetEnvironmentVariable(
                "OPEN_COWORK_RUNTIME_DB_PATH")?.Trim();
            return string.IsNullOrEmpty(overridePath)
                ? DbConnectionFactory.ResolveDbPath(default)
                : Path.GetFullPath(overridePath);
        }
    }

    public static void EnsureReady()
    {
        if (Volatile.Read(ref schemaReady))
        {
            return;
        }

        lock (SchemaSync)
        {
            if (schemaReady)
            {
                return;
            }

            using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
            // Isolated test/runtime DBs only need the Job outbox. The shared
            // ~/.open-cowork/data.db must get the full app schema — otherwise a
            // CLI-only first start creates a Job-only file and later
            // db/sessions-* calls fail with "no such table: sessions".
            var isolatedRuntimeDb = !string.IsNullOrEmpty(
                Environment.GetEnvironmentVariable("OPEN_COWORK_RUNTIME_DB_PATH")?.Trim());
            if (isolatedRuntimeDb)
            {
                DbSchemaMigrator.CreateRuntimeJobTables(connection);
            }
            else
            {
                DbSchemaMigrator.Initialize(connection);
            }
            Volatile.Write(ref schemaReady, true);
        }
    }

    public static void AcquireLease(string hostId, string workerInstanceId, long now, long expiresAt)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var transaction = connection.BeginTransaction();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO runtime_host_leases (
                  host_id, worker_instance_id, acquired_at, renewed_at, expires_at
                ) VALUES ($hostId, $worker, $now, $now, $expiresAt)
                ON CONFLICT(host_id) DO UPDATE SET
                  worker_instance_id = excluded.worker_instance_id,
                  acquired_at = excluded.acquired_at,
                  renewed_at = excluded.renewed_at,
                  expires_at = excluded.expires_at;
                """;
            command.Parameters.AddWithValue("$hostId", hostId);
            command.Parameters.AddWithValue("$worker", workerInstanceId);
            command.Parameters.AddWithValue("$now", now);
            command.Parameters.AddWithValue("$expiresAt", expiresAt);
            command.ExecuteNonQuery();
        }

        using (var verify = connection.CreateCommand())
        {
            verify.Transaction = transaction;
            verify.CommandText =
                "SELECT worker_instance_id FROM runtime_host_leases WHERE host_id = $hostId";
            verify.Parameters.AddWithValue("$hostId", hostId);
            var owner = verify.ExecuteScalar() as string;
            if (!string.Equals(owner, workerInstanceId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Runtime host '{hostId}' is already owned by another live worker.");
            }
        }
        transaction.Commit();
    }

    public static void RenewLease(string hostId, string workerInstanceId, long now, long expiresAt)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE runtime_host_leases
               SET renewed_at = $now, expires_at = $expiresAt
             WHERE host_id = $hostId AND worker_instance_id = $worker;
            """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$worker", workerInstanceId);
        command.Parameters.AddWithValue("$now", now);
        command.Parameters.AddWithValue("$expiresAt", expiresAt);
        if (command.ExecuteNonQuery() != 1)
        {
            throw new InvalidOperationException($"Runtime host lease was lost: {hostId}");
        }
    }

    public static int FailInterruptedJobs(string hostId, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE runtime_jobs
               SET state = 'failed',
                   params_json = '{}',
                   updated_at = $now,
                   finished_at = $now,
                   error_code = 'worker_interrupted',
                   error_message = 'The worker stopped while this job was running.',
                   owner_instance_id = NULL
             WHERE host_id = $hostId AND state IN ('running', 'cancelling');
            """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$now", now);
        return command.ExecuteNonQuery();
    }

    public static RuntimeJobSubmission Submit(
        string jobId,
        string hostId,
        string idempotencyKey,
        string method,
        string paramsJson,
        string? sessionId,
        string? runId,
        string laneKey,
        long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var transaction = connection.BeginTransaction();
        var inserted = 0;
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                INSERT OR IGNORE INTO runtime_jobs (
                  job_id, host_id, idempotency_key, method, params_json, session_id, run_id,
                  lane_key, state, created_at, updated_at
                ) VALUES (
                  $jobId, $hostId, $idempotencyKey, $method, $paramsJson, $sessionId, $runId,
                  $laneKey, 'queued', $now, $now
                );
                """;
            command.Parameters.AddWithValue("$jobId", jobId);
            command.Parameters.AddWithValue("$hostId", hostId);
            command.Parameters.AddWithValue("$idempotencyKey", idempotencyKey);
            command.Parameters.AddWithValue("$method", method);
            command.Parameters.AddWithValue("$paramsJson", paramsJson);
            command.Parameters.AddWithValue("$sessionId", (object?)sessionId ?? DBNull.Value);
            command.Parameters.AddWithValue("$runId", (object?)runId ?? DBNull.Value);
            command.Parameters.AddWithValue("$laneKey", laneKey);
            command.Parameters.AddWithValue("$now", now);
            inserted = command.ExecuteNonQuery();
        }

        RuntimeJobRecord job;
        using (var select = connection.CreateCommand())
        {
            select.Transaction = transaction;
            select.CommandText = """
                SELECT job_id, host_id, idempotency_key, method, '{}' AS params_json, session_id, run_id,
                       lane_key, state, created_at, updated_at, started_at, finished_at,
                       result_json, error_code, error_message
                  FROM runtime_jobs
                 WHERE host_id = $hostId AND idempotency_key = $idempotencyKey;
                """;
            select.Parameters.AddWithValue("$hostId", hostId);
            select.Parameters.AddWithValue("$idempotencyKey", idempotencyKey);
            using var reader = select.ExecuteReader();
            if (!reader.Read())
            {
                throw new IOException("The durable job transaction did not return the committed row.");
            }
            job = ReadJob(reader);
        }

        if (!string.Equals(job.Method, method, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "An idempotency key cannot be reused for a different worker method.");
        }

        transaction.Commit();
        return new RuntimeJobSubmission(true, inserted == 0, job);
    }

    public static RuntimeJobRecord? Get(string hostId, string jobId)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT job_id, host_id, idempotency_key, method, '{}' AS params_json, session_id, run_id,
                   lane_key, state, created_at, updated_at, started_at, finished_at,
                   result_json, error_code, error_message
              FROM runtime_jobs
             WHERE host_id = $hostId AND job_id = $jobId;
            """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$jobId", jobId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ReadJob(reader) : null;
    }

    public static List<RuntimeJobRecord> List(string hostId, int limit, string? state = null)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = state is null
            ? """
                SELECT job_id, host_id, idempotency_key, method, '{}' AS params_json, session_id, run_id,
                       lane_key, state, created_at, updated_at, started_at, finished_at,
                       NULL AS result_json, error_code, error_message
                  FROM runtime_jobs WHERE host_id = $hostId
                 ORDER BY created_at DESC, job_id DESC LIMIT $limit;
                """
            : """
                SELECT job_id, host_id, idempotency_key, method, '{}' AS params_json, session_id, run_id,
                       lane_key, state, created_at, updated_at, started_at, finished_at,
                       NULL AS result_json, error_code, error_message
                  FROM runtime_jobs WHERE host_id = $hostId AND state = $state
                 ORDER BY created_at DESC, job_id DESC LIMIT $limit;
                """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 1000));
        if (state is not null)
        {
            command.Parameters.AddWithValue("$state", state);
        }
        using var reader = command.ExecuteReader();
        var jobs = new List<RuntimeJobRecord>();
        while (reader.Read())
        {
            jobs.Add(ReadJob(reader));
        }
        return jobs;
    }

    public static List<RuntimeJobRecord> ReadQueued(string hostId, int limit)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT queued.job_id, queued.host_id, queued.idempotency_key, queued.method,
                   queued.params_json, queued.session_id, queued.run_id, queued.lane_key,
                   queued.state, queued.created_at, queued.updated_at, queued.started_at,
                   queued.finished_at, queued.result_json, queued.error_code,
                   queued.error_message
              FROM runtime_jobs queued
             WHERE queued.host_id = $hostId AND queued.state = 'queued'
               AND NOT EXISTS (
                 SELECT 1
                   FROM runtime_jobs earlier
                  WHERE earlier.host_id = queued.host_id
                    AND earlier.lane_key = queued.lane_key
                    AND earlier.state = 'queued'
                    AND (
                      earlier.created_at < queued.created_at OR
                      (earlier.created_at = queued.created_at AND earlier.rowid < queued.rowid)
                    )
               )
             ORDER BY queued.created_at, queued.rowid LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$limit", limit);
        using var reader = command.ExecuteReader();
        var jobs = new List<RuntimeJobRecord>();
        while (reader.Read())
        {
            jobs.Add(ReadJob(reader));
        }
        return jobs;
    }

    public static bool TryClaim(string hostId, string jobId, string workerInstanceId, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE runtime_jobs
               SET state = 'running', owner_instance_id = $worker,
                   started_at = $now, updated_at = $now
             WHERE host_id = $hostId AND job_id = $jobId AND state = 'queued'
               AND EXISTS (
                 SELECT 1 FROM runtime_host_leases
                  WHERE host_id = $hostId AND worker_instance_id = $worker
               );
            """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$jobId", jobId);
        command.Parameters.AddWithValue("$worker", workerInstanceId);
        command.Parameters.AddWithValue("$now", now);
        return command.ExecuteNonQuery() == 1;
    }

    public static void Finish(
        string hostId,
        string jobId,
        string state,
        string? resultJson,
        string? errorCode,
        string? errorMessage,
        long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE runtime_jobs
               SET state = $state, params_json = '{}', result_json = $resultJson,
                   error_code = $errorCode, error_message = $errorMessage,
                   updated_at = $now, finished_at = $now, owner_instance_id = NULL
             WHERE host_id = $hostId AND job_id = $jobId
               AND state IN ('running', 'cancelling');
            """;
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$jobId", jobId);
        command.Parameters.AddWithValue("$state", state);
        command.Parameters.AddWithValue("$resultJson", (object?)resultJson ?? DBNull.Value);
        command.Parameters.AddWithValue("$errorCode", (object?)errorCode ?? DBNull.Value);
        command.Parameters.AddWithValue("$errorMessage", (object?)errorMessage ?? DBNull.Value);
        command.Parameters.AddWithValue("$now", now);
        command.ExecuteNonQuery();
    }

    public static string? RequestCancellation(string hostId, string jobId, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var transaction = connection.BeginTransaction();
        string? state;
        using (var select = connection.CreateCommand())
        {
            select.Transaction = transaction;
            select.CommandText =
                "SELECT state FROM runtime_jobs WHERE host_id = $hostId AND job_id = $jobId";
            select.Parameters.AddWithValue("$hostId", hostId);
            select.Parameters.AddWithValue("$jobId", jobId);
            state = select.ExecuteScalar() as string;
        }

        if (state == "queued")
        {
            using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = """
                UPDATE runtime_jobs
                   SET state = 'cancelled', params_json = '{}',
                       updated_at = $now, finished_at = $now,
                       error_code = 'cancelled', error_message = 'Job cancelled before execution.'
                 WHERE host_id = $hostId AND job_id = $jobId AND state = 'queued';
                """;
            update.Parameters.AddWithValue("$hostId", hostId);
            update.Parameters.AddWithValue("$jobId", jobId);
            update.Parameters.AddWithValue("$now", now);
            update.ExecuteNonQuery();
            state = "cancelled";
        }
        else if (state == "running")
        {
            using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = """
                UPDATE runtime_jobs SET state = 'cancelling', updated_at = $now
                 WHERE host_id = $hostId AND job_id = $jobId AND state = 'running';
                """;
            update.Parameters.AddWithValue("$hostId", hostId);
            update.Parameters.AddWithValue("$jobId", jobId);
            update.Parameters.AddWithValue("$now", now);
            update.ExecuteNonQuery();
            state = "cancelling";
        }

        transaction.Commit();
        return state;
    }

    public static long AppendCommand(string jobId, string kind, string payloadJson, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var transaction = connection.BeginTransaction();
        long seq;
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText =
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM runtime_job_commands WHERE job_id = $jobId";
            command.Parameters.AddWithValue("$jobId", jobId);
            seq = (long)(command.ExecuteScalar() ?? 1L);
        }
        using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO runtime_job_commands (job_id, seq, kind, payload_json, created_at)
                VALUES ($jobId, $seq, $kind, $payload, $now);
                """;
            insert.Parameters.AddWithValue("$jobId", jobId);
            insert.Parameters.AddWithValue("$seq", seq);
            insert.Parameters.AddWithValue("$kind", kind);
            insert.Parameters.AddWithValue("$payload", payloadJson);
            insert.Parameters.AddWithValue("$now", now);
            insert.ExecuteNonQuery();
        }
        transaction.Commit();
        return seq;
    }

    public static List<RuntimeJobCommand> ReadPendingCommands(string jobId)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT command_id, seq, kind, payload_json
              FROM runtime_job_commands
             WHERE job_id = $jobId AND consumed_at IS NULL ORDER BY seq;
            """;
        command.Parameters.AddWithValue("$jobId", jobId);
        using var reader = command.ExecuteReader();
        var commands = new List<RuntimeJobCommand>();
        while (reader.Read())
        {
            commands.Add(new RuntimeJobCommand(
                reader.GetInt64(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3)));
        }
        return commands;
    }

    public static bool TryConsumeCommand(long commandId, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE runtime_job_commands SET consumed_at = $now
             WHERE command_id = $commandId AND consumed_at IS NULL;
            """;
        command.Parameters.AddWithValue("$commandId", commandId);
        command.Parameters.AddWithValue("$now", now);
        return command.ExecuteNonQuery() == 1;
    }

    public static bool TryConsumeCommand(string jobId, long seq, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE runtime_job_commands SET consumed_at = $now
             WHERE job_id = $jobId AND seq = $seq AND consumed_at IS NULL;
            """;
        command.Parameters.AddWithValue("$jobId", jobId);
        command.Parameters.AddWithValue("$seq", seq);
        command.Parameters.AddWithValue("$now", now);
        return command.ExecuteNonQuery() == 1;
    }

    public static void AppendEvent(
        string jobId,
        long seq,
        ReadOnlyMemory<byte> payload,
        bool terminal,
        long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO runtime_event_batches (
              job_id, seq, payload, byte_length, terminal, created_at
            ) VALUES ($jobId, $seq, $payload, $bytes, $terminal, $now);
            """;
        command.Parameters.AddWithValue("$jobId", jobId);
        command.Parameters.AddWithValue("$seq", seq);
        command.Parameters.Add("$payload", SqliteType.Blob).Value = payload.ToArray();
        command.Parameters.AddWithValue("$bytes", payload.Length);
        command.Parameters.AddWithValue("$terminal", terminal ? 1 : 0);
        command.Parameters.AddWithValue("$now", now);
        command.ExecuteNonQuery();
    }

    public static void Ack(string consumerId, string jobId, long throughSeq, long now)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO runtime_event_cursors (consumer_id, job_id, through_seq, updated_at)
            VALUES ($consumer, $jobId, $seq, $now)
            ON CONFLICT(consumer_id, job_id) DO UPDATE SET
              through_seq = MAX(runtime_event_cursors.through_seq, excluded.through_seq),
              updated_at = excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$consumer", consumerId);
        command.Parameters.AddWithValue("$jobId", jobId);
        command.Parameters.AddWithValue("$seq", throughSeq);
        command.Parameters.AddWithValue("$now", now);
        command.ExecuteNonQuery();
    }

    public static List<RuntimeEventBatch> Replay(
        string hostId,
        string consumerId,
        string? jobId,
        long? sinceSeq,
        int limit)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = jobId is null
            ? """
                SELECT e.job_id, e.seq, e.payload, e.terminal
                  FROM runtime_event_batches e
                  JOIN runtime_jobs j ON j.job_id = e.job_id
                  LEFT JOIN runtime_event_cursors c
                    ON c.consumer_id = $consumer AND c.job_id = e.job_id
                 WHERE j.host_id = $hostId
                   AND e.seq > COALESCE(c.through_seq, 0)
                 ORDER BY e.created_at, e.job_id, e.seq LIMIT $limit;
                """
            : """
                SELECT e.job_id, e.seq, e.payload, e.terminal
                  FROM runtime_event_batches e
                  JOIN runtime_jobs j ON j.job_id = e.job_id
                  LEFT JOIN runtime_event_cursors c
                    ON c.consumer_id = $consumer AND c.job_id = e.job_id
                 WHERE j.host_id = $hostId AND e.job_id = $jobId
                   AND e.seq > MAX(COALESCE(c.through_seq, 0), $sinceSeq)
                 ORDER BY e.seq LIMIT $limit;
                """;
        command.Parameters.AddWithValue("$consumer", consumerId);
        command.Parameters.AddWithValue("$hostId", hostId);
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 4096));
        if (jobId is not null)
        {
            command.Parameters.AddWithValue("$jobId", jobId);
            command.Parameters.AddWithValue("$sinceSeq", sinceSeq ?? 0);
        }
        using var reader = command.ExecuteReader();
        var batches = new List<RuntimeEventBatch>();
        while (reader.Read())
        {
            batches.Add(new RuntimeEventBatch(
                reader.GetString(0),
                reader.GetInt64(1),
                (byte[])reader[2],
                reader.GetInt64(3) != 0));
        }
        return batches;
    }

    public static int CleanupEvents(long cutoff)
    {
        EnsureReady();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbPath);
        using var command = connection.CreateCommand();
        command.CommandText = """
            DELETE FROM runtime_event_batches
             WHERE job_id IN (
               SELECT job_id FROM runtime_jobs
                WHERE state IN ('succeeded', 'failed', 'cancelled')
                  AND finished_at IS NOT NULL AND finished_at < $cutoff
             );
            """;
        command.Parameters.AddWithValue("$cutoff", cutoff);
        return command.ExecuteNonQuery();
    }

    private static RuntimeJobRecord ReadJob(SqliteDataReader reader)
    {
        return new RuntimeJobRecord(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetInt64(9),
            reader.GetInt64(10),
            reader.IsDBNull(11) ? null : reader.GetInt64(11),
            reader.IsDBNull(12) ? null : reader.GetInt64(12),
            reader.IsDBNull(13) ? null : reader.GetString(13),
            reader.IsDBNull(14) ? null : reader.GetString(14),
            reader.IsDBNull(15) ? null : reader.GetString(15));
    }
}
