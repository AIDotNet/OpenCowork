# 04 — Process Model & Enablement (opt-in standalone sidecar)

> **Status: supersedes Decision 8 of [`00-overview-and-roadmap.md`](../00-overview-and-roadmap.md).**
> The original plan embedded CodeGraph as a `Modules/CodeGraph/` module *inside* the
> existing `OpenCowork.Native.Worker`. This document changes that to a **dedicated,
> opt-in, second sidecar process**, shipped as a built-in plugin that is **disabled
> by default** and spawned only when the user enables it. The engine code is
> unchanged; only its *host* and *lifecycle* change.

---

## 1. Decision & rationale

**Decision.** Build the CodeGraph engine as a **class library**
(`OpenCowork.CodeGraph.Core`) and host it in its **own AOT-compiled sidecar
process** (`OpenCowork.CodeGraph.Worker`) that the Electron main process spawns
**only when the CodeGraph feature is enabled**. When disabled (the default), the
process is never started, its tools are not registered, and its native grammar
libraries are never loaded.

This is fully within the mission — it introduces **no Node.js/TypeScript**; it is a
second *C# AOT* binary. (analysis/04 rejected only *Option C = re-spawning the Node
CodeGraph*, which would reintroduce Node. A C# sidecar is Option A hosted
out-of-process.)

**Why standalone beats embedded here — five reasons, one of them decisive:**

1. **Neutralizes the #1 risk (R1, heartbeat starvation).** In the embedded design, a
   full-core index can saturate the shared worker's thread-pool, delay the
   `worker/ping` continuation past the 15 s / 5 s×2 window, and get the **whole
   worker SIGKILLed — taking the agent runtime, DB, and SSH down with it**
   (`native-worker.ts:21-23`, `:571 closeWorker`, `:675 startHeartbeat`). Out of
   process, CodeGraph's CPU load lives in its own address space and **cannot delay
   the main worker's heartbeat**. If the CodeGraph worker itself is killed mid-index,
   the supervisor respawns *only it*, and indexing resumes from the persisted
   checkpoint (00 Decision 15). R1 drops from "highest-risk, must mitigate with
   dedicated threads" to "isolated and recoverable."
2. **Fault isolation.** A tree-sitter native segfault (bad grammar, ABI mismatch,
   pathological input) crashes **only** the CodeGraph process — not the agent loop.
3. **Zero cost when disabled.** No process spawned; the ~1 MB `libtree-sitter` + the
   several-MB-per-RID grammar libs ship with the **CodeGraph** binary's `resources/`
   (or as an optional download), so the **main worker stays lean** for the majority
   of users who never enable code-graphing.
4. **Independent resource governance.** The CodeGraph process can be given its own
   thread cap, memory ceiling, and a **looser/indexing-aware heartbeat policy** —
   without ever starving the agent loop.
5. **Matches the existing plugin/enable pattern.** OpenCowork already
   registers/unregisters tools dynamically from settings (WebSearch, Browser, Wiki —
   see `CLAUDE.md` / `registerAllTools` in `src/renderer/src/lib/tools/index.ts`).
   "Enable → `codegraph_explore` appears; disable → it's gone" is that exact pattern.

**Cost (honest).** One more supervised process lifecycle and one more binary to
build/sign/package. Both are **bounded** because the transport/dispatch/lifecycle
machinery is already written and reusable (below). The lost "in-process agent tool
call" (analysis/06 §2) is negligible — every other MCP tool already takes an IPC hop.

**Bonus.** Structuring the engine as a **library** is *already required* for the
xUnit test project (workstreams/B — the worker is a single reflection-off AOT Exe
today, so tests need a lib+Exe split). So "library-ize the engine" costs nothing
extra here and simultaneously enables standalone hosting **and** testing.

---

## 2. Component topology

```
┌──────────────────────────── Electron main ────────────────────────────┐
│ NativeWorkerManager (main worker)      ← existing, unchanged, eager     │
│ CodeGraphWorkerManager (2nd instance)  ← NEW, lazy: spawned on ENABLE   │
│ settings: codegraph.enabled=false (default)                            │
│ tool router: method prefix "codegraph/" → CodeGraph worker; else main  │
└───────────┬───────────────────────────────────┬───────────────────────┘
            │ MessagePack frame IPC              │ MessagePack frame IPC
            ▼                                     ▼ (only when enabled)
┌───────────────────────────┐   ┌────────────────────────────────────────┐
│ OpenCowork.Native.Worker  │   │ OpenCowork.CodeGraph.Worker (AOT Exe)   │
│ agent-runtime, db, ssh,…  │   │ Program.Main → WorkerHost               │
│ (CodeGraph NOT here)      │   │   catalog = { CodeGraphModule }         │
└───────────────────────────┘   │ references OpenCowork.CodeGraph.Core     │
                                 │ resources/: libtree-sitter + grammars    │
                                 │ graph DB: ~/.open-cowork/codegraph/…     │
                                 └────────────────────────────────────────┘
```

