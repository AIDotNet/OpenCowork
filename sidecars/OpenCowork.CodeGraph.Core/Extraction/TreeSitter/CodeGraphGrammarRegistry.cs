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

    [LibraryImport("tree-sitter-tsx", EntryPoint = "tree_sitter_tsx")]
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

    [LibraryImport("tree-sitter-c", EntryPoint = "tree_sitter_c")]
    internal static partial nint C();

    [LibraryImport("tree-sitter-cpp", EntryPoint = "tree_sitter_cpp")]
    internal static partial nint Cpp();

    // tree-sitter-php exports tree_sitter_php (the full HTML-aware grammar); the
    // PHP-only variant tree_sitter_php_only is absent from this dylib.
    [LibraryImport("tree-sitter-php", EntryPoint = "tree_sitter_php")]
    internal static partial nint Php();

    [LibraryImport("tree-sitter-ruby", EntryPoint = "tree_sitter_ruby")]
    internal static partial nint Ruby();

    [LibraryImport("tree-sitter-scala", EntryPoint = "tree_sitter_scala")]
    internal static partial nint Scala();

    // --- M7 niche languages (15). Each vendors its own grammar lib; the whole set
    // compiles with every lib ABSENT and resolves per-grammar only once the lib is
    // download-available for the RID (reference/03 §5.3). ---

    [LibraryImport("tree-sitter-swift", EntryPoint = "tree_sitter_swift")]
    internal static partial nint Swift();

    [LibraryImport("tree-sitter-kotlin", EntryPoint = "tree_sitter_kotlin")]
    internal static partial nint Kotlin();

    [LibraryImport("tree-sitter-dart", EntryPoint = "tree_sitter_dart")]
    internal static partial nint Dart();

    [LibraryImport("tree-sitter-objc", EntryPoint = "tree_sitter_objc")]
    internal static partial nint ObjC();

    // ArkTS (HarmonyOS): a tsx-based fork vendored as tree-sitter-arkts.
    [LibraryImport("tree-sitter-arkts", EntryPoint = "tree_sitter_arkts")]
    internal static partial nint ArkTs();

    [LibraryImport("tree-sitter-cobol", EntryPoint = "tree_sitter_cobol")]
    internal static partial nint Cobol();

    // VB.NET: vendored govindbanura/tree-sitter-vbnet.
    [LibraryImport("tree-sitter-vbnet", EntryPoint = "tree_sitter_vbnet")] // TODO verify entrypoint vs the built grammar
    internal static partial nint VbNet();

    [LibraryImport("tree-sitter-erlang", EntryPoint = "tree_sitter_erlang")]
    internal static partial nint Erlang();

    [LibraryImport("tree-sitter-nix", EntryPoint = "tree_sitter_nix")]
    internal static partial nint Nix();

    // Terraform/OpenTofu uses the HCL grammar (tree-sitter-hcl exports tree_sitter_hcl).
    [LibraryImport("tree-sitter-hcl", EntryPoint = "tree_sitter_hcl")] // TODO verify entrypoint vs the built grammar
    internal static partial nint Terraform();

    [LibraryImport("tree-sitter-solidity", EntryPoint = "tree_sitter_solidity")]
    internal static partial nint Solidity();

    // Vendored ABI-15 @tree-sitter-grammars/tree-sitter-lua (the Luau grammar
    // reuses its node names).
    [LibraryImport("tree-sitter-lua", EntryPoint = "tree_sitter_lua")]
    internal static partial nint Lua();

    [LibraryImport("tree-sitter-luau", EntryPoint = "tree_sitter_luau")]
    internal static partial nint Luau();

    [LibraryImport("tree-sitter-r", EntryPoint = "tree_sitter_r")]
    internal static partial nint R();

    // tree-sitter-cfml ships THREE grammars as separate dylibs: cfml (tag-based
    // <cfcomponent>/HTML), cfscript (modern bare-script `component { … }`), and
    // cfquery (`#hash#` call expressions inside a <cfquery> SQL body). The CFML
    // embedded extractor dialect-switches between them (analysis/01 §R6).
    [LibraryImport("tree-sitter-cfml", EntryPoint = "tree_sitter_cfml")]
    internal static partial nint Cfml();

    [LibraryImport("tree-sitter-cfscript", EntryPoint = "tree_sitter_cfscript")]
    internal static partial nint CfScript();

    [LibraryImport("tree-sitter-cfquery", EntryPoint = "tree_sitter_cfquery")]
    internal static partial nint CfQuery();

    [LibraryImport("tree-sitter-pascal", EntryPoint = "tree_sitter_pascal")]
    internal static partial nint Pascal();

    // --- Grammar-expansion set (TreeSitter.DotNet 1.3.0 ships all four dylibs).
    // Bash/Haskell/Julia parse via their own grammar + config; Razor is handled by
    // the bespoke embedded extractor (regex directives + @code C# delegation) and
    // never actually resolves its grammar — the entry is wired for completeness. ---

    [LibraryImport("tree-sitter-bash", EntryPoint = "tree_sitter_bash")]
    internal static partial nint Bash();

    [LibraryImport("tree-sitter-haskell", EntryPoint = "tree_sitter_haskell")]
    internal static partial nint Haskell();

    [LibraryImport("tree-sitter-julia", EntryPoint = "tree_sitter_julia")]
    internal static partial nint Julia();

    [LibraryImport("tree-sitter-razor", EntryPoint = "tree_sitter_razor")]
    internal static partial nint Razor();
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
        CodeGraphLanguageIds.C => CodeGraphGrammarEntries.C(),
        CodeGraphLanguageIds.Cpp => CodeGraphGrammarEntries.Cpp(),
        CodeGraphLanguageIds.Php => CodeGraphGrammarEntries.Php(),
        CodeGraphLanguageIds.Ruby => CodeGraphGrammarEntries.Ruby(),
        CodeGraphLanguageIds.Scala => CodeGraphGrammarEntries.Scala(),
        CodeGraphLanguageIds.Swift => CodeGraphGrammarEntries.Swift(),
        CodeGraphLanguageIds.Kotlin => CodeGraphGrammarEntries.Kotlin(),
        CodeGraphLanguageIds.Dart => CodeGraphGrammarEntries.Dart(),
        CodeGraphLanguageIds.ObjC => CodeGraphGrammarEntries.ObjC(),
        CodeGraphLanguageIds.ArkTs => CodeGraphGrammarEntries.ArkTs(),
        CodeGraphLanguageIds.Cobol => CodeGraphGrammarEntries.Cobol(),
        CodeGraphLanguageIds.VbNet => CodeGraphGrammarEntries.VbNet(),
        CodeGraphLanguageIds.Erlang => CodeGraphGrammarEntries.Erlang(),
        CodeGraphLanguageIds.Nix => CodeGraphGrammarEntries.Nix(),
        CodeGraphLanguageIds.Terraform => CodeGraphGrammarEntries.Terraform(),
        CodeGraphLanguageIds.Solidity => CodeGraphGrammarEntries.Solidity(),
        CodeGraphLanguageIds.Lua => CodeGraphGrammarEntries.Lua(),
        CodeGraphLanguageIds.Luau => CodeGraphGrammarEntries.Luau(),
        CodeGraphLanguageIds.R => CodeGraphGrammarEntries.R(),
        CodeGraphLanguageIds.Cfml => CodeGraphGrammarEntries.Cfml(),
        CodeGraphLanguageIds.CfScript => CodeGraphGrammarEntries.CfScript(),
        CodeGraphLanguageIds.CfQuery => CodeGraphGrammarEntries.CfQuery(),
        CodeGraphLanguageIds.Pascal => CodeGraphGrammarEntries.Pascal(),
        CodeGraphLanguageIds.Bash => CodeGraphGrammarEntries.Bash(),
        CodeGraphLanguageIds.Haskell => CodeGraphGrammarEntries.Haskell(),
        CodeGraphLanguageIds.Julia => CodeGraphGrammarEntries.Julia(),
        CodeGraphLanguageIds.Razor => CodeGraphGrammarEntries.Razor(),
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
    public const string C = "c";
    public const string Cpp = "cpp";
    public const string Php = "php";
    public const string Ruby = "ruby";
    public const string Scala = "scala";
    public const string Swift = "swift";
    public const string Kotlin = "kotlin";
    public const string Dart = "dart";
    public const string ObjC = "objc";
    public const string ArkTs = "arkts";
    public const string Cobol = "cobol";
    public const string VbNet = "vbnet";
    public const string Erlang = "erlang";
    public const string Nix = "nix";
    public const string Terraform = "terraform";
    public const string Solidity = "solidity";
    public const string Lua = "lua";
    public const string Luau = "luau";
    public const string R = "r";
    public const string Cfml = "cfml";
    public const string CfScript = "cfscript";
    public const string CfQuery = "cfquery";
    public const string Pascal = "pascal";
    public const string Bash = "bash";
    public const string Haskell = "haskell";
    public const string Julia = "julia";
    public const string Razor = "razor";
}
