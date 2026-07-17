# M7 — Continuation Roadmap · engine parity, upstream catch-up, product surface

> **What this is.** The post-port continuation plan. The M1–M6 port is **complete**
> (application code): ~52k LOC across `OpenCowork.CodeGraph.Core`, 288 tests green,
> all 22 `codegraph/*` RPCs registered in the main worker
> (`sidecars/OpenCowork.Native.Worker/Hosting/WorkerModuleCatalog.cs`), and the TS
> enablement layer (toggle, grammar download, sync debounce, `codegraph_explore`
> tool, visualization page) is wired. This document plans what comes **after**: the
> deliberately-deferred engine branches, catching up to upstream's post-v1.4.1
> changes, and expanding the product surface.
>
> **Baseline.** Upstream [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
> **v1.4.1** (released 2026-07-10), gap-audited against a clone taken **2026-07-17**
> (including the then-`Unreleased` CHANGELOG section). Extraction version at
> baseline: **24**.
>
> **Explicitly NOT in M7** (owned elsewhere or decided against):
> - WS-A grammar CI matrix + per-RID packs, and the two `// TODO verify` grammar
>   entrypoints (terraform→`hcl`, vbnet) — [`../workstreams/A-grammar-build-matrix.md`](../workstreams/A-grammar-build-matrix.md).
> - The manual in-app runtime check (`npm run dev` → enable toggle → explore) —
>   needs a human with a GUI; tracked in the README status section.
> - Upstream's host machinery (CLI, MCP daemon/watchdogs, telemetry, installers,
>   update check) — architecture decision, permanently dropped (analysis/04).

---

> **✅ Execution status (2026-07-17).** W1 tasks 1–5 and W2 tasks 5–9 are DONE
> (326 tests green): the five deferred import-resolver branches, the read pool,
> the cross-process lock, the fn-ref/value-ref audit (both were live — stale
> comments fixed), CUDA launch normalization, the upstream tracking doc
> (`../reference/06-upstream-tracking.md` is now the live ledger), parallel
> resolution, fast-init, C++ explicit operator calls, and the `linking` progress
> phase. W3: tasks 1–2 DONE (tools-list-driven full surface behind
> `settings.codegraphFullToolSurface` + dashboard card; explore staleness banner —
> the dashboard freshness card already existed). W3-3 DONE: `codegraph/analytics`
> RPC (cycles + dead code, capped 50/200 with totals) + on-demand "Graph health"
> dashboard card. W3-4 RATIFIED **option A (wire)** and DONE:
> `codegraph/prompt-context` ports the upstream prompt-hook's tiered gate
> (HIGH keyword/token → capped explore injection; MEDIUM segment matches →
> symbol list; nudge-only for monorepo roots; every failure path a
> success-shaped no-op), and `buildRuntimeReminder` feeds it the outgoing user
> prompt per turn. **M7 is fully executed.**

## Workstream at a glance

```
W1 engine parity      ─ deferred import-resolver branches, read pool, cross-process lock,
                        fn-ref/value-ref flush audit, CUDA launch syntax        · size M
W2 upstream catch-up  ─ tracking process, parallel resolution, fast-init,
                        C++ explicit operator calls, post-1.4.1 checklist       · size M
W3 product surface    ─ the other 7 tools, staleness surfacing, viz analytics,
                        front-load hook decision (TS-side heavy)                · size M
```

W1 and W2 are independent of each other; W3 depends on nothing here (it consumes
RPCs that already exist) and can run in parallel. Within W2, task 6 (parallel
resolution) should land **after** W1 task 2 (read pool) so both concurrency changes
share one design review against R6 (concurrency risk).

---

## W1 — Engine parity · size M

**Goal:** close every gap the port itself marked `deferred` in code comments, so
the C# engine has no known self-acknowledged holes. Every task pairs with the
upstream TS source as the oracle and a WS-B-style golden test.

### Task breakdown (dependency-ordered)

1. **Import-resolver deferred branches** — `Resolution/CodeGraphImportResolver.cs`
   carries five `[DEFERRED]`-commented branches. Port each against the upstream
   resolver, one commit per branch, each with its upstream golden test:
   - **Rust `crate::m::Item` / `super::` / `self::` path resolution** — path-based
     module walking from the referencing file to the crate root.
   - **Lua/Luau `require("a.b.c")`** — dotted path → file resolution incl. `init.lua`.
   - **PHP `use` namespace context** — namespace-aware resolution for
     include/require refs (the extractor already captures `use` statements).
   - **Nix path-import branch** — `IsNixPathImport` currently returns constant
     `false`; enable the predicate and the skipped branch.
   - **HarmonyOS `oh-package.json5`** — `CodeGraphWorkspacePackages.EntryByName`
     currently returns `null` for ohpm; add JSON5-tolerant parsing of the
     dependency map (a minimal hand parser is fine — no new package dependency).
