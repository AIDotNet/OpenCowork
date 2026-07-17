// =============================================================================
// CodeGraphTsParser — IDisposable wrapper over a native TSParser.
//
//   * Native memory is malloc/free: model as IDisposable and always `using`; do
//     NOT add a GC finalizer as a safety net — finalizer order is nondeterministic
//     and could double-free a tree that outlived its parser (reference/03 §5.5).
//   * ONE parser per thread — TSParser is not thread-safe (reference/03 §5.6).
//   * The UTF-8 source buffer is PINNED across the whole parse call (reference/03
//     §5.7); ts_parser_parse_string reads it synchronously.
//
// COMPILES today; will not RUN until libtree-sitter is present.
// =============================================================================
internal sealed class CodeGraphTsParser : IDisposable
{
    private nint _handle;

    public CodeGraphTsParser()
    {
        _handle = CodeGraphTsBindings.ts_parser_new();
    }

    /// <summary>
    /// Bind a grammar (a `tree_sitter_&lt;lang&gt;()` handle from the registry).
    /// Throws when the grammar ABI is incompatible with this libtree-sitter — a
    /// false return silently yields empty parses otherwise (reference/03 §5.4).
    /// </summary>
    public void SetLanguage(nint language)
    {
        if (!CodeGraphTsBindings.ts_parser_set_language(_handle, language))
            throw new CodeGraphGrammarAbiException(language);
    }

    /// <summary>Optional parse-timeout guard (R5). Deprecated-but-present in 0.25.</summary>
    public void SetTimeoutMicros(ulong micros) =>
        CodeGraphTsBindings.ts_parser_set_timeout_micros(_handle, micros);

    /// <summary>Reset internal parse state (for parser reuse across files).</summary>
    public void Reset() => CodeGraphTsBindings.ts_parser_reset(_handle);

    /// <summary>Parse a UTF-8 source buffer owned by a CodeGraphSourceText.</summary>
    public CodeGraphTsTree Parse(CodeGraphSourceText source)
    {
        unsafe
        {
            fixed (byte* p = source.Utf8Span) // pin for the whole synchronous parse call
            {
                nint tree = CodeGraphTsBindings.ts_parser_parse_string(
                    _handle, oldTree: 0, source: p, length: (uint)source.ByteLength);
                if (tree == 0)
                    throw new CodeGraphParseException(); // timeout / OOM / no language set
                return new CodeGraphTsTree(tree, source);
            }
        }
    }

    /// <summary>
    /// Parse raw UTF-8 bytes. The returned tree references byte offsets into the
    /// source, so the bytes are COPIED into a CodeGraphSourceText the tree owns —
    /// the caller's span may be transient.
    /// </summary>
    public CodeGraphTsTree Parse(ReadOnlySpan<byte> utf8Source) =>
        Parse(CodeGraphSourceText.FromUtf8(utf8Source.ToArray()));

    public void Dispose()
    {
        if (_handle != 0)
        {
            CodeGraphTsBindings.ts_parser_delete(_handle);
            _handle = 0;
        }
    }
}

/// <summary>
/// ts_parser_set_language returned false — the grammar's ABI is outside this
/// libtree-sitter's supported range (reference/03 §5.4). The registry catches
/// this to disable one language rather than parse garbage.
/// </summary>
internal sealed class CodeGraphGrammarAbiException : Exception
{
    public nint Language { get; }

    public CodeGraphGrammarAbiException(nint language)
        : base($"tree-sitter rejected grammar language handle 0x{language:X} (ABI mismatch)")
    {
        Language = language;
    }
}

/// <summary>ts_parser_parse_string returned NULL — parse failed (timeout / OOM / no language).</summary>
internal sealed class CodeGraphParseException : Exception
{
    public CodeGraphParseException()
        : base("tree-sitter parse returned a null tree (timeout, OOM, or no language set)")
    {
    }
}
