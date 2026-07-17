using Microsoft.Data.Sqlite;

// Runtime proof that FTS5 is compiled into the bundled SQLite (SQLitePCLRaw
// bundle_e_sqlite3) — this is what codegraph/db-smoke returns. It opens a throw-
// away graph DB through the real CodeGraphConnectionFactory, creates an FTS5
// virtual table, inserts, runs a MATCH, and reads sqlite_version(). If FTS5 were
// absent, CREATE VIRTUAL TABLE ... USING fts5 throws and we return the error.
internal static class CodeGraphDbSmoke
{
    public static CodeGraphDbSmokeResult Run()
    {
        var dir = Path.Combine(Path.GetTempPath(), "opencowork-codegraph-smoke");
        var dbPath = Path.Combine(dir, $"fts5-smoke-{Guid.NewGuid():N}.db");

        try
        {
            using (var connection = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath))
            {
                ExecuteNonQuery(connection, "CREATE VIRTUAL TABLE t USING fts5(x)");
                ExecuteNonQuery(
                    connection,
                    "INSERT INTO t(x) VALUES ('order lookup by name'), ('unrelated content')");

                var matchCount = ScalarLong(connection, "SELECT COUNT(*) FROM t WHERE t MATCH 'order'");
                if (matchCount < 1)
                {
                    return new CodeGraphDbSmokeResult(false, null, false, $"fts5 MATCH returned {matchCount} rows");
                }

                var sqliteVersion = ScalarString(connection, "SELECT sqlite_version()");
                return new CodeGraphDbSmokeResult(true, sqliteVersion, true, null);
            }
        }
        catch (Exception ex)
        {
            return new CodeGraphDbSmokeResult(false, null, false, ex.Message);
        }
        finally
        {
            TryCleanup(dbPath);
        }
    }

    private static void ExecuteNonQuery(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static long ScalarLong(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        var value = command.ExecuteScalar();
        return value is null || value == DBNull.Value ? 0 : Convert.ToInt64(value);
    }

    private static string? ScalarString(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar() as string;
    }

    private static void TryCleanup(string dbPath)
    {
        try
        {
            // Release the pooled native handle so the WAL/SHM/DB files can be removed.
            SqliteConnection.ClearAllPools();
            foreach (var suffix in new[] { "", "-wal", "-shm" })
            {
                var path = dbPath + suffix;
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
        }
        catch
        {
            // Best-effort — a leftover temp file must never fail the smoke result.
        }
    }
}
