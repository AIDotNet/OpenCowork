using Microsoft.Data.Sqlite;

// Graph-tuned SQLite connection factory for the per-project CodeGraph DB.
// Mirrors the SHAPE of the main worker's DbConnectionFactory (lazy
// Batteries_V2.Init(), private-cache builder, parent-dir create) but applies
// GRAPH pragmas (Decision 4) — larger cache, memory temp store, mmap — instead
// of data.db's OLTP pragmas. Never call DbConnectionFactory.Open* for a graph
// DB: it sets the wrong pragmas (wal_autocheckpoint=4000, cache_size=-16000).
internal static class CodeGraphConnectionFactory
{
    private static bool sqliteInitialized;

    public static SqliteConnection OpenReadWrite(string dbPath)
    {
        return Open(dbPath, SqliteOpenMode.ReadWrite);
    }

    public static SqliteConnection OpenReadWriteCreate(string dbPath)
    {
        return Open(dbPath, SqliteOpenMode.ReadWriteCreate);
    }

    // READ-ONLY connection for the query pool (analysis/04 §5.1): WAL readers run
    // concurrently with the single writer and each other. query_only hard-stops any
    // accidental write; journal_mode/foreign_keys are writer concerns and skipped
    // (WAL is a database property, not per-connection).
    public static SqliteConnection OpenReadOnly(string dbPath)
    {
        EnsureSqliteInitialized();

        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Private
        };

        var connection = new SqliteConnection(builder.ToString());
        connection.Open();

