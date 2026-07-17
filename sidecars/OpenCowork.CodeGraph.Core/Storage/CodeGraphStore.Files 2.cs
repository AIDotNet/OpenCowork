using Microsoft.Data.Sqlite;

// CodeGraphStore — file-record CRUD (≙ queries.ts File Operations). Change
// detection is by content_hash, not mtime. `errors` is a RAW JSON string kept
// verbatim on the domain type (never modeled).
internal sealed partial class CodeGraphStore
{
    // INSERT ... ON CONFLICT(path) DO UPDATE (queries.ts:1674). Run once per file
    // per index/sync — fresh command is fine.
    public void UpsertFile(CodeGraphFileRecord file) =>
        ExecuteNonQuery(
            """
            INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
            VALUES ($path, $contentHash, $language, $size, $modifiedAt, $indexedAt, $nodeCount, $errors)
            ON CONFLICT(path) DO UPDATE SET
              content_hash = $contentHash,
              language = $language,
              size = $size,
              modified_at = $modifiedAt,
              indexed_at = $indexedAt,
              node_count = $nodeCount,
              errors = $errors
            """,
            new CodeGraphSqlParam("$path", file.Path),
            new CodeGraphSqlParam("$contentHash", file.ContentHash),
            new CodeGraphSqlParam("$language", file.Language),
            new CodeGraphSqlParam("$size", file.Size),
            new CodeGraphSqlParam("$modifiedAt", file.ModifiedAt),
            new CodeGraphSqlParam("$indexedAt", file.IndexedAt),
            new CodeGraphSqlParam("$nodeCount", file.NodeCount),
            new CodeGraphSqlParam("$errors", file.Errors));

    // Delete a file record AND its nodes in one transaction (queries.ts:1705).
    // Deleting the nodes first lets FK ON DELETE CASCADE reap their edges/refs;
    // the file row is removed last.
    public void DeleteFile(string filePath)
    {
        InTransaction(transaction =>
        {
            DeleteNodesByFileCore(filePath, transaction);
            ExecuteNonQuery(
                transaction,
                "DELETE FROM files WHERE path = $path",
                new CodeGraphSqlParam("$path", filePath));
        });
    }

    // Single file record by path (queries.ts:1718), or null.
    public CodeGraphFileRecord? GetFile(string filePath)
    {
        using var command = Connection.CreateCommand();
        command.CommandText = $"SELECT {FileColumns} FROM files WHERE path = $path";
        command.Parameters.AddWithValue("$path", filePath);
        using var reader = command.ExecuteReader();
        return reader.Read() ? RowToFileRecord(reader) : null;
    }

    // All tracked files, ordered by path (queries.ts:1729).
    public List<CodeGraphFileRecord> GetFiles()
    {
        using var command = Connection.CreateCommand();
        command.CommandText = $"SELECT {FileColumns} FROM files ORDER BY path";
        using var reader = command.ExecuteReader();
        var files = new List<CodeGraphFileRecord>();
        while (reader.Read())
        {
            files.Add(RowToFileRecord(reader));
        }

        return files;
    }
}
