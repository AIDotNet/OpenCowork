# WS-B · Golden-Test Fidelity Harness

> **Workstream owner deliverable.** CodeGraph ships **139 `__tests__/*.test.ts`**
> files (run under **Vitest 2.1.9**, `vitest run`). They are the *behavioral spec*
> for a port that is dense with heuristics, tuned constants, and AST special-cases —
> the exact code that drifts silently under a "spirit-of" rewrite. This workstream
> ports the highest-leverage suites to the C# worker **before** the code they cover,
> so every milestone lands as red→green TDD against CodeGraph's own oracle.
>
> Anchors: [`00-overview-and-roadmap.md`](../00-overview-and-roadmap.md) §5 (milestones),
> §6 (WS-B), §8 (risks **R4** AST-walk, **R5** ranking constants). Ground truth:
> the CodeGraph clone at `…/scratchpad/codegraph/__tests__/`.

---

## 0. What the CodeGraph tests actually are (fixture-style survey)

Skimmed ~15 representative suites. There is **no shared fixtures directory** and
**no golden `.txt`/`.snap` files** — every fixture is a source string written into a
`fs.mkdtempSync` temp dir inside the test, then indexed. Assertions are inline
literal expectations. Five distinct styles recur, and the C# port strategy differs
per style:

| # | Style | Example suites | What it looks like | C# port approach |
|---|---|---|---|---|
| **S1** | **Pure-function unit** | `search-query-parser`, `identifier-segments`, `context-ranking` (top block), `strip-comments`, `is-test-file`, `generated-detection`, `extension-mapping` | Imports one function, asserts `f(input) === literal`. No DB, no fs. | **Direct 1:1 port.** These are the cheapest, highest-value **regex/algorithm-parity oracles**. Port the input/expected pairs verbatim into `[Theory]`/`[InlineData]`. |
| **S2** | **Seeded-DB (in-memory graph stub)** | `db-perf`, `graph`, `iterate-nodes-by-kind`, `lru-cache`, `symbol-lookup`, `wal-deferral` | Build `Node`/`Edge` via a local `makeNode()` factory, `insertNodes`, then assert traversal/query results. No tree-sitter. | Port the `makeNode` factory to a C# test builder over `CodeGraphStore`; use a temp on-disk SQLite (or `:memory:` where WAL isn't under test). No grammar dependency ⇒ **these can land in M1 before extraction exists.** |
| **S3** | **End-to-end index + SQL assertion** | all `*-synthesizer`, `frameworks`, `spring-event-synthesizer`, `resolution`, `extraction` | Write real source files → `CodeGraph.init(dir)` → `indexAll()` → run raw SQL over `edges`/`nodes` and assert names/counts. | Port fixtures as embedded string resources; drive `CodeGraphEngine.IndexAll`; assert via the same SQL over the graph DB. **Requires the grammar for that language to be built** — gates the suite to its milestone. |
| **S4** | **Fixture-replay ranking** | `context`, `context-ranking`, `explore-corroboration-ranking`, `explore-*` | Index a hand-built repo, call `findRelevantContext(query)`, assert **ordering/identity/confidence** of `roots` + markdown markers. | **The R5 golden replay.** Capture CodeGraph's *actual* output on each fixture (see §3.4) as a checked-in golden, assert C# reproduces order + confidence. |
| **S5** | **Tool-boundary / MCP** | `mcp-unindexed`, `mcp-tool-allowlist`, `same-name-disambiguation`, `mcp-catchup-gate`, `dynamic-boundaries` | Either call `ToolHandler.execute(tool, args)` directly and assert on `content[0].text`, **or** `spawn` the CLI and speak JSON-RPC over stdio. | Port the **direct `ToolHandler.execute` variant only** — assert on the returned text/`isError` shape. The `spawn`+JSON-RPC transport is dropped (Option A, Decision 8); re-host those invariants onto direct `CodeGraphToolHandler` calls. |

Key consequence: because fixtures are inline source strings (not opaque binaries),
**porting a suite = translating its `describe/it` bodies**, not wrangling a fixture
pipeline. The one place that needs a *new* asset pipeline is S4 (captured golden
outputs), because CodeGraph asserts those inline against a build we must first
reproduce.

---

## 1. Full test inventory

139 files. Columns: **LOC** (approx), **subsystem**, **invariant pinned**,
**fixture style** (S1–S5 above), **milestone that must port it first** (or **DROP**).
Milestone = *port this test before writing the code it covers.*

