using System.Text;

// =============================================================================
// CodeGraphTsNode — readonly-struct navigation wrapper over a raw TSNode.
//
// Matches tree-sitter's value-type node semantics: copying the 32-byte struct is
// how you "move" to a child/sibling/parent, so a walk over millions of nodes adds
// no GC pressure (reference/03 §3.2). Carries a reference to the owning
// CodeGraphSourceText so Text/byte-slicing is one call away.
//
// Absent children are NOT null references — the C API returns a node whose Id is
// NULL. Test with IsNull before using a navigation result.
// =============================================================================
internal readonly struct CodeGraphTsNode
{
    private readonly CodeGraphTsNodeRaw _raw;
    private readonly CodeGraphSourceText _src; // for byte-offset text slicing

    internal CodeGraphTsNode(CodeGraphTsNodeRaw raw, CodeGraphSourceText src)
    {
        _raw = raw;
        _src = src;
    }

    /// <summary>Absent-child sentinel (raw node Id == NULL). The C API has no null.</summary>
    public bool IsNull => _raw.IsNull;

    /// <summary>Grammar node type name (e.g. "function_declaration"). Language-owned string.</summary>
    public string Type => CodeGraphTsBindings.PtrToUtf8(CodeGraphTsBindings.ts_node_type(_raw));

    /// <summary>Numeric type key (TSSymbol) — the fast type comparator.</summary>
    public ushort Symbol => CodeGraphTsBindings.ts_node_symbol(_raw);

    public bool IsNamed => CodeGraphTsBindings.ts_node_is_named(_raw);
    public bool HasError => CodeGraphTsBindings.ts_node_has_error(_raw);
    public bool IsMissing => CodeGraphTsBindings.ts_node_is_missing(_raw);

    // BYTE offsets (Decision 22) — for text slicing and the node-id line.
    public int StartByte => (int)CodeGraphTsBindings.ts_node_start_byte(_raw);
    public int EndByte => (int)CodeGraphTsBindings.ts_node_end_byte(_raw);

    // Points: Row/Column both 0-based, byte-derived. Extractors do Row+1 for the
    // 1-based start_line; Column is already the 0-based byte column stored as-is.
    public CodeGraphTsPoint StartPoint => CodeGraphTsBindings.ts_node_start_point(_raw);
    public CodeGraphTsPoint EndPoint => CodeGraphTsBindings.ts_node_end_point(_raw);

    public int ChildCount => (int)CodeGraphTsBindings.ts_node_child_count(_raw);
    public int NamedChildCount => (int)CodeGraphTsBindings.ts_node_named_child_count(_raw);

    public CodeGraphTsNode Child(int index) => Wrap(CodeGraphTsBindings.ts_node_child(_raw, (uint)index));
    public CodeGraphTsNode NamedChild(int index) => Wrap(CodeGraphTsBindings.ts_node_named_child(_raw, (uint)index));
    public CodeGraphTsNode Parent => Wrap(CodeGraphTsBindings.ts_node_parent(_raw));
    public CodeGraphTsNode NextNamedSibling => Wrap(CodeGraphTsBindings.ts_node_next_named_sibling(_raw));
    public CodeGraphTsNode PrevNamedSibling => Wrap(CodeGraphTsBindings.ts_node_prev_named_sibling(_raw));

    /// <summary>childForFieldName(name): UTF-8 field-name bytes (ASCII field names).</summary>
    public unsafe CodeGraphTsNode ChildByField(ReadOnlySpan<byte> utf8FieldName)
    {
        fixed (byte* p = utf8FieldName)
            return Wrap(CodeGraphTsBindings.ts_node_child_by_field_name(_raw, p, (uint)utf8FieldName.Length));
    }

    /// <summary>childForFieldName(name): convenience string overload — field names are ASCII.</summary>
    public unsafe CodeGraphTsNode ChildByField(string fieldName)
    {
        int max = Encoding.UTF8.GetMaxByteCount(fieldName.Length);
        Span<byte> buffer = max <= 128 ? stackalloc byte[max] : new byte[max];
        int written = Encoding.UTF8.GetBytes(fieldName, buffer);
        fixed (byte* p = buffer)
            return Wrap(CodeGraphTsBindings.ts_node_child_by_field_name(_raw, p, (uint)written));
    }

    /// <summary>
    /// getNodeText(node): slice the UTF-8 buffer by BYTE offset (Decision 22),
    /// never by char index — one non-ASCII char desyncs char/byte offsets.
    /// </summary>
    public string Text => _src.Slice(StartByte, EndByte);

    /// <summary>
    /// descendantsOfType — NOT a C API function; reproduce web-tree-sitter's
    /// recursive named-child walk collecting matching type names.
    /// </summary>
    public void CollectDescendantsOfType(HashSet<string> types, List<CodeGraphTsNode> into)
    {
        int count = NamedChildCount;
        for (int i = 0; i < count; i++)
        {
            CodeGraphTsNode child = NamedChild(i);
            if (types.Contains(child.Type)) into.Add(child);
            child.CollectDescendantsOfType(types, into);
        }
    }

    private CodeGraphTsNode Wrap(CodeGraphTsNodeRaw raw) => new(raw, _src);
}
