# 03 — Native tree-sitter `[LibraryImport]` Binding Spec

> **Milestone:** M0 (spike) → M2 (production). This is the concrete P/Invoke
> reference an engineer uses to write the C# binding to native `libtree-sitter`
> inside the OpenCowork .NET 10 native-AOT worker.
>
> **Authority:** `analysis/01-extraction-tree-sitter.md` (esp. §2.6 no-`.scm`,
> §3.3 the exact Node API, §5A the strategy, §6.1 class shapes) and
> `00-overview-and-roadmap.md` Decisions **1** (native `[LibraryImport]`, reject
> WASM), **10** (heartbeat — parse off the shared pool), **22** (UTF-8 bytes, not
> UTF-16 chars). Target csproj: `sidecars/OpenCowork.Native.Worker/…` with
> `PublishAot=true`, `JsonSerializerIsReflectionEnabledByDefault=false`.
>
> **Non-negotiable:** all native interop uses `[LibraryImport]` (source-generated
> marshalling), **never** `[DllImport]` — `DllImport`'s runtime IL-stub
> generation is not supported under full Native AOT (WS-C).

Namespace/location per Decision 6 (global namespace, `CodeGraph*` prefix):
`Modules/CodeGraph/Extraction/TreeSitter/`.

---

## 1. The required C API surface

Established in analysis-01 §2.6: **CodeGraph uses zero `.scm` queries** —
`grep '\.query('` in `src/extraction/` is 2 false positives ("RTK **Query**")
and comment mentions. Every extractor walks the tree by hand
(`namedChild(i)`/`childForFieldName`/`parent` recursion). The measured node-API
footprint over the 6,658-line engine (`tree-sitter.ts`):

```
126 startPosition   124 namedChild   89 namedChildCount   14 parent
  7 startIndex        6 child          5 childCount         4 endPosition
  3 endIndex          2 nextNamedSibling  1 previousNamedSibling  1 isNamed
```

Plus `type`, `endPosition`, `childForFieldName`, `hasError`, `descendantsOfType`,
and byte-offset text slicing (`getNodeText`). That maps to the following C API
(`tree_sitter/api.h`). **~40 functions.** Grouped:

### Parser (7)
| C signature | Node API it backs | Notes |
|---|---|---|
| `TSParser *ts_parser_new(void)` | `new Parser()` | one per thread (§5) |
| `void ts_parser_delete(TSParser*)` | `parser.delete()` | Dispose |
| `bool ts_parser_set_language(TSParser*, const TSLanguage*)` | `parser.setLanguage(lang)` | returns false on ABI mismatch — **check it** (R3) |
| `const TSLanguage *ts_parser_language(const TSParser*)` | `parser.language` | optional |
| `TSTree *ts_parser_parse_string(TSParser*, const TSTree* old, const char* src, uint32_t len)` | `parser.parse(source)` | UTF-8 bytes + byte length (Decision 22); `old = NULL` for full parse |
| `void ts_parser_reset(TSParser*)` | `parser.reset()` | |
| `void ts_parser_set_timeout_micros(TSParser*, uint64_t)` | (R5 parse timeout) | deprecated-but-present in 0.25; alternative is a `TSParseOptions` progress callback — see §5 open Q |

> Use `ts_parser_parse_string` (UTF-8, the default `TSInputEncoding`), **not** the
> callback-based `ts_parser_parse(TSInput)` — CodeGraph always parses a whole
> in-memory buffer, so we never need the streaming `TSInput` reader.

### Tree (3)
| C signature | Node API |
|---|---|
| `TSNode ts_tree_root_node(const TSTree*)` | `tree.rootNode` |
| `void ts_tree_delete(TSTree*)` | `tree.delete()` — Dispose, **no finalizer** (§5) |
| `const TSLanguage *ts_tree_language(const TSTree*)` | `tree.language` (optional) |