### 1.1 M1 — Storage & graph core (port these first as the TDD harness)

| File | LOC | Subsystem | Invariant pinned | Style | M |
|---|--:|---|---|---|---|
| **`graph.test.ts`** ★ | 615 | graph traversal | callers/callees/impact/path/type-hierarchy over a seeded graph; the #1086–#1090 edge-completeness/limit invariants | S2/S3 | **M1** |
| **`db-perf.test.ts`** ★ | 361 | store | batch `getNodesByIds` (Map keyed by id, omits missing); LRU invalidation on `INSERT OR REPLACE`; `insertEdges` endpoint-validate from DB not cache; `runMaintenance` no-throw | S2 | **M1** |
| `iterate-nodes-by-kind.test.ts` | 62 | store | streamed set == eager set; cursor survives interleaved queries on same connection (Decision 20) | S2 | **M1** |
| `symbol-lookup.test.ts` | 222 | store | by-name / qualified / lower / exact node lookups | S2 | **M1** |
| `wal-deferral.test.ts` | 217 | store/WAL | `resolveWalValveMb` fallbacks; autocheckpoint read/write; indexAll defers checkpoint + restores interval; identical graph with/without deferral | S2 | **M1** (valve trigger/backpressure part → M6) |
| `foundation.test.ts` | 526 | core types | node-id formula, kind/edge/language vocab, basic utils | S1/S2 | **M1** |
| `integration/lru-cache.test.ts` | 96 | store | LRU eviction + invalidation semantics | S2 | **M1** |

### 1.2 M2 — Extraction engine

| File | LOC | Subsystem | Invariant pinned | Style | M |
|---|--:|---|---|---|---|
| **`extraction.test.ts`** ★ | 11,010 | extraction | language detection, per-language node emission, `contains` edges, unresolved-ref emission, C/C++ macro-blanking helpers | S1+S3 | **M2** |
| `extension-mapping.test.ts` | 157 | extraction | `EXTENSION_MAP` → language | S1 | **M2** |
| `generated-detection.test.ts` | 47 | extraction | `isGenerated` heuristics | S1 | **M2** |
| `ts-field-classification.test.ts` | 159 | extraction | TS class-field kind classification | S3 | **M2** |
| `object-literal-methods.test.ts` | 176 | extraction | methods on object literals become nodes | S3 | **M2** |
| `function-ref.test.ts` | 790 | extraction | function-reference edges | S3 | M2 code / **M6** (value/function-refs deferred §5-M2) |
| `value-reference-edges.test.ts` | 724 | extraction | value-reference edges | S3 | **M6** (deferred) |
| `lombok.test.ts` | 156 | extraction (Java) | Lombok `@Data`/`@Getter` synthetic members | S3 | **M6** (framework-specific extractor deferred) |

### 1.3 M3 — Resolution, frameworks & MVP synthesizers

| File | LOC | Subsystem | Invariant pinned | Style | M |
|---|--:|---|---|---|---|
| **`resolution.test.ts`** ★ | 4,667 | resolution | 3-pass resolve, import resolution, name-matching, unresolved-ref lifecycle | S3 | **M3** |
| **`frameworks.test.ts`** ★ | 1,743 | frameworks | route→handler edges across the framework catalog (the regex-parity oracle) | S3 | **M3** (MVP subset), M6 (tail) |
| `frameworks-integration.test.ts` | 1,338 | frameworks | end-to-end framework edges on realistic layouts | S3 | **M3**/M6 |
| `php-property-receiver-resolution.test.ts` | 342 | resolution (PHP) | `$this->prop->method()` receiver-type inference | S3 | **M3** (PHP is MVP top-6) |
| `react-hoc-component.test.ts` | 145 | frameworks (React) | HOC-wrapped component recognized (react is MVP) | S3 | **M3** |
| `pr19-improvements.test.ts` | 719 | resolution | assorted resolution precision fixes | S3 | **M3** |
| `orphaned-refs-sweep.test.ts` | 231 | resolution | orphaned unresolved-ref cleanup, rowId-precise | S3 | **M3** |
| `batched-ref-cleanup.test.ts` | 121 | resolution | batched ref delete + non-progress guard | S3 | **M3** |
| `strip-comments.test.ts` | 134 | resolution util | `stripComments` preserves offsets/semantics | S1 | **M3** |
| `same-name-disambiguation.test.ts` | 141 | resolution + tool | distinct same-name defs stay distinct; callers/impact don't merge blast radii | S5 | **M3** (resolution) / M5 (render) |

