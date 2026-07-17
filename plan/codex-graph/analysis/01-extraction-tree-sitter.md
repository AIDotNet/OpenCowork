# 01 — Extraction Engine & Tree-sitter Integration

> Port analysis for the C# rewrite of CodeGraph inside the OpenCowork .NET native
> worker. Scope: the parsing core — file bytes → tree-sitter parse → AST walk →
> `nodes` + `unresolvedReferences` + intra-file edges. This is the single biggest
> technical risk of the whole port; the tree-sitter strategy (Section 5A) gates
> the project.
>
> Clone analyzed: `…/scratchpad/codegraph` (CodeGraph v1.4.1, MIT). All
> `file:line` citations are into that clone.

---

## 1. Scope & subsystem summary

The extraction subsystem lives under `src/extraction/**` — **48 files, ~21,073
LOC** (`src/extraction/*.ts` = 14,470 LOC; `src/extraction/languages/*.ts` =
~6,600 LOC). It answers one question per file: *given bytes + a language, what
symbols and references does this file contain?*

Its output is an `ExtractionResult` (`src/types.ts:253`):
`{ nodes, edges, unresolvedReferences, errors, durationMs }`. It does **not**
resolve cross-file relationships — that is a separate `src/resolution/` phase
that turns `unresolvedReferences` (name strings) into real edges later.

Files by role and size:

| File | LOC | Role |
|---|---|---|
| `tree-sitter.ts` | 6,658 | **The engine.** `TreeSitterExtractor` class: parse → recursive `visitNode` walk → emit. The `extractFromSource()` entry point. |
| `index.ts` | 2,559 | **Orchestrator** (NOT the per-file engine): directory scan, gitignore, `ParseWorkerPool`, SQLite writes. Re-exports `extractFromSource` (`index.ts:2558`). |
| `function-ref.ts` | 843 | Function-as-value capture (`FN_REF_SPECS`), table-driven per language. |
| `grammars.ts` | 598 | Grammar WASM loading/caching, `EXTENSION_MAP`, `detectLanguage()`. |
| `cfml-extractor.ts` | 494 | CFML dialect-switcher (uses 3 grammars). |
| `parse-pool.ts` | 442 | Worker-thread parse pool. |
| `liquid/astro/svelte/mybatis/vue/razor/dfm-extractor.ts` | 159–393 ea. | Bespoke per-format extractor classes. |
| `tree-sitter-types.ts` | 297 | **`LanguageExtractor` contract** + `ExtractorContext`. |
| `tree-sitter-helpers.ts` | 127 | `generateNodeId`, `getNodeText`, docstring extraction. |
| `parse-worker.ts` | 111 | worker_threads entry; calls `extractFromSource`. |
| `wasm-runtime-flags.ts` | 110 | V8 `--liftoff-only` workaround (**disappears in C#**). |
| `generated-detection.ts` | 81 | Filename-regex detection of generated files. |
| `extraction-version.ts` | 24 | `EXTRACTION_VERSION = 24` — re-index signal. |
| `languages/*.ts` (30 files) | ~6,600 | One declarative `LanguageExtractor` config per language. |
| `wasm/*.wasm` (15 files) | 45 MB | Vendored grammar binaries (the niche/patched set). |

---

## 2. Architecture & data flow

### 2.1 The per-file pipeline

`extractFromSource(filePath, source, language?, frameworkNames?)`
(`tree-sitter.ts:6568`) is the top-level entry. It:

1. Detects language if not given (`detectLanguage`, `grammars.ts:414`).
2. **Branches on language** (`tree-sitter.ts:6580-6630`) to a bespoke extractor
   for embedded/markup formats (svelte, vue, astro, liquid, razor, xml/MyBatis,
   cfml/cfscript, `.dfm`/`.fmx`), returns an empty result for file-level-only
   langs (yaml/twig/properties), or else constructs `TreeSitterExtractor`.
3. After extraction, runs any applicable **framework resolvers**
   (`frameworkNames`) and merges their `nodes` + `references`
   (`tree-sitter.ts:6632-6655`).

`TreeSitterExtractor.extract()` (`tree-sitter.ts:419`) is the grammar path:

```
preParse?(source)              # optional offset-preserving source transform (:463)
tree = parser.parse(source)    # web-tree-sitter parse (:466)
push file node "file:<path>"   # (:472-489) — the scope root
extractFilePackage(root)       # JVM namespace node (Kotlin/Java) (:495)
visitNode(tree.rootNode)       # recursive descent walk (:498)
flushFnRefCandidates()         # deferred function_ref emission (:502)
flushValueRefs()               # deferred value-reference edges (:503)
tree.delete()                  # free native WASM memory (:526)
return { nodes, edges, unresolvedReferences, errors, durationMs }  # (:534)
```

### 2.2 The walk

`visitNode(node)` (`tree-sitter.ts:900`) is a **single manual recursion** — a big
`if/else` ladder keyed on `node.type` against the language config's type arrays
(`functionTypes.includes(nodeType)` → `extractFunction`/`extractMethod`,
`classTypes` → `extractClass`, `callTypes` → `extractCall`, …
`:958-1256`), then recurses over `node.namedChild(i)` for `i in
0..namedChildCount` (`:1260`). There is **no tree-sitter query engine**
(see Section 2.6). Language files supply *classification data and small hooks*;
they never walk the tree themselves. The per-construct emitters
(`extractFunction :1455`, `extractClass :1617`, `extractMethod :1675`,
`extractCall :3622` — ~900 LOC alone, `extractImport :3108`, `extractVariable
:2476`, …) plus framework-specific logic (React, RTK Query, Vue/Pinia stores,
Rust route macros, Erlang gen_server, Lombok synthesis) make up the 6,600-line
bulk.

### 2.3 Node creation & IDs

`createNode(kind, name, node, extra?)` (`tree-sitter.ts:1272`):

- Skips empty names (would cause FK violations, `:1280`).
- ID via `generateNodeId(filePath, kind, name, node.startPosition.row + 1)`
  (`tree-sitter-helpers.ts:18`):
  `` `${kind}:${sha256(`${filePath}:${kind}:${name}:${line}`).hex.slice(0,32)}` ``
  — a **kind-prefixed 128-bit hash that embeds the 1-based start line**. The
  `file` node is the exception: `file:<filePath>` (`:473`).
- `qualifiedName = buildQualifiedName(name)` (`:1385`): the scope-stack node
  names joined by `::` (plus a C++ `namespacePrefix`). NB it does a linear
  `this.nodes.find(...)` per level (`:1391`) — O(n) that a C# port should index.
- Pushes a `contains` edge from the current scope top (`:1327-1336`).

### 2.4 Edges vs unresolved refs — the load-bearing design fact

The extraction engine emits **almost no direct edges**. There are only **3**
`edges.push` sites vs **69** `unresolvedReferences.push` sites:

- Direct `Edge`s: `contains` in `createNode` (`:1330`), `contains`
  method→owner (`:1745`), and same-file value-`references` from `flushValueRefs`
  (`:881`, `metadata:{valueRef:true}`).
- **Everything relational** — `calls`, `imports`, `extends`, `implements`,
  `instantiates`, `decorates`, `function_ref` — is emitted as an
  `UnresolvedReference` carrying a **name string, not a target id**, *even for
  same-file calls*. E.g. `extractCall` pushes
  `{fromNodeId, referenceName, referenceKind:'calls', line, column}`
  (`:3662`). The `src/resolution/` phase resolves these later.

Implication for the port: **the extraction module's contract is `nodes` +
`contains`/value-ref edges + `unresolvedReferences`.** Call/import/inheritance
edge *creation* belongs to the resolver analysis, not here.

### 2.5 Language detection

Purely in `grammars.ts`:

- `EXTENSION_MAP` (`grammars.ts:58-173`): ~90 extensions → `Language`. Plus
  path-shaped detectors: `isPlayRoutesFile` (extensionless `conf/routes`),
  `isShopifyLiquidJson` (`templates|sections/*.json`), `isErlangAppFile`
  (`*.app`/`*.app.src`).
- `detectLanguage(filePath, source?, overrides?)` (`grammars.ts:414`): extension
  lookup, with **content heuristics** for ambiguous `.h` files
  (`looksLikeCpp` / `looksLikeObjc`, `:440-460`) and project `codegraph.json`
  extension overrides.
- `isSourceFile()` (`:184`) is the single "should we index this" predicate,
  derived from `EXTENSION_MAP`.

### 2.6 No `.scm` queries — confirmed

`grep -rn '\.query('` in `src/extraction/` returns **2 hits, both false
positives**: `tree-sitter.ts:2236/2275` are "RTK **Query**" (Redux Toolkit
`build.query({...})` framework code), and every `injections.scm` mention is a
*comment* (`grammars.ts:295`, `cfml-extractor.ts:12`). The CFML extractor does
its `<cfscript>`/`<cfquery>` delegation **manually** in code, not via the
grammar's injections. **The port needs the tree-sitter parse + node-navigation
API only — not the query/`.scm` engine.** This materially shrinks the required
native surface.

---

## 3. Public/internal contracts the C# port must reproduce

### 3.1 The `LanguageExtractor` config (`tree-sitter-types.ts:80-297`)

The most important contract. A language extractor is **a declarative config
object**, not a class or function — arrays of grammar node-type *name strings* +
optional hook callbacks:

```ts
export interface LanguageExtractor {
  preParse?: (source, filePath?) => string;   // offset-preserving pre-parse fix
  // node-type name lists (grammar-specific strings):
  functionTypes: string[]; classTypes: string[]; methodTypes: string[];
  interfaceTypes: string[]; structTypes: string[]; enumTypes: string[];
  enumMemberTypes?: string[]; typeAliasTypes: string[]; importTypes: string[];
  callTypes: string[]; variableTypes: string[];
  fieldTypes?: string[]; propertyTypes?: string[];
  // field-name lookups (grammar-specific):
  nameField: string; bodyField: string; paramsField: string; returnField?: string;
  // hooks — pure (node, source) predicates/extractors:
  resolveName?; recoverMangledName?; extractPropertyName?;
  getSignature?; getVisibility?; isExported?; isAsync?; isStatic?; isConst?;
  extractModifiers?; extraClassNodeTypes?; methodsAreTopLevel?;
  skipBodilessClass?; interfaceKind?;
  visitNode?: (node, ctx: ExtractorContext) => boolean;   // custom subtree handler
  synthesizeMembers?: (classNode, ctx) => void;           // e.g. Java Lombok
  classifyClassNode?; classifyMethodNode?; resolveBody?;
  extractImport?: (node, source) => ImportInfo | null;
  extractVariables?: (node, source) => VariableInfo[];
  getReceiverType?; getReturnType?; resolveTypeAliasKind?;
  isMisparsedFunction?; extractBareCall?; packageTypes?; extractPackage?;
}
```

Consumed via `EXTRACTORS: Partial<Record<Language, LanguageExtractor>>`
(`languages/index.ts:40`); dispatch is a map lookup in the constructor:
`this.extractor = EXTRACTORS[this.language] ?? null` (`tree-sitter.ts:412`).

Hooks that emit call back through **`ExtractorContext`**
(`tree-sitter-types.ts:50-71`): `createNode`, `visitNode`, `visitFunctionBody`,
`addUnresolvedReference`, `pushScope`/`popScope`, plus readonly `filePath`,
`source`, `nodeStack`, `nodes`. Also `ImportInfo` (`:19`) and `VariableInfo`
(`:32`).

### 3.2 The output types (`src/types.ts`)

```ts
interface Node {                         // types.ts:120
  id; kind: NodeKind; name; qualifiedName; filePath; language;
  startLine; endLine;                    // 1-indexed
  startColumn; endColumn;                // 0-indexed
  docstring?; signature?;
  visibility?: 'public'|'private'|'protected'|'internal';
  isExported?; isAsync?; isStatic?; isAbstract?;
  decorators?: string[]; typeParameters?: string[]; returnType?;
  updatedAt: number;
}
interface Edge {                         // types.ts:194
  source; target; kind: EdgeKind; metadata?; line?; column?;
  provenance?: 'tree-sitter'|'scip'|'heuristic';
}
interface UnresolvedReference {          // types.ts:304
  fromNodeId; referenceName; referenceKind: ReferenceKind;  // EdgeKind|'function_ref'
  line; column; filePath?; language?; candidates?: string[]; rowId?;
}
interface ExtractionError {              // types.ts:273
  message; filePath?; line?; column?; severity: 'error'|'warning'; code?;
}
```

`NodeKind` — 22 values (`types.ts:18`): file, module, class, struct, interface,
trait, protocol, function, method, property, field, variable, constant, enum,
enum_member, type_alias, namespace, parameter, import, export, route, component.
`EdgeKind` — 12 (`types.ts:48`): contains, calls, imports, exports, extends,
implements, references, type_of, returns, instantiates, overrides, decorates.

### 3.3 The tree-sitter Node API actually used (`src/web-tree-sitter.d.ts`)

The C# node abstraction must expose (this is the *whole* required surface —
navigation only, no queries):