### Node (23)
| C signature | Node API | Notes |
|---|---|---|
| `const char *ts_node_type(TSNode)` | `node.type` | pointer into language static data — **do not free**; marshal as `IntPtr`→`PtrToStringUTF8` |
| `TSSymbol ts_node_symbol(TSNode)` | `node.typeId` | `TSSymbol = uint16` — the *fast* type key (see §3 note) |
| `uint32_t ts_node_start_byte(TSNode)` | `node.startIndex` | **byte offset** (Decision 22) |
| `uint32_t ts_node_end_byte(TSNode)` | `node.endIndex` | byte offset |
| `TSPoint ts_node_start_point(TSNode)` | `node.startPosition` | `{row, column}` both **byte-derived** |
| `TSPoint ts_node_end_point(TSNode)` | `node.endPosition` | |
| `uint32_t ts_node_child_count(TSNode)` | `node.childCount` | |
| `TSNode ts_node_child(TSNode, uint32_t)` | `node.child(i)` | |
| `uint32_t ts_node_named_child_count(TSNode)` | `node.namedChildCount` | the hot path (89 calls) |
| `TSNode ts_node_named_child(TSNode, uint32_t)` | `node.namedChild(i)` | the hot path (124 calls) |
| `TSNode ts_node_child_by_field_name(TSNode, const char* name, uint32_t nameLen)` | `node.childForFieldName(f)` | ASCII field name + byte length |
| `TSNode ts_node_next_sibling(TSNode)` | `node.nextSibling` | optional |
| `TSNode ts_node_prev_sibling(TSNode)` | `node.previousSibling` | optional |
| `TSNode ts_node_next_named_sibling(TSNode)` | `node.nextNamedSibling` | |
| `TSNode ts_node_prev_named_sibling(TSNode)` | `node.previousNamedSibling` | |
| `TSNode ts_node_parent(TSNode)` | `node.parent` | |
| `bool ts_node_is_named(TSNode)` | `node.isNamed` | |
| `bool ts_node_is_null(TSNode)` | (null-node test) | **the C API has no `null`** — absent child ⇒ a node with `id == NULL`; test with this or `id == IntPtr.Zero` |
| `bool ts_node_has_error(TSNode)` | `node.hasError` | |
| `bool ts_node_is_missing(TSNode)` | `node.isMissing` | optional (used by some extractors) |
| `bool ts_node_is_extra(TSNode)` | `node.isExtra` | optional |
| `bool ts_node_eq(TSNode, TSNode)` | `node.equals(o)` | optional |
| `char *ts_node_string(TSNode)` | `node.toString()` | **debug only**; returns malloc'd string — bind `ts_free`/`free` if used |

> `descendantsOfType(types)` is **not** a C function — web-tree-sitter implements
> it in JS by walking the subtree. Reproduce it in C# as a recursive walk over
> `namedChild(i)` collecting matching `type`s (or a `TSTreeCursor` walk for perf).
> Same for `node.text` → slice `SourceText[startByte..endByte]` (Decision 22).

### Language (4)
| C signature | Node API | Notes |
|---|---|---|
| `uint32_t ts_language_abi_version(const TSLanguage*)` | `lang.abiVersion` | **R3 gate** — assert it matches `libtree-sitter`'s supported range at load |
| `uint32_t ts_language_symbol_count(const TSLanguage*)` | `lang.nodeTypeCount` | optional |
| `const char *ts_language_symbol_name(const TSLanguage*, TSSymbol)` | `lang.nodeTypeForId(id)` | optional — enables the symbol-id fast path |
| `TSFieldId ts_language_field_id_for_name(const TSLanguage*, const char* name, uint32_t len)` | `lang.fieldIdForName(f)` | `TSFieldId = uint16`; lets you resolve field names **once** and call `ts_node_child_by_field_id` on the hot path (optional optimization) |

> In older headers the ABI accessor is `ts_language_version`; **0.25 renamed it
> `ts_language_abi_version`** (old name kept as a deprecated alias). Pin the name
> to the version you link (§5 open Q).

### Grammar entry-point (1 per grammar — the `tree_sitter_<lang>()` convention)
```c
const TSLanguage *tree_sitter_typescript(void);   // grammars.ts entry convention
const TSLanguage *tree_sitter_tsx(void);
const TSLanguage *tree_sitter_go(void);
// … one exported symbol per grammar object file
```
Each grammar's `parser.c` exports exactly one `tree_sitter_<lang>` returning a
`const TSLanguage*`. This is the only grammar-specific symbol; everything else is
`libtree-sitter`. (`grammars.ts` maps 31 languages; MVP ships 8 — TS/TSX/JS/JSX,
Python, Go, Java, C#, Rust — per roadmap M2. Note JSX reuses the `javascript`
grammar and TSX its own; **use the vendored ABI-15 `tree-sitter-c-sharp`** for
primary-constructor support, `grammars.ts:263`.)

### Optional — `TSTreeCursor` (6, perf only)
`ts_tree_cursor_new(TSNode)`, `ts_tree_cursor_delete`, `..._goto_first_child`,
`..._goto_next_sibling`, `..._goto_parent`, `..._current_node`. Only if the
recursive `namedChild(i)` walk shows up in a profile; CodeGraph itself uses index
recursion, so **defer**.

### Explicitly EXCLUDED — the query / `.scm` engine (justification: §2.6)
Do **not** bind any of these — CodeGraph never calls them:
`ts_query_new`, `ts_query_delete`, `ts_query_cursor_new`,
`ts_query_cursor_exec`, `ts_query_cursor_next_match`,
`ts_query_capture_count`, `ts_query_pattern_count`, `ts_query_string_value_for_id`,
the entire `TSQuery`/`TSQueryCursor`/`TSQueryMatch`/`TSQueryCapture`/`TSQueryError`
surface, and grammar `injections.scm`/`highlights.scm` loading. Binding them adds
marshalling of variadic capture structs and a whole struct family for **zero**
call sites. This is the single largest surface-area saving of the native path.

---

