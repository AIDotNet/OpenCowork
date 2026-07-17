# Upstream Tracking — keeping the C# port aligned with colbymchenry/codegraph

> **What this is.** The repeatable process (and the current ledger) for absorbing
> upstream releases after the port. Without this doc every upstream release costs a
> day of re-diffing; with it, a release is a checklist pass.

## Baseline

| | |
|---|---|
| Port oracle | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) **v1.4.1** (released 2026-07-10) |
| Audit clone | 2026-07-17 (includes the then-`Unreleased` CHANGELOG section) |
| Extraction version | **24** (`CodeGraphEngine.ExtractionVersion`) |

## Alignment rules

1. **Extraction version never drifts.** When upstream bumps `EXTRACTION_VERSION`,
   port the change set behind the bump FIRST, then set
   `CodeGraphEngine.ExtractionVersion` to the same number. Never bump without the
   changes; never take the changes without the bump (the staleness signal depends
   on it).
2. **Host machinery is always not-applicable.** CLI, installers, npm/upgrade
   plumbing, MCP daemon/watchdogs, telemetry, update notices, Pro signup — dropped
   by architecture decision (analysis/04); classify and move on.
3. **Grammar-shape differences are expected.** We ship native ABI-14 grammars,
   upstream ships WASM builds of (sometimes older) grammar versions. An upstream
   fix written against a mis-parse (e.g. #1247's ERROR-node recovery) may need a
   SECOND branch here for the correctly-parsing shape our grammar produces — test
   against OUR grammar, don't assume upstream's parse tree.
4. **Cadence: quarterly batches** (open decision M7 §4 default). Each pass: diff
   `CHANGELOG.md` from the last ledger entry, classify each row
   **already-have / port / not-applicable**, file the "port" rows as tasks, then
   extend the ledger below.

## Ledger — v1.4.1 + Unreleased (audited 2026-07-17)

Status legend: ✅ done in C# · 🔲 to port · ➖ not applicable · ❓ needs verification.

### Unreleased (post-1.4.1)

| Item | Status | Notes |
|---|---|---|
| Parallel reference resolution (150k+ refs fan-out, `CODEGRAPH_NO_PARALLEL_RESOLVE`) | ✅ | M7-W2 (2026-07-17): worker resolvers over read-only connections, batch-ordered apply on the single writer, deferral-list merge; `ParallelResolutionTests` pins sequential/parallel graph identity + real fan-out |
| Fast init (deferred durability on fresh DBs, search-index rebuilt once) | ✅ | M7-W2 (2026-07-17): `synchronous=OFF` + FTS trigger bulk mode on FRESH DBs only, restored on all paths; `FastInitTests`. Store-worker thread + multi-file transaction batching not taken (WAL valve already covers the disk-cost class) |
| Batch-boundary ref cleanup under-count (#1269) | ✅ | RowId-precise cleanup, pinned by `ResolutionTests.RowIdPreciseCleanup_KeepsSiblingRefAtDifferentLine_1269` |
| C++ explicit operator calls (#1247) | ✅ | M7-W2 (2026-07-17): ERROR-node recovery + the field_expression/operator_name shape our newer grammar produces; `CppOperatorCallTests` |
| Dynamic-dispatch linking progress phase | ✅ | M7-W2 (2026-07-17): `linking` phase emitted on `codegraph/index-progress` before the synthesis pass |
| SQLite experimental warning suppression | ➖ | node:sqlite-specific; Microsoft.Data.Sqlite emits no such warning |
| Pro beta signup / npm provenance / attestations | ➖ | Host machinery |

### 1.4.1 (2026-07-10)

| Item | Status | Notes |
|---|---|---|
| MCP update-available notice (#1243) | ➖ | Host machinery |
| `codegraph upgrade`/`uninstall` fixes (#1238, #1071) | ➖ | Host machinery |
| `codegraph_explore` word-bias fix (NL words hijacking symbol ranking) | ❓ | Verify the context builder's exact-name channel gates plain-English words the way upstream now does |
| PHP DI receiver inference (`$this->dep->method()`, #1220) | ✅ | `CodeGraphReceiverTypeInference` PhpPropertyTypePatterns / InferPhpAssignedPropertyType |
| Cross-file resolvability on sync, both directions (#1240) | ✅ | failed-ref parking + retry in `CodeGraphStore.Refs.cs`; orphan-sweep in sync |

### 1.4.0 / 1.3.1 (2026-07-09/10)

| Item | Status | Notes |
|---|---|---|
| WAL deferral on slow storage | ✅ | `CodeGraphWalValve` + WAL-deferral test suites |
| `CODEGRAPH_PARSE_TIMEOUT_MS` / parse-worker liveness | ➖ | Upstream's subprocess parse workers don't exist here (in-process parsing on capped threads) |
| Grammar in-memory loading for workers | ➖ | No worker processes; native dylibs load per-process once |
| Closure-collection quadratic-time fix (#1235) | ❓ | Verify `CodeGraphClosureCollectionSynthesizer` against the post-fix upstream algorithm |
| Post-index memory streaming (multi-million-symbol) | ✅ | `IterateNodesByKind` streaming cursor (Decision 20) |
| Query-pool warm-up / MCP handshake race / watchdog disk-activity | ➖ | Daemon machinery; the C# read pool (M7-W1) covers the concurrency need |
| Test-file detection in status | ❓ | Verify `codegraph/status` counts test files the way upstream 1.3.1 does |

### Next audit

Start from upstream `main` after v1.4.1; diff `CHANGELOG.md` against this ledger,
append a new dated section, and file 🔲 rows as tasks. Update the ❓ rows while
there — each should become ✅ (with the pinning test named) or 🔲.