        ExecutePragma(connection, "PRAGMA busy_timeout = 5000");
        ExecutePragma(connection, "PRAGMA query_only = ON");
        ExecutePragma(connection, "PRAGMA cache_size = -64000");     // 64 MB
        ExecutePragma(connection, "PRAGMA temp_store = MEMORY");
        ExecutePragma(connection, "PRAGMA mmap_size = 268435456");   // 256 MB
        return connection;
    }

    private static SqliteConnection Open(string dbPath, SqliteOpenMode mode)
    {
        EnsureSqliteInitialized();
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath) ?? ".");

        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = mode,
            Cache = SqliteCacheMode.Private
        };

        var connection = new SqliteConnection(builder.ToString());
        connection.Open();

        // Order is load-bearing: busy_timeout BEFORE journal_mode so a concurrent
        // writer's lock is waited out, not thrown (#238). foreign_keys is per-
        // connection and must be re-set on every open.
        ExecutePragma(connection, "PRAGMA busy_timeout = 5000");
        ExecutePragma(connection, "PRAGMA foreign_keys = ON");
        ExecutePragma(connection, "PRAGMA journal_mode = WAL");
        ExecutePragma(connection, "PRAGMA synchronous = NORMAL");
        ExecutePragma(connection, "PRAGMA cache_size = -64000");     // 64 MB
        ExecutePragma(connection, "PRAGMA temp_store = MEMORY");
        ExecutePragma(connection, "PRAGMA mmap_size = 268435456");   // 256 MB
        return connection;
    }

    // ------------------------------------------------------------------
    // WAL helpers (analysis/03 §2.5 / §6.7) — bulk-index checkpoint plumbing.
    // The valve (CodeGraphWalValve) and IndexAll drive these; correctness never
    // depends on any of them (SQLite replays the WAL on the next open).
    // ------------------------------------------------------------------

    // Size of the `-wal` sidecar in bytes; 0 when it doesn't exist (non-WAL mode,
    // in-memory DB, or no write since the last checkpoint+reset). ≙ getWalSizeBytes.
    public static long GetWalSizeBytes(string dbPath)
    {
        if (string.IsNullOrEmpty(dbPath) || dbPath == ":memory:")
        {
            return 0;
        }

        try
        {
            var info = new FileInfo(dbPath + "-wal");
            return info.Exists ? info.Length : 0;
        }
        catch
        {
            return 0;
        }
    }

    // Current `wal_autocheckpoint` interval in pages (0 = disabled). ≙ getWalAutocheckpoint.
    public static int GetWalAutocheckpoint(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA wal_autocheckpoint";
        var value = command.ExecuteScalar();
        return value is null || value == DBNull.Value ? 0 : Convert.ToInt32(value);
    }

    // Set the connection's `wal_autocheckpoint` interval (pages; 0 disables). Bulk
    // indexing defers checkpoints entirely (#1231) — see CodeGraphWalValve for why.
    // ≙ setWalAutocheckpoint.
    // Fast-init durability trade (M7-W2): `OFF` during a FRESH index only — an
    // interrupted first index is simply re-run (index_state stays 'indexing') — then
    // restored to `NORMAL`. Levels are a fixed internal set, never user input.
    public static void SetSynchronous(SqliteConnection connection, string level) =>
        ExecutePragma(connection, "PRAGMA synchronous = " + level);

    public static void SetWalAutocheckpoint(SqliteConnection connection, int pages)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA wal_autocheckpoint = " + Math.Max(0, pages).ToString(System.Globalization.CultureInfo.InvariantCulture);
        command.ExecuteNonQuery();
    }

    // Journal mode of the connection (lowercase, e.g. "wal"). ≙ getJournalMode.
    public static string GetJournalMode(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA journal_mode";
        return (command.ExecuteScalar() as string ?? string.Empty).ToLowerInvariant();
    }

    // `PRAGMA wal_checkpoint(PASSIVE)` on a WORKER thread with its own connection
    // (Task.Run + a second SqliteConnection). PASSIVE never blocks the writer, and
    // off-thread means the caller keeps turning even when the backfill is minutes of
    // I/O on slow storage. Returns SQLite's checkpoint row — busy==0 && log==checkpointed
    // means the ENTIRE WAL was backfilled (the writer's next commit wraps it and the
    // file stops growing). Best-effort: null on any failure. ≙ checkpointWalPassive.
    public static Task<CodeGraphWalCheckpointResult?> CheckpointWalPassiveAsync(string dbPath)
    {
        if (string.IsNullOrEmpty(dbPath) || dbPath == ":memory:")
        {
            return Task.FromResult<CodeGraphWalCheckpointResult?>(null);
        }

        return Task.Run<CodeGraphWalCheckpointResult?>(() =>
        {
            try
            {
                using var connection = OpenReadWrite(dbPath);
                using var command = connection.CreateCommand();
                command.CommandText = "PRAGMA wal_checkpoint(PASSIVE)";
                using var reader = command.ExecuteReader();
                if (!reader.Read())
                {
                    return null;
                }

                return new CodeGraphWalCheckpointResult(
                    Convert.ToInt32(reader.GetValue(0)),
                    Convert.ToInt32(reader.GetValue(1)),
                    Convert.ToInt32(reader.GetValue(2)));
            }
            catch
            {
                return null;
            }
        });
    }

    // Lightweight post-bulk maintenance on a WORKER thread with its own connection:
    // PRAGMA optimize (incremental ANALYZE, persisted in sqlite_stat) + a TRUNCATE
    // checkpoint to fold the bulk WAL back and reset the file. Best-effort; every
    // statement is swallowed on failure. ≙ runMaintenance.
    public static Task RunMaintenanceAsync(string dbPath)
    {
        if (string.IsNullOrEmpty(dbPath) || dbPath == ":memory:")
        {
            return Task.CompletedTask;
        }

        return Task.Run(() =>
        {
            try
            {
                using var connection = OpenReadWrite(dbPath);
                foreach (var pragma in new[] { "PRAGMA analysis_limit=1000", "PRAGMA optimize", "PRAGMA wal_checkpoint(TRUNCATE)" })
                {
                    try
                    {
                        using var command = connection.CreateCommand();
                        command.CommandText = pragma;
                        command.ExecuteNonQuery();
                    }
                    catch
                    {
                        // each pragma is individually best-effort
                    }
                }
            }
            catch
            {
                // whole maintenance is best-effort — never load-bearing for correctness
            }
        });
    }

    private static void EnsureSqliteInitialized()
    {
        if (sqliteInitialized)
        {
            return;
        }

        // Process-global, idempotent — safe to call here and in DbConnectionFactory.
        SQLitePCL.Batteries_V2.Init();
        sqliteInitialized = true;
    }

    private static void ExecutePragma(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
