# 02 — `codegraph/*` Worker RPC API Contract

> **Role of this doc.** This is the *exact interface* both sides of the CodeGraph
> port code against: the C# handlers registered inside the OpenCowork .NET 10
> native worker (`Modules/CodeGraph/`) **and** the renderer/main code that calls
> them. It is prescriptive. Where it says a field is *required*, the handler must
> reject its absence; where it names a result field, that field must appear on the
> wire under that name.
>
> **Provenance.** Conventions are pinned to real worker source
> (`Runtime/WorkerModuleContext.cs`, `Runtime/WorkerResponse.cs`,
> `Runtime/JsonHelpers.cs`, `Runtime/WorkerRequestContext.cs`,
> `Modules/Db/DbModule.cs`, `Modules/Shell/ShellTools.cs`) and the renderer call
> path (`src/renderer/src/lib/ipc/agent-bridge.ts`). Method → facade → MCP-tool
> mappings cite `analysis/05 §3.1` (the facade surface) and `analysis/04 §3.1`
> (the 8 MCP tools). Decisions cite `00-overview-and-roadmap.md`.
>
> **Scope.** MVP+ surface. Post-MVP knobs (allowlist, tiny-repo gating,
> require-projectPath transform, dynamic explore-budget suffix) are noted but not
> the MVP contract. This doc owns the *wire shapes*; the *ranking/extraction
> behavior* behind them is owned by analyses 01–03/05.

---

## 1. Conventions preamble

### 1.1 How a method is registered

Every method is one `context.Register(...)` line inside `CodeGraphModule.Register`,
delegating to a `static` handler on a `CodeGraph*Tools` class — exactly the
`DbModule` shape (`Modules/Db/DbModule.cs`). `CodeGraphModule.Name == "codegraph"`
(the dedup key only) and **every method is prefixed `codegraph/`** (Decision 5,
analysis 06 §3.1). The module is added once to `Hosting/WorkerModuleCatalog.cs`
(`new CodeGraphModule()`).

```csharp
internal sealed class CodeGraphModule : IWorkerModule
{
    public string Name => "codegraph";

    public void Register(WorkerModuleContext context)
    {
        // lifecycle / index (streaming handlers take WorkerRequestContext)
        context.Register("codegraph/index",        CodeGraphIndexTools.IndexAsync);
        context.Register("codegraph/reindex",      CodeGraphIndexTools.ReindexAsync);
        context.Register("codegraph/cancel-index", CodeGraphIndexTools.CancelIndex);
        context.Register("codegraph/index-status", CodeGraphIndexTools.Status);
        context.Register("codegraph/sync",         CodeGraphSyncTools.SyncAsync);
        // queries (tool-shaped)
        context.Register("codegraph/search",       CodeGraphQueryTools.Search);
        context.Register("codegraph/node",         CodeGraphQueryTools.Node);
        context.Register("codegraph/callers",      CodeGraphQueryTools.Callers);
        context.Register("codegraph/callees",      CodeGraphQueryTools.Callees);
        context.Register("codegraph/impact",       CodeGraphQueryTools.Impact);
        context.Register("codegraph/files",        CodeGraphQueryTools.Files);
        context.Register("codegraph/status",       CodeGraphQueryTools.StatusTool);
        // structured graph queries (JSON DTOs, not tool-shaped)
        context.Register("codegraph/query-definition", CodeGraphQueryTools.QueryDefinition);
        context.Register("codegraph/query-references", CodeGraphQueryTools.QueryReferences);
        context.Register("codegraph/query-neighbors",  CodeGraphQueryTools.QueryNeighbors);
        // context / explore
        context.Register("codegraph/explore",      CodeGraphExploreTools.ExploreAsync);
        // tool surface
        context.Register("codegraph/tools-list",   CodeGraphMcpTools.ListTools);
        context.Register("codegraph/instructions", CodeGraphMcpTools.Instructions);
    }
}
```

Handler shape — four overloads exist (`WorkerModuleContext.cs`); pick by
sync/async and whether you need to stream:

```csharp
context.Register(m, (JsonElement args) => WorkerResponse);
context.Register(m, (JsonElement args) => Task<WorkerResponse>);
context.Register(m, (JsonElement args, WorkerRequestContext ctx) => WorkerResponse);
context.Register(m, (JsonElement args, WorkerRequestContext ctx) => Task<WorkerResponse>);
```

Use the `ctx` overloads only for streamers (`codegraph/index`, `codegraph/reindex`,
`codegraph/sync`). **Duplicate method names throw at startup**
(`WorkerDispatcher.AddHandler`), so every `codegraph/*` string must be globally
unique across all modules. An unknown method resolves to
`WorkerResponse.Error("Unsupported method: …")`.

### 1.2 Input is a raw `JsonElement` — no input DTO