- Node: `type`, `startIndex`/`endIndex` (**byte offsets**),
  `startPosition`/`endPosition` (`{row, column}`), `childForFieldName(name)`,
  `namedChild(i)`, `namedChildCount`, `child(i)`, `childCount`,
  `previousNamedSibling`/`nextNamedSibling`, `parent`, `descendantsOfType(...)`,
  `isNamed`, `hasError`, `text`.
- Tree: `rootNode`, `delete()`.
- Parser: `setLanguage`, `parse(source)`, `delete()`, `reset()`.
- Language: `load(bytes|path)` — grammar handle.
- `getNodeText(node, source) = source.substring(node.startIndex, node.endIndex)`
  (`tree-sitter-helpers.ts:35`) — **byte-offset slicing** (see risk R4).

---

## 4. External dependencies → C# mapping

| CodeGraph dep / Node API | Use | C# / NuGet equivalent | AOT? |
|---|---|---|---|
| `web-tree-sitter` (^0.25.3) | WASM tree-sitter runtime + Node API | **Native `libtree-sitter` via `[LibraryImport]` P/Invoke** (own thin binding). See Section 5A. | ✅ (canonical AOT interop) |
| `tree-sitter-wasms` (^0.1.11) | ~16 common grammar `.wasm` | **Native grammar libs compiled from C source** (`tree_sitter_<lang>()`). | ✅ |
| `src/extraction/wasm/*.wasm` (15 vendored, 45 MB) | niche/patched grammars | **Compile from vendored C source** (Section 5A, R1). | ✅ |
| `worker_threads` (`parse-worker.ts`, `parse-pool.ts`) | multi-core parsing | `System.Threading` — `Parallel.ForEach` / `Channel<T>` + per-thread `TSParser`. Not a native dep. | ✅ |
| `crypto.createHash('sha256')` (`generateNodeId`) | node IDs | `System.Security.Cryptography.SHA256` | ✅ |
| `wasm-runtime-flags.ts` (`--liftoff-only`, re-exec) | V8 turboshaft OOM fix | **DELETE** — V8/Liftoff-specific; native/non-V8 has no such crash. | n/a |
| `path`, `fs/promises` | file I/O | `System.IO.Path`, `System.IO.File` (reuse worker's `FileSystemAccess`) | ✅ |
| regex (`RegExp`) in special extractors | region splitting | `System.Text.RegularExpressions` (use `[GeneratedRegex]` for AOT + speed) | ✅ (source-gen) |
| `JSON.parse` (liquid `.json` templates) | Shopify template refs | `System.Text.Json` **source-generated** `JsonSerializerContext` (worker constraint) | ✅ |

**Whole subsystems that evaporate in C#:** `wasm-runtime-flags.ts` (V8 flag +
re-exec), the WASM-heap "recycle worker every 250 parses" logic (native memory
is malloc/free), and the Emscripten-`Aborted()` stderr filter
(`parse-worker.ts:31-53`).

