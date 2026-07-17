# 06 — Target Worker Integration Contract (OpenCowork C# Native Worker)

**Role of this doc:** This is the *target shape* the CodeGraph port must conform to.
The other five analyses read CodeGraph's TypeScript; this one is the authority on
**how a new subsystem plugs into the existing OpenCowork .NET native worker**. It is
prescriptive: where it says "MUST", the runtime enforces it (duplicate-name throws,
AOT reflection-off, native-lib readiness gate, heartbeat kill).

All paths are absolute. Worker source lives under
`/Users/token/Desktop/code/OpenCowork/sidecars/OpenCowork.Native.Worker/`
(abbreviated below as `…/Worker/`). App source under
`/Users/token/Desktop/code/OpenCowork/src/`.

---

## 1. Scope & subsystem summary

The native worker is a **long-lived AOT-compiled .NET 10 sidecar** launched once per
Electron main process. It already *is* a persistent daemon (relevant: CodeGraph's own
daemon/watchdog machinery is largely redundant here). It speaks a JSON-RPC-shaped
protocol over a **length-prefixed MessagePack frame** on a Unix domain socket (macOS/
Linux) or named pipe (Windows).

Key facts (see `…/Worker/OpenCowork.Native.Worker.csproj`):

- `net10.0`, `PublishAot=true`, `Nullable=enable`, `ImplicitUsings=enable`,
  `InvariantGlobalization=false` (ICU present), `IlcOptimizationPreference=Speed`,
  `StripSymbols=true`.
- `JsonSerializerIsReflectionEnabledByDefault=false` — **all JSON (de)serialization is
  source-generated**. No reflection serialization, no `dynamic`, no runtime codegen.
- Only two NuGet refs today: `Microsoft.Data.Sqlite` 10.0.9 and
  `SQLitePCLRaw.bundle_e_sqlite3` 3.0.3. **No native-asset item groups exist in the
  csproj** — adding tree-sitter is new packaging territory (§7).
- **No C# `namespace` declarations anywhere.** Every file lives in the global namespace.
  Type collisions are avoided by *prefixing every class* with its area (`Db*`, `Ssh*`,
  `AgentRuntime*`). CodeGraph classes MUST likewise be prefixed `CodeGraph*` (§8).

Composition root, in order (`…/Worker/README.md`, `Hosting/`):

```
Program.Main (Program.cs)
  → WorkerEndpoint.Parse(args)              // args = ["--ipc", "<endpoint>"]
  → WorkerHost.CreateDefault(endpoint)      // Hosting/WorkerHost.cs
  → WorkerHostBuilder.UseDefaultModules()   // Hosting/WorkerHostBuilder.cs
  → WorkerModuleCatalog.Default             // Hosting/WorkerModuleCatalog.cs  ← register here
  → foreach module: IWorkerModule.Register(WorkerModuleContext)
  → LocalIpcWorkerServer.RunAsync()         // Runtime/LocalIpcWorkerServer.cs
  → WorkerDispatcher.DispatchAsync(method, params, ctx)   // Runtime/WorkerDispatcher.cs
```

---

## 2. End-to-end call path (renderer → worker) — what "reachable" means

The renderer **cannot** talk to the worker directly. Every call is
renderer → `ipcRenderer.invoke('<channel>:msgpack')` → a main-process `ipcMain.handle` →
the worker client → framed msgpack over the socket.

- **Main-process client:** `NativeWorkerManager` singleton, `getNativeWorker()`
  (`src/main/lib/native-worker.ts:777`). Generic, stringly-typed invoke:
  `request<T>(method: string, params?: unknown, timeoutMs?: number|null): Promise<T>`
  (`native-worker.ts:196`). It lazy-`ensureStarted()`s, assigns a monotonic `id`, encodes
  `{ id, method, params }`, and correlates the reply by `id` (`:214`, `:524`). Default
  timeout **60 s** (`:15`) if `timeoutMs` is null/omitted — long indexing calls MUST pass
  an explicit large timeout or, better, run detached and stream progress (§4).
- **Events:** `onEvent(name, cb)` for generic `{event, params}` frames (`:162`);
  `onRawEvent('agent/stream', cb)` for the hot msgpack fast-path (`:169`).
