# CodeGraph → C# Port Analysis: Cross-File Reference Resolution & Framework Synthesizers

> Scope owner deliverable. Analyzes `src/resolution/**` (39 files, ~20.5K LOC) of the
> CodeGraph clone plus the `src/types.ts` ref/edge shapes and the `unresolved_refs`
> table. Cites `file:line` into the clone at
> `…/scratchpad/codegraph/`. Target = OpenCowork .NET 10 native-AOT worker.

---

## 1. Scope & subsystem summary

This subsystem is **phase 2 of indexing**. Extraction (a separate module, out of
scope) parses each file with tree-sitter and writes `nodes`, base `edges`
(`contains`, and whatever the grammar can see locally), and a table of
`unresolved_refs` — every name a symbol referenced that extraction could not bind
(`calls`, `imports`, `extends`, `references`, `function_ref`, …). **Resolution turns
those unresolved refs into cross-file `edges`, then synthesizes framework-specific
edges that no static parse can see.** It is the difference between "a file that
mentions `UserService`" and "this call site → that exact method."

Two distinct engines live here:

| Engine | Files | LOC | What it does |
|---|---|---|---|
| **Reference resolver** (pipeline + matchers + import/module resolution) | `index.ts`, `name-matcher.ts`, `import-resolver.ts`, `path-aliases.ts`, `workspace-packages.ts`, `go-module.ts`, `types.ts` | ~13.5K | Binds each `unresolved_ref` to a target node via a strategy ladder. |
| **Synthesizers** (framework + dynamic-edge) | `frameworks/**` (26 files), `callback-synthesizer.ts`, `c-fnptr-synthesizer.ts`, `goframe-synthesizer.ts`, `swift-objc-bridge.ts` | ~6.5K | Emit edges for framework relationships (routes→handlers, events→listeners, observer dispatch, fn-pointer tables). |
| Support | `lru-cache.ts`, `cooperative-yield.ts`, `strip-comments.ts` | ~630 | Bounded caches, event-loop yielding, offset-preserving comment blanking. |

Key file sizes: `callback-synthesizer.ts` (3599), `import-resolver.ts` (2092),
`name-matcher.ts` (2042), `index.ts` (1878), `c-fnptr-synthesizer.ts` (986).

**Total synthesis surface: 27 framework resolvers + 38 dynamic-edge synthesizers = 65
distinct synthesis units** (enumerated in §3.3). This is the single largest and most
ecosystem-specific area of the port.

---

## 2. Architecture & data flow

### 2.1 The pass structure (orchestrated from `src/index.ts`)

Resolution is driven by the top-level indexer, not self-contained. Ordering
(`src/index.ts:494-531`):

1. **Re-init frameworks** — `resolver.initialize()` (`index.ts:282`) runs
   `detectFrameworks(context)` *after* the index is populated, because detectors
   consult the indexed file list (`src/index.ts:487-495`).
2. **`runPostExtract()`** (`index.ts:295`) — each framework's `postExtract()`
   cross-file finalization (e.g. NestJS `RouterModule.register([...])` route prefixes);
   persists mutated nodes via `updateNode`. Runs *before* resolution so updated names
   are visible.
3. **`resolveAndPersistBatched()`** (`index.ts:1259`) — the main pass. Reads
   `unresolved_refs` in batches of 5000, resolves each, persists edges, cleans up rows,
   and at the end runs the whole-graph **dynamic-edge synthesis** (`synthesizeCallbackEdges`,
   `index.ts:1378`).