## 2. Struct layouts & blittability

Three shapes cross the boundary. **`TSNode` and `TSPoint` are by-value,
fully-blittable structs** — passed and returned *by value*, not by pointer. This
is exactly what makes tree-sitter an ideal `[LibraryImport]` target: source-gen
marshalling copies the bytes with no allocation, no `Marshal.PtrToStructure`, no
custom marshaller.

```c
// tree_sitter/api.h
typedef struct TSNode {
  uint32_t context[4];   // 16 bytes — opaque cursor state
  const void *id;        //  8 bytes — node identity (NULL ⇒ "null node")
  const TSTree *tree;    //  8 bytes — owning tree
} TSNode;                // 32 bytes on 64-bit, blittable, returned BY VALUE

typedef struct TSPoint {
  uint32_t row;          // 0-based (extractor adds 1 for startLine — Decision 22)
  uint32_t column;       // 0-based, BYTE column (not UTF-16 char column)
} TSPoint;               // 8 bytes, blittable, returned BY VALUE

typedef uint16_t TSSymbol;
typedef uint16_t TSFieldId;
// bool is C99 stdbool (1 byte) — see marshalling pitfall below
```

C# equivalents — `[StructLayout(LayoutKind.Sequential)]`, no `[MarshalAs]` on any
field (all fields blittable), so the whole struct is blittable:

```csharp
[StructLayout(LayoutKind.Sequential)]
internal readonly struct TsNodeRaw          // 1:1 with C TSNode, 32 bytes
{
    // 4 × uint32 context. Expose as fixed buffer OR 4 fields — fields avoid `unsafe`.
    public readonly uint Context0;
    public readonly uint Context1;
    public readonly uint Context2;
    public readonly uint Context3;
    public readonly nint Id;                 // const void*  (IntPtr) — NULL ⇒ null node
    public readonly nint Tree;               // const TSTree*
    public bool IsNull => Id == 0;
}

[StructLayout(LayoutKind.Sequential)]
internal readonly struct TsPoint             // 1:1 with C TSPoint, 8 bytes
{
    public readonly uint Row;
    public readonly uint Column;
}
```

**Opaque handles** — `TSParser*`, `TSTree*`, `TSLanguage*` never have their
internals touched by C#; bind them as **`IntPtr`/`nint`**. Do not model them as
structs. (They are heap objects owned by `libtree-sitter`; lifetime is managed by
`ts_parser_delete`/`ts_tree_delete` — §5.)

Blittability checklist (must all hold, else source-gen falls back to slow/blocked
marshalling under AOT):
- `TsNodeRaw`, `TsPoint`: only `uint`/`nint` fields → blittable ✔ (pass/return by value).
- Handles: `nint` → blittable ✔.
- `bool`: **NOT** blittable by default under `[LibraryImport]` — annotate (§3).
- `const char*` returns: bind as `nint`, convert manually — never let the
  marshaller free language-owned static strings (§3).

---

## 3. Skeleton C# binding

Real, compilable-shaped code. Five types:
`CodeGraphTsBindings` (extern surface), `CodeGraphTsNode` (readonly struct
wrapper), `CodeGraphTsParser` / `CodeGraphTsTree` (IDisposable),
`CodeGraphGrammarRegistry`, `CodeGraphSourceText` (UTF-8 byte buffer).

### 3.1 `CodeGraphTsBindings` — the extern declarations