There is **no** deserialization of input into a DTO (AOT-safe, reflection-free).
Read each field off the `JsonElement` with `JsonHelpers` (`Runtime/JsonHelpers.cs`):

| Helper | Use |
|---|---|
| `JsonHelpers.GetString(args, "name")` | nullable string; non-string → `null` |
| `JsonHelpers.GetInt(args, "depth", 2)` | int with default; accepts numeric-string |
| `JsonHelpers.GetIntNullable(args, "limit")` | distinguish absent from present |
| `JsonHelpers.GetBool(args, "includeCode", false)` | bool with default |
| `JsonHelpers.GetLong / GetLongNullable / GetDoubleNullable` | numeric variants |
| `JsonHelpers.GetStringArray(args, "changedPaths")` | array *or* comma-string → `string[]` |
| `args.TryGetProperty("x", out var p)` + `p.EnumerateArray/Object` | nested shapes |

A required string is enforced by the handler (copy `ShellTools.RequireString`:
`GetString(...) is { Length: > 0 } v ? v : throw`). The thrown exception is caught
and surfaced through the result envelope (§1.3), never as a rejected promise.

### 1.3 Result via `WorkerResponse.Json(dto, CodeGraphJsonContext.Default.T)` — and the critical error convention

Normal path: build a result **record** and serialize it with the source-gen
`JsonTypeInfo`:

```csharp
return WorkerResponse.Json(result, CodeGraphJsonContext.Default.CodeGraphIndexResult);
```

Serialization is AOT source-gen only (`JsonSerializerIsReflectionEnabledByDefault=false`).
Every result DTO **and** every `List<T>` of it gets an entry in a **dedicated**
`CodeGraphJsonContext : JsonSerializerContext` (Decision 7; recommended over
appending to `WorkerJsonContext`). Options inherited from the worker convention:
PascalCase C# props → **camelCase JSON**, and **null props are omitted**
(`DefaultIgnoreCondition = WhenWritingNull`). Force an exact wire name with
`[JsonPropertyName("…")]` when needed.

> **THE critical error convention (non-obvious, load-bearing).**
> The worker's wire frame is **always** `{ id, result }` — there is *no* top-level
> `error` field (`Runtime/WorkerJson.cs`). `WorkerResponse.Error(msg)` serializes to
> `result: { error: msg }` and the JS client-side promise **RESOLVES** with
> `{ error: msg }` — it does **not** reject (`native-worker.ts` `response.error →
> reject` branch is effectively dead). The dispatcher's catch-all for an unhandled
> exception does the same (`LocalIpcWorkerServer.cs`).
>
> **Consequence — mandatory design rule:** model success/failure **explicitly in
> every result DTO**. Every `codegraph/*` result carries `success: bool` and an
> optional `error` (§4). Reserve `WorkerResponse.Error(...)` for "this handler
> threw unexpectedly"; callers must still inspect the payload. **Never assume the
> JS side rejects on failure.** (analysis 06 §3.3; Decision surfaced in §11.6 of
> analysis 06.)

### 1.4 msgpack `undefined → null` gotcha (patch fields)

Requests arrive as msgpack, transcoded to JSON (`MessagePackJsonTranscoder`).
The JS client **omits `undefined` keys entirely** (they never reach the handler),
but an **explicit `null` arrives as JSON `null`**. For any *patch/update* field
where "not provided" (leave unchanged) must differ from "explicitly cleared", you
MUST branch on `args.TryGetProperty(name, out var p) == false` (absent) vs
`p.ValueKind == JsonValueKind.Null` (clear) — copy `DbProjectTools.ApplyProjectPatch`.
A plain `GetString` fallback collapses the two and is wrong for patches.

In this contract only `codegraph/sync`'s `changedPaths` and the query methods'
optional disambiguators are patch-sensitive; for everything else absent and null
are treated identically (both fall to the default). Also: **never emit
NaN/Infinity** in a result (the transcoder throws on non-finite numbers) — sanitize
ranking scores that could divide by zero to `0`.

### 1.5 The two reachability paths

1. **Generic passthrough (MVP — zero new TS plumbing, Decision 9).**
   `agentBridge.request('codegraph/x', params, timeoutMs)`
   (`src/renderer/src/lib/ipc/agent-bridge.ts:84`) rides the existing
   `sidecar:request:msgpack` channel → main `getNativeWorker().request('codegraph/x', p)`.
   **Any** method string is forwarded; no allow-list edit is needed. This is the
   only path used at MVP.
2. **Dedicated typed channel (hot paths, later).** Add a channel constant in
   `src/shared/messagepack/binary-ipc.ts`, a `registerMessagePackHandler` in main,
   register it in `messagepack-channel-routing.ts`, optionally expose on
   `window.api`. Promote only proven-hot query paths (`explore`, `search`) here.

