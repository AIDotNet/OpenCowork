# M1–M6 Task Breakdown — the CodeGraph → C# Execution Handbook

> **⚠ Process-model addendum ([reference/04](../reference/04-process-model-and-enablement.md)).**
> The engine ships as an **opt-in standalone sidecar** (`OpenCowork.CodeGraph.Worker`,
> disabled by default), engine code in `OpenCowork.CodeGraph.Core`. Engine-level
> tasks below (M1–M4) are unchanged — they build the `Core` library. The **hosting
> deltas** are: **M0** scaffolds the `Worker` host (see M0 doc); **M5** additionally
> owns the **enablement layer** — the `codegraph.enabled` settings toggle (default
> off), the second `getCodeGraphWorker()` manager + lazy spawn-on-enable, prefix-based
> tool routing (`codegraph/*` → CodeGraph worker), dynamic tool (un)registration on
> toggle (the WebSearch/Browser/Wiki pattern), and the **grammar DOWNLOADING step**
> (fetch/verify/extract the per-RID grammar pack on enable — grammars are downloaded,
> not bundled; reference/04 §5–§6). Wherever a task says `getNativeWorker()`, read
> `getCodeGraphWorker()`.
>
> **What this is.** The engineer-facing expansion of the master roadmap
> ([`../00-overview-and-roadmap.md`](../00-overview-and-roadmap.md) §5). For each
> milestone M1–M6 it gives the goal + entry dependency, a dependency-ordered
> checklist of concrete build tasks (each naming the exact `CodeGraph*` class /
> method to write and the analysis section it derives from), the MVP cut, the
> golden-test gate, expanded acceptance criteria, the risk-register items in play,
> and cross-refs into the `reference/` and `workstreams/` docs.
>
> **How to read a task.** "M3, task 7" tells you: the class to write, the analysis
> §6/§7 that specifies it, and the test that proves it. Sequence within a milestone
> is the intended build order. Class names follow the canonical layout in
> [`../00-overview-and-roadmap.md`](../00-overview-and-roadmap.md) §4 (global
> namespace, `CodeGraph*` prefixes — Decision 6); where an analysis sketched a
> shorter name (`GraphStore`, `NodeIdFactory`), §4's prefixed name (`CodeGraphStore`,
> `CodeGraphNodeIdFactory`) wins.
>
> **Authorities.** Roadmap = `00` §5 (skeleton, do not contradict), Decisions = `00`
> §3, Layout = `00` §4, Risks = `00` §8, Workstreams = `00` §6. Subsystem detail =
> `analysis/01`–`06`. Supplementary references consumed below:
> `reference/01-data-model-and-schema.md` (final DDL), `reference/02-rpc-api-contract.md` (the `codegraph/*` surface),
> `reference/03-tree-sitter-binding.md` (the C-API binding + grammar ABI/patch matrix),
> `workstreams/A-grammar-build-matrix.md`, `workstreams/B-golden-test-porting.md`,
> `00-overview-and-roadmap.md §6 (WS-C)`.

> **M0 is the entry gate for everything below** (`00` §5 M0): the tree-sitter
> `[LibraryImport]` spike proven under `PublishAot=true`, the `CodeGraphModule`
> skeleton (`IWorkerModule` + `WorkerModuleCatalog` entry + `CodeGraphJsonContext` +
> a no-op `codegraph/status` round-trip), and a per-project graph DB created under
> `~/.open-cowork/codegraph/<hash>/` with one smoke FTS5 `MATCH`. M1 assumes the
> module skeleton exists; M2 assumes the tree-sitter spike is ratified.

---

## Critical path at a glance

```
M0 (skeleton + ts spike) ─► M1 (storage/graph core) ─► M2 (extraction) ─► M3 (resolution+synth) ─► M4 (facade/scan/sync/context/search) ─► M5 (tool surface) ═► shippable MVP
                                                          │
        WS-A grammar build ──────────────────────────────┘ (runs alongside M2, scales into M6)
        WS-B golden tests  ── ported one suite ahead of each milestone's code
        WS-C AOT discipline ── enforced in every milestone (DTOs, [GeneratedRegex], [LibraryImport])

M6 = demand-driven parity tail (23 more languages, ~49 more synthesizers, embedded extractors, 7 more tools) — not on the MVP critical path.
```

The shippable MVP is **M1→M5** in strict order; M2 cannot start its extractor
emitters until M1's `CodeGraphStore` write surface exists, M3 cannot resolve until
M2 emits `unresolvedReferences`, M4's `FindRelevantContext` needs M1 search + M3
edges, and M5's `explore` handler is a projection of M4's facade. WS-A (grammars)
is the one parallel track that gates M2 and must have an owner before M2 starts.

---

## M1 — Storage & graph core · size L

### 1. Goal & entry dependency

**Goal:** a queryable, concurrency-correct graph store (nodes/edges/files/refs +
FTS5 search) with the traversal algorithms, built TDD-first so the graph invariants
are pinned before any real data flows through. **Entry dependency:** M0 complete —
the `CodeGraphModule` skeleton registers, `CodeGraphConnectionFactory` +
`CodeGraphSchema` open a per-project DB and run an FTS5 smoke query. Derives from
**analysis/03 §6–§7**.

### 2. Task breakdown (dependency-ordered)

1. **Port the golden harness first** — bring `graph.test.ts` (in-memory traverser,
   needs no SQLite) and `db-perf.test.ts` invariants into the C# test project as the
   TDD oracle before writing traversal/store code. *(03 §2.8, §5.4; WS-B.)*
2. **`CodeGraphModels.cs`** — domain records `CodeGraphNode` (21 fields), `CodeGraphEdge`
   (`readonly record struct`), `FileRecord`, `UnresolvedReference` (with `RowId?`),
   `Subgraph` (`List<Node>` + `Dictionary<string,int>` index — insertion-ordered, not a
   `Map`), `SearchResult`, `GraphStats`; plus `static class` string constants for the
   22–23 `NodeKind`, 12 `EdgeKind`, 41 `Language` vocabularies (Decision 16 — TEXT
   constants, not `enum`; one shared source of truth). Keep `metadata`/`errors` as raw
   JSON strings internally (Decision 7, 03 §5.2). *(03 §3.1, §6.1.)*
3. **`CodeGraphNodeIdFactory.cs`** — `NodeId(filePath, kind, name, line)` =
   `"{kind}:" + hex(sha256("{filePath}:{kind}:{name}:{line}"))[..32]` and
   `ContentHash(bytes)` (full lowercase hex). Shared by extraction *and* resolution
   (Decision 17). *(03 §6.6; 01 §2.3; 02 §3.1.)*
4. **`CodeGraphConnectionFactory.cs`** — graph-tuned PRAGMAs in exact order
   `busy_timeout=5000` → `foreign_keys=ON` → `journal_mode=WAL` → `synchronous=NORMAL`
   → `cache_size=-64000` → `temp_store=MEMORY` → `mmap_size=268435456`; one
   `Batteries_V2.Init()`. Distinct from `data.db`'s factory (Decision 4). *(03 §2.2, §6.2.)*