- **Two ways a NEW worker method becomes reachable from the renderer:**
  1. **Generic passthrough (zero new plumbing).** `agentBridge.request('codegraph/x', p)`
     (`src/renderer/src/lib/ipc/agent-bridge.ts:84`) rides the existing
     `sidecar:request:msgpack` channel → `sidecar-manager.ts:1192` → `manager.request` →
     `getNativeWorker().request('codegraph/x', p)`. **Any** method string is forwarded.
     Good enough for the whole CodeGraph query surface at MVP.
  2. **Dedicated typed channel (hot paths only).** Add a channel constant in
     `src/shared/messagepack/binary-ipc.ts`, a main handler via
     `registerMessagePackHandler` (`src/main/ipc/messagepack-handler.ts`) that calls
     `getNativeWorker().request(...)`, register the channel in
     `src/renderer/src/lib/ipc/messagepack-channel-routing.ts`, and (optionally) expose it
     on `window.api` (`src/preload/index.ts` + `index.d.ts`). This is the db/fs/shell/
     team-runtime pattern.
- **Method discovery is automatic.** `worker/routes` returns `context.GetRegisteredMethods()`
  (`…/Worker/Modules/SystemModule.cs:13`), i.e. every registered method across all modules.
  A new module needs **no** registration in any TS allow-list *unless* you want it on the
  boot-time required-methods gate (`REQUIRED_NATIVE_WORKER_METHODS`, `native-worker.ts:27`)
  — do **not** add CodeGraph there; it must not block worker boot.
- **Since agent-runtime runs *inside* this worker**, CodeGraph's MCP tools can be invoked
  in-process by the agent loop (no IPC round-trip) — the "MCP surface" is really just more
  registered methods the runtime can call directly.

---

## 3. The module contract (prescriptive)

### 3.1 `IWorkerModule` (`…/Worker/Runtime/IWorkerModule.cs`)

```csharp
internal interface IWorkerModule
{
    string Name { get; }                       // dedup key only (see below)
    void Register(WorkerModuleContext context); // wire methods here
}
```

`Name` is used **only** to reject duplicate modules at startup
(`WorkerHostBuilder.AddModule`, throws on collision). It is **independent of method
names**: `DbModule.Name == "db"` and prefixes methods `db/…`; `ShellModule.Name ==
"shell"` prefixes `shell/…`; but `AgentRuntimeModule.Name == "agent-runtime"` registers
**unprefixed** methods (`initialize`, `agent/run`). CodeGraph: `Name = "codegraph"`, and
prefix every method `codegraph/…`.

### 3.2 Registering methods — `WorkerModuleContext` (`Runtime/WorkerModuleContext.cs`)

Four handler-shape overloads exist; pick by whether you need streaming (`ctx`) and whether
you're sync or async:

```csharp
context.Register(method, (JsonElement args) => WorkerResponse);
context.Register(method, (JsonElement args) => Task<WorkerResponse>);
context.Register(method, (JsonElement args, WorkerRequestContext ctx) => WorkerResponse);
context.Register(method, (JsonElement args, WorkerRequestContext ctx) => Task<WorkerResponse>);
```

- **Input is a raw `JsonElement`** — there is **no** DTO deserialization of input. Read
  field-by-field with `JsonHelpers` (`Runtime/JsonHelpers.cs`): `GetString`, `GetInt`,
  `GetBool`, `GetLong`, `GetIntNullable`, `GetLongNullable`, `GetDoubleNullable`,
  `GetStringArray`; and `element.TryGetProperty(...)` + `EnumerateArray/Object` for nested
  shapes. This is deliberate (AOT-safe, no reflection). Copy this convention exactly.
- **Duplicate method names throw at startup** (`WorkerDispatcher.AddHandler`,
  `WorkerDispatcher.cs:53`). All `codegraph/*` names must be globally unique.
- An unknown method returns `WorkerResponse.Error("Unsupported method: …")` (`:38`).

Registration is a flat list of `context.Register(...)` calls — see the ~140-line
`…/Worker/Modules/Db/DbModule.cs` for the canonical shape. One module, many methods,
delegating to `static` `*Tools` classes.

### 3.3 Constructing `WorkerResponse` (`Runtime/WorkerResponse.cs`)

```csharp
WorkerResponse.Json<T>(T value, JsonTypeInfo<T> typeInfo)  // the normal path
WorkerResponse.String(string s)
WorkerResponse.RawJson(string json)          // reparse+reserialize a JSON string
WorkerResponse.FromWriter(Action<Utf8JsonWriter> w)  // zero-copy, large/dynamic payloads
WorkerResponse.Error(string message)         // ⚠ see error semantics below
```