> **Do NOT** add any `codegraph/*` method to `REQUIRED_NATIVE_WORKER_METHODS`
> (`native-worker.ts:27`) — CodeGraph must never gate worker boot (Decision 9).
> `worker/routes` auto-discovers every registered method, so no other TS
> registration is required for reachability.
>
> **Default timeout is 60 s** (`native-worker.ts`). `codegraph/index` and a cold
> `codegraph/explore` MUST pass an explicit large `timeoutMs` **or** run detached
> and stream progress (§3). An omitted `timeoutMs` crosses msgpack as `null` and
> does **not** hit the JS default — pass it explicitly (§1.4).

---

## 2. Method-by-method specification

**Common input field — `workingFolder`.** Every method takes `workingFolder`
(string) identifying the project whose graph DB to resolve
(`~/.open-cowork/codegraph/<sha256(workingFolder)>/graph.db`, Decision 3). It is
**required** unless a single default project is established app-side; when absent
and no default exists, the method returns the `not_indexed` success-shaped envelope
(§4). (This mirrors the MCP tools' optional `projectPath`, analysis 04 §3.1, which
becomes *required* under the post-MVP `withRequiredProjectPath` transform.)

Legend: **type** = JSON type on the wire · **req?** = required · streaming noted per
method. All result DTOs additionally carry the standard envelope fields from §4
(`success`, `error?`, `errorKind?`); those are not repeated per-row.

---

### 2.1 Lifecycle / index

#### `codegraph/index` — full index of a project **(streams)**
- **Purpose:** scan → extract → resolve → synthesize → stamp; build the graph DB from scratch (or refresh in place). The 6-stage `IndexAll` pipeline.
- **Facade:** `CodeGraph.indexAll({onProgress, signal})` → `IndexResult` (analysis 05 §3.1 Indexing/sync; §2.3).
- **Backs MCP tool:** none directly (indexing is an app action, not an agent tool).
- **Input:**
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | yes | — | project root to index |
  | `indexId` | string | no | worker-generated | caller-supplied id for progress correlation + cancel; echoed in every event and the result |
  | `verbose` | bool | no | `false` | extra progress detail |
  | `force` | bool | no | `false` | ignore freshness stamps, re-extract all files |
- **Result DTO — `CodeGraphIndexResult`:**
  | field | type | notes |
  |---|---|---|
  | `success` | bool | see §4 |
  | `indexId` | string | echoes input/generated id |
  | `state` | string | terminal: `complete` \| `partial` \| `failed` |
  | `filesDiscovered` | int | scan ground truth |
  | `filesIndexed` | int | |
  | `filesSkipped` | int | |
  | `filesErrored` | int | |
  | `nodeCount` | int | post-resolution total |
  | `edgeCount` | int | post-synthesis total |
  | `durationMs` | long | |
  | `indexedWithVersion` | string | freshness stamp (`isIndexStale`) |
  | `warnings` | string[] | e.g. completeness shortfall (`partial`) |
  | `error` / `errorKind` | string? | on failure (§4) |
- **Streams:** `codegraph/index-progress` (0..n) then `codegraph/index-complete` (§3).
- **Errors:** `not_indexed` cannot occur (this *creates* the index); `path_refusal` (hard) if `workingFolder` resolves to a refused root (`$HOME`, `/`, `/etc` — `unsafeIndexRootReason`, analysis 05 §2.9); `internal` on parse/DB failure → `state:'failed'`, `success:false`.

