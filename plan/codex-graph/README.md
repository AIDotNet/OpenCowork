# CodeGraph → C# Port Plan

A complete plan to rewrite the open-source
[**CodeGraph**](https://github.com/colbymchenry/codegraph) semantic
code-intelligence engine (TypeScript, ~72 kLOC) **entirely in C#**, as a new module
inside the **OpenCowork .NET 10 native worker** (`sidecars/OpenCowork.Native.Worker/`).
No Node.js, no TypeScript, no `web-tree-sitter` shipped to users.

> **How this plan was produced.** The CodeGraph repo (v1.4.1, MIT) was cloned and
> analyzed by **six parallel deep-analysis agents**, one per subsystem, each writing
> a self-contained design + porting analysis. This README and
> [`00-overview-and-roadmap.md`](00-overview-and-roadmap.md) are the lead-architect
> synthesis on top of them.

---

> **⚠ Architecture revision 2 (user decision, 2026-07-16): SOURCE-MERGED SINGLE WORKER.**
> CodeGraph no longer runs as a separate opt-in sidecar — `OpenCowork.CodeGraph.Core`
> is source-compiled INTO `OpenCowork.Native.Worker` (one binary, one shared
> `e_sqlite3`), and tree-sitter grammars are **bundled** (publish copies them to
> `resources/native-worker/grammars/`; dev uses the NuGet dir) — **no download step**.
> This supersedes reference/04's standalone-sidecar + download-on-enable model. The
> plugin toggle still gates tool registration + `codegraph/*` routing (default off).
> Trade-off accepted: index CPU shares the main worker's strict heartbeat process —
> parallel parsing therefore runs on dedicated threads, capped below ProcessorCount.

## ✅ Implementation status — PORT COMPLETE (application code)

The plan below has been **executed end to end**. The entire CodeGraph engine is ported,
builds clean, and is test-verified. New projects under `sidecars/`:

- **`OpenCowork.CodeGraph.Core`** — the engine: **~52k LOC C# across 177 files**.
- **`OpenCowork.CodeGraph.Worker`** — the opt-in AOT sidecar host.
- **`OpenCowork.Worker.Runtime`** — the shared worker runtime/transport source-linked
  from the main worker (main worker **unchanged**).

**Full coverage — matching (and exceeding) CodeGraph's surface:**
- **~34 languages / ~37 file formats** — 30 tree-sitter language configs (TS/TSX, JS/JSX,
  Python, Go, Java, C#, Rust, C, C++, PHP, Ruby, Scala, Swift, Kotlin, Dart, Obj-C,
  ArkTS, COBOL, VB.NET, Erlang, Nix, Terraform, Solidity, Luau, R, CFML, Pascal,
  **Bash, Haskell, Julia**) + Vue/Svelte/Astro/Razor (`<script>`/`@code`-delegation) +
  MyBatis/Liquid/DFM (regex).
- **27 framework resolvers** and **37 dynamic-edge synthesizers** (all 65 of CodeGraph's
  synthesis units — including the **full** C fn-pointer preprocessor: macro expansion,
  `#include` env, `#ifdef` evaluation).
- Storage + FTS5 graph, resolution (cross-file edges + framework/dynamic synthesis),
  value-refs + function-refs, extended module resolution (C/C++ `#include`, PHP/COBOL),
  facade + scanning + **full incremental sync** (content-hash change detection,
  orphan-sweep recovery, failed-ref retry), context ranking + search, the **front-load
  prompt hook**, **explore-time dynamic-boundary detection**, the **WAL checkpoint valve**
  (bulk-index throttle), the storage heuristics + graph analytics
  (dominant-file/routing-manifest/circular-deps/dead-code/node-metrics), the `codegraph/*`
  tool surface, and the opt-in TS enablement.

**Verification:** `dotnet test` = **288 passing, 0 failed**; the full worker
**AOT-publishes with 0 warnings / 0 errors** (8 MB self-contained native binary; FTS5 +
real-grammar parse confirmed for the bootstrap languages); `npm run typecheck` clean;
`global.json` pins SDK 10.0.301; the TS enablement (2nd worker manager, `codegraph/*`
routing, `codegraphEnabled` toggle default-off, `codegraph_explore` tool) is additive —
the main worker path is provably unchanged.

**The only non-code remainder: grammar BINARIES.** The niche languages' tree-sitter
grammars aren't in the NuGet bootstrap, so they're **downloaded on enable** (reference/04
§6, by design — never bundled) and built by **your** WS-A CI pipeline (the build path is
proven: a grammar compiles from source to a loadable ABI-14 dylib our `[LibraryImport]`
binding accepts; see `workstreams/A-grammar-build-matrix.md`). Two entrypoints
(terraform→`hcl`, vbnet) carry `// TODO verify` notes — one-line fixes when those
grammars are built. This is packaging/CI, not application code.

**Needs your runtime check** (no headless GUI in the build env): `npm run dev` + build
the worker (`dotnet build sidecars/OpenCowork.CodeGraph.Worker`) + enable the toggle +
confirm `codegraph_explore` works in-app.

**What's next:** the post-port continuation plan —
[`milestones/M7-continuation-roadmap.md`](milestones/M7-continuation-roadmap.md)
(W1 engine parity: deferred import-resolver branches, read pool, cross-process lock;
W2 upstream catch-up: tracking process, parallel resolution, fast-init, C++ operator
calls; W3 product surface: the other 7 tools, staleness surfacing, viz analytics).

---

## Read in this order

1. **This file** — the 3-minute version: what, the headline decisions, scope, effort.
2. **[`00-overview-and-roadmap.md`](00-overview-and-roadmap.md)** — the master plan:
   full Architecture Decision Record, module/file layout, the **M0–M6 phased
   roadmap** (goals · deliverables · acceptance criteria), cross-cutting workstreams,
   risk register, and the decisions a human must ratify.
3. **[`analysis/`](analysis/)** — the six subsystem deep-dives (file/line-level detail):

   | # | Doc | Scope |
   |---|---|---|
   | 01 | [extraction-tree-sitter](analysis/01-extraction-tree-sitter.md) | Parsing engine + **the C# tree-sitter strategy** (project's gating decision) |
   | 02 | [resolution-synthesizers](analysis/02-resolution-synthesizers.md) | Cross-file resolution + the **65 framework/dynamic-dispatch synthesizers** |
   | 03 | [storage-graph-datamodel](analysis/03-storage-graph-datamodel.md) | SQLite data model, query layer, graph traversal, **FTS5 verification** |
   | 04 | [mcp-daemon-lifecycle](analysis/04-mcp-daemon-lifecycle.md) | The 8 MCP tools + what daemon machinery **drops** |
   | 05 | [facade-sync-context-search-cli](analysis/05-facade-sync-context-search-cli.md) | Public facade API, scanning/ignore, sync, **context ranking**, CORE-vs-DROP |
   | 06 | [target-worker-integration](analysis/06-target-worker-integration.md) | The **C# worker integration contract** (the target conventions) |

4. **[`reference/`](reference/)** — day-one implementation specs (produced by a
   second agent batch from source ground-truth):

   | Doc | What it pins down |
   |---|---|
   | [01-data-model-and-schema](reference/01-data-model-and-schema.md) | The final folded SQLite DDL (paste-ready) + C# domain types (`NodeKind`×22, `EdgeKind`×12, `Language`×42) + node-id/hash formulas |
   | [02-rpc-api-contract](reference/02-rpc-api-contract.md) | The exact `codegraph/*` RPC surface — **18 methods + 2 events**, input/result DTOs, error conventions, renderer call examples |
   | [03-tree-sitter-binding](reference/03-tree-sitter-binding.md) | The `[LibraryImport]` P/Invoke spec — ~40 C functions, blittable structs, `[MarshalAs(U1)]` bool pitfall, compilable skeletons, AOT packaging |
   | [04-process-model-and-enablement](reference/04-process-model-and-enablement.md) | **Opt-in standalone sidecar** (`OpenCowork.CodeGraph.Worker`, disabled by default) — engine-as-library, the 2nd `NativeWorkerManager`, enable/disable state machine, tool routing. **Supersedes 00 Decision 8.** |
   | [05-incremental-sync-and-freshness](reference/05-incremental-sync-and-freshness.md) | How code updates are handled — the `codegraph/sync` algorithm: FS-reconcile change detection, incoming-edge resurrection (#899/#1240), failed-ref forward retry, orphan sweep, catch-up-on-enable, staleness/full-vs-incremental + the copy/simplify/drop ledger |

5. **[`workstreams/`](workstreams/)** — the two cross-cutting build/QA tracks:

   | Doc | What it plans |
   |---|---|
   | [A-grammar-build-matrix](workstreams/A-grammar-build-matrix.md) | 31 grammars (8 MVP / 23 later, 15 patched) × 6–8 RIDs, vendoring + Zig-cross CI + packaging endgames |
   | [B-golden-test-porting](workstreams/B-golden-test-porting.md) | 139 CodeGraph tests dispositioned per milestone (~60 port, ~49 drop) + the xUnit harness design |

6. **[`milestones/`](milestones/)** — the execution handbook:

   | Doc | Scope |
   |---|---|
   | [M0-foundations](milestones/M0-foundations.md) | The first milestone as a command-level, "Done-when"-gated checklist (module skeleton · graph DB · **tree-sitter AOT spike**) |
   | [M1-M6-breakdown](milestones/M1-M6-breakdown.md) | **53 MVP build tasks** across M1→M5 (+ M6 tail), each naming the exact `CodeGraph*` class + source analysis § + test gate |

> **Two prerequisites the reference docs surfaced** (do before/at M1): (a) stand up
> an `OpenCowork.Native.Worker.Tests` xUnit project — which needs a **lib+Exe split
> or `InternalsVisibleTo`**, since the worker is a single reflection-off AOT Exe
> today (WS-B); (b) **pin the exact `libtree-sitter` version** early — it fixes the
> ABI-accessor name and grammar-ABI range the whole binding depends on (reference/03).

---

## What CodeGraph does (and why it's worth porting)

It parses a repo with tree-sitter into a **knowledge graph** — `nodes` (functions,
classes, symbols) and `edges` (calls, imports, extends, plus *synthesized*
framework/dynamic-dispatch relationships) — stored in SQLite with FTS5. An agent
queries it (over MCP, effectively one tool `codegraph_explore`) to answer "how does
X reach Y / who calls this / what breaks if I change it" in a few fast graph calls
with **zero Read/Grep**. Measured value (README A/B): **~35% cost, 57% tokens, 46%
time, 71% tool-calls saved.** Its differentiator is **dynamic-dispatch coverage** —
synthesizers that statically bridge callbacks, React re-render, event buses, etc.,
so flows connect end-to-end where grep can't follow.

---

## Headline decisions (all resolved by the analyses)

| Question | Decision | Confidence |
|---|---|:--:|
| **Tree-sitter under NativeAOT** | Native `libtree-sitter` + C grammars via an own-authored **`[LibraryImport]`** binding. **No `.scm` query engine needed** — extraction is 100% manual AST walks. WASM/wasmtime rejected. | ✅ two agents converged |
| **FTS5 in `SQLitePCLRaw.bundle_e_sqlite3` 3.0.3** | **Present** — empirically verified by building & running a .NET 10 probe (SQLite 3.50.4, FTS5+bm25+JSON1). No fallback. | ✅ empirical |
| **Module shape** | One `Modules/CodeGraph/` `IWorkerModule`; `codegraph/*` RPC methods; global namespace + `CodeGraph*` class prefixes; dedicated `CodeGraphJsonContext`. | ✅ |
| **Graph DB** | A **separate** per-project SQLite file, **centralized** at `~/.open-cowork/codegraph/<sha256(root)>/graph.db` (not in-repo). Collapse the v2–v8 migration chain to one final schema. | ✅ |
| **Packaging / enablement** | **Opt-in standalone sidecar** (`OpenCowork.CodeGraph.Worker`), engine as a `Core` library, **disabled by default**, spawned only on enable — a built-in plugin. Isolates index CPU/faults from the agent runtime (neutralizes R1) + keeps the main worker lean. **Grammars downloaded on enable** (only `libtree-sitter` core bundled). *(reference/04, supersedes Decision 8)* | ✅ |
| **MCP surface** | **Option A**: `codegraph/*` RPC + renderer holds tool *definitions*, execution routed to the (CodeGraph) worker (OpenCowork's existing `mcp__*` pattern). No MCP protocol/stdio/Node. | ✅ |
| **Daemon / watcher / CLI / installer / updater / telemetry / UI** | **Dropped** (~20 kLOC) — the worker already is the daemon; the app already watches files, wires agents, updates itself, renders UI. Incremental sync becomes a `codegraph/sync` RPC driven by the app's file-change signal. | ✅ |
| **#1 risk** | **Heartbeat starvation**: a full-core index can miss the worker's 15 s / 5 s×2 `worker/ping` and get SIGKILLed. → parse on **dedicated threads**, cap parallelism. | 🔴 mitigated by design |

---

## Scope & effort at a glance

Of CodeGraph's ~72 kLOC TypeScript:

- **~20 kLOC dropped** (daemon/proxy/pool/watchdogs + CLI/installer/upgrade/telemetry/UI + own watcher) — subsumed or replaced by OpenCowork.
- **~52 kLOC of behavior-dense logic ported** — extraction AST walks, resolution/synthesis heuristics, context-ranking constants.
- **Plus new infrastructure** with no TS analogue: the `[LibraryImport]` tree-sitter binding and the **grammar build matrix** (~31 grammars × 6–8 RIDs), which is the single biggest new build-CI muscle.

**Roadmap:** the **MVP is M0–M5** — 8 languages, ~16 of 65 synthesis units, the full
context-ranking pipeline, and the `codegraph_explore` tool. That slice delivers the
bulk of CodeGraph's measured agent value. **Full language/framework parity (M6) is a
demand-driven long tail.** The two dominant cost-centers are **extraction AST-walk
fidelity** and **resolution/synthesizer breadth**; the two disciplines that keep the
port honest are **golden-test-first** (port CodeGraph's 140+ tests as the oracle)
and **AOT-clean interop/serialization**.

See [`00-overview-and-roadmap.md`](00-overview-and-roadmap.md) §5 for per-milestone
deliverables and acceptance criteria, §7 for the decisions awaiting a human, and §8
for the full risk register.

---

## Six things a human should decide before M2

(Full list in [`00-overview-and-roadmap.md`](00-overview-and-roadmap.md) §7.)

1. **Grammar build-matrix owner** + static-link vs loadable-libs packaging (gates the release pipeline).
2. **How much of the 65-synthesizer / 31-language tail ships v1** (which ecosystems matter to OpenCowork's users?).
3. **Front-load prompt hook — reproduce or drop?** (biggest scope lever; recommend drop for MVP).
4. **Context-ranking fidelity bar** — byte-for-byte-with-fixture-replay (recommended) vs "spirit-of".
5. **Graph DB location** — ratify centralized `~/.open-cowork/` (recommended).
6. **`git` on PATH** — assumed present (worker already shells git); confirm, or make FS-walk first-class.