---

## 5. Porting challenges & risks

### 5A. THE CRITICAL DELIVERABLE — the C# tree-sitter strategy (gates the project)

Target constraints: **.NET 10, `PublishAot=true`, cross-platform
(Win/macOS/Linux, x64+arm64), `JsonSerializerIsReflectionEnabledByDefault=false`,
no JIT-only deps.** The chosen strategy must parse ~31 languages under those
constraints.

**What we actually need from tree-sitter** (established in Section 2.6): parse
bytes → tree, and navigate nodes (type, byte offsets, points, child-by-field,
named children, siblings, parent). **No `.scm` query engine.** The tree-sitter C
API that covers this is ~40 functions and is highly *blittable*: `TSNode` is a
`struct { uint32_t context[4]; const void* id; const TSTree* tree; }`, `TSPoint`
is `{ uint32_t row, column; }`, and the rest take/return pointers and ints. This
is close to an ideal P/Invoke target.

#### Option (a) — Native `libtree-sitter` + precompiled grammar libs via P/Invoke ✅ RECOMMENDED

Existing .NET bindings surveyed:

- **TreeSitter.DotNet** (`mariusgreuel/tree-sitter-dotnet-bindings`) — MIT,
  **actively maintained** (v1.3.0, 2026-01-22; 6 releases; 104K downloads).
  Bundles native `libtree-sitter` + **28+ grammar** native libs across
  `win-x64/x86/arm64`, `linux-x64/x86/arm/arm64`, `osx-x64/arm64` in
  `runtimes/<rid>/native/`. Targets .NET Standard 2.0. 51 MB package. Exposes
  the full Query + navigation API. **AOT: unverified/undocumented.**