**Wire framing (`Runtime/WorkerJson.cs:12`): the response is ALWAYS `{ id, result }`.**
There is no top-level `error` field emitted by this worker — `WriteResponse` writes `id`
then `result` unconditionally. Therefore:

> **Error convention (important, non-obvious).** `WorkerResponse.Error(msg)` serializes to
> `result: { error: msg }` (via `ErrorResult`, `Contracts/CommonModels.cs:1`) and the
> client-side promise **resolves** with `{ error: msg }` — it does **not** reject. The
> dispatcher's catch-all for an unhandled exception does the same
> (`LocalIpcWorkerServer.cs:231`). The TS `response.error`→`reject` branch
> (`native-worker.ts:531`) is effectively dead for this worker.

**Prescription:** model domain success/failure explicitly in your result DTO, exactly like
the DB modules — e.g. `record CodeGraphIndexResult(bool Success, …, string? Error)` and
return it via `WorkerResponse.Json`. Reserve `WorkerResponse.Error` for "this method blew
up unexpectedly"; callers must still inspect the payload. Never assume the JS side will
reject on failure.

### 3.4 Register the module — `Hosting/WorkerModuleCatalog.cs`

Add exactly one line to the static list:

```csharp
new CodeGraphModule(),
```

`SystemModule.cs` (30 lines) is the minimal copy-paste template for a new `IWorkerModule`.

---

## 4. Serialization under AOT (recipe)

### 4.1 The source-gen context (`…/Worker/Serialization/WorkerJsonContext.cs`)

One `partial class WorkerJsonContext : JsonSerializerContext` carries `[JsonSerializable]`
attributes for every serialized type (~200 today). Options set once at the top:

```csharp
[JsonSourceGenerationOptions(
    GenerationMode = JsonSourceGenerationMode.Metadata,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
```

So: **PascalCase C# props → camelCase JSON**, and **null props are omitted**. To force an
exact wire name (e.g. snake_case DB-row shapes), annotate the property
`[JsonPropertyName("working_folder")]` — see `Modules/Db/DbProjectModels.cs` (`ProjectRow`
uses snake_case to match the DB/TS contract). Positional `record`s get camelCase params
automatically.

### 4.2 "How to add a new serializable DTO" — concrete recipe

1. Define the type near its module (`Modules/CodeGraph/CodeGraphQueryModels.cs`). Prefix
   the class name `CodeGraph*` (global namespace). Prefer `record` for results,
   `sealed class` with `{ get; set; }` for DB rows you populate field-by-field.
2. Choose wire names: leave PascalCase for camelCase output, or add `[JsonPropertyName]`.
3. Register it in a source-gen context:
   - `[JsonSerializable(typeof(CodeGraphNode))]`
   - **Each collection is its own entry** with a stable alias:
     `[JsonSerializable(typeof(List<CodeGraphNode>), TypeInfoPropertyName = "ListCodeGraphNode")]`
     (mirrors the existing `List<ProjectRow>` → `ListProjectRow` pattern).
4. Serialize: `WorkerResponse.Json(result, CodeGraphJsonContext.Default.CodeGraphNode)` (or
   `.ListCodeGraphNode`).

**Where to register — decision for the lead (§11):** the codebase uses a *single*
`WorkerJsonContext`. You may either (a) append CodeGraph types to it (matches convention,
zero new wiring), or (b) create a dedicated `CodeGraphJsonContext` partial class (cleaner
isolation; you reference `CodeGraphJsonContext.Default.X`). Both are equally AOT-valid.
Recommendation: **dedicated context** — the port adds many DTOs and a separate context
keeps the diff and the type table legible.

### 4.3 Dynamic / loosely-shaped output (escape hatch)

For payloads whose shape is data-driven (e.g. arbitrary graph-query projections), you don't
have to pre-declare a DTO. Use `System.Text.Json.Nodes` (`JsonObject`/`JsonArray`, fully
AOT-safe, no reflection) and return `WorkerResponse.RawJson(node.ToJsonString())` — this is
exactly how `Modules/Mcp/McpConfigStore.cs` and `Modules/Sync/SyncFileStore.cs` work. For
*large* dynamic payloads prefer `WorkerResponse.FromWriter(writer => …)` and write straight
into the outgoing buffer (avoids the parse→reserialize cost of `RawJson`).

### 4.4 msgpack ↔ JSON transcoding and the undefined→null gotcha