```csharp
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

// libtree-sitter core. LibraryImport source-generates the marshalling stub at
// compile time — the only AOT-legal interop path (WS-C). One DLL/dylib/so named
// "tree-sitter"; NativeLibrary resolution maps it per-RID (§4).
internal static unsafe partial class CodeGraphTsBindings
{
    private const string Lib = "tree-sitter";

    // ---- Parser -----------------------------------------------------------
    [LibraryImport(Lib)] internal static partial nint ts_parser_new();
    [LibraryImport(Lib)] internal static partial void ts_parser_delete(nint parser);

    // C `bool` return is 1 byte — MUST be MarshalAs(U1); default [LibraryImport]
    // marshals bool as 4-byte Win32 BOOL and corrupts the stack. (Pitfall.)
    [LibraryImport(Lib)]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_parser_set_language(nint parser, nint language);

    // UTF-8 source + BYTE length (Decision 22). oldTree = 0 for a full parse.
    [LibraryImport(Lib)]
    internal static partial nint ts_parser_parse_string(
        nint parser, nint oldTree, byte* source, uint length);

    [LibraryImport(Lib)] internal static partial void ts_parser_reset(nint parser);
    [LibraryImport(Lib)] internal static partial void ts_parser_set_timeout_micros(nint parser, ulong micros);

    // ---- Tree -------------------------------------------------------------
    [LibraryImport(Lib)] internal static partial TsNodeRaw ts_tree_root_node(nint tree);
    [LibraryImport(Lib)] internal static partial void ts_tree_delete(nint tree);

    // ---- Node (returns/takes TSNode BY VALUE — blittable) -----------------
    // const char* owned by the language — return nint, convert manually, NEVER free.
    [LibraryImport(Lib)] internal static partial nint  ts_node_type(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial ushort ts_node_symbol(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial uint  ts_node_start_byte(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial uint  ts_node_end_byte(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial TsPoint ts_node_start_point(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial TsPoint ts_node_end_point(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial uint  ts_node_child_count(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial TsNodeRaw ts_node_child(TsNodeRaw node, uint i);
    [LibraryImport(Lib)] internal static partial uint  ts_node_named_child_count(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial TsNodeRaw ts_node_named_child(TsNodeRaw node, uint i);

    // field name: ASCII bytes + byte length (NOT NUL-terminated required)
    [LibraryImport(Lib)]
    internal static partial TsNodeRaw ts_node_child_by_field_name(
        TsNodeRaw node, byte* name, uint nameLength);

    [LibraryImport(Lib)] internal static partial TsNodeRaw ts_node_next_named_sibling(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial TsNodeRaw ts_node_prev_named_sibling(TsNodeRaw node);
    [LibraryImport(Lib)] internal static partial TsNodeRaw ts_node_parent(TsNodeRaw node);

    [LibraryImport(Lib)] [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_is_named(TsNodeRaw node);
    [LibraryImport(Lib)] [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_is_null(TsNodeRaw node);
    [LibraryImport(Lib)] [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_has_error(TsNodeRaw node);
    [LibraryImport(Lib)] [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_is_missing(TsNodeRaw node);

    // ---- Language ---------------------------------------------------------
    [LibraryImport(Lib)] internal static partial uint ts_language_abi_version(nint language);
    [LibraryImport(Lib)] internal static partial nint ts_language_symbol_name(nint language, ushort symbol);
    [LibraryImport(Lib)] internal static partial ushort ts_language_field_id_for_name(
        nint language, byte* name, uint nameLength);

    // ---- helper: const char* (UTF-8, language-owned) -> managed string ----
    internal static string PtrToUtf8(nint p) =>
        p == 0 ? string.Empty : Marshal.PtrToStringUTF8(p) ?? string.Empty;
}
```

### 3.2 `CodeGraphTsNode` — the readonly-struct navigation wrapper

Matches tree-sitter's value-type node semantics; avoids GC pressure across the
millions of nodes an index visits (analysis-01 §6.2). Carries the raw node **and**
a reference to the owning `SourceText` so `Text`/`Type` are one call away.

```csharp
using System;
using System.Buffers;
using System.Text;

internal readonly struct CodeGraphTsNode
{
    private readonly TsNodeRaw _raw;
    private readonly CodeGraphSourceText _src;   // for byte-offset text slicing

    internal CodeGraphTsNode(TsNodeRaw raw, CodeGraphSourceText src)
    {
        _raw = raw;
        _src = src;
    }

    public bool IsNull => _raw.IsNull;                       // absent child sentinel
    public string Type => CodeGraphTsBindings.PtrToUtf8(CodeGraphTsBindings.ts_node_type(_raw));
    public ushort Symbol => CodeGraphTsBindings.ts_node_symbol(_raw);  // fast type key
    public bool IsNamed => CodeGraphTsBindings.ts_node_is_named(_raw);
    public bool HasError => CodeGraphTsBindings.ts_node_has_error(_raw);
    public bool IsMissing => CodeGraphTsBindings.ts_node_is_missing(_raw);

    // BYTE offsets (Decision 22) — used for text slicing and node-id line.
    public int StartByte => (int)CodeGraphTsBindings.ts_node_start_byte(_raw);
    public int EndByte   => (int)CodeGraphTsBindings.ts_node_end_byte(_raw);

    // Points: row 0-based (extractor does row+1 -> startLine), column 0-based BYTE column.
    public (int Row, int Col) StartPosition
    { get { var p = CodeGraphTsBindings.ts_node_start_point(_raw); return ((int)p.Row, (int)p.Column); } }
    public (int Row, int Col) EndPosition
    { get { var p = CodeGraphTsBindings.ts_node_end_point(_raw); return ((int)p.Row, (int)p.Column); } }

    public int ChildCount      => (int)CodeGraphTsBindings.ts_node_child_count(_raw);
    public int NamedChildCount => (int)CodeGraphTsBindings.ts_node_named_child_count(_raw);

    public CodeGraphTsNode Child(int i)      => Wrap(CodeGraphTsBindings.ts_node_child(_raw, (uint)i));
    public CodeGraphTsNode NamedChild(int i) => Wrap(CodeGraphTsBindings.ts_node_named_child(_raw, (uint)i));
    public CodeGraphTsNode Parent            => Wrap(CodeGraphTsBindings.ts_node_parent(_raw));
    public CodeGraphTsNode NextNamedSibling  => Wrap(CodeGraphTsBindings.ts_node_next_named_sibling(_raw));
    public CodeGraphTsNode PrevNamedSibling  => Wrap(CodeGraphTsBindings.ts_node_prev_named_sibling(_raw));

    // childForFieldName(name): field names are ASCII constants — stackalloc the bytes.
    public unsafe CodeGraphTsNode ChildForFieldName(ReadOnlySpan<byte> utf8Field)
    {
        fixed (byte* p = utf8Field)
            return Wrap(CodeGraphTsBindings.ts_node_child_by_field_name(_raw, p, (uint)utf8Field.Length));
    }

    // getNodeText(node, source): slice the UTF-8 buffer by byte offset (Decision 22),
    // NOT by char index. This is the single most error-prone port point (R4/R9).
    public string Text => _src.Slice(StartByte, EndByte);

    // descendantsOfType — NOT a C API function; reproduce the web-tree-sitter walk.
    public void CollectDescendantsOfType(HashSet<string> types, List<CodeGraphTsNode> into)
    {
        int n = NamedChildCount;
        for (int i = 0; i < n; i++)
        {
            var c = NamedChild(i);
            if (types.Contains(c.Type)) into.Add(c);
            c.CollectDescendantsOfType(types, into);
        }
    }

    private CodeGraphTsNode Wrap(TsNodeRaw r) => new(r, _src);
}
```

