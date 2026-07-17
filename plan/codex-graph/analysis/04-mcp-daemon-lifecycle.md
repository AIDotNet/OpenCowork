# 04 — MCP Server, Daemon Architecture & Process Lifecycle

> Scope: CodeGraph `src/mcp/**` (20 files, ~9,658 LOC) + related tests. Target:
> the OpenCowork .NET 10 native worker (`sidecars/OpenCowork.Native.Worker/`).
>
> **Headline finding — validated:** the OpenCowork native worker is *already* a
> long-lived, single-owner sidecar with its own IPC transport, concurrent
> request dispatch, lifecycle supervision, and process-death reaping. That host
> **subsumes the overwhelming majority of `src/mcp/`.** Of the 20 files, **12
> drop entirely, 4 are replaced by existing worker capabilities, and only 4 are
> reproduced** — and of those 4, most of the reproduced LOC is the tool
> *contract* + *dispatch*, not infrastructure. The standalone daemon exists to
> turn a per-session stdio child into a shared multi-client service that reaps
> itself; OpenCowork's worker already **is** that shared service. The C# design
> is dramatically simpler than CodeGraph's daemon — the thesis holds.

---

## 1. Scope & subsystem summary

`src/mcp/` is CodeGraph's **agent-facing surface** and the process machinery
that keeps it alive and shared. Four concerns, physically interleaved:

| Concern | Files | LOC | Role |
|---|---|---|---|
| **Tool contract + dispatch** | `tools.ts` (4,685), `server-instructions.ts` (103), `dynamic-boundaries.ts` (398) | 5,186 | The 8 MCP tools, their schemas/annotations, allowlist gating, input validation, error classification, cross-cutting notices, and explore's dynamic-dispatch boundary detection. **This is the external contract.** |
| **MCP protocol** | `transport.ts` (436), `session.ts` (350), `startup-handshake.ts` (71), `stdin-teardown.ts` (46), `version.ts` (36) | 939 | JSON-RPC 2.0 over stdio/socket; the `initialize`/`tools/list`/`tools/call`/`roots` state machine; orphan/teardown backstops. |
| **Shared engine** | `engine.ts` (334) | 334 | One `CodeGraph` + watcher + `ToolHandler`, lazily opened, shared across sessions; catch-up gate. |
| **Daemon + lifecycle** | `daemon.ts` (867), `proxy.ts` (596), `daemon-registry.ts` (199), `daemon-paths.ts` (140), `daemon-manager.ts` (117), `query-pool.ts` (326), `query-worker.ts` (103), `ppid-watchdog.ts` (95), `early-ppid.ts` (25), `liveness-watchdog.ts` (242), `index.ts` (489) | 3,199 | Detached shared daemon, stdio↔socket proxy, socket paths, discovery registry, interactive stop CLI, worker-thread read pool, parent-death and main-thread-wedge watchdogs, mode selection. |

**Why the daemon exists at all** (`index.ts:17-35`, `daemon.ts:1-41`): a plain
MCP server is a stdio child the host spawns *per session*. That's wasteful — each
child re-opens SQLite, re-warms tree-sitter, and starts its own file watcher
(one inotify set per session). Issue #411 introduced a **detached daemon**: one
background process per project root, N MCP clients attached over a Unix socket /
named pipe, sharing **one** `CodeGraph` + **one** watcher + **one** WAL handle.
Because the daemon must not be any host's child (closing one terminal would sever
every other client — `index.ts:30-34`), it is spawned detached and reaped by
**client-refcount + idle timeout** rather than parent death. Every host actually
talks to a thin **proxy** (`proxy.ts`) that pipes stdio↔socket and carries the
parent-death watchdog. This entire topology is a workaround for "the OS process
model gives me per-session children, but I want one shared long-lived service."

**OpenCowork already has the shared long-lived service.** That single sentence
is the analytical crux of this document.

---

## 2. Architecture & data flow

### 2.1 The three runtime modes (`index.ts`)

`MCPServer.start()` (`index.ts:226-275`) picks a mode:

- **Direct** (`startDirect`, `index.ts:310-350`): one process = one stdio MCP
  session. Used when `CODEGRAPH_NO_DAEMON=1`, no `.codegraph/` is reachable, or
  the daemon path throws. Instantiates one `MCPEngine` + one `MCPSession` over
  `StdioTransport`.
- **Proxy** (`runProxyWithLocalHandshake`, `index.ts:406-441`): the common case.
  Answers `initialize`/`tools/list` **locally from static constants** for instant
  tool registration, forwards `tools/call` to the shared daemon connected in the
  background. Falls back to an in-process engine if the daemon never binds.
- **Daemon** (`startDaemonProcess`, `index.ts:361-396`): the detached process
  itself (spawned with `CODEGRAPH_DAEMON_INTERNAL=1`). Arbitrates the `O_EXCL`
  lock, binds the socket, serves N sessions forever.

The "answer the handshake locally, connect the daemon in the background" split
(`proxy.ts:216-412`) is a **cold-start race fix**: spawning+binding a daemon
takes ~600ms, long enough that a headless agent saw "No such tool available" and
fell back to grep/Read. None of this race exists when tools are registered
statically in the worker at startup.

### 2.2 MCP protocol (`transport.ts`, `session.ts`)