2. **Read-connection pool** — `Mcp/CodeGraphToolHandler.cs` §5.1 TODO. Today every
   RPC serializes through one per-project `SemaphoreSlim`. WAL already permits
   concurrent readers: add a small per-project pool of read-only connections
   (2–4, lazily opened, disposed on `Close()`), route the query-class RPCs
   (explore/search/node/callers/callees/impact/files/stats/query-neighbors)
   through it, and keep **all writes** (index/sync) on the existing single-writer
   path. The semaphore remains the write lock. *(Risk R6; validates under the
   heartbeat constraint of the source-merged worker.)*
3. **Cross-process file lock** — `CodeGraphEngine.cs` §5.7 deferral. The in-process
   semaphore does not protect against a second OpenCowork instance (or a stray
   worker after a crash) writing the same `graph.db`. Add a PID-stamped lock file
   next to the DB (`graph.lock`: pid + start-time), acquired before any write
   session, stale-detected by liveness probe, released on `Close()`/`Dispose()`.
   Read-only access never takes the lock.
4. **function-ref / value-ref flush audit** — the README claims value-refs +
   function-refs shipped; the code comments in the function-ref capture path
   (`CodeGraphFunctionRef.cs` §7) still read as gated/stubbed. Determine the truth:
   if the end-of-file flush is gated off, enable it and port the upstream
   `value-reference-edges` golden test; if it is live, delete the stale comments
   and add the missing test so the claim is pinned.
5. **CUDA kernel-launch syntax** (low priority, do last) — `.cu`/`.cuh` map to the
   C++ grammar (`Extraction/CodeGraphLanguageMap.cs:94-97`), which cannot parse
   `kernel<<<grid, block>>>(args)`. Do **not** add a CUDA grammar: add a
   pre-parse normalization in the C-family source-text path that rewrites
   `<<<…>>>` launches to plain calls (preserving byte offsets via same-length
   padding, the same discipline the CFML embedded extractor uses), so call edges
   to kernels resolve. `.metal` needs nothing (plain C++ subset).

### Acceptance

- Each branch in task 1 reproduces the upstream test expectations byte-for-byte
  where the upstream test is S3-style (index + SQL assertions).
- Task 2: a stress test issuing N concurrent explore RPCs against one project
  passes with the pool and fails (serializes) without it; no write interleaving.
- `dotnet test` fully green; AOT publish stays 0 warnings (WS-C discipline:
  `[GeneratedRegex]`, no reflection-based JSON5 parsing).

---

## W2 — Upstream catch-up · size M

**Goal:** absorb what upstream shipped after the v1.4.1 baseline, and leave a
repeatable process so future upstream releases are a checklist, not a re-audit.

### Task breakdown

1. **Upstream tracking process** (do first — it scopes everything else). Add
   `reference/06-upstream-tracking.md` recording: the baseline (v1.4.1 +
   2026-07-17 clone), the extraction-version alignment rule (when upstream bumps
   `EXTRACTION_VERSION`, we port the change set behind it and bump
   `CodeGraphEngine.ExtractionVersion` to the same number — never drift), and the
   per-release routine: diff `CHANGELOG.md`, classify each entry
   **already-have / port / not-applicable** (host machinery is always
   not-applicable), file the "port" rows as tasks.
2. **Parallel reference resolution** (upstream unreleased: fan-out on 150k+ refs).
   C# design: partition pending refs by file, resolve candidates on a bounded
   worker set (`Math.Min(ProcessorCount - 2, 4)` — capped below ProcessorCount per
   the source-merged-worker heartbeat constraint, Decision/R1), funnel results to
   the **single** writer thread. Store stays single-writer; only the pure
   candidate-matching fans out. Gate behind a ref-count threshold (small projects
   keep the sequential path). *(Sequence after W1 task 2 — one concurrency review.)*
3. **Fast-init: batched writes + deferred durability** (upstream unreleased,
   ~"25min → <1min" claim on slow disks). During a **fresh** index only:
   multi-row transactional inserts sized to the WAL valve, `synchronous=OFF`
   until the index completes, then one `wal_checkpoint(TRUNCATE)` + restore
   `synchronous=NORMAL`. An interrupted fresh index is already re-runnable
   (index_state='in_progress' → re-index), so the durability trade is safe.
   Compose with, don't replace, `Storage/CodeGraphWalValve.cs`. Env parity:
   honor a `CODEGRAPH_NO_FAST_INIT`-equivalent kill switch.
4. **C++ explicit operator calls** (upstream unreleased) — audited absent:
   `Extraction/Languages/CodeGraphCppExtractor.cs` has no `operator` handling.
   Port upstream's change: `a.operator+(b)` and namespace-qualified
   `ns::T::operator()` sites emit call refs to the operator definition.