- **`OpenCowork.CodeGraph.Core`** — class library: the entire engine
  (extraction/resolution/graph/storage/context/search + `CodeGraphModule`). No
  `Program.Main`. This is where 00 §4's `Modules/CodeGraph/` tree actually lives.
- **`OpenCowork.CodeGraph.Worker`** — a thin AOT Exe: `Program.Main` parses
  `--ipc <endpoint>`, builds a `WorkerHost` whose module catalog contains **only**
  `CodeGraphModule`, and runs `LocalIpcWorkerServer`. Essentially a copy of the main
  worker's `Program.cs` with a one-module catalog.
- **The renderer is unchanged in shape:** it still holds tool *definitions* and
  routes execution to a worker (Option A). Only the *routing target* differs for
  `codegraph_*` tools.

---

## 3. The `NativeWorkerManager` parameterization (the real refactor)

> **⚙ C#-side prerequisite (found in the M0 spike, 2026-07-16).** The CodeGraph worker
> Exe hosts an `IWorkerModule` and thus needs the worker's **runtime + transport types**
> (`IWorkerModule`, `WorkerModuleContext`, `WorkerResponse`, `WorkerHostBuilder`,
> `LocalIpcWorkerServer`, the MessagePack transport, `Contracts/*`, `JsonHelpers`) — which
> today live *inside* `OpenCowork.Native.Worker`. Reuse (this doc's premise) requires
> **extracting a shared `OpenCowork.Worker.Runtime` class library** from the main worker's
> `Runtime/`+`Hosting/`+msgpack+`Contracts/`, referenced by BOTH workers. This is a
> bounded but real refactor of the (shipping) main worker and is the **first task of the
> IPC-host step**. M0 proved the *engine* (storage/FTS5/tree-sitter binding) builds and
> runs AOT with **no** runtime coupling (see milestones/M0 status); the module/host are
> written and staged in `_deferred/` pending this extraction. The TS parameterization
> below is the *other* half (main-process side).

Today `NativeWorkerManager` (`native-worker.ts:101`) is an **arg-less class**
(`constructor()` `:123`) exposed as a **module-level singleton** (`nativeWorker`
`:775`, `getNativeWorker()` `:777`). Everything worker-specific is hard-coded in
module functions: `resolveNativeWorkerPath()` (`:999`, finds the *one* binary name),
`createNativeWorkerEndpoint()` (`:850`), `createNativeWorkerEnv()` (`:915`),
`REQUIRED_NATIVE_WORKER_METHODS` (`:27`, the boot gate), and the heartbeat constants
(`:21-23`).

**Refactor: extract a per-worker config; keep two singletons.**

```ts
interface NativeWorkerConfig {
  id: 'native' | 'codegraph'         // label for logs, endpoints, env
  resolveBinaryPath(): string | null // per-binary resolver (name + readiness gate)
  requiredMethods: string[]          // boot gate; [] for codegraph (never blocks)
  heartbeat: { intervalMs; timeoutMs; maxMisses } // codegraph may run looser
  readinessNativeLibs: string[]      // codegraph checks libtree-sitter + core grammar
  lazy: boolean                      // codegraph: don't ensureStarted() until enabled
}
class NativeWorkerManager {
  constructor(private cfg: NativeWorkerConfig) { … }   // was arg-less
  // start()/spawn()/request()/heartbeat()/closeWorker()/reconnect() unchanged,
  // just read cfg instead of the module constants
}
let nativeWorker: NativeWorkerManager | null = null
export function getNativeWorker() {          // main worker — eager, unchanged behavior
  nativeWorker ??= new NativeWorkerManager(NATIVE_CONFIG); return nativeWorker }
let codeGraphWorker: NativeWorkerManager | null = null
export function getCodeGraphWorker() {       // NEW — lazy, spawned on enable
  codeGraphWorker ??= new NativeWorkerManager(CODEGRAPH_CONFIG); return codeGraphWorker }
export async function stopCodeGraphWorker() { … }  // mirror stopNativeWorker() (:782)
```

Scope of change, precisely:
- Parameterize the 4 module functions + the constructor to read `cfg` (mechanical).
- `resolveBinaryPath` for CodeGraph: look for `OpenCowork.CodeGraph.Worker` under the
  same `bin/…/<rid>/` + packaged `resources/` search path (`resolveNativeWorkerPath`
  `:999`, `getCurrentRid` `:1058`), and a readiness gate that checks for
  `libtree-sitter` + ≥1 grammar in `runtimes/<rid>/native/` (mirrors
  `isNativeWorkerCandidateReady` `:1065`, which today only checks the SQLite lib).
- **CodeGraph gets `requiredMethods: []`** so it never sits on a boot-time gate, and
  **`lazy: true`** so `ensureStarted()` fires on first `codegraph/*` request *after*
  the feature is enabled — never during app boot.
- Everything else — endpoint creation, `spawn(binary, ['--ipc', endpoint])` (`:289`),
  the `connectNativeWorker` handshake (`:800`), `request()` correlation, reconnect,
  `closeWorker` — is **reused verbatim**.

**Estimated size:** a focused refactor of `native-worker.ts` (parameterize ~5
symbols) + a second singleton + a small enable/disable controller + renderer routing.
No new transport, no new protocol.

---

## 4. Lifecycle & heartbeat for a compute-heavy isolated worker

Because CodeGraph is isolated, its supervision can be **more tolerant** than the main
worker's:

- **Looser heartbeat, or indexing-aware.** Option (a): give the CodeGraph worker a
  larger `timeoutMs`/`maxMisses`. Option (b, better): keep the strict ping but ensure
  the worker **answers `worker/ping` on a dedicated thread** while indexing runs on
  its own dedicated thread-pool (00 Decision 10) — cheap now that nothing else shares
  the process. Either way, a killed-mid-index CodeGraph worker is **recoverable**: the
  supervisor respawns it and indexing resumes from the DB checkpoint (Decision 15),
  with **no impact on the agent**.
- **Exit-on-disconnect** (`LocalIpcWorkerServer`) still applies — closing the app or
  disabling the feature drops the client and the worker exits.
- **`FirstClientAcceptTimeout`** (2 min) still guards an orphaned spawn.

---

## 5. Enablement state machine

```
        ┌───────────── DISABLED (default) ─────────────┐
        │  worker: not spawned · tools: unregistered   │
        │  grammar libs: NOT installed (download-on-enable) · worker not spawned
        └──────────────────────┬───────────────────────┘
                 user toggles codegraph.enabled = true
                                ▼
        ┌──────────────── DOWNLOADING ──────────────────┐
        │ fetch per-RID grammar pack → verify sha256 →   │
        │ extract to ~/.open-cowork/codegraph/grammars/  │
        │ <setVersion>/<rid>/ · progress surfaced         │
        │ fail → NEEDS-GRAMMARS (retry) · offline → error │
        └──────────────────────┬───────────────────────┘
                     grammars present + verified
                                ▼
        ┌───────────────── ENABLING ───────────────────┐
        │ main: getCodeGraphWorker().ensureStarted()    │
        │ renderer: register codegraph_explore definition│
        │ engine: open/lazy-init project graph DB, index │
        │ tool surface reports "indexing… (N files)"     │
        └──────────────────────┬───────────────────────┘
                     index complete / ready
                                ▼
        ┌───────────────── ENABLED ─────────────────────┐
        │ codegraph_explore live; execution → CG worker  │
        │ app fs:file-changed (debounced) → codegraph/sync│
        └──────────────────────┬───────────────────────┘
                 user toggles codegraph.enabled = false
                                ▼
        ┌───────────────── DISABLING ───────────────────┐
        │ renderer: unregister codegraph_* tools         │
        │ main: stopCodeGraphWorker() (client disconnect  │
        │        → worker exits) · keep the graph DB on   │
        │        disk (fast re-enable) or offer "clear"   │
        └──────────────────────  → DISABLED  ────────────┘
```

- **Settings key:** `codegraph.enabled` (default `false`), stored the same way as
  other feature toggles; the renderer's `registerAllTools()` path adds/removes the
  `codegraph_explore` definition on change (the WebSearch/Browser/Wiki mechanism).
- **Per-project vs global:** the toggle is global (the feature); indexing is
  per-project (the engine already caches engines by project root — analysis/04 §6.6,
  analysis/05 §3.1). Enabling the feature doesn't force-index every project — index
  on first use per project, or on an explicit "index this project" action.

---

## 6. Native packaging — **download-all-grammars-on-enable** (RATIFIED)

**Decision (§9.1 resolved): grammar libraries are downloaded on first enable, not
bundled.** The default install ships the smallest possible footprint; the
several-MB-per-RID grammar payload only lands on machines that turn CodeGraph on.

- **What ships in the installer:** the `OpenCowork.CodeGraph.Worker` AOT Exe plus the
  **`libtree-sitter` core (~1 MB, always needed, bundled)** so the worker is
  self-consistent offline (it simply has no *languages* until the pack arrives). The
  **grammar libs** (`libtree-sitter-<lang>.{dylib,so,dll}`) are **not** in the
  installer.
- **What's downloaded on enable:** a **per-RID grammar pack** —
  `codegraph-grammars-<setVersion>-<rid>.zip` — containing all grammar libs for that
  RID. "Download-all" = one pack fetch (not lazily per language). One pack per
  platform keeps the transfer to a single verified artifact.
- **Source & integrity (RESOLVED):** publish the packs as **GitHub Release assets on
  the same `AIDotNet/OpenCowork` releases the app's auto-updater already uses**
  (`electron-builder.yml` `publish.provider: github`) — the CI matrix `gh release
  upload`s them; zero new delivery infra. Alongside them a `manifest.json`
  (`{ setVersion, libtreeSitterVersion, grammarAbi, rid → {url, sha256, bytes} }`),
  fetched over **HTTPS from the pinned release URL**. The downloader picks the
  `getCurrentRid()` row, fetches, and **verifies each file's SHA-256 against the
  manifest before extract**. **This SHA-256 gate is the security boundary** — the app
  ships with macOS `com.apple.security.cs.disable-library-validation` + `notarize:
  false` (`build/entitlements.mac.plist`, `electron-builder.yml`), so downloaded
  unsigned native libs *load* without OS blocking, which makes the integrity check the
  only thing standing between the release and code loaded into the process. Do it
  rigorously (verify-before-extract, per-file, HTTPS-pinned manifest).
- **Code-signing follows the app's baseline (currently none).** Grammar dylibs do
  **not** need Developer-ID signing/notarization to load (library validation is
  already disabled). Signing them stricter than the app's own native libs would be
  inconsistent and unnecessary; if OpenCowork later adopts notarization + library
  validation app-wide, the grammar libs must be signed as part of *that* global change.
- **Cache location:** extract to
  `~/.open-cowork/codegraph/grammars/<setVersion>/<rid>/` — **outside** the app
  bundle, so it survives app auto-updates and is only re-fetched on a `setVersion`
  bump. (Same root the graph DBs live under — 00 Decision 3.)
- **Version pinning:** `setVersion` is tied to the extraction ABI + the pinned
  `libtree-sitter` version (reference/03 open question). The worker **refuses to load
  a pack whose `grammarAbi`/`libtreeSitterVersion` doesn't match the binary** →
  triggers a re-download of the correct set. This is what keeps AST-walk fidelity
  (R4) from silently drifting across app updates.
- **Readiness gate + lazy load:** the CodeGraph worker's readiness now checks the
  **cache dir** (not the binary's resources) for the expected pack; a
  partial/corrupt/absent pack keeps the worker in **NEEDS-GRAMMARS** (tools report
  success-shaped "not ready", never `isError`). Per-grammar lazy load (reference/03)
  still applies, so a single bad grammar disables only that one language.
- **Failure / offline:** a failed or offline download leaves the feature
  **NEEDS-GRAMMARS** with a retry action and a clear "requires a one-time download to
  enable" message — the app never half-enables. Re-enable after a successful download
  is instant (cache hit).
- **Disable/uninstall:** keep the cached pack for instant re-enable, and offer a
  "remove downloaded grammars (~N MB)" action to reclaim space.

**WS-A impact (updated):** the grammar build matrix now **publishes per-RID packs +
a SHA-256 `manifest.json` as release artifacts**, instead of copying grammar libs into the
worker's `dotnet publish` output. `libtree-sitter` core is still built per-RID and
**bundled** with the Worker binary. (workstreams/A carries a note pointing here.)

---

## 7. Tool routing (renderer / main)

- Renderer registers `codegraph_explore` (and later the other 7) as tool
  **definitions** whose execution calls, e.g.,
  `agentBridge.request('codegraph/explore', args)`.
- The main-process handler for the sidecar-request channel routes by method prefix:
  `method.startsWith('codegraph/')` → `getCodeGraphWorker().request(...)`; otherwise
  `getNativeWorker().request(...)`. (One small branch where today it always calls the
  single worker — analysis/06 §2.)
- If the feature is disabled and a `codegraph/*` call somehow arrives, the router
  returns the **`not_indexed → success-shaped`** guidance (reference/02 §error
  conventions) rather than an error — so a stale tool reference never poisons the
  agent session.

---

## 8. What this changes in the existing plan

| Doc | Change |
|---|---|
| **00 Decision 8** | "embed one module in the main worker" → **"engine library + opt-in standalone sidecar"** (this doc is the authority). |
| **00 §2 diagram** | Second sidecar box; renderer routes `codegraph/*` to it; `libtree-sitter` core bundled, grammar packs downloaded on enable. |
| **00 §8 R1** | Downgrade heartbeat-starvation from 🔴 High (app-wide SIGKILL) to 🟠 Med, **isolated to the CodeGraph process + recoverable**. Keep the dedicated-thread discipline so the CodeGraph worker's *own* ping survives. |
| **00 §4 layout** | The `Modules/CodeGraph/` tree lives in `OpenCowork.CodeGraph.Core`; add the thin `OpenCowork.CodeGraph.Worker` host project. |
| **M0** | Add: scaffold `OpenCowork.CodeGraph.Worker` (Program.Main + one-module catalog); prove the **second** worker spawns + a `codegraph/status` round-trips through `getCodeGraphWorker()`. The tree-sitter AOT spike now targets *this* binary. |
| **M5** | Add: the enable/disable controller + settings toggle + prefix routing + dynamic tool (un)registration + the **DOWNLOADING** step (fetch/verify/extract the per-RID grammar pack, NEEDS-GRAMMARS/retry states, §5–§6). Default disabled. |
| **workstreams/A** | Output is **per-RID grammar packs + SHA-256 manifest as GitHub Release assets** (download-on-enable, §6) — not copied into the publish output. `libtree-sitter` core still bundled. |
| **workstreams/B** | The lib+Exe split is now the *product* structure (Core lib), not just a test affordance — the test project references `OpenCowork.CodeGraph.Core` directly. |

---

## 9. Open decisions for the lead

1. ~~**Grammar delivery: bundle vs optional-download.**~~ **RESOLVED →
   download-all-grammars-on-enable** (smallest default install). Only `libtree-sitter`
   core is bundled; the per-RID grammar pack is fetched + verified on first enable.
   See §6 for the full design (source, integrity, cache, versioning, failure).
   **Sub-items RESOLVED:** (a) **asset host = GitHub Releases** (`AIDotNet/OpenCowork`)
   — the same channel the app's `electron-updater` already uses, so zero new infra;
   (b) **no code-signing of grammar libs** — the app already runs
   `disable-library-validation` + `notarize: false`, so downloaded unsigned libs load,
   and the **SHA-256 manifest is the integrity boundary** (must be rigorous). Residual
   ops note (shared with app auto-update, not grammar-specific): GitHub is unreliable
   in mainland China — if/when a CN mirror/CDN is added for app updates, grammar packs
   should ride the *same* mirror rather than a separate system.
2. **Heartbeat policy for the isolated worker** — strict-with-dedicated-thread
   (recommended) vs deliberately looser. Confirm the supervisor treats a CodeGraph
   respawn as routine (with checkpoint resume), not an error surfaced to the user.
3. **Where the in-worker agent runtime calls CodeGraph from.** The agent runtime
   lives in the *main* worker; a `codegraph_explore` tool call routes main → CG
   worker (via the renderer/main router, like any tool). Confirm we do **not** need
   the main worker to hold its own direct client to the CG worker (simpler to route
   through the existing tool path).
4. **Disable semantics for the graph DB** — keep on disk for instant re-enable
   (recommended) vs offer a "clear index" action. Storage lives under
   `~/.open-cowork/codegraph/` regardless (00 Decision 3).
5. **Auto-enable heuristics** — stay fully manual (default off, user flips it) vs
   offer a first-run prompt ("index this repo for faster agent navigation?").
   Recommendation: manual for v1; revisit after the MVP ships.
