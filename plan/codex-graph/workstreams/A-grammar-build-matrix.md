# Workstream A — Tree-sitter Grammar Build & Packaging Matrix

> **⚠ Delivery decision (RATIFIED, [reference/04](../reference/04-process-model-and-enablement.md) §6):**
> grammars are **downloaded on enable**, not bundled. So this matrix's *output* is
> **per-RID grammar packs** (`codegraph-grammars-<setVersion>-<rid>.zip`) + a signed
> `manifest.json`, published as **release artifacts** — *not* copied into any binary's
> `dotnet publish` output. Only `libtree-sitter` **core** is built per-RID and bundled
> with the `OpenCowork.CodeGraph.Worker` Exe. The build/cross-compile mechanics below
> are unchanged; only the final packaging target moves from "beside the binary" to
> "release asset fetched into `~/.open-cowork/codegraph/grammars/<setVersion>/<rid>/`".
>
> **Owner:** TBD (must be ratified — see §6). Couples to whoever owns native-dep
> packaging today (`better-sqlite3` / `node-pty` rebuild + electron-builder
> `asarUnpack`).
> **Risk:** 🔴 HIGH. This is the project's biggest new build-CI muscle:
> ~31 grammars × 6–8 RIDs, cross-compiled from C into the .NET 10 native-AOT
> worker, with CodeGraph's *exact* vendored versions / ABIs / patches reproduced.
> **Realizes:** Decision 1 (native `libtree-sitter` + `[LibraryImport]`, no WASM);
> risks R2 (grammar sourcing/patch fidelity) and R3 (cross-platform build matrix)
> from `00-overview-and-roadmap.md` §8.
>
> Ground truth is CodeGraph v1.4.1's `src/extraction/grammars.ts` and the 15
> vendored `src/extraction/wasm/*.wasm`. Every claim below cites those. The port
> **compiles the same grammars from C source** instead of loading Emscripten WASM;
> the WASM files here are only a size/parity reference, never shipped.

---

## 0. Why this workstream exists (the one-paragraph frame)

CodeGraph ships tree-sitter as **WASM** (`web-tree-sitter ^0.25.3` +
`tree-sitter-wasms ^0.1.11`, plus 15 hand-vendored `.wasm` under
`src/extraction/wasm/`; `package.json`). The C# port **forbids WASM** (Decision 1,
analysis/06 §8.3): the AOT worker loads a native `libtree-sitter` and native
grammar libraries via a source-generated `[LibraryImport]` binding. There is **no
tree-sitter query engine** to build (analysis/01 §2.6 — CodeGraph uses zero `.scm`
queries; extraction is 100% manual node-navigation), so the native surface is just
parse + navigate. That shrinks the *runtime* problem but not the *build* problem:
every one of the ~31 grammars must be compiled from `parser.c`/`scanner.c` for
every shipped RID, with the same grammar version/ABI/patch CodeGraph vendored, or
extraction silently drifts (R2/R3). This document is the build spec for that.

---

## 1. Full grammar inventory (31 distinct grammar libs)

The set is derived from `WASM_GRAMMAR_FILES` (`grammars.ts:20-53`) — 32 language
keys, but `jsx` reuses `tree-sitter-javascript` (`grammars.ts:26`), so **31
distinct grammar libraries**. `VENDORED_WASM_LANGS` (`grammars.ts:275-278`) marks
the **15** that CodeGraph could *not* take clean from `tree-sitter-wasms` and
hand-vendored — these carry ABI pins and/or patches and are the R2 core.

Legend — **Tier**: `MVP` = the 8 first-party clean grammars shipped in M2;
`later` = M6 demand-driven tail. **Clean/Patched**: `clean` = unmodified upstream
first-party `tree-sitter/*`; `vendored` = CodeGraph pinned a specific
version/ABI/build; `patched` = CodeGraph modified the C source. **WASM size** is
the *vendored* `.wasm` actual (from `ls src/extraction/wasm/`) or a
`tree-sitter-wasms` typical — native `.a`/`.o` is **substantially smaller** (WASM
carries Emscripten runtime + weaker dead-code elim; e.g. COBOL is 16 MB as WASM
but its native archive is a fraction of that — analysis/01 §5A).

