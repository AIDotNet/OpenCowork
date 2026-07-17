# 05 — Facade, Sync, Context, Search, Directory Scanning, Config & Peripheral Tooling

> Scope: the orchestration facade (`src/index.ts`), directory scanning + ignore
> semantics, incremental sync + file watching, surgical-context assembly/ranking,
> search query parsing + identifier segmentation, project config, and the
> peripheral tooling (CLI, installer, upgrade, telemetry, terminal UI).
> This is the spec for the **C# core engine's public surface** — which becomes
> the `codegraph/*` worker RPC methods — plus the CORE-vs-DROP call for the
> peripherals.
>
> Cross-refs (do not duplicate): the extraction pipeline is doc `01`; resolution
> is `02`; storage/`QueryBuilder`/data-model is `03`; the MCP tool surface,
> daemon, and process lifecycle are `04`; the target worker's module/serialization/
> SQLite conventions are `06`. Where those overlap, I reference rather than repeat.

---

## 1. Scope & subsystem summary

This area is the **glue**: everything that turns the four engine layers
(extraction, resolution, graph, storage) into one usable object, plus the
peripheral surfaces around it. It splits cleanly into **CORE** (must port) and
**DROPPABLE** (OpenCowork already provides an equivalent).

| Area | Files | LOC | Role | Verdict |
|---|---|---|---|---|
| **Facade** | `src/index.ts` | 1636 | `CodeGraph` class — the public API surface; wires the 5 layers, owns lifecycle/locks/mutex, index/sync orchestration, all read queries | **CORE** |
| **Directory scanning + ignore** | `extraction/index.ts` (scan/git/ignore funcs, ~L90–1360), `extraction/grammars.ts` (EXTENSION_MAP/detectLanguage/isSourceFile), `extraction/generated-detection.ts` | ~1300 (of a 3300-line file) + 82 | file discovery via `git ls-files` (+ FS-walk fallback), `.gitignore`/default-ignore/include/exclude, embedded-repo/worktree/submodule/gitlink handling, ext→language, generated-file detection | **CORE** |
| **Data-dir mgmt + frontload heuristics** | `directory.ts` | 813 | `.codegraph/` dir create/validate/remove, `CODEGRAPH_DIR` override, `.codegraph/.gitignore` gen; **and** the prompt-hook heuristics (structural-keyword detection in ~29 languages, identifier-token extraction, monorepo subproject planning) | **SPLIT** (dir-mgmt CORE; frontload heuristics are hook-specific, see doc 04) |
| **Context** | `context/index.ts`, `context/formatter.ts`, `context/markers.ts` | 1372 + 290 + 19 | `ContextBuilder` — hybrid multi-channel search ranking, subgraph expansion/trimming, code-block extraction, markdown/JSON formatting, call-paths section, confidence | **CORE** |
| **Search** | `search/query-parser.ts`, `search/query-utils.ts`, `search/identifier-segments.ts` | 184 + 441 + 160 | field-qualified query parsing, term extraction/stemming, path/name/kind scoring, test-file detection, project-name tokens, identifier segmentation (the `name_segment_vocab` producer) | **CORE** |
| **Project config** | `project-config.ts` | 396 | `codegraph.json` schema (`extensions`/`includeIgnored`/`exclude`/`include`), mtime-cached, defensive parse | **CORE** |
| **Sync / watch** | `sync/watcher.ts`, `sync/watch-policy.ts`, `sync/git-hooks.ts`, `sync/worktree.ts`, `sync/index.ts` | 912 + 104 + 212 + 158 + 33 | `FileWatcher` (Node `fs.watch`, per-platform, 2s debounce), WSL watch policy, git sync hooks, worktree-index mismatch detection | **MOSTLY DROP** — see §3/§6; the OpenCowork worker is already a daemon and the app already watches files |
| **Shared utils / errors** | `utils.ts` (partial), `errors.ts` | 606 + 240 | `Mutex`, `FileLock` (PID lockfile), `normalizePath`, `validatePathWithinRoot`, `isConfigLeafNode`, error taxonomy, logger | **CORE (subset)** |
| **CLI** | `bin/codegraph.ts` + 4 helpers | ~2720 | commander CLI: 24 commands (install/init/uninit/index/sync/status/query/explore/node/files/callers/callees/impact/affected/serve/daemon/…) | **DROP** (replaced by RPC + OpenCowork UI) |
| **Installer** | `installer/**` (index + 8 targets) | ~3400 | agent wiring for Claude Code/Cursor/Codex/opencode/hermes/gemini/antigravity/kiro | **DROP** (OpenCowork wires its own agents) |
| **Upgrade** | `upgrade/**` | ~1250 | npm/binary self-update, GitHub release checks | **DROP** (OpenCowork has its own updater) |
| **Telemetry** | `telemetry/index.ts` | 546 | anonymous usage rollups → `telemetry.getcodegraph.com` | **DROP** |
| **Terminal UI** | `ui/**` | ~290 | ANSI shimmer progress, glyphs | **DROP** (OpenCowork has its own UI; index progress streams as a worker event) |

**Headline:** ~16.6 kLOC of the assigned area is peripheral (CLI + installer +
upgrade + telemetry + UI ≈ 8.2 kLOC of it) that OpenCowork replaces wholesale.
The genuine port is the **facade + directory-scan/ignore + context + search +
config + a subset of utils** — roughly **6.5 kLOC of behavior-dense code**, most
of it heuristics (ranking, ignore rules, language mapping) rather than
infrastructure.

---

## 2. Architecture & data flow

### 2.1 The facade: layer wiring (`index.ts:135–225`)

`CodeGraph` holds a `DatabaseConnection` + `QueryBuilder` (doc 03) and lazily
constructs five layers in `wireLayers()` (`index.ts:177`):

```
ExtractionOrchestrator(projectRoot, queries)   // doc 01
ReferenceResolver = createResolver(...)          // doc 02
GraphQueryManager(queries)                       // doc 03
GraphTraverser(queries)                          // doc 03
ContextBuilder = createContextBuilder(...)       // this doc, §2.6
```