**MVP synthesizer set (Decision, §5-M3 = 7 units).** CodeGraph has no single
"mvp-synthesizer" test; the MVP synthesizers (`goMethodContains`, `goImplements`,
`interfaceOverride`, `fieldChannel`, `eventEmitter`, `reactRender`, `reactJsxChild`)
are covered *inside* `resolution.test.ts` / `frameworks.test.ts` / `graph.test.ts`
and by `dynamic-boundaries.test.ts` (M5). The **standalone `*-synthesizer.test.ts`
files all cover the deferred tail → M6** (§1.6). Use `spring-event-synthesizer.test.ts`
as the **canonical parity-oracle template** (§3.5) even though the synthesizer itself
is M6 — its structure (fixture → indexAll → SQL on `synthesizedBy`) is the pattern
every synthesizer test follows.

### 1.4 M4 — Facade, scanning, sync, context & search

| File | LOC | Subsystem | Invariant pinned | Style | M |
|---|--:|---|---|---|---|
| **`context-ranking.test.ts`** ★ | 189 | context (R5) | `isDistinctiveIdentifier`, `scorePathRelevance` (#720 per-word), project-name down-weighting, common-word demotion, low-confidence handoff marker | S1+S4 | **M4** |
| **`context.test.ts`** ★ | 374 | context (R5) | `findRelevantContext` root selection + shape | S4 | **M4** |
| `search-query-parser.test.ts` | 142 | search | `parseQuery` field extraction (`kind:/lang:/path:/name:`), quoted spans, URL passthrough, invalid-kind fallback; `boundedEditDistance` | S1 | **M4** |
| `identifier-segments.test.ts` | 103 | search | `splitIdentifierSegments` (camel/acronym/digit/snake), `extractProseCandidates` (diacritics, CJK), `segmentLookupVariants` (#1145 plural folding) | S1 | **M4** |
| `segment-vocab.test.ts` | 221 | search/store | `name_segment_vocab` materialization + lookup | S2/S3 | **M4** (coupled to front-load product call §7.3) |
| `explore-nl-stopword-collision.test.ts` | 125 | search | NL stopword vs identifier collision | S1/S4 | **M4** |
| `explore-corroboration-ranking.test.ts` | 122 | context (R5) | corroborated-symbol ranking | S4 | **M4** |
| `sync.test.ts` | 759 | facade/sync | incremental re-index: add/modify/delete reflect in graph; stale-node cleanup | S3 | **M4** |
| `multi-repo-workspace.test.ts` | 441 | scanning | monorepo/workspace multi-root discovery | S3 | **M4** |
| `include-config.test.ts` | 262 | config/scan | `include` globs | S3 | **M4** |
| `exclude-config.test.ts` | 165 | config/scan | `exclude` globs | S3 | **M4** |
| `include-ignored-config.test.ts` | 144 | config/scan | force-include of otherwise-ignored paths | S3 | **M4** |
| `android-res-exclusion.test.ts` | 85 | scanning/ignore | android `res/` generated-noise exclusion | S3 | **M4** |
| `is-test-file.test.ts` | 53 | scanning | `isTestFile` classifier | S1 | **M4** |
| `config-secret-redaction.test.ts` | 102 | context | config-leaf secret redaction (#383) | S3/S1 | **M4** |
| `node-file-view.test.ts` | 118 | facade read | per-file node view | S3 | **M4** |
| `security.test.ts` | 687 | support/PathSafety | path-traversal refusal, unsafe root refusal | S1/S3 | **M4** |
| `unsafe-index-root.test.ts` | 52 | support/PathSafety | refuse `/`, `$HOME`, etc. as index root | S1 | **M4** |
| `worktree-detection.test.ts` | 362 | facade | git-worktree detection/diagnostic | S3 | **M4** (diagnostic part → M6) |
| `integration/full-pipeline.test.ts` | 272 | facade | scan→extract→resolve→query end-to-end | S3 | **M4** |

### 1.5 M5 — Tool surface & agent integration (explore-first)

| File | LOC | Subsystem | Invariant pinned | Style | M |
|---|--:|---|---|---|---|
| `mcp-unindexed.test.ts` | 265 | tool policy | un-indexed path returns **success-shaped guidance, never `isError`**; per-project instructions variant | S5 | **M5** (re-host to direct handler) |
| `dynamic-boundaries.test.ts` | 393 | explore | dynamic-dispatch surfacing at explore boundaries | S5 | **M5** |
| `adaptive-explore-sizing.test.ts` | 394 | explore budget | `getExploreBudget` monotonic with repo size | S3/S1 | **M5** |
| `explore-output-budget.test.ts` | 280 | explore budget | `getExploreOutputBudget` monotonic | S3/S1 | **M5** |
| `explore-result-count.test.ts` | 94 | explore | result-count bounds | S5 | **M5** |
| `explore-blast-radius.test.ts` | 73 | explore | impact blast-radius surfacing | S5 | **M5** |
| `explore-synth-constant-endpoints.test.ts` | 86 | explore | synthesized-edge endpoint surfacing | S5 | **M5** |
| `mcp-tool-allowlist.test.ts` | 63 | tool policy | `CODEGRAPH_MCP_TOOLS` allowlist gating | S5 | **M5** |
| `mcp-tool-annotations.test.ts` | 105 | tool defs | read-only annotations present | S5 | **M5** |
| `mcp-require-project-path.test.ts` | 104 | tool policy | require-`projectPath` transform | S5 | **M5** |
| `mcp-staleness-banner.test.ts` | 212 | tool policy | staleness/degraded notice in output | S5 | **M5** |
| `mcp-catchup-gate.test.ts` | 173 | tool policy | catch-up gate before serving stale reads | S5 | **M5** |
| `mcp-files-path-normalization.test.ts` | 113 | tool | files-tool path normalization | S5 | **M5** |
| `integration/mcp-input-limits.test.ts` | 109 | tool | input-size limits/validation | S5 | **M5** |
| `status-json.test.ts` | 147 | facade/status | `status` JSON shape (→ `codegraph/status` RPC) | S5/S3 | **M5** |

### 1.6 M6 — Deferred tail (port when the ecosystem ships)

All **standalone dynamic-edge synthesizers** (S3): `spring-event-synthesizer` (132,
parity template), `c-fnptr-synthesizer` (369, R8), `nix-option-synthesizer` (269),
`rtk-query-synthesizer` (197), `erlang-behaviour-synthesizer` (190),
`redux-thunk-synthesizer` (129), `celery-dispatch-synthesizer` (129),
`sidekiq-dispatch-synthesizer` (128), `mediatr-dispatch-synthesizer` (128),
`vuex-dispatch-synthesizer` (100), `pinia-store-synthesizer` (108),
`closure-collection-synthesizer` (159), `object-registry-synthesizer` (83),
`laravel-event-synthesizer` (169); `synthesis-tail-scaling` (103).

**Ecosystem framework/language tails** (S3): `drupal` (609), `arkts-resolution` (428),
`react-native-bridge` (342), `rn-event-channel` (160), `fabric-view` (144),
`expo-modules` (207), `swift-objc-bridge-resolver` (205), `swift-objc-bridge` (189),
`cfml-receiver-inference` (185), `cfml-inheritance-resolution` (132), `goframe` (181),
`gin-middleware-chain` (113), `mybatis-extractor-robustness` (218),
`vue-store-extraction` (138). Plus deferred extraction: `function-ref` (790),
`value-reference-edges` (724), `lombok` (156). Optional product feature (§7.3):
`frontload-hook` (323).

### 1.7 DROP — dropped subsystems (do **not** port; see §4)

`installer-targets` (1711), `watcher` (712), `upgrade` (663), `mcp-daemon` (460),
`npm-shim` (312), `telemetry` (294), `daemon-socket-fallback` (246), `update-check`
(243), `parse-pool` (239), `remove-binary` (228), `prepare-release` (221),
`index-command` (207), `query-pool` (198), `liveness-watchdog` (197),
`mcp-initialize` (183), `daemon-client-liveness` (181), `mcp-roots` (180),
`mcp-ppid-watchdog` (173), `glyphs` (170), `ppid-watchdog` (167), `concurrent-locking`
(152), `git-hooks` (129), `index-orphan-watchdog` (120), `db-reopen-on-replace` (117),
`install-sh-prune` (113), `daemon-manager` (113), `startup-handshake` (108), `npm-sdk`
(107), `mcp-startup-orphan` (106), `installer` (104), `daemon-registry` (103),
`fatal-handler` (100), `daemon-bind-failure` (94), `wasm-runtime-flags` (87),
`watch-policy` (82), `cooperative-yield` (82), `cli-version` (80), `cli-node-command`
(80), `proxy-connect` (78), `node-sqlite-backend` (71), `subprocess-timeouts` (70),
`node-version-check` (69), `cli-query-command` (65), `cli-affected-paths` (63),
`mcp-debounce-env` (47), `stdin-teardown` (46), `sqlite-backend` (44),
`grammar-wasm-bytes` (43), `daemon-attach-log` (38).

**Tally:** ~**7 M1 · 8 M2 (5 core + 3 deferred) · 10 M3 · 20 M4 · 15 M5 · ~33 M6 ·
~49 DROP.** ~**60 suites carry MVP behavior (M1–M5)**; the rest is demand-driven tail
or dropped infra.

---

## 2. Port-order plan (grouped by milestone)

TDD rule for the whole workstream: **write the C# test (red) before the production
code, using CodeGraph's asserted values as the expectation.** Within a milestone,
port the "harness set" first — those establish the test project and the domain
builders every later suite reuses.

### M1 — the TDD harness bootstrap
1. **Port `graph.test.ts` + `db-perf.test.ts` first.** They need only
   `CodeGraphStore` + `CodeGraphTraverser` (no tree-sitter), so they can go red
   before extraction exists. They also force the `makeNode`/`makeEdge` C# builders
   (§3.2) into existence — reused by every later S2/S3 suite.
2. Then `iterate-nodes-by-kind`, `symbol-lookup`, `lru-cache`, `wal-deferral`
   (checkpoint-deferral half), `foundation`.
- **Exit gate:** all M1 suites green ⇒ storage/graph is spec-correct before M2 piles
  extraction on top.

### M2 — extraction goldens
1. Port the **pure-function slices of `extraction.test.ts` first** (language
   detection, `EXTENSION_MAP`, C/C++ macro-blanking helpers, `generated-detection`,
   `extension-mapping`) — S1, no grammar needed, they de-risk the walk's helpers.
2. Then the S3 per-language node-emission blocks, **gated by grammar availability**
   (only the 8 MVP grammars) — `ts-field-classification`, `object-literal-methods`,
   plus the TS/Go/Python/Java/C#/Rust/JS blocks inside `extraction.test.ts`.
- **Exit gate:** node counts stable across re-index; golden extraction blocks green;
  and (Decision 10 / **R1**) a full-core index of the fixture corpus does not trip
  `worker/ping` — add a load test asserting ping latency during index.

### M3 — the `*-synthesizer` regex-parity oracle
1. Port `strip-comments`, `search`-adjacent pure utils first (S1).
2. Port `resolution.test.ts` + `frameworks.test.ts` as the resolution spine.
3. For each MVP synthesizer, port the matching assertions out of
   `resolution`/`frameworks`/`graph`, using `spring-event-synthesizer.test.ts`'s
   structure (§3.5) as the template. **This is where R4/regex parity (Decision 23)
   is enforced** — every JS regex ported to `System.Text.RegularExpressions` is
   validated against these fixtures before the synthesizer is trusted.
- **Exit gate:** connected graph across a React re-render + JSX-child boundary; no
  edge explosion; synthesized edges carry `provenance:'heuristic'` + `synthesizedBy`.

### M4 — context-ranking fixture-replay (R5)
1. Port the **S1 top block of `context-ranking.test.ts` first**
   (`isDistinctiveIdentifier`, `scorePathRelevance`, `deriveProjectNameTokens`,
   `boundedEditDistance`, `identifier-segments`, `search-query-parser`) — cheap,
   exact, and they pin the ranking primitives.
2. Then the **S4 fixture-replay blocks** (`context`, `context-ranking` end-to-end,
   `explore-corroboration-ranking`): capture CodeGraph's real `roots` ordering +
   `confidence` on each fixture (§3.4) and assert C# reproduces them **channel-by-
   channel with exact constants** (Decision, §5-M4).
3. Then scanning/sync/config suites.
- **Exit gate:** `FindRelevantContext` reproduces the golden fixtures exactly (order
  + confidence + low-confidence marker); edit → `codegraph/sync` reflects the change.

### M5 — tool-boundary policy
1. Port `mcp-unindexed` + `mcp-tool-allowlist` first (the two the analyses cite) —
   they pin the **error-classification contract** (`NotIndexed → success-shaped`,
   `PathRefusal → isError`) that makes the whole toolset agent-safe.
2. Then the explore-budget + annotation + staleness suites.
- **Exit gate:** explore answers a flow query with 0 Read/Grep; un-indexed root
  returns success-shaped guidance.

---

## 3. The C# harness design

### 3.1 Framework & project layout — **xUnit**

Recommend **xUnit** (the .NET default; `[Fact]`/`[Theory]`+`[InlineData]` map
cleanly onto Vitest `it`/`it.each`, and its per-test class instantiation mirrors
Vitest `beforeEach`). Add **one** test project, kept out of the AOT publish graph:

```
sidecars/OpenCowork.Native.Worker.Tests/
  OpenCowork.Native.Worker.Tests.csproj   # net10.0, NOT PublishAot; xunit + xunit.runner.visualstudio
  Harness/
    CodeGraphTestDb.cs        # temp-dir graph DB open/dispose (IDisposable/IAsyncLifetime)
    GraphBuilder.cs           # makeNode/makeEdge → CodeGraphStore (S2)
    FixtureRepo.cs            # write source strings to a temp repo, IndexAll (S3/S4/S5)
    GoldenStore.cs            # load/compare captured ranking goldens (S4)
  M1_Storage/  graph, db-perf, iterate-nodes-by-kind, symbol-lookup, wal-deferral, foundation, lru-cache
  M2_Extraction/  extraction (split per language), extension-mapping, generated-detection, …
  M3_Resolution/  resolution, frameworks, synthesizers, …
  M4_Context/  context-ranking, context, search-query-parser, identifier-segments, sync, scanning, …
  M5_Tools/  mcp-unindexed, explore-*, mcp-tool-*, status-json
  Fixtures/
    Goldens/    *.golden.json   # captured CodeGraph ranking outputs (S4)
    Repos/      *.cs/.ts/.go embedded or on-disk sample sources (optional; most stay inline)
```

**csproj wiring.** The worker is `OutputType=Exe`, `PublishAot=true`,
`JsonSerializerIsReflectionEnabledByDefault=false` — a normal test project cannot
`ProjectReference` an Exe and exercise its internals cleanly, and AOT/reflection-free
constraints don't apply to a JIT'd test host. Two clean options:

- **Preferred:** convert the worker to a **library + thin `Program.cs` Exe** (or add
  `<InternalsVisibleTo Include="OpenCowork.Native.Worker.Tests"/>` and reference the
  Exe project). Test project targets `net10.0` **without** `PublishAot` and **with**
  reflection-enabled JSON — it tests the *engine types* directly, not the published
  binary.
- Add an `.slnx`/`.sln` so `dotnet test` discovers it; **do not** add the test project
  to any `dotnet publish` path. Keep the same `Microsoft.Data.Sqlite 10.0.9` +
  `SQLitePCLRaw.bundle_e_sqlite3 3.0.3` versions as the worker so FTS5/bm25 behavior
  matches byte-for-byte (Decision 2, **R11**).

Tree-sitter native libs must be on the test host's load path (copy the built grammar
libs into the test `bin/` via a build target) — otherwise S3/S4/S5 suites can't index.

### 3.2 In-memory graph stub (for `graph.test.ts` / S2)

CodeGraph's `makeNode()` factory (seen in `db-perf.test.ts`) is a plain object with
`id, kind, name, qualifiedName, filePath, language, startLine, endLine, startColumn,
endColumn, updatedAt`. Port it as a C# builder that writes straight into
`CodeGraphStore` over a **temp on-disk SQLite** (WAL matters for `wal-deferral`;
elsewhere `:memory:` is fine and faster):

```csharp
static CodeGraphNode MakeNode(string id, string name = null, string kind = "function") =>
    new() { Id = id, Kind = kind, Name = name ?? id, QualifiedName = name ?? id,
            FilePath = "a.ts", Language = "typescript",
            StartLine = 1, EndLine = 1, StartColumn = 0, EndColumn = 0,
            UpdatedAt = /*fixed clock*/ };
```

Key point: `graph.test.ts` is *not* a mock/interface stub — it seeds a **real store**
and exercises the real traverser. So the "in-memory stub" is just a **temp SQLite +
the builder**, not a hand-rolled `IGraph` fake. This keeps the traversal invariants
(#1086–#1090: enqueued-vs-visited, per-add limit, mark-before-depth,
record-edge-unconditionally) tested against the shipping code path.

### 3.3 Regex-parity tests (S1)

Port S1 suites as `[Theory]` with the CodeGraph input/expected pairs as
`[InlineData]`. These are the **cheapest defense against R4/R5 drift** and the direct
oracle for Decision 23 (JS↔.NET regex deltas). For each ported regex:
- Assert the exact same match set on the fixture inputs *before* trusting it.
- Where CodeGraph relies on JS `\w`/`\b`/`\d` Unicode semantics, the ported test will
  catch the .NET difference (e.g. `identifier-segments` diacritics/CJK cases,
  `segmentLookupVariants` plural folding). Fix with explicit char classes /
  `RegexOptions.ECMAScript` as needed — the test tells you which.
- Use `[GeneratedRegex]` for the hot static patterns; the parity test runs against
  the generated matcher, so AOT and correctness are validated together.

### 3.4 Fixture-replay for context ranking (S4 — the R5 mechanism)

`context-ranking.test.ts` asserts **ordering and confidence** inline (e.g.
`rootNames[0] !== 'FLAT'`, `capIdx < flatIdx`, `sg.confidence === 'high'`,
markdown contains `LOW_CONFIDENCE_MARKER` + `/codegraph_explore/`). Two-tier approach:

1. **Port the inline ordinal assertions directly** — they are already golden values.
   This alone pins most of R5.
2. **Add a capture-replay safety net for the full ranking vector.** The inline
   assertions only check a few positions; ranking can regress *below* the asserted
   rank. So, one-time, run the **real CodeGraph** (`vitest`/a tiny harness script)
   over each M4 fixture repo, dump `findRelevantContext(query)` → the full ordered
   `roots` list + per-root channel scores + `confidence` into
   `Fixtures/Goldens/<fixture>.golden.json`, and check it in. The C# test rebuilds
   the same fixture, runs `FindRelevantContext`, and asserts the **entire ordered
   vector** matches the golden. Capture the goldens from the pinned CodeGraph commit
   (`…/scratchpad/codegraph`) so they're reproducible.
   - Decision (§7.4) is **byte-for-byte replay** for ranking — this workstream
     implements exactly that: the golden vector is the contract, and any constant the
     port gets wrong shows up as a reordered vector, not a silently-worse answer.

### 3.5 Regex/edge-parity template for synthesizers (S3)

Every `*-synthesizer` test follows one shape (see `spring-event-synthesizer.test.ts`):
write fixture sources → `IndexAll` → `SELECT s.name, t.name, json_extract(metadata,
'$.via') WHERE json_extract(metadata,'$.synthesizedBy')='<id>'` → assert the sorted
target set + a clean-control case that yields **zero** edges. Port this as a reusable
C# helper:

```csharp
IReadOnlyList<(string src, string tgt, string via)> SynthEdges(string synthesizedBy);
```

so each synthesizer test is a few `Assert.Equal(new[]{…}, SynthEdges("spring-event").Where(...))`
calls. The **precision half** (unheard event → no edge; non-annotated helper never a
target) matters as much as the positive half — port both.

### 3.6 Tool-boundary tests (S5, re-hosted)

Where CodeGraph `spawn`s the CLI and speaks JSON-RPC (`mcp-unindexed`,
`mcp-initialize`), **only the invariant is portable, not the transport** (Option A
drops stdio/JSON-RPC). Port by calling `CodeGraphToolHandler.Execute(tool, argsJson)`
directly (as `same-name-disambiguation.test.ts` already does via `handler.execute`)
and asserting on the returned text + `isError` flag. Suites that are *purely* about
the JSON-RPC handshake (`mcp-initialize`, `mcp-roots`, `startup-handshake`) are DROP
(§4) — the invariant they test no longer exists.

---

## 4. What NOT to port (and why)

These pin **dropped subsystems** (roadmap §1 disposition table, Decisions 8/11/12/13/
14, §5-M0). Porting them is wasted effort — the code they cover is never written.

| Dropped subsystem | Tests | Why dropped |
|---|---|---|
| **Daemon / proxy / registry / startup / socket** | `mcp-daemon`, `daemon-socket-fallback`, `daemon-client-liveness`, `daemon-manager`, `daemon-registry`, `daemon-bind-failure`, `daemon-attach-log`, `startup-handshake`, `proxy-connect`, `stdin-teardown`, `mcp-startup-orphan` | Worker is the shared long-lived service (Decision 12). |
| **Watchdogs / liveness / orphan / lock / yield** | `liveness-watchdog`, `ppid-watchdog`, `mcp-ppid-watchdog`, `index-orphan-watchdog`, `fatal-handler`, `concurrent-locking`, `cooperative-yield`, `subprocess-timeouts` | Supervised lifecycle + `SemaphoreSlim` + `GitTools` timeouts replace them (Decisions 12/14). |
| **Query/parse pools** | `query-pool`, `parse-pool` | C# parallelizes RPCs natively; dedicated parse threads replace pools (Decisions 10/11). |
| **CLI** | `cli-version`, `cli-node-command`, `cli-query-command`, `cli-affected-paths`, `index-command` | No CLI; RPC surface only. (`affected-paths` logic lives in `sync.test.ts`.) |
| **Installer / upgrade / release / npm** | `installer`, `installer-targets`, `install-sh-prune`, `remove-binary`, `upgrade`, `update-check`, `prepare-release`, `npm-shim`, `npm-sdk`, `node-version-check` | electron-builder + the worker's own updater replace all of this. |
| **Own file-watcher** | `watcher`, `watch-policy`, `git-hooks`, `mcp-debounce-env` | App's debounced `fs:file-changed` drives `codegraph/sync` (Decision 13). |
| **Telemetry / terminal UI** | `telemetry`, `glyphs` | Not shipped. |
| **WASM runtime / node:sqlite backend / inode self-heal** | `wasm-runtime-flags`, `grammar-wasm-bytes`, `node-sqlite-backend`, `sqlite-backend`, `db-reopen-on-replace` | Native `[LibraryImport]` (no WASM), `Microsoft.Data.Sqlite` (no backend selection), centralized DB eliminates the inode-replace class (Decisions 1/3). |
| **MCP JSON-RPC protocol** | `mcp-initialize`, `mcp-roots` | Option A: no MCP protocol/handshake (Decision 8). *(Their tool-policy cousins — `mcp-unindexed`, `mcp-tool-*` — DO port; the difference is protocol vs policy.)* |

---

## 5. Fidelity-bar guidance (tie to R4 & R5)

Two bars. Pick per-suite; the inventory's fixture-style column tells you which.

### Byte-for-byte fixture replay is **mandatory** where a constant is the product:

- **R5 · context ranking** — `context-ranking`, `context`,
  `explore-corroboration-ranking`, and the `scorePathRelevance`/`isDistinctiveIdentifier`
  primitives. A "close-enough" ranking silently regresses agent quality with no crash.
  Use §3.4 golden-vector replay: the **full ordered `roots` vector + confidence** is
  the contract. Every ranking constant (boosts/dampers/diversity caps, bm25 weights
  `0,20,5,1,2`) must reproduce the golden exactly. This is Decision §7.4 = byte-for-byte.
- **R4 · AST-walk & regex parity** — the S1 regex/segment suites
  (`identifier-segments`, `search-query-parser`, `strip-comments`, C/C++ macro helpers
  in `extraction`) and the S3 synthesizer edge-sets. Node **kind/name/offset** output
  and synthesized **edge identity** must match literally — these are the "6,658 LOC of
  special cases" that drift invisibly. Exact assertion, no tolerance.
- **Node identity & IDs** — `foundation`, `db-perf`, `graph`: the node-id formula and
  edge-identity uniqueness must be internally exact (Decision 17) so caches, dedupe,
  and the Drupal ID-reconstruction stay consistent.

### Behavioral equivalence **suffices** where CodeGraph's own values are incidental:

- **Counts/perf/ordering-agnostic** — `db-perf` (map has 3 entries; missing omitted),
  `iterate-nodes-by-kind` (streamed set **== ** eager set, order-insensitive),
  `wal-deferral` (interval restored; identical graph *with/without* deferral). Assert
  the property, not a magic number.
- **Scanning/config membership** — `include/exclude-config`, `is-test-file`,
  `android-res-exclusion`: assert the *set* of files in/out, not traversal order. The
  underlying ignore engine is a re-implementation (Extend the worker's `IgnoreMatcher`,
  §5-M4 / **R7**), so lean on `git ls-files`/`check-ignore` as the reference where
  possible rather than reproducing CodeGraph's matcher bit-for-bit.
- **Tool-boundary shape** — S5 suites: assert `isError` classification + presence of
  guidance markers/banners, not exact prose. The wording is OpenCowork's to own; the
  **success-shaped-vs-`isError` policy** is the load-bearing invariant.
- **Explore budgets** — `adaptive-explore-sizing`, `explore-output-budget`: assert
  **monotonicity** with repo size (Decision §5-M5), not the specific tier numbers.

Rule of thumb: **if a wrong value would fail loudly (missing node, unresolved edge,
`isError`), behavioral equivalence is enough; if it would fail silently (a worse-but-
plausible ranking or extraction), demand byte-for-byte replay.**