5. **Post-1.4.1 checklist sweep** — run the task-1 classification over the
   remaining baseline `Unreleased` entries. Known rows to seed it with:
   - dynamic-dispatch linking **progress events** → map onto the existing
     `codegraph/index-progress` stream (add a `linking` phase) — **port**;
   - `codegraph_explore` word-bias fix, SQLite warning suppression, PHP DI
     receiver inference (`Resolution/CodeGraphReceiverTypeInference.cs` already
     has property-type patterns), failed-ref bidirectional retry
     (`Storage/CodeGraphStore.Refs.cs` parks/retries) — **verify already-have**,
     add a pinning test where missing;
   - npm shim, uninstall overhaul, Pro signup, update notice — **not-applicable**.

### Acceptance

- `reference/06-upstream-tracking.md` exists with the classified table for
  everything between v1.4.1 and the newest upstream release at execution time.
- Parallel resolution: identical node/edge/ref counts vs the sequential path on
  the golden corpora (bitwise DB diff on ordered dumps), plus a wall-clock win on
  a large fixture.
- Fast-init: interrupted-index recovery test (kill mid-index → reopen →
  re-index succeeds), and the checkpoint leaves `synchronous=NORMAL`.

---

## W3 — Product surface · size M (TS-side heavy)

**Goal:** the engine exposes far more than the app consumes. Surface it.

### Task breakdown

1. **Register the remaining 7 agent tools** —
   `src/renderer/src/lib/tools/codegraph-tool.ts` registers only
   `codegraph_explore`. Extend registration to be **driven by
   `codegraph/tools-list`** (the C# side already shapes the surface: tiny-repo
   gating, allowlist, projectPath-required cloning) instead of hardcoding:
   on toggle-on, fetch tools-list, register each returned def
   (search/node/callers/callees/impact/files/status) through the existing
   dynamic register/unregister pattern (the WebSearch/Browser/Wiki pattern).
   Add a settings control (default = explore-only, matching upstream's
   `DEFAULT_MCP_TOOLS`) so users opt into the wider surface.
2. **Staleness surfacing** — `codegraph/status` already returns staleness +
   `index_state`. Two consumers:
   - the explore tool result: when the engine reports pending sync /
     `in_progress`, prefix the tool output with a one-line banner (upstream's
     staleness-banner behavior, minus the watcher machinery);
   - the viz dashboard (`src/renderer/src/components/codegraph/CodeGraphDashboard.tsx`):
     show per-project freshness (last indexed, pending sync count, in-progress).
3. **Viz analytics panels** — the graph-analytics RPCs are registered but unused
   by the UI beyond the canvas: add panels to the CodeGraph page fed by
   `codegraph/stats`, `codegraph/query-neighbors`, `codegraph/files-tree`,
   `codegraph/file-symbols`, surfacing the ported storage heuristics
   (dominant-file, routing-manifest, circular-deps, dead-code, node-metrics).
   Start with circular-deps + dead-code — the two with obvious user value.
4. **Front-load prompt hook — decide, then wire or delete** *(needs ratification,
   see Open decisions)*. The C# side ports the hook; the TS side only injects the
   static `CODEGRAPH_SYSTEM_GUIDANCE`. Option A: on session start in a project
   with a fresh index, call the hook and inject graph-derived context into the
   session prompt. Option B (upstream Decision 3 originally recommended): drop it
   and delete the dead C# path. Do not leave it half-wired.

### Acceptance

- With the toggle on and the wider surface enabled, an agent session can call all
  8 tools end-to-end against a real indexed project; `npm run typecheck` and
  ESLint (changed-files only — see repo lint caveat) stay clean.
- Tiny-repo gating observable from the app: a <500-file project lists only the
  trio, everything still executable.
- i18n: all new UI strings in both `en` and `zh` locale files.

---

## Open decisions (ratify before the relevant task)

| # | Decision | Default if unratified |
|---|---|---|
| 1 | Front-load hook: wire (W3-4 A) or delete (B) | ~~B~~ **RATIFIED: A — wired** (2026-07-17, user decision) |
| 2 | Wider tool surface default: explore-only vs trio | **explore-only** (upstream parity) |
| 3 | Fast-init `synchronous=OFF` acceptable on user machines | **yes, fresh-index only** with kill switch |
| 4 | W2 cadence: chase every upstream release vs quarterly batches | **quarterly batch** via the tracking doc |

## Risks in play

- **R1 (heartbeat starvation)** — W1-2 and W2-2 add threads inside the
  source-merged worker; both cap below ProcessorCount and must be validated under
  a full-core index load (same bar as the M2 validation).
- **R6 (concurrency)** — read pool + parallel resolution are the two changes that
  can corrupt the single-writer invariant; one shared design review, stress tests
  in both.
- **Upstream drift** — W2-1's tracking doc is the mitigation; without it every
  future audit costs a day of re-diffing.

## Verification (workstream-independent)

- `dotnet test sidecars/OpenCowork.CodeGraph.Tests` green after every task.
- `dotnet publish` of the worker stays **0 warnings / 0 errors** under AOT.
- `npm run typecheck` for W3; lint changed files directly.
- Golden corpora: every W1/W2 engine change lands with its upstream test ported
  (WS-B style discipline), or a pinning test where upstream has none.