#### `codegraph/reindex` — discard + rebuild **(streams)**
- **Purpose:** O(1) drop of the graph DB file then a fresh `index` — sidesteps delete-trigger churn on a poisoned large index (#1067).
- **Facade:** `CodeGraph.recreate(root)` then `indexAll` (analysis 05 §2.2/§3.1).
- **Input:** identical to `codegraph/index` (`force` is implied/ignored).
- **Result DTO:** `CodeGraphIndexResult` (same as index).
- **Streams:** same events, with a leading `phase:'recreate'` progress frame.
- **Errors:** same as `codegraph/index`.

#### `codegraph/cancel-index` — cancel an in-flight index (does **not** stream)
- **Purpose:** user-initiated cancel of a running `index`/`reindex`.
- **Facade:** cancels the `CancellationTokenSource` in the run registry (analysis 06 §5.3; the `ShellTools.Running` dict + `Abort` pattern).
- **Input:**
  | name | type | req? | notes |
  |---|---|---|---|
  | `indexId` | string | yes | the id passed to `index`/`reindex` |
- **Result DTO — `CodeGraphCancelResult`:**
  | field | type | notes |
  |---|---|---|
  | `success` | bool | request accepted |
  | `found` | bool | `false` if no run with that id (already finished) — success-shaped, mirrors `ShellAbortResult` |
  | `error` | string? | |
- **Errors:** never hard-errors on a missing id (`found:false`, `success:true`).
- **Note:** the run registry is process-local and lost on worker recycle (analysis 06 §7); a respawned worker returns `found:false` and the caller re-reads `index-status`.

#### `codegraph/index-status` — health snapshot (does **not** stream)
- **Purpose:** structured index freshness/health for the app UI (distinct from the agent-facing `codegraph/status` text tool).
- **Facade:** `getIndexState` + `getLastIndexedAt` + `getStats` + `isIndexStale` + `getIndexBuildInfo` + `getPendingReferenceCount` (analysis 05 §3.1).
- **Input:** `workingFolder` (string, required).
- **Result DTO — `CodeGraphIndexStatus`:**
  | field | type | notes |
  |---|---|---|
  | `success` | bool | |
  | `indexed` | bool | `false` ⇒ never indexed; other fields may be 0/null |
  | `state` | string? | `indexing` \| `complete` \| `partial` \| `failed` \| `null` |
  | `indexing` | bool | a run is currently active |
  | `lastIndexedAt` | long? | epoch ms |
  | `fileCount` | int | |
  | `nodeCount` | int | |
  | `edgeCount` | int | |
  | `pendingReferenceCount` | int | orphaned unresolved refs (interrupted pass signal) |
  | `dbSizeBytes` | long | |
  | `backend` | string | e.g. `microsoft.data.sqlite` |
  | `journalMode` | string | `wal` expected |
  | `stale` | bool | `extractionVersion < current` |
  | `indexedWithVersion` | string? | |
- **Errors:** un-indexed root ⇒ **not** an error — `indexed:false`, `success:true`.

#### `codegraph/sync` — incremental update **(streams)**
- **Purpose:** apply file changes since the last index (the app drives this from its debounced `fs:file-changed` signal; the worker ships no watcher — Decision 13).
- **Facade:** `CodeGraph.sync({onProgress})` → `SyncResult`; git-fast-path when `changedPaths` is supplied (analysis 05 §2.4/§3.1).
- **Input:**
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | yes | — | |
  | `changedPaths` | string[] | no | *(derive via git/hash)* | absolute or root-relative changed files; enables the git-scoped fast path. **Patch-sensitive** (§1.4): absent ⇒ engine self-detects; present-but-empty ⇒ "nothing changed, run orphan sweep only". |
  | `indexId` | string | no | generated | progress/cancel correlation |
- **Result DTO — `CodeGraphSyncResult`:**
  | field | type | notes |
  |---|---|---|
  | `success` | bool | |
  | `filesChecked` | int | |
  | `filesAdded` | int | |
  | `filesModified` | int | |
  | `filesRemoved` | int | |
  | `nodesUpdated` | int | |
  | `edgesUpdated` | int | |
  | `pendingReferenceCount` | int | post-sweep residual |
  | `durationMs` | long | |
  | `error` / `errorKind` | string? | |
- **Streams:** `codegraph/index-progress` (`phase:'sync'`) + `codegraph/index-complete`.
- **Errors:** `not_indexed` (success-shaped) if the project was never indexed — the app should call `codegraph/index` first; `internal` on failure.

---

### 2.2 Queries (tool-shaped — back the 7 non-explore MCP tools)

These return the **tool result shape** `CodeGraphToolResult` (§4.2) because their
output is the verbatim text an agent consumes, and the renderer routes the MCP tool
of the same name straight to them. All are read-only, none stream.

#### `codegraph/search` — symbol search by name
- **Purpose:** quick symbol lookup; locations only, no code (analysis 04 §3.1 `codegraph_search`).
- **Facade:** `searchNodes(query, opts)` (analysis 05 §3.1 Search).
- **Input:**
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | yes¹ | — | ¹optional if a default project exists |
  | `query` | string | yes | — | supports field-qualified `kind:/lang:/path:/name:` |
  | `kind` | string | no | — | enum: function\|method\|class\|interface\|type\|variable\|route\|component |
  | `limit` | int | no | `10` | |
- **Result:** `CodeGraphToolResult` — text list of matches (`name`, `kind`, `file:line`); generated files down-ranked.
- **Errors:** `not_indexed` → success-shaped guidance; `path_refusal` → hard `isError`.

#### `codegraph/node` — read a symbol or a file
- **Purpose:** two modes — (1) `file` alone ⇒ `Read`-like numbered source + dependents; (2) `symbol` ⇒ signature/body/caller-callee trail (analysis 04 §3.1 `codegraph_node`).
- **Facade:** `getNode` / `getNodesByName` / `getNodesInFile` + `getCode` (config-leaf redaction, #383) (analysis 05 §3.1).
- **Input:** (**required: none** — but one of `symbol`/`file` must be present or the result is a usage hint)
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | yes¹ | — | |
  | `symbol` | string | no | — | symbol-mode selector |
  | `file` | string | no | — | file-mode selector |
  | `includeCode` | bool | no | `false` | include body in symbol mode |
  | `symbolsOnly` | bool | no | `false` | structural outline only |
  | `line` | int | no | — | disambiguate a symbol by line |
  | `offset` | int | no | — | file-mode window start (Read semantics) |
  | `limit` | int | no | 2000-line cap | file-mode window size |
- **Result:** `CodeGraphToolResult` — file mode: `<n>\t<line>` source + dependents note; symbol mode: signature + body + trail; ambiguous name ⇒ every matching def.
- **Errors:** `not_indexed` → success-shaped; `path_refusal` → hard.

#### `codegraph/callers` — who calls `<symbol>`
- **Facade:** `getCallers(id, depth)` (analysis 05 §3.1); backs `codegraph_callers`.
- **Input:** `workingFolder`(str, req¹), `symbol`(str, **req**), `file`(str, no — disambiguate), `limit`(int, no, `20`).
- **Result:** `CodeGraphToolResult` — text list of callers.
- **Errors:** `not_indexed` → success-shaped; `path_refusal` → hard; missing `symbol` ⇒ `invalid_args` success-shaped hint.

#### `codegraph/callees` — what `<symbol>` calls
- **Facade:** `getCallees(id, depth)`; backs `codegraph_callees`. Input/Result/Errors identical to `callers`.

#### `codegraph/impact` — blast radius of changing `<symbol>`
- **Facade:** `getImpactRadius(id, depth)` (analysis 05 §3.1); backs `codegraph_impact`.
- **Input:** `workingFolder`(str, req¹), `symbol`(str, **req**), `file`(str, no), `depth`(int, no, `2`).
- **Result:** `CodeGraphToolResult` — text impact set.
- **Errors:** as `callers`.

#### `codegraph/files` — indexed file tree
- **Facade:** `getFiles()` + per-file node/lang counts (analysis 05 §3.1); backs `codegraph_files`.
- **Input:**
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | yes¹ | — | |
  | `path` | string | no | — | directory filter |
  | `pattern` | string | no | — | glob filter |
  | `format` | string | no | `tree` | `tree` \| `flat` \| `grouped` |
  | `includeMetadata` | bool | no | `true` | language/symbol counts |
  | `maxDepth` | int | no | — | |
- **Result:** `CodeGraphToolResult` — formatted tree/list/grouped.
- **Errors:** `not_indexed` → success-shaped.

#### `codegraph/status` — index health as agent text
- **Purpose:** the agent-facing `codegraph_status` markdown block (files/nodes/edges/db size/backend/journal/pending/degraded) (analysis 04 §3.1).
- **Facade:** `getStats` + `getBackend` + `getJournalMode` + `getPendingFiles` + `isWatcherDegraded` (analysis 05 §3.1).
- **Input:** `workingFolder` (str, req¹).
- **Result:** `CodeGraphToolResult` — markdown status block (text).
- **Note:** distinct from `codegraph/index-status` (structured DTO for the UI). Same underlying data, different consumer/shape.

---

### 2.3 Structured graph queries (JSON DTOs — not tool-shaped)

These expose the graph for the app/UI (and future typed channels) as structured
data rather than agent text. Illustrative surface (analysis 06 §9); ship as demand
requires.

#### `codegraph/query-definition` — locate a symbol's definition(s)
- **Facade:** `getNodesByName(name)` / `getNode(id)` (analysis 05 §3.1 Node ops).
- **Input:** `workingFolder`(str, req), `symbol`(str, **req**), `file`(str, no), `limit`(int, no, `20`).
- **Result DTO — `CodeGraphNodeListResult`:** `success`, `nodes: CodeGraphNodeDto[]`, `error?`. Each `CodeGraphNodeDto`: `id, kind, name, qualifiedName?, filePath, language, startLine, endLine, startColumn, endColumn, signature?, isExported?, docstring?` (subset of the `Node` record, analysis 05 §3.2). No `Map`s on the wire — arrays only.
- **Errors:** `not_indexed` → success-shaped (`nodes:[]` + `error`/`errorKind`).

#### `codegraph/query-references` — usages of a symbol
- **Facade:** `findUsages(id)` / `getIncomingEdges(id)` (analysis 05 §3.1).
- **Input:** `workingFolder`(str, req), `symbol`(str, **req**) *or* `nodeId`(str), `file`(str, no), `limit`(int, no, `50`).
- **Result DTO — `CodeGraphReferencesResult`:** `success`, `references: CodeGraphReferenceDto[]` (each `{ node: CodeGraphNodeDto, edge: CodeGraphEdgeDto }`), `error?`. `CodeGraphEdgeDto`: `source, target, kind, line?, column?, provenance?, synthesizedBy?`.
- **Errors:** `not_indexed` → success-shaped.

#### `codegraph/query-neighbors` — local subgraph around a node
- **Facade:** `traverse(id, opts)` / `getContext(id)` (analysis 05 §3.1 Graph queries).
- **Input:** `workingFolder`(str, req), `nodeId`(str, **req**) *or* `symbol`(str), `depth`(int, no, `1`), `edgeKinds`(string[], no — filter), `limit`(int, no, `100`).
- **Result DTO — `CodeGraphSubgraphResult`:** `success`, `nodes: CodeGraphNodeDto[]` (**serialized as an array**, not the internal `Map<string,Node>` — analysis 05 §6.1), `edges: CodeGraphEdgeDto[]`, `roots: string[]` (node ids), `confidence?: string`, `error?`.
- **Errors:** `not_indexed` → success-shaped; unknown node ⇒ `success:true, nodes:[]`.

---

### 2.4 Context / explore

#### `codegraph/explore` — the primary agent tool
- **Purpose:** NL question OR a bag of symbol/file names → verbatim source grouped by file + the call path among them + blast-radius, in one capped call. **The default agent surface** (analysis 04 §3.1/§3.2; `DEFAULT_MCP_TOOLS = {explore}`).
- **Facade:** `findRelevantContext(query, opts)` → `buildContext(...)` (the full multi-channel ranking pipeline, analysis 05 §2.7); explore's dynamic-dispatch surfacing via the `dynamic-boundaries` port.
- **Backs MCP tool:** `codegraph_explore`.
- **Input:**
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | yes¹ | — | |
  | `query` | string | **yes** | — | NL question or symbol/file bag |
  | `maxFiles` | int | no | `12` | size-tiered budget caps the effective value |
- **Result:** `CodeGraphToolResult` — large markdown: per-file line-numbered source (`**\`path\`**` headers, `<n>\t<line>` body), a Relationships section, "additional relevant files", completeness/budget notes. Output budget is size-tiered (`getExploreOutputBudget`, ≤~24K chars). **Paginate/cap** — frames are capped at 256 MB but explore should stay well under (analysis 06 §4.4).
- **Errors:** `not_indexed` → **success-shaped guidance** (never `isError` — an early error teaches session-long abandonment, analysis 04 §3.3); `path_refusal` → hard `isError`; `internal` → `isError` + "retry once, else continue without codegraph".
- **Timeout:** cold explore can be slow; caller passes an explicit `timeoutMs` (§1.5).

---

### 2.5 Tool surface

#### `codegraph/tools-list` — enumerate exposed tool definitions
- **Purpose:** the source-gen tool definitions the renderer registers (default = `codegraph_explore` alone). Replaces MCP `tools/list` (analysis 04 §6.2).
- **Facade:** `CodeGraphToolDefs.GetTools()` with surface gating (analysis 04 §3.2).
- **Input:**
  | name | type | req? | default | notes |
  |---|---|---|---|---|
  | `workingFolder` | string | no | — | when absent + no default, definitions mark `projectPath` required (post-MVP `withRequiredProjectPath`) |
- **Result DTO — `CodeGraphToolsListResult`:** `success`, `tools: CodeGraphToolDefinition[]`. Each `CodeGraphToolDefinition`: `name` (e.g. `codegraph_explore`), `description`, `inputSchema` (a fixed JSON object — model as a source-gen DTO, not `dynamic`), `annotations` (`readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false`). Annotations MUST survive every transform (analysis 04 §3.2).
- **MVP:** returns `[explore]` only. Allowlist / tiny-repo gating / require-projectPath are post-MVP (analysis 04 §7).
- **Errors:** never `not_indexed` (tool defs are static); always `success:true`.

#### `codegraph/instructions` — agent playbook text
- **Purpose:** the "one tool, explore, use it instead of Read" playbook, indexed-vs-no-root variant, surfaced in the agent system prompt (analysis 04 §3.4, `server-instructions.ts` as data).
- **Facade:** `CodeGraphInstructions` const text selection.
- **Input:** `workingFolder` (string, no) — selects the indexed vs no-root text.
- **Result DTO — `CodeGraphInstructionsResult`:** `success`, `instructions: string`, `indexed: bool`.
- **Errors:** always `success:true`.

---

## 3. Streaming events

Index/sync progress streams while the handler runs and still returns a final
`WorkerResponse` (analysis 06 §5.1; the `ShellTools` `shell/started`/`shell/output`
template). Emit via `ctx.EmitEventAsync(name, dto, CodeGraphJsonContext.Default.T)`.
Writes are serialized by the per-connection write lock, so interleaving progress
frames with the final response is safe.

### 3.1 `codegraph/index-progress` (0..n per run)
```csharp
await ctx.EmitEventAsync(
    "codegraph/index-progress",
    new CodeGraphIndexProgress(indexId, phase, filesDone, filesTotal, nodeCount, edgeCount, message),
    CodeGraphJsonContext.Default.CodeGraphIndexProgress);
```
- **Payload DTO — `CodeGraphIndexProgress`:**
  | field | type | notes |
  |---|---|---|
  | `indexId` | string | correlates to the `index`/`reindex`/`sync` call |
  | `phase` | string | `scan` \| `extract` \| `resolve` \| `synthesize` \| `maintenance` \| `recreate` \| `sync` |
  | `filesDone` | int | |
  | `filesTotal` | int | 0 until scan completes |
  | `nodeCount` | int | running total (best-effort) |
  | `edgeCount` | int | running total (best-effort) |
  | `message` | string? | optional detail (verbose) |
- **Frequency:** low — batch per file-group; do not emit per-node. Numbers must be finite (§1.4).

### 3.2 `codegraph/index-complete` (exactly 1, terminal)
```csharp
await ctx.EmitEventIgnoringCancellationAsync(
    "codegraph/index-complete",
    new CodeGraphIndexComplete(indexId, state, filesIndexed, nodeCount, edgeCount, durationMs, error),
    CodeGraphJsonContext.Default.CodeGraphIndexComplete);
```
- **Payload DTO — `CodeGraphIndexComplete`:**
  | field | type | notes |
  |---|---|---|
  | `indexId` | string | |
  | `state` | string | `complete` \| `partial` \| `failed` \| `cancelled` |
  | `filesIndexed` | int | |
  | `nodeCount` | int | final |
  | `edgeCount` | int | final |
  | `durationMs` | long | |
  | `error` | string? | on `failed` |
- Use `EmitEventIgnoringCancellationAsync` so the terminal frame flushes even when the run was cancelled (mirrors `ShellTools` abort path). The final `WorkerResponse` (the `CodeGraphIndexResult`/`CodeGraphSyncResult`) is still returned in addition to this event.

### 3.3 How main subscribes and forwards
Main-process subscribes once with
`getNativeWorker().onEvent('codegraph/index-progress', cb)` and
`onEvent('codegraph/index-complete', cb)` (`native-worker.ts:162`), then forwards
each `{event, params}` to the owning renderer window over a msgpack event channel —
the exact `shell-handlers.ts` forwarding pattern for `shell/output`. The renderer
correlates by `indexId`. No dedicated typed channel is needed at MVP (generic
`onEvent` suffices).

---

## 4. Error / result DTO shapes

### 4.1 Standard structured envelope
Every structured (non-tool-shaped) result composes these fields:
```csharp
// carried by CodeGraphIndexResult, CodeGraphSyncResult, CodeGraphIndexStatus,
// CodeGraphNodeListResult, CodeGraphSubgraphResult, CodeGraphReferencesResult, …
public bool   Success;      // false ⇒ inspect Error/ErrorKind
public string? Error;       // human-readable; null on success
public string? ErrorKind;   // machine tag; null on success
```
`ErrorKind` vocabulary (string constants, not a C# enum):
| `errorKind` | meaning | shape | promise |
|---|---|---|---|
| `not_indexed` | project never indexed / no default project | **success-shaped**: `success:true`, data fields empty, `error`+`errorKind` set as guidance | resolves |
| `path_refusal` | refused/sensitive root (`/etc`, `$HOME`, `/`) | **hard**: `success:false` | resolves (never rejects — §1.3) |
| `invalid_args` | missing/invalid required field | `success:false` (or success-shaped hint for query tools) | resolves |
| `internal` | handler threw unexpectedly | `success:false` | resolves |

### 4.2 Tool result shape (`codegraph/explore|search|node|callers|callees|impact|files|status`)
Mirrors the MCP tool output `{ content:[{type:'text',text}], isError? }` (analysis
04 §3.1) so the renderer can route the same-named MCP tool straight through:
```csharp
public sealed record CodeGraphToolResult(
    bool           Success,
    string         Text,        // the agent-visible markdown/plaintext
    bool           IsError,     // true only for hard failures (path_refusal, internal)
    string?        ErrorKind,   // not_indexed | path_refusal | internal | invalid_args | null
    string[]?      Notices);    // staleness/degraded/worktree banners (post-MVP, analysis 04 §3.4)
```
The renderer adapts this to `{ content:[{type:'text', text: Text}], isError: IsError }`.

### 4.3 The `not_indexed → success-shaped` vs `path_refusal → hard` split (behavioral, analysis 04 §3.3)
This split is **load-bearing**, not cosmetic — port it exactly and with its tests:

- **`not_indexed`** (and "no default project", "path not indexed") ⇒ **success-shaped
  guidance**: `CodeGraphToolResult { Success:true, IsError:false, ErrorKind:"not_indexed",
  Text:"<index this project first>" }`. An early `isError` teaches the agent to
  abandon the whole toolset for the session. Structured methods return their empty
  DTO with `success:true` + `errorKind:"not_indexed"`.
- **`path_refusal`** ⇒ **hard**: `CodeGraphToolResult { Success:false, IsError:true,
  ErrorKind:"path_refusal", Text:"<refused path>" }`, no retry guidance —
  abandoning that path is the desired reaction.
- **`internal`** ⇒ `IsError:true` **with** "retry once, else continue without
  codegraph" text.

Remember (§1.3): in **all** cases the JS promise **resolves**; `IsError`/`success`
in the payload is the only failure signal. `WorkerResponse.Error(...)` is reserved
for truly unexpected throws (it also resolves, as `{ error }`).

---

## 5. Renderer usage examples

All via the generic passthrough (`agentBridge.request`, Decision 9) — no new TS
plumbing.

### 5.1 Kick off a full index with an explicit long timeout + progress
```ts
// subscribe to streamed progress (main forwards worker onEvent → renderer)
const off = ipcClient.on('codegraph:index-progress', (p: {
  indexId: string; phase: string; filesDone: number; filesTotal: number
}) => updateIndexBar(p))

const indexId = crypto.randomUUID()
const res = (await agentBridge.request(
  'codegraph/index',
  { workingFolder: '/Users/me/repo', indexId },
  15 * 60_000            // explicit 15-min timeout; omitting it would cross as null
)) as {
  success: boolean; state: 'complete' | 'partial' | 'failed'
  filesIndexed: number; nodeCount: number; edgeCount: number; error?: string
}
off()
if (!res.success) showError(res.error)          // resolves even on failure (§1.3)
else if (res.state === 'partial') showWarning('index incomplete')
```

### 5.2 Explore (the agent's primary call) — success-shaped when un-indexed
```ts
const res = (await agentBridge.request(
  'codegraph/explore',
  { workingFolder: '/Users/me/repo', query: 'how does login reach the DB?', maxFiles: 12 },
  60_000
)) as { success: boolean; text: string; isError: boolean; errorKind?: string }

// un-indexed root ⇒ success:true, isError:false, errorKind:'not_indexed' — the
// agent gets guidance text, NOT a hard error, so it keeps using the toolset.
renderToolOutput({ content: [{ type: 'text', text: res.text }], isError: res.isError })
```

### 5.3 Structured status for the UI
```ts
const st = (await agentBridge.request(
  'codegraph/index-status',
  { workingFolder: '/Users/me/repo' }
)) as {
  success: boolean; indexed: boolean; state: string | null
  nodeCount: number; edgeCount: number; stale: boolean; dbSizeBytes: number
}
if (!st.indexed) promptToIndex()          // indexed:false is success, not an error
else if (st.stale) promptToReindex()
```

---

## Summary for the lead

This contract specifies **18 `codegraph/*` RPC methods** — 5 lifecycle/index
(`index`, `reindex`, `cancel-index`, `index-status`, `sync`), 7 tool-shaped queries
(`search`, `node`, `callers`, `callees`, `impact`, `files`, `status`), 3 structured
graph queries (`query-definition`, `query-references`, `query-neighbors`),
`explore`, plus `tools-list` and `instructions` — with 2 streamed events
(`codegraph/index-progress`, `codegraph/index-complete`). Each maps to a facade
method (analysis 05 §3.1) and, where applicable, an MCP tool (analysis 04 §3.1).

**Key gotchas both sides must honor:** (1) `WorkerResponse.Error` **resolves, never
rejects** — so every DTO carries explicit `success`/`error`/`errorKind` and the JS
side must inspect the payload, never rely on promise rejection; (2) the behavioral
**`not_indexed → success-shaped` vs `path_refusal → hard isError`** split, or the
agent abandons the toolset; (3) msgpack **undefined→null** for patch fields
(`sync.changedPaths`); (4) input is a raw `JsonElement` read via `JsonHelpers`, no
input DTO; (5) explicit `timeoutMs` on `index`/`explore` (60 s default otherwise).

**Underspecified — lead must decide:** (a) `workingFolder` vs an app-side default
project — whether/how a default is established (drives every "required?" cell);
(b) whether the 7 query tools return the text `CodeGraphToolResult` shape *and*
structured DTOs, or text-only at MVP; (c) final `errorKind` string vocabulary and
whether it lands in `CodeGraphJsonContext` as constants shared with the renderer;
(d) event channel naming for main→renderer forwarding (generic `onEvent` vs a typed
channel); (e) confirm `reindex` semantics (recreate-then-index vs in-place force).
```