Requests arrive as msgpack, are transcoded to JSON bytes
(`Runtime/MessagePackJsonTranscoder.cs`, via `MessagePackFrameProtocol.ConvertRequestToJson`),
then `JsonDocument.Parse`d into the `JsonElement` your handler receives. Responses go the
reverse way. Consequences the port must respect:

- **msgpack nil (`0xc0`) → JSON `null`.** The JS client omits `undefined` keys entirely
  (they never reach you), but an explicit `null` arrives as JSON `null`. This is the
  documented app-wide gotcha (`native-worker.ts:201-207`: an omitted `timeout` became
  `null` and bypassed a default param). **For patch/update methods you MUST distinguish
  `TryGetProperty == false` (absent → leave unchanged) from present-with-`Null` (→ clear).**
  Copy `DbProjectTools.ApplyProjectPatch` (`Modules/Db/DbProjectTools.cs:429`), which does
  exactly this per field. Do not use a plain `GetString` fallback where "explicitly cleared"
  and "not provided" must differ.
- **Non-finite numbers are rejected** by the transcoder (`WriteDouble`/`WriteSingle` throw
  on NaN/Infinity). Never emit NaN/Infinity in a result (e.g. a ranking score that divided
  by zero) — sanitize first.
- **Binary → base64 string.** msgpack `bin` (`0xc4-0xc6`) is base64-encoded to a JSON string
  on the way in; there is no raw-bytes JSON type. If CodeGraph ever returns blobs, they are
  base64 strings on the wire.
- **Map keys must be strings** (enforced by `ReadMapKey`). Fine for JSON objects; just never
  design a payload assuming non-string keys.
- Frames are capped at **256 MB** (`MessagePackFrameProtocol.cs:7`, mirrored
  `native-worker.ts:26`). A full-repo graph dump could approach this — paginate large query
  results.

---

## 5. Streaming / progress (indexing must stream)

A handler that receives a `WorkerRequestContext` (`Runtime/WorkerRequestContext.cs`) can
emit events *while running* and still return a final `WorkerResponse`. Two mechanisms:

### 5.1 Generic JSON events — **use this for index progress**

```csharp
public static async Task<WorkerResponse> IndexAsync(JsonElement args, WorkerRequestContext ctx)
{
    // …
    await ctx.EmitEventAsync(
        "codegraph/index-progress",
        new CodeGraphIndexProgress(indexId, filesDone, filesTotal, phase),
        CodeGraphJsonContext.Default.CodeGraphIndexProgress);
    // … when done:
    return WorkerResponse.Json(result, CodeGraphJsonContext.Default.CodeGraphIndexResult);
}
```

- Emits a `{ event: "codegraph/index-progress", params: {…} }` frame. The progress DTO MUST
  be in a source-gen context (§4).
- **This is the Shell template** (`Modules/Shell/ShellTools.cs:48` emits `shell/started`,
  `:211` emits `shell/output`). Main subscribes with
  `getNativeWorker().onEvent('codegraph/index-progress', cb)` and forwards to the owning
  renderer window over a msgpack event channel (the `shell-handlers.ts:380` pattern). Writes
  are serialized by a per-connection `writeLock` (`LocalIpcWorkerServer.cs:133`), so
  interleaving progress events with the eventual final response is safe.
- `EmitEventIgnoringCancellationAsync` exists for "flush a terminal event even though we're
  cancelling".

### 5.2 Hand-rolled msgpack fast-path — probably **not** needed

`ctx.EmitMessagePackEventAsync(WorkerMessagePackEvent)` writes pre-encoded msgpack, bypassing
JSON. Only `AgentStreamMessagePackEmitter.cs` uses it, for the extreme-volume `agent/stream`
path (with a `seq` counter + envelope + a renderer-side raw fast-reader). Index progress is
low-frequency; use §5.1 and skip this complexity unless progress volume proves pathological.

### 5.3 Cancellation of a long op — separate RPC + registry (not just the token)

`ctx.CancellationToken` is tied to the **client connection** (cancelled on disconnect,
`LocalIpcWorkerServer.cs:155`). For *user-initiated* cancel of an in-flight index, follow the
**Shell/AgentRuntime pattern**: register the running job in a
`static ConcurrentDictionary<string, CancellationTokenSource>` keyed by `indexId`, expose a
second method `codegraph/cancel-index` that looks up the id and cancels/aborts
(`ShellTools.cs:11` `Running` dict + `:145` `Abort`; `AgentRuntimeModule.cs:13`
`agent/cancel`). The index handler links the caller token with the registry CTS
(`CreateLinkedTokenSource`) and checks it in the parse loop.

