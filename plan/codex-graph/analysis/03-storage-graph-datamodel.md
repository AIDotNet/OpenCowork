# 03 — Storage, Graph Query Layer, and Data Model

Analysis of CodeGraph's persistence and graph-query subsystem, and a concrete
plan to rewrite it in C# inside the OpenCowork .NET native worker.

Clone analyzed: `…/scratchpad/codegraph` (v1.4.1). All `path:line` references
below are into that clone unless prefixed with `OpenCowork:`.

---

## 1. Scope & subsystem summary

This subsystem is the **entire persistence + graph-traversal core** of
CodeGraph. Everything else (tree-sitter extraction, reference resolution,
framework synthesizers, MCP tools, CLI, daemon) reads and writes through it.

| Area | Files | LOC | Role |
|---|---|---|---|
| Schema (DDL) | `src/db/schema.sql` | 195 | The complete relational + FTS5 model, with rich reasoning comments |
| Connection/lifecycle | `src/db/index.ts` | 475 | `DatabaseConnection`: open/init, PRAGMAs, WAL helpers, maintenance, inode-replace self-heal, file location |
| Query layer | `src/db/queries.ts` | 2245 | `QueryBuilder`: every CRUD + search + stats query; **the single biggest file in the repo** |
| Migrations | `src/db/migrations.ts` | 234 | Versioned schema migrations v2–v8 |
| SQLite adapter | `src/db/sqlite-adapter.ts` | 149 | Thin better-sqlite3-shaped wrapper over Node 22 `node:sqlite` |
| WAL valve | `src/db/wal-valve.ts` | 206 | Off-thread WAL-checkpoint throttling during bulk index |
| Graph traversal | `src/graph/traversal.ts` | 733 | `GraphTraverser`: BFS/DFS, callers/callees, impact, path, type hierarchy |
| Graph queries | `src/graph/queries.ts` | 394 | `GraphQueryManager`: context, file deps, dead code, metrics, cycles |
| Domain types | `src/types.ts` | 649 | `Node`, `Edge`, `FileRecord`, `UnresolvedReference`, options, results |

Total ≈ **5,080 LOC** of TypeScript to port. It is a **single-file embedded
SQLite database per project** (`.codegraph/codegraph.db`) with WAL + FTS5. There
is no server; the DB *is* the shared state between the CLI, the daemon, and the
MCP server (multiple processes/connections onto one file — the source of much of
the locking/self-heal machinery).

**Verdict up front on the one hard gate:** FTS5 (and every other optional SQLite
feature CodeGraph uses) **is compiled into `SQLitePCLRaw.bundle_e_sqlite3` 3.0.3**
— empirically verified below (§4). No blocker; no fallback needed.

---

## 2. Architecture & data flow

### 2.1 The data model (schema.sql)

Seven tables + one FTS5 virtual table. All types are SQLite-native
(`TEXT`/`INTEGER`; JSON stored as `TEXT`).

**`schema_versions`** (`schema.sql:5-13`) — migration bookkeeping. `version`
PK, `applied_at` ms, `description`. `getCurrentVersion` = `MAX(version)`.

**`nodes`** (`schema.sql:20-42`) — code symbols. `id TEXT PRIMARY KEY`, plus
`kind, name, qualified_name, file_path, language, start_line, end_line,
start_column, end_column, docstring, signature, visibility, is_exported,
is_async, is_static, is_abstract, decorators (JSON array), type_parameters (JSON
array), return_type, updated_at`. `is_*` are `INTEGER DEFAULT 0` booleans.
`return_type` (v5) is a normalized return-type name captured for C/C++ so
resolution can infer a chained receiver's type (`Foo::instance().bar()`, #645).

- **Node id scheme** (`src/extraction/tree-sitter-helpers.ts:18-30`):
  `id = "${kind}:" + sha256(`${filePath}:${kind}:${name}:${line}`).hex[:32]`
  — a kind prefix plus a **128-bit** (32 hex chars) truncated SHA-256. This is
  load-bearing: **any line shift in a file changes the ids of its symbols**, so
  incremental re-index cannot re-insert incoming edges by old id — hence
  `getCrossFileIncomingEdgesWithTarget` (§2.3) re-resolves them by (name, kind).

**`edges`** (`schema.sql:45-56`) — relationships. `id INTEGER PRIMARY KEY
AUTOINCREMENT`, `source, target, kind`, `metadata (JSON)`, `line, col`,
`provenance` (`'tree-sitter' | 'scip' | 'heuristic'`, v2). FKs
`source`/`target → nodes(id) ON DELETE CASCADE` — deleting a node reaps its
edges. Edge identity is `(source, target, kind, IFNULL(line,-1), IFNULL(col,-1))`.

**`files`** (`schema.sql:59-68`) — tracked source files. `path TEXT PRIMARY
KEY`, `content_hash` (full SHA-256 hex of content, `src/extraction/index.ts:121`),
`language, size, modified_at, indexed_at, node_count, errors (JSON array)`.
Change detection is by content hash, not mtime.

