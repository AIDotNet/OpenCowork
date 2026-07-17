# 05 — Incremental Sync, Change Detection & Freshness

> **What this pins down.** How the port keeps the graph fresh when source code
> changes — the algorithm behind the `codegraph/sync` RPC. The RPC *I/O* is in
> [reference/02 §2.1](02-rpc-api-contract.md); the *trigger/hosting* is in
> [reference/04](04-process-model-and-enablement.md); the *facade/resolution
> details* are in [analysis/05 §2.4](../analysis/05-facade-sync-context-search-cli.md)
> and [analysis/02 §8](../analysis/02-resolution-synthesizers.md). This doc is the
> single place the two halves — **how CodeGraph does it** and **what the port
> copies / simplifies / drops** — are laid out end-to-end.
>
> Source citations `src/…:line` are into the CodeGraph clone (verified against
> v1.4.1). Plan cross-refs are clickable.

---

## 1. How CodeGraph does it (ground truth)

CodeGraph never "recompiles the graph on save." It funnels every change through one
idempotent method, **`CodeGraph.sync()`** (`src/index.ts:643`), fed by three
triggers, and reconciles **filesystem content vs indexed state** — deliberately
**not** `git status`.

### 1.1 Three triggers → one `sync()`

| Trigger | Source | When |
|---|---|---|
| **Live watcher** | `src/sync/watcher.ts` (`FileWatcher`, Node `fs.watch`, **2 s debounce**) | daemon/MCP running; edits detected, filtered by `ScopeIgnore`+`isSourceFile`, recorded in `pendingFiles`, then `scheduleSync → flush → sync()` |
| **git hooks** | `src/sync/git-hooks.ts` (`post-commit`/`post-merge`/`post-checkout`) | when watching is off (e.g. WSL2 `/mnt/*`, where recursive `fs.watch` stalls — `watch-policy.ts`) |
| **Catch-up on open** | `src/mcp/engine.ts` `catchUpSync` (~`:296`) | daemon (re)start: one-shot `sync()` reconciles everything changed while nothing watched (incl. `git pull`); the **first tool call blocks on it**, time-boxed |

### 1.2 Change detection = filesystem reconcile (the key subtlety)

`orchestrator.sync()` (`src/extraction/index.ts:2305`) states the rule in comments
(`:2322-2330`): **"the source of truth for what changed is the filesystem vs the
indexed state — never git."** Reason: `git status` cannot see committed changes from
`git pull`/`checkout`/`merge`/`rebase` (the working tree is clean afterward). So it
scans current source files and reconciles each against the `files` table with a
**three-tier filter**:

1. **size + mtime both match the DB row → skip** — no read, no hash (`:2393-2403`).
   Blind spot: a content change preserving *both* exactly is missed (accepted;
   `index --force` is the escape hatch). Git bumps mtime on checkout/merge, so pulls
   are caught.
2. size or mtime differs → **read file + SHA-256** (`hashContent`, `:120`).
3. `tracked.contentHash !== contentHash` → **real change**, queue for re-index
   (`:2413-2423`).

Removals: tracked in the DB but not a present source file (checked against the FS
directly — `git ls-files` still lists a deleted-but-unstaged file) → `deleteFile`.

### 1.3 The line-shift edge-preservation problem (#899 / #1240)

Node id embeds the start line (`{kind}:sha256(filePath:kind:name:line)[:32]`), so an
edit **changes the ids of every symbol below it**, and cross-file **incoming** edges
(callers in *other* files) referenced the old ids. Before deleting a file's nodes,
CodeGraph captures those incoming edges with their target `(name, kind)` via
`getCrossFileIncomingEdgesWithTarget` and **resurrects them as pending unresolved
refs** (`resurrectRefFromDroppedEdge` → `insertUnresolvedRefsBatch`,
`src/extraction/index.ts:2351-2375`) so they rebind to the shifted node — or park as
`failed` until the symbol reappears. This is why the `unresolved_refs`
`pending → delete/failed` lifecycle exists.

### 1.4 Incremental resolution (facade `sync()`, `src/index.ts:643`)

After the reconcile re-extracts changed files (`indexFile` deletes-old + inserts-new
per file), the facade choreographs **scoped** resolution — not a whole-graph re-run:

1. **Framework finalization** — `runPostExtract()` if files added/modified
   (`:665`); e.g. editing `app.module.ts` re-propagates NestJS route prefixes to
   controllers in unchanged files. Pure-removal → `clearCaches()`.
2. **Scoped resolution** — resolve only the changed files' unresolved refs
   (`getUnresolvedReferencesByFiles(changedPaths)`, `:681-699`).