### 5.4 Worker → host callbacks (reverse requests) — available, likely unused at MVP

`AgentRuntimeReverseRequests.RequestAsync(ctx, method, params, ct)`
(`Modules/AgentRuntime/AgentRuntimeReverseRequests.cs:9`) lets the worker call *back* into
the app and await a reply (emits `agent/reverse-request`, host answers via
`agent/reverse-response`). `Modules/File/FileSystemAccess.cs:96` uses it to prompt for macOS
folder permissions. CodeGraph likely doesn't need this for MVP (it reads project files it was
handed), but it's the mechanism if indexing ever hits a permission wall.

---

## 6. SQLite conventions (a NEW per-project graph DB)

### 6.1 Connection factory (`…/Worker/Modules/Db/DbConnectionFactory.cs`)

`DbConnectionFactory.Open` is **already path-parameterized and directly reusable**:

```csharp
DbConnectionFactory.OpenReadWriteCreate(string dbPath)  // public, creates dir + file
DbConnectionFactory.OpenReadWrite(string dbPath)        // public, existing file
```

It calls `SQLitePCL.Batteries_V2.Init()` once (lazy), `Directory.CreateDirectory`, then sets
the standard pragmas (`:42`):

```
busy_timeout = 5000   journal_mode = WAL       synchronous = NORMAL
wal_autocheckpoint=4000   cache_size = -16000 (16 MB)   foreign_keys = ON
Cache = Private (per-connection)
```

**Prescription:** the graph DB should reuse this factory (or a thin `CodeGraphConnectionFactory`
wrapper) so it inherits WAL + pragmas. Do **not** hand-roll a connection string. WAL matters
here: the long index writer and concurrent read-queries want WAL's reader/writer concurrency.

### 6.2 Additive migrations (`…/Worker/Modules/Db/DbSchemaMigrator.cs`)

The pattern is **no migration files, no version table**: `CREATE TABLE IF NOT EXISTS …` plus
idempotent `EnsureColumn(conn, table, col, def)` which checks `PRAGMA table_info` then
`ALTER TABLE ADD COLUMN` (`:948`). For CHECK-constraint changes, the rebuild pattern is
rename→create→copy→drop (`MigrateSessionGoalsStatusSchema`, `:871`). It's safe to run on
every open (idempotent).

**Prescription — a `CodeGraphSchemaMigrator.Initialize(SqliteConnection)`** mirroring this:
one method that creates the `nodes` / `edges` / FTS5 tables + indexes with `IF NOT EXISTS`,
then `EnsureColumn` for later additive fields. Copy `DbSchemaTools.Initialize`
(`Modules/Db/DbSchemaTools.cs`) for the open→migrate→return-result shape.

### 6.3 Where the graph DB lives (per-project, separate from `data.db`)

`data.db` is `~/.open-cowork/data.db` (`DbConnectionFactory.cs:58`). The **graph DB is a
separate file, per project.** Two viable layouts — **decision for the lead (§11):**

- **Co-located:** `<projectWorkingFolder>/.open-cowork/codegraph.db`. Matches CodeGraph's own
  ".in the repo" convention and is truly per-project/local; but it writes into the user's repo
  (needs a `.gitignore` hint) and breaks for SSH/remote working folders.
- **Central:** `~/.open-cowork/codegraph/<hash-of-workingFolder>.db`. Never pollutes repos,
  uniform local path; but "which repo is this" is indirection and stale DBs accumulate.

**Init strategy:** because there are N project DBs, prefer **lazy per-DB init** — every
CodeGraph handler resolves the project's DB path from its args
(`workingFolder`/`projectId`), opens via the factory, and calls
`CodeGraphSchemaMigrator.Initialize` behind a "already-initialized this path?" guard —
rather than a global `codegraph/initialize` boot step. (Contrast `db/initialize`, which is a
single global DB migrated once at app boot.)

### 6.4 Query/writer mechanics (copy verbatim)

`DbSql.ExecuteNonQuery(conn, tx, sql, params SqlParam[])` (`Modules/Db/DbSql.cs`) +
`connection.BeginTransaction()` + `command.Parameters.AddWithValue("$x", v ?? DBNull.Value)`
+ manual `reader.GetString/GetInt64/IsDBNull` row mapping. The full template is
`Modules/Db/DbProjectTools.cs` (transactioned create/update/delete, `$param` binding, row
readers, patch application). **Batch the index writer inside one transaction per file-batch**
— per-row autocommit on a 100k-node repo will be pathologically slow under WAL.