- `tree-sitter/csharp-tree-sitter` (official) — P/Invoke via
  `ClangSharpPInvokeGenerator`; low activity, no bundled natives.
- `profMagija/dotnet-tree-sitter`, `Cody-Duncan/...` (CppSharp) — dormant.

None of these bundle CodeGraph's **niche/patched grammars** (cfml, cfquery,
cfscript, cobol, vbnet, arkts, nix, luau, erlang, terraform, scala, pascal, r,
objc). That work — sourcing + compiling those C grammars — is **required
regardless of binding choice**, and is the real cost of the native path.

**Recommended concrete shape:** write a **thin, purpose-built `[LibraryImport]`
binding** to the tree-sitter C API (source-generated marshalling — the
AOT-recommended interop path; `DllImport`'s runtime IL-stub generation is
explicitly "not an option for full Native AOT"). Do **not** take a hard
dependency on TreeSitter.DotNet's managed surface — it may use `DllImport` and is
AOT-unverified; but it is a fine *source* for pre-built common-grammar binaries
to bootstrap. Ship grammars two ways, evolving:

1. **MVP:** loadable native libs per RID in `runtimes/<rid>/native/`, resolved by
   name — mirrors how the worker already ships `better-sqlite3`/`node-pty`
   natives and how electron-builder `asarUnpack`s them.
2. **Shipping optimization:** compile `libtree-sitter` + all grammar
   `parser.c`/`scanner.c` into **one static archive per RID**
   (`libcodegraph-grammars.a`/`.lib`) and link it into the AOT binary
   (`[LibraryImport("__Internal")]`-style / `<DirectPInvoke>` +
   `<NativeLibrary>`), yielding a **single self-contained per-RID worker
   binary** — the cleanest fit for the AOT "one native binary" model.

Pros: native parse speed (faster than WASM); smallest runtime footprint
(`libtree-sitter` ≈ 1 MB; a native grammar lib is far smaller than its WASM —
COBOL is 16 MB as WASM); malloc/free memory (no heap-growth recycling); cleanest
AOT story. Cons: a per-RID C build pipeline for ~31 grammars; niche grammars need
their patched C sources reproduced.

#### Option (b) — Run existing WASM grammars via a .NET WASM runtime ❌ NOT RECOMMENDED

`wasmtime-dotnet` (AOT-compat issue #293 was *recently* closed via PR #348 — not
battle-tested; host-callback/delegate marshalling is the classic AOT pain);
`WasmEdge` (no first-class AOT .NET story); `WACS` (pure-C# WASM — AOT-friendly
but an interpreter far too slow for parsing large repos).

Fatal problems:
- **"Reuse `tree-sitter-wasms` as-is" is largely a myth.** Those `.wasm` are
  **Emscripten** builds targeting web-tree-sitter's specific JS/Emscripten host
  ABI — they are *not* standalone WASI modules. Loading them in Wasmtime would
  require reimplementing tree-sitter's WASM host bindings (the `ts_wasm_store`
  glue web-tree-sitter's C++ provides). You would still be doing grammar-level
  integration work, just harder.
- Embedding Wasmtime (Cranelift JIT, tens of MB of Rust native per platform)
  is a **bigger** native dependency than `libtree-sitter`, plus per-grammar
  JIT-compile startup cost, to run something you can run natively.
- Slower than native; AOT risk higher.

The one appeal (skip C grammar compilation) does not survive the Emscripten-ABI
reality. Reject.

#### Option (c) — Other paths

