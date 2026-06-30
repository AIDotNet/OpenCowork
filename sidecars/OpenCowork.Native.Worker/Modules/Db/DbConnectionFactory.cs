using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbConnectionFactory
{
    private static bool sqliteInitialized;

    public static SqliteConnection OpenReadWrite(JsonElement parameters)
    {
        return OpenReadWrite(ResolveDbPath(parameters));
    }

    public static SqliteConnection OpenReadWriteCreate(JsonElement parameters)
    {
        return OpenReadWriteCreate(ResolveDbPath(parameters));
    }

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
        ExecutePragma(connection, "PRAGMA busy_timeout = 5000");
        ExecutePragma(connection, "PRAGMA journal_mode = WAL");
        ExecutePragma(connection, "PRAGMA synchronous = NORMAL");
        ExecutePragma(connection, "PRAGMA wal_autocheckpoint = 4000");
        ExecutePragma(connection, "PRAGMA cache_size = -16000");
        ExecutePragma(connection, "PRAGMA foreign_keys = ON");
        return connection;
    }

    public static string ResolveDbPath(JsonElement parameters)
    {
        if (JsonHelpers.GetString(parameters, "dbPath") is { Length: > 0 } dbPath)
        {
            return Path.GetFullPath(dbPath);
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".open-cowork",
            "data.db");
    }

    private static void EnsureSqliteInitialized()
    {
        if (sqliteInitialized)
        {
            return;
        }

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