> **FTS5 caveat (hand off to the storage analyst):** FTS5 is **not used anywhere in the
> current worker** (grepped: zero `fts5`/`MATCH`/virtual-table hits). `bundle_e_sqlite3`
> 3.0.x is normally compiled with `SQLITE_ENABLE_FTS5`, but this MUST be verified before the
> graph schema depends on it (a one-line `CREATE VIRTUAL TABLE … USING fts5` smoke test at
> the target version). If FTS5 is absent, either switch the bundle package or fall back to
> LIKE/trigram indexes.

---

## 7. Concurrency, threading & long-running CPU work

- **Every RPC frame runs on its own Task.** `HandleClientAsync` spawns `HandleFrameAsync` per
  frame and does **not** await it inline (`LocalIpcWorkerServer.cs:148`) — so a long
  `codegraph/index` does not block `codegraph/cancel-index`, `worker/ping`, or any other
  method. Responses are correlated by `id`, not ordered.
- **Parallel parsing:** use `Parallel.ForEachAsync` / `Task.Run` honoring the linked
  cancellation token (§5.3). This is a normal CPU-bound .NET job.
- **⚠ Cross-cutting hazard — heartbeat starvation (rank: HIGH).** The main process pings
  `worker/ping` every 15 s with a **5 s** timeout and recycles the worker after **2** misses
  (`native-worker.ts:21-23,675-714`). If a full-core indexing job saturates the **threadpool**,
  the async continuation that answers `worker/ping` can be delayed past the heartbeat window
  and the supervisor will **SIGTERM/SIGKILL the worker mid-index** (`closeWorker`,
  `native-worker.ts:595`). Mitigations the port MUST adopt:
  - Cap parallelism **below** `Environment.ProcessorCount` (e.g. `max(1, N-1)`), **or** run
    the CPU-heavy parse on **dedicated threads** (`new Thread`/a bounded custom scheduler),
    not the shared threadpool, so the async IPC read loop and ping continuation stay
    responsive.
  - Keep individual synchronous work items short and `await Task.Yield()`/checkpoint the
    cancellation token frequently.
- **Memory pressure:** the ipc-frame path already reports pressure and triggers idle GC/LOH
  compaction (`WorkerMemory`, `Runtime/WorkerMemory.cs`). A big index that allocates lots of
  AST/string garbage should, on completion, call
  `WorkerMemory.ReportCompletedWork("codegraph-index", approxBytes, forceTrim: true)` to
  prompt a trim once idle — matching how `LocalIpcWorkerServer.HandleFrameAsync` reports frame
  bytes.
- **Single-owner lifecycle:** the worker exits when its sole client disconnects
  (`LocalIpcWorkerServer.cs:63`) and the supervisor owns respawn/backoff/reconnect
  (`native-worker.ts:639`, `onReconnect`/`onDisconnect`). CodeGraph background state
  (in-flight indexes, the registry in §5.3) is **process-local and lost on recycle** — persist
  index checkpoints to the graph DB so a respawn can resume/re-detect rather than assuming the
  process lives forever. (This is why co-opting CodeGraph's own persistent-daemon design is
  unnecessary — the OS/supervisor already provides it — but also why you can't hold important
  state only in memory.)

---

## 8. Build / packaging & AOT native-dependency constraints (the tree-sitter gate)

### 8.1 How the sidecar is built & shipped

- `scripts/publish-native-worker.mjs`:
  `dotnet publish -c Release -r <rid> /p:PublishAot=true /p:StripSymbols=true` → copied into
  `resources/native-worker/`.
- `electron-builder.yml:95` `asarUnpack: [ resources/** ]` — so `resources/native-worker/` is
  shipped **unpacked** (loadable native executables/libs).
- RIDs the app builds for (`native-worker.ts:1058` `getCurrentRid`, publish script
  `currentRid`): **osx-arm64, osx-x64, win-x64, win-arm64, linux-x64, linux-arm64.** Any native
  dep MUST exist for all shipped RIDs.
- Dev resolution (`resolveNativeWorkerPath`, `native-worker.ts:999`) searches
  `bin/Debug|Release/net10.0/<rid>/…` and packaged `resources/native-worker/…`; `predev.mjs`
  rebuilds before `npm run dev`.

### 8.2 Native libs *are auto-bundled by publish* — confirmed