### 3.3 `CodeGraphTsParser` / `CodeGraphTsTree` — IDisposable native lifetime

Native memory is malloc/free — **no GC finalizer reliance** (§5). One parser per
thread.

```csharp
internal sealed class CodeGraphTsParser : IDisposable
{
    private nint _handle;
    public CodeGraphTsParser() => _handle = CodeGraphTsBindings.ts_parser_new();

    public void SetLanguage(nint language)
    {
        // set_language returns false when the grammar ABI is incompatible with
        // this libtree-sitter (R3). Fail loud rather than parse garbage.
        if (!CodeGraphTsBindings.ts_parser_set_language(_handle, language))
            throw new CodeGraphGrammarAbiException(language);
    }

    public void SetTimeoutMicros(ulong micros) =>
        CodeGraphTsBindings.ts_parser_set_timeout_micros(_handle, micros); // R5

    public CodeGraphTsTree Parse(CodeGraphSourceText src)
    {
        unsafe
        {
            fixed (byte* p = src.Utf8Span)   // pin the UTF-8 buffer for the parse call
            {
                nint tree = CodeGraphTsBindings.ts_parser_parse_string(_handle, 0, p, (uint)src.ByteLength);
                if (tree == 0) throw new CodeGraphParseException(); // timeout / OOM
                return new CodeGraphTsTree(tree, src);
            }
        }
    }

    public void Dispose()
    {
        if (_handle != 0) { CodeGraphTsBindings.ts_parser_delete(_handle); _handle = 0; }
    }
}

internal sealed class CodeGraphTsTree : IDisposable
{
    private nint _handle;
    private readonly CodeGraphSourceText _src;
    internal CodeGraphTsTree(nint handle, CodeGraphSourceText src) { _handle = handle; _src = src; }

    public CodeGraphTsNode RootNode =>
        new(CodeGraphTsBindings.ts_tree_root_node(_handle), _src);

    public void Dispose()
    {
        if (_handle != 0) { CodeGraphTsBindings.ts_tree_delete(_handle); _handle = 0; }
    }
}
```

### 3.4 `CodeGraphSourceText` — the UTF-8 byte buffer (Decision 22)

Owns the `byte[]`, slices by **byte offset**, and precomputes a byte→(line,col)
map. This one type centralizes R4/R9. `preParse` transforms must preserve byte
length (analysis-01 R4) — enforce it here.

```csharp
internal sealed class CodeGraphSourceText
{
    private readonly byte[] _utf8;

    private CodeGraphSourceText(byte[] utf8) => _utf8 = utf8;

    public static CodeGraphSourceText FromString(string source) =>
        new(Encoding.UTF8.GetBytes(source));

    // File bytes are already UTF-8 on disk — avoid the UTF-16 round-trip entirely.
    public static CodeGraphSourceText FromUtf8(byte[] utf8) => new(utf8);

    public ReadOnlySpan<byte> Utf8Span => _utf8;
    public int ByteLength => _utf8.Length;

    // getNodeText: reconstruct text from a byte range. NEVER slice a C# string by
    // these offsets — they are byte indices, and one non-ASCII char desyncs them.
    public string Slice(int startByte, int endByte) =>
        Encoding.UTF8.GetString(_utf8, startByte, endByte - startByte);

    // A preParse hook must return an equal-BYTE-LENGTH buffer (tests assert
    // out.length === in.length; e.g. macro-blanking). Enforce it:
    public CodeGraphSourceText WithPreParse(Func<byte[], byte[]> preParse)
    {
        var next = preParse(_utf8);
        if (next.Length != _utf8.Length)
            throw new InvalidOperationException("preParse must preserve byte length (Decision 22)");
        return new CodeGraphSourceText(next);
    }
}
```