3. **Failed-ref forward retry (#1240)** — the clever part (`:701-727`): a changed
   file that **gains** a symbol lets previously-`failed` refs in *unchanged* files
   finally resolve. Look them up by the changed files' new symbol names against the
   `name_tail` partial index and re-resolve just that set. No match ⇒ one indexed
   lookup.
4. **Orphan sweep (#1187)** — any `pending` refs still at rest = an interrupted
   earlier pass; the scoped path never revisits them, so grind them down with the
   batched resolver (`:748-776`). This is what makes a bare `sync` the **recovery
   command** for a wedged index.
5. **Deferred passes** — chained-conformance (#750) + deferred-this-member (#808)
   if anything changed (`:778-786`).
6. **Maintenance** — off-thread `ANALYZE` + WAL checkpoint (`:790-792`); segment-vocab
   heal if the vocab was empty at start (`:800-804`).

All under `indexMutex` (in-process) + `fileLock` (cross-process PID lock); if the
lock can't be acquired it returns an all-zero `SyncResult` and does nothing
(`:644-649`).

### 1.5 Full re-index vs incremental

Incremental `sync` is steady state. A **full** rebuild fires only when the extractor
output shape changed: `EXTRACTION_VERSION` (`src/extraction/extraction-version.ts`,
bumped 24× historically) → `isIndexStale()` compares the DB's
`indexed_with_extraction_version` → `recreate()` **unlinks the DB file (O(1)) and
rebuilds** rather than DELETE-ing rows, because per-row FTS delete-trigger churn on a
poisoned multi-GB index is pathological (`src/db/index.ts:464`, #1067).

### 1.6 Staleness signal

The watcher tracks `pendingFiles` (edited since the last completed sync); the MCP
layer intersects a response against that set and prepends **"⚠️ some files were
edited since the last index sync"** so the agent knows results may be slightly stale
even before the debounce fires.

---

## 2. How the port does it

Same **algorithm**, different **host**. Two structural facts change the wrapper (not
the core reconcile/resolve logic):

- **Opt-in standalone sidecar** ([reference/04](04-process-model-and-enablement.md)):
  the engine runs in `OpenCowork.CodeGraph.Worker`, spawned only when
  `codegraph.enabled=true`. So it is **off for long stretches** — the catch-up sync
  on enable does more work than a always-running daemon's would, but the FS-reconcile
  (content-hash vs DB) handles "what changed while I was off" correctly by
  construction; it never relied on having watched.
- **No watcher ships** (00 [Decision 13](../00-overview-and-roadmap.md)): the trigger
  is the **app's** debounced `fs:file-changed` → `codegraph/sync` RPC (reference/04
  §5, ENABLED state).

### 2.1 Trigger mapping (who calls `codegraph/sync`, with what `changedPaths`)

The RPC's `changedPaths` is patch-sensitive (reference/02 §2.1) — three modes:

| App situation | `changedPaths` | Engine behavior |
|---|---|---|
| Debounced edit(s) with known paths | `["src/a.ts", …]` | **scoped fast path** — reconcile+resolve just those (skip full FS scan) |
| Enable / catch-up / "index changed since last open" | **absent** | **full FS reconcile** (§1.2) — self-detect every add/mod/remove |
| Periodic health tick, nothing changed | `[]` (empty) | **orphan-sweep only** — grind residual `pending` refs, no scan |

The app already owns a debounced file-change pipeline (`src/main/ipc/fs-handlers.ts`,
`fs:file-changed`, with its own ignore filtering) — debounce it (~2 s, matching
CodeGraph) per enabled project and forward the changed paths. **On enable**, issue
one catch-up `codegraph/sync` with no `changedPaths` (reference/04 §5 ENABLING→ENABLED).

### 2.2 What the C# `SyncAsync` implements

`CodeGraphSyncTools.SyncAsync` (reference/02) → `CodeGraphEngine.SyncAsync`. Mirrors
§1.4 with the port's simplifications (§3):

```csharp
// CodeGraphEngine.SyncAsync(changedHint, ct)  — one writer, guarded by a semaphore
await _writeGate.WaitAsync(ct);                       // SemaphoreSlim(1,1), not a PID lock (Dec.14)
try {
    var vocabWasEmpty = _store.IsNameSegmentVocabEmpty();   // capture BEFORE (index.ts:655)

    // 1. Reconcile FS vs `files` table → added/modified/removed  (Store + Scanning)
    var delta = await ReconcileAsync(changedHint, ct);       // §1.2; changedHint scopes the scan

    // 2. Per removed/changed file: resurrect incoming cross-file edges, then delete+re-extract
    foreach (var f in delta.Removed)  ResurrectIncomingEdges(f);   // #899/#1240 (index.ts:2360)
    foreach (var f in delta.Removed)  _store.DeleteFile(f);
    foreach (var f in delta.Changed)  await ReExtractFileAsync(f, ct);  // delete-old + insert-new

    // 3. Framework finalization
    if (delta.HasAddsOrMods) _resolver.RunPostExtract();          // index.ts:665
    else if (delta.HasRemovals) _resolver.ClearCaches();

    // 4. Scoped resolution + forward retry
    if (delta.HasAddsOrMods) {
        _resolver.ResolveAndPersist(_store.GetUnresolvedRefsByFiles(delta.ChangedPaths), ct);
        var retry = _store.GetRetryableFailedRefs(_store.GetNodeNamesByFiles(delta.ChangedPaths));
        if (retry.Count > 0) await _resolver.ResolveListAsync(retry, ct);   // #1240 (index.ts:711)
    }

    // 5. Orphan sweep — recovery for a wedged/killed index (#1187, index.ts:761)
    if (_store.GetUnresolvedRefCount() > 0) await _resolver.ResolveAllBatchedAsync(ct);

    // 6. Deferred passes + maintenance + vocab heal
    if (delta.Changed.Count > 0) {
        await _resolver.ResolveChainedViaConformanceAsync(ct);   // #750
        await _resolver.ResolveDeferredThisMemberAsync(ct);      // #808
    }
    if (delta.Any) await _db.RunMaintenanceAsync();              // off-thread ANALYZE + checkpoint
    if (vocabWasEmpty && _store.NodeCount > 0) await RebuildNameSegmentVocabAsync(ct);

    return delta.ToSyncResult(pendingReferenceCount: _store.GetUnresolvedRefCount());
} finally { _writeGate.Release(); }
```

Progress streams as `codegraph/index-progress` (`phase:'sync'`) → `codegraph/index-complete`
(reference/02 §2.1). Cancellable via `codegraph/cancel-index` + the run registry.

### 2.3 Freshness in the isolated-sidecar model

- **Full-vs-incremental** is unchanged: `index-status.stale` (reference/02) exposes
  `extractionVersion < current`; a stale index → the app calls `codegraph/reindex`
  (the O(1)-unlink rebuild). Because the grammar pack is version-pinned to the
  extraction ABI (reference/04 §6), an app update that bumps `EXTRACTION_VERSION`
  triggers both a grammar re-download **and** a reindex — keeping AST-walk fidelity
  (R4) from drifting.
- **Staleness banner** moves to the **app** (00 Decision 13): the app knows what it
  edited since the last completed `codegraph/sync`, so it renders "results may be
  stale"; the worker just exposes `lastIndexedAt`/`state`/`pendingReferenceCount` via
  `codegraph/index-status`. (The worker no longer tracks `pendingFiles` — it has no
  watcher.)
- **Recoverability** (00 Decision 15 + reference/04 §4): the run registry and any
  in-flight index state are process-local and lost if the CodeGraph worker is
  recycled. The `index_state` marker + completeness reconcile are persisted in the
  graph DB, so a respawn resumes/re-detects rather than silently dropping an index —
  and because the worker is **isolated**, a mid-index kill never touches the agent.

---

## 3. Copy / simplify / drop ledger

| CodeGraph mechanism | Port disposition | Why |
|---|---|---|
| FS-reconcile change detection (size/mtime prefilter → content-hash confirm) | **COPY verbatim** | correctness-critical; catches `git pull`; the blind-spot/escape-hatch semantics are load-bearing |
| Incoming-edge resurrection on delete/modify (#899/#1240) | **COPY** | without it, editing a file silently drops its callers' edges (too-small blast radius) |
| Scoped resolution + failed-ref forward retry (#1240) | **COPY** | the whole point of incremental — bounded work, and unchanged files' refs still heal |
| Orphan sweep (#1187) | **COPY** | makes `sync` self-healing after an interrupted/killed pass — more relevant now the sidecar can be killed & respawned |
| Framework `postExtract` + deferred passes (#750/#808) on sync | **COPY** | cross-file finalization must re-run when a module/supertype file changes |
| `EXTRACTION_VERSION` → `isIndexStale` → `recreate` (O(1) unlink) | **COPY** | the full-rebuild trigger; ties to the version-pinned grammar pack (reference/04 §6) |
| **File watcher** (`sync/watcher.ts`, 912 LOC) + `watch-policy` + `git-hooks` | **DROP** | app already watches (`fs:file-changed`); a 2nd watch set = the fd-exhaustion class CodeGraph fought (00 Dec.13) |
| **Cross-process `FileLock`** (PID lockfile) | **SIMPLIFY → `SemaphoreSlim(1,1)`** | the CodeGraph sidecar is the **sole writer**; no CLI/hook races (00 Dec.14) |
| **`cooperative-yield` / `setImmediate` reconcile yields** (`SYNC_RECONCILE_YIELD_INTERVAL`, index.ts:2372) | **DROP → `CancellationToken` + off-thread** | Node yielded only because sync shared the event loop with the liveness heartbeat; the C# RPC handler already runs on its own `Task` off the IPC read loop |
| **Catch-up gate** (`engine.ts` catchUpSync, blocks first tool call) | **REPLACE → app-driven catch-up on enable** | reference/04 §5 issues one no-`changedPaths` `codegraph/sync` in ENABLING; tools report success-shaped "indexing…" until ready |
| Worker-side `pendingFiles` staleness tracking | **MOVE to app** | app owns the change signal; worker exposes `index-status` (00 Dec.13) |
| `getChangedFiles()` git-status helper (`extraction/index.ts:2467`) | **OPTIONAL** | only a status nicety; the FS reconcile is authoritative. Port if `codegraph status` wants a git-diff view |

---

## 4. Edge cases & failure modes to preserve

- **Never-indexed project** → `codegraph/sync` returns `not_indexed` **success-shaped**
  (reference/02 §2.1); the app calls `codegraph/index` first. Never `isError`.
- **Content change with identical size+mtime** → missed by design; the app can force
  correctness with `codegraph/reindex` (`force`) — document the escape hatch in the UI.
- **Sidecar killed mid-sync** → supervisor respawns *only* CodeGraph; next `sync`'s
  orphan sweep (§1.4.4) grinds down whatever the killed pass left `pending`. No agent
  impact (isolation).
- **Rapid successive edits** → the app debounces (~2 s) before calling `sync`;
  mid-sync edits arrive on the next debounce (the engine's `SemaphoreSlim` serializes,
  so a second `sync` waits, it does not interleave).
- **Empty `changedPaths`** (health tick) → orphan-sweep only, no FS scan — cheap
  liveness that also drains any residual `pending`.
- **`git pull` while disabled** → caught on the next enable's catch-up sync (full FS
  reconcile); mtime bumps from checkout guarantee detection.

---

## 5. Test gates (WS-B)

Port these CodeGraph suites as the fidelity oracle for this subsystem (see
[workstreams/B](../workstreams/B-golden-test-porting.md)):

- `sync.test.ts` — add/modify/remove reconcile counts; content-hash (not mtime)
  authority; `changedFilePaths` scoping.
- the `#1240` / `#1187` / `#899` regression cases — failed-ref forward retry, orphan
  sweep after an interrupted pass, incoming-edge survival across a line-shift edit.
- `db-reopen-on-replace` is **not** ported (inode self-heal is moot under the
  centralized DB + single-owner sidecar — 00 Decision 3, analysis/03 §5.5).

**Acceptance:** edit a file mid-graph → `codegraph/sync` updates only the affected
nodes/edges, a caller in an unchanged file keeps its (rebound) edge, a symbol newly
added in file A resolves a previously-failed ref in unchanged file B, and killing the
sidecar mid-sync then re-syncing converges (orphan sweep) with no lost edges.

---

## 6. Open questions

1. **Debounce ownership & interval.** App-side debounce (recommended, reuses the
   existing `fs:file-changed` machinery) at ~2 s to match CodeGraph, vs a
   worker-side coalescing queue. Confirm the app forwards changed paths (enables the
   scoped fast path) rather than always triggering a full reconcile.
2. **Catch-up cost on enable for large repos.** A full FS reconcile on every enable
   is O(files) stat + hash for changed ones. Acceptable? Or persist a "last synced
   at" and let the app pass a git-diff-since range as `changedPaths` when it can.
3. **Health-tick cadence.** Is a periodic empty-`changedPaths` orphan-sweep worth
   scheduling (drains residual `pending` from a prior kill), or rely on the next real
   edit's sweep? Recommend: rely on the next edit; add a tick only if wedged-index
   reports appear.
4. **Reindex-on-version-bump UX.** Auto-`reindex` when `index-status.stale` after an
   app update, vs prompt the user. Cross-cuts the grammar-pack re-download (reference/04
   §6). Recommend: auto, surfaced as "re-indexing after update".