Plus, before wiring, it seeds ranking down-weights:
`queries.setProjectNameTokens(deriveProjectNameTokens(projectRoot))`
(`index.ts:181`, best-effort). `wireLayers()` is factored out of the constructor
so `reopenIfReplaced()` (`index.ts:210`) can rebuild the layers over a fresh
connection in place — this heals a stale DB handle after `.codegraph/` is
removed-and-recreated at the same path (POSIX unlinked-inode case, #925). **The
C# port needs the equivalent only if it caches per-project engine instances
across `recreate`; note it's POSIX-only and never fires on Windows.**

### 2.2 Lifecycle & concurrency (`index.ts:227–421`)

- Static factories: `init` (async, `initGrammars()` first, optional index),
  `initSync`, `open` (validates dir, optional sync), `openSync`, `recreate`
  (discards + re-inits the DB file — O(1), sidesteps the delete-trigger churn of
  clearing a poisoned 1.6M-node index, #1067), `isInitialized`.
- `close()` → `unwatch()` + `fileLock.release()` + `db.close()`.
- **Two-tier locking**, both held around every write path:
  - `indexMutex` — in-process `Mutex` (`utils.ts:375`, async FIFO queue) so
    `indexAll`/`indexFiles`/`sync` never overlap **within** the process.
  - `fileLock` — cross-process `FileLock` (`utils.ts:223`) = a PID lockfile at
    `.codegraph/codegraph.lock` with a 2-min staleness timeout and
    `process.kill(pid, 0)` liveness check; `wx` exclusive-create closes the
    check-then-write race. This is what coordinates the CLI, MCP daemon, and git
    hooks writing one DB.

### 2.3 `indexAll` pipeline (`index.ts:432–616`)

The single most orchestration-heavy method. Under both locks:

1. **WAL deferral valve** (`index.ts:448–461`): sets `wal_autocheckpoint=0`,
   starts a `WalCheckpointValve` worker that PASSIVE-checkpoints off-thread so
   the WAL doesn't rewrite hot pages ~every 1000 pages during a bulk write
   (19min→45s on HDD, #1231). Kill switch `CODEGRAPH_NO_WAL_DEFER=1`; skipped on
   non-WAL journal modes. **(Storage concern; doc 03 owns the valve. The facade
   is the caller.)**
2. Set `index_state='indexing'` marker, `clearNameSegmentVocab()`.
3. `orchestrator.indexAll(onProgress, signal, verbose, backpressure)` — parse
   phase (doc 01).
4. `walValve.foldNow()` before the first post-parse main-thread read.
5. If files indexed: `resolver.initialize()` (re-detect frameworks now that the
   file list exists) + `resolver.runPostExtract()` (cross-file finalization,
   e.g. NestJS route prefixes).
6. `resolveReferencesBatched()` (doc 02) → then two deferred passes:
   `resolveChainedCallsViaConformance()` (#750) and
   `resolveDeferredThisMemberRefs()` (#808).
7. `db.runMaintenance()` (off-thread ANALYZE + checkpoint).
8. Recompute node/edge deltas against the DB (`getNodeAndEdgeCount()` before/
   after) because resolution + synthesizer edges land after the orchestrator's
   own counts.
9. **Version stamping** (`index.ts:564–569`): `indexed_with_version` +
   `indexed_with_extraction_version` — the freshness signal behind
   `isIndexStale()`.
10. **Completeness reconcile** (`index.ts:576–600`): compares
    `filesDiscovered` (scan ground truth) against `indexed+skipped+errored`; a
    shortfall stamps `index_state='partial'` and pushes a warning. Terminal
    states: `complete` / `partial` / `failed` / (leftover) `indexing`.

### 2.4 `sync` pipeline (`index.ts:643–811`)

Incremental. Captures `vocabWasEmpty` **before** running (its own writes would
otherwise mask an empty vocab). Then:

- `orchestrator.sync()` returns `SyncResult{ filesChecked, filesAdded,
  filesModified, filesRemoved, nodesUpdated, changedFilePaths? }`.
- `changedFilePaths` present ⇒ **git fast path**: scope resolution to the
  changed files' unresolved refs (`getUnresolvedReferencesByFiles`), **plus** a
  failed-ref retry (`getRetryableFailedReferences` keyed on the changed files'
  node names — #1240 lets unchanged files' previously-failed refs resolve once a
  changed file gains the symbol). No git info ⇒ batched full resolution.
- **Orphan sweep** (`index.ts:761`): any pending refs at rest = an interrupted
  earlier pass (#1187); grind them down. Makes a bare `sync` the recovery
  command for a wedged index.
- Deferred passes (chained-conformance / deferred-this-member) if anything
  changed.
- **Segment-vocab heal** (`index.ts:800–804`): if `vocabWasEmpty` and nodes
  exist, `rebuildNameSegmentVocab()` (batched, yielding) — upgrade path for
  indexes built before the vocab table existed.

The change-detection itself (git `status` vs FS re-hash) lives in the extraction
module (`getGitChangedFiles` / orchestrator sync) — doc 01. The facade owns the
**resolution re-run + vocab + maintenance** choreography above.

### 2.5 Directory scanning & ignore (the real "directory" logic — `extraction/index.ts`)

> `src/directory.ts` is **not** the scanner (see §2.9). Actual file discovery
> lives in `extraction/index.ts`; it's in this doc's scope.

**Two enumeration paths**, unified so behavior is identical with/without git
(`scanDirectory`, `extraction/index.ts:1167`):

1. **Git fast path** — `getGitVisibleFiles(rootDir)` (`:998`):
   - `git rev-parse --show-toplevel`; if `rootDir` is itself gitignored by a
     parent repo (`git check-ignore -q`), return `null` → FS-walk fallback.
   - `collectGitFiles` (`:893`): `git ls-files -z -s --recurse-submodules`
     (tracked, `-s` gives mode so **gitlinks** `160000` are spotted) + `git
     ls-files -z -o --exclude-standard` (untracked). Recurses into **embedded
     repos** (a nested `.git` that isn't a submodule — CMake super-repo layout,
     #193), **submodule checkouts**, and **unexpanded gitlinks** (#1031/#1033).
     `-z` NUL-separation keeps CJK paths intact (#541).
   - Then filter with `ScopeIgnore` (§2.6-ignore) and force-add `include`
     whitelist files.
2. **FS-walk fallback** — `scanDirectoryWalk` (`:1228`): recursive `readdir`,
   per-directory nested `.gitignore` matchers (git-style scoping), symlink-cycle
   guard via `realpathSync` + `visitedDirs`, skips `.git` and any
   `.codegraph*` data dir.

**Ignore semantics** (all `ignore` npm package, git-syntax):

- `DEFAULT_IGNORE_DIRS` (`:145`) — a curated ~70-name set (node_modules, dist,
  build, target, vendor, .venv, Pods, .gradle, __pycache__, …). Applied
  **uniformly** (git or not, tracked or not, #407); only opt-out is an explicit
  `.gitignore` negation `!vendor/`. First-party-prone names (src/lib/app/bin) are
  deliberately excluded.
- `DEFAULT_IGNORE_PATTERNS` (`:205`) — the dirs as `foo/` globs + `*.egg-info/`,
  `cmake-build-*/`, `bazel-*/`, and **Android res** patterns `**/res/{layout,
  values,drawable,…}*/` (#1047).
- `readGitignorePatterns` (`:241`) — **defensive**: NUL/invalid-UTF-8 files
  (DLP-encrypted `.gitignore`, #682) skipped whole; a single uncompilable line
  (`ignore` throws lazily at match time) dropped, rest kept.
- `ScopeIgnore` class (`:624`) — the single source of truth for indexer **and**
  watcher scope. Layers, in precedence: user `exclude` (wins always, even on
  tracked files inside embedded repos) → user `include` (forces first-party
  source in despite `.gitignore`, but never resurfaces a default-ignored dir) →
  per-embedded-repo matchers (each embedded repo judged by *its own* `.gitignore`
  + defaults, #514) → root matcher. Also keeps ancestor dirs of embedded repos
  walkable so the walker/watcher can descend.
- Embedded/worktree/gitlink classification: `classifyGitDir` (`:544`) returns
  `embedded` | `worktree` | `none` by reading the `.git` file's `gitdir:`
  pointer (a `worktrees/` segment ⇒ duplicate view, skip; #848/#945).

### 2.6 Language mapping, generated & test detection

- `EXTENSION_MAP` (`grammars.ts:58`) — ~90 extensions → 41 languages, incl.
  Drupal `.module/.theme`, `.metal`/`.cu` → cpp, `.ets` → arkts, `.cshtml` →
  razor. `detectLanguage` (`:414`) adds a **content heuristic for `.h`**
  (`looksLikeCpp`/`looksLikeObjc` on the first 8 KB). `isSourceFile` (`:184`) is
  the "should we index this" gate; special-cases extensionless/multi-suffix
  files: Play `conf/routes`, Shopify OS-2.0 `templates|sections/*.json`, OTP
  `.app`/`.app.src`. User `codegraph.json` `extensions` overrides merge on top.
- `isGeneratedFile` (`generated-detection.ts:79`) — 30 filename-suffix regexes
  (`.pb.go`, `_grpc.pb.go`, `*_mock(s).go`, `.g.dart`, `*_pb2.py`, `.min.js`,
  `OuterClass.java`, …). **Ranking hint only**, never a hard filter — generated
  nodes stay reachable but rank last / drop from context.
- `isTestFile` (`query-utils.ts:280`) — filename patterns (`test_*`,
  `*.test.ts`, `FooTest.kt`, capital-led CamelCase suffix) + directory patterns
  (`/tests/`, `/spec/`, `jvmTest/`, …) + non-production dirs
  (`matchesNonProductionDir`: integration/sample/example/fixture/benchmark/demo).

### 2.7 Context assembly & ranking (`context/index.ts`)

The surgical-context engine. `findRelevantContext(query, opts)` (`:432`) is a
**multi-channel hybrid retriever** — this is the highest-value, highest-risk
heuristic in the whole area. Pipeline:

1. `extractSymbolsFromQuery` (`:44`) — regexes for CamelCase / snake / SCREAMING
   / ALL-CAPS acronym / dot.notation / plain-lowercase identifiers, minus a
   common-word stoplist.
2. **Exact-name channel** (`:454`) — `findNodesByExactName`, then a
   **co-location boost**: when ≥2 extracted symbols land in the same file, boost
   both (`+ (count-1)*20`, `:480`).
3. **Definition-prefix channel** (`:498`) — title-case each symbol (+ stem
   variants) and prefix-match `class/interface/struct/…` kinds; brevity bonus
   favors short names.
4. **FTS text channel** (`:539`) — `extractSearchTerms` per-term, boost multi-
   term hits (`+ (termHits-1)*5`); excludes imports unless kinds specified.
5. **Merge** channels taking `max` score per node (`:588`).
6. **Test down-rank** (`×0.3`, `:620`) unless query mentions test/spec.
7. **Core-directory boost** (`:640`) — if one file dominates in-file call edges
   (≥3× the next), boost its directory siblings `+25` (Iter7, e.g. sinatra
   `base.rb`).
8. **Multi-term co-occurrence re-rank** (`:659`) — group stem-variant terms into
   concepts; a node matching ≥2 concepts (in name-substring or exact dir
   segment) gets `× (1 + matchCount*0.5)`; distinctive exact matches keep full
   score; common-word exact matches `×0.3`; generic single-term `×0.6`.
9. **CamelCase-boundary channel** (`:745`) — `LIKE`-based substring match at
   CamelCase/acronym boundaries (FTS can't find `Search` inside
   `TransportSearchAction`); scaled by term count.
10. **Compound channel** (`:830`) — classes containing ≥2 query terms at any
    position.
11. Final sort/truncate → `minScore` filter → `resolveImportsToDefinitions`
    (follow `imports`/`exports` edge to the real def) → cap to `searchLimit`.
12. **Confidence** (`:912`): a ≥2-term query with no entry point corroborated by
    ≥2 distinct terms and no user-named distinctive identifier ⇒ `'low'` ⇒
    honest-handoff footer.
13. **Graph expansion**: type-hierarchy expansion (2 passes for siblings), BFS
    from each entry point (`traversalDepth`), then **trimming** — priority
    (roots + neighbors), **per-file diversity cap** (~20% of budget), **non-
    production cap** (~15%), edge recovery (`findEdgesBetweenNodes`).

`buildContext` (`:216`) wraps it: extract code blocks (`extractNodeCode` reads
the file lines; **config-leaf nodes return only the key, never the on-disk
secret value**, #383), generate summary/stats, format. `formatter.ts` renders
markdown (Entry Points / Related Symbols / Code, with generated files re-sorted
last) or JSON. `buildCallPathsSection` (`:320`) does an in-memory DFS over
`calls` edges to surface execution chains connecting ≥2 query-relevant roots,
labeling synthesized (dynamic-dispatch) hops.

### 2.8 Search query parsing & identifier segmentation

- `parseQuery` (`query-parser.ts:66`) — field-qualified syntax
  `kind:function lang:go path:"src/api" name:auth freetext`; unknown `foo:bar`
  falls through to FTS; quote-aware tokenizer; validates `kind`/`lang` against
  the canonical `NODE_KINDS`/`LANGUAGES` arrays. Also `boundedEditDistance`
  (`:157`) for fuzzy fallback.
- `extractSearchTerms` (`query-utils.ts:156`) — splits camel/snake/dot, drops
  `STOP_WORDS`, adds `getStemVariants` (-ing/-tion/-ment/-ies/-s/-ed/-er
  strippers for FTS prefix matching).
- `splitIdentifierSegments` (`identifier-segments.ts:30`) — the
  `name_segment_vocab` producer: `OrderStateMachine → order/state/machine`,
  Unicode-aware camel/acronym boundaries, digit-glued (`base64Encode →
  base64/encode`), bounded 2–32 chars, ≤12 segments. `extractProseCandidates`
  (`:114`) normalizes prompt prose (NFD diacritic-strip), drops
  `ENGLISH_PROSE_STOPWORDS`. `segmentLookupVariants` (`:147`) does English
  plural folding. These feed `CodeGraph.getSegmentMatches` (§3, `index.ts:1127`)
  — the graph-derived prompt-matching tier (co-occurrence + rarity ceiling).
- `deriveProjectNameTokens` (`query-utils.ts:29`) — go.mod / package.json / repo
  dir name, normalized, ≥5 chars, to down-weight the non-discriminative project
  name in ranking (#720).

### 2.9 Data-dir mgmt + frontload heuristics (`directory.ts`)

- **Data-dir**: `codeGraphDirName()` honors `CODEGRAPH_DIR` env override
  (single-segment, validated) so Windows + WSL don't share one index (#636);
  `getCodeGraphDir`, `isInitialized` (dir **and** `codegraph.db` must exist),
  `findNearestCodeGraphRoot` (git-style up-walk), `createDirectory` (+ writes a
  wildcard `.codegraph/.gitignore`), `validateDirectory`, `removeDirectory`
  (symlink-safe), `unsafeIndexRootReason` (refuses `$HOME`/`/`, #845).
- **Frontload heuristics** (hook-only): `hasStructuralKeyword` (~29-language
  keyword/stem/unsegmented tables — huge multilingual regexes), `extractCodeTokens`,
  `isStructuralPrompt`, `planFrontload` (monorepo subproject scan +
  scoring). **These belong to the prompt-hook feature (doc 04), not the core
  engine** — flag for the architect whether OpenCowork reproduces the front-load
  hook at all.

### 2.10 Sync / watch (`sync/**`)

`FileWatcher` (`watcher.ts:247`) uses **Node's built-in `fs.watch`** (no
chokidar, no native addon) with a per-platform strategy:

- **macOS/Windows**: one recursive `fs.watch(root, {recursive:true})` → one
  FSEvents stream / one ReadDirectoryChangesW handle = **O(1) descriptors**
  (fixes the pre-1.0 macOS fd-exhaustion, #644/#496).
- **Linux**: recursive unsupported → one inotify watch **per non-ignored
  directory** (O(dirs), not O(files)); new dirs picked up dynamically; capped at
  `DEFAULT_MAX_DIR_WATCHES=50_000` with graceful degrade; ENOSPC (inotify budget)
  warns-and-continues, EMFILE/ENFILE degrades.
- **Debounce**: `debounceMs ?? 2000` (`:330`). `handleChange` filters via the
  shared `ScopeIgnore` + `isSourceFile`, records `pendingFiles` (for the MCP
  "results may be stale" signal), and `scheduleSync()`. `flush()` (`:772`) runs
  the sync callback, clears only pending entries whose `lastSeenMs <=
  syncStartedMs` (keeps mid-sync edits pending), and backs off exponentially
  (capped 30 s) on lock contention (`MAX_LOCK_RETRIES=5`) or generic failure
  (`MAX_SYNC_FAILURE_RETRIES=5`), degrading permanently past the budget.
- `watch-policy.ts`: `watchDisabledReason` turns watching **off** on WSL2
  `/mnt/*` drives (recursive `fs.watch` stalls the event loop past MCP handshake
  timeouts, #199); env overrides `CODEGRAPH_NO_WATCH` / `CODEGRAPH_FORCE_WATCH`.
- `git-hooks.ts`: opt-in `post-commit`/`post-merge`/`post-checkout` hooks that
  background `codegraph sync` when watching is off (marker-delimited, idempotent).
- `worktree.ts`: `detectWorktreeIndexMismatch` — warns when a query "borrows"
  another git worktree's index (via `git rev-parse --show-toplevel` /
  `--git-common-dir`).

---

## 3. Public / internal contracts the C# port must reproduce

### 3.1 The `CodeGraph` facade — method-by-method (the C# core-engine spec)

This **is** the public surface the C# `CodeGraphEngine` must expose; the
`codegraph/*` RPC methods (§6) are a thin projection of it, and doc 04's 8 MCP
tools are a further projection of *those*. Types (`Node`, `Edge`, `Subgraph`,
`SearchResult`, `SegmentMatch`, `Context`, `GraphStats`, …) are in §3.2.

**Lifecycle**
| Method | Signature | Notes |
|---|---|---|
| `init` | `(root, {index?, onProgress?}) → Promise<CodeGraph>` | grammars init + create dir + init DB (+ optional index) |
| `initSync` / `openSync` | `(root) → CodeGraph` | no async grammar init / no sync |
| `open` | `(root, {sync?, readOnly?}) → Promise<CodeGraph>` | validate dir, optional sync |
| `recreate` | `(root) → Promise<CodeGraph>` | discard + re-init DB file (O(1) rebuild) |
| `isInitialized` (static) | `(root) → boolean` | dir + `codegraph.db` present |
| `close` / `destroy` | `() → void` | unwatch + release lock + close DB |
| `uninitialize` | `() → void` | close + delete `.codegraph/` |
| `getProjectRoot` | `() → string` | |
| `reopenIfReplaced` | `() → boolean` | POSIX stale-handle heal (defer/skip on Windows) |

**Indexing / sync**
| `indexAll` | `({onProgress?, signal?, verbose?}) → Promise<IndexResult>` | full pipeline §2.3 |
| `indexFiles` | `(paths[]) → Promise<IndexResult>` | subset |
| `sync` | `({onProgress?}) → Promise<SyncResult>` | incremental §2.4 |
| `isIndexing` | `() → boolean` | mutex state |
| `extractFromSource` | `(path, source) → ExtractionResult` | parse without storing |
| `getChangedFiles` | `() → {added,modified,removed}` | |
| `getLastIndexedAt` | `() → number\|null` | |
| `getIndexState` | `() → 'indexing'\|'complete'\|'partial'\|'failed'\|null` | |
| `getIndexBuildInfo` | `() → {version, extractionVersion}` | |
| `isIndexStale` | `() → boolean` | extractionVersion < current |

**Resolution**
| `resolveReferences` / `resolveReferencesBatched` | `(onProgress?) → (Promise<)ResolutionResult(>)` | |
| `getPendingReferenceCount` | `() → number` | orphan detector |
| `getDetectedFrameworks` | `() → string[]` | |
| `reinitializeResolver` | `() → void` | |

**Stats / backend**
| `getStats` | `() → GraphStats` (+ dbSizeBytes) |
| `getBackend` / `getJournalMode` | `() → SqliteBackend / string` |

**Node ops**
| `getNode(id) → Node\|null` · `getNodesInFile(path) → Node[]` · `getNodesByKind(kind) → Node[]` · `getNodesByName(name) → Node[]` (all overloads, uncapped) · `getNodesByNamePrefix(prefix, limit=20) → Node[]` |

**Search (the load-bearing read surface)**
| `searchNodes(query, opts?) → SearchResult[]` | FTS/LIKE ranked (doc 03 `QueryBuilder`) |
| `getSegmentMatches(words[], limit=6) → SegmentMatch[]` | co-occurrence + rarity-ceiling(25) graph-derived prompt matcher (`index.ts:1127`) |
| `getProjectNameTokens() → Set<string>` · `getTopRouteFile() → {filePath,routeCount,totalRoutes}\|null` · `getRoutingManifest(limit?) → {...}\|null` |

**Edge ops**: `getOutgoingEdges(id)` · `getIncomingEdges(id) → Edge[]`.
**File ops**: `getFile(path) → FileRecord\|null` · `getFiles() → FileRecord[]`.

**Graph queries (traverser/graphManager pass-throughs, doc 03)**
| `getContext(id) → Context` · `traverse(id, opts?) → Subgraph` · `getCallGraph(id, depth=2)` · `getTypeHierarchy(id)` · `findUsages(id) → {node,edge}[]` · `getCallers(id, depth=1)` · `getCallees(id, depth=1)` · `getImpactRadius(id, depth=3)` · `findPath(from,to,edgeKinds?) → {node,edge|null}[]\|null` · `getAncestors(id)` · `getChildren(id)` · `getFileDependencies(path)` · `getFileDependents(path)` · `findCircularDependencies() → string[][]` · `findDeadCode(kinds?)` · `getNodeMetrics(id) → {…6 counts}` |

**Context building (this doc's core)**
| `getCode(id) → Promise<string\|null>` | config-leaf redaction (#383) |
| `findRelevantContext(query, opts?) → Promise<Subgraph>` | §2.7 |
| `buildContext(input, opts?) → Promise<TaskContext\|string>` | markdown/json/struct |

**DB mgmt**: `optimize()` · `clear()`.

**Watching (facade side — candidate to DROP, see §6):** `watch(opts?) → boolean`
· `unwatch()` · `isWatching()` · `isWatcherDegraded()` · `getWatcherDegradedReason()`
· `getPendingFiles() → PendingFile[]` · `waitUntilWatcherReady(timeoutMs?)`.

### 3.2 Data types (source of truth for source-gen DTOs — `types.ts`)

`NODE_KINDS` (22, runtime-iterable const array), `EdgeKind` (12), `LANGUAGES`
(41 incl. `unknown`). Core records: `Node` (id/kind/name/qualifiedName/filePath/
language/start-endLine/start-endColumn + optional docstring/signature/visibility/
isExported/isAsync/isStatic/isAbstract/decorators/typeParameters/returnType/
updatedAt), `Edge` (source/target/kind/metadata?/line?/column?/provenance?),
`FileRecord`, `ExtractionResult`, `SyncResult`, `IndexResult` (+`filesDiscovered?`),
`Subgraph` (**`nodes: Map<string,Node>`** + edges + roots + `confidence?`),
`SearchResult` (node + **unbounded, non-normalized** score + highlights?),
`SegmentMatch`, `Context`, `CodeBlock`, `GraphStats`, `TaskContext`,
`BuildContextOptions`, `FindRelevantContextOptions`, `TraversalOptions`,
`SearchOptions`. **Note the `NODE_KINDS`/`LANGUAGES` const arrays back the query
parser's validation** — keep one C# source of truth (an `enum` + string map).

### 3.3 Directory/config contracts

- `codegraph.json` (`ProjectConfig`, `project-config.ts:34`): `extensions?:
  Record<string,string>`, `includeIgnored?: string[]`, `exclude?: string[]`,
  `include?: string[]`. All optional; every parse failure degrades to
  zero-config (never throws); mtime-cached per root; invalid entries
  warn-and-skip. `addIncludeIgnoredPatterns` writes back (plain-JSON round-trip).
- `isSourceFile(path, overrides?) → boolean`, `detectLanguage(path, source?,
  overrides?) → Language`, `isGeneratedFile(path) → boolean`, `isTestFile(path)
  → boolean` — pure classifiers, all reproducible.
- `ScopeIgnore.ignores(rel) → boolean` and `buildScopeIgnore(root,
  embeddedRoots?)` — the shared indexer/watcher scope contract.

### 3.4 Shared utils to reproduce (`utils.ts`)

`normalizePath` (backslash→slash), `validatePathWithinRoot(root, path,
{allowSymlinkEscape?})` (lexical + realpath containment — **security-critical**,
#527/#935), `isConfigLeafNode`, `Mutex`, `FileLock` (PID lockfile), `clamp`,
`safeJsonParse`. Error taxonomy (`errors.ts`): `CodeGraphError` + FileError/
ParseError/DatabaseError/SearchError/ConfigError + pluggable `Logger`.

---

## 4. External dependencies → C# mapping

| npm dep / Node API | Used for (in scope) | C# / .NET target | AOT? |
|---|---|---|---|
| **`ignore` ^7** | ALL `.gitignore`/default-ignore matching (`extraction/index.ts`, `watcher.ts`) | **Reimplement** a git-semantics matcher. The existing worker `IgnoreMatcher`/`PathGlobMatcher` (`Modules/File/FileTools.cs:1835`) is **insufficient** (root-only `.gitignore`, **no negations**, no nested, ~28 default dirs) — extend it or write a dedicated `GitIgnoreMatcher`. | ✅ pure managed |
| **`picomatch` ^4** | **Only** `resolution/frameworks/cargo-workspace.ts` (out of this doc's scope) — **not** used by the scanner | Skip for scanning; if the Cargo resolver needs it, use `Microsoft.Extensions.FileSystemGlobbing` or a small glob→regex | ✅ |
| **`jsonc-parser` ^3** | **Not** used by `project-config.ts` (it uses plain `JSON.parse`). Used by the installer/CLI for editing agents' JSONC configs → **DROP** | n/a (config uses `System.Text.Json` source-gen; see doc 06) | ✅ |
| **`chokidar`** | **NOT a dependency** — the watcher uses Node `fs.watch` directly | If a watcher is ported at all: `System.IO.FileSystemWatcher` (see §6 — **recommend NOT porting**) | ⚠️ FSW is flaky/leaky; prefer app signals |
| Node `fs`/`path`/`os` | scanning, dir mgmt, config, locks | `System.IO.File/Directory/Path`, `Environment.GetFolderPath`, `Path.GetFullPath` | ✅ |
| Node `crypto` SHA-256 | content hashing (`hashContent`) | `System.Security.Cryptography.SHA256` | ✅ |
| `child_process.execFileSync('git', …)` | git ls-files/status/rev-parse/check-ignore across scan, worktree, hooks | **`System.Diagnostics.Process`** — and the worker **already shells `git`** (`Modules/Git/GitTools.cs:591`, `FileName="git"`), reuse that helper | ✅ (needs `git` on PATH — see §5) |
| `TextDecoder('utf-8',{fatal})` | invalid-UTF-8 `.gitignore` detection | `new UTF8Encoding(false, throwOnInvalidBytes:true)` or `Utf8.IsValid` | ✅ |
| Unicode regex `\p{L}\p{N}\p{Lu}\p{Ll}\p{M}` + NFD normalize | identifier segmentation, structural keywords | .NET `Regex` supports `\p{L}` etc.; `string.Normalize(NormalizationForm.FormD)` | ⚠️ see §5 (regex source-gen / big multilingual patterns) |
| **`commander` ^14** | CLI (`bin/`) | **DROP** — replaced by RPC | — |
| **`@clack/prompts`, `sisteransi`, `fast-string-width`, `fast-wrap-ansi`** | installer prompts + terminal UI | **DROP** — OpenCowork owns UI | — |
| GitHub/npm HTTP (upgrade), telemetry HTTP | self-update, telemetry | **DROP** — OpenCowork updater; no telemetry | — |

**Net new NuGet:** effectively **none** for this area — `Microsoft.Data.Sqlite`
(doc 03/06) is the only heavyweight, and it's already in the worker. The
directory/context/search port is pure managed C# + `Process` for git.

---

## 5. Porting challenges & risks (ranked)

1. **`ignore` semantics fidelity (HIGH).** The whole scan correctness rests on
   reproducing git's `.gitignore` algorithm: nested per-directory files,
   negations (`!vendor/`), anchored vs floating patterns, `**`, trailing-slash
   dir-only rules, and the ~70-name default set applied uniformly. The worker's
   current `IgnoreMatcher` gets none of the hard cases (drops `!` lines entirely,
   root-only). **Mitigation:** in a git repo, lean on `git ls-files`/`git
   check-ignore` (git *is* the reference implementation) and only reproduce the
   matcher for (a) the non-git FS-walk fallback and (b) the built-in defaults +
   user `include`/`exclude`/`includeIgnored` overlays. Pin against the
   `exclude-config` / `include-config` / `include-ignored-config` / directory
   tests.

2. **`git` availability + subprocess cost (HIGH).** CodeGraph shells `git` for
   nearly all discovery and change-detection (ls-files, status, rev-parse,
   check-ignore, common-dir). If `git` is missing or the tree isn't a repo, it
   degrades to the FS walk — the C# port must keep that fallback. All calls are
   **time-bounded** (5–30 s) to avoid hanging the daemon's liveness watchdog
   (#1139) — reproduce the timeouts. Reuse `Modules/Git/GitTools.cs`'s process
   helper. Risk: per-embedded-repo recursion spawns many `git` processes on
   monorepos.

3. **Context ranking heuristic fidelity (HIGH, highest-value).** `findRelevantContext`
   is ~450 lines of tuned magic-number heuristics (10+ channels, boosts, dampers,
   caps at `:480/524/578/650/727/820/870`, diversity/non-prod caps). Small
   deviations change which symbols an agent sees. **Mitigation:** port
   channel-by-channel with the exact constants; treat `context-ranking.test.ts`
   and `context.test.ts` as the golden spec; consider a fixture-replay harness.
   This is where a "close enough" rewrite silently regresses quality.

4. **`SearchResult.score` is BM25-unbounded, not normalized (MEDIUM).** Ranking
   mixes FTS BM25 magnitudes (tens–hundreds) with exact/fuzzy ~0–1 scores; the
   `× multiplier` re-ranks assume that scale. The C# FTS5 path (doc 03) must
   emit the **same** relative magnitudes or every downstream boost mis-weights.
   Verify FTS5 `bm25()` output aligns.

5. **Multilingual regex tables (MEDIUM, mostly hook-only).** `directory.ts`'s
   structural-keyword detection is enormous `\p{L}`-based regexes across ~29
   languages/scripts. .NET `Regex` handles the syntax, but: (a) confirm `\p{M}`
   NFD-strip parity for segmentation; (b) under AOT, use
   `[GeneratedRegex]` source-gen for the hot ones. If the front-load hook is out
   of scope (likely), this risk evaporates.

6. **`Subgraph.nodes` is a `Map` with insertion-order semantics (MEDIUM).**
   Trimming/diversity logic iterates `finalNodes` and relies on insertion order
   (`:1049` fills "remaining from other nodes"). Use `Dictionary` (insertion-
   ordered in practice but not guaranteed) → prefer an explicit ordered
   structure or a `List<Node>` + id index to be safe.

7. **`FileLock` cross-process semantics (MEDIUM).** PID lockfile + `kill(pid,0)`
   liveness + 2-min staleness + `wx` exclusive create. In C#: `File.Open(...,
   FileMode.CreateNew)` for the race, `Process.GetProcessById` for liveness. But
   **in the OpenCowork embedding the worker is the *only* writer** (single
   daemon) — the cross-process lock may be reducible to the in-process `Mutex`
   (a `SemaphoreSlim(1,1)`). Confirm with the architect whether external `git
   hook` writers still exist (they won't — hooks are dropped).

8. **Path security (`validatePathWithinRoot`) (MEDIUM).** Load-bearing against
   symlink-escape leaks (#527/#935). Reproduce lexical + `realpath` containment
   exactly; `Path.GetFullPath` + a canonicalized-prefix check + symlink
   resolution (`new FileInfo(path).ResolveLinkTarget(true)` on .NET 6+).

9. **`CODEGRAPH_DIR` override / `.codegraph-*` sibling detection (LOW).** Simple
   to port; matters only for the Windows+WSL shared-tree case, which is unlikely
   in the OpenCowork embedding (one platform per install).

10. **`fs.watch` per-platform behavior (LOW — because we're dropping it).** If
    ported, `FileSystemWatcher` is notoriously lossy under load and has its own
    inotify/FSEvents caveats. See §6 — **recommend not porting.**

---

## 6. Recommended C# design

### 6.0 CORE-vs-DROP ledger (the KEY judgment)

**CORE — port into the worker:**

| CodeGraph | → C# home |
|---|---|
| `CodeGraph` facade (all read/index/sync methods) | `CodeGraphEngine` (the reproduced core; RPC surface) |
| `extraction/index.ts` scan/git/ignore funcs, `ScopeIgnore` | `Scanning/` (DirectoryScanner, GitFileEnumerator, ScopeIgnore, GitIgnoreMatcher) |
| `grammars.ts` EXTENSION_MAP/detectLanguage/isSourceFile | `Scanning/LanguageMap.cs` |
| `generated-detection.ts`, `query-utils.isTestFile` | `Scanning/FileClassifier.cs` |
| `context/**` | `Context/` (ContextBuilder, ContextFormatter, CallPaths) |
| `search/**` | `Search/` (QueryParser, QueryTerms, IdentifierSegments) |
| `project-config.ts` | `Config/ProjectConfig.cs` |
| `utils.ts` subset (Mutex/FileLock/normalizePath/validatePathWithinRoot/isConfigLeafNode), `errors.ts` | `Support/` |
| `directory.ts` data-dir mgmt (create/validate/remove/isInitialized/CODEGRAPH_DIR) | `Support/DataDir.cs` |

**DROP — OpenCowork already provides it (with reasoning):**

| Dropped | Why | OpenCowork replacement |
|---|---|---|
| `bin/**` (24-command CLI) | RPC is the interface; no terminal front-end ships to users | `codegraph/*` worker RPCs + renderer UI |
| `installer/**` (8 agent targets) | OpenCowork wires its **own** agents/tools (`registerAllTools`); it doesn't install into external CLIs | app's tool-registration path |
| `upgrade/**` | OpenCowork has `updater.ts` + electron-updater | app auto-update |
| `telemetry/**` | phones home to `getcodegraph.com`; not our infra | none (or app's own opt-in) |
| `ui/**` (shimmer/glyphs) | terminal ANSI; OpenCowork renders in React | index progress streams as a `WorkerMessagePackEvent` (doc 06 §5) |
| `sync/watcher.ts` (912) + `watch-policy.ts` | **the worker is already a daemon and the app already watches files** (see §6.2) | app file-change signals → `codegraph/sync` RPC |
| `sync/git-hooks.ts` | git hooks existed only for the standalone CLI when the watcher was off; irrelevant when the app drives sync | app orchestration |
| `directory.ts` frontload heuristics | front-load hook is an MCP/agent-integration feature (doc 04), not the engine | architect decides if reproduced |
| `reopenIfReplaced` (maybe) | POSIX-only stale-handle heal; only needed if engine instances are cached across `recreate` | keep only if caching engines |

### 6.1 Module boundary & namespaces

One new worker module, following the `Modules/<Name>/` convention (doc 06):

```
Modules/CodeGraph/
  CodeGraphModule.cs          // IWorkerModule — registers codegraph/* RPCs
  CodeGraphEngine.cs          // the reproduced facade (per-project, cached)
  CodeGraphModels.cs          // source-gen DTOs (Node, Edge, Subgraph, …)
  Scanning/  DirectoryScanner.cs · GitFileEnumerator.cs · ScopeIgnore.cs
             GitIgnoreMatcher.cs · LanguageMap.cs · FileClassifier.cs
  Context/   ContextBuilder.cs · ContextFormatter.cs · CallPaths.cs
  Search/    QueryParser.cs · QueryTerms.cs · IdentifierSegments.cs
  Config/    ProjectConfig.cs
  Support/   DataDir.cs · PathSafety.cs · IndexLock.cs
  Db/        (graph DB — separate file; DbConnectionFactory/Migrator pattern, doc 03/06)
```

Register in `Hosting/WorkerModuleCatalog.cs`. All DTOs crossing IPC go in a
`JsonSerializerContext` (doc 06 §4) — critical: `Subgraph.nodes` serializes as an
**array**, not a JS `Map`.

### 6.2 Sync / watcher design — **the KEY recommendation: do NOT port the watcher**

Rationale, from three confirmed facts:
1. The worker is a **long-lived sidecar daemon** (`CONTEXT-BRIEF` §Process
   model) — CodeGraph's watcher exists mostly to give a *standalone CLI* the
   daemon behavior the OpenCowork worker already has natively.
2. **The OpenCowork app already watches files** — `src/main/ipc/fs-handlers.ts`
   runs `fs.FSWatcher` per-directory watching with debounced `fs:file-changed`
   IPC events and its own ignore filtering (`shouldIgnoreWatchedDirectory`).
   Duplicating a second watcher inside the C# worker means two watch sets over
   the same tree, double the inotify/FSEvents cost, and the exact fd-exhaustion
   class CodeGraph spent a dozen issues fixing.
3. `FileSystemWatcher` in .NET is lossy under load and would need its own
   port of the WSL policy, inotify-cap, degrade, and per-platform strategy — 912
   lines of the highest-risk infra in the area — for capability the app already
   has.

**Design:** expose an incremental **`codegraph/sync` RPC** (equivalent to
`CodeGraph.sync()`), and let the **app** decide when to call it:
- Debounce the app's existing file-change signal (the app already has the
  2 s-style debounce machinery) and call `codegraph/sync` for the affected
  project. Optionally pass the changed paths so the engine can take the
  git-scoped fast path directly (skip `git status`).
- Keep the internal **change-detection** (git `status`/FS re-hash) — that's the
  *engine's* job inside `sync`, and it's cheap. Only the **OS watch layer** is
  dropped.
- Reproduce `getPendingFiles()`/staleness as: the app knows what changed since
  the last `codegraph/sync` completed, so the "results may be stale" banner is
  the app's to render — expose `getLastIndexedAt()` / `getIndexState()` so it
  can. If a per-file stale list is wanted, the app supplies it (it has the
  signal) rather than the worker re-deriving it.

Keep the **worktree-mismatch** check (`sync/worktree.ts`) — it's cheap, pure
`git rev-parse`, and useful as a `codegraph/*` diagnostic. Drop git-hooks and
watch-policy.

### 6.3 `CodeGraphEngine` shape

```csharp
internal sealed class CodeGraphEngine : IDisposable {
  // per-project; cached by projectRoot in the module (the daemon holds them open)
  static Task<CodeGraphEngine> OpenAsync(string root, OpenOptions o);
  static CodeGraphEngine Init(string root, InitOptions o);
  Task<IndexResult> IndexAllAsync(IProgress<IndexProgress>?, CancellationToken);
  Task<SyncResult>  SyncAsync(IReadOnlyList<string>? changedHint, CancellationToken);
  SearchResult[]    SearchNodes(string q, SearchOptions? o);
  SegmentMatch[]    GetSegmentMatches(string[] words, int limit = 6);
  Subgraph          Traverse(string id, TraversalOptions? o);
  Subgraph          GetCallGraph(string id, int depth = 2);
  IReadOnlyList<NodeEdge> GetCallers(string id, int depth = 1);   // + GetCallees
  Subgraph          GetImpactRadius(string id, int depth = 3);
  Task<TaskContext> BuildContextAsync(TaskInput input, BuildContextOptions? o);
  Task<Subgraph>    FindRelevantContextAsync(string q, FindRelevantContextOptions? o);
  // …the full §3.1 surface
}
```

- Concurrency: a `SemaphoreSlim(1,1)` replaces the in-process `Mutex`; `IndexLock`
  (PID file) is optional (see §5.7) — start with just the semaphore since the
  daemon is the sole writer, add the PID file only if external writers are
  confirmed.
- Progress streams via `IProgress<IndexProgress>` → the module bridges it to a
  `WorkerMessagePackEvent` stream (doc 06 §5.1) so the renderer shows index
  progress. This replaces the `ui/` shimmer.
- Cancellation via `CancellationToken` (replaces `AbortSignal`); pair with a
  separate `codegraph/cancel` RPC + a run registry (doc 06 §5.3) since a token
  can't cross the RPC boundary.

### 6.4 Scanning design

- `GitFileEnumerator` — shells `git` (reuse `GitTools` process helper, bounded
  timeouts) for `ls-files -z -s --recurse-submodules` + `-o --exclude-standard`,
  reproducing embedded-repo/gitlink/worktree recursion. `null` on non-git →
  `DirectoryScanner` FS walk.
- `GitIgnoreMatcher` — reproduce git semantics for defaults + FS-walk fallback +
  `include`/`exclude`/`includeIgnored`. **Extend, don't reuse as-is,** the
  worker's `IgnoreMatcher` (it lacks negations/nested). `ScopeIgnore` is the
  single shared indexer+sync scope object (per §2.5 precedence).
- `LanguageMap` — a `FrozenDictionary<string,Language>` for `EXTENSION_MAP` +
  the `.h` content heuristic + special-filename cases + user overrides.
- `FileClassifier` — `IsGenerated`/`IsTest` regex sets (`[GeneratedRegex]`).

### 6.5 Context & search classes

- `ContextBuilder.FindRelevantContext` — port the channel pipeline verbatim
  (§2.7), each channel a private method returning scored candidates, merged by
  `max`. Keep all constants. `Subgraph` uses an insertion-ordered node map
  (`List<Node>` + `Dictionary<string,int>`).
- `ContextFormatter` — markdown/JSON (generated-last re-sort); `CallPaths` — the
  DFS-over-`calls` chain builder.
- `QueryParser`/`QueryTerms`/`IdentifierSegments` — direct ports; the
  identifier-segment splitter feeds `name_segment_vocab` writes in the storage
  layer (doc 03).

---

## 7. MVP vs later

**MVP (first working, agent-useful slice):**
1. `CodeGraphEngine` lifecycle: `Init`/`Open`/`IndexAll`/`Close` + the graph DB
   (doc 03) and extraction (doc 01) plugged in.
2. **Scanning**: git-path `GitFileEnumerator` + `ScopeIgnore` with defaults +
   root `.gitignore` (+ negations) + `LanguageMap` + `isSourceFile`. FS-walk
   fallback. (include/exclude/includeIgnored can be v1.1.)
3. `SearchNodes` + the graph read methods (`GetCallers`/`GetCallees`/
   `GetImpactRadius`/`Traverse`) — the highest-utility agent surface.
4. `BuildContext` / `FindRelevantContext` with the **full** ranking pipeline
   (this is the product; a degraded version isn't worth shipping).
5. `codegraph/sync` RPC wired to the app's file-change signal (no worker
   watcher).
6. Index progress streaming as a worker event.
7. `project-config.ts` `extensions` override (cheap, unblocks non-standard
   extensions); `getStats`/`getIndexState`/`isIndexStale`.

**Later:**
- `include`/`exclude`/`includeIgnored` config + embedded-repo/submodule/gitlink
  recursion + nested per-dir `.gitignore` in the FS walk (correctness polish;
  monorepo/super-repo cases).
- `getSegmentMatches` + `name_segment_vocab` heal (front-load-hook tier — only
  if the hook is reproduced).
- `getRoutingManifest`/`getTopRouteFile`, `findCircularDependencies`/
  `findDeadCode`/`getNodeMetrics` (nice-to-have analytics).
- `recreate` + `reopenIfReplaced` (only if engines are cached across rebuilds).
- worktree-mismatch diagnostic.
- PID `FileLock` (only if external writers materialize).

---

## 8. Open questions / decisions for the architect

1. **Watcher: confirm the DROP.** I recommend **not** porting `sync/watcher.ts`
   and instead driving `codegraph/sync` from the app's existing
   `fs:file-changed` pipeline (§6.2). Confirm the app's watcher covers the
   project trees CodeGraph indexes with acceptable latency, and decide who
   renders the "stale results" banner (worker exposes `lastIndexedAt`/state; app
   owns per-file staleness). **This removes ~1000 lines of the riskiest infra.**

2. **Cross-process `FileLock`: keep or collapse to in-process?** If the daemon is
   the sole writer (no git hooks, no second CLI), a `SemaphoreSlim` suffices and
   we drop the PID-lockfile machinery. Confirm nothing else writes the graph DB.

3. **Is the front-load prompt hook reproduced at all?** If yes, the ~29-language
   structural-keyword tables + `getSegmentMatches` + `planFrontload` monorepo
   scanner come along (and the multilingual-regex/AOT risk with them). If the
   hook is an MCP-integration concern owned by doc 04's surface (or dropped),
   most of `directory.ts` and `identifier-segments.ts` become optional. **This
   is the single biggest scope lever in this area.**

4. **git dependency.** CodeGraph assumes `git` on PATH for its fast paths (with a
   FS-walk fallback). Is `git` guaranteed in the OpenCowork user environment, or
   must the FS-walk path be first-class (and reproduce git's ignore algorithm
   fully, raising risk #1)? The worker already shells `git` for its Git module,
   suggesting it's assumed present.

5. **`SearchResult.score` scale parity.** The ranking heuristics assume FTS5
   BM25 magnitudes on a specific scale mixed with ~0–1 exact/fuzzy scores.
   Storage (doc 03) must confirm the C# FTS5 `bm25()` output matches, or the
   `×`-multiplier re-ranks mis-weight. Cross-team check with the storage doc.

6. **How much ranking fidelity is "good enough"?** `findRelevantContext` is
   ~450 lines of tuned constants. Do we commit to a byte-for-byte port validated
   by fixture replay against `context-ranking.test.ts`, or accept a "spirit-of"
   reimplementation with regression tolerance? This decides the QA budget for the
   highest-value method in the port.

7. **Reuse vs fork of the worker's `IgnoreMatcher`.** It's insufficient as-is
   (no negations/nested). Extend it in place (risk of diverging the File
   module's grep/glob behavior) or write a separate `GitIgnoreMatcher` for
   CodeGraph? I lean separate, to keep CodeGraph's stricter git semantics from
   perturbing the existing `fs/glob`/`fs/grep` tools.
