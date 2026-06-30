using System.Text.Json;

internal static class DbSchemaTools
{
    public static WorkerResponse Initialize(JsonElement parameters)
    {
        var dbPath = DbConnectionFactory.ResolveDbPath(parameters);
        try
        {
            using var connection = DbConnectionFactory.OpenReadWriteCreate(dbPath);
            DbSchemaMigrator.Initialize(connection);
            return WorkerResponse.Json(
                new DbInitializeResult(true, dbPath, null),
                WorkerJsonContext.Default.DbInitializeResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new DbInitializeResult(false, dbPath, ex.Message),
                WorkerJsonContext.Default.DbInitializeResult);
        }
    }
}
