# Reference 01 — Data Model & Final SQLite Schema (C# port)

> **Status:** day-one implementable reference for `Modules/CodeGraph/` in the
> OpenCowork .NET 10 native worker. This is the authoritative artifact for the
> graph DB shape, the C# domain/DTO types, source-gen JSON registration, node-id
> hashing, and edge identity. Design authority: master plan Decisions **2, 3, 4,
> 16, 17, 18** and §4 layout. Ground truth: CodeGraph `src/db/schema.sql`,
> `src/db/migrations.ts` (v2–v8), `src/types.ts`, `src/extraction/tree-sitter-helpers.ts`.
>
> Conventions (Decision 6): **global C# namespace, `CodeGraph*` class prefixes,
> no `namespace` declarations.** `.prettierrc`-equivalent for C# is the worker's
> existing style; source-gen JSON only (Decision 7); `enum` is banned for the
> three vocabularies (Decision 16 — `static class` string constants).

---

## 1. Final SQLite schema — one ready-to-paste DDL block

**Decision 18:** migrations v2–v8 are dead history (no legacy CodeGraph DBs exist
in OpenCowork's world). Emit the final (v8-equivalent) schema **directly**. Every
v2–v8 addition is already inlined below; the migration chain is **not** ported.
The port evolves *its own* future schema via `EnsureColumn` + a
`schema_versions`-guarded hook for rare data fixups (mirroring
`DbSchemaMigrator.EnsureColumn`).

This is exactly `schema.sql` folded — that file already contains every v2–v8
delta (return_type/v5, provenance/v2, status+name_tail/v8, unresolved file_path+
language/v2, lower(name) index/v3, edges_identity UNIQUE/v6, name_segment_vocab/v7,
project_metadata/v2) and never creates the v4-dropped narrow edge indexes.

```sql
-- =============================================================================
-- CodeGraph — FINAL schema (v8-equivalent, migrations folded). Emit as one block.
-- Booleans are stored as INTEGER (0/1). JSON payloads are stored as TEXT.
-- Lines are 1-based; columns are 0-based (see node-id §4 and models §2).
-- =============================================================================

-- Schema bookkeeping. Port stamps the current version once at create time
-- (do NOT replay v1..v8). getCurrentVersion = MAX(version).
CREATE TABLE IF NOT EXISTS schema_versions (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,          -- epoch ms
    description TEXT
);

-- nodes: code symbols (functions, classes, variables, files, ...).
CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,       -- "{kind}:" + sha256(...)[:32]  (§4)
    kind            TEXT NOT NULL,          -- NodeKind constant (§2)
    name            TEXT NOT NULL,
    qualified_name  TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    language        TEXT NOT NULL,          -- Language constant (§2)
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
    return_type     TEXT,                   -- v5: normalized return type (receiver inference, #645)
    updated_at      INTEGER NOT NULL        -- epoch ms
);

-- edges: relationships between nodes.
CREATE TABLE IF NOT EXISTS edges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- surrogate row id; NOT the identity
    source     TEXT NOT NULL,
    target     TEXT NOT NULL,
    kind       TEXT NOT NULL,               -- EdgeKind constant (§2)
    metadata   TEXT,                        -- JSON-as-TEXT: opaque object (kept as raw string, §3)
    line       INTEGER,                     -- nullable call-site line (1-based)
    col        INTEGER,                     -- nullable call-site column (0-based)  [Edge.column in TS]
    provenance TEXT DEFAULT NULL,           -- v2: 'tree-sitter'|'scip'|'heuristic'
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- files: tracked source files. Change detection is by content_hash, not mtime.
CREATE TABLE IF NOT EXISTS files (
    path         TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,             -- full lowercase hex sha256 of file bytes (§4)
    language     TEXT NOT NULL,
    size         INTEGER NOT NULL,          -- bytes
    modified_at  INTEGER NOT NULL,          -- epoch ms
    indexed_at   INTEGER NOT NULL,          -- epoch ms
    node_count   INTEGER DEFAULT 0,
    errors       TEXT                       -- JSON-as-TEXT: ExtractionError[] (kept as raw string, §3)
);

-- unresolved_refs: references pending cross-file resolution.
-- Lifecycle: inserted 'pending'; a completed resolution pass DELETEs a row
-- (resolved) or marks it 'failed' (attempted, no match — kept, with name_tail =
-- last dotted segment, so a later sync retries it when a changed file adds a
-- matching symbol, #1240). Rows CASCADE with from_node_id.
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- UnresolvedReference.rowId (precise cleanup target, #1269)
    from_node_id   TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,           -- ReferenceKind = EdgeKind | 'function_ref'
    line           INTEGER NOT NULL,        -- 1-based
    col            INTEGER NOT NULL,        -- 0-based  [UnresolvedReference.column in TS]
    candidates     TEXT,                    -- JSON-as-TEXT: string[]
    file_path      TEXT NOT NULL DEFAULT '',        -- v2 (denormalized)
    language       TEXT NOT NULL DEFAULT 'unknown', -- v2 (denormalized)
    status         TEXT NOT NULL DEFAULT 'pending', -- v8: 'pending'|'failed'
    name_tail      TEXT NOT NULL DEFAULT '',        -- v8: last segment of reference_name
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- name_segment_vocab: prose-word -> symbol-name lookup for the prompt hook's
-- graph-derived gate. WITHOUT ROWID; one row per (lowercased name-segment, name).
-- File/import nodes are excluded on the write path. Rows are PROPOSALS,
-- re-verified against nodes before use; deletions leave orphans on purpose; a
-- full index clears the table at its start. (v7)
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

-- =============================================================================
-- FTS5 external-content virtual table + sync triggers
-- =============================================================================

-- External content: FTS stores only the tokenized columns, not a row copy;
-- content_rowid maps back to nodes.rowid. Column order is load-bearing for the
-- bm25 weights used at search time: bm25(nodes_fts, 0, 20, 5, 1, 2) =>
-- id=0, name=20, qualified_name=5, docstring=1, signature=2.
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

-- =============================================================================
-- Indexes (every one, with rationale). v4-dropped idx_edges_source /
-- idx_edges_target are intentionally NEVER created.
-- =============================================================================

-- nodes
CREATE INDEX IF NOT EXISTS idx_nodes_kind           ON nodes(kind);              -- kind scans (getNodesByKind, dead-code, subgraph)
CREATE INDEX IF NOT EXISTS idx_nodes_name           ON nodes(name);              -- exact-name lookup + prefix range scan
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);    -- exact qualified-name lookup
CREATE INDEX IF NOT EXISTS idx_nodes_file_path      ON nodes(file_path);         -- per-file node fetch; dependency projections
CREATE INDEX IF NOT EXISTS idx_nodes_language       ON nodes(language);          -- language filters
CREATE INDEX IF NOT EXISTS idx_nodes_file_line      ON nodes(file_path, start_line); -- ordered per-file listing
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name     ON nodes(lower(name));       -- v3: EXPRESSION index; memory-efficient case-insensitive lookup

-- edges. Narrow idx_edges_source / idx_edges_target are OMITTED: the (source,kind)
-- / (target,kind) composites cover source-only / target-only scans via SQLite's
-- left-prefix rule, so the narrow indexes would be dead write-weight (v4 drops
-- them on legacy DBs; the port never creates them).
CREATE INDEX IF NOT EXISTS idx_edges_kind        ON edges(kind);                 -- kind aggregation (stats)
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);         -- outgoing edges by kind AND source-only (left-prefix)
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);         -- incoming edges by kind AND target-only (left-prefix)
CREATE INDEX IF NOT EXISTS idx_edges_provenance  ON edges(provenance);           -- v2: provenance filtering

-- Edge identity uniqueness. An edge IS (source, target, kind, line, col).
-- insertEdge uses INSERT OR IGNORE; without a UNIQUE target it degraded to a
-- plain INSERT and two passes produced byte-identical duplicate rows (#1034).
-- IFNULL folds the nullable line/col so coordinate-less edges dedup too (SQLite
-- treats each NULL as distinct otherwise). MUST be present from row zero (v6).
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
    ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));

-- files
CREATE INDEX IF NOT EXISTS idx_files_language    ON files(language);             -- language file listing
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);          -- staleness scans

-- unresolved_refs
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);                 -- cleanup by node
CREATE INDEX IF NOT EXISTS idx_unresolved_name      ON unresolved_refs(reference_name);               -- resolution lookup by name
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);                    -- v2: scoped-by-file resolution
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name); -- composite cleanup
CREATE INDEX IF NOT EXISTS idx_unresolved_status    ON unresolved_refs(status);                       -- v8: pending count/batch excludes failed
CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail
    ON unresolved_refs(name_tail) WHERE status = 'failed';                                            -- v8: PARTIAL; #1240 retry lookup (failed set is the only population worth indexing)
```

**Stamp the version after create** (do not replay migrations):

```sql
INSERT INTO schema_versions (version, applied_at, description)
VALUES (8, <epoch_ms>, 'CodeGraph C# port — folded final schema');
```

**Column-shape cheat sheet**

- **Boolean-as-INTEGER (0/1):** `nodes.is_exported`, `nodes.is_async`,
  `nodes.is_static`, `nodes.is_abstract`. (Read with `GetInt64(i) != 0`.)
- **JSON-as-TEXT:** `nodes.decorators` (`string[]`), `nodes.type_parameters`
  (`string[]`), `unresolved_refs.candidates` (`string[]`), `edges.metadata`
  (opaque object — keep raw), `files.errors` (`ExtractionError[]` — keep raw).
- **epoch-ms INTEGER:** `nodes.updated_at`, `files.modified_at/indexed_at`,
  `project_metadata.updated_at`, `schema_versions.applied_at`.
- **Name mismatches (TS field → DB column) the mapper MUST bridge:**
  `Edge.column → edges.col`, `UnresolvedReference.column → unresolved_refs.col`,
  `Node.startColumn/endColumn → nodes.start_column/end_column`.
- `edges.id` (AUTOINCREMENT) is a surrogate row id, **not** part of edge
  identity and **not** on the `Edge` domain type. `unresolved_refs.id` **is**
  surfaced as `UnresolvedReference.rowId`.

---

## 2. C# data-model mapping

### 2.1 Fixed vocabularies as `static class` string constants (Decision 16)

Stored as `TEXT`; `enum` is banned (zero mapping cost at the SQLite boundary,
AOT-trivial). Each class exposes an `All` array = the single source of truth the
search query parser validates against.

**`CodeGraphNodeKind` — 22 values** (`types.ts:18-41`):

```csharp
internal static class CodeGraphNodeKind
{
    public const string File       = "file";
    public const string Module     = "module";
    public const string Class      = "class";
    public const string Struct     = "struct";
    public const string Interface  = "interface";
    public const string Trait      = "trait";
    public const string Protocol   = "protocol";
    public const string Function   = "function";
    public const string Method     = "method";
    public const string Property   = "property";
    public const string Field      = "field";
    public const string Variable   = "variable";
    public const string Constant   = "constant";
    public const string Enum       = "enum";
    public const string EnumMember = "enum_member";
    public const string TypeAlias  = "type_alias";
    public const string Namespace  = "namespace";
    public const string Parameter  = "parameter";
    public const string Import     = "import";
    public const string Export     = "export";
    public const string Route      = "route";
    public const string Component  = "component";

    public static readonly string[] All =
    {
        File, Module, Class, Struct, Interface, Trait, Protocol, Function, Method,
        Property, Field, Variable, Constant, Enum, EnumMember, TypeAlias, Namespace,
        Parameter, Import, Export, Route, Component
    };
}
```

**`CodeGraphEdgeKind` — 12 values** (`types.ts:48-60`). Note the internal-only
`ReferenceKind` extra `"function_ref"` (a function name used as a value; it is
**never** an edge kind — resolution maps it to a `references` edge targeting
function/method nodes, `types.ts:293-299`). Provide it as a separate constant,
not in `EdgeKind.All`.

```csharp
internal static class CodeGraphEdgeKind
{
    public const string Contains     = "contains";
    public const string Calls        = "calls";
    public const string Imports      = "imports";
    public const string Exports      = "exports";
    public const string Extends      = "extends";
    public const string Implements   = "implements";
    public const string References   = "references";
    public const string TypeOf       = "type_of";
    public const string Returns      = "returns";
    public const string Instantiates = "instantiates";
    public const string Overrides    = "overrides";
    public const string Decorates    = "decorates";

    public static readonly string[] All =
    {
        Contains, Calls, Imports, Exports, Extends, Implements, References,
        TypeOf, Returns, Instantiates, Overrides, Decorates
    };

    // ReferenceKind = EdgeKind | 'function_ref' (internal-only; maps to a
    // 'references' edge; NOT a valid edges.kind value).
    public const string FunctionRef = "function_ref";
}
```

**`CodeGraphLanguage` — 42 values** (`types.ts:66-109`). See the discrepancy
note at the end: the plan says "41"; the array is **42 including the `unknown`
sentinel** (41 real languages + `unknown`).

```csharp
internal static class CodeGraphLanguage
{
    public const string TypeScript = "typescript";
    public const string JavaScript = "javascript";
    public const string Tsx        = "tsx";
    public const string Jsx        = "jsx";
    public const string ArkTs      = "arkts";
    public const string Python     = "python";
    public const string Go         = "go";
    public const string Rust       = "rust";
    public const string Java       = "java";
    public const string C          = "c";
    public const string Cpp        = "cpp";
    public const string CSharp     = "csharp";
    public const string Razor      = "razor";
    public const string Php        = "php";
    public const string Ruby       = "ruby";
    public const string Swift      = "swift";
    public const string Kotlin     = "kotlin";
    public const string Dart       = "dart";
    public const string Svelte     = "svelte";
    public const string Vue        = "vue";
    public const string Astro      = "astro";
    public const string Liquid     = "liquid";
    public const string Pascal     = "pascal";
    public const string Scala      = "scala";
    public const string Lua        = "lua";
    public const string Luau       = "luau";
    public const string ObjC       = "objc";
    public const string R          = "r";
    public const string Solidity   = "solidity";
    public const string Nix        = "nix";
    public const string Yaml       = "yaml";
    public const string Twig       = "twig";
    public const string Xml        = "xml";
    public const string Properties = "properties";
    public const string Cfml       = "cfml";
    public const string CfScript   = "cfscript";
    public const string CfQuery    = "cfquery";
    public const string Cobol      = "cobol";
    public const string VbNet      = "vbnet";
    public const string Erlang     = "erlang";
    public const string Terraform  = "terraform";
    public const string Unknown    = "unknown";

    public static readonly string[] All =
    {
        TypeScript, JavaScript, Tsx, Jsx, ArkTs, Python, Go, Rust, Java, C, Cpp,
        CSharp, Razor, Php, Ruby, Swift, Kotlin, Dart, Svelte, Vue, Astro, Liquid,
        Pascal, Scala, Lua, Luau, ObjC, R, Solidity, Nix, Yaml, Twig, Xml,
        Properties, Cfml, CfScript, CfQuery, Cobol, VbNet, Erlang, Terraform, Unknown
    };
}
```

`CodeGraphVisibility` optional helper (values `public`/`private`/`protected`/
`internal`) and `CodeGraphProvenance` (`tree-sitter`/`scip`/`heuristic`) may be
modeled the same way, or left as bare strings.

### 2.2 Core domain types — in-process only (NOT serialized, Decision 7)

These mirror the DDL rows and `types.ts`. They stay in the engine and are
**never** handed to `System.Text.Json`. Opaque columns (`metadata`, `errors`)
are carried as **raw JSON strings**, never modeled (see §3). Nullable reference
types on; `int` for line/col, `long` for epoch-ms.

```csharp
// ≙ types.ts Node (nodes row). In-process only.
internal sealed record CodeGraphNode(
    string Id,
    string Kind,
    string Name,
    string QualifiedName,
    string FilePath,
    string Language,
    int StartLine,          // 1-based
    int EndLine,            // 1-based
    int StartColumn,        // 0-based
    int EndColumn,          // 0-based
    string? Docstring,
    string? Signature,
    string? Visibility,
    bool IsExported,
    bool IsAsync,
    bool IsStatic,
    bool IsAbstract,
    IReadOnlyList<string>? Decorators,      // JSON string[] column
    IReadOnlyList<string>? TypeParameters,  // JSON string[] column
    string? ReturnType,
    long UpdatedAt);

// ≙ types.ts Edge (edges row). In-process only.
// NOTE: Column property maps to DB column `col`; there is no surrogate `id` here.
internal sealed record CodeGraphEdge(
    string Source,
    string Target,
    string Kind,
    string? Metadata,       // RAW JSON string (opaque object) — kept verbatim, §3
    int? Line,              // 1-based, nullable
    int? Column,            // 0-based, nullable  -> edges.col
    string? Provenance);

// ≙ types.ts FileRecord (files row). In-process only.
internal sealed record CodeGraphFileRecord(
    string Path,
    string ContentHash,
    string Language,
    long Size,
    long ModifiedAt,
    long IndexedAt,
    int NodeCount,
    string? Errors);        // RAW JSON string (ExtractionError[]) — kept verbatim, §3

// ≙ types.ts UnresolvedReference (unresolved_refs row). In-process only.
// Status/NameTail are DB-managed (v8) and absent from the TS domain type; carry
// them here for the resolution lifecycle. Column maps to DB `col`.
internal sealed record CodeGraphUnresolvedReference(
    string FromNodeId,
    string ReferenceName,
    string ReferenceKind,   // EdgeKind | 'function_ref'
    int Line,               // 1-based
    int Column,             // 0-based -> unresolved_refs.col
    string? FilePath,
    string? Language,
    IReadOnlyList<string>? Candidates,      // JSON string[] column
    long? RowId,            // unresolved_refs.id — precise cleanup target (#1269)
    string Status = "pending",              // v8
    string NameTail = "");                  // v8
```

### 2.3 Result / query types

`Subgraph` and `ExtractionResult` are **in-process only**. The remaining result
types cross the tool boundary and are the serialized DTOs (§3). `ExtractionError`
is modeled for extraction internals **and** registered so `files.errors` can be
surfaced at the tool boundary.

```csharp
// In-process. nodes as a Dictionary (TS Map<string,Node>). NOT serialized.
internal sealed class CodeGraphSubgraph
{
    public Dictionary<string, CodeGraphNode> Nodes { get; } = new();
    public List<CodeGraphEdge> Edges { get; } = new();
    public List<string> Roots { get; } = new();
    public string? Confidence { get; set; }   // 'high' | 'low' | null
}

// In-process. Extraction pipeline output. NOT serialized.
internal sealed record CodeGraphExtractionResult(
    List<CodeGraphNode> Nodes,
    List<CodeGraphEdge> Edges,
    List<CodeGraphUnresolvedReference> UnresolvedReferences,
    List<CodeGraphExtractionError> Errors,
    double DurationMs);

// Serialized at the tool boundary (files.errors echo + extraction diagnostics).
internal sealed record CodeGraphExtractionError(
    string Message,
    string Severity,          // 'error' | 'warning'
    string? FilePath = null,
    int? Line = null,
    int? Column = null,
    string? Code = null);

// Serialized. A search hit. Embeds a serializable node view (see §3 rationale).
internal sealed record CodeGraphSearchResult(
    CodeGraphNodeView Node,
    double Score,             // relative rank only; NOT normalized (BM25 magnitude on FTS path)
    IReadOnlyList<string>? Highlights = null);

// Serialized. Prompt-hook segment match (name_segment_vocab gate).
internal sealed record CodeGraphSegmentMatch(
    string Name,
    string Kind,
    string FilePath,
    int StartLine,            // 1-based
    IReadOnlyList<string> MatchedWords);

// Serialized. getContext result. Node fields as serializable views.
internal sealed record CodeGraphContext(
    CodeGraphNodeView Focal,
    IReadOnlyList<CodeGraphNodeView> Ancestors,
    IReadOnlyList<CodeGraphNodeView> Children,
    IReadOnlyList<CodeGraphNodeEdge> IncomingRefs,   // { node, edge }
    IReadOnlyList<CodeGraphNodeEdge> OutgoingRefs,
    IReadOnlyList<CodeGraphNodeView> Types,
    IReadOnlyList<CodeGraphNodeView> Imports);

internal sealed record CodeGraphNodeEdge(CodeGraphNodeView Node, CodeGraphEdgeView Edge);

// Serialized. Graph statistics.
internal sealed record CodeGraphStats(
    int NodeCount,
    int EdgeCount,
    int FileCount,
    IReadOnlyDictionary<string, int> NodesByKind,
    IReadOnlyDictionary<string, int> EdgesByKind,
    IReadOnlyDictionary<string, int> FilesByLanguage,
    long DbSizeBytes,
    long LastUpdated);

// Serialized facade results (NOT in types.ts — facade-level; pin exact fields in
// M4/M1 against index.ts. Fields below are the load-bearing minimum).
internal sealed record CodeGraphIndexResult(
    int FilesIndexed,
    int NodesCreated,
    int EdgesCreated,
    int UnresolvedCount,
    double DurationMs,
    IReadOnlyList<CodeGraphExtractionError> Errors);

internal sealed record CodeGraphSyncResult(
    int FilesChanged,
    int FilesAdded,
    int FilesRemoved,
    int NodesUpdated,
    int EdgesUpdated,
    double DurationMs);
```

**Serializable node/edge views** — the wire projections used inside the
serialized results (Decision 7 keeps the domain `CodeGraphNode`/`Edge`
in-process, so results embed a view instead). Same fields as the domain records,
minus opaque `metadata` (surfaced as `JsonElement?` only if a caller needs it):

```csharp
internal sealed record CodeGraphNodeView(
    string Id, string Kind, string Name, string QualifiedName, string FilePath,
    string Language, int StartLine, int EndLine, int StartColumn, int EndColumn,
    string? Docstring, string? Signature, string? Visibility,
    bool IsExported, bool IsAsync, bool IsStatic, bool IsAbstract,
    IReadOnlyList<string>? Decorators, IReadOnlyList<string>? TypeParameters,
    string? ReturnType, long UpdatedAt);

internal sealed record CodeGraphEdgeView(
    string Source, string Target, string Kind,
    int? Line, int? Column, string? Provenance,
    JsonElement? Metadata = null);   // parsed from the raw string ONLY at the boundary
```

### 2.4 JSON naming policy

- **Default = camelCase** for every serialized DTO. Register
  `CodeGraphJsonContext` with
  `PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase` and
  `DefaultIgnoreCondition = WhenWritingNull` (identical to `WorkerJsonContext`).
  This makes the wire shape match `types.ts` verbatim: `qualifiedName`,
  `filePath`, `startLine`, `isExported`, `typeParameters`, `nodesByKind`, etc.
  **No `[JsonPropertyName]` needed** on any result DTO — the C# property name
  camelCased already equals the TS field name.
- **`[JsonPropertyName("snake_case")]` is required only for DB-row-shaped
  payloads** — DTOs that mirror table columns verbatim (the
  `DbProjectModels.ProjectRow` pattern: `[JsonPropertyName("working_folder")]`,
  `[JsonPropertyName("ssh_connection_id")]`). CodeGraph exposes **no such raw-row
  DTO at MVP** (domain types stay in-process, Decision 7), so snake_case forcing
  is **not** used in the CodeGraph module today. If a future debug/db-sync channel
  ever ships a `CodeGraphNodeRow` mirroring the `nodes` table 1:1, that DTO — and
  only that DTO — takes `[JsonPropertyName]` with the exact column names
  (`qualified_name`, `file_path`, `start_line`, `is_exported`, `type_parameters`,
  `return_type`, `updated_at`, ...).

---

## 3. Source-gen JSON registration (`CodeGraphJsonContext`)

A dedicated `CodeGraphJsonContext : JsonSerializerContext`
(`Serialization/CodeGraphJsonContext.cs`), `GenerationMode = Metadata`,
camelCase, `WhenWritingNull` — one per the `WorkerJsonContext` template.
`JsonSerializerIsReflectionEnabledByDefault=false` is hard-enforced.

**Rule:** *opaque metadata/errors are kept as raw JSON strings internally and are
never modeled or registered.* They are parsed to `JsonElement` **only** at the
tool boundary (e.g. `CodeGraphEdgeView.Metadata`). Everything that crosses IPC is
registered; every internal domain type is **not**.

**Register `[JsonSerializable(typeof(T))]` for (+ `List<T>` alias where a
collection crosses the wire):**

```csharp
// scalars / shared
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(List<string>), TypeInfoPropertyName = "ListString")]
[JsonSerializable(typeof(JsonElement))]

// serialized node/edge views + collections
[JsonSerializable(typeof(CodeGraphNodeView))]
[JsonSerializable(typeof(List<CodeGraphNodeView>), TypeInfoPropertyName = "ListCodeGraphNodeView")]
[JsonSerializable(typeof(CodeGraphEdgeView))]
[JsonSerializable(typeof(List<CodeGraphEdgeView>), TypeInfoPropertyName = "ListCodeGraphEdgeView")]
[JsonSerializable(typeof(CodeGraphNodeEdge))]
[JsonSerializable(typeof(List<CodeGraphNodeEdge>), TypeInfoPropertyName = "ListCodeGraphNodeEdge")]

// serialized results
[JsonSerializable(typeof(CodeGraphSearchResult))]
[JsonSerializable(typeof(List<CodeGraphSearchResult>), TypeInfoPropertyName = "ListCodeGraphSearchResult")]
[JsonSerializable(typeof(CodeGraphSegmentMatch))]
[JsonSerializable(typeof(List<CodeGraphSegmentMatch>), TypeInfoPropertyName = "ListCodeGraphSegmentMatch")]
[JsonSerializable(typeof(CodeGraphContext))]
[JsonSerializable(typeof(CodeGraphStats))]
[JsonSerializable(typeof(CodeGraphExtractionError))]
[JsonSerializable(typeof(List<CodeGraphExtractionError>), TypeInfoPropertyName = "ListCodeGraphExtractionError")]
[JsonSerializable(typeof(CodeGraphIndexResult))]
[JsonSerializable(typeof(CodeGraphSyncResult))]
[JsonSerializable(typeof(CodeGraphStatusResult))]   // module status DTO (M0)
[JsonSerializable(typeof(CodeGraphExploreResult))]  // M5 tool envelope
internal sealed partial class CodeGraphJsonContext : JsonSerializerContext;
```

**Stay in-process ONLY — never `[JsonSerializable]`:**

- `CodeGraphNode`, `CodeGraphEdge`, `CodeGraphFileRecord`,
  `CodeGraphUnresolvedReference` — domain row types (Decision 7).
- `CodeGraphSubgraph` — traversal working set (holds a `Dictionary` + domain
  nodes; projected to views at the boundary).
- `CodeGraphExtractionResult` — extraction pipeline output (projected to
  `CodeGraphIndexResult`).
- The three vocabulary `static class`es and any `string[] All` arrays.
- Raw opaque payloads: `edges.metadata`, `files.errors` — held as `string?`,
  never a modeled type.

`List<T>` alias entries are only required for collections actually serialized as
a top-level/array payload; a `List<T>` nested inside a registered record does not
need its own alias but is harmless to add. Match `WorkerJsonContext`'s
`TypeInfoPropertyName = "ListX"` naming.

---

## 4. Node-ID + content-hash formulas (`CodeGraphNodeIdFactory`)

Decision 17. One shared factory used by **both** extraction and resolution
(synthesizers reconstruct ids by this exact formula). `line` is **1-based**
(the node's `start_line`). Hash is truncated to **32 hex chars = 128 bits**.
Load-bearing: **any line shift changes a symbol's id**, which is why incremental
re-index re-resolves incoming edges by `(name, kind)`, not by old id.

```csharp
using System.Security.Cryptography;
using System.Text;

internal static class CodeGraphNodeIdFactory
{
    // id = "{kind}:" + lowerhex(sha256(utf8($"{filePath}:{kind}:{name}:{line}")))[..32]
    // line is 1-based (nodes.start_line). 32 hex chars = 128-bit truncated digest.
    public static string NodeId(string filePath, string kind, string name, int line)
    {
        var payload = Encoding.UTF8.GetBytes($"{filePath}:{kind}:{name}:{line}");
        Span<byte> digest = stackalloc byte[32];         // SHA-256 = 32 bytes
        SHA256.HashData(payload, digest);
        var hex = Convert.ToHexString(digest).ToLowerInvariant(); // 64 chars, lowercase
        return $"{kind}:{hex.AsSpan(0, 32)}";            // kind prefix + first 32 hex chars
    }

    // Full lowercase hex sha256 of the file's UTF-8 bytes -> files.content_hash.
    // Change detection is by content hash, not mtime.
    public static string ContentHash(ReadOnlySpan<byte> fileBytes)
    {
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(fileBytes, digest);
        return Convert.ToHexString(digest).ToLowerInvariant(); // full 64-char hex
    }
}
```

Reference TS: `generateNodeId` (`tree-sitter-helpers.ts:18-30`) —
`sha256(`${filePath}:${kind}:${name}:${line}`).digest('hex').substring(0,32)`,
returned as `` `${kind}:${hash}` ``. `crypto` hex output is already lowercase;
`Convert.ToHexString` is uppercase, so `.ToLowerInvariant()` is **mandatory** for
parity. Content hash: `src/extraction/index.ts:121` (full hex sha256).

---

## 5. Edge identity & dedup

Edge identity is the tuple

```
(source, target, kind, IFNULL(line, -1), IFNULL(col, -1))
```

enforced by the **UNIQUE** `idx_edges_identity` (present from row zero — do not
defer it). `edges.id` (AUTOINCREMENT) is a surrogate and is **not** part of the
identity.

**Insert path:** always `INSERT OR IGNORE INTO edges (...)`. With the UNIQUE
index in place, a second pass emitting the same logical edge conflicts and is
silently ignored — so two passes cannot produce byte-identical duplicate rows
(#1034). `IFNULL(..., -1)` folds nullable `line`/`col` so coordinate-less
(synthesized / file-level) edges also dedup — SQLite otherwise treats every NULL
as distinct, which would let duplicates through.

**Consequences the writer must honor:**

- `metadata` differences do **not** create a new edge — two edges identical in
  `(source, target, kind, line, col)` but differing only in `metadata` collapse
  to one (first writer wins under `OR IGNORE`).
- Distinct `line`/`col` **do** keep separate edges (same caller→callee at two
  call sites = two rows).
- `insertEdges` must still validate **both endpoints exist** (chunked `IN`-list
  existence probe against `nodes`, **not** the LRU node cache — a stale cache
  would admit dangling edges) before inserting, all inside one transaction.
- No v6-style dedup DELETE is needed on a fresh port DB; the UNIQUE index makes
  `OR IGNORE` correct from the first write.

---

## Discrepancies the implementer MUST know

1. **Language count: `41` (plan/Decision 16) vs `42` (`types.ts:66-109`).** The
   `LANGUAGES` array has **42** members; the "41" figure counts real languages
   and excludes the `unknown` sentinel. Model **all 42** constants (incl.
   `Unknown`); `analysis/03` already says "42". Treat 41 as "41 real + 1
   sentinel."
2. **NodeKind count: `22` (`types.ts`) vs "22–23" (Decision 16).** The
   `NODE_KINDS` array is exactly **22**. Ship 22; if a 23rd kind surfaces during
   extraction porting (a kind emitted by the walk but absent from the const
   array), add it to `All` and reconcile — but there is no 23rd in the ground
   truth today.
3. **TS field vs DB column name drift:** `Edge.column`↔`edges.col`,
   `UnresolvedReference.column`↔`unresolved_refs.col`. The row mapper must not
   assume name equality here (everything else is a straight `camelCase`↔
   `snake_case` transform).
4. **`schema.sql` is already the folded v8 schema; `migrations.ts` v2–v8 are
   redundant for the port** — do not port the chain (Decision 18). The only
   non-idempotent step in the whole chain, v6's dedup `DELETE`, is unnecessary on
   a fresh DB because `idx_edges_identity` exists from creation. v4's dropped
   `idx_edges_source`/`idx_edges_target` are simply never created.
5. **`unresolved_refs.status`/`name_tail` (v8) exist in the DDL but are absent
   from the TS `UnresolvedReference` domain type** — they are DB-managed
   lifecycle fields. The C# record carries them (defaults `'pending'`/`''`) so
   resolution and retryable-failed-ref (#1240) logic has them; do not expect them
   on the extraction-time value.
6. **`edges.id` AUTOINCREMENT has no domain-type counterpart** (identity is the
   tuple, not the id); **`unresolved_refs.id` does** (`UnresolvedReference.rowId`,
   the precise-cleanup target for #1269). Don't conflate the two "id" columns.