- **Wire format** (`transport.ts:84-246`): newline-delimited JSON-RPC 2.0. A
  shared `LineBasedJsonRpcTransport` base implements request/response/notify and
  **bidirectional** server→client requests (used for `roots/list`,
  `transport.ts:114-129`). `StdioTransport` and `SocketTransport` differ only in
  which streams plug in and whether a close calls `process.exit`.
- **Session state machine** (`session.ts:143-183`): dispatches `initialize`,
  `initialized`, `tools/list`, `tools/call`, `ping`, and answers
  `resources/list` / `resources/templates/list` / `prompts/list` with **empty
  lists** (not `-32601`) because opencode/Codex probe them (#621,
  `session.ts:161-173`).
- **`initialize`** (`session.ts:185-241`): **responds before any heavy init**
  (#172 — slow FS could blow the ~30s handshake timeout). Resolves the project
  root strongest-signal-first: client `rootUri` → `workspaceFolders` → `--path`;
  `cwd` deferred so a later `roots/list` can win (#196). Picks the instructions
  variant by whether the root is indexed (`SERVER_INSTRUCTIONS` vs
  `SERVER_INSTRUCTIONS_NO_ROOT_INDEX`), then kicks off engine init in the
  background.
- **`roots/list`** (`session.ts:334-349`): server-initiated request to learn the
  workspace root when the client didn't pass one; 5s timeout → falls back to
  `cwd`.
- **Lazy default-project resolution** (`retryInitIfNeeded`, `session.ts:305-328`):
  three layers — await the in-flight init, else ask `roots/list` (or cwd), else
  a synchronous last-resort re-walk that picks up a project `codegraph init`'d
  *after* the server started.

### 2.3 Shared engine (`engine.ts`) — this is the reusable idea

`MCPEngine` owns the heavyweight, *shared* state: the `CodeGraph` instance, the
file watcher, and the `ToolHandler` (`engine.ts:53-72`). **One engine, many
sessions** — daemon mode opens the DB once and every session reads the same WAL
and the same inotify set. Key mechanisms:

- **Lazy, idempotent init** (`ensureInitialized`, `engine.ts:133-150`):
  concurrent callers share one in-flight promise so racing sessions never
  double-open SQLite. The heavy `CodeGraph` chain (sqlite + query/graph layers)
  is `require()`'d lazily *off* the startup path (`engine.ts:26-27`).
- **Catch-up gate** (`catchUpSync`, `engine.ts:296-312`): after open, runs a
  one-shot `cg.sync()` to reconcile edits/deletes/`git pull` made while no
  watcher ran, and pushes the promise into the `ToolHandler` so the **first tool
  call blocks** on it (time-boxed, #905). Without it, a tool call races past sync
  and returns rows for files that no longer exist.
- **Watcher** (`startWatching`, `engine.ts:231-284`): debounced auto-sync;
  degradation is announced once (`onDegraded`) so long sessions stop assuming
  freshness.
- **Query pool** (`maybeStartPool`, `engine.ts:80-96`): daemon-mode only —
  off-loads read dispatch to worker threads (see §2.5).

### 2.4 The daemon (`daemon.ts`) — refcount, lock, idle, phantom-reaping

`Daemon` (`daemon.ts:167-513`) binds a socket, spawns an `MCPSession` per
connection over `SocketTransport`, and manages its own death:

- **Lockfile arbitration** (`tryAcquireDaemonLock`, `daemon.ts:555-604`): atomic
  `O_EXCL`-equivalent via `link()` (race-free, no empty-file window — must-fix 1),
  with an `openSync('wx')` fallback for filesystems without hard links (#997).
- **Socket candidate walk** (`daemon.ts:219-259`, `daemon-paths.ts:69-89`):
  in-project `.codegraph/daemon.sock` first, deterministic `os.tmpdir()` hash
  fallback for ExFAT/FAT/WSL2/over-long paths. Daemon and proxy walk the *same*
  ordered list, converging with zero coordination.
- **Refcount + idle** (`daemon.ts:386-416`): last client disconnect → linger
  `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` (default 300s) then exit.
- **Phantom-client backstops** (`daemon.ts:433-498`): a `hostPid`-carrying
  client-hello + a periodic liveness sweep + a 30-min inactivity backstop, all
  to reap a client whose socket-close was never delivered (a Windows named-pipe
  hazard, #692).
- **Windows shutdown drain** (`finalizeDaemonExit`, `daemon.ts:95-110`): don't
  `process.exit()` while `fs.watch` handles are closing (libuv assertion).

Every one of these is a consequence of "I am a detached process that N unrelated
clients attach to and I must reap myself." **None of it is a code-intelligence
concern.**

### 2.5 Query pool (`query-pool.ts`, `query-worker.ts`) — a Node-only workaround

The daemon serves every session on **one event loop** with **synchronous**
`node:sqlite`. `codegraph_explore` is CPU-heavy (FTS + personalized-PageRank +
impact + output building) stitched by `await`s, so N concurrent explores keep
the microtask queue full and **starve the macrotask phases — including socket
I/O** (`query-worker.ts:1-22`): "a 10-way wave delivered 0 transport heartbeats
in 25s." The pool (`query-pool.ts`) moves read dispatch onto worker threads, each
holding its own WAL read connection, restoring multi-core parallelism and an idle
main loop. It has lazy growth, crash-recovery with retry + circuit breaker, and a
success-shaped "busy, retry" backstop so overload never teaches abandonment.

**This entire subsystem is a fix for a constraint the C# worker does not have**
(see §2.6). It is the single clearest "drop" in the port.

### 2.6 The OpenCowork worker already provides the shared-service substrate

Established from the target repo:

- **Long-lived, single-owner sidecar.** `LocalIpcWorkerServer`
  (`Runtime/LocalIpcWorkerServer.cs:6-28`) listens on a named pipe (Windows) or
  Unix socket (POSIX). One client (the Electron main). It **exits when its sole
  client disconnects** (`LocalIpcWorkerServer.cs:62-73, 112-121`) and **exits if
  no client connects within 2 min** (`FirstClientAcceptTimeout`,
  `LocalIpcWorkerServer.cs:12`). The Electron `NativeWorkerManager`
  (`src/main/lib/native-worker.ts`) owns spawn/restart/heartbeat.
- **Concurrent request dispatch, non-blocking.** `HandleClientAsync`
  (`LocalIpcWorkerServer.cs:130-167`) reads frames in a loop and dispatches each
  as a **separate `Task` it does not await** (`HandleFrameAsync`, line 148); a
  `SemaphoreSlim` serializes only the frame *writes* (line 273-288). CPU-bound
  handler work runs on thread-pool threads. **This is exactly what the query
  pool manufactures in Node — the worker has it natively.**
- **Module contract.** `IWorkerModule.Register(WorkerModuleContext)`
  (`Runtime/IWorkerModule.cs`) registers dotted RPC methods
  (`context.Register("db/sessions-list", handler)`,
  `Modules/Db/DbModule.cs:5-12`). Handlers take `(JsonElement args,
  WorkerRequestContext ctx)` and return `WorkerResponse`
  (`Runtime/WorkerDispatcher.cs`). Modules are listed in
  `Hosting/WorkerModuleCatalog.cs`.
- **SQLite conventions.** `DbConnectionFactory`
  (`Modules/Db/DbConnectionFactory.cs:28-49`) opens `Microsoft.Data.Sqlite` with
  WAL + `busy_timeout` + `SQLitePCL.Batteries_V2.Init()`. Additive migrations via
  `DbSchemaMigrator` (no migration files).
- **Streaming events.** `WorkerRequestContext.EmitEventAsync` /
  `EmitMessagePackEventAsync` (`Runtime/WorkerRequestContext.cs:21-40`) stream
  progress frames mid-request — usable for index/sync progress.

### 2.7 How CodeGraph tools reach an OpenCowork agent today (the surfacing path)

OpenCowork already runs external MCP servers and already renders *their* tools to
its agent — a fully worked template for surfacing CodeGraph:

1. MCP server configs live in `~/.open-cowork/mcp-servers.json`, CRUD'd by the
   worker's `McpConfigStore` (`Modules/Mcp/McpConfigStore.cs`) via
   `mcp/config-*` methods (`Modules/Mcp/McpConfigModule.cs`).
2. The **Electron main** connects to each server (`src/main/mcp/mcp-manager.ts`,
   `mcp-client.ts`), collecting `{name, description, inputSchema}` per tool and
   executing via `callTool(serverId, toolName, args)`.
3. The **renderer** registers each as an agent tool named
   `mcp__{serverId}__{toolName}` in its `toolRegistry`, keeping only the
   *definition*; **"Execution is owned by the .NET Native Worker"**
   (`src/renderer/src/lib/mcp/mcp-tools.ts:51-88`).

So OpenCowork's agent tools are `{definition in renderer registry, execution
routed to a backend}`. CodeGraph's tools slot into that exact shape.

---

## 3. Public / internal contracts the C# port must reproduce

### 3.1 The MCP tool contract — the 8 tools (external, load-bearing)

All defined in `tools.ts:536-746`. Every tool is **read-only**
(`READ_ONLY_ANNOTATIONS`, `tools.ts:520-525`: `readOnlyHint:true`,
`destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`) — Cursor
Ask mode refuses any MCP tool lacking `readOnlyHint:true` (#1018). Every tool
accepts optional `projectPath` (`tools.ts:504-507`). Output is always
`{ content: [{ type:'text', text }], isError?: boolean }` (`tools.ts:493-499`).

| Tool | Purpose (one line) | Input params | Output shape |
|---|---|---|---|
| **`codegraph_explore`** | **PRIMARY.** NL question OR bag of symbol/file names → verbatim source grouped by file + call path among them + blast-radius, one capped call. | `query`* (str), `maxFiles` (num, def 12), `projectPath` | Large markdown: per-file line-numbered source sections (`**\`path\`**` headers, `<n>\t<line>` body), Relationships section, "additional relevant files", completeness/budget notes. Size-tiered budget (`getExploreOutputBudget`, `tools.ts:192-290`; ≤~24K chars). |
| **`codegraph_search`** | Quick symbol search by name; locations only, no code. | `query`* (str), `kind` (enum: function\|method\|class\|interface\|type\|variable\|route\|component), `limit` (num, def 10), `projectPath` | Text list of matches (name, kind, `file:line`); generated files down-ranked. |
| **`codegraph_node`** | Two modes: (1) **read a file** like `Read` (`file` alone → numbered source + dependents); (2) one symbol's location/signature/source/trail. | `symbol` (str), `includeCode` (bool, def false), `file` (str), `offset` (num), `limit` (num), `symbolsOnly` (bool, def false), `line` (num), `projectPath`. **required: none** | File mode: `<n>\t<line>` source (offset/limit like Read, 2000-line cap) + dependents note. Symbol mode: signature + body + caller/callee trail; ambiguous name → every matching def. Container kinds → structural outline. |
| **`codegraph_callers`** | Functions that call `<symbol>`. | `symbol`* (str), `file` (disambiguate), `limit` (num, def 20), `projectPath` | Text list of callers. |
| **`codegraph_callees`** | Functions that `<symbol>` calls. | `symbol`* (str), `file`, `limit` (num, def 20), `projectPath` | Text list of callees. |
| **`codegraph_impact`** | Symbols affected by changing `<symbol>` (pre-refactor). | `symbol`* (str), `file`, `depth` (num, def 2), `projectPath` | Text impact set. |
| **`codegraph_files`** | Indexed file tree + language/symbol counts. | `path` (dir filter), `pattern` (glob), `format` (enum tree\|flat\|grouped, def tree), `includeMetadata` (bool, def true), `maxDepth` (num), `projectPath` | Formatted file tree / list / grouped. |
| **`codegraph_status`** | Index health (files/nodes/edges/db size/backend/journal/pending/degraded). | `projectPath` | Markdown status block (`handleStatus`, `tools.ts:4031-4150`). |

(`*` = required.)

### 3.2 Tool-surface gating rules (must reproduce — pinned by tests)

- **Default surface = `codegraph_explore` ALONE** (`DEFAULT_MCP_TOOLS =
  {'explore'}`, `tools.ts:804`). The other 7 stay fully executable but are
  **not listed** to agents. Pinned: `mcp-tool-allowlist.test.ts:20-27`.
- **Allowlist override**: `CODEGRAPH_MCP_TOOLS` (comma-sep short or
  `codegraph_`-prefixed names) *replaces* the default surface and is enforced
  again on `execute()` (defense in depth, `tools.ts:1371-1373`). Pinned:
  `mcp-tool-allowlist.test.ts:29-62`.
- **Annotations survive every transform** — master array, `getStaticTools()`,
  `getTools()` (explore's description is rebuilt), `withRequiredProjectPath()`
  (schema clone). Pinned: `mcp-tool-annotations.test.ts`.
- **No default project → `projectPath` becomes `required`** in every exposed
  schema (`withRequiredProjectPath`, `tools.ts:766-776`) — a high-salience nudge
  (#993). Must **clone**, never mutate the shared array. Pinned:
  `mcp-require-project-path.test.ts`.
- **Tiny-repo gating**: <500 indexed files → only `{explore, search, node}`
  (`tools.ts:997-1005`).
- **Dynamic explore-budget suffix**: explore's description gains "Budget: make at
  most N calls (M files indexed)" scaled to project size (`getExploreBudget`,
  `tools.ts:1007-1015`).

### 3.3 Error-classification contract (must reproduce exactly — behavioral)

- `NotIndexedError` → **SUCCESS-shaped guidance** (`textResult`, no `isError`):
  an early `isError` teaches session-long abandonment of the whole toolset
  (`tools.ts:35-46, 1421-1427`). Covers "no default project", "path not indexed".
- `PathRefusalError` → **hard `isError`, no retry text** (sensitive path, e.g.
  `/etc`) — abandoning that path is the desired reaction (`tools.ts:48-52,
  1428-1431`). Pinned: `mcp-unindexed.test.ts:191-235`.
- Internal error → `isError` **with** "retry once, else continue without
  codegraph" (`tools.ts:1432-1436`).

### 3.4 Cross-cutting response notices (must reproduce)

Applied to successful read results in `execute()` (`tools.ts:1416-1420`):

- **Per-file staleness banner** (`formatStaleBanner`, `tools.ts:389-403`):
  `⚠️ Some files referenced below were edited since the last index sync…` —
  intersect the response text against the watcher's pending set (#403).
- **Whole-index degraded banner** (`formatDegradedBanner`, `tools.ts:433-440`):
  `⚠️ CodeGraph auto-sync is DISABLED…` when live watching stopped (#876).
- **Worktree-mismatch notice** (`worktreeMismatchNotice`, `tools.ts:1234-1245`):
  index belongs to a different git worktree than the caller (#155).
- **Catch-up gate** (`tools.ts:1364-1368`): first `execute()` awaits the engine's
  post-open reconcile, time-boxed (`CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS`).

The server-instructions text (`server-instructions.ts`) — the "one tool,
explore, use it instead of Read" playbook surfaced in the agent's system prompt —
must be reproduced as **data** (see §6.4 for where).

### 3.5 Internal contracts (consumed, resolved by the query/storage layers)

The `ToolHandler` consumes a `CodeGraph` facade: `open`/`openSync`,
`searchNodes`, `getStats`, `getProjectRoot`, `getPendingFiles`,
`isWatcherDegraded`, `reopenIfReplaced`, `watch`, `sync`, `close`, plus the
graph/context queries the handlers call. **That facade is the query/storage
analysts' scope** — this document depends on it but does not define it.

---

## 4. External dependencies → C# mapping

| CodeGraph dep / Node API | Used for | C# / .NET mapping | AOT? |
|---|---|---|---|
| `readline`, `process.stdin/stdout` (`transport.ts`) | stdio JSON-RPC framing | **DROP** — worker uses `MessagePackFrameProtocol` over pipe/socket | n/a |
| `net` (Unix socket / named pipe) (`daemon.ts`, `proxy.ts`) | daemon socket + proxy pipe | **DROP** — `LocalIpcWorkerServer` already owns the transport | ✅ (already in worker) |
| `child_process.spawn` (detached daemon, liveness child) (`index.ts`, `liveness-watchdog.ts`) | spawn daemon / watchdog child | **DROP** — no second process | n/a |
| `worker_threads` (`query-pool.ts`, `query-worker.ts`) | parallel read dispatch | **DROP** — worker dispatches each request as a `Task`; use a small read-only `SqliteConnection` pool for concurrent readers | ✅ |
| `fs` lock/pidfile/registry (`daemon.ts`, `daemon-registry.ts`) | O_EXCL lock, discovery | **DROP** — single owner, no arbitration | n/a |
| `process.kill(pid,0)`, `process.ppid` (`ppid-watchdog.ts`) | parent-death detection | **REPLACE** — worker exit-on-disconnect + `NativeWorkerManager` supervision | ✅ |
| `crypto.createHash('sha256')` (`daemon-paths.ts`, `daemon-registry.ts`) | project-hash socket/record names | **DROP** (no daemon socket). If any hashing survives: `System.Security.Cryptography.SHA256` | ✅ |
| `os.tmpdir`, `os.homedir`, `os.cpus` | fallback paths, pool sizing | `Path.GetTempPath()`, `Environment.SpecialFolder.UserProfile`, `Environment.ProcessorCount` | ✅ |
| JSON-RPC 2.0 request/response/notify semantics | protocol | **REPLACE** — `WorkerDispatcher` (dotted methods, `WorkerResponse`) is the equivalent semantic layer | ✅ |
| JSON schema objects (`ToolDefinition.inputSchema`) | `tools/list` payloads | Source-gen `JsonSerializerContext` DTOs; register every tool-def DTO. `inputSchema` is a fixed object graph — trivially source-gennable | ⚠️ **must be source-gen** (`JsonSerializerIsReflectionEnabledByDefault=false`) |
| `require()`/lazy module load (`engine.ts:26`, `tools.ts:15`) | defer heavy chain off startup | **N/A** — no cold-start handshake to protect; open the engine lazily on first tool call with a plain `Lazy<T>`/gate | ✅ |
| regex over source bodies (`dynamic-boundaries.ts`) | dynamic-dispatch boundary detection | `System.Text.RegularExpressions` — **prefer `RegexOptions.NonBacktracking` or `[GeneratedRegex]`** for AOT + ReDoS safety | ⚠️ see §5 |
| `package.json` version read (`version.ts`) | daemon/proxy version rendezvous | **DROP** — no cross-process version handshake | n/a |
| `@clack/prompts` `select` (`daemon-manager.ts`) | interactive daemon stop CLI | **DROP** — CLI-only UX, no analog in OpenCowork | n/a |

**Net AOT surface for this subsystem:** only two real items — (a) source-gen all
tool-definition + tool-result DTOs, and (b) AOT-safe regex for boundary
detection. Everything else is dropped or already provided by the worker.

---

## 5. Porting challenges & risks (ranked)

1. **Concurrency correctness of the shared engine under the worker's real
   parallelism (MEDIUM-HIGH).** In Node the daemon's single event loop
   *serialized* everything; the query pool was bolted on to regain parallelism
   *safely* (each worker its own WAL read connection). The C# worker dispatches
   requests **truly in parallel from day one**, so the engine must be built
   concurrency-correct *up front*: one shared **writer** (watcher/sync) + a pool
   of **read-only** connections, WAL enabled, `busy_timeout` set (mirror
   `DbConnectionFactory`). Getting this wrong resurfaces the "database is locked"
   class (#238) that CodeGraph itself hit. This is the one place the *simpler*
   design demands *more* upfront care than a naive port.
2. **`inputSchema` under source-gen JSON (MEDIUM).** With
   `JsonSerializerIsReflectionEnabledByDefault=false`, every tool-definition and
   tool-result DTO must be in a `JsonSerializerContext`. The schemas are static
   objects, so this is mechanical — but the **annotations/allowlist/tiny-repo/
   require-projectPath transforms** (§3.2) each produce a variant that must also
   serialize. Model tool defs as immutable records and apply transforms by
   constructing new records, not mutating shared state (the purity the tests
   demand).
3. **ReDoS + AOT in `dynamic-boundaries.ts` (MEDIUM).** ~15 hand-tuned regexes
   run over arbitrary source bodies (capped at 60K chars, `tools.ts` /
   `dynamic-boundaries.ts:223`). .NET's backtracking engine can catastrophically
   blow up on adversarial input; use `RegexOptions.NonBacktracking` or
   `[GeneratedRegex]` (compile-time, AOT-friendly). Also port the
   comment/string-stripping (`stripCommentsForRegex`, `blankStringContents`) that
   prevents false fires — a research spike to validate C# regex parity with the
   JS patterns across all languages. **Note:** this file is really an
   *explore-feature*, not lifecycle — coordinate with the query-engine analyst
   (§8).
4. **Reproducing the exact "no-error-on-expected-condition" behavior (MEDIUM).**
   The `NotIndexed → success-shaped`, `PathRefusal → hard error` split is
   *behavioral*, not cosmetic — it's what keeps agents from abandoning the
   toolset. Easy to get subtly wrong when refactoring dispatch into C#. Port the
   classification and its tests (`mcp-unindexed.test.ts`) together.
5. **Catch-up gate + watcher lifecycle in a shared singleton (MEDIUM).** The gate
   (`first call blocks on post-open reconcile, time-boxed`) and the degraded/
   staleness banners depend on a **watched main instance**. In C# these live in a
   singleton engine service; the "first call" gate must be per-project-open, not
   per-process, and must be thread-safe under concurrent first calls.
6. **Multi-project (`projectPath`) connection cache (LOW-MEDIUM).** `ToolHandler`
   caches opened `CodeGraph` by *resolved root* (`tools.ts:1096-1104`),
   re-resolves the nearest `.codegraph/` each call (worktree correctness, #926),
   and self-heals a replaced inode (`reopenIfReplaced`, #925). Reproduce as a
   `ConcurrentDictionary<string, CodeGraphHandle>` with the same
   resolve-every-call, cache-by-root discipline.
7. **FTS5 availability (LOW, but a hard dependency — cross-cutting).**
   `codegraph_search` and explore rely on FTS5. The brief flags that the storage
   doc must confirm `SQLitePCLRaw.bundle_e_sqlite3` ships FTS5. **If it doesn't,
   the search path breaks.** Flag to the storage analyst; not resolvable here.
8. **Losing the standalone CLI daemon UX (LOW / by design).** `codegraph list`,
   `codegraph stop --all`, `codegraph daemon` (registry + manager) disappear.
   Acceptable — OpenCowork users manage the worker via the app, not a CLI. Call
   it out so no one tries to port it.

---

## 6. Recommended C# design

### 6.0 One-line shape

**One worker module (`CodeGraphModule`) registering ~8 `codegraph/*` RPC methods,
backed by a shared singleton `CodeGraphEngine`, a `CodeGraphToolHandler`
(validation/gating/dispatch/notices), and static tool-definition metadata.** The
entire daemon/proxy/transport/session/watchdog/pool stack is **not ported**.

### 6.1 Module boundary & namespaces

```
Modules/CodeGraph/                         namespace OpenCowork.Native.Worker.Modules.CodeGraph
  CodeGraphModule.cs        // IWorkerModule — registers codegraph/* methods
  CodeGraphToolHandler.cs   // validation, allowlist, dispatch, error classification, notices
  CodeGraphToolDefs.cs      // the 8 ToolDefinition records + annotations + surface gating
  CodeGraphEngine.cs        // shared singleton: DB handle(s) + watcher + lazy init + catch-up gate
  CodeGraphExploreTools.cs  // handleExplore + dynamic-boundaries port  (query-engine-owned logic)
  CodeGraphReadTools.cs     // handleNode/search/callers/callees/impact/files/status
  CodeGraphModels.cs        // source-gen DTOs (ToolDefinition, ToolResult, StatusResult, …)
  CodeGraphInstructions.cs  // SERVER_INSTRUCTIONS text as a const (see §6.4)
```

Register in `Hosting/WorkerModuleCatalog.cs` alongside the existing modules. The
`CodeGraph` **graph database is a separate file** (e.g.
`<project>/.codegraph/graph.db` or a per-project file under `~/.open-cowork/`),
opened via a factory mirroring `DbConnectionFactory` (WAL, busy_timeout,
`Batteries_V2.Init`) but **distinct from `data.db`** — do not co-mingle with
OpenCowork's app DB.

### 6.2 RPC surface (replaces the MCP `tools/call` layer)

```
codegraph/tools-list      -> ToolDefinition[]  (honors allowlist/gating/require-projectPath)
codegraph/explore         -> ToolResult
codegraph/search          -> ToolResult
codegraph/node            -> ToolResult
codegraph/callers         -> ToolResult
codegraph/callees         -> ToolResult
codegraph/impact          -> ToolResult
codegraph/files           -> ToolResult
codegraph/status          -> ToolResult
codegraph/instructions    -> { instructions: string }  (indexed vs no-root variant)
```

Each `codegraph/<tool>` handler is a thin adapter: parse `JsonElement args` →
call `CodeGraphToolHandler.ExecuteAsync(name, args, ct)` → return
`WorkerResponse.Json(result, ctx.ToolResult)`. **The dispatcher's per-request
`Task` gives free concurrency; no query pool.** Index/sync progress can stream via
`WorkerRequestContext.EmitEventAsync` if desired.

### 6.3 `CodeGraphEngine` — the reproduced core (from `engine.ts`)

A singleton service (constructed once in the module, or a static held by the
module) that reproduces the *ideas* of `MCPEngine`, minus multi-session/pool:

- Lazy, thread-safe open per project root (`SemaphoreSlim`-guarded, mirrors the
  `initPromise` dedupe so concurrent first-callers open once).
- One **writer** connection + watcher (`FileSystemWatcher` or the existing
  `Modules/Sync` file-change tracking — **reuse, don't reinvent**, see §8) with
  debounced sync.
- A **read-connection pool** for concurrent tool reads (WAL).
- **Catch-up gate**: a `Task` per project-open that the first tool call awaits
  (time-boxed); reproduce `awaitCatchUpGate` (`tools.ts:879-905`).
- `getPendingFiles` / `isWatcherDegraded` surfaced for the banners.
- Multi-project cache keyed by resolved root
  (`ConcurrentDictionary<string, CodeGraphHandle>`).

### 6.4 Surfacing the tools to the agent — **recommended: Option A**

Three options; recommendation first.

- **(A) RECOMMENDED — In-process worker RPC + renderer tool definitions.**
  Register `codegraph/*` methods in the worker (above). In the renderer, register
  the 8 (well, 1-by-default) tool **definitions** into `toolRegistry` with
  execution routed to the worker via `getNativeWorker().request('codegraph/…',
  args)` — the *identical* pattern OpenCowork uses for every worker-backed tool
  and for `mcp__*` tools ("definitions only; execution owned by the worker",
  `src/renderer/src/lib/mcp/mcp-tools.ts:51-53`). The
  `SERVER_INSTRUCTIONS` playbook becomes either the explore tool's description or
  session/mode instructions text. **No MCP protocol, no stdio, no JSON-RPC
  handshake, no daemon, no version rendezvous** — all of `transport/session/
  startup-handshake/version/proxy/index` is simply never written. Native,
  minimal, and it inherits OpenCowork's approval + streaming plumbing for free.
- **(B) In-process MCP server hosted by the worker.** The worker speaks MCP
  JSON-RPC over a socket; OpenCowork's `McpManager` attaches to it as an
  "external" server (an `mcp-servers.json` entry). This **re-implements
  `transport.ts` + `session.ts` + the whole handshake** to bridge a channel the
  worker *already has* to the main process. Pure overhead; the only upside is
  wire-compatibility with non-OpenCowork MCP hosts, which is a non-goal. Reject.
- **(C) External `codegraph serve --mcp` process the worker spawns.** Reintroduces
  a Node/second process — **directly violates the "complete C# rewrite, no
  Node" mission.** Reject.

**Recommendation: (A).** It is the only option consistent with both the mission
(no Node/no MCP runtime shipped) and OpenCowork's existing tool-surfacing
architecture. The MCP *protocol* was CodeGraph's way to plug a standalone binary
into arbitrary agent hosts; inside OpenCowork the worker is the host's own
sidecar, so the protocol layer is pure ceremony.

### 6.5 The reproduce / replace / drop ledger (per file)

| File | LOC | Verdict | Justification |
|---|---:|:--:|---|
| `tools.ts` (defs + dispatch) | 4,685 | **REPRODUCE** | The external contract + dispatch/gating/validation/notices. (Handler *business logic* is query-engine scope.) |
| `dynamic-boundaries.ts` | 398 | **REPRODUCE** | Explore-time dynamic-dispatch boundary detection — a feature, not infra. |
| `server-instructions.ts` | 103 | **REPRODUCE** (as data) | Agent playbook; surface as tool/mode instructions. |
| `engine.ts` | 334 | **REPRODUCE** (core) / drop pool plumbing | Shared engine idea (one DB+watcher+lazy init+catch-up gate) is exactly right; multi-session/queryPool wiring drops. |
| `session.ts` | 350 | **REPLACE** (mostly drop) | `tools/call` dispatch + input validation → RPC handlers; `initialize`/`roots`/handshake → dropped (worker IPC replaces it). |
| `transport.ts` | 436 | **REPLACE** | `MessagePackFrameProtocol` + `WorkerDispatcher` already are the transport + JSON-RPC semantics. |
| `index.ts` | 489 | **DROP** | Direct/proxy/daemon mode selection collapses to "the worker module." |
| `daemon.ts` | 867 | **DROP** | Socket server, O_EXCL lock, refcount, idle timeout, phantom-reaping — all "shared detached process" concerns the worker already owns. |
| `proxy.ts` | 596 | **DROP** | stdio↔socket pipe + local handshake — the worker IS the pipe. |
| `query-pool.ts` | 326 | **DROP** | Parallelizes reads around Node's single event loop; the worker dispatches per-request `Task`s natively. |
| `query-worker.ts` | 103 | **DROP** | Worker-thread body — no analog needed. |
| `liveness-watchdog.ts` | 242 | **DROP** | SIGKILL-self on main-thread wedge; .NET CPU work is off-thread, no single-loop wedge. Rely on per-request `CancellationToken` + main-process timeout. |
| `ppid-watchdog.ts` | 95 | **REPLACE** | Parent-death reaping → worker exit-on-disconnect + `NativeWorkerManager`. |
| `early-ppid.ts` | 25 | **DROP** | Earliest-PPID capture — moot without a PPID watchdog. |
| `startup-handshake.ts` | 71 | **DROP** | Orphan-if-no-traffic backstop → worker's `FirstClientAcceptTimeout` (2 min). |
| `stdin-teardown.ts` | 46 | **DROP** | stdin-error-as-shutdown → worker socket read-loop already breaks + cancels on disconnect. |
| `daemon-registry.ts` | 199 | **DROP** | `~/.codegraph/daemons/` discovery for `list`/`stop --all` — no multiple daemons. |
| `daemon-paths.ts` | 140 | **DROP** | Daemon socket/pidfile path helpers — no daemon socket. |
| `daemon-manager.ts` | 117 | **DROP** | Interactive `codegraph daemon` CLI picker. |
| `version.ts` | 36 | **DROP** | Daemon/proxy version rendezvous — no cross-process handshake. |

**Tally: 12 drop, 4 replace (2 fully subsumed by worker infra, 2 partial),
4 reproduce.** ~3,500 of the ~9,658 LOC is daemon/proxy/pool/watchdog/registry
machinery that evaporates. What remains to *write* is the tool contract + engine
core + boundary detection — and much of that is query/storage-layer business
logic owned by other analysts.

---

## 7. MVP vs later

**MVP (first working slice):**

1. `CodeGraphEngine` singleton: open a project's `.codegraph/graph.db` (WAL,
   read-pool + single writer), lazy thread-safe init, catch-up sync gate.
2. `CodeGraphToolDefs` for **`codegraph_explore` only** (the default surface),
   with read-only annotations, source-gen serialized.
3. `codegraph/tools-list` + `codegraph/explore` RPC methods; `explore` handler
   (depends on the query-engine port landing `handleExplore`).
4. Renderer: register the `codegraph_explore` definition, route execution to the
   worker (Option A).
5. Error classification (`NotIndexed → success-shaped`, `PathRefusal → hard`) +
   the per-file staleness banner.
6. `codegraph/instructions` returning the indexed vs no-root text.

That yields the *entire default agent experience* — one tool, "explore instead of
Read" — with none of the daemon stack.

**Later:**

- The other 7 tools (`search/node/callers/callees/impact/files/status`) + the
  `CODEGRAPH_MCP_TOOLS` allowlist, tiny-repo gating, `require-projectPath`
  transform, dynamic explore-budget suffix.
- `dynamic-boundaries` port for explore (coordinate with query-engine analyst).
- Multi-project (`projectPath`) connection cache with re-resolve + self-heal.
- Whole-index degraded + worktree-mismatch notices.
- Streaming index/sync progress via `EmitMessagePackEventAsync`.
- Config surface: map the useful env knobs (`CODEGRAPH_MCP_TOOLS`,
  `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS`, `CODEGRAPH_WATCH_DEBOUNCE_MS`,
  `CODEGRAPH_EXPLORE_LINENUMS`, `CODEGRAPH_ADAPTIVE_EXPLORE`) to OpenCowork
  settings; **drop** all daemon/pool/watchdog/ppid env vars.

---

## 8. Open questions / decisions for the architect

1. **Is Option A (worker RPC + renderer definitions) the sanctioned surfacing
   path?** This document strongly recommends it and it matches OpenCowork's
   existing `mcp__*` pattern — but it's a cross-cutting product decision (does
   CodeGraph appear as a first-class built-in tool set, or masquerade as an
   `mcp-servers.json` entry?). Recommend: first-class built-in. **Lead to
   confirm.**
2. **Where does the graph DB live, and who owns its lifecycle?** Per-project
   `<root>/.codegraph/graph.db` (CodeGraph's convention, survives across app
   restarts, shareable with a future standalone) vs centralized under
   `~/.open-cowork/`? And does the **worker** own indexing/watching, or does the
   Electron main trigger sync on project events? Affects §6.3 and the sync/watch
   analyst.
3. **FTS5 in `SQLitePCLRaw.bundle_e_sqlite3` — confirmed?** Hard dependency for
   `search`/`explore`. The storage doc must verify; if absent, we need a bundle
   with FTS5 or a fallback. **Blocking for search.** (Owned by storage analyst,
   surfaced here.)
4. **Concurrency model for the shared engine.** Single writer + read-pool is
   recommended (§5.1). Confirm the storage layer will expose read-only
   connections and that WAL is viable on the target FS set (the same
   network/virtualized-mount caveats CodeGraph's `status` reports). Cross-cuts
   the storage analyst.
5. **Watcher reuse.** Should `CodeGraphEngine` reuse `Modules/Sync/SyncFileStore`
   / `Modules/File` change-tracking rather than a fresh `FileSystemWatcher`?
   Likely yes (avoid two watch sets on the same tree). Cross-cuts the sync
   analyst.
6. **`dynamic-boundaries.ts` ownership.** It physically lives in `src/mcp/` but is
   an explore *feature* depending on `stripCommentsForRegex` (resolution layer).
   Decide whether the MCP-module port or the query-engine port owns it (this doc
   assumes shared, MCP-module-hosted, query-engine-reviewed).
7. **Do we keep any operability equivalent of `codegraph status`/CLI?** The CLI
   daemon commands drop, but users may still want an index health view — likely
   the existing `codegraph_status` tool + OpenCowork UI suffices. Confirm no
   external tooling depends on the dropped `codegraph list`/`stop`.
8. **Cancellation semantics.** CodeGraph relied on the query pool's soft-timeout
   "busy, retry" backstop; OpenCowork has per-request `CancellationToken` + a
   main-process request timeout. Confirm a long explore under load returns a
   graceful result rather than a hard timeout — decide whether to port the
   success-shaped "busy" guidance or rely on the worker's timeout envelope.
