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