4. **`resolveChainedCallsViaConformance()`** (`index.ts:1160`) — pass 2 for deferred
   chained/fluent calls whose method lives on a supertype (`Foo.getInstance().bar()`),
   resolvable only after `implements`/`extends` edges exist (#750).
5. **`resolveDeferredThisMemberRefs()`** (`index.ts:1738`) — pass 3 for
   `this.<member>` callback registrations whose member is inherited from a supertype
   (#808); node-anchored BFS up the supertype graph (depth 5).

### 2.2 Per-ref resolution (`resolveOne`, `index.ts:766`)

A strict, ordered strategy ladder with early-exit on high confidence:

1. **Skip built-in/external** (`isBuiltInOrExternal`, `index.ts:1400`) — big per-language
   allow-lists: `JS_BUILT_INS`, `REACT_HOOKS`, `PYTHON_BUILT_INS`/`_TYPES`/`_METHODS`,
   `GO_STDLIB_PACKAGES`, `C_BUILT_INS`/`CPP_BUILT_INS`, `std::` prefix, etc. C/C++ builtins
   are only filtered when *no* user node shadows them.
2. **Fast pre-filter** (`hasAnyPossibleMatch`, `index.ts:677`) — a `knownNames` set
   membership check (O(1)); parses `.`/`::`/`:`/`$`/`/` separators to test receiver &
   member leaves. Escape hatches: `matchesAnyImport` (re-export rename chains),
   `frameworks.some(f => f.claimsReference?.(name))`, Nix path imports.
3. **`function_ref`** (`index.ts:818`) — dedicated gated path: `this.` member →
   `resolveThisMemberFnRef`; else import first, then `matchFunctionRef`. Never touches
   fuzzy/framework strategies.
4. **JVM FQN import**, **Razor `@using`**, **CFML component path** — dedicated
   short-circuits (`index.ts:837-848`, `resolveCfmlComponentPath` `:1608`).
5. **Framework strategy** — every detected framework's `resolve()`, `≥0.9` returns
   immediately (`index.ts:857`).
6. **Import strategy** — `resolveViaImport` (`import-resolver.ts:1207`).
7. **Name strategy** — `matchReference` (`name-matcher.ts:1911`).
8. Collect candidates, return highest confidence; else defer chained/PHP-prop refs.

Each result passes `gateLanguage`/`gateFrameworkLanguage` (`index.ts:1840`,`:1862`)
which drop cross-language-family `references`/`imports` edges (a TS `<TestRunner>`
must not match a Kotlin `class TestRunner`) while preserving legitimate cross-language
`calls` bridges and config↔code edges.

### 2.3 Name matching & disambiguation (`name-matcher.ts`)

`matchReference` (`:1911`) tries strategies by descending confidence
(`matchByFilePath` → `matchByQualifiedName` → C++/scoped/dotted **call-chain** matchers
→ `matchMethodCall` → `matchByExactName` → `matchFuzzy`). Disambiguation signals:

- **Language families** (`LANGUAGE_FAMILY`: jvm/apple/web/c; everything else is a
  singleton). `sameLanguageFamily` / `crossesKnownFamily` (`:151-178`) gate cross-language
  matches.
- **Same-name disambiguation** (`same-name-disambiguation.test.ts`): `preferCallSiteFile`
  (`:485`) — when N symbols share a name/qualifiedName, prefer the one in the call site's
  own file; `findBestMatch` (`:1771`) scores candidates: same-file +100, dir-proximity
  (+15/shared segment, cap 80), same-language +50 / cross −80, kind bonus +25, exported
  +10, line proximity. **Ambiguous-name ceiling** (`AMBIGUOUS_NAME_CEILING`, `:382`): above
  it, exact-name declines (O(K) per ref is the "Resolving refs" wedge).
- **Receiver-type inference** (the heavy part): `matchMethodCall` (`:1450`) +
  `resolveMethodOnType` (`:498`) infer a variable's type by regex-scanning source lines
  (`localReceiverTypePatterns`, `:1093` — a per-language table of dynamically-built
  regexes for ~14 languages), plus dedicated C++ (`inferCppReceiverType` `:633`,
  return-type chains `:710`/`:765`), Java field (`:1006`), PHP property (`:1400`)
  inference. This is why `ResolutionContext` grew `getFileLines`/`getMethodMatches`
  caches (`types.ts:98`,`:109`) — it was ~20% of index CPU (#1122).
- **`matchFunctionRef`** (`:208`) — callback-as-value refs (#756): function/method
  targets only, same-file first, cross-file only when unique, with per-language
  bare-vs-method rules and Swift implicit-self scoping.

### 2.4 Import/module resolution (`import-resolver.ts` + helpers)

`extractImportMappings` (`:660`) dispatches to per-language extractors: JS/TS (`:698`),
Python (`:802`), Go (`:855`), Java/Kotlin (`:911`), PHP (`:943`), C/C++ (`:974`) — all
regex-based on raw source. `resolveViaImport` (`:1207`) then resolves per ecosystem:

- **C/C++ `#include`** → file→file edge; quoted includes resolve relative to the
  including dir first, then `-I` dirs from `compile_commands.json`
  (`loadCppIncludeDirs` `:425`, `shlexSplit` `:513`, heuristic `:550`).
- **COBOL COPY / EXEC SQL INCLUDE**, **PHP include/require**, **Nix path import** →
  file→file edges; explicitly *do not* fall back to name-matching (a wrong file edge is
  worse than none).
- **JS/TS** → relative resolution + **tsconfig/jsconfig `paths`** (`path-aliases.ts`:
  `loadProjectAliases` `:145`, `applyAliases` `:211`, own JSONC stripper `stripJsonc`
  `:65`) + **monorepo workspaces** (`workspace-packages.ts`: npm/yarn/bun `workspaces`,
  pnpm-workspace.yaml, HarmonyOS ohpm `oh-package.json5` `file:` deps) + re-export chain
  chasing (`extractReExports` `:1074`).
- **Python** module→file + module-member resolution (`:1480`,`:1650`,`:1674`).
- **Go cross-package** (`:1898`) using `go-module.ts` (`loadGoModule` reads the root
  `go.mod` module path so in-module imports aren't treated as third-party, #388).
- **Rust** path/module resolution (`:1697`,`:1759`) using the Cargo workspace map.
- **Java/JVM** FQN imports (`resolveJvmImport` `:1142`, `pickClosestJvmCandidate` `:1182`).
- **Lua `require`** (`:1561`).

**Emulated module-resolution ecosystems: TypeScript/JavaScript (relative + tsconfig
paths + monorepo workspaces + re-exports), Python, Go modules, Rust crates/workspaces,
Java/Kotlin JVM FQN, PHP (namespace `use` + include paths), C/C++ includes
(compile_commands.json), COBOL copybooks, Nix path imports, Lua require, HarmonyOS ohpm.**

### 2.5 `unresolved_refs` status lifecycle (`db/schema.sql:70-92`)

```
INSERT 'pending' (extraction)
   │
   ├── resolved  → DELETE row (edge created)
   └── attempted, no match → UPDATE status='failed', name_tail=<last segment>
```

- **`name_tail`** = last segment of `reference_name` (`util.greet`→`greet`), written on
  failure, indexed by `idx_unresolved_failed_tail` (`schema.sql:186`). A later sync that
  adds a matching node name retries failed rows (#1240) — the "retry logic."
- **Why not delete on failure?** A ref whose own file never changes would be gone
  forever; when a *different* file later gains the symbol, only a full re-index (not a
  sync) could recreate the edge. Failed rows stay retryable but are excluded from the
  pending reader.
- **Row-id precision** (`partitionResolvedCleanup` `index.ts:1021`,
  `partitionFailedCleanup` `:1045`): rows loaded from DB carry `rowId` and are
  deleted/failed by exact id; the legacy key-tuple `(fromNodeId, referenceName,
  referenceKind)` fallback would also flip *sibling* rows (same caller→callee at other
  lines) that a later batch hasn't attempted — silently dropping their edges when a batch
  boundary split them (#1269).
- **Batching invariant** (`resolveAndPersistBatched` `:1287`): always read offset 0; every
  processed ref leaves the pending set, so the population must shrink each pass. A
  non-progress guard (`remaining >= prevRemaining` → break, `:1369`) prevents the runaway
  that once grew a 99-file repo to 5M edges / 1.4 GB.

### 2.6 Dynamic-edge synthesis (`synthesizeCallbackEdges`, `callback-synthesizer.ts:3449`)

Runs once at the tail of `resolveAndPersistBatched`. Two Go pre-passes
(`goCrossFileMethodContainsEdges`, `goImplementsEdges`) are synthesized **and persisted
first** (later passes read their edges), then ~34 more passes run, each returning
`Edge[]`; results are **merged+deduped by `source>target`** and inserted in 2000-row
chunks. Every synthesized edge is `provenance:'heuristic'` with
`metadata.synthesizedBy:'<name>'` and usually `registeredAt`/`route`/`via`. Each pass is
**language-gated** by `has(...langs)` against `getDistinctFileLanguages()` — a pass whose
result is provably empty is skipped outright (the Kotlin pass OOM'd the pure-C Linux
kernel, #1212).

**Common synthesizer shape** (see `springEventEdges` `:2637`, `goframeRouteEdges`
`goframe-synthesizer.ts:77`): iterate files-by-extension or nodes-by-kind →
`stripCommentsForRegex` → regex-scan registration/dispatch sites → build index maps keyed
by a **join key** (event type, request type, struct field, route request-type) → find the
enclosing function via `enclosingFn(nodesInFile, line)` (line computed
`content.slice(0, m.index).split('\n').length`) → emit edges under a **FANOUT_CAP** →
dedupe. High-precision/low-recall by design.

---

## 3. Public/internal contracts the C# port must reproduce

### 3.1 Core data shapes (`src/types.ts`)

- **`Node`** (`types.ts:120`): `id`, `kind` (NodeKind, ~26 values), `name`,
  `qualifiedName` (`file::Class.method`), `filePath` (posix, project-relative),
  `language` (LANGUAGES, ~40 values), `startLine`/`endLine`/`startColumn`/`endColumn`,
  optional `signature`/`visibility`/`isExported`/`isStatic`/`decorators`/`returnType`/…
- **`Edge`** (`types.ts:194`): `source`, `target`, `kind` (EdgeKind: contains, calls,
  imports, exports, extends, implements, references, type_of, returns, instantiates,
  overrides, decorates), `metadata`, `line`, `column`, `provenance`
  (`tree-sitter`|`scip`|`heuristic`).
- **`UnresolvedReference`** (`types.ts:304`): `fromNodeId`, `referenceName`,
  `referenceKind` (EdgeKind + `function_ref`), `line`, `column`, denormalized
  `filePath`/`language`, `candidates?`, `rowId?`.
- **Node ID scheme** (`extraction/tree-sitter-helpers.ts:18`):
  `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``. Must be
  reproduced **internally-consistently**; Drupal's synthesizer reconstructs IDs by this
  formula (`generateNodeId`), so the C# extractor and synthesizer must share one impl.

### 3.2 `ResolutionContext` (`resolution/types.ts:68`) — the graph-access facade

The single interface every resolver/synthesizer consumes. Required: `getNodesInFile`,
`getNodesByName`, `getNodesByQualifiedName`, `getNodesByKind`, `fileExists`, `readFile`,
`getProjectRoot`, `getAllFiles`, `getNodesByLowerName`, `getImportMappings`. Optional
(performance / advanced): `iterateNodesByKind` (streaming — **mandatory** for synthesizer
memory, see `queries.ts:880`), `getFileLines`, `getMethodMatches`, `getSupertypes`,
`getNodeById`, `getProjectAliases`, `getGoModule`, `getWorkspacePackages`, `getReExports`,
`listDirectories`, `getCppIncludeDirs`. The production impl (`index.ts:397`) wires these
over the `QueryBuilder` + `fs` + a stack of LRU caches.

### 3.3 The synthesizer interfaces + full enumeration

**(a) `FrameworkResolver`** (`resolution/types.ts:196`): `name`, optional `languages[]`,
`detect(ctx)→bool` (project-level, once), `resolve(ref,ctx)→ResolvedRef|null`, optional
`claimsReference(name)`, `extract(filePath,content)→{nodes,references}`,
`postExtract(ctx)→Node[]`. Registered in a **static array** `FRAMEWORK_RESOLVERS`
(`frameworks/index.ts:36`); `detectFrameworks` filters by `detect()`.

**27 framework resolvers** (relationship → edge; mechanism):

| # | Resolver | Lang | Relationship | Mechanism |
|---|---|---|---|---|
| 1 | `laravel` | php | route→`Controller@method`, `Route::resource`→controller, Eloquent `Model::m` | regex + convention paths; `FACADE_MAPPINGS` table (currently dead) |
| 2 | `drupal` | php,yaml | route→`_controller`/`_form`, hook-impl→`hook_X` | `composer.json` JSON parse + hand-YAML `.routing.yml` + hook docblock/name scan; **reconstructs node IDs** |
| 3 | `express` | js,ts | route→handler (named `references`, inline-arrow `calls`) | stripComments + `app.METHOD('/p',…)` regex + **balanced-paren arg reader** |
| 4 | `nestjs` | ts,js | route→handler-method (HTTP/GraphQL/WS) **+ postExtract** RouterModule prefixes | stripComments + **decorator scanner** (sticky regex) + **mini JS-object-literal parser** |
| 5 | `react` | js,ts,tsx,jsx | route→component (`references`) | regex windows after `<Route`, `createBrowserRouter([...])`, `filePathToRoute` |
| 6 | `svelte` | svelte | routes + rune/`$store` noise-suppression | filename table `SVELTEKIT_ROUTE_FILES` + `$lib/`→`src/lib/` probe |
| 7 | `vue` | all | file-routes + compiler-macro/Nuxt-auto-import suppression | path-based (`/pages/`,`/server/api/`), set membership, alias probe |
| 8 | `astro` | all | route→component | path-based `src/pages/` + PascalCase component |
| 9 | `django` | python | url-conf→view, `include('x.urls')`→file, DRF viewset, `_iterable_class`→ORM | stripComments + `path/re_path/url(...)` regex + suffix heuristics |
| 10 | `flask` | python | decorator-route→handler | `extractDecoratorRoutes` (scan to next `def`) |
| 11 | `fastapi` | python | decorator-route→handler | same shared decorator-route extractor |
| 12 | `rails` | ruby | route→`controller#action`; expands `resources` into 7 REST actions | regex + naive pluralize/camelize tables |
| 13 | `spring` | java,kotlin,yaml,properties | route→handler; `@Value`/`@ConfigurationProperties`→config key | **hand YAML/properties parser** (key-only, secret guard #383) + relaxed-binding canonicalization; perf-gated (#1180) |
| 14 | `play` | scala,java,yaml | route→`Controller.method` | line-parse `conf/routes` DSL |
| 15 | `go` | go | route→handler (Gin/Chi/net-http) | `X.GET("/p",handler)` regex + tail-ident |
| 16 | `goframe` | go | emits `route` node only (edge deferred to synthesizer) | `g.Meta` struct-tag regex; encodes req-type into qualifiedName after `GOFRAME_ROUTE_MARKER` |
| 17 | `rust` | rust | route→handler (Actix/Rocket/Axum) + module resolution | heaviest: attr macros + `.route(...)` **balanced-paren** scan; Cargo workspace map |
| 18 | `aspnet` | csharp | attribute & minimal-API route→action | `[Route]`/`[HttpGet]` + `app.MapGet("/p",h)` regex |
| 19 | `swiftUI` | swift | `struct X: View`→component nodes; View/VM heuristic | text scan `import SwiftUI`; no route edges |
| 20 | `uikit` | swift | `UIViewController`/`UIView` subclass nodes | text scan |
| 21 | `vapor` | swift | route→handler | 2-pass `.grouped`/`.group` prefix map + `.get(…,use:h)` |
| 22 | `swift-objc-bridge` | swift+objc | bidirectional `call→method` across the boundary | uses `swift-objc-bridge.ts` name-math; `WeakMap` memo |
| 23 | `react-native-bridge` | js/ts+objc/java/kotlin | JS→native method redirect | regex over ObjC macros / `@ReactMethod` / TurboModule specs; `WeakMap` cache |
| 24 | `expo-modules` | swift,kotlin | emits DSL `Function("x")` method nodes | module-level regex |
| 25 | `fabric-view` | ts/tsx+objc/java/kotlin | RN Fabric/Codegen `component`+`property` nodes | regex per ext; `listDirectories` monorepo probe |
| 26 | `cics` | cobol | `cics-transid:XXXX`→owning COBOL module | per-context TRANSID→module index |
| 27 | `terraform` | terraform | dir-scoped `var/local/module/resource` + cross-module bridges | directory-scoping + re-read attribute lines by regex (no real HCL parse) |

**(b) Dynamic-edge synthesizers** — no formal interface today; they are
`async (queries?, ctx, onYield) => Edge[]` functions hard-listed in `synthesizeCallbackEdges`
(`callback-synthesizer.ts:3488-3542`). **38 total** (2 Go pre-passes + 36 merged):

Go pre-passes (persisted first): `goCrossFileMethodContainsEdges`, `goImplementsEdges`.
Merged: `fieldChannelEdges` (field-backed observer), `closureCollectionEdges`,
`eventEmitterEdges` (string-keyed EventEmitter), `reactRenderEdges`, `reactJsxChildEdges`,
`vueTemplateEdges`, `svelteKitLoadEdges`, `pascalFormEdges`, `flutterBuildEdges`,
`arkuiStateBuildEdges`, `arkuiEmitterEdges`, `arkuiRouterEdges`, `cppOverrideEdges`,
`interfaceOverrideEdges` (~10 langs), `kotlinExpectActualEdges`, `goGrpcStubImplEdges`,
`rnEventEdges`, `fabricNativeImplEdges`, `expoCrossPlatformEdges`, `rnCrossPlatformEdges`,
`mybatisJavaXmlEdges`, `ginMiddlewareChainEdges`, `reduxThunkEdges`, `objectRegistryEdges`,
`rtkQueryEdges`, `piniaStoreEdges`, `vuexDispatchEdges`, `celeryDispatchEdges`,
`springEventEdges`, `mediatrDispatchEdges`, `sidekiqDispatchEdges`,
`erlangBehaviourDispatchEdges`, `laravelEventEdges`, `cFnPointerDispatchEdges`
(→`c-fnptr-synthesizer.ts`), `goframeRouteEdges` (→`goframe-synthesizer.ts`),
`nixOptionPathEdges`.

Values, grouped by relationship kind:
- **Observer / pub-sub dispatch** (dispatcher→registered callback): `fieldChannelEdges`,
  `closureCollectionEdges`, `eventEmitterEdges`, `springEventEdges` (event-type join),
  `mediatrDispatchEdges` (request-type join), `celeryDispatchEdges`, `sidekiqDispatchEdges`,
  `laravelEventEdges`, `erlangBehaviourDispatchEdges`. Value: closes the #1 dynamic-dispatch
  hole — "who actually handles this event/callback."
- **UI component tree** (parent→child render): `reactRenderEdges`, `reactJsxChildEdges`,
  `vueTemplateEdges`, `flutterBuildEdges`, `arkuiStateBuildEdges`/`arkuiEmitterEdges`/
  `arkuiRouterEdges`, `pascalFormEdges`. Value: JSX/template children become traversable.
- **State management** (component→store action): `reduxThunkEdges`, `rtkQueryEdges`,
  `piniaStoreEdges`, `vuexDispatchEdges`, `objectRegistryEdges`.
- **Polymorphism the parser can't see**: `interfaceOverrideEdges`, `cppOverrideEdges`,
  `goImplementsEdges` (Go has no static `implements`), `goGrpcStubImplEdges`,
  `kotlinExpectActualEdges`, `cFnPointerDispatchEdges` (C fn-pointer tables),
  `goframeRouteEdges` (reflective routes), `nixOptionPathEdges`.
- **Cross-platform / native bridges**: `rnEventEdges`, `fabricNativeImplEdges`,
  `expoCrossPlatformEdges`, `rnCrossPlatformEdges`, `mybatisJavaXmlEdges`,
  `ginMiddlewareChainEdges`, `svelteKitLoadEdges`.

### 3.4 `QueryBuilder` (storage) methods consumed — the DB contract

`getAllFilePaths`, `getAllNodeNames`, `iterateNodeNames`, `getDistinctFileLanguages`,
`getNodesByFile`, `getNodesByName`, `getNodesByLowerName`, `getNodesByQualifiedNameExact`,
`getNodesByKind`, `iterateNodesByKind` (streaming cursor), `getNodesByIds`, `getNodeById`,
`getOutgoingEdges`/`getIncomingEdges` (by kind), `iterateNodesByLanguageWithDecorator`,
`insertEdges`, `updateNode`, `getUnresolvedReferencesCount`, `getUnresolvedReferencesBatch`,
`deleteReferencesByRowIds`, `deleteSpecificResolvedReferences`, `markReferencesFailed`,
`markReferencesFailedByRowIds`. The storage-analysis doc must expose exactly these.

---

## 4. External dependencies → C# mapping

| TS dependency / Node API | Used by | C# / NuGet equivalent | AOT note |
|---|---|---|---|
| `web-tree-sitter`, `tree-sitter-wasms` | **none in resolution** (extraction only) | n/a here | resolution operates on the DB + raw text via regex — **zero tree-sitter dependency** |
| `better-sqlite3` / `node:sqlite` (via `QueryBuilder`) | all | `Microsoft.Data.Sqlite` (storage module) | consumed through an interface; not a direct dep of this layer |
| `jsonc-parser` | `workspace-packages.ts` (ohpm json5), indirectly tsconfig | `System.Text.Json` `JsonDocument` with `ReadCommentHandling=Skip`, `AllowTrailingCommas=true` for **JSONC**; ohpm `.json5` (unquoted keys/single quotes) needs a tiny hand-parser or a JSON5 lib | **use `JsonDocument`/`Utf8JsonReader` (reflection-free), NOT `JsonSerializer.Deserialize<T>`** for config files |
| `JSON.parse` (package.json, composer.json, compile_commands.json) | workspaces, drupal, cpp includes | `JsonDocument.Parse` | AOT-safe (DOM, no reflection) |
| `picomatch` | `cargo-workspace.ts` glob, `workspace-packages.ts` (hand-rolled) | one-level `*`/`**` expansion is hand-rolled already → port by hand; if broader globs needed, `DotNet.Glob` or `Microsoft.Extensions.FileSystemGlobbing` | avoid heavy glob libs; hand-roll |
| own JSONC/YAML/TOML mini-parsers (`stripJsonc`, Spring/Drupal YAML, cargo TOML, pnpm-YAML) | path-aliases, spring, drupal, cargo, workspaces | **port verbatim** — do not swap in libraries (behavior is lossy-by-design, tests pin it) | pure string code, AOT-safe |
| Node `fs` (readFileSync, existsSync, readdirSync) | context impl, all module helpers | `System.IO.File`, `Directory` | fine; centralize under `ResolutionContext` |
| Node `path` (posix) | everywhere | **custom `PosixPath` helper** — TS assumes forward-slash project-relative paths; `System.IO.Path` uses `\` on Windows | see §5 |
| `crypto.createHash('sha256')` | node-ID reconstruction | `System.Security.Cryptography.SHA256.HashData` | AOT-safe |
| JS `RegExp` (hundreds of patterns; some `new RegExp(interpolated)`) | name-matcher, all synthesizers, import extractors | `System.Text.RegularExpressions.Regex`; `[GeneratedRegex]` for static patterns, `new Regex(...)` for dynamic ones | **`new Regex` runs interpreted under AOT (works); `RegexOptions.Compiled` is a no-op**. Semantics deltas in §5 |
| `setImmediate` (`cooperative-yield.ts`) | batching + synthesis | **largely removable** — run resolution on a worker thread with `CancellationToken`; `await Task.Yield()` only if progress streaming needs it | see §5.9 |
| `WeakMap<ResolutionContext, T>` | swift-objc, cics, react-native memo | `ConditionalWeakTable<ResolutionContext,T>` or a field on the resolver | AOT-safe |
| `Map`/`Set` | everywhere | `Dictionary<,>`/`HashSet<>` | trivial |
| insertion-ordered Map LRU (`lru-cache.ts`) | context caches | small `LruCache<K,V>` over `Dictionary` + `LinkedList` | trivial |

**Net AOT posture: this subsystem is unusually AOT-friendly** — it is pure string/regex/DB
logic with no `dynamic`, no runtime codegen, no reflection-based serialization, and (unlike
extraction) no native interop. The only real AOT discipline is: config parsing via
`JsonDocument`, and edge/DTO types that cross IPC registered in a `JsonSerializerContext`.

---

## 5. Porting challenges & risks (ranked)

1. **`c-fnptr-synthesizer.ts` mini C-preprocessor (986 LOC, HIGH).** Emulates `#ifdef`
   evaluation, object/function macro expansion, and `#include` following to find
   fn-pointer registration tables (redis/sqlite/vim/git command tables). The single
   hardest unit; C/C++ only; narrowest breadth. **Defer; spike separately.**
2. **`name-matcher.ts` receiver-type inference (~2K LOC, HIGH value + effort).** Per-language
   regex type inference (`localReceiverTypePatterns` for ~14 languages, C++ return-type
   chains, Java/PHP field inference). Dynamically-built regexes. Load-bearing for
   method-call edge quality. Port incrementally, top languages first.
3. **Hand-rolled parsers must be ported faithfully (MEDIUM-HIGH).** NestJS RouterModule
   JS-object-literal parser + balanced-delimiter scanners (express/nestjs/rust), Spring
   hand-YAML/properties, Drupal hand-YAML, cargo-workspace hand-TOML, pnpm mini-YAML,
   tsconfig `stripJsonc`. Behavior parity matters — the `*-synthesizer.test.ts` /
   `frameworks.test.ts` suite pins them. Don't substitute general libraries.
4. **`strip-comments.ts` (528 LOC, MEDIUM, must be exact).** Offset-preserving per-language
   comment/string blanker; foundational for ~15 regex extractors (`match.index`→line
   correctness). Port the state machine verbatim.
5. **Regex semantics parity (MEDIUM, pervasive).** JS↔.NET deltas: sticky `/y` flag
   (→ `\G` anchor or `Regex.Match(input, startat)`), stateful `.lastIndex` iteration
   (→ `Regex.Matches` / `Match.NextMatch`), `\w`/`\b` Unicode differences, `\d` Unicode.
   Hundreds of patterns; needs a translation checklist + the test suite as the oracle.
6. **Posix path normalization (MEDIUM, cross-platform).** The whole layer assumes
   forward-slash, project-relative paths (dir-proximity scoring, terraform dir-scoping,
   CFML component paths, workspace rewrites). `System.IO.Path` diverges on Windows.
   Centralize a `PosixPath` helper and never call `Path.Combine` raw on graph paths.
7. **Streaming iteration for synthesizer memory (MEDIUM).** `iterateNodesByKind` /
   `iterateNodesByLanguageWithDecorator` must be true streaming cursors (Sqlite
   `DbDataReader` as `IEnumerable<Node>`), not materialized lists — several synthesizers
   scan `function`/`method` (gigabytes on large repos, #1212, #610). Model as
   `IEnumerable<Node>`/`IAsyncEnumerable<Node>`.
8. **Node-ID scheme (LOW-MEDIUM).** `sha256(filePath:kind:name:line)[:32]` prefixed by
   kind; Drupal reconstructs it. Must be one shared C# impl across extractor + synthesizer
   (internally consistent — no cross-impl DB compat needed for a fresh rewrite).
9. **Cooperative-yield re-architecture (LOW, a simplification).** Node's yielding exists
   only because resolution runs on the same single thread as the liveness-watchdog
   heartbeat. The C# worker has no such self-SIGKILL watchdog; resolution runs off the IPC
   thread. Replace `maybeYield()` with `CancellationToken` checks + optional progress
   events. **This deletes machinery rather than porting it.**
10. **Breadth/maintenance (LOW-each, HIGH-aggregate).** 65 synthesis units × per-ecosystem
    regex quirks is the bulk of the labor. Manage via the MVP cut (§7).

---

## 6. Recommended C# design

### 6.1 Module boundary

Resolution is an **internal phase of the CodeGraph index/graph module, not its own
`IWorkerModule`.** It exposes no RPC directly — the RPC surface is
`codegraph.index`/`codegraph.sync`/`codegraph.query` on the graph module, which calls the
resolver internally. Suggested layout under `Modules/CodeGraph/`:

```
Modules/CodeGraph/
  CodeGraphModule.cs            // IWorkerModule: registers codegraph.* RPC
  Resolution/
    ReferenceResolver.cs        // orchestrator ≙ index.ts (passes 1-3, batching, lifecycle)
    ResolutionContext.cs        // IResolutionContext + production impl over QueryBuilder+fs+LRU
    NameMatcher.cs              // matchReference ladder ≙ name-matcher.ts
    ReceiverTypeInference.cs    // localReceiverTypePatterns + C++/Java/PHP inference
    ImportResolver.cs           // resolveViaImport + per-language extractors
    PathAliases.cs / WorkspacePackages.cs / GoModule.cs / CargoWorkspace.cs
    StripComments.cs / PosixPath.cs / LruCache.cs
    Frameworks/
      IFrameworkResolver.cs
      FrameworkResolverCatalog.cs   // static ordered list ≙ FRAMEWORK_RESOLVERS
      ReactResolver.cs, ExpressResolver.cs, NestJsResolver.cs, …
    Synthesizers/
      IEdgeSynthesizer.cs
      EdgeSynthesizerCatalog.cs     // static ordered list ≙ synthesizeCallbackEdges body
      InterfaceOverrideSynthesizer.cs, FieldChannelSynthesizer.cs, …
      SynthesisRunner.cs            // gating + merge/dedupe + chunked persist
```

Follow the existing `Modules/Db/` file convention (`*Module.cs` / `*Tools.cs` /
`*Models.cs`); source-gen JSON types for any edge/progress DTO that crosses IPC live in a
`CodeGraphModels.cs` `[JsonSerializable]` context.

### 6.2 AOT plug-in registration (no reflection scanning)

Both engines already use **static compile-time arrays** — preserve that; it is exactly
what native AOT wants. Do **not** use assembly/attribute scanning.

```csharp
internal interface IFrameworkResolver {
    string Name { get; }
    IReadOnlyList<string>? Languages { get; }          // null = all
    bool Detect(IResolutionContext ctx);
    ResolvedRef? Resolve(UnresolvedRef r, IResolutionContext ctx);
    bool ClaimsReference(string name) => false;
    FrameworkExtraction? Extract(string filePath, string content) => null;
    IReadOnlyList<Node> PostExtract(IResolutionContext ctx) => Array.Empty<Node>();
}
internal static class FrameworkResolverCatalog {
    internal static readonly IReadOnlyList<IFrameworkResolver> All = new IFrameworkResolver[] {
        new LaravelResolver(), new DrupalResolver(), new ExpressResolver(), /* … */
    };
}

internal interface IEdgeSynthesizer {
    string Name { get; }
    IReadOnlyList<string> RequiredLanguages { get; }   // empty = always run
    SynthPhase Phase { get; }                          // GoPrePass (persist-before-next) | Main
    IAsyncEnumerable<Edge> SynthesizeAsync(ISynthContext ctx, CancellationToken ct);
}
internal static class EdgeSynthesizerCatalog {
    internal static readonly IReadOnlyList<IEdgeSynthesizer> All = new IEdgeSynthesizer[] {
        new GoMethodContainsSynthesizer(),   // Phase.GoPrePass
        new GoImplementsSynthesizer(),       // Phase.GoPrePass
        new InterfaceOverrideSynthesizer(),  // Phase.Main
        /* … ordered exactly as synthesizeCallbackEdges lists them */
    };
}
```

`SynthesisRunner` reproduces `synthesizeCallbackEdges`: query
`GetDistinctFileLanguages()` once; run `GoPrePass` synthesizers first and **persist each
before the next** (later passes read their edges); run `Main` synthesizers whose
`RequiredLanguages` intersect the present set; merge+dedupe by `source>target`; insert in
2000-row batched transactions. Ordering is a property of the catalog list — deterministic,
inspectable, AOT-clean.

### 6.3 Concurrency & yielding

Run the whole resolution+synthesis phase on a background `Task` (off the IPC thread). Pass
a `CancellationToken` down every loop (replaces the watchdog contract). Emit progress via
the existing streaming-event channel (`WorkerMessagePackEvent`) instead of `onProgress`
callbacks. Drop `cooperative-yield.ts` entirely; keep periodic `ct.ThrowIfCancellationRequested()`
+ optional `await Task.Yield()` only where progress cadence needs it.

### 6.4 Caching

Port `LruCache<K,V>` (Dictionary + LinkedList, insertion-order eviction). Reproduce the
per-context caches from `index.ts:226-243` (node/file/name/lowerName/qualifiedName/
importMapping/reExport/fileLines/methodMatch), sized off one `CODEGRAPH_CACHE_LIMIT`-style
budget. Keep the non-LRU `nodesByKindCache` (small fixed key set).

---

## 7. MVP vs later

**The base resolution pipeline is not optional** — without it there are no cross-file
`calls`/`imports`/`extends`/`implements` edges, i.e. no graph. So the MVP is the pipeline
plus a *small, high-leverage* slice of synthesizers.

### MVP (first working slice)
- **Pipeline**: `ReferenceResolver` passes 1-3, `unresolved_refs` status lifecycle
  (pending→delete/failed, `name_tail` retry, rowId-precise cleanup), batching + non-progress
  guard, `gateLanguage`/built-in filtering.
- **NameMatcher**: `matchByFilePath`, `matchByQualifiedName`, `matchByExactName`,
  `matchFuzzy`, `findBestMatch`/`preferCallSiteFile`, `matchFunctionRef`, and
  `matchMethodCall`+receiver inference **for the top ~6 languages** (TS/JS, Python, Java,
  Go, C#, PHP). Defer C++ call-chains, Rust/Swift scoped chains, Lua/Luau/R/Pascal.
- **ImportResolver**: JS/TS (relative + tsconfig `paths` + monorepo `workspaces`),
  Python, Go modules, Java JVM-FQN, re-exports. `path-aliases.ts`, `workspace-packages.ts`
  (npm/pnpm; defer ohpm), `go-module.ts`. Defer C/C++ includes, PHP includes, COBOL, Nix, Lua.
- **Framework resolvers (~9, the dominant web/back-end ecosystems)**: `react`, `express`,
  `nestjs`, `django`, `flask`, `fastapi`, `spring`, `rails`, `aspnet` (+ `laravel` cheap to add).
  These give route→handler edges, the single most agent-visible framework value.
- **Dynamic-edge synthesizers (~7, broad or mandatory)**: `goCrossFileMethodContainsEdges`
  + `goImplementsEdges` (**mandatory for Go correctness**), `interfaceOverrideEdges`
  (override edges across ~10 languages — huge breadth-per-line), `fieldChannelEdges`,
  `eventEmitterEdges`, `reactRenderEdges`, `reactJsxChildEdges`.
- **Support**: `StripComments` (at least js/ts/python/java/php/go), `LruCache`, `PosixPath`.

This MVP covers the JS/TS + Python + Java/Kotlin + Go + C# ecosystems end-to-end (parse →
resolve → routes → override/observer edges) — the bulk of real usage.

### Later (long tail, add per demand)
- Remaining frameworks: `vue`, `svelte`, `astro`, `play`, `drupal`, `goframe`, `rust`,
  swift trio, `swift-objc`, `react-native`, `expo-modules`, `fabric`, `cics`, `terraform`.
- Remaining synthesizers: state-mgmt (`reduxThunk`, `rtkQuery`, `pinia`, `vuex`,
  `objectRegistry`), pub-sub (`spring-event`, `mediatr`, `celery`, `sidekiq`, `laravel-event`,
  `erlang-behaviour`), UI (`flutter`, `arkui*`, `pascal-form`, `vue-template`, `svelte-kit`),
  bridges (`rn*`, `expo/fabric-native`, `mybatis`, `gin`, `go-grpc`, `kotlin-expect-actual`,
  `nix-option`, `cpp-override`, `closure-collection`), and **`c-fnptr` last** (its own spike).
- Extended name-matching: C++/Rust/Swift/ObjC call-chains, `resolveChainedCallsViaConformance`,
  `resolveDeferredThisMemberRefs`, Razor/CFML/ArkTS/Erlang special paths.
- Extended module resolution: C/C++ includes (compile_commands.json), PHP/COBOL/Nix/Lua,
  ohpm workspaces.

---

## 8. Open questions / decisions for the architect

1. **Module granularity.** Confirm resolution is an *internal* library of a single
   `CodeGraph` graph/index module (my recommendation) rather than its own `IWorkerModule`.
   This affects how extraction, resolution, and query share the `QueryBuilder`/context.
2. **How much of the 65-unit tail ships v1?** The MVP (§7) is ~16 synthesis units. The
   remaining ~49 are per-ecosystem and individually low-risk but high aggregate cost. Need a
   product call on which ecosystems are in-scope for the OpenCowork audience (e.g. is
   Swift/ObjC/RN/HarmonyOS worth it? COBOL/CICS? Terraform/Nix?).
3. **Config parsing stance.** Approve `JsonDocument`/`Utf8JsonReader` (reflection-free) for
   all config reads, and the port-verbatim policy for the hand-rolled YAML/TOML/JSONC mini
   parsers (vs. pulling `YamlDotNet`/a TOML lib). Cross-cuts the storage/AOT strategy doc.
4. **Regex parity strategy.** Do we (a) port patterns 1:1 and rely on the ported
   `*-synthesizer.test.ts` suite as the oracle, or (b) invest in a JS→.NET regex-audit pass
   up front? Recommend (a) with a documented delta-checklist (sticky flag, lastIndex,
   Unicode classes). Needs the test suite ported early as the safety net.
5. **Cooperative-yield removal is a behavior change.** Confirm the C# worker has no
   equivalent self-kill watchdog and that a long synthesis span on a huge repo is acceptable
   on a background thread with cancellation (I believe yes — the sidecar is already a
   persistent daemon per the brief). If any watchdog exists, resolution must cooperate with it.
6. **Streaming node access contract.** The storage-module doc must commit to true streaming
   cursors for `iterateNodesByKind` / `iterateNodesByLanguageWithDecorator` (not
   materialized) — a hard requirement for synthesizer memory. Flag it there.
7. **Node-ID hash ownership.** Decide where `generateNodeId` lives (shared between the
   extraction and resolution modules) so Drupal's ID reconstruction stays in lockstep with
   the extractor. If a fresh DB is always built (no reading TS-era DBs), the only constraint
   is internal consistency.
8. **Incremental sync semantics.** This analysis covers the full-index path; the failed-ref
   retry (`resolveAndPersistListYielding`, #1240) and per-framework `postExtract` on every
   sync are the incremental contract. Confirm the sync/daemon doc reproduces the
   pending/failed status invariants (the #1187 orphan sweep keys off the pending count).
