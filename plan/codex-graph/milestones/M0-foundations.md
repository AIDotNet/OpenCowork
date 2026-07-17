# M0 — Foundations & de-risking spikes · Engineer Checklist

> **⚠ Process-model addendum ([reference/04](../reference/04-process-model-and-enablement.md)).**
> This checklist was written for the embedded design; the architecture is now an
> **opt-in standalone sidecar**. Apply these deltas throughout:
> - The `CodeGraph` module lives in a new **`OpenCowork.CodeGraph.Core`** class
>   library, hosted by a new thin **`OpenCowork.CodeGraph.Worker`** AOT Exe
>   (`Program.Main` + a one-module catalog). Wherever a task says "add to /
>   `OpenCowork.Native.Worker`", target the new `Core` lib + `Worker` host instead.
> - **New M0-A task:** scaffold `OpenCowork.CodeGraph.Worker` (copy the main
>   worker's `Program.cs`/host bootstrap; catalog = `{ CodeGraphModule }`) and its
>   `.csproj` (`PublishAot=true`, reflection-off JSON); wire its per-RID publish
>   output like the main worker's.
> - **Round-trip via the 2nd manager:** prove `codegraph/status` through a new
>   `getCodeGraphWorker()` (the parameterized `NativeWorkerManager`, reference/04 §3)
>   — **not** `getNativeWorker()`. The tree-sitter AOT spike (M0-C) targets the
>   **CodeGraph** binary; for M0 place ONE grammar locally (dev bootstrap from a
>   TreeSitter.DotNet prebuilt binary) — the real **download-on-enable** grammar
>   delivery (reference/04 §6) is an M5 concern, not M0. `libtree-sitter` core is
>   bundled with the binary.
> - The enable/disable toggle itself is M5; for M0 the worker may be spawned directly.

---

## ✅ M0 EXECUTION STATUS (2026-07-16)

**The two hard interop unknowns are DE-RISKED and empirically proven in a real
NativeAOT-compiled binary.** Built with .NET SDK 10.0.301 (see NETSDK1057 note below).

**Projects created & building (0 warnings / 0 errors, incl. AOT publish):**
- `sidecars/OpenCowork.CodeGraph.Core/` — class library: DTOs, `CodeGraphJsonContext`
  (source-gen), `Storage/{CodeGraphConnectionFactory, CodeGraphSchema, CodeGraphDbSmoke}`,
  `CodeGraphNodeIdFactory`, `Extraction/CodeGraphSourceText`, `Extraction/TreeSitter/*`
  (the full `[LibraryImport]` binding). **AOT-clean (zero trim/AOT warnings).**
- `sidecars/OpenCowork.CodeGraph.Worker/` — AOT exe; M0 `Program.cs` is a **self-test
  harness** (the real IPC host is staged in `_deferred/Program.host.cs`).

**Verified — running the NATIVE Mach-O arm64 binary (no dotnet host):**
```
db-smoke : {"success":true,"sqliteVersion":"3.50.4","fts5":true}
tree-sit : binding callable; grammar 'typescript' not loaded (expected at M0)
RESULT   : M0 SELF-TEST OK
```
- **M0-B ✅** FTS5 works at AOT runtime in bundled `e_sqlite3` (real `CREATE VIRTUAL
  TABLE … fts5` + `MATCH` + `sqlite_version()=3.50.4`); `libe_sqlite3.dylib` auto-copied
  by publish (the analysis/06 §8.2 packaging lever, confirmed).
- **M0-C ✅** tree-sitter `[LibraryImport]` binding compiles **and is callable** in the
  AOT binary, degrading gracefully (`GetLanguage→null`) with no grammar lib present.
  Actual file parse defers to M2 (needs a grammar lib; per reference/04 §6 grammars
  download on enable). Also proved: reflection-free source-gen JSON works under AOT.
- **M2 interop PRE-VERIFIED (bonus).** Dropping the real `TreeSitter.DotNet` 1.3.0
  osx-arm64 dylibs (`libtree-sitter.dylib` + all 8 MVP grammars, file names matching our
  `[LibraryImport]` exactly) beside the AOT binary and re-running flipped the probe to
  `grammar 'typescript' loaded (handle=0x…)` — the binding **loads a real grammar,
  resolves `tree_sitter_typescript()`, and passes the `ts_language_abi_version` ABI
  check** in the AOT binary. This resolves reference/03's open questions: the
  ABI-accessor symbol is `ts_language_abi_version` (present + working), and
  **TreeSitter.DotNet 1.3.0 is a confirmed dev bootstrap** for TS/TSX/JS/Python/Go/Java/
  C#/Rust. (Network to nuget.org is available in this env, so M2 can be verified
  end-to-end here.) **Full parse+walk also PROVEN** (isolated scratch harness
  compile-including only `Extraction/`): parsing real TypeScript yields
  `root=program, named-children=2, hasError=False`; walking gives
  `[0] function_declaration @line 1` with child-by-field `name → greet` and correct
  byte offsets / UTF-8 text slicing. So the **entire** binding surface (parse, root,
  type, named-child, child-by-field, points, text) is verified — M2's core interop is
  fully de-risked; only the `visitNode` extractor logic remains to write in M2.

**Fixes applied during the spike:** added `<AllowUnsafeBlocks>true>` to Core.csproj —
`[LibraryImport]` source-gen emits `unsafe` marshalling (the main worker omits it as it
has no P/Invoke).

