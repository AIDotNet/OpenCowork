using System.Runtime.InteropServices;

// =============================================================================
// CodeGraphGrammarRegistry — language string -> tree_sitter_<lang>() handle.
//
// Each grammar's parser.c exports exactly ONE `tree_sitter_<lang>()` returning a
// const TSLanguage*; that is the only grammar-specific symbol. Everything else is
// libtree-sitter (CodeGraphTsBindings).
//
//   * LAZY-LOAD per grammar: a missing/mis-RID grammar lib throws
//     DllNotFoundException on the FIRST P/Invoke, not at boot. Catch it so a
//     missing lib disables ONE language and boot still succeeds (reference/03 §5.3).
//     libtree-sitter ITSELF is the exception — its absence is a hard, correct fail.
//   * NEVER resolve grammars in a static ctor / module init — that turns one
//     missing lib into a dead worker (reference/03 §5.3).
//   * TSLanguage* handles are process-static (owned by the grammar lib's static
//     data) — cache for the worker's lifetime; never ts_language_delete them.
//
// MVP grammar set (roadmap M2): TS/TSX/JS(+JSX reuse), Python, Go, Java, C#, Rust.
// COMPILES today with every grammar lib ABSENT; only the languages whose libs are
// present will resolve at runtime.
// =============================================================================

// One extern per tree_sitter_<lang> entry-point. The [LibraryImport] lib name is
// the native base name, mapped per-RID by NativeLibrary resolution / DirectPInvoke.
internal static partial class CodeGraphGrammarEntries
{
    [LibraryImport("tree-sitter-typescript", EntryPoint = "tree_sitter_typescript")]
    internal static partial nint TypeScript();

    [LibraryImport("tree-sitter-typescript", EntryPoint = "tree_sitter_tsx")]
    internal static partial nint Tsx();

    [LibraryImport("tree-sitter-javascript", EntryPoint = "tree_sitter_javascript")]
    internal static partial nint JavaScript();

    [LibraryImport("tree-sitter-python", EntryPoint = "tree_sitter_python")]
    internal static partial nint Python();

    [LibraryImport("tree-sitter-go", EntryPoint = "tree_sitter_go")]
    internal static partial nint Go();

    [LibraryImport("tree-sitter-java", EntryPoint = "tree_sitter_java")]
    internal static partial nint Java();

    // Vendored ABI-15 tree-sitter-c-sharp (primary-constructor support).
    [LibraryImport("tree-sitter-c-sharp", EntryPoint = "tree_sitter_c_sharp")]
    internal static partial nint CSharp();

    [LibraryImport("tree-sitter-rust", EntryPoint = "tree_sitter_rust")]
    internal static partial nint Rust();
}

internal sealed class CodeGraphGrammarRegistry
{
    private readonly object _gate = new();
    private readonly Dictionary<string, nint> _cache = new(); // lang -> loaded TSLanguage*
    private readonly HashSet<string> _unavailable = new();    // lazy-load / ABI failures

    /// <summary>
    /// Resolve a language-vocabulary string to a cached TSLanguage* handle, or
    /// null if the grammar lib is missing / its ABI is unsupported. Never throws
    /// for a missing grammar — it disables just that language (reference/03 §5.3).
    /// Thread-safe: parse worker threads (Decision 10) may call this concurrently.
    /// </summary>
    public nint? GetLanguage(string language)
    {
        lock (_gate)
        {
            if (_cache.TryGetValue(language, out nint cached)) return cached;
            if (_unavailable.Contains(language)) return null;

            nint handle;
            try
            {
                handle = ResolveEntry(language);
            }
            catch (DllNotFoundException) // grammar lib not shipped for this RID
            {
                _unavailable.Add(language);
                return null;
            }
            catch (EntryPointNotFoundException) // lib present but wrong export
            {
                _unavailable.Add(language);
                return null;
            }

            if (handle == 0)
            {
                _unavailable.Add(language);
                return null;
            }

            // R3: assert the grammar ABI is within libtree-sitter's supported range.
            uint abi = CodeGraphTsBindings.ts_language_abi_version(handle);
            if (abi < CodeGraphTs.MinAbi || abi > CodeGraphTs.MaxAbi)
            {
                _unavailable.Add(language);
                return null;
            }

            _cache[language] = handle;
            return handle;
        }
    }

    /// <summary>True once a language has been probed and found unavailable.</summary>
    public bool IsUnavailable(string language)
    {
        lock (_gate)
        {
            return _unavailable.Contains(language);
        }
    }

    private static nint ResolveEntry(string language) => language switch
    {
        CodeGraphLanguageIds.TypeScript => CodeGraphGrammarEntries.TypeScript(),
        CodeGraphLanguageIds.Tsx => CodeGraphGrammarEntries.Tsx(),
        CodeGraphLanguageIds.JavaScript or CodeGraphLanguageIds.Jsx => CodeGraphGrammarEntries.JavaScript(),
        CodeGraphLanguageIds.Python => CodeGraphGrammarEntries.Python(),
        CodeGraphLanguageIds.Go => CodeGraphGrammarEntries.Go(),
        CodeGraphLanguageIds.Java => CodeGraphGrammarEntries.Java(),
        CodeGraphLanguageIds.CSharp => CodeGraphGrammarEntries.CSharp(),
        CodeGraphLanguageIds.Rust => CodeGraphGrammarEntries.Rust(),
        _ => 0
    };
}

// Minimal language-id vocabulary needed by the grammar registry. This is a local
// subset of the full CodeGraphLanguage constant set (reference/01 §2.1); if the
// serialization agent's CodeGraphLanguage lands in the same assembly, prefer that
// and delete this. Kept CodeGraph-prefixed and distinct to avoid a collision.
internal static class CodeGraphLanguageIds
{
    public const string TypeScript = "typescript";
    public const string JavaScript = "javascript";
    public const string Tsx = "tsx";
    public const string Jsx = "jsx";
    public const string Python = "python";
    public const string Go = "go";
    public const string Java = "java";
    public const string CSharp = "csharp";
    public const string Rust = "rust";
}