**`unresolved_refs`** (`schema.sql:79-92`) — references pending cross-file
resolution. `id INTEGER PK AUTOINCREMENT`, `from_node_id` (FK→nodes CASCADE),
`reference_name, reference_kind, line, col, candidates (JSON), file_path (v2),
language (v2), status (v8, default 'pending'), name_tail (v8, default '')`.
Lifecycle (`schema.sql:70-78`): inserted `pending`; a completed resolution pass
either **deletes** a row (resolved) or marks it **`failed`** (attempted, no
match — kept, with `name_tail` = last dotted segment, so a later sync can retry
it when a changed file adds a matching symbol, #1240).

**`name_segment_vocab`** (`schema.sql:149-153`) — `WITHOUT ROWID` table,
`PRIMARY KEY (segment, name)`. One row per (lowercased word-segment of a symbol
name, name): `OrderStateMachine → (order, OrderStateMachine), (state, …),
(machine, …)`. Powers the prompt-hook "does this prose word name a real symbol"
gate. FTS5 **can't** serve it (its tokenizer keeps `camelCase` as one token), so
segments are materialized on the node write path. Rows are *proposals*,
re-verified against `nodes` before use; deletions deliberately leave orphans; a
full index clears the table at its start (`schema.sql:136-148`).

**`project_metadata`** (`schema.sql:190-194`) — `key TEXT PK, value TEXT,
updated_at`. Version/provenance KV store.

**`nodes_fts`** (`schema.sql:108-116`) — FTS5 **external-content** virtual
table: `fts5(id, name, qualified_name, docstring, signature, content='nodes',
content_rowid='rowid')`. Kept in sync by three triggers (`schema.sql:119-134`):
`nodes_ai` (AFTER INSERT), `nodes_ad` (AFTER DELETE, uses the `'delete'` command
row), `nodes_au` (AFTER UPDATE, delete-then-insert). External content = the FTS
index stores only the tokenized columns, not a copy of the row; `content_rowid`
maps back to `nodes.rowid`.

**Indexes and *why*** (comments are unusually explicit — capture them):

| Index | Columns | Rationale (schema.sql) |
|---|---|---|
| `idx_nodes_kind` | `kind` | kind scans (`getNodesByKind`, dead-code, subgraph) |
| `idx_nodes_name` | `name` | exact-name lookup + prefix range scan |
| `idx_nodes_qualified_name` | `qualified_name` | exact qualified-name lookup |
| `idx_nodes_file_path` | `file_path` | per-file node fetch; dependency projections |
| `idx_nodes_language` | `language` | language filters |
| `idx_nodes_file_line` | `(file_path, start_line)` | ordered per-file listing |
| `idx_nodes_lower_name` | `lower(name)` (**expression**, v3) | memory-efficient case-insensitive lookup |
| `idx_edges_kind` | `kind` | kind aggregation (stats) |
| `idx_edges_source_kind` | `(source, kind)` | outgoing edges by kind **and** source-only via left-prefix |
| `idx_edges_target_kind` | `(target, kind)` | incoming edges by kind **and** target-only via left-prefix |
| `idx_edges_identity` | `(source, target, kind, IFNULL(line,-1), IFNULL(col,-1))` **UNIQUE** (v6) | makes `INSERT OR IGNORE` actually dedup (#1034) |
| `idx_edges_provenance` | `provenance` (v2) | provenance filtering |
| `idx_files_language`, `idx_files_modified_at` | | file listing/staleness |
| `idx_unresolved_from_node` | `from_node_id` | cleanup by node |
| `idx_unresolved_name` | `reference_name` | resolution lookup by name |
| `idx_unresolved_file_path` | `file_path` (v2) | scoped-by-file resolution |
| `idx_unresolved_from_name` | `(from_node_id, reference_name)` | composite cleanup |
| `idx_unresolved_status` | `status` (v8) | pending count/batch excludes failed |
| `idx_unresolved_failed_tail` | `name_tail` **WHERE status='failed'** (**partial**, v8) | #1240 retry lookup; partial because on a healthy index the failed set is the only population worth indexing |

Deliberately **omitted**: `idx_edges_source` and `idx_edges_target` — the
`(source,kind)` / `(target,kind)` composites cover source-only / target-only
scans via SQLite's left-prefix rule, so the narrow indexes are dead write-weight.
Migration v4 *drops* them on existing DBs (`schema.sql:155-163`).

### 2.2 Connection lifecycle & PRAGMAs (`db/index.ts`)

`configureConnection` (`index.ts:30-38`) applies, in this exact order:
`busy_timeout=5000` (**first, before `journal_mode`** so a concurrent writer's
lock is waited out instead of throwing, #238), `foreign_keys=ON`,
`journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000` (64 MB),
`temp_store=MEMORY`, `mmap_size=268435456` (256 MB).

`DatabaseConnection` (`index.ts:43-407`):
- `initialize(dbPath)` — mkdir parent, create DB, apply PRAGMAs, `exec(schema.sql)`,
  stamp `schema_versions` to `CURRENT_SCHEMA_VERSION` so migrations don't re-run
  (`index.ts:67-93`).
- `open(dbPath)` — apply PRAGMAs, then `runMigrations` if `currentVersion < 8`
  (`index.ts:98-116`).
- WAL helpers: `getWalSizeBytes` (stat the `-wal` sidecar), `getWalAutocheckpoint`
  / `setWalAutocheckpoint`, `checkpointWalPassive` (runs `PRAGMA
  wal_checkpoint(PASSIVE)` **on a worker-thread with its own connection**, returns
  `{busy, log, checkpointed}`), `runMaintenance` (`PRAGMA analysis_limit=1000;
  optimize; wal_checkpoint(PASSIVE)` off-thread).
- `isReplacedOnDisk` (`index.ts:402-406`) — compares `dev:ino` captured at open
  vs now; detects `.codegraph/` deleted+recreated under a long-lived process
  (#925). POSIX-only (Windows returns null inode).
- `getDatabasePath(projectRoot)` = `join(getCodeGraphDir(projectRoot),
  'codegraph.db')`; default dir name `.codegraph` (`src/directory.ts`).
- `removeDatabaseFiles` (`index.ts:464-475`) — a **full re-index unlinks the DB
  file + `-wal`/`-shm` sidecars** (O(1)) rather than DELETE-ing rows, because the
  per-row `nodes_fts` delete-trigger churn on a poisoned multi-GB index trips the
  liveness watchdog before indexing even starts (#1067).

### 2.3 Query layer (`db/queries.ts`) — the heart

`QueryBuilder` wraps one `SqliteDatabase`. State it carries:
- `nodeCache: Map<string,Node>` — **LRU, max 1000** (`queries.ts:200-202`);
  delete+re-set on read to move-to-end; evict first key when full
  (`cacheNode` `queries.ts:679-688`). Invalidated on every write path.
- `stmts` — a bag of **lazily-prepared statements** (`queries.ts:205-239`),
  each created on first use and reused thereafter.
- `segmentedNames: Set<string>` — names whose segments were already written this
  session (write-path fast path; bounded at 65536, `queries.ts:245-246`).
- `projectNameTokens` — for path-relevance down-weighting (#720).

**Query categories:**

*Writes (nodes):* `insertNode` (`INSERT OR REPLACE`, `@named` params, validates
required fields, invalidates cache, materializes segment vocab for non-file /
non-import kinds — `queries.ts:270-343`); `insertNodes` (wraps a loop in one
transaction); `updateNode` (`UPDATE … WHERE id`, also feeds segment vocab, for
framework rename passes #1141); `deleteNode`; `deleteNodesByFile` (+ cache sweep).

*Writes (edges):* `insertEdge` (`INSERT OR IGNORE`, dedups via the UNIQUE
identity index, #1034 — `queries.ts:1470-1487`); `insertEdges` — **validates
both endpoints exist in the DB** via `getExistingNodeIds` (chunked IN-list, *not*
the node cache — a stale cache would admit dangling edges, `queries.ts:1492-1510`)
then inserts, all in one transaction; `deleteEdgesBySource`.

*Writes (files/refs):* `upsertFile` (`INSERT … ON CONFLICT(path) DO UPDATE`);
`deleteFile` (transaction: delete nodes-by-file then the file row);
`insertUnresolvedRef` / `insertUnresolvedRefsBatch`; a family of ref-cleanup
writers — `deleteResolvedReferences` (by node id, chunked),
`deleteSpecificResolvedReferences` (by tuple), `deleteReferencesByRowIds` (precise,
#1269), `markReferencesFailed` / `markReferencesFailedByRowIds` (park as
`failed` + write `name_tail`, #1240), `clearUnresolvedReferences`.

*Reads (point/kind/name):* `getNodeById` (cache-first), `getNodesByIds` (**batch
IN-list, cache-aware, chunked at 500 — the N+1 killer**, `queries.ts:620-655`),
`getNodesByFile`, `getNodesByKind`, `iterateNodesByKind` (**streaming** —
`stmt.iterate()`, fresh statement per call so the open cursor doesn't clash,
O(1) memory, #610 — `queries.ts:880-887`), `getNodesByName`,
`getNodesByNamePrefix` (range scan `name >= p AND name < p+'￿'` to keep the
index, `queries.ts:943-951`), `getNodesByQualifiedNameExact`, `getNodesByLowerName`,
`getAllNodes`, `getAllNodeNames`/`iterateNodeNames`, `getDistinctFileLanguages`,
`iterateNodesByLanguageWithDecorator` (streaming LIKE pre-filter, #1212).

*Reads (edges):* `getOutgoingEdges(source, kinds?, provenance?)`,
`getIncomingEdges(target, kinds?)`, `findEdgesBetweenNodes` (uses `json_each(?)`
to bind a node-id array), `getDependentFilePaths` / `getDependencyFilePaths`
(file-level projection of the cross-file symbol graph — **all kinds except
`contains`**, the basis for blast-radius/`affected`, `queries.ts:1604-1632`),
`getCrossFileIncomingEdgesWithTarget` (returns edges + target (name,kind) so a
re-index can re-resolve them to shifted target ids, #899).

*Search:* `searchNodes` (`queries.ts:987-1104`) is the orchestrator —
1. parse field-qualifiers (`kind:`, `lang:`, `path:`, `name:`) out of the query;
2. FTS5 prefix search (`searchNodesFTS`), else LIKE substring (`searchNodesLike`),
   else bounded-edit-distance fuzzy (`searchNodesFuzzy`);
3. supplement with exact-name matches (BM25 can bury short exact names);
4. multi-signal rescore (`kindBonus + pathRelevance + nameMatchBonus`), sort, trim;
5. apply `path:`/`name:` hard filters last.
`searchNodesFTS` (`queries.ts:1201-1264`) builds `"term"*` prefix queries joined
by `OR`, strips FTS operators, and ranks by `bm25(nodes_fts, 0, 20, 5, 1, 2)`
(column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2),
over-fetching 5× then rescoring. `findNodesByExactName` does a two-pass
distinctive-file co-location boost for common names like `run` (`queries.ts:1336-1415`).

*Segment vocab:* `insertNameSegments` (idempotent via in-memory set + `INSERT OR
IGNORE`), `clearNameSegmentVocab`, `isNameSegmentVocabEmpty`,
`getDistinctNodeNames` (paged rebuild), `getSegmentCoOccurrence` (co-occurrence
probe folding plural variants inside SQL, #1146), `getSegmentNameCounts` (rarity),
`getNamesForSegment`.

*Heuristics:* `getDominantFile` (densest same-file edge concentration, excludes
test/generated), `getTopRouteFile`, `getRoutingManifest` (route→handler join).

*Stats/metadata:* `getStats` (single query for node/edge/file counts + grouped
`nodesByKind`/`edgesByKind`/`filesByLanguage`), `getNodeAndEdgeCount`,
`getLastIndexedAt`, `getMetadata`/`setMetadata`/`getAllMetadata`, `clear`.

**Prepared-statement management:** two idioms coexist —
(a) *cached* statements in `stmts` for fixed SQL (hot single-row paths);
(b) *ad-hoc* `db.prepare(sql)` for **dynamic SQL** whose placeholder count varies
(IN-lists, optional `kind IN (…)` / `language IN (…)` clauses). Ad-hoc statements
are re-prepared each call — cheap because `node:sqlite` caches by SQL text.

**Transaction/batching strategy (write/index path):** every batch writer wraps a
loop in `db.transaction(fn)()` (a single implicit `BEGIN…COMMIT`). Chunking under
`SQLITE_PARAM_CHUNK_SIZE = 500` (`queries.ts:51`) guards every IN-list against
`SQLITE_MAX_VARIABLE_NUMBER` (tests push 33,000 ids, #1001, `db-perf.test.ts:117`).

**Hot-path perf tricks:** LRU node cache; `getNodesByIds` batch lookup
(collapses graph-traversal N+1, "~10–50× faster", `queries.ts:606-619`);
`iterate()` streaming for unbounded scans; `segmentedNames` fast-path;
BM25-weighted over-fetch-then-rescore; and the **WAL-deferral system** (below).

### 2.4 SQLite adapter (`db/sqlite-adapter.ts`)

Abstracts a single backend: **Node 22.5+'s built-in `node:sqlite`
(`DatabaseSync`)** — real SQLite compiled into Node, with WAL + FTS5 + mmap +
`@named` params, **no native build step and no wasm fallback**
(`sqlite-adapter.ts:1-11, 39`). The adapter is a better-sqlite3-*shaped* facade:
`SqliteStatement { run, get, all, iterate }` and `SqliteDatabase { prepare, exec,
pragma, transaction, close, open }`. The only real shims are `.pragma()`
(read/write helper), `.transaction()` (BEGIN/COMMIT/ROLLBACK wrapper,
`sqlite-adapter.ts:109-121`), and `open`←`isOpen`. `createDatabase` returns
`{db, backend: 'node-sqlite'}` and each `DatabaseConnection` reports its backend
per-instance (MCP opens multiple project DBs in one process, `sqlite-adapter.ts:130-149`).

### 2.5 WAL valve (`db/wal-valve.ts`)

Solves **WAL-checkpoint I/O amplification during a bulk index** (#1231). The
default `wal_autocheckpoint=1000` re-writes hot B-tree/FTS pages into the main DB
"over and over — measured at ~95% of ALL disk I/O … the difference between 45s
and 19+ minutes on HDD-class storage" (`wal-valve.ts:5-11`). So bulk index
**disables auto-checkpointing** (`setWalAutocheckpoint(0)`) to turn the store
into pure sequential WAL appends, and a `WalCheckpointValve` bounds WAL growth:
- watches WAL size on a 2s timer; past a **soft threshold (default 256 MB of
  *growth*)** it fires an **off-thread PASSIVE checkpoint** (never blocks the
  writer);
- the load-bearing subtlety: **a WAL file's size never shrinks** — after a full
  backfill the next commit restarts it from the top and frames recycle, so the
  valve tracks `sizeAtLastFullBackfill` and triggers on *growth past that
  baseline*, refreshed only when a checkpoint reports `log === checkpointed`
  (`wal-valve.ts:23-33, 98-101, 186-205`);
- **backpressure**: past a hard cap (2× soft) it *pauses the writer* between
  transactions until a full backfill lands (`wal-valve.ts:129-139`);
- `foldNow()` folds the whole WAL at a phase boundary (after parsing, before
  resolution's first reads) so the next phase never pages a multi-GB WAL on the
  main thread (`wal-valve.ts:157-163`).

**Does it matter in C#?** The *problem* (WAL amplification on slow disks during
bulk writes) is real and SQLite-level, so it can recur. But the *mechanism* is
heavily Node-specific (watchdog heartbeat, worker_threads, single-threaded event
loop that a synchronous checkpoint would freeze). In the .NET worker, a
background checkpoint is a `Task.Run` on a second `SqliteConnection` — far
simpler, and the "keep the event loop turning" motivation largely evaporates.
**MVP can skip the valve entirely** (defer auto-checkpoint during bulk + one
`wal_checkpoint(TRUNCATE)` between phases and at end) and only add growth-bounded
throttling if HDD repros surface (see §5, §7).

### 2.6 Migrations (`db/migrations.ts`)

`CURRENT_SCHEMA_VERSION = 8`. `runMigrations(db, from)` filters `version > from`,
sorts, and runs each `up()` in its own transaction, recording it in
`schema_versions`. Enumerated:

| v | Description | Operations |
|---|---|---|
| 1 | Initial schema | (schema.sql) |
| 2 | metadata + provenance + ref context | CREATE `project_metadata`; ADD `unresolved_refs.file_path`, `.language`, `edges.provenance`; `idx_unresolved_file_path`, `idx_edges_provenance` |
| 3 | case-insensitive lookup | `idx_nodes_lower_name ON nodes(lower(name))` |
| 4 | drop redundant edge indexes | `DROP INDEX idx_edges_source`, `idx_edges_target` |
| 5 | receiver-type inference | ADD `nodes.return_type` (#645) |
| 6 | edge dedup | `DELETE` duplicate rows (keep `MIN(id)` per identity group), then `CREATE UNIQUE INDEX idx_edges_identity` (#1034) |
| 7 | prompt-hook vocab | CREATE `name_segment_vocab` WITHOUT ROWID |
| 8 | retryable failed refs | ADD `unresolved_refs.status`, `.name_tail` (guarded by `PRAGMA table_info`); `idx_unresolved_status`; partial `idx_unresolved_failed_tail` (#1240) |

Almost all are **idempotent additive DDL** (`CREATE … IF NOT EXISTS`, guarded
`ALTER TABLE ADD COLUMN`); the only **one-time data mutation** is v6's dedup
DELETE, and the only *destructive* DDL is v4's `DROP INDEX IF EXISTS`.

### 2.7 Graph traversal & queries (`graph/*`)

`GraphTraverser` (`traversal.ts`) — pure algorithms over `QueryBuilder`:
- `traverseBFS` / `traverseDFS` — general traversal with `direction`
  (out/in/both), `edgeKinds`/`nodeKinds` filters, `maxDepth`, `limit`,
  `includeStart`. Structural edges (`contains`, `calls`) are prioritized first
  (`traversal.ts:96-99`). Batch-fetches neighbors via `getNodesByIds` (no N+1).
  Careful invariants pinned by tests (§ below): an **`enqueued` set separate from
  `visited`** so parallel edges to the same target aren't lost (#1090), and a
  **per-add limit check** so one high-degree node can't overshoot `opts.limit`
  (#1087/#1088).
- `getCallers` / `getCallees` — recursive, `maxDepth` default 1. Incoming/outgoing
  edges of kinds `['calls','references','imports','instantiates']` — **`instantiates`
  counts as a call** (constructing a class calls its constructor, #774). `visited`
  is marked **before** the depth check so a caller reached via two edges isn't
  duplicated (#1086).
- `getCallGraph` — callers ∪ callees to `depth` (default 2).
- `getImpactRadius` (blast radius) — follows **incoming** edges (dependents) to
  `maxDepth` (default 3), **excluding `contains`** (a container doesn't *depend*
  on its members, #536), but for container kinds it descends into children so
  callers of contained methods appear. Records every dependency edge even to
  already-collected nodes (#1089).
- `findPath` — BFS shortest path (outgoing), returns node/edge list or null.
- `getTypeHierarchy` — ancestors (`extends`/`implements` outgoing) ∪ descendants
  (incoming).
- `getAncestors` (walk `contains` upward), `getChildren` (`contains` downward),
  `findUsages` (all incoming edges).

`GraphQueryManager` (`queries.ts`) — higher-level:
- `getContext(nodeId)` — focal + ancestors + children + incoming/outgoing refs
  (excluding `contains`) + type nodes (`type_of`/`returns`) + imports.
- `getFileDependencies` / `getFileDependents` — delegate to the DB projection
  (`getDependencyFilePaths`/`getDependentFilePaths`).
- `getExportedSymbols`, `findByQualifiedName` (glob→regex scan),
  `getModuleStructure`, `findCircularDependencies` (DFS over file deps),
  `getNodeMetrics`, `findDeadCode` (kinds with zero non-`contains` incoming edges,
  skipping exported), `getFilteredSubgraph`.

These `GraphTraverser`/`GraphQueryManager` methods are exactly what the MCP tools
(`callers`, `callees`, `impact`/`affected`, `trace`, `context`) call — this
subsystem is their engine.

### 2.8 Behavior spec from tests

- `db-perf.test.ts` — batch lookup semantics (Map keyed by id, missing ids
  absent, empty input, 1500-id chunking, cache-hit-serves-stale-row); cache
  invalidation on `INSERT OR REPLACE`; `insertEdges` skips dangling endpoints and
  **does not trust the node cache**; edge identity uniqueness (byte-identical
  collapse, metadata-only differences dedup, distinct line/col kept, NULL line/col
  folded via IFNULL, cross-call dedup); migration v6 collapses pre-existing dups.
- `wal-deferral.test.ts` — `wal_autocheckpoint` read/write; WAL grows with
  deferred commits; PASSIVE checkpoint backfills from a worker connection; valve
  soft/hard/baseline/foldNow/dedupe behavior; **identical graph with and without
  deferral** end-to-end.
- `node-sqlite-backend.test.ts` / `sqlite-backend.test.ts` — WAL mode, FTS5
  search, cross-file caller resolution all exercised end-to-end.
- `graph.test.ts` — traversal/context/callgraph/type-hierarchy/impact/path/
  ancestors/children; **file-dependency-via-symbol-graph** (not imports); the
  #1086–#1090 edge-completeness/limit regressions driven directly against an
  in-memory graph stub.
- `symbol-lookup.test.ts` — module-qualified lookups (`stage_apply::run`,
  `Session.request`, slash qualifiers) — relevant to search/`matchesSymbol`.
- `iterate-nodes-by-kind.test.ts` — streamed set == eager set; an open iterator
  cursor coexists with other queries on the same connection.
- `db-reopen-on-replace.test.ts` — `isReplacedOnDisk` / `reopenIfReplaced`
  POSIX-only inode self-heal.

---

## 3. Public/internal contracts the C# port must reproduce

### 3.1 Domain types (`types.ts`)

- **`Node`** — 21 fields (§2.1). `NodeKind` union of 22 kinds
  (`types.ts:18-41`: file, module, class, struct, interface, trait, protocol,
  function, method, property, field, variable, constant, enum, enum_member,
  type_alias, namespace, parameter, import, export, route, component).
- **`Edge`** — `source, target, kind, metadata?, line?, column?, provenance?`.
  `EdgeKind` union of 12 (`types.ts:48-60`: contains, calls, imports, exports,
  extends, implements, references, type_of, returns, instantiates, overrides,
  decorates). `ReferenceKind = EdgeKind | 'function_ref'` (internal-only, maps to
  a `references` edge, `types.ts:293-299`).
- **`FileRecord`**, **`UnresolvedReference`** (note `rowId?` — precise cleanup
  target, #1269), **`Language`** union of 42 (`types.ts:66-109`).
- Query/result types: `Subgraph {nodes: Map, edges, roots, confidence?}`,
  `TraversalOptions`, `SearchOptions`, `SearchResult {node, score, highlights?}`,
  `SegmentMatch`, `Context`, `GraphStats`, `SchemaVersion`.

### 3.2 `QueryBuilder` surface

~70 public methods (catalogued in §2.3). The consumers that constrain the C#
signatures: `GraphTraverser`/`GraphQueryManager` (need `getNodeById`,
`getNodesByIds`→`Map`, `getOutgoingEdges`/`getIncomingEdges(id, kinds?)`,
`getNodesByKind`, file-dep projections), the resolution engine (unresolved-ref
family), the MCP tools (`searchNodes`, `getStats`, metadata), and `sync`
(segment-vocab + retryable-failed-ref family).

### 3.3 `DatabaseConnection` surface

`initialize`/`open`, `getDb`, `transaction`, `getStats`-support (`getSize`), WAL
family (`getWalSizeBytes`, get/set autocheckpoint, `checkpointWalPassive`,
`runMaintenance`), `getJournalMode`, `getSchemaVersion`, `isReplacedOnDisk`,
`close`/`isOpen`; module funcs `getDatabasePath`, `removeDatabaseFiles`.

---

## 4. External dependencies → C# mapping

| CodeGraph dep / API | Use | C# / NuGet equivalent | AOT? |
|---|---|---|---|
| `node:sqlite` (`DatabaseSync`) | the entire storage engine | **`Microsoft.Data.Sqlite` 10.0.9** + **`SQLitePCLRaw.bundle_e_sqlite3` 3.0.3** (already referenced by `OpenCowork:…/OpenCowork.Native.Worker.csproj`) | ✅ P/Invoke, AOT-safe |
| SQLite **FTS5** + `bm25()` + external-content | `nodes_fts` search | **compiled into the bundle** — verified below | ✅ |
| SQLite **JSON1** (`json_each`) | `findEdgesBetweenNodes` | compiled into the bundle — verified | ✅ |
| SQLite expression / partial indexes, `WITHOUT ROWID`, `COLLATE NOCASE`, `IFNULL` | schema | all verified | ✅ |
| WAL PRAGMAs, `wal_checkpoint(PASSIVE/TRUNCATE)` | valve/maintenance | same PRAGMAs via `SqliteCommand` | ✅ |
| `@named` params | inserts | `SqliteParameter` `@name` (already used in `OpenCowork:DbSql.cs`) | ✅ |
| `stmt.iterate()` streaming | O(1) scans | `SqliteDataReader` (streaming by nature) | ✅ |
| `db.transaction(fn)()` | batch atomicity | `SqliteConnection.BeginTransaction()` | ✅ |
| `crypto.createHash('sha256')` | node id, content hash | `System.Security.Cryptography.SHA256` | ✅ |
| `worker_threads` (checkpoint/maintenance off-thread) | non-blocking WAL fold | `Task.Run` + a second `SqliteConnection` | ✅ (simpler) |
| `fs.statSync(...).ino` (inode) | `isReplacedOnDisk` | `stat`/`File.GetLastWriteTimeUtc` — **inode not exposed by BCL**; P/Invoke `stat` or drop (see §5) | ⚠ |
| `JSON.stringify` / `safeJsonParse` for column values | decorators, type_parameters, metadata, candidates, errors | `System.Text.Json` **source-gen** for `string[]`; keep opaque `metadata` as a raw JSON `string` | ⚠ must be source-gen, no reflection |
| `RegExp` (search glob→regex, path heuristics) | `findByQualifiedName`, `isLowValueFile` | `System.Text.RegularExpressions` (prefer `GeneratedRegex` for AOT) | ⚠ use `[GeneratedRegex]` |
| `picomatch`/`ignore` (dir scan) | *not this subsystem* — extraction/discovery | reuse `OpenCowork:Modules/File` | n/a |

### 4.1 FTS5-in-bundle verdict — VERIFIED (hard gate cleared)

I compiled and ran a throwaway .NET 10 console app referencing the **exact**
package versions (`Microsoft.Data.Sqlite` 10.0.9 + `SQLitePCLRaw.bundle_e_sqlite3`
3.0.3) on this machine. Results:

```
sqlite_version=3.50.4
FTS5=OK bm25=-1E-06                 # CREATE VIRTUAL TABLE … USING fts5(…) + MATCH + bm25()
external-content OK                 # fts5(name, content='nodes', content_rowid='rowid')
json_each=OK (3)                    # JSON1
expr_index_lower=OK                 # CREATE INDEX … ON nodes(lower(name))
partial_index=OK                    # CREATE INDEX … WHERE status='failed'
without_rowid=OK                    # PRIMARY KEY(...) WITHOUT ROWID
unique_ifnull_index=OK              # UNIQUE(... , IFNULL(line,-1), IFNULL(col,-1))
bm25_weights=OK                     # bm25(f,0,20,5) column-weighted ranking
collate_nocase=OK (1)               # 'ABC' = 'abc' COLLATE NOCASE
prefix_range=OK (Foo)               # name >= 'F' AND name < 'F'||char(0xFFFF)
```

The bundled native `e_sqlite3` in 3.0.3 is **SQLite 3.50.4 with
`SQLITE_ENABLE_FTS5` + JSON1 + bm25 + external-content all compiled in.** This
corroborates the ecosystem record that FTS5 has shipped in `bundle_e_sqlite3`
since v1.1.10 ([SQLitePCL.raw #171](https://github.com/ericsink/SQLitePCL.raw/issues/171),
[NuGet: SQLitePCLRaw.bundle_e_sqlite3](https://www.nuget.org/packages/SQLitePCLRaw.bundle_e_sqlite3),
[SQLite FTS5 docs](https://www.sqlite.org/fts5.html)).

**No fallback required.** (Had it failed, the fallbacks would have been: swap to
`SQLitePCLRaw.bundle_e_sqlite3mc` or a custom-compiled `e_sqlite3` with FTS5, or
degrade `searchNodesFTS` to the LIKE/`name`-index path — but none of that is
needed.)

---

## 5. Porting challenges & risks (ranked)

1. **FTS5 availability — RESOLVED.** Was the one true gate; verified compiled in
   (§4.1). Down to a non-issue.

2. **AOT reflection-free JSON for column payloads.** `decorators`,
   `type_parameters` (`string[]`), `candidates` (`string[]`), `errors`
   (object array), and `metadata` (opaque `Record<string,unknown>`) are stored as
   JSON `TEXT`. With `JsonSerializerIsReflectionEnabledByDefault=false`, every
   (de)serialize must be source-gen. *Mitigation:* register `string[]` in a
   `GraphJsonContext`; keep `metadata` and `errors` as **raw JSON strings**
   in-process (they are only stored and echoed back — never inspected by the
   storage/graph layer), parsing them to `JsonElement` only at the MCP boundary.
   This removes the need to model `metadata` at all internally.

3. **Recursion depth in traversal.** `getCallers`/`getCallees`/`getImpact`/
   `getTypeAncestors|Descendants`/`dfsRecursive` are natively recursive. On deep
   graphs C# risks `StackOverflowException` (uncatchable, kills the worker).
   *Mitigation:* the algorithms are already depth-capped (default 1–3) so MVP is
   safe, but convert the unbounded ones (`traverseDFS`, cycle DFS) to an explicit
   stack.

4. **Preserving the exact edge-completeness/limit invariants (#1086–#1090).**
   The `enqueued`-vs-`visited` split, per-add limit checks, mark-visited-before-
   depth-check, and record-edge-unconditionally rules are subtle and each fixes a
   real bug with a pinned test. *Mitigation:* port `graph.test.ts`'s in-memory
   traverser tests **first** (they need no SQLite) as the C# TDD harness.

5. **`isReplacedOnDisk` inode check has no BCL equivalent.** The self-heal for
   `.codegraph/` deleted+recreated under a live holder (#925) relies on POSIX
   `dev:ino`. *Mitigation:* this hazard is largely **moot in the sidecar** — the
   worker is the single long-lived owner; there is no separate CLI process racing
   it, and a full re-index goes through the worker itself. Defer entirely; if
   needed later, P/Invoke `stat(2)` on POSIX and no-op on Windows (matching the TS
   behavior).

6. **WAL amplification on HDDs.** The underlying I/O problem is SQLite-level and
   can recur; only the Node-specific *machinery* is redundant. *Mitigation (MVP):*
   disable `wal_autocheckpoint` during bulk index, `wal_checkpoint(TRUNCATE)`
   between phases and at end (off a background `Task`); add growth-bounded
   throttling only if repros appear. Note OpenCowork's existing
   `DbConnectionFactory` already sets `wal_autocheckpoint = 4000` — the graph DB
   needs its **own** connection factory with graph-tuned PRAGMAs, not the shared
   `data.db` one.

7. **`node:sqlite` param-limit differs (32766) vs default 999.** Chunking at 500
   is already backend-agnostic and safe for `Microsoft.Data.Sqlite` (which uses
   the compiled default). Keep `SQLITE_PARAM_CHUNK_SIZE = 500`.

8. **`lower()` / `COLLATE NOCASE` are ASCII-only in SQLite.** TS relies on exactly
   this (SQLite's built-in, not JS `toLowerCase`). C# must **not** substitute
   `string.ToLowerInvariant()` in SQL-equivalent spots — keep the work in SQL so
   behavior matches. `InvariantGlobalization=false` is irrelevant here (SQLite's
   collation is independent of .NET culture). Low risk if we mirror the SQL.

9. **`INSERT OR REPLACE` + FTS triggers churn.** `insertNode` uses `OR REPLACE`,
   which fires delete+insert triggers on `nodes_fts` per replaced row. Full
   re-index avoids this by unlinking the file (`removeDatabaseFiles`); the C# port
   must keep that "unlink, don't DELETE" strategy for full rebuilds.

10. **Struct-vs-class for `GraphNode`/`GraphEdge` on million-node graphs.**
    Millions of small heap objects pressure GC. *Mitigation:* readonly `record
    struct` for `GraphEdge` (small, value-like); `sealed class`/`record` for
    `GraphNode` (21 fields, passed by ref through Maps). Measure before
    micro-optimizing.

---

## 6. Recommended C# design

### 6.1 Module boundary

A **new worker module**: `OpenCowork:Modules/CodeGraph/` implementing
`IWorkerModule` (Name `"codegraph"`), registered in `Hosting/WorkerModuleCatalog.cs`.
This doc's storage+graph layer is the module's **internal engine**; the RPC method
surface (MCP tools) belongs to a sibling analysis doc. The graph DB is a
**separate SQLite file per project**, *not* `data.db`, but it follows the
`Modules/Db` conventions (connection factory, additive migrator, `DbSql`-style
helpers). File layout (mirrors `Modules/Db`):

```
Modules/CodeGraph/
  CodeGraphModule.cs            # IWorkerModule; wires RPC methods (sibling doc)
  Storage/
    GraphConnectionFactory.cs   # ≈ DbConnectionFactory, graph-tuned PRAGMAs
    GraphDatabase.cs            # ≈ DatabaseConnection: lifecycle, WAL, maintenance, path
    GraphSchema.cs              # final DDL (one raw string) + additive migrator
    GraphStore.cs               # ≈ QueryBuilder (partial class, split by area)
    GraphStore.Nodes.cs
    GraphStore.Edges.cs
    GraphStore.Files.cs
    GraphStore.Refs.cs
    GraphStore.Search.cs
    GraphStore.Segments.cs
    GraphStore.Stats.cs
    NodeIdFactory.cs            # sha256 id + content hash
  Graph/
    GraphTraverser.cs           # ≈ traversal.ts
    GraphQueryManager.cs        # ≈ graph/queries.ts
  CodeGraphModels.cs            # GraphNode, GraphEdge, FileRecord, UnresolvedReference,
                                # Subgraph, SearchResult, GraphStats, enums/constants
  CodeGraphJsonContext.cs       # source-gen: MCP result DTOs + string[]
```

### 6.2 Connection & transaction management

- **One long-lived `SqliteConnection` per open project DB**, owned by a
  `GraphDatabase`. A `GraphDatabaseRegistry` (Dictionary keyed by normalized db
  path) holds the open set, matching CodeGraph's "MCP opens multiple project DBs
  in one process". `Microsoft.Data.Sqlite` is not thread-safe per connection →
  serialize access with a per-`GraphDatabase` lock (the worker dispatches RPCs;
  index runs are the only concurrency), or a dedicated writer with a shared-cache
  reader pool later.
- **`GraphConnectionFactory.Open`** (graph-specific PRAGMAs, order preserved):
  `busy_timeout=5000` → `foreign_keys=ON` → `journal_mode=WAL` →
  `synchronous=NORMAL` → `cache_size=-64000` → `temp_store=MEMORY` →
  `mmap_size=268435456`. Call `SQLitePCL.Batteries_V2.Init()` once (as
  `DbConnectionFactory` does).
- **Transactions:** `using var tx = conn.BeginTransaction();` … `tx.Commit();`.
  Batch writers reuse a **prepared `SqliteCommand`** (create once, `Prepare()`,
  bind parameters by set-value, `ExecuteNonQuery()` per row) inside the tx.

### 6.3 Prepared-statement / DTO handling (AOT)

- **Row → object mapping by ordinal**, not reflection: `reader.GetString(0)`,
  `reader.IsDBNull(i)`, etc. This is the fastest and the only AOT-safe approach;
  it directly replaces `rowToNode`/`rowToEdge`/`rowToFileRecord`.
- **Prepared statements:** hold reusable `SqliteCommand` fields on `GraphStore`
  (the analog of the `stmts` bag) for hot fixed-SQL paths; build ad-hoc commands
  for dynamic IN-list SQL (chunked at 500).
- **JSON columns:** `string[]` via `CodeGraphJsonContext` source-gen; `metadata`/
  `errors` kept as raw JSON strings internally (see §5.2).
- **MCP DTOs:** every result crossing IPC registered in `CodeGraphJsonContext`
  (`[JsonSerializable(typeof(...))]`), exactly like `WorkerJsonContext`
  (`OpenCowork:Serialization/WorkerJsonContext.cs`), returned via
  `WorkerResponse.Json(dto, CodeGraphJsonContext.Default.X)`.

### 6.4 Schema & migration strategy — collapse to final

**Key simplification:** there are **no legacy CodeGraph TS databases** in
OpenCowork's world, so migrations v2–v8 are dead history. Emit the **final (v8-
equivalent) schema directly** as one idempotent DDL block (all columns, all
indexes including `idx_edges_identity` UNIQUE from row zero, `nodes_fts` +
triggers, `name_segment_vocab`, `project_metadata`). For the port's *own* future
evolution, adopt OpenCowork's proven pattern: `CREATE … IF NOT EXISTS` +
`EnsureColumn(conn, table, col, decl)` (idempotent, `OpenCowork:DbSchemaMigrator.cs:727+`),
plus a tiny `schema_versions`-guarded hook for any one-time data fixup (the v6-
style dedup). This gives the best of both: no fragile long migration chain, but a
place to hang the rare data migration.

### 6.5 DB file location per project

CodeGraph uses `<projectRoot>/.codegraph/codegraph.db`. Two options for
OpenCowork (flag for the lead, §8): **(A)** keep it in-project under
`.codegraph/` (co-located, gitignorable, matches CodeGraph semantics); **(B)**
centralize under `~/.open-cowork/codegraph/<sha256(projectRoot)>/codegraph.db`
(keeps the user's repo clean, no accidental commits, natural for a sidecar that
already owns `~/.open-cowork/`). **Recommend (B)** for OpenCowork — the sidecar is
the single owner, users don't want a `.codegraph/` appearing in every repo, and it
sidesteps the entire #925 inode-replace class of problems.

### 6.6 Node id & hashing

`NodeIdFactory.NodeId(filePath, kind, name, line)` = `$"{kind}:" +
Convert.ToHexString(SHA256(utf8($"{filePath}:{kind}:{name}:{line}")))[..32].ToLowerInvariant()`.
`ContentHash(bytes)` = full lowercase hex SHA-256. Must match the TS byte-for-byte
if any cross-tool DB compatibility is ever wanted (not required for a clean-room
rewrite, but cheap to keep identical).

### 6.7 WAL maintenance (MVP)

`GraphDatabase.SetBulkMode(on)` sets `wal_autocheckpoint = 0` for the index run;
`CheckpointAsync()` runs `PRAGMA wal_checkpoint(TRUNCATE)` on a background `Task`
with a second connection between phases and at completion; restore
`wal_autocheckpoint = 1000` after. No valve class in MVP.

---

## 7. MVP vs later

**MVP (a working, queryable graph store):**
- Final schema DDL + `GraphConnectionFactory` + `GraphDatabase` lifecycle
  (open/create/close, transaction, `GetSize`, WAL bulk-mode + checkpoint).
- `NodeIdFactory`; domain models + `NodeKind`/`EdgeKind`/`Language` constants.
- `GraphStore` writes: `InsertNode(s)` (`INSERT OR REPLACE`, cache-invalidate),
  `InsertEdge(s)` (`INSERT OR IGNORE` + endpoint validation via chunked existence
  check), `UpsertFile`, `DeleteFile`/`DeleteNodesByFile` (FK cascade),
  `InsertUnresolvedRefsBatch`, ref-resolve delete/clear.
- `GraphStore` reads: `GetNodeById` (+ LRU cache), **`GetNodesByIds` batch**,
  `GetNodesByKind` + `IterateNodesByKind` (reader-streaming), by name / qualified
  name / lower name / file / prefix; edges out/in with kind filter; file-dep
  projections; `GetStats`, metadata.
- **FTS5 search**: `SearchNodesFts` (bm25-weighted, prefix, over-fetch+rescore) +
  LIKE fallback + exact-name supplement + multi-signal rescore.
- **Graph**: `GraphTraverser` (BFS/DFS, callers/callees, impact, path, type
  hierarchy, ancestors/children) + `GraphQueryManager.GetContext`, file deps,
  metrics, dead code.
- Port `graph.test.ts` + `db-perf.test.ts` invariants as the C# test harness.

**Later:**
- Fuzzy search (bounded edit distance), `findNodesByExactName` co-location boost.
- Segment-vocab prompt-hook gate (`name_segment_vocab` + co-occurrence/rarity
  queries) — only if the front-load hook is ported.
- Retryable-failed-ref machinery (status/`name_tail`, `GetRetryableFailedReferences`,
  #1240) — only with incremental sync.
- Heuristics: `GetDominantFile`, `GetTopRouteFile`, `GetRoutingManifest`.
- `GetCrossFileIncomingEdgesWithTarget` (edge preservation across re-index, #899).
- WAL growth valve (only if HDD amplification repros).
- Inode-replace self-heal (§5.5 — likely never, given location option B).
- `findCircularDependencies`, `getModuleStructure`, `findByQualifiedName`.

---

## 8. Open questions / decisions for the architect

1. **DB file location — (A) in-project `.codegraph/` vs (B) centralized
   `~/.open-cowork/codegraph/<hash>/`.** I recommend **(B)**; it removes the whole
   #925 self-heal class and keeps user repos clean. Cross-cutting with how sync /
   file-watching identify a project. *(Owner: lead.)*

2. **Migration model.** Confirm we **collapse to the final schema** (no v2–v8
   chain) and evolve via `EnsureColumn` + `schema_versions`-guarded data fixups.
   Affects how much of `migrations.ts` gets ported (recommend: almost none).

3. **Concurrency model for the graph connection.** One serialized writer + N
   readers? Single locked connection? This depends on whether indexing runs
   concurrently with query RPCs in the sidecar (it will, once file-watching sync
   exists). Interacts with the WAL/checkpoint design.

4. **Keep or drop the WAL valve.** Recommend drop for MVP; decide the threshold at
   which the growth-bounded throttle is worth re-adding. Cross-cuts the indexer
   analysis (who owns bulk-mode toggling).

5. **`GraphNode`/`GraphEdge` as struct vs class**, and whether `Subgraph.nodes`
   stays a `Dictionary<string,GraphNode>` (matches TS `Map`) — a GC/perf call best
   made with a benchmark on a large repo.

6. **Reuse of `Modules/File` scanning/ignore logic** for the extractor's file
   discovery (out of this subsystem's scope but its writes depend on it). Flag so
   the extraction doc and this one don't both reimplement ignore handling.

7. **Enum representation.** `NodeKind`/`EdgeKind`/`Language` are stored as `TEXT`.
   Recommend `static class` string constants (zero mapping cost to/from SQLite,
   AOT-trivial) over C# `enum` (which would need string conversion at every
   boundary). Confirm.

8. **Cross-tool DB compatibility.** Do we need the C# DB to be byte-identical to
   CodeGraph's (same node-id hashing, same schema) so an existing `.codegraph`
   could be read? Assumed **no** (clean-room rewrite); if yes, node-id hashing and
   FTS tokenizer choices become frozen constraints.