### 3.5 `CodeGraphGrammarRegistry` — lang → `tree_sitter_<lang>()` handle

Two shapes. **(a)** For the fixed MVP set, a `[LibraryImport]` per grammar
entry-point is cleanest (compile-time symbol, AOT-friendly, works with both
loadable and static-linked shipping — §4). **(b)** For arbitrary/late-added
grammars, resolve dynamically via `NativeLibrary.Load` + a `delegate*` — keeps
boot alive when a lib is missing (§5).

```csharp
// (a) Fixed MVP grammars — one extern per tree_sitter_<lang> entry-point.
// Each lives in its own native lib ("tree-sitter-typescript", …) at MVP, or all
// in one static archive at the endgame; the LibraryImport name is the DLL base
// name, mapped per-RID by NativeLibrary resolution / DirectPInvoke (§4).
internal static partial class CodeGraphGrammarEntries
{
    [LibraryImport("tree-sitter-typescript", EntryPoint = "tree_sitter_typescript")]
    internal static partial nint TypeScript();
    [LibraryImport("tree-sitter-typescript", EntryPoint = "tree_sitter_tsx")]
    internal static partial nint Tsx();
    [LibraryImport("tree-sitter-go",     EntryPoint = "tree_sitter_go")]     internal static partial nint Go();
    [LibraryImport("tree-sitter-python", EntryPoint = "tree_sitter_python")] internal static partial nint Python();
    [LibraryImport("tree-sitter-java",   EntryPoint = "tree_sitter_java")]   internal static partial nint Java();
    // vendored ABI-15 c-sharp (primary-constructor support, grammars.ts:263)
    [LibraryImport("tree-sitter-c-sharp",EntryPoint = "tree_sitter_c_sharp")]internal static partial nint CSharp();
    [LibraryImport("tree-sitter-rust",   EntryPoint = "tree_sitter_rust")]   internal static partial nint Rust();
    [LibraryImport("tree-sitter-javascript", EntryPoint = "tree_sitter_javascript")] internal static partial nint JavaScript();
}

internal sealed class CodeGraphGrammarRegistry
{
    private readonly Dictionary<string, nint> _cache = new();
    private readonly HashSet<string> _unavailable = new();  // lazy-load failures

    // language string (Decision 16 vocab) -> loaded TSLanguage*. LAZY: a missing
    // grammar disables one language, never crashes boot (§5, WS-C).
    public nint? GetLanguage(string lang)
    {
        if (_cache.TryGetValue(lang, out var h)) return h;
        if (_unavailable.Contains(lang)) return null;
        try
        {
            nint p = lang switch
            {
                "typescript" => CodeGraphGrammarEntries.TypeScript(),
                "tsx"        => CodeGraphGrammarEntries.Tsx(),
                "javascript" or "jsx" => CodeGraphGrammarEntries.JavaScript(),
                "python"     => CodeGraphGrammarEntries.Python(),
                "go"         => CodeGraphGrammarEntries.Go(),
                "java"       => CodeGraphGrammarEntries.Java(),
                "csharp"     => CodeGraphGrammarEntries.CSharp(),
                "rust"       => CodeGraphGrammarEntries.Rust(),
                _ => 0
            };
            if (p == 0) { _unavailable.Add(lang); return null; }

            // R3: assert grammar ABI is in libtree-sitter's supported range.
            uint abi = CodeGraphTsBindings.ts_language_abi_version(p);
            if (abi is < CodeGraphTs.MinAbi or > CodeGraphTs.MaxAbi)
            { _unavailable.Add(lang); return null; }

            _cache[lang] = p;
            return p;
        }
        catch (DllNotFoundException)   // grammar lib not shipped for this RID (§5)
        {
            _unavailable.Add(lang);
            return null;
        }
    }
}
```

> `TSLanguage*` handles are process-static (owned by the grammar lib's static
> data) — cache them for the worker's lifetime; never `ts_language_delete` a
> `tree_sitter_<lang>()` result.

---

## 4. AOT packaging — the two shipping shapes

### (a) MVP — loadable per-RID native libs, resolved by name

Mirrors how the worker already ships `better-sqlite3`/`node-pty`/`ssh2` natives
and how `SQLitePCLRaw.bundle_e_sqlite3` lands its `e_sqlite3` native. The
`dotnet publish -r <rid>` (via `scripts/publish-native-worker.mjs`) copies the
AOT worker **plus** the grammar libs into `resources/native-worker/`, which
electron-builder `asarUnpack`s (`electron-builder.yml`: `asarUnpack: resources/**`).

csproj — add the grammar libs as native content copied next to the worker binary
so `NativeLibrary`'s default probing (app directory) finds them by name:

```xml
<!-- OpenCowork.Native.Worker.csproj -->
<ItemGroup>
  <!-- Per-RID grammar libs staged under runtimes/<rid>/native so publish copies
       them beside the AOT binary. Base names match the [LibraryImport] lib names:
       tree-sitter(.dylib/.so/.dll), tree-sitter-typescript, tree-sitter-go, … -->
  <None Include="native/$(RuntimeIdentifier)/*"
        CopyToOutputDirectory="PreserveNewest"
        Link="%(Filename)%(Extension)" />
</ItemGroup>
```

- Naming: `[LibraryImport("tree-sitter")]` resolves `libtree-sitter.dylib`
  (osx) / `libtree-sitter.so` (linux) / `tree-sitter.dll` (win) via the default
  `DllImportSearchPath`. Ship the `lib` prefix on Unix; the loader adds/strips it.
- If names ever diverge per RID, register a
  `NativeLibrary.SetDllImportResolver(typeof(CodeGraphTsBindings).Assembly, …)`
  at module init to map `"tree-sitter"`→the actual file — the same hook used to
  point at `resources/native-worker/` if the libs are staged in a subfolder.
- The worker's existing publish flow (`scripts/publish-native-worker.mjs` →
  `resources/native-worker/`) needs the grammar libs added to the publish output;
  `RID` is already threaded through (`OPEN_COWORK_NATIVE_WORKER_RID`).

### (b) Endgame — static-link into the per-RID AOT binary

