// =============================================================================
// CodeGraphTsTree — IDisposable wrapper over a native TSTree.
//
// ts_tree_delete frees malloc'd memory: model as IDisposable, `using` it at the
// end of each file's parse, NO finalizer (reference/03 §5.5). A TSTree/TSNode may
// be read from another thread once parsing is done, but keep the tree confined to
// the thread that will delete it (reference/03 §5.6).
//
// COMPILES today; will not RUN until libtree-sitter is present.
// =============================================================================
internal sealed class CodeGraphTsTree : IDisposable
{
    private nint _handle;
    private readonly CodeGraphSourceText _source;

    internal CodeGraphTsTree(nint handle, CodeGraphSourceText source)
    {
        _handle = handle;
        _source = source;
    }

    /// <summary>The source text the tree's byte offsets index into.</summary>
    public CodeGraphSourceText Source => _source;

    /// <summary>The root node (type "program"/"source_file"/… per grammar).</summary>
    public CodeGraphTsNode RootNode =>
        new(CodeGraphTsBindings.ts_tree_root_node(_handle), _source);

    public void Dispose()
    {
        if (_handle != 0)
        {
            CodeGraphTsBindings.ts_tree_delete(_handle);
            _handle = 0;
        }
    }
}