`resources/native-worker/` currently contains the 17 MB AOT binary **and**
`libe_sqlite3.dylib` (1.66 MB) side-by-side. `dotnet publish` copies NuGet **runtime native
assets** (`runtimes/<rid>/native/*`) next to the executable automatically. **This is the key
packaging lever:** a tree-sitter native library shipped as a NuGet with
`runtimes/<rid>/native/…` (or referenced as a per-RID native file in the csproj) will land in
`resources/native-worker/` and ship with **no** electron-builder changes.

### 8.3 Constraints the tree-sitter decision MUST respect (rank-ordered)

1. **No WASM runtime / no `web-tree-sitter`.** The mission forbids the JS/WASM runtime, and a
   .NET WASM host (Wasmtime.NET etc.) is a heavy native dep with questionable AOT/trim
   cleanliness. **Rule it out.** Viable options: (a) native tree-sitter C core + per-language
   grammar libs via P/Invoke; (b) fully-managed C# parsers; (c) a hybrid.
2. **P/Invoke MUST be AOT-friendly.** Use **`[LibraryImport]`** (source-generated marshalling),
   **not** `[DllImport]` with runtime marshalling. No reflection-based interop, no
   `Marshal.GetDelegateForFunctionPointer` on trimmed types. This is compatible with the
   existing `SQLitePCLRaw` native interop model.
3. **The csproj has zero native-asset item groups today.** You will add either:
   - a **NuGet** carrying `runtimes/<rid>/native/libtree-sitter.*` + grammars (**preferred** —
     publish handles copy + per-RID selection), or
   - vendored libs via
     `<None Include="native/<rid>/libtree-sitter.dylib" CopyToOutputDirectory="PreserveNewest" Condition="'$(RuntimeIdentifier)'=='osx-arm64'" />`
     per RID (a **6-RID build matrix** you own — compile tree-sitter + every grammar for each).
4. **Readiness-gate blind spot.** `isNativeWorkerCandidateReady` (`native-worker.ts:1065`)
   gates worker selection **only** on the SQLite native lib being present next to the binary.
   A missing tree-sitter lib will **not** block boot but **will crash at the first P/Invoke**
   (`DllNotFoundException`). Mitigate by (a) ensuring the lib always ships (via NuGet runtime
   assets), and (b) **lazy-loading** grammars so the worker still boots and only
   `codegraph/*` methods fail gracefully if a grammar is absent — never let a grammar load
   failure take down the whole sidecar. Optionally extend the readiness check to include the
   tree-sitter lib.
5. **Trimming/AOT drops reflection-only types.** Pure P/Invoke bindings and managed
   grammar tables are safe; anything discovered by reflection is trimmed away. No
   `System.Reflection.Emit`.
6. **Size:** binary is already ~17 MB; tree-sitter core + N grammars add several MB per RID.
   Acceptable, but note it for installer size.

---

## 9. Recommended module layout & method namespace

**Namespace (methods): `codegraph/…`** (slash convention, like `db/`, `shell/`, `fs/`,
`mcp/`). Illustrative surface:

```
codegraph/index            codegraph/reindex          codegraph/cancel-index
codegraph/index-status     codegraph/sync             (incremental file-change apply)
codegraph/query-definition codegraph/query-references codegraph/query-callers
codegraph/query-neighbors  codegraph/search           (FTS/symbol search)
codegraph/mcp-list-tools   codegraph/mcp-call         (MCP-shaped surface for the agent loop)
```

Events: `codegraph/index-progress`, `codegraph/index-complete` (§5.1).

**One `IWorkerModule`, many files** (mirrors `Modules/Db/`: one `DbModule`, ~25 `*Tools.cs`).
A single module keeps the `codegraph/*` namespace unified and avoids duplicate-name
coordination across modules. Global namespace ⇒ **every class prefixed `CodeGraph*`.**

```
…/Worker/Modules/CodeGraph/
  CodeGraphModule.cs                 // IWorkerModule; Name="codegraph"; registers all codegraph/*
  CodeGraphConnectionFactory.cs      // thin wrapper over DbConnectionFactory for per-project path
  CodeGraphSchemaMigrator.cs         // nodes/edges/FTS5 tables + additive EnsureColumn
  CodeGraphIndexTools.cs             // index/reindex/cancel/status; emits progress; run registry
  CodeGraphSyncTools.cs              // incremental change apply (reuse dir-scan/ignore, §ref)
  CodeGraphQueryTools.cs             // graph queries
  CodeGraphMcpTools.cs               // MCP-tool-shaped handlers (callable in-process by runtime)
  CodeGraphIndexModels.cs            // DTOs → source-gen context
  CodeGraphQueryModels.cs            // DTOs → source-gen context
  Extraction/
    CodeGraphTreeSitterInterop.cs    // [LibraryImport] bindings (AOT)
    CodeGraphLanguageRegistry.cs     // language → grammar + extractor
    CodeGraphExtractors*.cs          // per-language node/edge extraction
    CodeGraphFrameworkEdges*.cs      // React/Redux/Spring/… synthesizers
Serialization/CodeGraphJsonContext.cs  // dedicated partial JsonSerializerContext (recommended)
```