### 1A. MVP tier — the 8 grammars shipped in M2 (all clean first-party)

| # | Language | Ext (EXTENSION_MAP) | Source repo | Pin / ABI | Clean? | WASM size (ref) | Notes |
|--:|----------|--------------------|-------------|-----------|--------|-----------------|-------|
| 1 | typescript | `.ts .mts .cts` (`:59,62-63`) | `tree-sitter/tree-sitter-typescript` | v0.23.x, ABI-15 | clean | ~1.1 MB (tsw) | `.mts/.cts` parse as TS-no-JSX (#366, `:61`) |
| 2 | tsx | `.tsx` (`:60`) | `tree-sitter/tree-sitter-typescript` (tsx dir) | v0.23.x, ABI-15 | clean | ~1.1 MB (tsw) | separate grammar lib from `typescript` |
| 3 | javascript | `.js .mjs .cjs .xsjs .xsjslib` (`:68-73`) | `tree-sitter/tree-sitter-javascript` | v0.23.x, ABI-15 | clean | ~0.5 MB (tsw) | `.xsjs*` = SAP HANA XS (#556) |
| 4 | jsx | `.jsx` (`:74`) | **shares `tree-sitter-javascript`** (`:26`) | — | clean | (shared) | **not a distinct lib** — same handle as javascript |
| 5 | python | `.py .pyw` (`:75-76`) | `tree-sitter/tree-sitter-python` | v0.23.x, ABI-15 | clean | ~0.4 MB (tsw) | |
| 6 | go | `.go` (`:77`) | `tree-sitter/tree-sitter-go` | v0.23.x, ABI-15 | clean | ~0.2 MB (tsw) | |
| 7 | java | `.java` (`:79`) | `tree-sitter/tree-sitter-java` | v0.23.x, ABI-15 | clean | ~0.5 MB (tsw) | |
| 8 | csharp | `.cs` (`:87`) | `tree-sitter/tree-sitter-c-sharp` | **0.23.5, ABI-15 — VENDORED** | **vendored** | **5.35 MB** | ABI-13 tsw build parses `class Foo(...)` as ERROR, swallows the class (#237); vendored ABI-15 parses primary constructors (`grammars.ts:259-263`) |
| 9 | rust | `.rs` (`:78`) | `tree-sitter/tree-sitter-rust` | v0.23.x, ABI-15 | clean | ~0.9 MB (tsw) | |

**MVP grammar-lib count = 8** (jsx shares #3). Note csharp, though a first-party
`tree-sitter/*` repo, is in `VENDORED_WASM_LANGS` because the *tree-sitter-wasms
build* is ABI-13 and wrong — the port must pin **tree-sitter-c-sharp 0.23.5 (ABI-15)
source**, not whatever `tree-sitter-wasms 0.1.11` bundled. This is the one MVP
grammar that needs deliberate version pinning.

### 1B. Later tier — the 23 remaining grammars (M6, demand-driven)

**Clean first-party / community, sourced via `tree-sitter-wasms 0.1.11`** (pin the
upstream commit `tree-sitter-wasms` built — its bundled ABI/node-types are what the
extractor's type-arrays key on; R3):

| # | Language | Ext | Upstream repo | Clean? | WASM size (ref) | Notes |
|--:|----------|-----|---------------|--------|-----------------|-------|
| 10 | c | `.c .h` (`:80-81`) | `tree-sitter/tree-sitter-c` | clean | ~0.2 MB (tsw) | `.h` defaults to C; content heuristic may switch to cpp/objc (`grammars.ts:428-431`) |
| 11 | cpp | `.cpp .cc .cxx .hpp .hxx` + `.metal .cu .cuh` (`:82-86,135,141-142`) | `tree-sitter/tree-sitter-cpp` | clean | ~1.4 MB (tsw) | Metal/CUDA reuse cpp via pre-parse blanking (#1121,#387) |
| 12 | php | `.php .module .install .theme .inc` (`:88,90-93`) | `tree-sitter/tree-sitter-php` | clean | ~0.6 MB (tsw) | Drupal exts (`:90-93`) |
| 13 | ruby | `.rb .rake` (`:103-104`) | `tree-sitter/tree-sitter-ruby` | clean | ~0.5 MB (tsw) | has external scanner |
| 14 | swift | `.swift` (`:105`) | `alex-pinkus/tree-sitter-swift` | clean* | ~1.5 MB (tsw) | community; **external scanner** (heavier build) |
| 15 | kotlin | `.kt .kts` (`:106-107`) | `fwcd/tree-sitter-kotlin` | clean* | ~0.9 MB (tsw) | community |
| 16 | dart | `.dart` (`:108`) | `UserNobody14/tree-sitter-dart` | clean* | ~0.6 MB (tsw) | community; external scanner |
| 17 | objc | `.m .mm` (`:124-125`) | `jiyee/tree-sitter-objc` (via tsw) | niche | ~0.4 MB (tsw) | niche per R1; reached from `.h` heuristic too |
| 18 | solidity | `.sol` (`:126`) | `JoranHonig/tree-sitter-solidity` | clean* | ~0.3 MB (tsw) | community |

**Vendored / patched (the R2 core — 11 of the 15 `VENDORED_WASM_LANGS` beyond
csharp; each carries a pinned commit and often a `.patch`):**

| # | Language | Ext | Vendored source | Pin / ABI | Patch / why (cite) | WASM size (actual) |
|--:|----------|-----|-----------------|-----------|--------------------|--------------------|
| 19 | lua | `.lua` (`:121`) | upstream `tree-sitter-lua` **ABI-15** | ABI-15 | tsw ships ABI-13 that **corrupts the shared WASM heap** under wts 0.25 (drops nested calls/imports after file #1); vendor ABI-15 (`grammars.ts:256-259`). *In C# the heap-corruption cause is WASM-only — but still pin ABI-15 source for node-type parity.* | **48 KB** |
| 20 | luau | `.luau` (`:122`) | upstream `tree-sitter-luau` | vendored | tsw build too old/absent (`grammars.ts:253-255`) | 92 KB |
| 21 | pascal | `.pas .dpr .dpk .lpr .dfm .fmx` (`:114-119`) | vendored `tree-sitter-pascal` | vendored | tsw build too old/absent; `.dfm/.fmx` also route to the DFM extractor | 0.70 MB |
| 22 | scala | `.scala .sc` (`:120`) | vendored `tree-sitter-scala` | vendored | tsw build too old/absent | 4.96 MB |
| 23 | r | `.r` (`:113`) | vendored `tree-sitter-r` | vendored | tsw build too old/absent | 0.48 MB |
| 24 | cfml | `.cfc .cfm` (`:129-130`) | `cfmleditor/tree-sitter-cfml` | vendored | tag-aware CFML; **CfmlExtractor dialect-switches** to cfscript/cfquery (R6, analysis/01) | 2.70 MB |
| 25 | cfscript | `.cfs` (`:131`) | `cfmleditor/tree-sitter-cfml` (cfscript) | vendored | bare-script CFML dialect | 2.16 MB |
| 26 | cfquery | (delegated from cfml) | `cfmleditor/tree-sitter-cfml` (cfquery) | vendored | `<cfquery>` SQL bodies; only reached via cfml delegation (`grammars.ts:301-303`) | 2.41 MB |
| 27 | cobol | `.cbl .cob .cobol .cpy` (`:150-153`) | `yutaro-sakamoto/tree-sitter-cobol` | **PATCHED** | patched for **fixed-format column rules, EXEC CICS/SQL blocks, standalone copybook fragments** (`grammars.ts:148-149`) | **16.36 MB** ← largest |
| 28 | vbnet | `.vb` (`:156`) | `govindbanura/tree-sitter-vbnet` | **PATCHED** | patched: classes, modules, interfaces, structures, properties, events, **Handles clauses, LINQ** (`grammars.ts:154-155`) | 6.48 MB |
| 29 | erlang | `.erl .hrl .escript` + `.app/.app.src` (`:159-164`) | `WhatsApp/tree-sitter-erlang` (ELP) | vendored | first-class `shebang` node for escript (`:161-162`); `.app`/`.app.src` via `isErlangAppFile` (`:213-215`) | 0.42 MB |
| 30 | terraform | `.tf .tfvars .tofu` (`:170-172`) | `@tree-sitter-grammars/tree-sitter-hcl 1.2.0` (Apache-2.0) | vendored | tsw ships **no** HCL/Terraform; vendored prebuilt is byte-identical to npm (`grammars.ts:263-266`) | 92 KB |
| 31 | arkts | `.ets` (`:67`) | `harmony-contrib/tree-sitter-arkts 0.2.0` (MIT) | vendored | tsw absent; extends `tree-sitter-javascript` with `struct_declaration` + `arkui_component_expression` build() DSL (`grammars.ts:266-271`) | 4.38 MB |
| 32 | nix | `.nix` (`:143`) | `nix-community/tree-sitter-nix @ 3d0173d` (MIT) | **REGENERATED ABI-15** | wasm built with `tree-sitter-cli 0.25.10` (`generate` + `build --wasm`); **upstream's checked-in `parser.c` is still ABI-13** — must `generate` from grammar.js to get ABI-15; all 54 upstream corpus tests pass (`grammars.ts:271-274`) | 81 KB |

**Distinct grammar-lib total = 31** (rows 1–3,5–32 minus jsx's shared lib = 31).
`VENDORED_WASM_LANGS` = **15**: `pascal, scala, lua, luau, csharp, r, cfml,
cfscript, cfquery, cobol, vbnet, erlang, terraform, arkts, nix` (`grammars.ts:276-277`)
— confirmed 1:1 against the 15 files in `src/extraction/wasm/`.

**Not grammars (excluded from the build matrix — no tree-sitter parse):** `svelte,
vue, astro, liquid, razor, yaml, twig, xml, properties, unknown`
(`grammars.ts:14`). These use bespoke/regex/delegating extractors or file-level-only
tracking. They ship as C# code, not native libs. (`svelte/vue/astro` delegate
`<script>` to the TS/JS grammars; `razor` delegates `@code` to the C# grammar; so
they need MVP grammars present but add no build-matrix rows.)

**Patch-fidelity call-out (R2):** the three that *modify or regenerate C* — **cobol
(patched), vbnet (patched), nix (regenerated to ABI-15)** — plus the ABI pins
(**csharp 0.23.5, lua ABI-15**) are the fidelity-critical set. Reproduce these as
committed `.patch` files (§3) and gate them with a golden extraction test (WS-B):
a wrong ABI renames node types and the extractor's `functionTypes/classTypes`
arrays silently stop matching (R3).

---

## 2. The RID matrix

Every shipped grammar **must exist for every shipped RID** — a partial matrix means
`codegraph/*` degrades on that platform (or, worse, `DllNotFoundException` at first
P/Invoke; analysis/06 §8.3 note 4). The app's RID set is fixed by
`getCurrentRid()` (`src/main/lib/native-worker.ts:1058-1061`) and
`publish-native-worker.mjs:19-25`:

| RID | Platform | Toolchain (host→target) | Tier | musl? |
|-----|----------|-------------------------|------|-------|
| `osx-arm64` | macOS Apple Silicon | clang, native or `-arch arm64` | ship | — |
| `osx-x64` | macOS Intel | clang, native or `-arch x86_64` | ship | — |
| `win-x64` | Windows x64 | clang-cl / MSVC | ship | — |
| `win-arm64` | Windows ARM64 | clang-cl (cross) | ship | — |
| `linux-x64` | Linux glibc x64 | gcc/clang, or Zig cross | ship | glibc |
| `linux-arm64` | Linux glibc arm64 | Zig cross / aarch64 gcc | ship | glibc |
| `linux-musl-x64` | Alpine x64 | Zig `-target x86_64-linux-musl` | **optional** | musl |
| `linux-musl-arm64` | Alpine arm64 | Zig `-target aarch64-linux-musl` | **optional** | musl |

**Baseline = 6 RIDs** (the two `osx-*`, two `win-*`, two `linux-*`). musl is only
needed if Alpine is a worker target — the worker currently ships glibc; add the two
musl RIDs **only if** an Alpine distribution is ratified (open Q for the lead).
So the matrix is **6 (baseline) → 8 (with musl)**.

**Matrix magnitude:** MVP is **8 grammars × 6 RIDs = 48** artifact builds
(`libtree-sitter` core ×6 on top). Full parity is **31 × 6 = 186** (or **248** with
musl). This is the R3 scale that mandates a CI matrix, not a laptop build.

---

## 3. Vendoring layout (`third_party/grammars/`)

Vendor grammar **C sources** (never the WASM) as pinned git submodules, with
CodeGraph's modifications reproduced as committed `.patch` files applied at build
time. Repo-root sibling of `sidecars/` (already sketched in `00-overview` §4 as
`third_party/grammars/`).

```
third_party/
  tree-sitter/                         # the CORE runtime, pinned
    (submodule: tree-sitter/tree-sitter @ v0.25.x)   # libtree-sitter — matches
                                                      # web-tree-sitter ^0.25.3 ABI-15
  grammars/
    manifest.json                      # single source of truth: lang → {repo, commit,
                                       #   abi, subdir, needs_generate, patches[], scanner}
    tree-sitter-typescript/  (submodule @ v0.23.x)
    tree-sitter-javascript/  (submodule @ v0.23.x)
    tree-sitter-python/      (submodule @ v0.23.x)
    tree-sitter-go/          (submodule @ v0.23.x)
    tree-sitter-java/        (submodule @ v0.23.x)
    tree-sitter-c-sharp/     (submodule @ v0.23.5)   # ABI-15, primary ctors (#237)
    tree-sitter-rust/        (submodule @ v0.23.x)
    # --- later tier ---
    tree-sitter-c/  tree-sitter-cpp/  tree-sitter-php/  tree-sitter-ruby/
    tree-sitter-swift/ (external scanner)  tree-sitter-kotlin/  tree-sitter-dart/
    tree-sitter-objc/  tree-sitter-solidity/  tree-sitter-lua/ (ABI-15)  tree-sitter-luau/
    tree-sitter-pascal/  tree-sitter-scala/  tree-sitter-r/  tree-sitter-erlang/
    tree-sitter-cfml/  (cfml + cfscript + cfquery in one repo)
    tree-sitter-cobol/       (submodule @ yutaro-sakamoto pin)
      patches/0001-fixed-format-columns.patch
      patches/0002-exec-cics-sql-blocks.patch
      patches/0003-standalone-copybook.patch
    tree-sitter-vbnet/       (submodule @ govindbanura pin)
      patches/0001-handles-clauses.patch
      patches/0002-linq.patch
    tree-sitter-terraform/   (submodule @ tree-sitter-grammars/tree-sitter-hcl v1.2.0)
    tree-sitter-arkts/       (submodule @ harmony-contrib v0.2.0)
    tree-sitter-nix/         (submodule @ nix-community 3d0173d, needs_generate=true)
```

**`manifest.json` per-grammar fields** (drives the CI build; §4):
`{ name, language_keys[], repo, commit, abi, src_subdir, needs_generate (bool),
scanner ("c"|"cpp"|null), patches[], license }`. `needs_generate:true` (nix)
means run `tree-sitter generate` from `grammar.js` before compiling (regenerates
`parser.c` at ABI-15 — `grammars.ts:271-274`). `scanner:"cpp"` (swift, dart, etc.)
means compile `scanner.cc` with the C++ toolchain and link libstdc++.

**Recovering the tree-sitter-wasms pins.** The 16 non-vendored grammars come from
`tree-sitter-wasms 0.1.11` (`package.json`). Its build script records the exact
upstream commit per grammar — extract those into `manifest.json` so the C sources
match the ABI/node-types the extractor was written against (R3). Do **not** pull
`main` of each upstream repo; pin the commit `tree-sitter-wasms@0.1.11` built.

**libtree-sitter core pinning.** Pin `tree-sitter/tree-sitter` to the **v0.25.x**
release matching `web-tree-sitter ^0.25.3` (the nix note used CLI 0.25.10 —
`grammars.ts:272`), so the core's supported ABI range includes the ABI-15 grammars.
Compile `lib/src/lib.c` (the amalgamation) once per RID into `libtree-sitter.a`.
This is the only "core" dependency; there is **no query-engine** build (analysis/01
§2.6), but the amalgamation includes it harmlessly.

---

## 4. The CI build approach

### 4.1 Per-grammar compile (the inner loop)

For each `(grammar, rid)`: apply patches → optionally `tree-sitter generate` →
compile `parser.c` (+ `scanner.c`/`scanner.cc` if present) `-fPIC` with the
tree-sitter headers on the include path → archive.

```
# pseudo, per manifest entry, per RID
git -C $G checkout $commit && for p in $patches; do git apply $p; done
[ "$needs_generate" = true ] && tree-sitter generate $G/grammar.js   # nix: ABI-15
$CC -fPIC -O2 -I third_party/tree-sitter/lib/include \
    -c $G/$src_subdir/parser.c   -o out/$rid/$name.parser.o
[ -n "$scanner" ] && $CXXorCC -fPIC -O2 -c $G/$src_subdir/scanner.* -o out/$rid/$name.scanner.o
```

Each grammar exposes a single C entry `tree_sitter_<lang>()` returning a
`const TSLanguage*` — the `GrammarRegistry` (`Extraction/TreeSitter/`) resolves it
by name via `[LibraryImport]`/`<DirectPInvoke>` (analysis/01 §6.1). ABI is asserted
at load: `ts_language_abi_version(lang)` must be **15** (14/15 acceptable for the
0.25 core) — fail the build if a grammar drifts to ABI-13 (guards R3).

### 4.2 Cross-compiling from a single host — Zig linker / PublishAotCross

The killer requirement is Linux-arm64 + musl from an x64 CI host, and the two
`osx-*`/`win-*` targets. Two proven levers (analysis/01 §5A per-platform story):

- **Zig as the cross C compiler/linker** for the grammar objects:
  `zig cc -target aarch64-linux-gnu` / `-target x86_64-linux-musl` etc. — one host
  builds all Linux (glibc+musl, x64+arm64) grammar archives. `zig cc` also handles
  the C++ scanners (swift/dart/kotlin) with a bundled libc++.
- **`MichalStrehovsky/PublishAotCross`** (Zig-backed) for the *dotnet publish AOT*
  link step so the AOT worker itself cross-compiles Linux-from-host. macOS targets
  build on a macOS runner (both arches via `-arch`); Windows on a Windows runner
  (`clang-cl`, arm64 cross). So the CI matrix is **3 runner OSes** (mac/win/linux)
  emitting **6–8 RID** artifact sets.

CI job shape (GitHub Actions matrix): `os: [macos-14, windows-2022, ubuntu-22.04]`
× `rid` (each runner emits its native + its cross targets), producing per-RID
grammar bundles as build artifacts, cached by `manifest.json` hash so unchanged
grammars don't rebuild.

### 4.3 The two packaging endgames

**Endgame 1 — MVP: loadable per-RID native libs (M2).** Package each RID's
grammar objects + `libtree-sitter` as **loadable shared libs** laid out as
`runtimes/<rid>/native/*` and referenced from
`OpenCowork.Native.Worker.csproj`. `dotnet publish -r <rid>` **auto-copies NuGet /
per-RID runtime native assets next to the AOT binary** — analysis/06 §8.2 confirms
this is exactly how `libe_sqlite3.dylib` already lands beside the 17 MB worker in
`resources/native-worker/`, with **zero electron-builder changes** (because
`electron-builder.yml:95-96` already `asarUnpack`s all of `resources/**`). So the
grammar libs ride the *existing* `publish-native-worker.mjs` flow: publish → copy
`tempOutputDir → resources/native-worker/` (script lines 30-59). Two delivery
shapes, both AOT-valid (analysis/06 §8.3 note 3):
  - (a) an **internal NuGet** carrying `runtimes/<rid>/native/…` (preferred — publish
    selects the RID and copies automatically), or
  - (b) csproj `<None Include="native/<rid>/libtree-sitter.*"
    CopyToOutputDirectory="PreserveNewest" Condition="'$(RuntimeIdentifier)'=='<rid>'" />`
    per RID (the build matrix you own; more explicit, no NuGet feed needed).
  Recommend (b) for MVP (self-contained in-repo, no feed), migrate to (a) if the
  grammar set is reused elsewhere.

**Endgame 2 — shipping optimization: static archive linked into the AOT binary
(M6).** Combine `libtree-sitter` + all grammar `.o` into **one static archive per
RID** (`libcodegraph-grammars.a` / `.lib`) and link it into the AOT worker via
`<DirectPInvoke Include="tree_sitter_*" />` + `<NativeLibrary
Include="libcodegraph-grammars.a" />`, so `tree_sitter_<lang>()` resolves at link
time (`[LibraryImport("__Internal")]`-style). Result: a **single self-contained
per-RID worker binary** — the cleanest fit for the AOT "one native binary" model
(analysis/01 §5A shape #2). Trade-off: lazy per-grammar loading (a missing grammar
degrades one method, not boot — analysis/06 §8.3 note 4, WS-C) is easy with
loadable libs and harder when everything is statically linked; keep the static
endgame gated behind lazy-init that catches missing symbols. Recommend **shipping
MVP as loadable (endgame 1)** and only moving to static once the matrix is green
and size/startup measurably benefit.

### 4.4 Coupling to the existing pipeline (summary)

```
third_party/grammars (submodules+patches)
   │  WS-A CI matrix (Zig cross, 3 runners → 6–8 RIDs)
   ▼
native/<rid>/{libtree-sitter, grammar libs}   ← csproj per-RID <None>/NuGet runtime assets
   │  publish-native-worker.mjs: dotnet publish -r <rid>  (auto-copies runtime natives)
   ▼
resources/native-worker/<rid>/…               ← same dir as libe_sqlite3.dylib today
   │  electron-builder.yml asarUnpack: resources/**  (already present)
   ▼
shipped installer  (loaded by resolveNativeWorkerPath, native-worker.ts:999)
```

No new electron-builder wiring is needed — the whole delivery is subsumed by the
`resources/native-worker/` + `asarUnpack: resources/**` path that already ships the
SQLite native lib (analysis/06 §8.1-8.2).

---

## 5. Bootstrap plan (unblock M0/M2 before the C matrix is green)

The C build matrix (§4) is the long pole. Do **not** block the M0 tree-sitter
`[LibraryImport]` spike or the M2 extraction engine on it:

1. **M0/early-M2: use `TreeSitter.DotNet` prebuilt binaries** as a *binary source*
   (analysis/01 §5A option (a)): `mariusgreuel/tree-sitter-dotnet-bindings` bundles
   native `libtree-sitter` + 28+ grammar libs across `win-x64/x86/arm64`,
   `linux-x64/x86/arm/arm64`, `osx-x64/arm64` in `runtimes/<rid>/native/`. Extract
   its `libtree-sitter.*` and the **MVP-8** grammar libs (ts/tsx/js/python/go/java/
   rust — and c# *only if its bundled build is ABI-15*; otherwise vendor c# first)
   and drop them into `native/<rid>/` to prove the P/Invoke binding, the parse walk,
   and the auto-copy-into-`resources/native-worker/` flow on the dev RID.
   **Do not take a managed dependency on TreeSitter.DotNet's API** — it may use
   `DllImport` and is AOT-unverified (analysis/01 §5A, Decision 1); own the
   `[LibraryImport]` binding, borrow only the `.so`/`.dylib`/`.dll` bytes.
2. **Replace incrementally.** As each `(grammar, rid)` goes green in the CI matrix,
   swap the bootstrapped binary for the reproducible in-house build. csharp,
   lua, and the patched/regenerated set (cobol/vbnet/nix) are **never** bootstrapped
   from TreeSitter.DotNet — their ABI/patch fidelity is the whole point (R2), so they
   come from `third_party/grammars/` from day one.
3. **Exit criterion for the bootstrap:** all 6 baseline RIDs build the MVP-8 from
   `third_party/` reproducibly in CI; then the M2 acceptance ("index a mid-size
   TS+Go+Python repo") runs on in-house binaries, and TreeSitter.DotNet is dropped
   from the tree.

---

## 6. Risks & owner asks

### R2 — Grammar sourcing / patch fidelity (🔴 HIGH)

~15 grammars need exact vendored ABIs/patches or extraction silently drifts
(`00-overview` §8 R2; analysis/01 R1). Concrete fidelity-critical items, each a
committed artifact under `third_party/grammars/*/patches/` + a WS-B golden test:
  - **csharp** must be `tree-sitter-c-sharp 0.23.5 ABI-15** (primary constructors,
    #237) — not the tsw ABI-13 build.
  - **lua** must be **ABI-15** upstream (tsw ABI-13 corrupts parses).
  - **cobol** — 3 patches (fixed-format columns, EXEC CICS/SQL, standalone copybooks).
  - **vbnet** — 2 patches (Handles clauses, LINQ).
  - **nix** — `needs_generate` (upstream `parser.c` is ABI-13; regenerate to ABI-15).
  - **terraform/arkts** — byte-identical vendored prebuilts; pin the exact npm-tarball
    commit.
  Mitigation: MVP ships only the 8 clean first-party grammars (§1A), deferring all 11
  patched/vendored niche grammars + objc to M6; assert `ts_language_abi_version()==15`
  at build and load.

### R3 — Cross-platform native build matrix (🔴 HIGH)

31 grammars × 6–8 RIDs into the AOT publish is new CI muscle (`00-overview` §8 R3).
Mitigation: start **8 × 1 RID** (dev host, M0), scale to **8 × 6** (M2), then
**31 × 6–8** (M6) via the Zig-cross matrix (§4.2); cache by `manifest.json` hash so
the 186–248-cell full matrix only rebuilds changed grammars.

### Owner asks (ratify before M2 exits — `00-overview` §7 decision 1)

1. **Who owns this CI job?** It must sit with whoever owns native-dep packaging
   today (`better-sqlite3`/`node-pty` rebuild + `publish-native-worker.mjs` +
   `asarUnpack`). Unowned, the matrix rots and RIDs silently lose grammars.
2. **Packaging endgame:** ratify **loadable per-RID libs for MVP** (endgame 1,
   §4.3) and **static-link-into-AOT for shipping** (endgame 2) — or stop at loadable
   if the size/startup win doesn't justify the lazy-load complexity.
3. **musl / Alpine:** in or out? Decides 6 vs 8 RIDs and whether the Zig
   `*-linux-musl` targets are on the critical path.
4. **Installer-size impact:** the worker binary is already ~17 MB
   (analysis/06 §8.3 note 6). MVP-8 native grammar libs add a few MB per RID
   (mostly the 5.35 MB c#); **full parity adds the heavy tail** — cobol (16 MB
   WASM → several MB native), vbnet (6.5 MB WASM), scala (5 MB), arkts (4.4 MB).
   Since installers are per-RID, only *one* RID's grammar set ships to each user,
   so the *download* delta is bounded (single-RID), but the **repo/CI artifact
   store** holds all 6–8 sets. Ratify an installer-size budget before the full
   tail lands (static-link + `StripSymbols` + `-Os` on the huge state tables help).

---

## Appendix — grammar-count reconciliation

- `WASM_GRAMMAR_FILES` keys: **32** (`grammars.ts:20-53`); `jsx` reuses the
  `javascript` lib (`:26`) ⇒ **31 distinct grammar libraries** to build.
- `VENDORED_WASM_LANGS`: **15** (`grammars.ts:275-278`) — 1:1 with the 15 files in
  `src/extraction/wasm/`.
- **MVP tier: 8** grammar libs (ts, tsx, js[+jsx], python, go, java, csharp, rust).
- **Later tier: 23** (10 clean-via-tsw incl. objc + 11 vendored/patched + … = 23).
- Non-grammar extractors (svelte/vue/astro/liquid/razor/yaml/twig/xml/properties):
  **0 build-matrix rows** (ship as C#; delegate to MVP grammars where needed).
</content>
</invoke>