Compile `libtree-sitter` + every grammar's `parser.c`/`scanner.c` into **one
static archive per RID** (`libcodegraph-grammars.a` / `.lib`) and link it into
the AOT worker, yielding a **single self-contained per-RID binary** — the
cleanest fit for the AOT "one native binary" model (analysis-01 §5A shape #2).

csproj — `DirectPInvoke` binds the P/Invokes at link time (no dynamic lookup),
`NativeLibrary`/`LinkerArg` pulls in the archive:

```xml
<ItemGroup>
  <!-- Bind every P/Invoke against these lib names directly into the image. -->
  <DirectPInvoke Include="tree-sitter" />
  <DirectPInvoke Include="tree-sitter-typescript" />
  <DirectPInvoke Include="tree-sitter-go" />
  <DirectPInvoke Include="tree-sitter-python" />
  <DirectPInvoke Include="tree-sitter-java" />
  <DirectPInvoke Include="tree-sitter-c-sharp" />
  <DirectPInvoke Include="tree-sitter-rust" />
  <DirectPInvoke Include="tree-sitter-javascript" />

  <!-- The prebuilt static archive for the current RID (from the WS-A CI matrix). -->
  <NativeLibrary Include="native/$(RuntimeIdentifier)/libcodegraph-grammars.a"
                 Condition="!$(RuntimeIdentifier.StartsWith('win'))" />
  <NativeLibrary Include="native\$(RuntimeIdentifier)\codegraph-grammars.lib"
                 Condition="$(RuntimeIdentifier.StartsWith('win'))" />
</ItemGroup>
```

- With `DirectPInvoke`, the `[LibraryImport("tree-sitter")]` symbols are resolved
  statically — no `.dylib`/`.so`/`.dll` ships, and the `DllNotFoundException`
  class (§5) disappears for the linked-in grammars.
- Equivalent to the `[LibraryImport("__Internal")]` idiom other AOT stacks use;
  in .NET the `DirectPInvoke` + `NativeLibrary` pair is the idiomatic form.
- Grammar C sources are vendored under `third_party/grammars/` with CodeGraph's
  patches reproduced as `.patch` files (analysis-01 §5A / roadmap WS-A); a CI
  matrix cross-compiles each into the per-RID archive (`-fPIC`, tree-sitter
  headers; `PublishAotCross`/Zig for Linux cross-compile).

**Recommendation:** (a) for M0/M2 to unblock the spike fast (bootstrap the 8
common grammar binaries from TreeSitter.DotNet's prebuilt natives); migrate to
(b) as the shipping endgame once the WS-A build matrix is green.

---

## 5. Pitfalls (must-read before writing the binding)

1. **`bool` marshalling — the silent stack-corruptor.** C's `bool` is 1 byte;
   `[LibraryImport]` marshals `bool` as a **4-byte Win32 `BOOL`** by default.
   Every `bool`-returning/`bool`-taking function (`ts_parser_set_language`,
   `ts_node_is_named`, `ts_node_has_error`, …) **must** carry
   `[return: MarshalAs(UnmanagedType.U1)]` / `[MarshalAs(UnmanagedType.U1)]`.
   Omit it and you read garbage from adjacent stack bytes — intermittently. This
   is the #1 tree-sitter P/Invoke bug.

2. **`const char*` returns are language-owned — never free them.** `ts_node_type`
   and `ts_language_symbol_name` return pointers into the grammar's **static**
   string table. Bind them as `nint` and convert with
   `Marshal.PtrToStringUTF8` (the `PtrToUtf8` helper). Do **not** declare the
   return as `string` with `StringMarshalling.Utf8` — that marshaller may free the
   pointer, corrupting the grammar's static data. (`ts_node_string` is the one
   that *does* malloc — free it if you ever use it; it's debug-only.)

3. **`DllNotFoundException` at first P/Invoke if a grammar lib is missing.** Under
   shape (a), a missing/mis-RID grammar lib throws on the **first** call, not at
   boot. **Lazy-load grammars** (`CodeGraphGrammarRegistry.GetLanguage`
   try/catch → `_unavailable`) so a missing lib disables one language and boot
   still succeeds (WS-C). Never resolve grammars in a static ctor or at module
   init — that turns one missing lib into a dead worker. `libtree-sitter` itself
   is the exception: it must be present, and its absence is a hard, correct fail.

4. **Grammar ABI must match `libtree-sitter`.** `ts_parser_set_language` returns
   **false** when a grammar's ABI is outside the runtime's supported range (R3);
   `ts_language_abi_version` reads it. Check both — a false from `set_language`
   silently yields empty parses (every extractor then emits nothing for that
   language). CodeGraph deliberately vendors **ABI-15** lua/c-sharp because the
   ABI-13 builds mis-parse (`grammars.ts:253-274`) — reproduce the exact
   ABI/version per grammar (R2). Pin the `libtree-sitter` version and standardize
   on ≥ ABI-14 grammars.

5. **Native memory — Dispose, no finalizers.** `ts_tree_delete` and
   `ts_parser_delete` free malloc'd memory. Model `CodeGraphTsTree`/`Parser` as
   `IDisposable` and **always** `using` them (the extractor deletes the tree at
   the end of each file — `tree-sitter.ts:526`). Do **not** add a GC finalizer as
   a safety net: finalizer order is nondeterministic, a finalized tree may outlive
   its parser, and finalizers run on a thread that could double-free. Deterministic
   `Dispose` at the parse-loop `finally` is the contract.

6. **One `TSParser` per thread.** `TSParser` is **not** thread-safe. Parse
   concurrency (Decision 10 — off the shared thread-pool to protect the 15s
   `worker/ping` heartbeat) uses one `CodeGraphTsParser` **per consumer thread**
   (a bounded `Channel<ParseTask>` + N dedicated-thread consumers), never a shared
   parser. `TSTree`/`TSNode` reads are fine to hand between threads once parsing is
   done, but keep a tree confined to the thread that will delete it. Grammar
   `TSLanguage*` handles are read-only/process-static and safe to share.

7. **Pin the source buffer across the whole parse call.** `ts_parser_parse_string`
   reads `source` synchronously and returns before it needs the buffer again, so a
   `fixed` block around the single call suffices (shown in §3.3). Do not hand
   tree-sitter a pointer that the GC can move — always `fixed`/pin, never a bare
   `GCHandle`-less address.

8. **`ts_language_abi_version` vs `ts_language_version` naming.** 0.25 renamed the
   ABI accessor; older headers expose `ts_language_version`. Bind the name that
   matches the `libtree-sitter` you pin (open question below) — a wrong extern name
   is a link-time (static) or first-call (dynamic) failure.

---

## Summary for the lead

The binding needs **~40 `libtree-sitter` C functions** (7 parser, 3 tree, ~23
node, 4 language, +1 `tree_sitter_<lang>` entry per grammar; optional 6-function
`TSTreeCursor` deferred). The **entire query/`.scm` engine is excluded** — analysis-01
§2.6 confirms zero query call sites, which is the largest surface saving. Key
marshalling decisions: **`[LibraryImport]` only** (AOT-legal, never `[DllImport]`);
`TSNode`/`TSPoint` are **by-value blittable structs** (no custom marshaller);
**every `bool` needs `[MarshalAs(U1)]`** (the top pitfall — default 4-byte BOOL
corrupts the stack); `const char*` type strings returned as `nint` +
`PtrToStringUTF8`, **never freed**; source as a **pinned UTF-8 `byte*` + byte
length** and all text sliced by **byte offset** (Decision 22), never UTF-16 char
index. Lifetime is **`IDisposable`, no finalizers**; grammars **lazy-load** so a
missing per-RID lib disables one language instead of killing boot. Ship shape (a)
loadable per-RID libs for MVP → (b) `DirectPInvoke` + `NativeLibrary` static-link
for the endgame.

**Open questions for you:** (1) **exact `libtree-sitter` version to pin** — this
fixes the ABI accessor name (`ts_language_abi_version` vs `ts_language_version`),
the supported grammar-ABI range, and whether we adopt the 0.25 `TSParseOptions`
progress-callback for parse timeouts instead of the deprecated
`ts_parser_set_timeout_micros` (R5). (2) Bootstrap common-grammar binaries from
**TreeSitter.DotNet's prebuilt natives** for M0, or stand up the WS-A C build
matrix first? Recommend bootstrap to unblock the M0 gate. (3) Confirm the
grammar libs are added to `scripts/publish-native-worker.mjs`'s publish output
(they must land in `resources/native-worker/` for `asarUnpack`).