5. **`CodeGraphSchema.cs`** — the final (v8-equivalent) DDL as one idempotent string:
   all columns, all indexes incl. `idx_edges_identity` UNIQUE from row zero,
   `nodes_fts` external-content FTS5 + its 3 triggers (`nodes_ai/ad/au`),
   `name_segment_vocab` WITHOUT ROWID, `project_metadata`; plus an `EnsureColumn`
   migrator + a `schema_versions`-guarded hook for future data fixups (Decision 18,
   collapse v2–v8). *(03 §2.1, §2.6, §6.4; consumes `reference/01-data-model-and-schema.md`.)*
6. **`CodeGraphDatabase.cs`** — lifecycle (open/create/close), `BeginTransaction`,
   `GetSize`, path resolution to `~/.open-cowork/codegraph/<sha256(root)>/graph.db`
   (Decision 3), `RemoveDatabaseFiles` (unlink `.db`+`-wal`+`-shm`, O(1), never DELETE
   — 03 §2.2 #1067), WAL `SetBulkMode(on)` (`wal_autocheckpoint=0`) +
   `CheckpointAsync` (`wal_checkpoint(TRUNCATE)` on a background `Task`+second
   connection). No valve at MVP (Decision, 03 §2.5, §6.7). *(03 §2.2, §6.7.)*
7. **`CodeGraphStore.Nodes.cs`** — `InsertNode` (`INSERT OR REPLACE`, `@named` params,
   required-field validation, cache-invalidate, segment-vocab materialization for
   non-file/non-import kinds), `InsertNodes` (one transaction), `UpdateNode`,
   `DeleteNode`, `DeleteNodesByFile`; reads `GetNodeById` (LRU max-1000, move-to-end),
   **`GetNodesByIds`** (batch IN-list, cache-aware, 500-chunk — the N+1 killer),
   `GetNodesByKind`, **`IterateNodesByKind`** (true streaming `SqliteDataReader` cursor,
   fresh command per call — Decision 20), by name / qualified / lower / file / prefix
   (range scan). *(03 §2.3, §6.3; 03 §5.7 streaming.)*
8. **`CodeGraphStore.Edges.cs`** — `InsertEdge` (`INSERT OR IGNORE`, dedup via UNIQUE
   identity index), `InsertEdges` (validates **both** endpoints exist via chunked
   `GetExistingNodeIds` — *not* the node cache), `DeleteEdgesBySource`; reads
   `GetOutgoingEdges`/`GetIncomingEdges(id, kinds?)`, `FindEdgesBetweenNodes`,
   file-dep projections `GetDependencyFilePaths`/`GetDependentFilePaths` (all kinds
   except `contains`). *(03 §2.3.)*
9. **`CodeGraphStore.Files.cs` + `.Refs.cs`** — `UpsertFile`, `DeleteFile` (tx:
   nodes-by-file then file row), `GetFile`/`GetFiles`; unresolved-ref write family
   (`InsertUnresolvedRefsBatch`, `DeleteReferencesByRowIds`,
   `DeleteSpecificResolvedReferences`, `MarkReferencesFailed(ByRowIds)`, `ClearUnresolvedReferences`)
   scaffolded now, exercised by M3. *(03 §2.3; consumed by 02 §3.4.)*
10. **`CodeGraphStore.Search.cs`** — `SearchNodesFts` (bm25 weights `0,20,5,1,2`,
    `"term"*` prefix OR-joined, 5× over-fetch then multi-signal rescore
    `kindBonus+pathRelevance+nameMatchBonus`), LIKE fallback, exact-name supplement,
    field-qualifier stripping. *(03 §2.3 search; risk R11.)*
11. **`CodeGraphStore.Segments.cs` + `.Stats.cs`** — `InsertNameSegments` (idempotent
    set + `INSERT OR IGNORE`), `ClearNameSegmentVocab`, `IsNameSegmentVocabEmpty`;
    `GetStats` (single grouped query), `GetNodeAndEdgeCount`, metadata get/set. *(03 §2.3.)*
12. **`CodeGraphTraverser.cs`** — `TraverseBFS`/`TraverseDFS` (direction out/in/both,
    edge/node-kind filters, `maxDepth`, `limit`, structural-edge priority), batch
    neighbor fetch via `GetNodesByIds`; `GetCallers`/`GetCallees` (default depth 1,
    kinds `calls/references/imports/instantiates`), `GetImpactRadius` (incoming, depth
    3, exclude `contains`), `FindPath` (BFS shortest), `GetTypeHierarchy`,
    `GetAncestors`/`GetChildren`/`FindUsages`. **Enforce the #1086–#1090 invariants:**
    `enqueued`≠`visited` split, per-add limit check, mark-visited-before-depth,
    record-edge-unconditionally. **Unbounded DFS → explicit stack** (Decision 21,
    `StackOverflowException` is uncatchable). *(03 §2.7, §5.3–§5.4.)*
13. **`CodeGraphQueryManager.cs`** — `GetContext(id)` (focal + ancestors + children +
    non-`contains` refs + type nodes + imports), `GetFileDependencies`/`Dependents`,
    `GetNodeMetrics`, `FindDeadCode`. *(03 §2.7.)*

### 3. The MVP cut

Ship: final DDL + factory + database lifecycle + node-id factory + models/constants;
the write surface (nodes/edges/files/refs) with batching + endpoint validation + LRU
+ streaming reads; FTS5 search with bm25 + LIKE fallback + exact supplement + rescore;
the full traverser + `GetContext`/file-deps/metrics/dead-code. **Defer** (03 §7 Later):
fuzzy edit-distance search + `FindNodesByExactName` co-location boost; retryable-failed-ref
machinery (lands with M4 sync); `GetDominantFile`/`GetTopRouteFile`/`GetRoutingManifest`;
`GetCrossFileIncomingEdgesWithTarget` (#899); the WAL growth valve; inode-replace
self-heal (moot under centralized DB, Decision 3); `FindCircularDependencies`/`GetModuleStructure`.

### 4. Test gate (WS-B)

`graph.test.ts` (traversal/context/callgraph/type-hierarchy/impact/path/ancestors/
children + file-dependency-via-symbol-graph + the #1086–#1090 regressions) and
`db-perf.test.ts` (batch-lookup semantics, 500/1500-id chunking, cache-hit-serves-stale,
`INSERT OR REPLACE` cache invalidation, `insertEdges` skips dangling + distrusts cache,
edge-identity uniqueness incl. IFNULL line/col folding) both green. `iterate-nodes-by-kind`
streamed-set==eager-set with a coexisting open cursor.

### 5. Acceptance criteria

- Ported `graph.test.ts` + `db-perf.test.ts` invariants pass (`00` §5 M1).
- A hand-seeded graph answers callers / callees / impact / path / context correctly.
- FTS5 `SearchNodes` returns bm25-ranked hits, prefix + exact-name supplement working.
- WAL bulk-mode disables autocheckpoint during a bulk write and a `TRUNCATE`
  checkpoint runs between phases with no valve.
- A concurrent read while a write transaction is open does not throw "database is
  locked" (writer + read path correct under WAL + `busy_timeout`).

### 6. Risks touched (`00` §8)

**R6 (shared-engine concurrency correctness) — owned here:** build single-writer +
read-pool + WAL + `busy_timeout` correct up front; the worker parallelizes RPCs from
day one (Decision 11). **R11 (FTS5 bm25 scale parity):** confirm bm25 magnitudes
during M1 so M4's `×`-multiplier re-ranks weight correctly. **R10 (recursion→stack)**
for the unbounded traversals (Decision 21).

### 7. Cross-refs

`reference/01-data-model-and-schema.md` (final DDL — task 5), `reference/02-rpc-api-contract.md` (the read methods
these back), `workstreams/B-golden-test-porting.md` (harness), `00-overview-and-roadmap.md §6 (WS-C)`
(`string[]` JSON columns via `CodeGraphJsonContext`; ordinal row mapping, no reflection).

---

## M2 — Extraction engine (MVP: 8 languages) · size XL

### 1. Goal & entry dependency

**Goal:** parse real repos into `nodes` + `contains`/value-ref edges +
`unresolvedReferences` (name strings only — even same-file calls are unresolved;
Decision 19). **Entry dependency:** M1's `CodeGraphStore` write surface + node-id
factory; **and the tree-sitter `[LibraryImport]` spike (M0) ratified** plus WS-A
delivering the first 8 grammar libs. Derives from **analysis/01 §6–§7**.

### 2. Task breakdown (dependency-ordered)

1. **`CodeGraphTsBindings.cs`** — the `[LibraryImport]` (source-generated marshalling,
   never `[DllImport]`) binding to the ~40-function tree-sitter C API: `ts_parser_new/
   delete/set_language/parse_string`, node navigation (`ts_node_type`,
   `ts_node_start/end_byte`, `ts_node_start/end_point`, `ts_node_child_by_field_name`,
   `ts_node_named_child`, `ts_node_named_child_count`, sibling/parent, `ts_node_is_named`,
   `ts_node_has_error`). `TSNode`/`TSPoint` as blittable structs. **No query/`.scm`
   engine** (01 §2.6). *(01 §5A, §6.1; Decision 1; consumes `reference/03-tree-sitter-binding.md`.)*
2. **`CodeGraphTsParser.cs` / `TsTree.cs` / `TsNode.cs`** — `IDisposable` parser
   wrapper; `TsNode` a **`readonly struct`** over the native node (matches tree-sitter's
   value-type node, avoids GC pressure across millions of nodes). *(01 §6.1–§6.2.)*
3. **`CodeGraphGrammarRegistry.cs`** — `lang → tree_sitter_<lang>()` handle resolution
   via `DirectPInvoke`/lazy per-RID native-lib load; a missing grammar degrades one
   language, never crashes boot (WS-C). *(01 §5A shape #1; Decision, `00` §6 WS-C.)*
4. **`CodeGraphSourceText.cs`** — owns the UTF-8 `byte[]`, exposes `Slice(startByte,
   endByte) → string` and a byte-offset→(line,col) map (lines 1-based, columns
   0-based). **Centralizes R4** — every position and every `getNodeText` slice goes
   through byte offsets, never `char` index. `preParse` transforms must preserve byte
   length. *(01 §5B R4, §6.2; Decision 22.)*
5. **`CodeGraphExtractorContext.cs`** — the `ExtractorContext` facade hooks call back
   through: `CreateNode`, `VisitNode`, `VisitFunctionBody`, `AddUnresolvedReference`,
   `PushScope`/`PopScope`, readonly `FilePath`/`Source`/`NodeStack`/`Nodes`. *(01 §3.1.)*
6. **`ILanguageExtractor` contract (record)** — the declarative config: `string[]`
   node-type arrays (`functionTypes`, `classTypes`, `methodTypes`, `interfaceTypes`,
   `structTypes`, `enumTypes`, `typeAliasTypes`, `importTypes`, `callTypes`,
   `variableTypes`, `field/propertyTypes`), field-name lookups (`nameField`,
   `bodyField`, `paramsField`, `returnField`), and optional hook delegates. One
   generic engine + N thin configs — the port's leverage point. *(01 §3.1, §6.2.)*
7. **`CodeGraphTreeSitterExtractor.cs`** — the `visitNode` if/else ladder keyed on
   `node.type` against the config arrays, recursing over named children; `createNode`
   (skip-empty-name, id via factory, `buildQualifiedName` from the scope stack —
   **index the scope stack, don't linear-scan** per 01 §2.3 O(n)), and the `contains`
   edge push. *(01 §2.2–§2.4, §6.1.)*
8. **Core emitters** — `extractFunction`, `extractClass`, `extractMethod`,
   `extractInterface`, `extractStruct`, `extractEnum`, `extractImport`, `extractCall`,
   `extractVariable`. Emit `nodes` + `contains` + `unresolvedReferences` only; every
   `calls`/`imports`/`extends`/`implements` is an unresolved ref carrying a name string
   (Decision 19, 01 §2.4). *(01 §2.2, §7.)*
9. **`CodeGraphLanguageMap.cs` + `CodeGraphGeneratedDetection.cs`** — `EXTENSION_MAP`
   (~90 ext → Language), `detectLanguage` (+ `.h` `looksLikeCpp/Objc` content
   heuristic, `codegraph.json` extension overrides), `isSourceFile`, and the
   30-regex `isGeneratedFile` (ranking hint, never a hard filter). *(01 §2.5, §7; 05 §2.6.)*
10. **Data-driven language configs (8)** in `Languages/` — TypeScript, TSX, JavaScript,
    JSX, Python, Go, Java, C#, Rust as `ILanguageExtractor` records. All clean
    first-party grammars; **C# uses the vendored ABI-15 `tree-sitter-c-sharp`** for
    primary-constructor support (01 §7 note; WS-A). *(01 §7 MVP subset.)*
11. **Parse concurrency + safety** — a bounded `Channel<ParseTask>` + worker loop, one
    `CodeGraphTsParser` per consumer thread on **dedicated threads** (or cap parallelism
    to `max(1, ProcessorCount-1)`), SQLite writes marshalled to the single M1 writer;
    parse timeout + 1 MB file cap; frequent `CancellationToken`/`Task.Yield()`
    checkpoints. **This is the R1 heartbeat mitigation** (Decision 10). *(01 §5B R5;
    Decision 10; `00` §8 R1.)*
12. **`CodeGraphExtractionVersion` constant** (= CodeGraph's 24 semantics) to drive
    re-index prompts. *(01 §6.2.)*

### 3. The MVP cut — the 8-grammar set

Ship exactly **8 grammars → 9 language configs**: **TypeScript, TSX, JavaScript, JSX,
Python, Go, Java, C#, Rust** (01 §7). Rationale: all clean, unpatched first-party
`tree-sitter/*` C sources with stable ABIs (lowest R1/R2 risk); TS/JS/C# unlock the
later embedded-extractor delegation. Bootstrap the common libs from `TreeSitter.DotNet`
prebuilt binaries (Decision 1). **Engine scope:** `visitNode` ladder + `createNode` +
`contains` + the 9 core emitters + `generateNodeId` + `detectLanguage` +
`GeneratedDetection`. **Defer** (01 §7): value-refs (`flushValueRefs`) & function-refs
(`FN_REF_SPECS`); framework-specific extractor branches (React/RTK/Pinia/Rust-macro/
Erlang/Lombok); the niche/patched grammars and their languages; the bespoke embedded
extractors (Vue/Svelte/Astro/Razor/CFML/MyBatis/Liquid/DFM); multi-grammar CFML (R6).

### 4. Test gate (WS-B)

`extraction.test.ts` + the per-language golden tests for the 8-grammar set green
(node/edge/unresolved-ref shape, emission order preserved — tests `.sort()` before
comparing). Port these *before* the emitters they cover.

### 5. Acceptance criteria

- Index a mid-size TS + Go + Python repo end to end; node counts **stable across
  re-index** (`00` §5 M2).
- Golden extraction tests green for all 8 languages.
- **A full-core index does NOT trip the `worker/ping` heartbeat** — 15 s ping / 5 s
  timeout / 2-miss SIGKILL survived under load (Decision 10 validated — the milestone's
  defining acceptance check).
- UTF-8 byte-offset positions correct on files with multibyte (CJK/emoji) content —
  `startLine`/columns and `getNodeText` slices match the TS output.

### 6. Risks touched (`00` §8)

**R1 (heartbeat starvation) — owned here; the milestone must validate the Decision-10
mitigation under a full-core index (the #1 integration hazard).** **R4 (AST-walk
fidelity):** golden-tests-first + generic engine + thin configs. **R9 (UTF-8 byte
offsets):** `CodeGraphSourceText` centralizes it. **R2/R3 (grammar sourcing + build
matrix):** MVP uses only 8 clean grammars; owned jointly with **WS-A**.

### 7. Cross-refs

`reference/03-tree-sitter-binding.md` (C-API surface + node-type names + the ABI/patch matrix —
tasks 1, 10), `workstreams/A-grammar-build-matrix.md` (the 8 grammar libs, per-RID),
`workstreams/B-golden-test-porting.md` (`extraction.test.ts`), `00-overview-and-roadmap.md §6 (WS-C)`
(`[LibraryImport]`, lazy grammar load).

---

## M3 — Resolution & MVP synthesizers (~16 units) · size XL

### 1. Goal & entry dependency

**Goal:** turn `unresolvedReferences` into cross-file `calls`/`imports`/`extends`/
`implements` edges, then synthesize the highest-value dynamic-dispatch edges — an
actually-connected graph. **Entry dependency:** M2 emits `nodes` +
`unresolvedReferences`; M1's ref-write family + streaming `IterateNodesByKind`.
Derives from **analysis/02 §6–§7**.

### 2. Task breakdown (dependency-ordered)

1. **`CodeGraphResolutionContext.cs`** — the `IResolutionContext` graph-access facade
   over `CodeGraphStore` + file I/O + LRU caches: `GetNodesInFile`, `GetNodesByName`,
   `GetNodesByQualifiedName`, `GetNodesByKind`, `GetNodesByLowerName`, `IterateNodesByKind`
   (streaming — mandatory for synthesizer memory), `GetImportMappings`, `FileExists`,
   `ReadFile`, `GetProjectRoot`, plus the optional perf accessors (`GetFileLines`,
   `GetMethodMatches`, `GetSupertypes`, `GetProjectAliases`, `GetGoModule`,
   `GetWorkspacePackages`, `GetReExports`). *(02 §3.2, §6.4.)*
2. **Support ports** — **`LruCache.cs`** (Dictionary+LinkedList, insertion-order
   eviction), **`PosixPath.cs`** (forward-slash project-relative; never `Path.Combine`
   raw on graph paths — R6), **`StripComments.cs`** (offset-preserving per-language
   comment/string blanker, verbatim state machine — for at least js/ts/python/java/php/go).
   *(02 §5.4, §5.6, §6.4; Decision 24.)*
3. **`NameMatcher.cs`** — `matchReference` strategy ladder by descending confidence:
   `MatchByFilePath` → `MatchByQualifiedName` → `MatchByExactName` → `MatchFuzzy`;
   `FindBestMatch` (same-file +100, dir-proximity +15/seg cap 80, same-lang +50 /
   cross −80, kind +25, exported +10, line proximity) + `PreferCallSiteFile`;
   `MatchFunctionRef` (callback-as-value, function/method targets only). Language-family
   gating (`sameLanguageFamily`/`crossesKnownFamily`) + `AMBIGUOUS_NAME_CEILING`.
   *(02 §2.3, §7 MVP.)*
4. **`ReceiverTypeInference.cs`** — `MatchMethodCall` + `ResolveMethodOnType` receiver
   inference via `localReceiverTypePatterns` for the **top 6 languages: TS/JS, Python,
   Java, Go, C#, PHP** (+ Java field / PHP property inference). Defer C++ return-type
   chains, Rust/Swift scoped chains, Lua/Luau/R/Pascal. *(02 §2.3, §5.2, §7 MVP.)*
5. **`ImportResolver.cs` + helpers** — `resolveViaImport` + per-language extractors for
   **JS/TS** (relative + tsconfig `paths` via **`PathAliases.cs`** `stripJsonc` +
   monorepo **`WorkspacePackages.cs`** npm/pnpm + re-export chains), **Python**,
   **Go modules** (**`GoModule.cs`** reads root `go.mod`), **Java JVM-FQN**. Defer
   C/C++ includes, PHP includes, COBOL, Nix, Lua, ohpm. *(02 §2.4, §7 MVP; Decision 24.)*
6. **`CodeGraphReferenceResolver.cs`** — the orchestrator (≙ `index.ts`): 3 ordered
   passes; `resolveOne` strategy ladder (skip built-in/external → `hasAnyPossibleMatch`
   pre-filter → `function_ref` gated path → framework `resolve` ≥0.9 early-exit →
   import → name); the `unresolved_refs` **status lifecycle** (pending → delete-on-resolve
   / mark-`failed`+`name_tail` on miss; rowId-precise cleanup #1269); batching (read
   offset 0, 5000/batch) + non-progress guard (#runaway); `gateLanguage`/`gateFrameworkLanguage`
   + built-in filtering. *(02 §2.1–§2.2, §2.5, §6.1, §7 MVP.)*
7. **`IFrameworkResolver` + `FrameworkResolverCatalog.cs`** — the interface (`Name`,
   `Languages?`, `Detect`, `Resolve`, `ClaimsReference`, `Extract`, `PostExtract`) and a
   **static compile-time catalog** (no reflection scanning — Decision, 02 §6.2). *(02 §3.3(a), §6.2.)*
8. **The 9 framework resolvers** (route→handler, most agent-visible value) — `ReactResolver`,
   `ExpressResolver`, `NestJsResolver`, `DjangoResolver`, `FlaskResolver`, `FastApiResolver`,
   `SpringResolver`, `RailsResolver`, `AspNetResolver` (+ cheap `LaravelResolver`). Port
   their hand-rolled parsers verbatim (NestJS JS-object-literal parser + balanced-paren
   scanners; Spring hand-YAML/properties with the #383 secret guard) — do not substitute
   libraries. *(02 §2.2 step 5, §3.3 table, §5.3, §7 MVP.)*
9. **`IEdgeSynthesizer` + `EdgeSynthesizerCatalog.cs` + `SynthesisRunner.cs`** — the
   interface (`Name`, `RequiredLanguages`, `Phase` = GoPrePass|Main, `SynthesizeAsync`
   as `IAsyncEnumerable<Edge>`) + static ordered catalog; `SynthesisRunner` reproduces
   `synthesizeCallbackEdges`: query `GetDistinctFileLanguages()` once → run GoPrePass
   synthesizers **and persist each before the next** → run Main synthesizers whose
   `RequiredLanguages` intersect the present set → merge/dedupe by `source>target` →
   insert in 2000-row batched transactions. Every synthesized edge is
   `provenance:'heuristic'` + `metadata.synthesizedBy`. *(02 §2.6, §6.2, §7 MVP.)*
10. **The 7 dynamic-edge synthesizers** — `GoMethodContainsSynthesizer` +
    `GoImplementsSynthesizer` (**mandatory Go pre-passes**, persisted first),
    `InterfaceOverrideSynthesizer` (~10-language breadth — huge value-per-line),
    `FieldChannelSynthesizer`, `EventEmitterSynthesizer`, `ReactRenderSynthesizer`,
    `ReactJsxChildSynthesizer`. *(02 §2.6, §3.3(b), §7 MVP.)*
11. **Concurrency & yielding** — run the whole resolution+synthesis phase on a
    background `Task` off the IPC thread; `CancellationToken` down every loop; **drop
    `cooperative-yield`** entirely (Decision 14, 02 §5.9); progress via `WorkerMessagePackEvent`.

### 3. The MVP cut — the exact ~16 synthesis units

**Base pipeline is non-optional** (no pipeline ⇒ no cross-file edges ⇒ no graph). On
top of it, the ~16-unit high-leverage slice (02 §7):

- **9 framework resolvers:** `react`, `express`, `nestjs`, `django`, `flask`, `fastapi`,
  `spring`, `rails`, `aspnet` (+ `laravel` as a cheap 10th).
- **7 dynamic-edge synthesizers:** `goCrossFileMethodContainsEdges` + `goImplementsEdges`
  (mandatory for Go correctness), `interfaceOverrideEdges` (~10 languages), `fieldChannelEdges`,
  `eventEmitterEdges`, `reactRenderEdges`, `reactJsxChildEdges`.
- **NameMatcher receiver-inference scope = top 6 languages:** TS/JS, Python, Java, Go,
  C#, PHP.
- **ImportResolver:** JS/TS (relative + tsconfig paths + npm/pnpm workspaces + re-exports),
  Python, Go modules, Java JVM-FQN.

This covers JS/TS + Python + Java/Kotlin + Go + C# end-to-end (parse → resolve → routes
→ override/observer edges). **Defer the ~49-unit tail** (02 §7 Later): state-mgmt
(`reduxThunk`/`rtkQuery`/`pinia`/`vuex`/`objectRegistry`), pub-sub (`spring-event`/
`mediatr`/`celery`/`sidekiq`/`laravel-event`/`erlang-behaviour`), UI-tree
(`flutter`/`arkui*`/`pascal-form`/`vue-template`/`svelte-kit`), bridges (`rn*`/`fabric`/
`expo`/`mybatis`/`gin`/`go-grpc`/`kotlin-expect-actual`/`nix-option`/`cpp-override`/
`closure-collection`), the remaining 17 framework resolvers, and **`c-fnptr` last** (R8).

### 4. Test gate (WS-B)

The `*-synthesizer.test.ts` / `frameworks.test.ts` suite for the shipped units green
(the regex-parity oracle — port before the resolvers), plus `same-name-disambiguation.test.ts`
and `symbol-lookup.test.ts` for `NameMatcher`.

### 5. Acceptance criteria

- On an excalidraw-class repo, an explore-style flow query **connects end-to-end
  across a React re-render + JSX-child boundary** (`00` §5 M3).
- Node/edge counts **stable, no explosion** (the non-progress guard holds — no repeat
  of the 99-file → 5M-edge runaway).
- Synthesized edges carry `provenance:'heuristic'` + `synthesizedBy`.
- Go correctness: `goImplements`/`goMethodContains` pre-passes persisted before the
  passes that read them; interface-override edges appear across languages.

### 6. Risks touched (`00` §8)

**R10 (aggregate breadth) — the MVP cut (16 units) is the primary mitigation;** static
catalogs keep the tail mechanical. **R5-adjacent (regex parity, `00` §3 Decision 23):**
sticky `/y`→`\G`, `.lastIndex`→`Matches`/`NextMatch`, `\w`/`\b`/`\d` Unicode deltas;
`[GeneratedRegex]` for static hot patterns, `RegexOptions.NonBacktracking` over source
bodies (ReDoS). **R8 (`c-fnptr`) deliberately deferred to M6.**

### 7. Cross-refs

`reference/02-rpc-api-contract.md` (edges these produce), `reference/01-data-model-and-schema.md` (`unresolved_refs`
status/`name_tail` lifecycle), `workstreams/B-golden-test-porting.md` (synthesizer suite as
parity oracle), `00-overview-and-roadmap.md §6 (WS-C)` (regex discipline, static catalogs,
`JsonDocument` config parsing — Decision 24).

---

## M4 — Facade, scanning, sync, context & search · size L

### 1. Goal & entry dependency

**Goal:** the full public engine surface — lifecycle + the 6-stage index pipeline +
incremental sync + scanning/ignore + search parsing + **the context ranking that *is*
the product**. **Entry dependency:** M1 storage, M2 extraction, M3 resolution all
plugged in. Derives from **analysis/05 §6–§7** (with search/context ranking as the
high-risk core).

### 2. Task breakdown (dependency-ordered)

1. **`CodeGraphEngine.cs` facade** (Decision 5) — lifecycle `Init`/`Open`/`Recreate`/
   `Close`, wiring the five layers; the 6-stage `IndexAll` pipeline (WAL bulk-mode →
   `index_state='indexing'` marker + `clearNameSegmentVocab` → parse → resolver
   `initialize`+`runPostExtract` → `resolveReferencesBatched` + deferred passes →
   maintenance + version stamping + **completeness reconcile** `complete/partial/failed`);
   `IndexFiles` (subset). **Persist index-run checkpoints to the DB** so a supervised
   respawn is resumable (Decision 15). *(05 §2.1–§2.3, §3.1, §6.3.)*
2. **`CodeGraphDirectoryScanner.cs` + `GitFileEnumerator.cs`** — git fast path via
   **reuse of `Modules/Git/GitTools`** process helper (`ls-files -z -s
   --recurse-submodules` + `-o --exclude-standard`, bounded timeouts), embedded-repo/
   gitlink/worktree recursion, `classifyGitDir`; FS-walk fallback (`scanDirectoryWalk`
   with symlink-cycle guard). *(05 §2.5, §6.4; R2 git availability.)*
3. **`GitIgnoreMatcher.cs` + `ScopeIgnore.cs`** — reproduce git `.gitignore` semantics
   (negations `!vendor/`, nested per-dir, anchored vs floating, `**`, trailing-slash
   dir-only, the ~70-name `DEFAULT_IGNORE_DIRS` applied uniformly + `DEFAULT_IGNORE_PATTERNS`
   incl. Android-res). **Extend, don't reuse**, the worker's `IgnoreMatcher` (it lacks
   negations/nested). `ScopeIgnore` is the single shared indexer+sync scope object with
   the exclude→include→embedded→root precedence. *(05 §2.5, §6.4; R1/R7.)*
4. **`CodeGraphLanguageMap` + `FileClassifier.cs`** — `EXTENSION_MAP` as a
   `FrozenDictionary` + `.h` heuristic + special-filename cases + user overrides;
   `IsGenerated`/`IsTest` via `[GeneratedRegex]`. (M2 shares `CodeGraphLanguageMap`.)
   *(05 §2.6, §6.4.)*
5. **Search — `CodeGraphQueryParser.cs` / `QueryTerms.cs` / `IdentifierSegments.cs`** —
   field-qualified parse (`kind:`/`lang:`/`path:`/`name:` validated against the shared
   `NODE_KINDS`/`LANGUAGES` constants), `boundedEditDistance` fuzzy fallback;
   `extractSearchTerms` (camel/snake/dot split, `STOP_WORDS`, `getStemVariants`);
   `splitIdentifierSegments` (the `name_segment_vocab` producer, Unicode camel/acronym
   boundaries, 2–32 chars, ≤12 segments); `deriveProjectNameTokens` (#720 down-weight).
   *(05 §2.8, §6.5.)*
6. **`CodeGraphContextBuilder.FindRelevantContext`** — the highest-value/highest-risk
   method, **ported channel-by-channel with the exact constants** (Decision, R5):
   exact-name + co-location boost (`+(count-1)*20`), definition-prefix, FTS text
   channel, merge-by-`max`, test down-rank (`×0.3`), core-directory boost (`+25`),
   multi-term co-occurrence re-rank, CamelCase-boundary channel, compound channel;
   then confidence + graph expansion (type-hierarchy, BFS from entry points) + trimming
   (per-file diversity cap, non-production cap, edge recovery). *(05 §2.7, §5.3, §6.5.)*
7. **`ContextFormatter.cs` + `CallPaths.cs`** — markdown/JSON rendering (generated
   files re-sorted last); `buildCallPathsSection` DFS over `calls` edges labeling
   synthesized (dynamic-dispatch) hops. `getCode`/`extractNodeCode` with **config-leaf
   secret redaction** (#383 — return only the key, never the on-disk value). *(05 §2.7, §6.5.)*
8. **`CodeGraphProjectConfig.cs`** — `codegraph.json` (`extensions`/`includeIgnored`/
   `exclude`/`include`), mtime-cached, defensive zero-config-on-failure parse via
   `JsonDocument` (reflection-free, Decision 24). MVP: `extensions` override. *(05 §2.9, §3.3.)*
9. **`Support/`** — `CodeGraphDataDir.cs` (path resolution under `~/.open-cowork/codegraph/<hash>/`),
   `PathSafety.cs` (`validatePathWithinRoot` — lexical + realpath containment,
   security-critical #527/#935), `IndexLock.cs` = **`SemaphoreSlim(1,1)`** (Decision 14
   — the worker is sole writer; PID `FileLock` only if external writers materialize).
   *(05 §3.4, §5.7–§5.8, §6.3.)*
10. **`codegraph/sync` RPC + incremental `Sync`** — wired to the app's debounced
    `fs:file-changed` signal (Decision 13 — **do NOT port the watcher**); the engine
    keeps its internal git-`status`/FS-rehash change detection, git-scoped fast path
    (changed paths → scoped unresolved refs + failed-ref retry #1240), orphan sweep
    (#1187), segment-vocab heal. Index progress streams as a `WorkerMessagePackEvent`;
    cancel via `codegraph/cancel-index` + a run registry (a token can't cross RPC).
    *(05 §2.4, §6.2–§6.3; Decision 13.)*

### 3. The MVP cut — v1 vs deferred scanning/config

**v1 (05 §7):** git-path `GitFileEnumerator` + `ScopeIgnore` with defaults + root
`.gitignore` (incl. negations) + FS-walk fallback + `LanguageMap`/`isSourceFile`; the
**full** `FindRelevantContext` ranking pipeline (a degraded version isn't worth
shipping — Decision, R5); `SearchNodes` + graph read methods; `codegraph/sync` wired
to the app signal (no worker watcher); index progress streaming; `project-config`
`extensions` override + `getStats`/`getIndexState`/`isIndexStale`. **Deferred to
v1.1+:** `include`/`exclude`/`includeIgnored` overlays + embedded-repo/submodule/gitlink
recursion + nested per-dir `.gitignore` in the FS walk; `getSegmentMatches` +
`name_segment_vocab` heal (front-load-hook tier — only if the hook ships, `00` §7.3
recommends drop for MVP); `getRoutingManifest`/`getTopRouteFile`/`findCircularDependencies`/
`findDeadCode`/`getNodeMetrics` analytics; `recreate`/`reopenIfReplaced` (only if
engines cached across rebuilds); worktree-mismatch diagnostic; PID `FileLock`.

### 4. Test gate (WS-B)

`context-ranking.test.ts` + `context.test.ts` reproduced via **fixture replay** (the
golden spec for the ranking — Decision, `00` §7.4); the scan-ignore config suite
(`exclude-config` / `include-config` / `include-ignored-config` / directory tests) for
`ScopeIgnore`/`GitIgnoreMatcher`.

### 5. Acceptance criteria

- End-to-end index-from-scan on a real repo via `codegraph/index` with **streaming
  progress** (`00` §5 M4).
- **`FindRelevantContext` reproduces the golden fixtures** (byte-for-byte channel
  outputs — the product-quality gate).
- Editing a file triggers `codegraph/sync` and the graph reflects the change (no worker
  watcher involved).
- `git`-absent / non-repo trees degrade cleanly to the FS-walk path.

### 6. Risks touched (`00` §8)

**R5 (context-ranking fidelity) — owned here; channel-by-channel port + fixture replay
is the mitigation.** **R7 (`.gitignore` semantics) — owned here;** lean on `git
ls-files`/`check-ignore` as the reference impl, reproduce the matcher only for FS-walk
+ overlays. **R11 (bm25 scale):** confirm FTS5 magnitudes feed the ranking multipliers
correctly (cross-check with M1). Sync design closes the **fd-exhaustion / two-watch-sets**
class by dropping the watcher (Decision 13).

### 7. Cross-refs

`reference/02-rpc-api-contract.md` (`codegraph/index`/`sync`/`cancel-index` + progress-event shape),
`reference/01-data-model-and-schema.md` (`index_state`/version-stamp columns, `name_segment_vocab`),
`workstreams/B-golden-test-porting.md` (`context-ranking.test.ts` fixture replay),
`00-overview-and-roadmap.md §6 (WS-C)` (`Subgraph.nodes` serializes as an array not a
Map; `JsonDocument` config parsing; `[GeneratedRegex]`).

---

## M5 — Tool surface & agent integration (explore-first) · size M

### 1. Goal & entry dependency

**Goal:** the agent actually uses it — **one tool, `codegraph_explore`, "explore
instead of Read."** **Entry dependency:** M4's `CodeGraphEngine` facade (explore is a
projection of `FindRelevantContext` + graph queries). Derives from **analysis/04 §6–§7**.

### 2. Task breakdown (dependency-ordered)

1. **`CodeGraphToolDefs.cs`** — the 8 `ToolDefinition` immutable records with
   `READ_ONLY_ANNOTATIONS` (`readOnlyHint:true` etc. — Cursor Ask-mode requirement
   #1018), each accepting optional `projectPath`; **default surface = `codegraph_explore`
   ALONE** (`DEFAULT_MCP_TOOLS={'explore'}`). Source-gen serialized in `CodeGraphJsonContext`.
   Transforms (`getStaticTools`/`getTools`/`withRequiredProjectPath`) construct **new
   records, never mutate** the shared array. *(04 §3.1–§3.2, §6.1; WS-C.)*
2. **`CodeGraphToolHandler.cs`** — validation, allowlist enforcement (defense-in-depth
   on `execute` too), dispatch, and the **error-classification contract** (behavioral,
   pinned by tests): `NotIndexedError` → **success-shaped guidance** (`textResult`, no
   `isError` — an early `isError` teaches session-long abandonment); `PathRefusalError`
   → **hard `isError`, no retry text**; internal error → `isError` + "retry once, else
   continue without codegraph". Plus the cross-cutting notices (per-file staleness
   banner, whole-index degraded banner, worktree-mismatch notice) and the **catch-up
   gate** (first `execute` per project-open awaits the post-open reconcile, time-boxed,
   thread-safe). *(04 §3.2–§3.4, §5.4–§5.5, §6.1.)*
3. **`CodeGraphInstructions.cs`** — the `SERVER_INSTRUCTIONS` "one tool, explore, use
   it instead of Read" playbook as **data**, with the indexed vs no-root variant. *(04 §3.4, §6.4.)*
4. **RPC methods** in `CodeGraphModule` — `codegraph/tools-list` (honors allowlist/
   gating/require-projectPath), `codegraph/explore`, `codegraph/instructions`. Each
   handler is a thin adapter: parse `JsonElement args` → `CodeGraphToolHandler.ExecuteAsync`
   → `WorkerResponse.Json(result, CodeGraphJsonContext.Default.ToolResult)`. The
   dispatcher's per-request `Task` gives free concurrency — **no query pool** (Decision 11).
   *(04 §6.2, §7 MVP.)*
5. **`CodeGraphExploreTools.handleExplore` + the `dynamic-boundaries` port** — the
   explore output builder (per-file line-numbered source sections + Relationships +
   additional-relevant-files + completeness/budget notes) and the dynamic-dispatch
   boundary detection over source bodies. Use `RegexOptions.NonBacktracking`/
   `[GeneratedRegex]` (ReDoS + AOT) and the `stripCommentsForRegex` port. *(04 §3.1
   explore row, §5.3, §6.5.)*
6. **The size-tiered explore budget** — `getExploreBudget`/`getExploreOutputBudget`
   (≤~24K chars), both kept **monotonic with repo size**. *(04 §3.2, §7 Later→MVP-budget.)*
7. **Renderer integration (Option A, Decision 8)** — register the `codegraph_explore`
   **definition** in the renderer `toolRegistry`, route execution to the worker via the
   generic passthrough `agentBridge.request('codegraph/explore', args)` (zero new TS
   plumbing, Decision 9); wire into the agent tool registry + session/mode instructions.
   **Multi-project cache keyed by resolved root** (`ConcurrentDictionary<string,
   CodeGraphHandle>`, resolve-every-call discipline). Do **not** add `codegraph/*` to
   the boot-time required-methods gate (Decision 9). *(04 §2.7, §6.4; `00` §3 Decisions 8–9.)*

### 3. The MVP cut — explore-only default surface

Default agent surface = **`codegraph_explore` alone** (04 §7). Ship: `CodeGraphToolDefs`
for explore (read-only annotations, source-gen); `codegraph/tools-list` +
`codegraph/explore` + `codegraph/instructions`; the `handleExplore` + `dynamic-boundaries`
port; error classification (`NotIndexed→success-shaped`, `PathRefusal→hard`) + the
per-file staleness banner; renderer definition routed to the worker; the size-tiered
budget. **Defer to M6** (04 §7 Later): the other 7 tools (`search`/`node`/`callers`/
`callees`/`impact`/`files`/`status`) + `CODEGRAPH_MCP_TOOLS` allowlist + tiny-repo
gating + require-projectPath transform + dynamic-budget suffix; whole-index degraded +
worktree-mismatch notices; env-knob → OpenCowork-settings mapping.

### 4. Test gate (WS-B)

`mcp-tool-allowlist.test.ts` (default surface = explore only; allowlist replaces +
re-enforces), `mcp-tool-annotations.test.ts` (annotations survive every transform),
`mcp-require-project-path.test.ts` (schema clone, no mutation),
`mcp-unindexed.test.ts` (the `NotIndexed→success` / `PathRefusal→isError` split).

### 5. Acceptance criteria

- An OpenCowork agent, on an indexed repo, answers a "how does X reach Y" flow
  question via `codegraph_explore` with **0 Read/Grep inside the call budget** (`00` §5 M5).
- An un-indexed root returns **success-shaped guidance (never `isError`)**, so the
  agent doesn't abandon the toolset.
- Explore output stays within the size-tiered budget; annotations/read-only hints
  survive the tool-list transforms.

### 6. Risks touched (`00` §8)

**R6 (shared-engine concurrency) resurfaces at the handler:** the catch-up gate and
multi-project cache must be thread-safe under concurrent first-calls (04 §5.1, §5.5).
**ReDoS/AOT in `dynamic-boundaries`** (04 §5.3): `NonBacktracking`/`[GeneratedRegex]`.
No new heartbeat exposure (explore reads are off-thread `Task`s).

### 7. Cross-refs

`reference/02-rpc-api-contract.md` (the `codegraph/*` method contracts + `ToolResult` DTO shape — the
authority for tasks 1–4), `workstreams/B-golden-test-porting.md` (the four `mcp-*.test.ts`),
`00-overview-and-roadmap.md §6 (WS-C)` (tool-def/result DTOs in `CodeGraphJsonContext`;
AOT-safe boundary regex). Renderer surfacing mirrors the existing `mcp__*` pattern
(04 §2.7).

---

## M6 — Full parity & polish (post-MVP, demand-driven) · size XL (long tail)

### 1. Goal & entry dependency

**Goal:** close the parity gap behind the MVP — the remaining languages, synthesizers,
embedded extractors, tools, and the static-link shipping endgame — driven by demand,
not sequence. **Entry dependency:** a shipped M1–M5 MVP. Derives from **the "Later"
sections of all six analyses** (01 §7, 02 §7, 03 §7, 04 §7, 05 §7) + `00` §5 M6 / §6 WS-A.

### 2. Task breakdown (grouped by area; each item is independently shippable)

1. **Languages — the remaining ~23 grammars** (niche/patched: cobol, vbnet, cfml family,
   arkts, nix, erlang, terraform, scala, pascal, r, luau, objc, dart, kotlin, swift,
   php, ruby, solidity, …) as `ILanguageExtractor` configs, each with its vendored
   ABI/patch reproduced. Expand the WS-A grammar build matrix to all **6–8 RIDs** and
   move to the **static-link-into-AOT-binary** shipping endgame (one self-contained
   per-RID worker). *(01 §7 Later; `00` §5 M6, §6 WS-A; R2/R3.)*
2. **Synthesizers — the remaining ~49 units** via the existing `IEdgeSynthesizer` +
   `IFrameworkResolver` static catalogs: state-mgmt (`reduxThunk`/`rtkQuery`/`pinia`/
   `vuex`/`objectRegistry`), pub-sub (`spring-event`/`mediatr`/`celery`/`sidekiq`/
   `laravel-event`/`erlang-behaviour`), UI-tree (`flutter`/`arkui*`/`pascal-form`/
   `vue-template`/`svelte-kit`), cross-platform bridges (`rn*`/`fabric`/`expo`/`mybatis`/
   `gin`/`go-grpc`/`kotlin-expect-actual`/`nix-option`/`cpp-override`/`closure-collection`),
   the remaining 17 framework resolvers (`vue`/`svelte`/`astro`/`play`/`drupal`/`goframe`/
   `rust`/swift-trio/`swift-objc`/`react-native`/`expo-modules`/`fabric-view`/`cics`/
   `terraform`), and **`c-fnptr` last** (its own 986-LOC mini C-preprocessor spike —
   `#ifdef`/macro/`#include` — R8, defer to the very end). *(02 §7 Later; R8/R10.)*
3. **Extended name-matching & module resolution** — C++/Rust/Swift/ObjC call-chains,
   `resolveChainedCallsViaConformance`, `resolveDeferredThisMemberRefs`, Razor/CFML/
   ArkTS/Erlang special paths; C/C++ includes (`compile_commands.json`), PHP/COBOL/Nix/
   Lua module resolution, ohpm workspaces. *(02 §7 Later.)*
4. **Embedded extractors** (`Embedded/`) — Vue/Svelte/Astro/Razor/CFML/MyBatis/Liquid/
   DFM (script-block delegation to the TS/JS/C# engines; multi-grammar CFML is R6) +
   value-refs (`flushValueRefs`) / function-refs (`FN_REF_SPECS`). *(01 §7 Later.)*
5. **The other 7 MCP tools fully surfaced** — `codegraph/search`/`node`/`callers`/
   `callees`/`impact`/`files`/`status` + the `CODEGRAPH_MCP_TOOLS` allowlist + tiny-repo
   gating (<500 files → `{explore,search,node}`) + require-projectPath transform +
   dynamic explore-budget suffix + whole-index-degraded/worktree-mismatch notices +
   env-knob→settings mapping. *(04 §7 Later.)*
6. **Front-load prompt hook (product decision, `00` §7.3 — recommend drop)** —
   `getSegmentMatches` + `name_segment_vocab` co-occurrence/rarity + the ~29-language
   structural-keyword tables + monorepo `planFrontload`. Only if ratified. *(05 §2.9,
   §7 Later; 03 §7 Later.)*
7. **Storage/facade tail** — WAL growth valve (only if HDD amplification repros);
   `findCircularDependencies`/`findDeadCode`/`getNodeMetrics` analytics;
   `getRoutingManifest`/`getTopRouteFile`; fuzzy edit-distance search +
   `findNodesByExactName` co-location; `recreate`/`reopenIfReplaced` (only if engines
   cached across rebuilds); worktree-mismatch diagnostic. *(03 §7, 05 §7 Later.)*

### 3. The MVP cut

N/A — M6 **is** the post-MVP tail. Prioritization is demand-driven per `00` §7.2
(which ecosystems matter: Swift/ObjC/RN/HarmonyOS? COBOL/CICS? Terraform/Nix?). Each
item ships independently behind the static catalogs; none blocks the MVP.

### 4. Test gate (WS-B)

Each ported unit brings its own upstream suite green before merge (per-language
extraction goldens; the remaining `*-synthesizer.test.ts` / `frameworks.test.ts`; the
remaining `mcp-*.test.ts` for the other 7 tools). The `c-fnptr` spike gets a dedicated
fixture set. No single gate — the discipline is "port the test suite one unit ahead."

### 5. Acceptance criteria

Demand-driven and per-unit: a newly added language indexes its golden fixtures stably;
a newly added synthesizer emits `provenance:'heuristic'` edges without count explosion
and passes its parity suite; the static-linked per-RID binary boots and parses on each
target RID. Parity milestone "done" = the ratified ecosystem set from `00` §7.2 is
covered.

### 6. Risks touched (`00` §8)

**R2 (grammar sourcing/patch fidelity)** and **R3 (cross-platform build matrix)** — the
dominant M6 risks, owned with **WS-A** (the project's biggest new build muscle). **R8
(`c-fnptr`)** — the narrowest-breadth, highest-difficulty unit, deliberately last.
**R10 (aggregate breadth)** — kept mechanical by the static catalogs + per-ecosystem,
individually-low-risk increments.

### 7. Cross-refs

`workstreams/A-grammar-build-matrix.md` (the ~31-grammar × 6–8-RID matrix + patch reproduction
+ static-link endgame — the M6 spine), `reference/03-tree-sitter-binding.md` (per-grammar ABI/patch
pins), `reference/02-rpc-api-contract.md` (the other 7 tool contracts), `workstreams/B-golden-test-porting.md`
(the remaining upstream suites), `00` §7 (the product/ownership ratifications that gate M6).

---

## Appendix — task count & critical path summary

| Milestone | Size | Numbered build tasks | Defining acceptance | Owned risks |
|---|:--:|:--:|---|---|
| **M1** Storage & graph core | L | 13 | ported graph/db tests green; seeded graph answers callers/callees/impact/path/context; bm25 search | R6, R11 |
| **M2** Extraction (8 langs) | XL | 12 | index TS+Go+Python, stable counts, goldens green, **heartbeat survives full-core index** | R1, R4, R9, (R2/R3 w/ WS-A) |
| **M3** Resolution + ~16 synth | XL | 11 | React re-render + JSX-child flow connects end-to-end; no edge explosion | R10, R8-deferred |
| **M4** Facade/scan/sync/context | L | 10 | streaming index-from-scan; **`FindRelevantContext` matches golden fixtures**; sync reflects edits | R5, R7, R11 |
| **M5** Tool surface (explore) | M | 7 | agent answers "X reach Y" via explore, **0 Read/Grep**; un-indexed → success-shaped | R6-at-handler |
| **M6** Parity tail | XL | 7 (areas) | demand-driven per-unit parity + static-link endgame | R2, R3, R8, R10 |

**Total MVP build tasks (M1–M5): 53**, plus M6's 7 demand-driven area tracks.

**The MVP critical path is strictly M1 → M2 → M3 → M4 → M5**, each hard-gated on its
predecessor: M2's emitters need M1's `CodeGraphStore` writes; M3 resolves M2's
`unresolvedReferences`; M4's `FindRelevantContext` needs M1 FTS5 search + M3's
synthesized edges; M5's `codegraph_explore` is a thin projection of M4's facade. The
one parallel dependency is **WS-A (grammar build)**, which must have an owner and
deliver 8 grammar libs before M2 can start — it then scales into M6. WS-B (golden
tests) is ported one suite ahead of each milestone's code (the fidelity discipline);
WS-C (AOT serialization/interop) is enforced continuously. The single operational
hazard to respect across the whole path is **R1 (heartbeat)** — validated in M2 and
never re-introduced (keep indexing off the shared thread-pool).