- **Static-link C grammars into the AOT binary** — this is not a separate option
  but the *packaging endgame of (a)* (shape #2 above). Strongly recommended as
  the final shipping form.
- **Roslyn** — C#-only; cannot parse 40 languages. Reject (as the brief notes).
- **Reimplement parsers in C#** — absurd at 31 grammars. Reject.

#### Recommendation

**Option (a): native `libtree-sitter` + grammars compiled from C, via an
own-authored `[LibraryImport]` binding**, shipped initially as per-RID loadable
native libs and ultimately static-linked into the per-RID AOT worker binary.
Rationale: best AOT fit (P/Invoke-to-C is canonical NativeAOT interop; no
reflection/JIT), best performance, smallest footprint, and it deletes the entire
V8-specific `--liftoff-only`/heap-recycling machinery. The unavoidable cost —
compiling ~31 grammars per platform — is a one-time build-infra investment that
any native path shares and that WASM does not actually avoid.

**Per-platform shipping story.** RIDs: `win-x64`, `win-arm64`, `osx-x64`,
`osx-arm64`, `linux-x64`, `linux-arm64` (+ `linux-musl-*` if Alpine is a target).
Vendor grammar C sources under `third_party/grammars/` (submodules pinned to the
exact commits/ABIs CodeGraph vendored) with CodeGraph's patches reproduced as
`.patch` files. A CI matrix cross-compiles each grammar (`-fPIC`, tree-sitter
headers) into the per-RID static archive; MichalStrehovsky/`PublishAotCross`
(Zig linker) can cross-compile Linux targets from one host. Bootstrap common
grammars from TreeSitter.DotNet's prebuilt binaries to unblock development before
the C build matrix is green.

**Biggest risks of the strategy:** (1) grammar sourcing/patching fidelity
(R1 below); (2) the cross-platform native build matrix (R2); (3) grammar **ABI**
drift changing node-type names the extractor keys on (R3). This decision gates
everything downstream and must be ratified first.

### 5B. Other porting risks (ranked)

- **R1 — Grammar sourcing & patch fidelity (HIGH).** 31 grammars; ~15 are
  niche/patched (`grammars.ts:275` `VENDORED_WASM_LANGS`). CodeGraph vendors
  specific versions *for correctness*: lua/c# ABI-15 (upstream ABI-13 corrupts
  the shared WASM heap / mis-parses primary constructors, `grammars.ts:253-274`),
  a regenerated nix, patched cobol (fixed-format columns) and vbnet. The C# port
  must reproduce the **same grammar version/ABI/patch per language** or
  extraction output silently drifts. Sources are all public
  (`cfmleditor/tree-sitter-cfml`, `yutaro-sakamoto/tree-sitter-cobol`, …) but
  must be pinned and patched deliberately.
- **R2 — Cross-platform native build matrix (HIGH).** Compiling ~31 C grammars
  for 6–8 RIDs (incl. arm64, musl, cross-compilation) and wiring them into the
  AOT publish. New CI muscle for the OpenCowork build; couples to
  electron-builder's native-unpack/sidecar packaging.
- **R3 — AST-walk behavioral fidelity (HIGH).** The 6,658-line
  `TreeSitterExtractor` + per-language configs encode thousands of node-type/
  field-name special cases (C++ namespace prefixing `:937`, Pascal custom
  visitor, Swift class/struct/enum classification, Java Lombok synthesis, RTK
  Query/React/Pinia framework logic, value-refs, function-refs). Must be
  reproduced near-exactly; grammar ABI changes rename nodes. The 140+ tests are
  the spec — port them as golden tests. `EXTRACTION_VERSION = 24`
  (`extraction-version.ts`) shows how often output shape has changed.
- **R4 — UTF-8 byte offsets vs UTF-16 strings (MEDIUM, easy to get wrong).**
  tree-sitter indexes **bytes**; `getNodeText` slices by `startIndex..endIndex`
  byte offsets; positions are byte-derived. C# `string` is UTF-16. The port must
  operate on the **UTF-8 byte buffer** and slice/reconstruct text by byte offset
  (`ReadOnlySpan<byte>` + `Encoding.UTF8`), not by `char` index — a naive
  `string`-index port breaks every `startLine`/column and every `getNodeText`.
  Lines are 1-based (`row+1`), columns 0-based. `preParse` transforms must
  **preserve byte length** (blank with equal-length spaces — tests assert
  `out.length === inp.length`, e.g. macro-blanking).