Register once in `Hosting/WorkerModuleCatalog.cs` (`new CodeGraphModule()`).

**Reuse opportunities (don't reinvent):**
- Directory scan + ignore/gitignore handling overlaps `Modules/File/FileSystemAccess.cs`,
  `Modules/File/FileTools.cs`, `Modules/File/FileGrepExternalEngines.cs`. Reuse the ignore/
  walk logic rather than porting CodeGraph's `ignore`/`picomatch`.
- Incremental file-change tracking has a precedent in `Modules/Sync/SyncFileStore.cs`
  (hashing, atomic temp-file writes, change enumeration).
- Per-project DB open/migrate/transaction/row-map: `Modules/Db/*` verbatim.
- HTTP (if ever needed): `Runtime/WorkerHttpClientFactory.cs`.

**Reachability:** at MVP every `codegraph/*` method is callable from the renderer via the
**generic passthrough** (`agentBridge.request('codegraph/x', p)`) with **zero** new TS code
(§2). Promote only hot query paths to dedicated typed msgpack channels later.

---

## 10. MVP vs later

**MVP (first working slice):**
- `CodeGraphModule` + `WorkerModuleCatalog` entry; `codegraph/index` (streaming progress) +
  `codegraph/cancel-index` + `codegraph/index-status`; a handful of `codegraph/query-*`.
- Per-project graph DB via reused `DbConnectionFactory` + `CodeGraphSchemaMigrator` (lazy
  init); nodes/edges/FTS5 schema.
- Tree-sitter core + **2-3 languages** via `[LibraryImport]`, shipped as NuGet runtime assets
  for the 6 RIDs (or start with the current dev RID and expand).
- Reachable via generic passthrough only.
- Cap indexing parallelism to protect the heartbeat.

**Later / deferrable:**
- Full language matrix + framework-edge synthesizers.
- `codegraph/sync` incremental watch-driven updates (the worker is already a daemon; wire to
  the app's file-change signals rather than porting CodeGraph's watcher).
- Dedicated typed msgpack channels + `window.api` surface for hot query paths.
- Reverse-request permission handling (only if remote/SSH indexing is added).
- Extending the native-lib readiness gate to include tree-sitter.

---

## 11. Open questions / decisions for the architect

1. **Graph DB location** (§6.3): co-located `<repo>/.open-cowork/codegraph.db` vs central
   `~/.open-cowork/codegraph/<hash>.db`. Affects SSH/remote support, repo cleanliness, and
   how a query resolves "which DB". Recommend central for uniformity; needs a ruling.
2. **Serialization context** (§4.2): append CodeGraph DTOs to the existing `WorkerJsonContext`
   (convention) vs a dedicated `CodeGraphJsonContext` (recommended for isolation). One-line
   decision, but set it before DTOs proliferate.
3. **Tree-sitter delivery** (§8.3): NuGet-with-runtime-native-assets vs vendored per-RID
   native files. Determines who owns the 6-RID native build matrix and CI cost. Coordinate
   with the extraction analyst's grammar choice.
4. **FTS5 availability** (§6.4): must be verified in `bundle_e_sqlite3` 3.0.3 at the target
   RID before the schema commits to it. Owned by the storage analyst; blocks schema design.
5. **Heartbeat vs CPU saturation** (§7): confirm the parallelism cap / dedicated-thread
   strategy with whoever owns worker lifecycle, so a full-core index can't get the sidecar
   SIGKILLed mid-run. This is the single highest-risk integration hazard.
6. **Error surfacing** (§3.3): the port must adopt the explicit `success`/`error` DTO
   convention because `WorkerResponse.Error` *resolves* (not rejects) on the client. Confirm
   no CodeGraph query is expected to throw-through to a rejected JS promise.
7. **Index run persistence across recycle** (§7): agree where index checkpoints live so a
   supervisor respawn can resume rather than silently losing an in-flight index.
```