**M0-A ⏸ DEFERRED — with a concrete blocking finding (the spike's main discovery):**
The IPC-host round-trip (`CodeGraphModule` + `Program.host.cs`) implements the worker's
runtime types (`IWorkerModule`, `WorkerModuleContext`, `WorkerResponse`, the msgpack
transport, `WorkerHostBuilder`…) which live **inside** `OpenCowork.Native.Worker`. A
second worker can't just reference `Core`; that runtime/transport layer must be **shared**.
**→ Prerequisite for the IPC host: extract a shared `OpenCowork.Worker.Runtime` class
library** from the main worker's `Runtime/` + `Hosting/` + msgpack + `Contracts/`, and
have BOTH workers reference it (reference/04 §3 assumed "reuse LocalIpcWorkerServer/
transport wholesale" — this is how). Rejected alternatives: duplicating the runtime into
Core (fork risk) or `<Compile Include>` source-linking the whole interdependent cluster
(fragile). The `CodeGraphModule.cs` + host `Program.cs` are written and API-correct,
staged under each project's `_deferred/`, ready for that extraction.

**Build/env note (NETSDK1057):** no `global.json` in the repo + two SDKs installed
(10.0.301 stable, 11.0.100-preview), so builds float to the **preview** SDK. Recommend a
repo-root `global.json` pinning `10.0.301` (`rollForward: latestFeature`) for reproducible
builds — **affects the main worker too**, so ratify before adding.

**Next:** the IPC-host follow-up = (1) extract `OpenCowork.Worker.Runtime`; (2) un-defer
`CodeGraphModule` + host `Program.cs`; (3) the TS second-worker wiring (spec in the
workflow's `mainproc-wiring` output / reference/04 §3, §7). Then M1 (storage/graph core).

---

> **Milestone goal (from [`00-overview-and-roadmap.md`](../00-overview-and-roadmap.md) §5 M0):**
> Prove the two hard interop facts end-to-end and stand up the `CodeGraph` module
> skeleton. Exit when: (1) a renderer call reaches a `codegraph/*` worker handler,
> (2) a per-project graph DB is created and an FTS5 `MATCH` query runs, and
> (3) the **AOT-published** worker loads a tree-sitter grammar and parses a file.
>
> This doc is executable start-to-finish. Three workstreams (**M0-A** module +
> IPC round-trip, **M0-B** graph DB bring-up, **M0-C** tree-sitter `[LibraryImport]`
> spike — *the gate*). A/B are independent and can run in parallel; **C is the
> critical path** and should start first.
>
> All paths absolute. Worker source lives under
> `/Users/token/Desktop/code/OpenCowork/sidecars/OpenCowork.Native.Worker/`
> (abbreviated `…/Worker/` below).

---

## Prerequisites & ground rules (read once)

- [ ] **Dev toolchain present.** `dotnet --version` → 11.x SDK is installed; the
  csproj targets `net10.0`. `node`/`npm` present for the Electron side.
- [ ] **Dev RID for this machine = `osx-arm64`** (`uname -m` → `arm64`, darwin).
  Everywhere below `<dev-rid>` means `osx-arm64` on this box. The publish script
  (`scripts/publish-native-worker.mjs`) auto-detects it; only the standalone AOT
  spike command in M0-C names it explicitly.
- [ ] **Worker conventions are enforced, not stylistic** (analysis/06 §1, §3):
  - **No `namespace` declarations** anywhere in the worker. Every file is in the
    global namespace; collisions are avoided by **prefixing every class
    `CodeGraph*`**. (`grep -rL "namespace " …/Worker/Modules` — you will find none.)
  - `PublishAot=true`, `JsonSerializerIsReflectionEnabledByDefault=false`,
    `Nullable=enable`, `ImplicitUsings=enable`. **No reflection JSON, no
    `dynamic`, no `[DllImport]`** (use `[LibraryImport]`).
  - **RPC input is a raw `JsonElement`** — read field-by-field with
    `…/Worker/Runtime/JsonHelpers.cs` (`GetString`/`GetInt`/…). Never deserialize
    input into a DTO.
  - **`WorkerResponse.Error(msg)` resolves, it does not reject** on the JS side
    (analysis/06 §3.3). Model success/failure in the result DTO
    (`record …(bool Success, …, string? Error)`), like the `Db*` modules.
- [ ] **Skim the templates you will copy:** `…/Worker/Modules/SystemModule.cs`
  (30-line `IWorkerModule`), `…/Worker/Modules/Db/DbConnectionFactory.cs`,
  `…/Worker/Modules/Db/DbSchemaMigrator.cs`, `…/Worker/Serialization/WorkerJsonContext.cs`.

---

## Workstream M0-A — Module skeleton & IPC round-trip

**Deliverable:** `CodeGraphModule` (`Name="codegraph"`) registered in the catalog,
serving a stub `codegraph/status`, reachable from the renderer via the generic
passthrough. **No** tree-sitter, **no** SQLite yet — a pure wiring slice.

- [ ] **A1 — Create the module.**
  **File:** create `…/Worker/Modules/CodeGraph/CodeGraphModule.cs`.
  Model it on `SystemModule.cs`. Global namespace, prefix `CodeGraph*`.

  ```csharp
  using System.Text.Json;

  internal sealed class CodeGraphModule : IWorkerModule
  {
      public string Name => "codegraph";

      public void Register(WorkerModuleContext context)
      {
          context.Register("codegraph/status", (JsonElement args) =>
          {
              var workingFolder = JsonHelpers.GetString(args, "workingFolder");
              return WorkerResponse.Json(
                  new CodeGraphStatusResult(
                      Success: true,
                      Ready: false,               // stub: no engine yet
                      WorkingFolder: workingFolder,
                      Version: "m0-skeleton",
                      Error: null),
                  CodeGraphJsonContext.Default.CodeGraphStatusResult);
          });
      }
  }

  internal sealed record CodeGraphStatusResult(
      bool Success,
      bool Ready,
      string? WorkingFolder,
      string Version,
      string? Error);
  ```

  **Done when:** file compiles as part of the next build (A4 gate). **Pitfalls:**
  do not add a `namespace`; do not name the class `StatusResult` (collides with the
  existing `SystemModule` DTO — the `CodeGraph*` prefix exists for exactly this).

- [ ] **A2 — Create the dedicated source-gen JSON context** (Decision 7;
  analysis/06 §4.2 recommends a *dedicated* context, not appending to
  `WorkerJsonContext`).
  **File:** create `…/Worker/Serialization/CodeGraphJsonContext.cs`.

  ```csharp
  using System.Text.Json.Serialization;

  [JsonSourceGenerationOptions(
      GenerationMode = JsonSourceGenerationMode.Metadata,
      PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
      DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
  [JsonSerializable(typeof(CodeGraphStatusResult))]
  internal sealed partial class CodeGraphJsonContext : JsonSerializerContext;
  ```

  **Done when:** `CodeGraphJsonContext.Default.CodeGraphStatusResult` resolves at
  build time (the source generator produces the metadata). **Pitfalls:** each
  serialized type needs its own `[JsonSerializable]`; every `List<T>` result you
  add later needs a **separate** entry with a stable
  `TypeInfoPropertyName = "ListCodeGraphX"` (mirror `WorkerJsonContext`'s
  `ListProjectRow` pattern). PascalCase C# props emit as camelCase JSON — don't
  hand-camelCase field names.

- [ ] **A3 — Register the module in the catalog.**
  **File:** edit `…/Worker/Hosting/WorkerModuleCatalog.cs`. Add exactly one line to
  the `Default` list (e.g. after `new SshModule()`):

  ```csharp
      new SshModule(),
      new CodeGraphModule()
  ```

  **Done when:** `worker/routes` includes `codegraph/status` (verified in A5).
  **Pitfalls:** `Name` must be unique — `WorkerHostBuilder.AddModule` throws
  `Duplicate worker module` at startup on collision. Do **not** register
  `codegraph/status` in `REQUIRED_NATIVE_WORKER_METHODS`
  (`src/main/lib/native-worker.ts:27`) — CodeGraph must never gate worker boot
  (Decision 9, analysis/06 §2).

- [ ] **A4 — Build the worker (Debug) and typecheck the app.**
  **Commands:**
  ```bash
  dotnet build /Users/token/Desktop/code/OpenCowork/sidecars/OpenCowork.Native.Worker/OpenCowork.Native.Worker.csproj -c Debug --nologo
  cd /Users/token/Desktop/code/OpenCowork && npm run typecheck
  ```
  **Done when:** both exit `0`. The Debug build lands in
  `…/Worker/bin/Debug/net10.0/` — the path `resolveNativeWorkerPath`
  (`native-worker.ts:1007`) prefers in dev.
  **Pitfalls:** a missing `[JsonSerializable]` surfaces as a build error
  ("no metadata for type"), not a runtime one — fix it here.

- [ ] **A5 — Prove the renderer → worker round-trip via the generic passthrough**
  (Decision 9; call path = analysis/06 §2). `agentBridge.request(method, params)`
  rides `sidecar:request:msgpack` → main → `getNativeWorker().request(method,…)`,
  which lazy-`ensureStarted()`s the worker. **No `initialize` handshake needed** for
  a bare passthrough request.
  **Approach (temporary dev hook — revert after):** at the bottom of
  `/Users/token/Desktop/code/OpenCowork/src/renderer/src/lib/ipc/agent-bridge.ts`,
  add, guarded so it is trivially removable:
  ```ts
  // TEMP M0-A round-trip probe — delete before merge.
  if (import.meta.env.DEV) (window as unknown as { __cg?: unknown }).__cg = agentBridge
  ```
  **Commands:**
  ```bash
  cd /Users/token/Desktop/code/OpenCowork && npm run dev
  ```
  Then in the app's DevTools console:
  ```js
  await window.__cg.request('codegraph/status', { workingFolder: '/tmp/demo' })
  // → { success: true, ready: false, workingFolder: '/tmp/demo', version: 'm0-skeleton', error: null }
  ```
  **Done when:** the console call resolves to the stub object above (camelCase keys).
  Confirm `worker/routes` lists it too:
  `(await window.__cg.request('worker/routes', {})).methods.includes('codegraph/status')` → `true`.
  **Pitfalls:** (a) `predev.mjs` rebuilds the worker (Debug) before `dev`; if you
  edited C# after `dev` started, restart `dev` or the old binary is still live.
  (b) A thrown/failed handler **resolves** with `{ error: … }` — inspect the
  payload, don't rely on a rejected promise. (c) Remove the `__cg` hook once the
  gate is green.

**M0-A Done-when (gate):** `npm run typecheck` + `dotnet build -c Debug` green, and
a manual `codegraph/status` call returns the stub `CodeGraphStatusResult`.

---

## Workstream M0-B — Graph DB bring-up

**Deliverable:** opening a project lazily creates
`~/.open-cowork/codegraph/<sha256(root)>/graph.db` with graph-tuned PRAGMAs, the
`nodes` + `nodes_fts` + triggers minimum schema, and a working FTS5 `MATCH` smoke
query. (FTS5 presence is already verified — Decision 2 / analysis/03 §4.1 —
so this is bring-up, not de-risking.)

- [ ] **B1 — Graph-tuned connection factory** (Decision 4; PRAGMA order from
  analysis/03 §6.2). Reuses the `DbConnectionFactory` *shape* but **not** its
  pragmas (`data.db` uses `wal_autocheckpoint=4000`, `cache_size=-16000` — wrong
  for the graph).
  **File:** create `…/Worker/Modules/CodeGraph/Storage/CodeGraphConnectionFactory.cs`.

  ```csharp
  using Microsoft.Data.Sqlite;

  internal static class CodeGraphConnectionFactory
  {
      private static bool sqliteInitialized;

      public static SqliteConnection OpenReadWriteCreate(string dbPath)
      {
          EnsureSqliteInitialized();
          Directory.CreateDirectory(Path.GetDirectoryName(dbPath) ?? ".");

          var builder = new SqliteConnectionStringBuilder
          {
              DataSource = dbPath,
              Mode = SqliteOpenMode.ReadWriteCreate,
              Cache = SqliteCacheMode.Private
          };
          var connection = new SqliteConnection(builder.ToString());
          connection.Open();

          // Order is load-bearing: busy_timeout BEFORE journal_mode so a
          // concurrent writer's lock is waited out, not thrown (#238).
          Exec(connection, "PRAGMA busy_timeout = 5000");
          Exec(connection, "PRAGMA foreign_keys = ON");
          Exec(connection, "PRAGMA journal_mode = WAL");
          Exec(connection, "PRAGMA synchronous = NORMAL");
          Exec(connection, "PRAGMA cache_size = -64000");     // 64 MB
          Exec(connection, "PRAGMA temp_store = MEMORY");
          Exec(connection, "PRAGMA mmap_size = 268435456");   // 256 MB
          return connection;
      }

      private static void EnsureSqliteInitialized()
      {
          if (sqliteInitialized) return;
          SQLitePCL.Batteries_V2.Init();   // once, same as DbConnectionFactory
          sqliteInitialized = true;
      }

      private static void Exec(SqliteConnection c, string sql)
      {
          using var cmd = c.CreateCommand();
          cmd.CommandText = sql;
          cmd.ExecuteNonQuery();
      }
  }
  ```

  **Done when:** it compiles and (via B4) an opened connection reports
  `PRAGMA journal_mode` → `wal`. **Pitfalls:** do **not** call the shared
  `DbConnectionFactory.Open*` — it applies the wrong pragmas. Keep the pragma
  order exactly as above (analysis/03 §2.2, §6.2). `Batteries_V2.Init()` is
  process-global and idempotent; calling it here and in `DbConnectionFactory` is
  fine.

- [ ] **B2 — Per-project path resolution + already-initialized guard**
  (Decision 3, centralized location; analysis/06 §6.3 lazy per-DB init).
  **File:** create `…/Worker/Modules/CodeGraph/Support/CodeGraphDataDir.cs`.

  ```csharp
  using System.Security.Cryptography;
  using System.Text;

  internal static class CodeGraphDataDir
  {
      public static string GraphDbPath(string projectRoot)
      {
          var full = Path.GetFullPath(projectRoot);
          var hash = Convert.ToHexString(
              SHA256.HashData(Encoding.UTF8.GetBytes(full))).ToLowerInvariant();
          return Path.Combine(
              Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
              ".open-cowork", "codegraph", hash, "graph.db");
      }
  }
  ```

  Add a static init guard (a `HashSet<string>` of initialized db paths behind a
  lock, or a `ConcurrentDictionary<string, byte>`) so `CodeGraphSchemaMigrator`
  runs once per path per process, not on every handler call.
  **Done when:** two calls for the same root yield the same path; a second open of
  an already-initialized path skips the DDL. **Pitfalls:** normalize the root
  (`Path.GetFullPath`) before hashing so `/repo` and `/repo/` hash identically.
  Process-local guard state is **lost on supervised respawn** (analysis/06 §7) —
  acceptable in M0 (the migrator is `IF NOT EXISTS`-idempotent and cheap to re-run).

- [ ] **B3 — Final DDL + migrator** (Decision 18, collapse to final schema;
  minimum for M0 = `nodes` + `nodes_fts` + 3 triggers + node indexes. Full
  `edges`/`unresolved_refs`/`name_segment_vocab`/`project_metadata` land in M1 —
  see [`reference/01-data-model-and-schema.md`](../reference/01-data-model-and-schema.md)
  once written; the column set below is from analysis/03 §2.1).
  **File:** create `…/Worker/Modules/CodeGraph/Storage/CodeGraphSchema.cs` (holds the
  DDL string) and `…/Worker/Modules/CodeGraph/Storage/CodeGraphSchemaMigrator.cs`
  (the `Initialize(SqliteConnection)` entry, mirroring `DbSchemaMigrator`).

  ```csharp
  internal static class CodeGraphSchema
  {
      public const string Ddl = """
          CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            qualified_name TEXT,
            file_path TEXT NOT NULL,
            language TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            start_column INTEGER NOT NULL,
            end_column INTEGER NOT NULL,
            docstring TEXT,
            signature TEXT,
            visibility TEXT,
            is_exported INTEGER DEFAULT 0,
            is_async INTEGER DEFAULT 0,
            is_static INTEGER DEFAULT 0,
            is_abstract INTEGER DEFAULT 0,
            decorators TEXT,        -- JSON array (raw string in-process)
            type_parameters TEXT,   -- JSON array
            return_type TEXT,
            updated_at INTEGER
          );

          CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
          CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
          CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
          CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
          CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
          CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
          CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));

          CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
            id, name, qualified_name, docstring, signature,
            content='nodes', content_rowid='rowid'
          );

          CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
            VALUES (new.rowid, new.id, new.name, new.qualified_name, new.docstring, new.signature);
          END;
          CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
            VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.docstring, old.signature);
          END;
          CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
            INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
            VALUES ('delete', old.rowid, old.id, old.name, old.qualified_name, old.docstring, old.signature);
            INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
            VALUES (new.rowid, new.id, new.name, new.qualified_name, new.docstring, new.signature);
          END;
          """;
  }
  ```

  `CodeGraphSchemaMigrator.Initialize` = one `ExecuteNonQuery(CodeGraphSchema.Ddl)`
  (multi-statement exec, like `DbSchemaMigrator.Execute`), then any future
  `EnsureColumn` calls (none needed in M0). Copy `DbSchemaTools.Initialize`'s
  open→migrate→return-result shape.
  **Done when:** running it against a fresh DB creates `nodes`, `nodes_fts`, and the
  three triggers (`SELECT name FROM sqlite_master WHERE type IN ('table','trigger')`).
  **Pitfalls:** the FTS5 delete/update triggers use the **special `('delete', …)`
  command row** — omitting it corrupts the external-content index. Column order in
  the `nodes_fts(…)` insert lists must match the virtual-table column order. The
  fts5 column order (`id, name, qualified_name, docstring, signature`) fixes the
  bm25 weight positions used in B4 (`0, 20, 5, 1, 2`).

- [ ] **B4 — Wire a `codegraph/db-smoke` handler (temporary M0 proof) and run the
  FTS5 MATCH.** Register in `CodeGraphModule.Register` a handler that: resolves the
  path (B2), opens (B1), initializes (B3), inserts one sample node, and runs a
  `MATCH` + `bm25` query.
  **File:** extend `…/Worker/Modules/CodeGraph/CodeGraphModule.cs`. Sketch:
  ```csharp
  context.Register("codegraph/db-smoke", (JsonElement args) =>
  {
      var root = JsonHelpers.GetString(args, "workingFolder") ?? "/tmp/demo";
      var dbPath = CodeGraphDataDir.GraphDbPath(root);
      using var conn = CodeGraphConnectionFactory.OpenReadWriteCreate(dbPath);
      CodeGraphSchemaMigrator.Initialize(conn);
      // insert one node (id/kind/name/file_path/language/… ), then:
      // SELECT id, bm25(nodes_fts, 0,20,5,1,2) AS score
      //   FROM nodes_fts WHERE nodes_fts MATCH 'order*' ORDER BY score;
      // return { success, dbPath, matchCount, sampleScore } via CodeGraphJsonContext
  });
  ```
  Add a `CodeGraphDbSmokeResult` DTO + `[JsonSerializable]` entry in
  `CodeGraphJsonContext`.
  **Commands:** rebuild + `npm run dev`, then in DevTools:
  ```js
  await window.__cg.request('codegraph/db-smoke', { workingFolder: '/tmp/demo' })
  ```
  Verify on disk:
  ```bash
  ls -la ~/.open-cowork/codegraph/*/graph.db
  ```
  **Done when:** the call returns `matchCount >= 1` with a finite `sampleScore`, and
  `graph.db` (+ `-wal`/`-shm`) exists under `~/.open-cowork/codegraph/<hash>/`.
  **Pitfalls:** `bm25()` returns **negative** scores (smaller = better) — that is
  correct, not a bug (analysis/03 §4.1 shows `bm25=-1E-06`). Never emit
  `NaN`/`Infinity` in a result — the msgpack transcoder throws on non-finite
  numbers (analysis/06 §4.4); sanitize a divide-by-zero score first. `codegraph/db-smoke`
  is throwaway M0 scaffolding — keep it out of `REQUIRED_NATIVE_WORKER_METHODS`;
  delete or fold it into real query methods in M1.

**M0-B Done-when (gate):** opening a project creates the per-project graph DB and a
`CREATE VIRTUAL TABLE … USING fts5` + `MATCH` smoke query succeeds end-to-end.

---

## Workstream M0-C — Tree-sitter `[LibraryImport]` spike (THE GATE)

**Deliverable:** a minimal own-authored `[LibraryImport]` binding that, in the
**AOT-published** worker, loads a TypeScript grammar, parses a sample `.ts` file,
walks the root node, and prints node types + byte spans + UTF-8 text slices.
This is the single make-or-break interop unknown (Decision 1; analysis/01 §5A;
risk R2/R3/R4). Start this first.

- [ ] **C1 — Obtain the native libs (bootstrap from TreeSitter.DotNet prebuilt
  binaries)** (Decision 1; analysis/01 §5A recommendation). You need TWO dylibs for
  `<dev-rid>`: the core `libtree-sitter` and the `libtree-sitter-typescript` grammar,
  **from the same TreeSitter.DotNet release** (ABI must match — see C4 pitfall).
  **Commands (bootstrap via NuGet package extraction — no managed dependency taken):**
  ```bash
  cd /Users/token/Desktop/code/OpenCowork
  mkdir -p sidecars/OpenCowork.Native.Worker/native/osx-arm64
  # Pull the prebuilt native assets from the TreeSitter.DotNet nupkg(s). Example:
  #   1. download TreeSitter.DotNet + grammar nupkg from nuget.org (or the
  #      configured OPEN_COWORK_NUGET_SOURCE mirror)
  #   2. unzip and copy runtimes/osx-arm64/native/libtree-sitter.dylib
  #      and libtree-sitter-typescript.dylib into native/osx-arm64/
  ```
  Place the two `.dylib` files at:
  `…/Worker/native/osx-arm64/libtree-sitter.dylib` and
  `…/Worker/native/osx-arm64/libtree-sitter-typescript.dylib`.
  **Done when:** both files exist and `file` reports `Mach-O 64-bit dynamically
  linked shared library arm64`; `nm -gU libtree-sitter-typescript.dylib | grep
  tree_sitter_typescript` shows the exported entrypoint.
  **Pitfalls:** do **not** add a `PackageReference` to `TreeSitter.DotNet`'s managed
  assembly — it may use `[DllImport]` and is AOT-unverified (analysis/01 §5A). Use it
  only as a *source of prebuilt binaries*. `tree-sitter-typescript` exports **two**
  languages: `tree_sitter_typescript` and `tree_sitter_tsx` — bind the former for
  `.ts`.

- [ ] **C2 — csproj: copy the native libs next to the published binary.**
  **File:** edit `…/Worker/OpenCowork.Native.Worker.csproj`. Add an item group so
  the dylibs land at the **output root** (beside `OpenCowork.Native.Worker` and
  `libe_sqlite3.dylib`), which is where `NativeLibrary` default-probes:
  ```xml
  <ItemGroup>
    <None Include="native/$(RuntimeIdentifier)/libtree-sitter.dylib"
          Condition="Exists('native/$(RuntimeIdentifier)/libtree-sitter.dylib')"
          CopyToOutputDirectory="PreserveNewest" Link="%(Filename)%(Extension)" />
    <None Include="native/$(RuntimeIdentifier)/libtree-sitter-typescript.dylib"
          Condition="Exists('native/$(RuntimeIdentifier)/libtree-sitter-typescript.dylib')"
          CopyToOutputDirectory="PreserveNewest" Link="%(Filename)%(Extension)" />
  </ItemGroup>
  ```
  **Done when:** after a publish (C5) both dylibs sit next to the AOT binary in the
  publish output (and, after `native:publish`, in `resources/native-worker/`).
  **Pitfalls:** `$(RuntimeIdentifier)` is only set during `dotnet publish -r <rid>` /
  `build -r <rid>`, **not** a bare `dotnet build` — the `Condition`/`Exists` guard
  keeps a plain Debug build from failing, but means the **dev (`npm run dev`) Debug
  worker won't have the dylibs** unless you also build with `-r <dev-rid>` or drop
  copies into `bin/Debug/net10.0/`. For fast non-AOT iteration, either
  `dotnet build -r osx-arm64` or manually copy the two dylibs into
  `bin/Debug/net10.0/`. The AOT publish (C5) is the actual gate; the Debug path is
  only a convenience. The publish script copies the **whole** temp output dir into
  `resources/native-worker/` (`publish-native-worker.mjs:59`), so no
  electron-builder change is needed (analysis/06 §8.2).

- [ ] **C3 — Author the minimal `[LibraryImport]` binding.**
  **File:** create `…/Worker/Modules/CodeGraph/Extraction/TreeSitter/CodeGraphTsBindings.cs`.
  The full binding lands per
  [`reference/03-tree-sitter-binding.md`](../reference/03-tree-sitter-binding.md)
  (once written); M0 needs only the parse+navigate subset (analysis/01 §2.6, §3.3).
  Bind against the base lib names `tree-sitter` / `tree-sitter-typescript` (default
  probing strips `lib`/`.dylib`). `TSNode` is a 4×`uint` context + two pointers —
  a blittable `[StructLayout(LayoutKind.Sequential)]` struct (passed/returned **by
  value**, no marshalling). Minimum functions:
  ```csharp
  using System.Runtime.InteropServices;

  [StructLayout(LayoutKind.Sequential)]
  internal struct TsNodeRaw
  {
      public uint Context0, Context1, Context2, Context3;
      public nint Id;
      public nint Tree;
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct TsPoint { public uint Row; public uint Column; }

  internal static partial class CodeGraphTsBindings
  {
      [LibraryImport("tree-sitter")] internal static partial nint ts_parser_new();
      [LibraryImport("tree-sitter")] internal static partial void ts_parser_delete(nint parser);
      [LibraryImport("tree-sitter")] [return: MarshalAs(UnmanagedType.I1)]
      internal static partial bool ts_parser_set_language(nint parser, nint language);
      // parse_string takes UTF-8 bytes + byte length
      [LibraryImport("tree-sitter")]
      internal static partial nint ts_parser_parse_string(nint parser, nint oldTree, byte[] src, uint length);
      [LibraryImport("tree-sitter")] internal static partial void ts_tree_delete(nint tree);
      [LibraryImport("tree-sitter")] internal static partial TsNodeRaw ts_tree_root_node(nint tree);
      [LibraryImport("tree-sitter")] internal static partial nint ts_node_type(TsNodeRaw node);          // const char* (UTF-8)
      [LibraryImport("tree-sitter")] internal static partial uint ts_node_start_byte(TsNodeRaw node);
      [LibraryImport("tree-sitter")] internal static partial uint ts_node_end_byte(TsNodeRaw node);
      [LibraryImport("tree-sitter")] internal static partial TsPoint ts_node_start_point(TsNodeRaw node);
      [LibraryImport("tree-sitter")] internal static partial uint ts_node_child_count(TsNodeRaw node);
      [LibraryImport("tree-sitter")] internal static partial TsNodeRaw ts_node_child(TsNodeRaw node, uint index);
      [LibraryImport("tree-sitter")] internal static partial uint ts_node_named_child_count(TsNodeRaw node);
      [LibraryImport("tree-sitter")] internal static partial TsNodeRaw ts_node_named_child(TsNodeRaw node, uint index);
      [LibraryImport("tree-sitter")] [return: MarshalAs(UnmanagedType.I1)]
      internal static partial bool ts_node_is_named(TsNodeRaw node);

      // grammar entrypoint from the grammar lib
      [LibraryImport("tree-sitter-typescript")] internal static partial nint tree_sitter_typescript();
  }
  ```
  `ts_node_type` returns a `const char*`; convert with
  `Marshal.PtrToStringUTF8(ptr)`. Slice text as `src[startByte..endByte]` on the
  **UTF-8 `byte[]`** then `Encoding.UTF8.GetString(...)` (risk R4 — byte offsets,
  never `char` indices; lines are 1-based `row+1`, columns 0-based).
  **Done when:** the file compiles under AOT (C5). **Pitfalls:** use
  `[LibraryImport]` **never** `[DllImport]` (AOT rule, analysis/06 §8.3.2).
  `ts_parser_parse_string` wants a byte length, not a char count — pass
  `(uint)utf8Bytes.Length`. Every `TSNode` is a value; the walk copies structs,
  which is correct and cheap.

- [ ] **C4 — Add a standalone self-test entrypoint** (so the AOT binary can prove
  parsing without the IPC socket).
  **File:** edit `…/Worker/Program.cs` — add an early branch in `Main` before
  `WorkerEndpoint.Parse`:
  ```csharp
  if (args.Length >= 2 && args[0] == "--codegraph-selftest")
      return CodeGraphTsSelfTest.Run(args[1]);   // returns 0 on success, non-0 on failure
  ```
  **File:** create `…/Worker/Modules/CodeGraph/Extraction/TreeSitter/CodeGraphTsSelfTest.cs`:
  read the sample file as UTF-8 bytes → `ts_parser_new` → `ts_parser_set_language(p,
  tree_sitter_typescript())` (assert it returns `true`) → `ts_parser_parse_string`
  → `ts_tree_root_node` → walk children, printing for the first ~10 named nodes:
  `type`, `[startByte..endByte)`, `startPoint (line,col)`, and the UTF-8 text slice.
  Free with `ts_tree_delete`/`ts_parser_delete`. Return `0` iff the root type is
  `program` and at least one expected child type (e.g. `function_declaration`,
  `class_declaration`, `import_statement`) appears.
  **Sample file:** create `/private/tmp/claude-501/.../scratchpad/sample.ts` (or any
  path) with a couple of functions/classes/imports to walk.
  **Done when:** compiles; behavior proven in C5. **Pitfalls:** `ts_parser_set_language`
  returns **`false`** (silently) if the grammar ABI is incompatible with the core
  lib — this is the #1 spike failure mode (risk R3). If it returns false, the core
  and grammar dylibs are from mismatched ABIs; re-pull both from the *same*
  TreeSitter.DotNet release (C1). This self-test is temporary M0 scaffolding — mark
  it for deletion once the real extractor lands in M2.

- [ ] **C5 — Prove it under AOT publish (THE gate).**
  **Commands:**
  ```bash
  cd /Users/token/Desktop/code/OpenCowork
  # publish the AOT worker for the dev RID into a temp dir
  dotnet publish sidecars/OpenCowork.Native.Worker/OpenCowork.Native.Worker.csproj \
    -c Release -r osx-arm64 /p:PublishAot=true /p:StripSymbols=true \
    -o /private/tmp/cg-aot-out
  # confirm the grammar libs were copied beside the binary
  ls -la /private/tmp/cg-aot-out/libtree-sitter*.dylib
  # run the standalone self-test against a sample .ts
  /private/tmp/cg-aot-out/OpenCowork.Native.Worker --codegraph-selftest /path/to/sample.ts
  echo "exit=$?"
  ```
  **Done when:** the AOT binary prints the walk (correct node types, byte spans, and
  UTF-8 text slices matching the source) and exits `0`; both dylibs are present next
  to the binary. Record the **exact commands + the grammar-lib placement** (this doc's
  C1/C2 paths) in the spike notes.
  **Pitfalls:** a `DllNotFoundException` at first P/Invoke means the dylib didn't ship
  next to the binary — the readiness gate (`isNativeWorkerCandidateReady`,
  `native-worker.ts:1065`) checks **only** for the SQLite lib, so a missing
  tree-sitter lib does **not** block boot; it crashes at first call (analysis/06
  §8.3.4). Verify the `ls` shows the dylibs. If publish omits them, re-check the
  C2 `Condition`/`$(RuntimeIdentifier)` (it must be `osx-arm64` here). If AOT trims
  something, it will be a build-time ILC warning, not a silent drop — pure
  `[LibraryImport]` bindings are AOT-safe.

- [ ] **C6 — Confirm the grammar loads through the *normal* worker too (optional but
  recommended).** Copy the published output over `resources/native-worker/` via
  `npm run native:publish`, then hit a temporary `codegraph/ts-selftest` RPC (or
  reuse `--codegraph-selftest`) so the same parse path is exercised inside the live
  sidecar the app launches.
  **Command:** `cd /Users/token/Desktop/code/OpenCowork && npm run native:publish`
  **Done when:** `ls resources/native-worker/libtree-sitter*.dylib` shows both libs
  alongside `OpenCowork.Native.Worker` and `libe_sqlite3.dylib`.
  **Pitfalls:** lazy-load grammars in the real engine (M2) so a missing/incompatible
  grammar degrades one `codegraph/*` method instead of crashing the whole sidecar
  (WS-C discipline; analysis/06 §8.3.4).

**M0-C Done-when (gate):** the **AOT-published** worker parses a sample `.ts` file
and the node-walk output (types + byte spans + UTF-8 slices) is correct; the exact
publish commands and grammar-lib placement are documented.

---

## M0 exit checklist (all three gates)

- [ ] **M0-A:** `dotnet build -c Debug` + `npm run typecheck` green; a manual
  `codegraph/status` call returns the stub `CodeGraphStatusResult` over the generic
  passthrough. (`codegraph/*` is **not** in `REQUIRED_NATIVE_WORKER_METHODS`.)
- [ ] **M0-B:** opening a project lazily creates
  `~/.open-cowork/codegraph/<sha256(root)>/graph.db` with graph-tuned PRAGMAs and the
  `nodes` + `nodes_fts` + triggers schema; a `CREATE VIRTUAL TABLE … fts5` + `MATCH`/`bm25`
  smoke query returns a hit with a finite score.
- [ ] **M0-C (the gate):** the AOT-published worker loads the TypeScript grammar and
  parses a file; the node walk is correct; commands + lib placement documented.
- [ ] **Cleanup:** the temporary `__cg` window hook (A5), `codegraph/db-smoke` (B4),
  and `--codegraph-selftest`/`CodeGraphTsSelfTest` (C4) are marked for deletion (they
  are M0 scaffolding, not shipped surface).

---

## Dev-loop commands (reference)

```bash
# Fast inner loop (Debug worker, no AOT). predev.mjs rebuilds the worker first.
cd /Users/token/Desktop/code/OpenCowork && npm run dev

# Rebuild only the worker (Debug), e.g. after a C# edit while dev is running:
dotnet build sidecars/OpenCowork.Native.Worker/OpenCowork.Native.Worker.csproj -c Debug --nologo
# (restart `npm run dev` to pick up the new binary — the resolver prefers bin/Debug)

# Full AOT parity build (what M0-C gates on), copied into resources/native-worker/:
npm run native:publish        # → dotnet publish -c Release -r <dev-rid> /p:PublishAot=true

# App-side validation:
npm run typecheck             # typecheck:node + typecheck:web (strict)
npm run lint                  # ESLint (note: known pre-existing failures in vendored
                              #  resources/extensions — lint changed files, not the tree)
```

Notes: the Debug worker (`npm run dev`) is faster to iterate but, per C2, only has the
grammar dylibs if you build with `-r <dev-rid>` or hand-copy them into
`bin/Debug/net10.0/`. AOT publish (`native:publish`) is the real tree-sitter gate.

---

## Risks surfaced early (carry forward)

- **R1 — Heartbeat starvation is NOT exercised in M0 → flag for M2.** The main
  process pings `worker/ping` every **15 s** with a **5 s** timeout and SIGKILLs the
  worker after **2** misses (`native-worker.ts:21-23,675-714`). M0 does no full-core
  indexing, so this hazard is **unvalidated here**. The M2 extraction engine MUST run
  CPU-heavy parsing on **dedicated threads** (or cap parallelism to
  `max(1, ProcessorCount-1)`), off the shared thread-pool, and checkpoint the
  `CancellationToken`/`Task.Yield()` frequently, so the IPC read loop + ping stay
  responsive (Decision 10; analysis/06 §7). **Do not** let M0's clean bill of health
  imply this is handled — it is the single highest integration risk and belongs to M2.
- **R2/R3 — Grammar ABI fidelity.** M0-C proves *one* clean first-party grammar. If
  `ts_parser_set_language` ever returns `false`, it's an ABI mismatch between the core
  and grammar dylibs — pin both to the same TreeSitter.DotNet release now, and treat
  the niche/patched grammars (M6/WS-A) as a separate, higher-risk sourcing job.
- **R4 — UTF-8 byte offsets.** The self-test already forces the byte-slice discipline;
  centralize it in `CodeGraphSourceText` (M2) so no later code slices by `char` index.
- **Process-local state lost on respawn.** The B2 init guard and any future in-flight
  index state die on supervised respawn (analysis/06 §7). Fine for M0; M1+ must persist
  index checkpoints to the graph DB (Decision 15).
- **Error semantics.** Every `codegraph/*` result is a `{ success, …, error }` DTO —
  `WorkerResponse.Error` *resolves* on the JS side, so callers must inspect payloads,
  never rely on a rejected promise (analysis/06 §3.3). Bake this in from the first DTO.
