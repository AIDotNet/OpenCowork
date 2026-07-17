# CodeGraph → C# Port — Master Architecture & Roadmap

> **Deliverable:** A complete plan to rewrite the open-source
> [CodeGraph](https://github.com/colbymchenry/codegraph) engine (TypeScript,
> ~72 kLOC) **entirely in C#** as a new module inside the OpenCowork .NET 10
> native worker sidecar — no Node.js, no TypeScript, no `web-tree-sitter` runtime
> shipped to users.
>
> This document is the lead-architect synthesis. It makes the cross-cutting
> decisions, fixes the module shape, and lays out a phased roadmap. It sits on top
> of six deep subsystem analyses in [`analysis/`](analysis/) — cite those for
> file/line-level detail. Read [`README.md`](README.md) first for the 3-minute
> version.

---

## 1. Mission & framing

CodeGraph is a **100% local semantic code-intelligence engine** for AI coding
agents. It parses a repo with tree-sitter, builds a **knowledge graph** of symbols
(`nodes`) and relationships (`edges`) in SQLite (with FTS5), resolves cross-file
references and synthesizes framework/dynamic-dispatch edges, and exposes it to an
agent over MCP as essentially **one tool, `codegraph_explore`**. Its measured value
(README A/B): ~35% cost / 57% tokens / 46% time / 71% tool-calls saved, by letting
an agent answer "how does X reach Y / who calls this / what breaks if I change it"
in a few fast graph calls with **zero Read/Grep**.

The authors' own pipeline (their `CLAUDE.md`):

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework synthesis)
              ↓
       GraphTraverser / GraphQueryManager (callers, callees, impact, paths)
              ↓
       ContextBuilder (ranked markdown/JSON for the agent)