- **R5 — Parallelism & the daemon model (MEDIUM).** CodeGraph uses N
  worker_threads each with its own WASM heap, recycled every 250 parses; base
  parse timeout 10s (+10s/100 KB, hard-kill 3×, `parse-pool.ts:63/332/75`); pool
  size `clamp(cores-1,1,8)`, cap 16; `MAX_FILE_SIZE = 1 MB` (`index.ts:129`,
  larger skipped). In C#, a `TSParser` is cheap and single-thread; parallelize
  with a bounded `Channel`/`Parallel.ForEach` (one parser per thread), keep
  SQLite writes single-threaded. Native memory removes the recycle need, but a
  parse **timeout + size cap** is still wise (pathological files / grammar
  catastrophic backtracking). The worker is already a long-lived daemon, so
  CodeGraph's crash-budget/respawn machinery is largely redundant.
- **R6 — CFML three-grammar delegation (MEDIUM, niche).** `CfmlExtractor` walks
  raw tree-sitter nodes and dialect-switches across `cfml` + `cfscript` +
  `cfquery` grammars. The most tree-sitter-coupled special extractor; defer.
- **R7 — Determinism (LOW/MEDIUM).** Node IDs embed the start line; a line shift
  rewrites IDs (handled at `index.ts:2188`). Node/edge output order matters for
  stable diffs (tests `.sort()` before comparing). Preserve emission order.

---

## 6. Recommended C# design

### 6.1 Module boundary

A new worker module `Modules/CodeGraph/` (following `Modules/Db|File|Sync`
conventions: `CodeGraphModule.cs` wires RPC methods, `*Tools.cs` handlers,
`*Models.cs` source-gen DTOs). The **extraction engine** is an internal library
inside it, not directly an RPC surface — indexing RPCs (`codegraph.index`,
`codegraph.sync`) drive it. The graph DB is a **separate SQLite file** but reuses
`Modules/Db` patterns (`DbConnectionFactory`, additive `DbSchemaMigrator`).

Proposed namespaces/classes:

```
OpenCowork.Native.Worker.Modules.CodeGraph.Extraction
├─ TreeSitter/
│  ├─ TsBindings.cs        // [LibraryImport] P/Invoke to libtree-sitter C API
│  ├─ TsParser.cs          // IDisposable wrapper (parse, setLanguage, reset)
│  ├─ TsTree.cs / TsNode.cs// readonly struct TsNode over TSNode; navigation
│  ├─ GrammarRegistry.cs   // lang -> tree_sitter_<lang>() handle (DirectPInvoke)
│  └─ SourceText.cs        // UTF-8 byte buffer + byte-offset slicing + line map
├─ ILanguageExtractor.cs   // the LanguageExtractor config contract (record)
├─ Languages/              // one config per language (TypeScriptExtractor.cs, …)
│  └─ LanguageRegistry.cs  // EXTRACTORS map
├─ TreeSitterExtractor.cs  // the visitNode engine + createNode/emit
├─ ExtractorContext.cs
├─ Embedded/               // Vue/Svelte/Astro/Razor/Cfml/MyBatis/Liquid/Dfm
├─ FunctionRef.cs          // FN_REF_SPECS
├─ LanguageDetection.cs    // EXTENSION_MAP, detectLanguage, path detectors
├─ GeneratedDetection.cs   // filename regex
└─ Models.cs               // Node, Edge, UnresolvedReference, ExtractionResult (source-gen JSON)
```

### 6.2 Key design choices

- **`LanguageExtractor` as a `record`/config object** with `string[]` node-type
  arrays + `Func<>`/delegate hooks (or an abstract base with virtual hooks for
  the heavier languages). Keep it data-driven — it is the port's leverage point:
  one generic engine + N thin configs.
