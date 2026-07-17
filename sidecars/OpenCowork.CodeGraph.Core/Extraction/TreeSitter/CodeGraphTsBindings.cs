using System.Runtime.InteropServices;

// =============================================================================
// CodeGraphTsBindings — native libtree-sitter P/Invoke surface.
//
//   * [LibraryImport] ONLY (source-generated stubs) — the only AOT-legal interop
//     path. NEVER [DllImport] (its runtime IL-stub gen is unsupported under full
//     Native AOT). Reference/03 §"Non-negotiable".
//   * TSNode / TSPoint cross the boundary BY VALUE as blittable structs — no
//     custom marshaller, no allocation (reference/03 §2).
//   * Every C `bool` (1 byte) carries [return: MarshalAs(UnmanagedType.U1)] — the
//     default [LibraryImport] marshals bool as a 4-byte Win32 BOOL and corrupts
//     the stack. This is the #1 tree-sitter P/Invoke bug (reference/03 §5.1).
//   * `const char*` returns are language-owned static strings — bound as `nint`
//     and converted with Marshal.PtrToStringUTF8; NEVER let a marshaller free them
//     (reference/03 §5.2).
//   * source text is passed as a pinned UTF-8 `byte*` + BYTE length (Decision 22);
//     the query/.scm engine is deliberately NOT bound (reference/03 §"Excluded").
//
// COMPILES today with the native libs ABSENT. It will NOT RUN until a
// `libtree-sitter` core lib (+ a grammar lib) is placed next to the AOT binary;
// the first P/Invoke otherwise throws DllNotFoundException (caught, for grammars,
// by CodeGraphGrammarRegistry).
//
// Requires <AllowUnsafeBlocks>true</AllowUnsafeBlocks> in the Core .csproj
// (this class is `unsafe` for the `byte*` parameters).
// =============================================================================

// 1:1 with C `TSNode` (32 bytes on 64-bit): 4x uint32 context + two pointers.
// All fields blittable -> the whole struct is blittable, passed/returned by value.
[StructLayout(LayoutKind.Sequential)]
internal readonly struct CodeGraphTsNodeRaw
{
    public readonly uint Context0;
    public readonly uint Context1;
    public readonly uint Context2;
    public readonly uint Context3;
    public readonly nint Id;   // const void*  — NULL ⇒ "null node" (the C API has no null)
    public readonly nint Tree; // const TSTree*

    public bool IsNull => Id == 0;
}

// 1:1 with C `TSPoint` (8 bytes). Row/Column are 0-based, BYTE-derived
// (Decision 22): Column is a byte column, NOT a UTF-16 char column.
[StructLayout(LayoutKind.Sequential)]
internal readonly struct CodeGraphTsPoint
{
    public readonly uint Row;
    public readonly uint Column;
}

// tree-sitter ABI / lib-name constants. MinAbi/MaxAbi are PLACEHOLDER bounds —
// pin them once the libtree-sitter version is fixed (reference/03 open question).
// The hard gate remains ts_parser_set_language returning true (reference/03 §5.4).
internal static class CodeGraphTs
{
    public const uint MinAbi = 13;
    public const uint MaxAbi = 15;
}

internal static unsafe partial class CodeGraphTsBindings
{
    // libtree-sitter core. NativeLibrary default probing maps "tree-sitter" ->
    // libtree-sitter.dylib / libtree-sitter.so / tree-sitter.dll per-RID.
    private const string Lib = "tree-sitter";

    // ---- Parser -------------------------------------------------------------
    [LibraryImport(Lib)]
    internal static partial nint ts_parser_new();

    [LibraryImport(Lib)]
    internal static partial void ts_parser_delete(nint parser);

    // Returns false on grammar/runtime ABI mismatch — the caller MUST check it
    // (reference/03 §5.4); a false yields silent empty parses otherwise.
    [LibraryImport(Lib)]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_parser_set_language(nint parser, nint language);

    [LibraryImport(Lib)]
    internal static partial nint ts_parser_language(nint parser);

    // UTF-8 source + BYTE length (Decision 22). oldTree = 0 for a full parse.
    [LibraryImport(Lib)]
    internal static partial nint ts_parser_parse_string(
        nint parser, nint oldTree, byte* source, uint length);

    [LibraryImport(Lib)]
    internal static partial void ts_parser_reset(nint parser);

    [LibraryImport(Lib)]
    internal static partial void ts_parser_set_timeout_micros(nint parser, ulong micros);

    // ---- Tree ---------------------------------------------------------------
    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_tree_root_node(nint tree);

    [LibraryImport(Lib)]
    internal static partial void ts_tree_delete(nint tree);

    [LibraryImport(Lib)]
    internal static partial nint ts_tree_language(nint tree);

    // ---- Node (takes/returns TSNode BY VALUE — blittable) -------------------
    // const char* owned by the grammar's static string table — return nint,
    // convert via PtrToUtf8, NEVER free (reference/03 §5.2).
    [LibraryImport(Lib)]
    internal static partial nint ts_node_type(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial ushort ts_node_symbol(CodeGraphTsNodeRaw node); // fast type key

    [LibraryImport(Lib)]
    internal static partial uint ts_node_start_byte(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial uint ts_node_end_byte(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsPoint ts_node_start_point(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsPoint ts_node_end_point(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial uint ts_node_child_count(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_node_child(CodeGraphTsNodeRaw node, uint index);

    [LibraryImport(Lib)]
    internal static partial uint ts_node_named_child_count(CodeGraphTsNodeRaw node); // hot path

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_node_named_child(CodeGraphTsNodeRaw node, uint index); // hot path

    // field name: ASCII/UTF-8 bytes + byte length (NOT required NUL-terminated).
    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_node_child_by_field_name(
        CodeGraphTsNodeRaw node, byte* name, uint nameLength);

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_node_next_named_sibling(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_node_prev_named_sibling(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    internal static partial CodeGraphTsNodeRaw ts_node_parent(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_is_named(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_is_null(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_has_error(CodeGraphTsNodeRaw node);

    [LibraryImport(Lib)]
    [return: MarshalAs(UnmanagedType.U1)]
    internal static partial bool ts_node_is_missing(CodeGraphTsNodeRaw node);

    // ---- Language -----------------------------------------------------------
    // 0.25 renamed this from ts_language_version; pin the name to the linked
    // libtree-sitter (reference/03 §5.8).
    [LibraryImport(Lib)]
    internal static partial uint ts_language_abi_version(nint language);

    [LibraryImport(Lib)]
    internal static partial uint ts_language_symbol_count(nint language);

    [LibraryImport(Lib)]
    internal static partial nint ts_language_symbol_name(nint language, ushort symbol);

    [LibraryImport(Lib)]
    internal static partial ushort ts_language_field_id_for_name(
        nint language, byte* name, uint nameLength);

    // ---- helper: const char* (UTF-8, language-owned) -> managed string ------
    internal static string PtrToUtf8(nint p) =>
        p == 0 ? string.Empty : Marshal.PtrToStringUTF8(p) ?? string.Empty;
}
