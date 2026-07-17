// Opens a CodeGraphStore over the per-project graph DB: connect through the graph-
// tuned CodeGraphConnectionFactory (never the OLTP data.db factory), fold the final
// schema idempotently (CodeGraphSchema.Initialize), and wrap the live connection in
// a store the CRUD / Search / Graph layers write against. The returned store OWNS
// the connection and disposes it on Dispose.
internal static class CodeGraphStoreFactory
{
    // Open, creating the DB file (and parent dir) if absent, and fold the schema.
    public static CodeGraphStore Open(string dbPath)
    {
        var connection = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
        try
        {
            CodeGraphSchema.Initialize(connection);
            return new CodeGraphStore(connection);
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    // Open an existing graph DB read/write WITHOUT creating it (throws if missing).
    // The schema is still folded idempotently (every DDL statement is IF NOT
    // EXISTS), so a store opened against an externally-created file is usable.
    public static CodeGraphStore OpenExisting(string dbPath)
    {
        var connection = CodeGraphConnectionFactory.OpenReadWrite(dbPath);
        try
        {
            CodeGraphSchema.Initialize(connection);
            return new CodeGraphStore(connection);
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }
}