- **`TsNode` as a `readonly struct`** wrapping the native `TSNode` (matches
  tree-sitter's value-type node; avoids GC pressure across millions of nodes).
- **`SourceText`** owns the UTF-8 `byte[]`, exposes `Slice(startByte, endByte)`
  → `string` and a byte-offset→(line,col) map, centralizing R4.
- **DTOs source-gen registered** in a `[JsonSerializable]` context (worker's
  `JsonSerializerIsReflectionEnabledByDefault=false` constraint) — only needed
  where results cross the IPC boundary; internal graph writes go to SQLite
  directly.
- **Parsing concurrency** via a bounded `Channel<ParseTask>` + worker loop, one
  `TsParser` per consumer thread; SQLite writes marshalled to a single writer.
- **Reuse** the worker's existing `Modules/File` directory-scan / ignore
  (gitignore/picomatch) logic instead of porting CodeGraph's — flag the overlap
  to the lead (the orchestrator's scan lives in `index.ts`, out of this file's
  scope, but the port should not duplicate ignore handling).
- **Keep an `ExtractionVersion` constant** (= CodeGraph's 24 semantics) to drive
  re-index prompts.

---

## 7. MVP vs later

**MVP language subset (8 grammars):** TypeScript, TSX, JavaScript, JSX, Python,
Go, Java, C#, Rust. Rationale: all are **first-party `tree-sitter/*` grammars
with clean, unpatched C sources and stable ABIs** (lowest R1/R2 risk); they cover
the dominant languages; and TS/JS/C# unlock the **embedded-extractor delegation**
(vue/svelte/astro delegate `<script>` to the TS/JS engine; razor delegates
`@code` to C#) so the SFC path can follow immediately. *(Note: use the vendored
ABI-15 `tree-sitter-c-sharp` per `grammars.ts:263` to get primary-constructor
support.)*

**MVP engine scope:** `TsBindings`/`TsParser`/`TsNode`, `SourceText` (UTF-8),
`TreeSitterExtractor.visitNode` ladder, `createNode` + `contains` edges,
`extractFunction/Class/Method/Interface/Struct/Enum/Import/Call/Variable`,
`generateNodeId`, `detectLanguage`, `GeneratedDetection`. Emit `nodes` +
`contains` edges + `unresolvedReferences`. Port the corresponding golden tests
first.

**MVP can defer:** value-refs (`flushValueRefs`) and function-refs
(`FN_REF_SPECS`, `function-ref.ts`) — big per-language spec tables, additive
edges; the framework-specific branches (React/RTK/Pinia/Rust-macro/Erlang/Lombok)
— large and heuristic; the niche/patched grammars and their languages (cobol,
vbnet, cfml family, arkts, nix, erlang, terraform, scala, pascal, r, luau, objc,
dart, kotlin, swift, php, ruby, solidity); the bespoke embedded extractors
beyond a first Vue/Svelte slice; multi-grammar CFML (R6). The pure-regex
extractors (**MyBatis, Liquid, DFM** — no tree-sitter at all) are trivial and can
come whenever their language matters.

---

## 8. Open questions / decisions for the architect

1. **Grammar packaging: static-link-into-AOT-binary vs loadable per-RID native
   libs.** Gates the whole build/release pipeline and the electron-builder
   sidecar packaging. Recommend static-link as the endgame, loadable libs for
   MVP. *(Cross-cuts the build/infra owner.)*
2. **Who owns the grammar build matrix + patch reproduction?** ~31 grammars × 6–8
   RIDs with CodeGraph's exact versions/patches (R1/R2). Needs a dedicated CI job
   and an owner; shared with whoever owns native-dep packaging
   (`better-sqlite3`/`node-pty` today).
3. **Own-authored `[LibraryImport]` binding vs adopting TreeSitter.DotNet.**
   Recommend own binding for the AOT guarantee + minimal surface (navigation
   only), using TreeSitter.DotNet only as a prebuilt-binary source. Confirm.
4. **Reuse the worker's `Modules/File` scan/ignore instead of porting
   CodeGraph's orchestrator scan?** Likely yes — avoids duplicating gitignore/
   ignore/discovery. Confirms the extraction module's boundary (per-file engine
   only; orchestration is the worker's).
5. **Parallelism primitive & memory posture** in a long-lived daemon: `Channel`
   + per-thread parser, SQLite single-writer, plus a parse timeout + `MAX_FILE_SIZE`
   (1 MB) cap. Confirm the daemon makes CodeGraph's crash-budget/respawn/
   worker-recycle machinery redundant (native memory ≠ ever-growing WASM heap).
6. **Scope line: does "extraction" include the resolver?** This file covers
   nodes + `contains`/value-ref edges + `unresolvedReferences` only. The
   `src/resolution/` phase that turns refs → `calls`/`imports`/`extends` edges is
   a separate analysis (flag to whoever owns resolution/framework-edges).
7. **MVP edge features:** ship value-refs/function-refs in MVP or defer? They are
   sizeable per-language tables but materially change which `references` edges
   exist (impact analysis). Recommend defer; confirm.
```