```

**Why this port is tractable.** OpenCowork already ships a mature **.NET 10,
`PublishAot=true` native worker** with a module system, MessagePack IPC,
source-generated JSON, `Microsoft.Data.Sqlite`, streaming events, and a long-lived
supervised lifecycle. The worker *already is* the "shared daemon" CodeGraph builds
by hand — so a large fraction of CodeGraph's code (daemon, proxy, watchdogs, query
pool, CLI, installer, updater, telemetry, terminal UI, its own file-watcher)
**does not get ported at all** — it is subsumed or replaced. What remains is the
genuine engine: extraction, storage/graph, resolution/synthesis, context/search,
and a thin tool surface.

**Net LOC reality:**

| CodeGraph area | TS LOC | Disposition |
|---|---:|---|
| extraction (`src/extraction`) | 21,073 | **PORT** (engine) — the tree-sitter walk |
| resolution + synthesizers (`src/resolution`) | 20,458 | **PORT** (engine) — the "secret sauce" |
| storage + graph (`src/db` + `src/graph`) | 5,080 | **PORT** (engine) |
| facade + context + search + scan + config | ~6,500 | **PORT** (engine glue) |
| mcp tool contract + explore boundary detection | ~5,200 | **PORT** (thin surface) |
| daemon/proxy/pool/watchdogs (`src/mcp/*` infra) | ~3,500 | **DROP** — worker subsumes |
| CLI + installer + upgrade + telemetry + UI + own watcher | ~16,600 | **DROP** — OpenCowork replaces |

So of ~72 kLOC, roughly **~20 kLOC is dropped outright** and **~52 kLOC of
behavior-dense logic is ported** (extraction walks, resolution heuristics, ranking
constants), plus **new** native-interop + grammar build infrastructure that has no
TS analogue.

---

## 2. Target architecture

One new worker module, `Modules/CodeGraph/`, that internally reproduces
CodeGraph's five engine layers and exposes a `codegraph/*` RPC surface. It follows
the worker's verified conventions (see [analysis/06](analysis/06-target-worker-integration.md)):
**global C# namespace, every class prefixed `CodeGraph*`**, RPC methods namespaced
`codegraph/…`, and a dedicated source-generated `CodeGraphJsonContext`.

> **⚠ Process model revised.** The engine is now hosted as a **dedicated, opt-in
> standalone sidecar** (`OpenCowork.CodeGraph.Worker`, disabled by default), **not**
> embedded in the main worker. See **[reference/04-process-model-and-enablement.md](reference/04-process-model-and-enablement.md)**,
> which supersedes Decision 8 below. The diagram's host box is that second sidecar;
> the engine code (the `Modules/CodeGraph/` tree in §4) lives in an
> `OpenCowork.CodeGraph.Core` library it references.

```
┌───────────────────────── OpenCowork (Electron) ─────────────────────────┐
│ renderer: registers `codegraph_explore` tool DEFINITION only            │
│           execution routed to the CodeGraph worker (existing mcp* pattern)│
│ main:     2nd managed worker, spawned only when codegraph.enabled=true    │
│           debounced fs:file-changed → codegraph/sync RPC                 │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  MessagePack frame IPC (reused LocalIpcWorkerServer)
                ▼
┌── OpenCowork.CodeGraph.Worker (opt-in AOT sidecar) · refs …CodeGraph.Core ┐
│  CodeGraphModule                RPC:  codegraph/index · sync · cancel     │
│    (IWorkerModule)                    explore · search · node · callers   │
│                                       callees · impact · files · status  │
│                                       tools-list · instructions          │
│  ┌────────────── CodeGraphEngine (per-project facade, cached) ─────────┐  │
│  │  Scanning  → Extraction → Storage(Graph DB) → Resolution → Graph    │  │
│  │                              ▲                                Context │  │
│  │  TreeSitter [LibraryImport]  │  Microsoft.Data.Sqlite + FTS5  Search  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  Graph DB: ~/.open-cowork/codegraph/<sha256(projectRoot)>/graph.db (WAL)  │
│  Native:   libtree-sitter core bundled; grammar packs DOWNLOADED on      │
│            enable → ~/.open-cowork/codegraph/grammars/ (reference/04 §6)  │
└──────────────────────────────────────────────────────────────────────────┘
   (main OpenCowork.Native.Worker runs separately: agent-runtime/db/ssh/…)
```

---

## 3. Architecture Decision Record

Each decision resolves an open question raised by one or more subsystem analyses.
Format: **Decision — rationale (source).**

### Core technology

1. **Tree-sitter: native `libtree-sitter` + C-compiled grammars via an
   own-authored `[LibraryImport]` (source-generated) P/Invoke binding.** Ship as
   loadable per-RID native libs for MVP; static-link into the AOT worker binary as
   the shipping endgame. **Reject WASM/wasmtime.** Rationale: P/Invoke-to-C is the
   canonical NativeAOT interop (no reflection/JIT); the tree-sitter C API is ~40
   blittable functions; and CodeGraph uses **zero `.scm` queries** — extraction is
   100% manual node-navigation walks, so only parse+navigate is needed, not the
   query engine. "Reuse `tree-sitter-wasms` as-is" is a myth (they are Emscripten
   builds, not WASI), and wasmtime is a *bigger* native dep than libtree-sitter
   with weaker AOT support. Bootstrap common grammars from `TreeSitter.DotNet`'s
   prebuilt binaries; own the binding for the AOT guarantee. *(analysis/01, analysis/06)*

2. **Storage: `Microsoft.Data.Sqlite` 10.0.9 + `SQLitePCLRaw.bundle_e_sqlite3`
   3.0.3 — FTS5 is CONFIRMED present.** Empirically verified by building and
   running a .NET 10 probe on the exact versions: SQLite **3.50.4** with FTS5,
   bm25, external-content, JSON1, partial/expression indexes, `WITHOUT ROWID`,
   `COLLATE NOCASE` all working. **No fallback needed.** This was the single hard
   gate; it is cleared. *(analysis/03 — the highest-value de-risk)*

3. **Graph DB location: centralized, `~/.open-cowork/codegraph/<sha256(projectRoot)>/graph.db`.**
   Not co-located `.codegraph/` in the repo. Rationale: keeps user repos clean (no
   stray dir to gitignore), the sidecar already owns `~/.open-cowork/`, works for
   SSH/remote working folders where in-repo writes fail, and **eliminates the
   entire `#925` inode-replace self-heal class** (`isReplacedOnDisk`,
   `reopenIfReplaced`) that only exists because standalone CodeGraph writes into a
   repo other processes can `rm -rf`. *(analysis/03, analysis/06)*

4. **A separate DB file, its own connection factory.** The graph DB is **not**
   `data.db`. It reuses the `DbConnectionFactory`/`DbSchemaMigrator` *patterns* but
   needs **graph-tuned PRAGMAs** (`cache_size=-64000`, `mmap_size=256MB`,
   `temp_store=MEMORY`, `busy_timeout=5000` set *before* `journal_mode=WAL`) —
   distinct from `data.db`'s. *(analysis/03)*

### Module shape & integration

5. **One `IWorkerModule`: `CodeGraphModule`**, registered once in
   `Hosting/WorkerModuleCatalog.cs`. Resolution, synthesizers, extraction, graph,
   context, and search are **internal libraries** of this one module — none is its
   own module. Method namespace `codegraph/*`. *(analysis/02, analysis/04, analysis/06)*

6. **Follow the worker's verified conventions: global namespace, `CodeGraph*`
   class prefixes** (the worker uses *no* `namespace` declarations and prefixes for
   collision-avoidance). Folders (`Extraction/`, `Resolution/`, `Storage/`,
   `Graph/`, `Context/`, `Search/`, `Scanning/`, `Mcp/`, `Support/`) are
   organizational only. *(analysis/06 — the conventions authority; overrides the
   illustrative `namespace …` sketches in other analyses)*

7. **Serialization: a dedicated `CodeGraphJsonContext : JsonSerializerContext`.**
   Every RPC result DTO gets `[JsonSerializable(typeof(T))]` (+ a `List<T>` entry
   with a stable `TypeInfoPropertyName`). `JsonSerializerIsReflectionEnabledByDefault=false`
   is hard-enforced — no reflection, no `dynamic`. Internal domain types
   (`CodeGraphNode`, `CodeGraphEdge`, `Subgraph`) stay in-process and are **not**
   serialized; keep opaque `metadata`/`errors` columns as **raw JSON strings**
   internally, parsing to `JsonElement` only at the tool boundary. Read RPC input
   field-by-field from `JsonElement` via `JsonHelpers` (no input DTO
   deserialization). *(analysis/03, analysis/06)*

8. **MCP surfacing: Option A — `codegraph/*` RPC + renderer holds tool definitions
   only, execution routed to the worker — hosted in a dedicated opt-in sidecar.**
   The *surfacing mechanism* is OpenCowork's existing `mcp__{server}__{tool}` pattern
   ("definitions in the renderer registry, execution owned by a .NET worker"): **no
   MCP JSON-RPC protocol, no stdio, no handshake, no Node process** — all of
   `transport/session/startup-handshake/proxy/index` is never written. **Revised
   hosting (supersedes the original "embed in the main worker"):** the engine is a
   library (`OpenCowork.CodeGraph.Core`) run by a **separate AOT sidecar
   (`OpenCowork.CodeGraph.Worker`), disabled by default and spawned only on enable**
   — a built-in plugin. This isolates faults and the index CPU load from the agent
   runtime (see Decision 10 / R1) and keeps the main worker lean. **Authority:
   [reference/04-process-model-and-enablement.md](reference/04-process-model-and-enablement.md).**
   *(analysis/04; revised per reference/04)*

9. **Reachable from the renderer at MVP via the generic passthrough**
   (`agentBridge.request('codegraph/x', p)`) with **zero new TS plumbing**. Promote
   only hot query paths to dedicated typed MessagePack channels later. Do **not**
   add `codegraph/*` to the boot-time required-methods gate — it must never block
   worker boot. *(analysis/06)*

### Concurrency, lifecycle & the top hazard

10. **THE top integration risk — heartbeat starvation.** The main process pings
    `worker/ping` every **15 s** with a **5 s** timeout and **SIGKILLs the worker
    after 2 misses**. A full-core index that saturates the thread-pool can delay
    the `worker/ping` continuation past that window and **get the sidecar killed
    mid-index.** **Mitigation (mandatory):** run CPU-heavy parsing on **dedicated
    threads** (or cap parallelism to `max(1, ProcessorCount-1)`), *not* the shared
    thread-pool, so the IPC read loop + ping stay responsive; checkpoint the
    `CancellationToken`/`Task.Yield()` frequently. **With the standalone sidecar
    (reference/04) this hazard is contained: a missed ping kills only the CodeGraph
    process — never the agent runtime — and it respawns and resumes from the index
    checkpoint. The dedicated-thread discipline still applies so the CodeGraph
    worker's *own* ping survives a heavy index.** *(analysis/06; reference/04)*

11. **Concurrency model: one shared writer + a read-only connection pool, WAL.**
    Unlike Node's single event loop (which serialized everything and needed a
    bolted-on worker-thread query pool), the C# worker dispatches every RPC as an
    independent `Task` **truly in parallel from day one** — so the engine must be
    concurrency-correct *up front* (this is the one place the simpler design demands
    *more* care). `Microsoft.Data.Sqlite` connections are not thread-safe; use a
    dedicated writer + a small read-connection pool. **Drop** CodeGraph's
    `query-pool`/`query-worker` entirely. *(analysis/03, analysis/04)*

12. **Drop the daemon/watchdog stack (~3,500 LOC): `daemon`, `proxy`,
    `daemon-registry/paths/manager`, `query-pool/worker`, `ppid-watchdog`,
    `early-ppid`, `liveness-watchdog`, `startup-handshake`, `stdin-teardown`,
    `version`, mode-selection `index.ts`.** The worker already provides shared
    long-lived service + exit-on-disconnect + supervised respawn. *(analysis/04:
    12 drop, 4 replace, 4 reproduce)*

13. **Drop CodeGraph's file watcher (`sync/watcher.ts`, 912 LOC + watch-policy +
    git-hooks).** The app already watches files (`src/main/ipc/fs-handlers.ts`,
    debounced `fs:file-changed`). Expose an incremental **`codegraph/sync` RPC** and
    drive it from the app's existing signal (optionally passing changed paths for
    the git-scoped fast path). Keep the engine's *internal* git/hash change
    detection — only the OS watch layer is dropped. Two watch sets over one tree =
    the fd-exhaustion class CodeGraph spent a dozen issues fixing. *(analysis/05)*

14. **Concurrency guard collapses to `SemaphoreSlim(1,1)`.** The cross-process PID
    `FileLock` exists to coordinate CLI + daemon + git-hooks writing one repo DB;
    the worker is the **sole writer**, so an in-process semaphore suffices. Add a
    PID lockfile back only if external writers ever materialize. Likewise **drop
    `cooperative-yield`** (Node yielded only because resolution shared a thread with
    the liveness heartbeat; C# runs it off-thread with a `CancellationToken`).
    *(analysis/02, analysis/05)*

15. **Persist index-run checkpoints to the graph DB.** Worker background state is
    lost on supervised respawn, so an in-flight index must be resumable/re-detectable
    from the DB (`index_state` marker + completeness reconcile), not held only in
    memory. *(analysis/06)*

### Data model & algorithms

16. **Fixed vocabularies as string constants (stored as TEXT):** 22–23 `NodeKind`,
    12 `EdgeKind`, 41 `Language`. Use `static class` string constants, not C#
    `enum` (zero mapping cost at the SQLite boundary, AOT-trivial). One shared
    source of truth backs the query parser's validation. *(analysis/03, analysis/05)*

17. **Node ID = `"{kind}:" + sha256(filePath:kind:name:line).hex[:32]`** (128-bit,
    line-embedded), via one shared `CodeGraphNodeIdFactory` used by **both**
    extraction and resolution (Drupal's synthesizer reconstructs IDs by this
    formula). Clean-room rewrite ⇒ internal consistency is the only constraint (no
    cross-tool DB compatibility required). *(analysis/01, analysis/02, analysis/03)*

18. **Collapse the v2–v8 migration chain to one final schema.** No legacy CodeGraph
    DBs exist in OpenCowork's world, so emit the final (v8-equivalent) DDL directly
    — all columns, all indexes (incl. `idx_edges_identity` UNIQUE from row zero),
    `nodes_fts` + its 3 triggers, `name_segment_vocab`, `project_metadata`. Evolve
    the *port's own* future schema via `EnsureColumn` + a `schema_versions`-guarded
    hook for rare data fixups. *(analysis/03)*

19. **Extraction/resolution boundary is load-bearing.** Extraction emits **`nodes`
    + `contains`/value-ref edges + `unresolvedReferences` (name strings) only** —
    even same-file calls are unresolved refs. Resolution turns refs →
    `calls`/`imports`/`extends`/`implements`/… edges and synthesizes framework/
    dynamic-dispatch edges. Keep this split exactly. *(analysis/01, analysis/02)*

20. **Streaming node access is mandatory, not optional.** `iterateNodesByKind` /
    `iterateNodesByLanguageWithDecorator` must be true streaming cursors
    (`SqliteDataReader` as `IEnumerable`/`IAsyncEnumerable`), never materialized —
    several synthesizers scan every `function`/`method` (GBs on large repos).
    *(analysis/02, analysis/03)*

21. **Recursion → explicit stacks for unbounded traversals.** `StackOverflowException`
    is uncatchable and kills the worker. Depth-capped methods (callers/callees/impact,
    default 1–3) are MVP-safe; convert unbounded DFS (`traverseDFS`, cycle detection)
    to an explicit stack. *(analysis/03)*

### Text & correctness invariants

22. **UTF-8 byte offsets, not UTF-16 chars.** tree-sitter indexes **bytes**;
    `getNodeText` slices by byte offset; positions are byte-derived. Operate on the
    UTF-8 `byte[]` (a `CodeGraphSourceText` owning the buffer + a byte→(line,col)
    map); a naive `string`-index port breaks every line/column and every text slice.
    Lines 1-based, columns 0-based. `preParse` transforms must preserve byte length.
    *(analysis/01, R4)*

23. **Regex parity discipline.** Hundreds of JS regexes port to `System.Text.Regex`;
    watch JS↔.NET deltas: sticky `/y` → `\G`/`Regex.Match(startat)`, stateful
    `.lastIndex` → `Matches`/`NextMatch`, `\w`/`\b`/`\d` Unicode differences. Use
    `[GeneratedRegex]` for static hot patterns (AOT + speed) and `RegexOptions.NonBacktracking`
    for regexes over arbitrary source bodies (ReDoS safety). The ported
    `*-synthesizer.test.ts` suite is the parity oracle. *(analysis/02, analysis/04)*

24. **Config parsing is reflection-free.** All config reads (`codegraph.json`,
    tsconfig `paths`, package.json/composer.json/compile_commands.json) via
    `JsonDocument`/`Utf8JsonReader`, never `JsonSerializer.Deserialize<T>`. Port the
    hand-rolled JSONC/YAML/TOML mini-parsers **verbatim** (Spring/Drupal YAML, cargo
    TOML, pnpm YAML, `stripJsonc`) — their lossy-by-design behavior is pinned by
    tests; do not substitute general libraries. *(analysis/02)*

---

## 4. Module & file layout

Global namespace; `CodeGraph*`-prefixed classes; folders are organizational. Mirrors
the `Modules/Db/` split (`*Module` / `*Tools` / `*Models`).

> **Hosting (per [reference/04](reference/04-process-model-and-enablement.md)):** the
> tree below is the **`OpenCowork.CodeGraph.Core`** class library. A thin
> **`OpenCowork.CodeGraph.Worker`** AOT Exe (just `Program.Main` + a one-module
> `WorkerModuleCatalog` containing `CodeGraphModule`) references it and is the
> opt-in sidecar process. The xUnit test project (workstreams/B) references the same
> `Core` library directly. Paths below are relative to `Core/`.

```
sidecars/OpenCowork.Native.Worker/Modules/CodeGraph/
  CodeGraphModule.cs              # IWorkerModule; Name="codegraph"; registers codegraph/*
  CodeGraphEngine.cs              # the facade (≙ index.ts): lifecycle, indexAll/sync, reads
  CodeGraphModels.cs              # domain: CodeGraphNode/Edge/FileRecord/UnresolvedRef/Subgraph…
  CodeGraphNodeIdFactory.cs       # sha256 node-id + content hash (shared by extraction+resolution)

  Storage/
    CodeGraphConnectionFactory.cs # graph-tuned PRAGMAs over Microsoft.Data.Sqlite
    CodeGraphDatabase.cs          # lifecycle, WAL bulk-mode/checkpoint, path resolution
    CodeGraphSchema.cs            # final DDL (one string) + EnsureColumn migrator
    CodeGraphStore.*.cs           # ≙ QueryBuilder, partial by area (Nodes/Edges/Files/Refs/Search/Segments/Stats)
  Graph/
    CodeGraphTraverser.cs         # BFS/DFS, callers/callees, impact, path, type-hierarchy
    CodeGraphQueryManager.cs      # getContext, file deps, dead code, metrics

  Extraction/
    TreeSitter/CodeGraphTsBindings.cs   # [LibraryImport] to libtree-sitter C API
              CodeGraphTsParser.cs/TsTree.cs/TsNode.cs (readonly struct)
              CodeGraphGrammarRegistry.cs / CodeGraphSourceText.cs (UTF-8)
    CodeGraphTreeSitterExtractor.cs     # the visitNode walk + createNode/emit
    CodeGraphExtractorContext.cs
    Languages/                          # one config per language (data-driven)
    Embedded/                           # Vue/Svelte/Astro/Razor/Cfml/MyBatis/Liquid/Dfm (later)
    CodeGraphLanguageMap.cs / CodeGraphGeneratedDetection.cs

  Resolution/
    CodeGraphReferenceResolver.cs # 3 passes + batching + unresolved_ref lifecycle
    CodeGraphResolutionContext.cs / NameMatcher.cs / ReceiverTypeInference.cs
    ImportResolver.cs / PathAliases.cs / WorkspacePackages.cs / GoModule.cs
    StripComments.cs / PosixPath.cs / LruCache.cs
    Frameworks/  IFrameworkResolver + static catalog + N resolvers
    Synthesizers/ IEdgeSynthesizer + static catalog + SynthesisRunner + N synthesizers

  Context/  CodeGraphContextBuilder.cs / ContextFormatter.cs / CallPaths.cs
  Search/   CodeGraphQueryParser.cs / QueryTerms.cs / IdentifierSegments.cs
  Scanning/ CodeGraphDirectoryScanner.cs / GitFileEnumerator.cs / ScopeIgnore.cs
            GitIgnoreMatcher.cs / FileClassifier.cs
  Config/   CodeGraphProjectConfig.cs
  Support/  CodeGraphDataDir.cs / PathSafety.cs / IndexLock.cs
  Mcp/      CodeGraphToolDefs.cs / CodeGraphToolHandler.cs / CodeGraphInstructions.cs

sidecars/OpenCowork.Native.Worker/Serialization/CodeGraphJsonContext.cs
third_party/grammars/               # vendored grammar C sources + patches (build infra)
```

**Reuse, don't reinvent:** `Modules/Git/GitTools.cs` (the `git` subprocess helper,
bounded timeouts) for scanning; `Modules/File/FileSystemAccess.cs` for file I/O;
`Modules/Db/DbSql.cs` patterns for parameter binding/row mapping; `DbConnectionFactory`
as the template for the graph connection factory.

---

## 5. Phased roadmap

Milestones are dependency-ordered. Each lists **goal · key deliverables ·
acceptance criteria · rough size**. Sizes are T-shirt (S/M/L/XL) per the dominant
cost; the two XL cost-centers are extraction AST-walk fidelity and the
resolution/synthesizer breadth.

### M0 — Foundations & de-risking spikes  · size M

**Goal:** prove the two hard interop facts end-to-end and stand up the module skeleton.

- Tree-sitter `[LibraryImport]` spike: bind ~40 C functions, load one grammar
  (TypeScript), parse a file, walk nodes (type/offsets/points/named-children),
  slice text by byte offset. Prove it under `dotnet publish -c Release
  /p:PublishAot=true` on the dev RID, with the native grammar lib auto-copied into
  `resources/native-worker/`.
- `CodeGraphModule` skeleton: `IWorkerModule` + `WorkerModuleCatalog` entry +
  `CodeGraphJsonContext`; register `codegraph/status` (no-op). Prove
  renderer → `agentBridge.request('codegraph/status')` → worker round-trip.
- `CodeGraphConnectionFactory` + `CodeGraphSchema` (final DDL) + per-project DB
  under `~/.open-cowork/codegraph/<hash>/`; open + migrate + a smoke `nodes_fts`
  MATCH.

**Acceptance:** AOT worker boots with a bundled grammar lib; a renderer call
reaches a `codegraph/*` handler; a graph DB is created and an FTS5 query runs.
✅ *FTS5-in-bundle already verified (Decision 2); the tree-sitter spike is the gate.*

### M1 — Storage & graph core  · size L

**Goal:** a queryable graph store with the traversal algorithms, TDD-first.

- Port `graph.test.ts` + `db-perf.test.ts` invariants **first** (in-memory
  traverser; needs no SQLite) as the C# golden harness.
- `CodeGraphStore` (≙ `QueryBuilder`): node/edge/file/ref writes (batched
  transactions, `INSERT OR REPLACE`/`OR IGNORE`, endpoint-existence validation,
  500-param chunking, LRU node cache, segment-vocab materialization); reads
  (`GetNodeById`+cache, batch `GetNodesByIds`, by kind/name/qualified/lower/file/
  prefix, **streaming** `IterateNodesByKind`); FTS5 `SearchNodes`
  (bm25 weights `0,20,5,1,2`, prefix, over-fetch+rescore, LIKE fallback,
  exact-name supplement); stats/metadata.
- `CodeGraphTraverser` + `CodeGraphQueryManager` with the #1086–#1090
  edge-completeness/limit invariants (enqueued-vs-visited, per-add limit,
  mark-visited-before-depth, record-edge-unconditionally). Unbounded DFS → explicit
  stack (Decision 21).
- WAL bulk-mode (autocheckpoint=0 during index + `TRUNCATE` checkpoint between
  phases); **no valve** at MVP.

**Acceptance:** ported graph/db tests green; a hand-seeded graph answers
callers/callees/impact/path/context; FTS5 search returns bm25-ranked hits.

### M2 — Extraction engine (MVP: 8 languages)  · size XL

**Goal:** parse real repos into `nodes` + `contains` edges + `unresolvedReferences`.

- TreeSitter layer: `CodeGraphTsBindings/TsParser/TsTree/TsNode` (readonly struct),
  `CodeGraphGrammarRegistry`, `CodeGraphSourceText` (UTF-8 buffer + byte→line/col).
- Ship **8 grammars** as loadable per-RID native libs: TS/TSX, JS/JSX, Python, Go,
  Java, C#, Rust (all clean first-party grammars; **use vendored ABI-15
  `tree-sitter-c-sharp`** for primary-constructor support). Bootstrap the common
  ones from `TreeSitter.DotNet` prebuilt binaries.
- `CodeGraphTreeSitterExtractor.visitNode` ladder + `createNode` + `contains` edges
  + core emitters (function/class/method/interface/struct/enum/import/call/variable).
  `LanguageExtractor` as data-driven config records (node-type name arrays + hooks) —
  one generic engine + N thin configs. `detectLanguage`/`EXTENSION_MAP`,
  `GeneratedDetection`.
- Parse concurrency on **dedicated threads** (Decision 10) + parse timeout + 1 MB
  file cap; single SQLite writer.
- Port `extraction.test.ts` + per-language golden tests.
- **Defer:** value-refs/function-refs, framework-specific extractor branches
  (React/RTK/Pinia/Lombok), embedded extractors, niche/patched grammars.

**Acceptance:** index a mid-size TS + Go + Python repo; node counts stable across
re-index; golden extraction tests green; a full-core index does **not** trip the
`worker/ping` heartbeat (Decision 10 validated under load).

### M3 — Resolution & MVP synthesizers (~16 units)  · size XL

**Goal:** cross-file `calls`/`imports`/`extends` edges + the highest-value dynamic
edges — i.e. an actually-connected graph.

- `CodeGraphReferenceResolver`: 3 ordered passes, `resolveOne` strategy ladder,
  `unresolved_refs` lifecycle (pending→delete/failed, `name_tail` retry,
  rowId-precise cleanup, batching + non-progress guard, `gateLanguage`/built-in
  filtering). `ResolutionContext` over `CodeGraphStore` + LRU caches.
- `NameMatcher` (file-path/qualified/exact/fuzzy, `findBestMatch`/`preferCallSiteFile`,
  `matchFunctionRef`) + `ReceiverTypeInference` for the **top 6 languages** (TS/JS,
  Python, Java, Go, C#, PHP).
- `ImportResolver`: JS/TS (relative + tsconfig `paths` + monorepo workspaces +
  re-exports), Python, Go modules, Java FQN. `PathAliases`/`WorkspacePackages`/
  `GoModule`/`StripComments`/`LruCache`/`PosixPath`.
- **9 framework resolvers** (route→handler, the most agent-visible value):
  react, express, nestjs, django, flask, fastapi, spring, rails, aspnet (+laravel).
- **7 dynamic-edge synthesizers:** `goMethodContains` + `goImplements` (mandatory Go
  pre-passes), `interfaceOverride` (~10-language breadth), `fieldChannel`,
  `eventEmitter`, `reactRender`, `reactJsxChild`. `IFrameworkResolver`/`IEdgeSynthesizer`
  **static compile-time catalogs** (no reflection scanning); `SynthesisRunner`
  (language-gating + merge/dedupe by `source>target` + chunked persist; Go pre-passes
  persisted first).
- Port the `*-synthesizer.test.ts` / `frameworks.test.ts` suite as the regex-parity
  oracle.
- **Defer** the ~49-unit tail (state-mgmt, pub-sub, UI-tree, bridges, `c-fnptr`).

**Acceptance:** on excalidraw-class repos, an explore-style flow query connects
end-to-end across a React re-render + JSX-child boundary; node/edge counts stable
(no explosion); synthesized edges carry `provenance:'heuristic'` + `synthesizedBy`.

### M4 — Facade, scanning, sync, context & search  · size L

**Goal:** the full public engine surface + the ranking that *is* the product.

- `CodeGraphEngine` facade (Decision 5): lifecycle (Init/Open/Recreate/Close), the
  6-stage `IndexAll` pipeline, incremental `Sync`, and the full read surface
  (search, graph queries, node/edge/file/stats accessors, freshness signals).
- Scanning: `GitFileEnumerator` (reuse `GitTools`, `ls-files -z -s
  --recurse-submodules` + `-o --exclude-standard`, embedded-repo/gitlink recursion)
  + FS-walk fallback + `GitIgnoreMatcher` (git semantics: negations, nested,
  anchored, `**`, ~70 default dirs) + `ScopeIgnore` + `LanguageMap` + `FileClassifier`.
  **Extend, don't reuse**, the worker's `IgnoreMatcher` (it lacks negations/nested).
- Search: `QueryParser` (field-qualified `kind:/lang:/path:/name:`), `QueryTerms`
  (camel/snake/dot split, stemming), `IdentifierSegments`.
- **Context: `FindRelevantContext` ported channel-by-channel with the exact
  constants** (10+ channels, boosts/dampers/diversity caps) — the highest-value,
  highest-risk method; a "close-enough" rewrite silently regresses agent quality.
  `context-ranking.test.ts`/`context.test.ts` are the golden spec (fixture replay).
  `ContextFormatter` + `CallPaths`. Config-leaf secret redaction (#383).
- `codegraph/sync` RPC wired to the app's debounced `fs:file-changed` (Decision 13);
  index progress streams as a `WorkerMessagePackEvent`; cancel via `codegraph/cancel-index`
  + a run registry. `ProjectConfig` (`extensions` override). `SemaphoreSlim` guard.

**Acceptance:** end-to-end index-from-scan on a real repo via `codegraph/index`
with streaming progress; `FindRelevantContext` reproduces the golden fixtures;
editing a file triggers `codegraph/sync` and the graph reflects the change.

### M5 — Tool surface & agent integration (explore-first)  · size M

**Goal:** the agent actually uses it — one tool, "explore instead of Read."

- `CodeGraphToolDefs` (8 tools; **default surface = `codegraph_explore` alone**,
  read-only annotations, source-gen serialized) + `CodeGraphToolHandler`
  (validation, allowlist, dispatch, **error classification**: `NotIndexed →
  success-shaped guidance`, `PathRefusal → hard isError`; staleness/degraded/
  worktree notices; catch-up gate) + `CodeGraphInstructions` (indexed vs no-root text).
- `codegraph/tools-list` + `codegraph/explore` (+ the `dynamic-boundaries` port for
  explore's dynamic-dispatch surfacing) + `codegraph/instructions`.
- Renderer: register the `codegraph_explore` **definition**, route execution to the
  worker (Option A, Decision 8); wire into the agent tool registry + session/mode
  instructions. Multi-project cache keyed by resolved root.
- The size-tiered explore budget (`getExploreBudget`/`getExploreOutputBudget`) —
  keep both monotonic with repo size.

**Acceptance:** an OpenCowork agent, on an indexed repo, answers a "how does X reach
Y" flow question via `codegraph_explore` with 0 Read/Grep inside the call budget;
an un-indexed root returns success-shaped guidance (never `isError`), so the agent
doesn't abandon the toolset.

### M6 — Full parity & polish (post-MVP, demand-driven)  · size XL (long tail)

- Remaining **~23 languages** (niche/patched grammars) + expand the grammar build
  matrix to all 6–8 RIDs + the **static-link-into-AOT-binary** shipping endgame.
- Remaining **~49 synthesizers** (state-mgmt, pub-sub, UI-tree, cross-platform
  bridges) + extended name-matching (C++/Rust/Swift call-chains, chained-conformance,
  deferred-this-member) + extended module resolution (C/C++ includes, PHP/COBOL/Nix/Lua)
  + `c-fnptr` (its own spike — a mini C-preprocessor, defer last).
- Embedded extractors (Vue/Svelte/Astro/Razor/CFML/MyBatis/Liquid/DFM) +
  value-refs/function-refs.
- The other 7 MCP tools fully surfaced + `CODEGRAPH_MCP_TOOLS` allowlist + tiny-repo
  gating + require-projectPath transform.
- Optional: front-load prompt hook (`getSegmentMatches` + `name_segment_vocab` +
  ~29-language structural-keyword tables) — **product decision** (§7).
- WAL growth valve (only if HDD amplification repros); worktree-mismatch diagnostic;
  `findCircularDependencies`/`findDeadCode`/`getNodeMetrics` analytics; `recreate`/
  `reopenIfReplaced` (only if engines are cached across rebuilds).

---

## 6. Cross-cutting workstreams (run alongside the milestones)

- **WS-A · Grammar build & patch pipeline (HIGH risk, needs an owner).** ~31
  grammars × 6–8 RIDs, with CodeGraph's *exact* vendored versions/ABIs/patches
  reproduced (lua/c# ABI-15, patched cobol/nix/vbnet). Vendor C sources under
  `third_party/grammars/` (submodules pinned + `.patch` files); a CI matrix
  cross-compiles per-RID static archives (`PublishAotCross`/Zig linker for Linux).
  Couples to electron-builder's native-unpack/sidecar packaging. Starts small (8
  grammars in M2) and scales with M6. *This is the project's biggest new build muscle.*
- **WS-B · Golden-test fidelity harness.** CodeGraph's 140+ `__tests__/*.test.ts`
  are the behavioral spec. Port the highest-leverage suites *before* the code they
  cover: `graph.test.ts`/`db-perf.test.ts` (M1), `extraction.test.ts` (M2),
  `*-synthesizer.test.ts` (M3), `context-ranking.test.ts` (M4). Treat regex/ranking
  ports as TDD against these fixtures — this is how "behavior-dense heuristic" code
  ports without silent drift.
- **WS-C · AOT/serialization discipline.** Every RPC DTO in `CodeGraphJsonContext`;
  reflection-free config parsing; `[GeneratedRegex]`/`NonBacktracking` for hot/
  untrusted regexes; `[LibraryImport]` (never `[DllImport]`) for all native interop;
  lazy grammar loading so a missing lib degrades one method instead of crashing boot.

---

## 7. Decisions for the human to ratify

Technical decisions are made above. These are genuine **product / ownership /
budget** calls the plan cannot make alone:

1. **Grammar build matrix ownership & packaging endgame** (WS-A). Who owns the
   ~31-grammar × 6–8-RID CI job? Static-link (recommended endgame) vs loadable
   per-RID libs (recommended MVP)? Gates release-pipeline work.
2. **How much of the 65-synthesizer / 31-language tail ships v1?** MVP is ~16
   synthesis units + 8 languages. The tail is per-ecosystem and individually
   low-risk but high aggregate cost. Which ecosystems matter to OpenCowork's
   audience (Swift/ObjC/RN/HarmonyOS? COBOL/CICS? Terraform/Nix?)?
3. **Front-load prompt hook: reproduce or drop?** The single biggest scope lever in
   the facade area (~29-language keyword tables + `getSegmentMatches` +
   `name_segment_vocab` + monorepo `planFrontload`). Recommendation: **drop for MVP**
   — it's an agent-integration feature, and OpenCowork has its own prompt pipeline.
4. **Context-ranking fidelity bar.** Byte-for-byte port validated by fixture replay
   (recommended — it's the product) vs a "spirit-of" reimplementation with regression
   tolerance. Sets the QA budget for the highest-value method.
5. **Graph DB location** — ratify **centralized** `~/.open-cowork/codegraph/<hash>/`
   (recommended, Decision 3) vs in-repo `.codegraph/`.
6. **`git` on PATH** — assumed present (the worker already shells git). Confirm, or
   make the FS-walk + full-ignore-reimplementation path first-class (raises risk R1).

---

## 8. Risk register (ranked)

| # | Risk | Sev | Mitigation | Owner milestone |
|---|---|:--:|---|---|
| R1 | **Heartbeat starvation** — full-core index → `worker/ping` miss → SIGKILL mid-index | 🟠 Med (was 🔴) | **Isolated & recoverable** via the standalone sidecar (reference/04): only the CodeGraph process is affected — never the agent runtime — and it respawns + resumes from the index checkpoint. Still keep dedicated parse threads so its *own* ping survives; validate under load | M2 (Dec. 10) / reference/04 |
| R2 | **Grammar sourcing/patch fidelity** — ~15 niche grammars need exact vendored ABIs/patches or extraction silently drifts | 🔴 High | Pin C sources + reproduce patches; MVP uses only 8 clean first-party grammars | WS-A / M2 |
| R3 | **Cross-platform native build matrix** (31 grammars × 6–8 RIDs into AOT publish) | 🔴 High | Start with 8×1 RID; scale via CI cross-compile; bootstrap from TreeSitter.DotNet binaries | WS-A |
| R4 | **AST-walk behavioral fidelity** (6,658 LOC of node-type/field special cases) | 🔴 High | Golden tests first (WS-B); port the generic engine + thin per-language configs | M2 |
| R5 | **Context-ranking fidelity** (~450 lines of tuned magic constants; "close enough" regresses agent quality) | 🔴 High | Channel-by-channel port with exact constants; fixture-replay against `context-ranking.test.ts` | M4 |
| R6 | **Shared-engine concurrency correctness** (worker parallelizes from day one; "database is locked" class) | 🟠 Med | Single writer + read-pool, WAL, `busy_timeout`; build correct up front | M1 |
| R7 | **`.gitignore` semantics fidelity** (negations, nested, anchored, defaults) | 🟠 Med | Lean on `git ls-files`/`check-ignore` as the reference impl in-repo; reproduce matcher only for FS-walk + overlays | M4 |
| R8 | **`c-fnptr-synthesizer`** — a 986-LOC mini C-preprocessor (`#ifdef`/macro/`#include`) | 🟠 Med | Defer to M6 as its own spike; narrowest breadth | M6 |
| R9 | **UTF-8 byte-offset handling** — naive `string`-index port breaks all positions | 🟠 Med | `CodeGraphSourceText` centralizes byte-offset slicing + line map | M2 (Dec. 22) |
| R10 | **Aggregate breadth** — 65 synthesizers + 31 grammars is the bulk of the labor | 🟡 Low-each | MVP cut (16 + 8); demand-driven tail; static catalogs keep it mechanical | M3/M6 |
| R11 | **FTS5 bm25 scale parity** — ranking multipliers assume specific magnitudes | 🟡 Low | Verified FTS5 present; confirm bm25 magnitudes match during M1/M4 | M1/M4 |

---

## 9. Bottom line

The port is **large but de-risked**. The two make-or-break unknowns are both
resolved: **FTS5 is confirmed** in the exact SQLite bundle, and the **tree-sitter
strategy is settled** (native `[LibraryImport]`, no query engine needed). The
worker's existing daemon/IPC/SQLite/streaming infrastructure lets ~20 kLOC of
CodeGraph evaporate. The real work is faithfully porting behavior-dense heuristic
code — the tree-sitter walk, the resolution/synthesis, and the context ranking —
under two disciplines: **golden-test-first fidelity** (WS-B) and **AOT-clean
interop/serialization** (WS-C). The single operational hazard to respect
throughout is the **worker heartbeat** (R1): keep indexing off the shared
thread-pool.

An **explore-capable MVP** (M0–M5: 8 languages, ~16 synthesis units, full context
ranking, the `codegraph_explore` tool) is the first shippable slice and delivers
the bulk of CodeGraph's measured agent value; **full language/framework parity**
(M6 + WS-A) is a demand-driven long tail.

See [`analysis/`](analysis/) for the six subsystem deep-dives this synthesis rests on.
