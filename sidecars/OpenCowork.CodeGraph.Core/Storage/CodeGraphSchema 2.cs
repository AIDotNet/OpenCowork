using Microsoft.Data.Sqlite;

// The FINAL (v8-equivalent) CodeGraph schema, folded — reference/01 §1.
// Migrations v2..v8 are dead history (Decision 18); the port emits the folded
// schema directly and evolves its own future shape via EnsureColumn.
//
// Booleans are stored as INTEGER (0/1). JSON payloads are stored as TEXT.
// Lines are 1-based; columns are 0-based. Every statement is IF NOT EXISTS, so
// Initialize is idempotent and cheap to re-run on a supervised respawn.
internal static class CodeGraphSchema
{
    // Stamp value for schema_versions after create (do NOT replay v1..v8).
    public const int SchemaVersion = 8;

    public const string Ddl = """
        -- =====================================================================
        -- CodeGraph — FINAL schema (v8-equivalent, migrations folded).
        -- =====================================================================

        -- Schema bookkeeping. Port stamps the current version once at create time.
        CREATE TABLE IF NOT EXISTS schema_versions (
            version     INTEGER PRIMARY KEY,
            applied_at  INTEGER NOT NULL,          -- epoch ms
            description TEXT
        );

        -- nodes: code symbols (functions, classes, variables, files, ...).
        CREATE TABLE IF NOT EXISTS nodes (
            id              TEXT PRIMARY KEY,       -- "{kind}:" + sha256(...)[:32]
            kind            TEXT NOT NULL,
            name            TEXT NOT NULL,
            qualified_name  TEXT NOT NULL,
            file_path       TEXT NOT NULL,
            language        TEXT NOT NULL,
            start_line      INTEGER NOT NULL,       -- 1-based
            end_line        INTEGER NOT NULL,       -- 1-based
            start_column    INTEGER NOT NULL,       -- 0-based
            end_column      INTEGER NOT NULL,       -- 0-based
            docstring       TEXT,
            signature       TEXT,
            visibility      TEXT,                   -- 'public'|'private'|'protected'|'internal'
            is_exported     INTEGER DEFAULT 0,      -- BOOLEAN-as-INTEGER
            is_async        INTEGER DEFAULT 0,      -- BOOLEAN-as-INTEGER
            is_static       INTEGER DEFAULT 0,      -- BOOLEAN-as-INTEGER
            is_abstract     INTEGER DEFAULT 0,      -- BOOLEAN-as-INTEGER
            decorators      TEXT,                   -- JSON-as-TEXT: string[]
            type_parameters TEXT,                   -- JSON-as-TEXT: string[]
            return_type     TEXT,                   -- v5: normalized return type
            updated_at      INTEGER NOT NULL        -- epoch ms
        );

        -- edges: relationships between nodes.
        CREATE TABLE IF NOT EXISTS edges (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- surrogate row id; NOT the identity
            source     TEXT NOT NULL,
            target     TEXT NOT NULL,
            kind       TEXT NOT NULL,
            metadata   TEXT,                        -- JSON-as-TEXT: opaque object (raw string)
            line       INTEGER,                     -- nullable call-site line (1-based)
            col        INTEGER,                     -- nullable call-site column (0-based)
            provenance TEXT DEFAULT NULL,           -- v2: 'tree-sitter'|'scip'|'heuristic'
            FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
        );

        -- files: tracked source files. Change detection is by content_hash, not mtime.
        CREATE TABLE IF NOT EXISTS files (
            path         TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,             -- full lowercase hex sha256 of file bytes
            language     TEXT NOT NULL,
            size         INTEGER NOT NULL,          -- bytes
            modified_at  INTEGER NOT NULL,          -- epoch ms
            indexed_at   INTEGER NOT NULL,          -- epoch ms
            node_count   INTEGER DEFAULT 0,
            errors       TEXT                       -- JSON-as-TEXT: ExtractionError[] (raw string)
        );

        -- unresolved_refs: references pending cross-file resolution.
        CREATE TABLE IF NOT EXISTS unresolved_refs (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- UnresolvedReference.rowId
            from_node_id   TEXT NOT NULL,
            reference_name TEXT NOT NULL,
            reference_kind TEXT NOT NULL,           -- ReferenceKind = EdgeKind | 'function_ref'
            line           INTEGER NOT NULL,        -- 1-based
            col            INTEGER NOT NULL,        -- 0-based
            candidates     TEXT,                    -- JSON-as-TEXT: string[]
            file_path      TEXT NOT NULL DEFAULT '',        -- v2 (denormalized)
            language       TEXT NOT NULL DEFAULT 'unknown', -- v2 (denormalized)
            status         TEXT NOT NULL DEFAULT 'pending', -- v8: 'pending'|'failed'
            name_tail      TEXT NOT NULL DEFAULT '',        -- v8: last segment of reference_name
            FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );

        -- name_segment_vocab: prose-word -> symbol-name lookup for the prompt hook. (v7)
        CREATE TABLE IF NOT EXISTS name_segment_vocab (
            segment TEXT NOT NULL,
            name    TEXT NOT NULL,
            PRIMARY KEY (segment, name)
        ) WITHOUT ROWID;

        -- project_metadata: version/provenance KV store. (v2)
        CREATE TABLE IF NOT EXISTS project_metadata (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL             -- epoch ms
        );

        -- =====================================================================
        -- FTS5 external-content virtual table + sync triggers.
        -- Column order is load-bearing for bm25(nodes_fts, 0, 20, 5, 1, 2):
        -- id=0, name=20, qualified_name=5, docstring=1, signature=2.
        -- =====================================================================
        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
            id,
            name,
            qualified_name,
            docstring,
            signature,
            content='nodes',
            content_rowid='rowid'
        );

        -- ai: mirror an inserted node row into the FTS index.
        CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
            VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
        END;

        -- ad: on delete, emit the external-content 'delete' command row.
        CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
        END;

        -- au: on update, delete-then-insert (external content requires the old-row delete first).
        CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
            VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
            INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
            VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
        END;

        -- =====================================================================
        -- Indexes. v4-dropped idx_edges_source / idx_edges_target are NEVER created.
        -- =====================================================================

        -- nodes
        CREATE INDEX IF NOT EXISTS idx_nodes_kind           ON nodes(kind);
        CREATE INDEX IF NOT EXISTS idx_nodes_name           ON nodes(name);
        CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
        CREATE INDEX IF NOT EXISTS idx_nodes_file_path      ON nodes(file_path);
        CREATE INDEX IF NOT EXISTS idx_nodes_language       ON nodes(language);
        CREATE INDEX IF NOT EXISTS idx_nodes_file_line      ON nodes(file_path, start_line);
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name     ON nodes(lower(name));  -- v3: expression index

        -- edges (narrow source/target omitted — composites cover them via left-prefix).
        CREATE INDEX IF NOT EXISTS idx_edges_kind        ON edges(kind);
        CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
        CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance  ON edges(provenance);

        -- Edge identity: (source, target, kind, IFNULL(line,-1), IFNULL(col,-1)). v6.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
            ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));

        -- files
        CREATE INDEX IF NOT EXISTS idx_files_language    ON files(language);
        CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

        -- unresolved_refs
        CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
        CREATE INDEX IF NOT EXISTS idx_unresolved_name      ON unresolved_refs(reference_name);
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
        CREATE INDEX IF NOT EXISTS idx_unresolved_status    ON unresolved_refs(status);
        CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail
            ON unresolved_refs(name_tail) WHERE status = 'failed';  -- v8: PARTIAL; #1240 retry lookup
        """;

    // Idempotent. Emits the folded final schema, then stamps the version once.
    // Future additive fields go through EnsureColumn (none needed at M0).
    public static void Initialize(SqliteConnection connection)
    {
        Execute(connection, Ddl);
        StampVersion(connection);
    }

    private static void StampVersion(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
            VALUES ($version, $appliedAt, $description)
            """;
        command.Parameters.AddWithValue("$version", SchemaVersion);
        command.Parameters.AddWithValue("$appliedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$description", "CodeGraph C# port — folded final schema");
        command.ExecuteNonQuery();
    }

    // Additive-only migration helper for future fields — mirrors DbSchemaMigrator.
    public static void EnsureColumn(
        SqliteConnection connection,
        string tableName,
        string columnName,
        string definition)
    {
        if (HasColumn(connection, tableName, columnName))
        {
            return;
        }

        Execute(
            connection,
            $"ALTER TABLE {QuoteIdent(tableName)} ADD COLUMN {QuoteIdent(columnName)} {definition}");
    }

    private static bool HasColumn(SqliteConnection connection, string tableName, string columnName)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({QuoteIdent(tableName)})";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static string QuoteIdent(string value)
    {
        return $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
    }
}
