using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// =============================================================================
// CodeGraphImportResolver — the import/module-resolution strategy (≙ import-resolver.ts
// + path-aliases.ts + go-module.ts + workspace-packages.ts). It exposes the exact
// method signatures the CodeGraphReferenceResolver AND CodeGraphStoreResolutionContext
// call. Config parsing (LoadProjectAliases / LoadGoModule / LoadWorkspacePackages) is
// delegated to the reflection-free JsonDocument loaders in the sibling files
// (CodeGraphPathAliases / CodeGraphGoModuleLoader / CodeGraphWorkspaces) — NEVER
// JsonSerializer.Deserialize<T> (Decision on AOT config parsing).
//
// MVP ecosystems (analysis/02 §7): JS/TS (relative + tsconfig `paths` + monorepo
// `workspaces` + re-export chains), Python (module→file + module-member), Go
// (cross-package via go.mod), Java/Kotlin (JVM FQN), plus the file→file module
// resolvers C/C++ #include (quoted-relative then compile_commands.json -I dirs),
// PHP include/require, and COBOL COPY / EXEC SQL INCLUDE. M7-W1 adds the four
// branches the MVP deferred: Nix path imports, Rust `crate::`/`self::`/`super::`
// module paths, Lua/Luau `require(...)`, and PHP `use` namespace mappings (ohpm
// workspaces live in CodeGraphWorkspaces). The resolver holds only two per-run memo caches mirroring
// import-resolver.ts's module-level ones — the C/C++ include-dir list (by
// projectRoot) and the COBOL copybook stem index (by context, GC-scoped like the TS
// WeakMap); a fresh resolver is built per run, so everything else caches in context.
// =============================================================================
internal sealed class CodeGraphImportResolver
{
    // Recursive depth cap for re-export chain following (import-resolver.ts:1951).
    private const int ReexportMaxDepth = 8;

    private static readonly RegexOptions Ecma = RegexOptions.ECMAScript;
    private static readonly RegexOptions EcmaMultiline = RegexOptions.ECMAScript | RegexOptions.Multiline;

    // --- JS/TS import extraction (import-resolver.ts:702, :757) ---
    private static readonly Regex JsImportRegex = new(
        @"import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:(\*)\s+as\s+(\w+))?\s*from\s*['""]([^'""]+)['""]", Ecma);
    private static readonly Regex JsRequireRegex = new(
        @"(?:const|let|var)\s+(?:(\w+)|{([^}]+)})\s*=\s*require\(['""]([^'""]+)['""]\)", Ecma);
    private static readonly Regex JsNamedAliasRegex = new(@"(\w+)\s+as\s+(\w+)", Ecma);
    private static readonly Regex JsDestructureAliasRegex = new(@"(\w+)\s*:\s*(\w+)", Ecma);

    // --- Python import extraction (import-resolver.ts:806, :836) ---
    private static readonly Regex PyFromImportRegex = new(@"from\s+([\w.]+)\s+import\s+([^#\n]+)", Ecma);
    private static readonly Regex PyImportRegex = new(@"^import\s+([\w.]+)(?:\s+as\s+(\w+))?", EcmaMultiline);
    private static readonly Regex PyAliasRegex = new(@"(\w+)\s+as\s+(\w+)", Ecma);

    // --- Go import extraction (import-resolver.ts:859, :875, :878) ---
    private static readonly Regex GoSingleImportRegex = new(@"import\s+(?:(\w+)\s+)?[""']([^""']+)[""']", Ecma);
    private static readonly Regex GoBlockImportRegex = new(@"import\s*\(\s*([^)]+)\s*\)", Ecma);
    private static readonly Regex GoBlockLineRegex = new(@"(?:(\w+)\s+)?[""']([^""']+)[""']", Ecma);

    // --- Java/Kotlin import extraction (import-resolver.ts:914, :918) ---
    private static readonly Regex JavaBlockComment = new(@"/\*[\s\S]*?\*/", RegexOptions.CultureInvariant);
    private static readonly Regex JavaLineComment = new(@"//[^\n]*", RegexOptions.CultureInvariant);
    private static readonly Regex JavaImportRegex = new(@"^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;", EcmaMultiline);

    // --- PHP `use` extraction (import-resolver.ts:1010) ---
    private static readonly Regex PhpUseRegex = new(@"use\s+([\w\\]+)(?:\s+as\s+(\w+))?;", Ecma);

    // --- Nix path-import shape: any dynamic-expression character disqualifies
    // (import-resolver.ts:46) ---
    private static readonly Regex NixDynamicExprRegex = new(@"[\s{}()\[\];""'<>$]", RegexOptions.CultureInvariant);

    // --- Re-export extraction (import-resolver.ts:1094, :1101, :1108, :1116) ---
    private static readonly Regex WildcardReExportRegex = new(@"export\s*\*(?:\s+as\s+\w+)?\s*from\s*['""]([^'""]+)['""]", Ecma);
    private static readonly Regex NamedReExportRegex = new(@"export\s*\{([^}]+)\}\s*from\s*['""]([^'""]+)['""]", Ecma);
    private static readonly Regex ReExportAliasRegex = new(@"^(\w+)\s+as\s+(\w+)$", Ecma);
    private static readonly Regex WordOnlyRegex = new(@"^\w+$", Ecma);

    // Extension resolution order by language (import-resolver.ts:17). Data only.
    private static readonly Dictionary<string, string[]> ExtensionResolution = new(StringComparer.Ordinal)
    {
        [CodeGraphLanguage.TypeScript] = new[] { ".ts", ".tsx", ".d.ts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js" },
        [CodeGraphLanguage.ArkTs] = new[] { ".ets", ".ts", ".d.ts", ".js", "/Index.ets", "/index.ets", "/index.ts", "/index.js" },
        [CodeGraphLanguage.JavaScript] = new[] { ".js", ".jsx", ".mjs", ".cjs", "/index.js", "/index.jsx" },
        [CodeGraphLanguage.Tsx] = new[] { ".tsx", ".ts", ".d.ts", ".js", ".jsx", "/index.tsx", "/index.ts", "/index.js" },
        [CodeGraphLanguage.Jsx] = new[] { ".jsx", ".js", "/index.jsx", "/index.js" },
        [CodeGraphLanguage.Svelte] = new[] { ".ts", ".js", ".svelte", ".tsx", ".jsx", "/index.ts", "/index.js", "/index.svelte" },
        [CodeGraphLanguage.Vue] = new[] { ".ts", ".js", ".vue", ".tsx", ".jsx", "/index.ts", "/index.js", "/index.vue" },
        [CodeGraphLanguage.Astro] = new[] { ".ts", ".js", ".astro", ".tsx", ".jsx", "/index.ts", "/index.js", "/index.astro" },
        [CodeGraphLanguage.Python] = new[] { ".py", "/__init__.py" },
        [CodeGraphLanguage.Go] = new[] { ".go" },
        [CodeGraphLanguage.Rust] = new[] { ".rs", "/mod.rs" },
        [CodeGraphLanguage.Java] = new[] { ".java" },
        [CodeGraphLanguage.C] = new[] { ".h", ".c" },
        [CodeGraphLanguage.Cpp] = new[] { ".h", ".hpp", ".hxx", ".cpp", ".cc", ".cxx" },
        [CodeGraphLanguage.CSharp] = new[] { ".cs" },
        [CodeGraphLanguage.Php] = new[] { ".php" },
        [CodeGraphLanguage.Ruby] = new[] { ".rb" },
        [CodeGraphLanguage.ObjC] = new[] { ".h", ".m", ".mm" },
        [CodeGraphLanguage.Nix] = new[] { ".nix", "/default.nix" }
    };

    // Node built-in modules — external for a JS/TS import (import-resolver.ts:220).
    private static readonly HashSet<string> NodeBuiltins = new(StringComparer.Ordinal)
    {
        "fs", "path", "os", "crypto", "http", "https", "url", "util", "events",
        "stream", "child_process", "buffer"
    };

    // Python stdlib module roots (import-resolver.ts:239).
    private static readonly HashSet<string> PythonStdLibs = new(StringComparer.Ordinal)
    {
        "os", "sys", "json", "re", "math", "datetime", "collections", "typing", "pathlib", "logging"
    };

    // Legacy hard-coded alias fallbacks, insertion-ordered (import-resolver.ts:380).
    private static readonly (string Alias, string Replacement)[] FallbackAliases =
    {
        ("@/", "src/"), ("~/", "src/"), ("@src/", "src/"), ("src/", "src/"), ("@app/", "app/"), ("app/", "app/")
    };

    // Node kinds that own static members reachable as `Container.member` (import-resolver.ts:2052).
    private static readonly HashSet<string> StaticMemberContainers = new(StringComparer.Ordinal)
    {
        CodeGraphNodeKind.Class, CodeGraphNodeKind.Struct, CodeGraphNodeKind.Interface,
        CodeGraphNodeKind.Enum, CodeGraphNodeKind.Trait, CodeGraphNodeKind.Protocol
    };

    // --- C/C++ #include extraction + header classification (import-resolver.ts:978, :157, :567) ---
    // `#include <x.h>` / `#include "x.h"` — line-anchored, capturing the delimited path.
    private static readonly Regex CppIncludeRegex = new(@"^\s*#\s*include\s+[<""]([^>""]+)[>""]", EcmaMultiline);
    // Header-file extension stripped off an include's basename to form its localName.
    private static readonly Regex CppHeaderExtRegex = new(@"\.(h|hpp|hxx|hh|inl|ipp|cxx|cc|cpp)$", Ecma);
    // Case-insensitive header test for the heuristic include-dir probe.
    private static readonly Regex HeaderFileExtRegex = new(@"\.(h|hpp|hxx|hh)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // C/C++ standard-library headers — both C-style (<stdio.h>) and C++-style
    // (<cstdio>, <vector>) forms — filtered from resolution as external
    // (import-resolver.ts:157). Duplicates across the three groups are deduped by the set.
    private static readonly HashSet<string> CCppStdlibHeaders = new(StringComparer.Ordinal)
    {
        // C standard library headers
        "assert.h", "complex.h", "ctype.h", "errno.h", "fenv.h", "float.h",
        "inttypes.h", "iso646.h", "limits.h", "locale.h", "math.h", "setjmp.h",
        "signal.h", "stdalign.h", "stdarg.h", "stdatomic.h", "stdbool.h",
        "stddef.h", "stdint.h", "stdio.h", "stdlib.h", "stdnoreturn.h",
        "string.h", "tgmath.h", "threads.h", "time.h", "uchar.h", "wchar.h",
        "wctype.h",
        // C++ C-library wrappers (cname form)
        "cassert", "ccomplex", "cctype", "cerrno", "cfenv", "cfloat",
        "cinttypes", "ciso646", "climits", "clocale", "cmath", "csetjmp",
        "csignal", "cstdalign", "cstdarg", "cstdbool", "cstddef", "cstdint",
        "cstdio", "cstdlib", "cstring", "ctgmath", "ctime", "cuchar",
        "cwchar", "cwctype",
        // C++ STL headers
        "algorithm", "any", "array", "atomic", "barrier", "bit", "bitset",
        "charconv", "chrono", "codecvt", "compare", "complex", "concepts",
        "condition_variable", "coroutine", "deque", "exception", "execution",
        "expected", "filesystem", "format", "forward_list", "fstream",
        "functional", "future", "generator", "initializer_list", "iomanip",
        "ios", "iosfwd", "iostream", "istream", "iterator", "latch",
        "limits", "list", "locale", "map", "mdspan", "memory", "memory_resource",
        "mutex", "new", "numbers", "numeric", "optional", "ostream", "print",
        "queue", "random", "ranges", "ratio", "regex", "scoped_allocator",
        "semaphore", "set", "shared_mutex", "source_location", "span",
        "spanstream", "sstream", "stack", "stacktrace", "stdexcept",
        "stdfloat", "stop_token", "streambuf", "string", "string_view",
        "strstream", "syncstream", "system_error", "thread", "tuple",
        "type_traits", "typeindex", "typeinfo", "unordered_map",
        "unordered_set", "utility", "valarray", "variant", "vector",
        "version"
    };

    // compile_commands.json search locations relative to the project root
    // (import-resolver.ts:442). Real filesystem paths — combined with Path.Combine.
    private static readonly string[] CompileDbRelativePaths =
    {
        "compile_commands.json",
        "build/compile_commands.json",
        "cmake-build-debug/compile_commands.json",
        "cmake-build-release/compile_commands.json",
        "out/compile_commands.json"
    };

    // Convention directories the heuristic treats as include roots (import-resolver.ts:552).
    private static readonly HashSet<string> CppConventionDirs = new(StringComparer.Ordinal)
    {
        "include", "src", "lib", "api", "inc"
    };

    // Per-run memo caches mirroring import-resolver.ts's module-level caches (the
    // resolver is rebuilt per resolution run, so these live exactly one run).
    // cppIncludeDirCache: projectRoot -> resolved -I search dirs (import-resolver.ts
    // cppIncludeDirCache). cobolCopybookIndexes: the WeakMap-equivalent keyed by
    // context -> lowercased-stem -> file paths (import-resolver.ts cobolCopybookIndexes).
    private readonly Dictionary<string, IReadOnlyList<string>> cppIncludeDirCache = new(StringComparer.Ordinal);
    private readonly ConditionalWeakTable<CodeGraphResolutionContext, Dictionary<string, List<string>>> cobolCopybookIndexes = new();

    // =====================================================================
    // Public contract (KEEP SIGNATURES)
    // =====================================================================

    // Import strategy (index.ts strategy 2). null when no import binds it.
    public CodeGraphResolvedRef? ResolveViaImport(CodeGraphUnresolvedReference r, CodeGraphResolutionContext ctx)
    {
        // C/C++ #include -> file→file edge (bypass symbol lookup). A quoted include
        // resolves against the INCLUDING file's own directory FIRST (the C standard's
        // quoted-include search order) so a same-directory header wins over a same-named
        // header reachable via an -I dir or on another platform; then the -I search.
        if ((r.Language == CodeGraphLanguage.C || r.Language == CodeGraphLanguage.Cpp) &&
            r.ReferenceKind == CodeGraphEdgeKind.Imports)
        {
            var refFilePath = r.FilePath ?? string.Empty;
            var slash = refFilePath.LastIndexOf('/');
            var fromDir = slash >= 0 ? refFilePath[..slash] : string.Empty;
            var siblingPath = CodeGraphPosixPath.Join(fromDir, r.ReferenceName);
            var sibling = FindFileNode(LastSegment(siblingPath), siblingPath, ctx);
            if (sibling is not null)
            {
                return new CodeGraphResolvedRef(sibling.Id, 0.92, CodeGraphResolvedBy.Import);
            }

            var cppPath = ResolveImportPath(r.ReferenceName, refFilePath, r.Language, ctx);
            if (cppPath is null)
            {
                return null;
            }

            var cppHit = FindFileNode(LastSegment(cppPath), cppPath, ctx);
            return cppHit is not null ? new CodeGraphResolvedRef(cppHit.Id, 0.9, CodeGraphResolvedBy.Import) : null;
        }

        // COBOL COPY / EXEC SQL INCLUDE -> file→file edge (mirrors the C/C++ branch). A
        // member matching no indexed file (compiler-supplied SQLCA / DFHAID) stays
        // unresolved — never fall through to the symbol name-matcher.
        if (IsCobolCopybookRef(r))
        {
            var cobolPath = ResolveImportPath(r.ReferenceName, r.FilePath ?? string.Empty, r.Language ?? CodeGraphLanguage.Cobol, ctx);
            if (cobolPath is null)
            {
                return null;
            }

            var cobolHit = FindFileNode(LastSegment(cobolPath), cobolPath, ctx);
            return cobolHit is not null ? new CodeGraphResolvedRef(cobolHit.Id, 0.9, CodeGraphResolvedBy.Import) : null;
        }

        // PHP include/require -> file→file edge (mirrors the C/C++ branch). A path-shaped
        // include that doesn't resolve to a known project file is a dead end — return
        // unresolved rather than mis-connecting to an unrelated same-named file elsewhere.
        if (IsPhpIncludePathRef(r))
        {
            var phpPath = ResolvePhpIncludePath(r.ReferenceName, r.FilePath ?? string.Empty, ctx);
            if (phpPath is not null)
            {
                var phpHit = FindFileNode(LastSegment(phpPath), phpPath, ctx);
                if (phpHit is not null)
                {
                    return new CodeGraphResolvedRef(phpHit.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }

            return null;
        }

        // Nix static project-path imports (`import ./x.nix`, `builtins.import ./dir`,
        // `import ./x.nix {}`) resolve to file nodes only. Angle-bracket channels,
        // attribute expressions, variables, and other dynamic expressions stay
        // unresolved (import-resolver.ts:1372).
        if (IsNixPathImportRef(r))
        {
            var nixPath = ResolveImportPath(r.ReferenceName, r.FilePath ?? string.Empty, r.Language ?? CodeGraphLanguage.Nix, ctx);
            if (nixPath is null)
            {
                return null;
            }

            var nixHit = FindFileNode(LastSegment(nixPath), nixPath, ctx);
            return nixHit is not null ? new CodeGraphResolvedRef(nixHit.Id, 0.9, CodeGraphResolvedBy.Import) : null;
        }

        var lang = r.Language ?? CodeGraphLanguage.Unknown;
        var filePath = r.FilePath ?? string.Empty;

        // Extraction emits one JS-family `imports` reference whose name is the
        // MODULE SOURCE (`./util`, not a local binding such as `greet`). Resolve that
        // path directly to the target file before binding-level import matching.
        // This also covers side-effect imports, which intentionally have no local
        // mapping. Without this branch the generic name matcher can self-resolve
        // `./util` to the importing file's own import node.
        if (IsJsFamily(lang) && r.ReferenceKind == CodeGraphEdgeKind.Imports)
        {
            var resolvedPath = ResolveImportPath(r.ReferenceName, filePath, lang, ctx);
            if (resolvedPath is not null && resolvedPath != filePath)
            {
                var fileNode = FirstFileNode(ctx.GetNodesInFile(resolvedPath));
                if (fileNode is not null)
                {
                    return new CodeGraphResolvedRef(fileNode.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }
        }

        // Cached import mappings (avoids re-reading/re-parsing per ref). `!readFile` in
        // the TS is falsy for an empty file too, so IsNullOrEmpty is the faithful gate.
        var imports = ctx.GetImportMappings(filePath, lang);
        if (imports.Count == 0 && string.IsNullOrEmpty(ctx.ReadFile(filePath)))
        {
            return null;
        }

        // Go cross-package calls (`pkga.FuncX`) — issue #388.
        if (lang == CodeGraphLanguage.Go)
        {
            var goResult = ResolveGoCrossPackageReference(r, imports, ctx);
            if (goResult is not null)
            {
                return goResult;
            }
        }

        // Java / Kotlin — imports are FQNs; disambiguate by file-path suffix (#314).
        if (lang == CodeGraphLanguage.Java || lang == CodeGraphLanguage.Kotlin)
        {
            var javaResult = ResolveJavaImportedReference(r, imports, ctx);
            if (javaResult is not null)
            {
                return javaResult;
            }
        }

        // Python qualified access through an imported MODULE + absolute dotted module.
        if (lang == CodeGraphLanguage.Python)
        {
            var pyResult = ResolvePythonModuleMember(r, imports, ctx);
            if (pyResult is not null)
            {
                return pyResult;
            }

            var pyModResult = ResolvePythonAbsoluteModule(r, ctx);
            if (pyModResult is not null)
            {
                return pyModResult;
            }
        }

        // Rust qualified path: resolve the module prefix of `crate::m::Item` /
        // `self::sub::Item` / `super::m::func` to a file, then find the leaf symbol in
        // it. Disambiguates common-name `pub use self::read::read` re-exports that
        // name-matching would land on the wrong same-named symbol (import-resolver.ts:1436).
        if (lang == CodeGraphLanguage.Rust && r.ReferenceName.Contains("::", StringComparison.Ordinal))
        {
            var rustResult = ResolveRustPathReference(r, ctx);
            if (rustResult is not null)
            {
                return rustResult;
            }
        }

        // Lua / Luau `require(...)`: a dotted module path (`a.b.c`) or an instance-path
        // leaf (`Signal` from `require(script.Parent.Signal)`) — map it to a module file;
        // there's no static import statement, so the generic path-matcher can't bridge
        // the dot↔slash / leaf↔basename gap (import-resolver.ts:1445).
        if ((lang == CodeGraphLanguage.Lua || lang == CodeGraphLanguage.Luau) &&
            r.ReferenceKind == CodeGraphEdgeKind.Imports)
        {
            var luaResult = ResolveLuaRequire(r, ctx);
            if (luaResult is not null)
            {
                return luaResult;
            }
        }

        // Whole-module / namespace imports → link the importing file to the module file.
        if (lang == CodeGraphLanguage.Python || IsJsFamily(lang))
        {
            var moduleFile = ResolveModuleImportToFile(r, imports, ctx);
            if (moduleFile is not null)
            {
                return moduleFile;
            }
        }

        // Check whether the reference name matches any import.
        foreach (var imp in imports)
        {
            if (imp.LocalName != r.ReferenceName && !r.ReferenceName.StartsWith(imp.LocalName + ".", StringComparison.Ordinal))
            {
                continue;
            }

            var resolvedPath = ResolveImportPath(imp.Source, filePath, lang, ctx);
            if (resolvedPath is null)
            {
                continue;
            }

            var exportedName = imp.IsDefault ? "default" : imp.ExportedName;
            var memberName = imp.IsNamespace ? ReplaceFirst(r.ReferenceName, imp.LocalName + ".", string.Empty) : null;

            var targetNode = FindExportedSymbol(
                resolvedPath, imp.IsDefault, imp.IsNamespace, exportedName, memberName, lang, ctx,
                new HashSet<string>(StringComparer.Ordinal), 0);
            if (targetNode is null)
            {
                continue;
            }

            // `Foo.bar()` on a NAMED (non-namespace) class import — descend to the member
            // so the edge links `bar`, not the class (#825).
            if (!imp.IsNamespace && r.ReferenceName.StartsWith(imp.LocalName + ".", StringComparison.Ordinal))
            {
                var memberNode = ResolveStaticMember(targetNode, r, imp.LocalName, ctx);
                if (memberNode is not null)
                {
                    return new CodeGraphResolvedRef(memberNode.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }

            return new CodeGraphResolvedRef(targetNode.Id, 0.9, CodeGraphResolvedBy.Import);
        }

        return null;
    }

    // JVM FQN import short-circuit (`import com.example.Bar`) — resolves through the
    // qualifiedName index, unambiguous across packages (import-resolver.ts:1142).
    public CodeGraphResolvedRef? ResolveJvmImport(CodeGraphUnresolvedReference r, CodeGraphResolutionContext ctx)
    {
        if (r.ReferenceKind != CodeGraphEdgeKind.Imports)
        {
            return null;
        }

        if (r.Language != CodeGraphLanguage.Java && r.Language != CodeGraphLanguage.Kotlin)
        {
            return null;
        }

        var fqn = r.ReferenceName;
        var lastDot = fqn.LastIndexOf('.');
        if (lastDot <= 0)
        {
            return null;
        }

        var pkg = fqn[..lastDot];
        var sym = fqn[(lastDot + 1)..];
        if (sym == "*")
        {
            return null;
        }

        var candidates = ctx.GetNodesByQualifiedName(pkg + "::" + sym);
        if (candidates.Count == 0)
        {
            return null;
        }

        var best = candidates.Count == 1 ? candidates[0] : PickClosestJvmCandidate(candidates, r.FilePath ?? string.Empty);
        return new CodeGraphResolvedRef(best.Id, 0.95, CodeGraphResolvedBy.Import);
    }

    // Nix static path import (`./x.nix`, `../lib`) — relative-path shaped and free of
    // dynamic-expression characters; resolves to file nodes only (import-resolver.ts:46).
    public bool IsNixPathImportRef(CodeGraphUnresolvedReference r) =>
        r.Language == CodeGraphLanguage.Nix &&
        r.ReferenceKind == CodeGraphEdgeKind.Imports &&
        (r.ReferenceName.StartsWith("./", StringComparison.Ordinal) ||
         r.ReferenceName.StartsWith("../", StringComparison.Ordinal)) &&
        !NixDynamicExprRegex.IsMatch(r.ReferenceName);

    // PHP include/require PATH (vs a namespace `use` symbol). include/require emit a
    // file path ("lib.php", "inc/db.php", "../x.php"); namespace use is an FQN
    // (App\Foo\Bar) or a bare class symbol (Closure). PHP identifiers contain neither
    // '/' nor '.', so a slash or dot marks a path-shaped include — those resolve to
    // files only, so callers must NOT fall back to the name-matcher (import-resolver.ts:616).
    public bool IsPhpIncludePathRef(CodeGraphUnresolvedReference r) =>
        r.Language == CodeGraphLanguage.Php &&
        r.ReferenceKind == CodeGraphEdgeKind.Imports &&
        (r.ReferenceName.Contains('/') || r.ReferenceName.Contains('.'));

    // COBOL COPY / EXEC SQL INCLUDE copybook reference. Resolves to files only (or stays
    // unresolved for compiler-supplied members like SQLCA) — never to a same-named
    // symbol via the name-matcher (import-resolver.ts:629).
    public bool IsCobolCopybookRef(CodeGraphUnresolvedReference r) =>
        r.Language == CodeGraphLanguage.Cobol && r.ReferenceKind == CodeGraphEdgeKind.Imports;

    // Per-language import extraction over raw source (import-resolver.ts:660).
    public IReadOnlyList<CodeGraphImportMapping> ExtractImportMappings(string filePath, string content, string language)
    {
        var mappings = new List<CodeGraphImportMapping>();

        if (IsJsFamily(language) || language == CodeGraphLanguage.Svelte || language == CodeGraphLanguage.Vue || language == CodeGraphLanguage.Astro)
        {
            // SFC consumers (svelte/vue/astro) import via plain ES6 inside their script
            // block — running the ES6 import regex over the whole file is safe (#629).
            ExtractJsImports(content, mappings);
        }
        else if (language == CodeGraphLanguage.Python)
        {
            ExtractPythonImports(content, mappings);
        }
        else if (language == CodeGraphLanguage.Go)
        {
            ExtractGoImports(content, mappings);
        }
        else if (language == CodeGraphLanguage.Java || language == CodeGraphLanguage.Kotlin)
        {
            ExtractJavaImports(content, mappings);
        }
        else if (language == CodeGraphLanguage.C || language == CodeGraphLanguage.Cpp)
        {
            ExtractCppImports(content, mappings);
        }
        else if (language == CodeGraphLanguage.Php)
        {
            // PHP `use Namespace\Class;` mappings feed name-matcher FQN disambiguation;
            // include/require refs still resolve directly in ResolveViaImport (file→file).
            ExtractPhpImports(content, mappings);
        }

        return mappings;
    }

    // Barrel re-export extraction (import-resolver.ts:1074). `language` is the barrel's.
    public IReadOnlyList<CodeGraphReExport> ExtractReExports(string content, string language)
    {
        if (!IsJsFamily(language))
        {
            return Array.Empty<CodeGraphReExport>();
        }

        var result = new List<CodeGraphReExport>();

        // Pre-strip comments so a commented-out `// export { x } from '...'` doesn't
        // produce a phantom edge.
        var cleaned = StripJsComments(content);

        foreach (Match m in WildcardReExportRegex.Matches(cleaned))
        {
            result.Add(new CodeGraphReExport(CodeGraphReExportKind.Wildcard, m.Groups[1].Value));
        }

        foreach (Match m in NamedReExportRegex.Matches(cleaned))
        {
            var inner = m.Groups[1].Value;
            var source = m.Groups[2].Value;
            foreach (var raw in inner.Split(','))
            {
                var item = raw.Trim();
                if (item.Length == 0)
                {
                    continue;
                }

                var aliasMatch = ReExportAliasRegex.Match(item);
                if (aliasMatch.Success)
                {
                    result.Add(new CodeGraphReExport(
                        CodeGraphReExportKind.Named, source, aliasMatch.Groups[2].Value, aliasMatch.Groups[1].Value));
                }
                else if (WordOnlyRegex.IsMatch(item))
                {
                    result.Add(new CodeGraphReExport(CodeGraphReExportKind.Named, source, item, item));
                }
            }
        }

        return result;
    }

    // tsconfig/jsconfig `paths` alias map at the project root, or null.
    public CodeGraphAliasMap? LoadProjectAliases(string projectRoot) => CodeGraphPathAliases.Load(projectRoot);

    // Root go.mod module info, or null.
    public CodeGraphGoModule? LoadGoModule(string projectRoot) => CodeGraphGoModuleLoader.Load(projectRoot);

    // Monorepo workspace member packages, or null.
    public CodeGraphWorkspacePackages? LoadWorkspacePackages(string projectRoot) => CodeGraphWorkspaces.Load(projectRoot);

    // C/C++ -I include search dirs, project-relative (import-resolver.ts:425). Prefer
    // compile_commands.json's -I / -isystem flags; else a heuristic convention/header
    // probe. Memoized per projectRoot (the flags/dirs are lifetime-immutable config).
    public IReadOnlyList<string> LoadCppIncludeDirs(string projectRoot)
    {
        if (cppIncludeDirCache.TryGetValue(projectRoot, out var cached))
        {
            return cached;
        }

        var dirs = LoadCppIncludeDirsFromCompileDb(projectRoot) ?? LoadCppIncludeDirsHeuristic(projectRoot);
        cppIncludeDirCache[projectRoot] = dirs;
        return dirs;
    }

    // Parse -I<dir> / -I <dir> / -isystem <dir> from compile_commands.json (a Clang
    // compilation database). Returns null when no database is found (so the heuristic
    // runs); an array (possibly empty) otherwise (import-resolver.ts:441). Reflection-free
    // JsonDocument DOM — never JsonSerializer.Deserialize<T> (AOT config-parsing decision).
    private static IReadOnlyList<string>? LoadCppIncludeDirsFromCompileDb(string projectRoot)
    {
        string? dbPath = null;
        foreach (var rel in CompileDbRelativePaths)
        {
            var candidate = Path.Combine(projectRoot, rel.Replace('/', Path.DirectorySeparatorChar));
            try
            {
                if (File.Exists(candidate))
                {
                    dbPath = candidate;
                    break;
                }
            }
            catch
            {
                // ignore
            }
        }

        if (dbPath is null)
        {
            return null;
        }

        try
        {
            var content = File.ReadAllText(dbPath);
            using var doc = JsonDocument.Parse(content);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var dirs = new List<string>();
            foreach (var entry in doc.RootElement.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                // `entry.directory || projectRoot`.
                var dir = entry.TryGetProperty("directory", out var dirEl) && dirEl.ValueKind == JsonValueKind.String
                    ? dirEl.GetString() ?? string.Empty
                    : string.Empty;
                if (dir.Length == 0)
                {
                    dir = projectRoot;
                }

                // `entry.arguments || (entry.command ? shlexSplit(entry.command) : [])`.
                var args = new List<string>();
                if (entry.TryGetProperty("arguments", out var argsEl) && argsEl.ValueKind == JsonValueKind.Array)
                {
                    foreach (var a in argsEl.EnumerateArray())
                    {
                        if (a.ValueKind == JsonValueKind.String)
                        {
                            args.Add(a.GetString() ?? string.Empty);
                        }
                    }
                }
                else if (entry.TryGetProperty("command", out var cmdEl) && cmdEl.ValueKind == JsonValueKind.String)
                {
                    args = ShlexSplit(cmdEl.GetString() ?? string.Empty);
                }

                for (var i = 0; i < args.Count; i++)
                {
                    var arg = args[i];
                    string? includeDir = null;
                    if (arg.StartsWith("-I", StringComparison.Ordinal) && arg.Length > 2)
                    {
                        includeDir = arg[2..];
                    }
                    else if ((arg == "-isystem" || arg == "-I") && i + 1 < args.Count)
                    {
                        includeDir = args[i + 1];
                        i++; // skip next arg
                    }

                    if (string.IsNullOrEmpty(includeDir))
                    {
                        continue;
                    }

                    // Resolve relative to the compilation directory, re-express relative to
                    // the project root, and skip system/out-of-project dirs (../ or absolute).
                    var absPath = CodeGraphPosixPath.IsAbsolute(includeDir)
                        ? includeDir
                        : CodeGraphPosixPath.Resolve(dir, includeDir);
                    var relPath = CodeGraphPosixPath.Relative(projectRoot, absPath).Replace('\\', '/');
                    if (relPath.Length > 0 &&
                        !relPath.StartsWith("..", StringComparison.Ordinal) &&
                        !CodeGraphPosixPath.IsAbsolute(relPath) &&
                        seen.Add(relPath))
                    {
                        dirs.Add(relPath);
                    }
                }
            }

            return dirs;
        }
        catch
        {
            return null;
        }
    }

    // Minimal shlex-style split for a compiler command string; handles double- and
    // single-quoted arguments (import-resolver.ts:513).
    private static List<string> ShlexSplit(string cmd)
    {
        var result = new List<string>();
        var i = 0;
        while (i < cmd.Length)
        {
            while (i < cmd.Length && char.IsWhiteSpace(cmd[i]))
            {
                i++;
            }

            if (i >= cmd.Length)
            {
                break;
            }

            var ch = cmd[i];
            var arg = new StringBuilder();
            if (ch == '"')
            {
                i++;
                while (i < cmd.Length && cmd[i] != '"')
                {
                    if (cmd[i] == '\\' && i + 1 < cmd.Length)
                    {
                        i++;
                        arg.Append(cmd[i]);
                    }
                    else
                    {
                        arg.Append(cmd[i]);
                    }

                    i++;
                }

                i++; // closing quote
            }
            else if (ch == '\'')
            {
                i++;
                while (i < cmd.Length && cmd[i] != '\'')
                {
                    arg.Append(cmd[i]);
                    i++;
                }

                i++; // closing quote
            }
            else
            {
                while (i < cmd.Length && !char.IsWhiteSpace(cmd[i]))
                {
                    arg.Append(cmd[i]);
                    i++;
                }
            }

            result.Add(arg.ToString());
        }

        return result;
    }

    // Heuristic include-dir discovery when no compile_commands.json exists: convention
    // dirs (include/, src/, lib/, api/, inc/) plus any top-level dir containing a header
    // (import-resolver.ts:550). Dir names are returned project-relative in original case.
    private static IReadOnlyList<string> LoadCppIncludeDirsHeuristic(string projectRoot)
    {
        var dirs = new List<string>();
        try
        {
            foreach (var entryPath in Directory.EnumerateDirectories(projectRoot))
            {
                var name = Path.GetFileName(entryPath);
                if (name.Length == 0)
                {
                    continue;
                }

                if (CppConventionDirs.Contains(name.ToLowerInvariant()))
                {
                    dirs.Add(name);
                    continue;
                }

                try
                {
                    foreach (var f in Directory.EnumerateFiles(Path.Combine(projectRoot, name)))
                    {
                        if (HeaderFileExtRegex.IsMatch(Path.GetFileName(f)))
                        {
                            dirs.Add(name);
                            break;
                        }
                    }
                }
                catch
                {
                    // ignore permission errors
                }
            }
        }
        catch
        {
            // ignore
        }

        return dirs;
    }

    // =====================================================================
    // Import-path resolution (import-resolver.ts:58, :282, :340)
    // =====================================================================

    private string? ResolveImportPath(string importPath, string fromFile, string language, CodeGraphResolutionContext ctx)
    {
        // COBOL COPY / EXEC SQL INCLUDE names a copybook MEMBER, not a path — the compiler
        // searches a library, so match against indexed file basenames. Runs BEFORE
        // IsExternalImport (a bare member would be misclassified as an external package).
        if (language == CodeGraphLanguage.Cobol)
        {
            return ResolveCobolCopybook(importPath, fromFile, ctx);
        }

        if (IsExternalImport(importPath, language, ctx))
        {
            return null;
        }

        var projectRoot = ctx.GetProjectRoot();
        var fromDir = CodeGraphPosixPath.Dirname(CodeGraphPosixPath.Join(projectRoot, fromFile));

        if (importPath.StartsWith(".", StringComparison.Ordinal))
        {
            return ResolveRelativeImport(importPath, fromDir, language, ctx);
        }

        var aliased = ResolveAliasedImport(importPath, projectRoot, language, ctx);
        if (aliased is not null)
        {
            return aliased;
        }

        // C/C++ include-dir search: neither relative nor aliased matched — probe the -I
        // dirs from compile_commands.json / the heuristic (import-resolver.ts:95).
        if (language == CodeGraphLanguage.C || language == CodeGraphLanguage.Cpp)
        {
            return ResolveCppIncludePath(importPath, language, ctx);
        }

        return null;
    }

    // C/C++ include-path search over the -I dirs (import-resolver.ts:585). Tries each
    // dir × extension, then the path as-is (already-extensioned header).
    private static string? ResolveCppIncludePath(string importPath, string language, CodeGraphResolutionContext ctx)
    {
        var includeDirs = ctx.GetCppIncludeDirs();
        var extensions = Extensions(language);
        foreach (var dir in includeDirs)
        {
            var normalizedDir = dir.Replace('\\', '/');
            foreach (var ext in extensions)
            {
                var candidate = normalizedDir + "/" + importPath + ext;
                if (ctx.FileExists(candidate))
                {
                    return candidate;
                }
            }

            var asIs = normalizedDir + "/" + importPath;
            if (ctx.FileExists(asIs))
            {
                return asIs;
            }
        }

        return null;
    }

    // PHP include/require path -> project-relative file (import-resolver.ts:640). Resolves
    // against the including file's directory; php.ini include_path is not modeled. The
    // literal may omit `.php`.
    private static string? ResolvePhpIncludePath(string includePath, string fromFile, CodeGraphResolutionContext ctx)
    {
        var projectRoot = ctx.GetProjectRoot();
        var fromDir = CodeGraphPosixPath.Dirname(CodeGraphPosixPath.Join(projectRoot, fromFile));
        var basePath = CodeGraphPosixPath.Resolve(fromDir, includePath);
        var relativePath = CodeGraphPosixPath.Relative(projectRoot, basePath).Replace('\\', '/');
        if (ctx.FileExists(relativePath))
        {
            return relativePath;
        }

        foreach (var ext in Extensions(CodeGraphLanguage.Php))
        {
            if (ctx.FileExists(relativePath + ext))
            {
                return relativePath + ext;
            }
        }

        return null;
    }

    // COBOL copybook lookup (import-resolver.ts:112): `COPY CVACT01Y` names a library
    // member resolved against indexed file basenames, case-insensitively. `.cpy` outranks
    // a same-named program; a same-directory hit wins within a tier. The stem index is
    // built once per context (a per-ref scan of every file node would go quadratic).
    private string? ResolveCobolCopybook(string member, string fromFile, CodeGraphResolutionContext ctx)
    {
        var index = GetCobolCopybookIndex(ctx);
        if (!index.TryGetValue(member.ToLowerInvariant(), out var candidates) || candidates.Count == 0)
        {
            return null;
        }

        var fromParts = fromFile.Replace('\\', '/').Split('/');
        var fromDir = fromParts.Length <= 1 ? string.Empty : string.Join('/', fromParts[..^1]);

        string? best = null;
        var bestScore = -1;
        foreach (var candidate in candidates)
        {
            var normalized = candidate.Replace('\\', '/');
            var dotIdx = normalized.LastIndexOf('.');
            var ext = (dotIdx >= 0 ? normalized[dotIdx..] : string.Empty).ToLowerInvariant();
            var score = 0;
            if (ext == ".cpy")
            {
                score += 4;
            }
            else if (ext == ".cbl" || ext == ".cob" || ext == ".cobol")
            {
                score += 2;
            }

            var candParts = normalized.Split('/');
            var candDir = candParts.Length <= 1 ? string.Empty : string.Join('/', candParts[..^1]);
            if (candDir == fromDir)
            {
                score += 1;
            }

            if (score > bestScore)
            {
                bestScore = score;
                best = candidate;
            }
        }

        return best;
    }

    // The per-context lowercased-stem -> file-paths index for COBOL copybook lookup.
    private Dictionary<string, List<string>> GetCobolCopybookIndex(CodeGraphResolutionContext ctx)
    {
        if (cobolCopybookIndexes.TryGetValue(ctx, out var existing))
        {
            return existing;
        }

        var index = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var fileNode in ctx.GetNodesByKind(CodeGraphNodeKind.File))
        {
            var normalized = fileNode.FilePath.Replace('\\', '/');
            var baseName = LastSegment(normalized);
            var dot = baseName.LastIndexOf('.');
            var stem = (dot > 0 ? baseName[..dot] : baseName).ToLowerInvariant();
            if (index.TryGetValue(stem, out var paths))
            {
                paths.Add(fileNode.FilePath);
            }
            else
            {
                index[stem] = new List<string> { fileNode.FilePath };
            }
        }

        cobolCopybookIndexes.Add(ctx, index);
        return index;
    }

    // Is this import external (npm/stdlib/third-party)? Consults workspace + alias maps
    // first so monorepo members and custom prefixes aren't misclassified (import-resolver.ts:198).
    private bool IsExternalImport(string importPath, string language, CodeGraphResolutionContext ctx)
    {
        if (importPath.StartsWith(".", StringComparison.Ordinal))
        {
            return false;
        }

        var workspaces = ctx.GetWorkspacePackages();
        if (workspaces is not null && CodeGraphWorkspaces.ResolveImport(importPath, workspaces) is not null)
        {
            return false;
        }

        if (IsJsFamily(language))
        {
            if (NodeBuiltins.Contains(importPath))
            {
                return true;
            }

            var aliases = ctx.GetProjectAliases();
            if (aliases is not null)
            {
                foreach (var pat in aliases.Patterns)
                {
                    if (importPath.StartsWith(pat.Prefix, StringComparison.Ordinal))
                    {
                        return false;
                    }
                }
            }

            if (!importPath.StartsWith("@/", StringComparison.Ordinal) &&
                !importPath.StartsWith("~/", StringComparison.Ordinal) &&
                !importPath.StartsWith("src/", StringComparison.Ordinal))
            {
                return true;
            }
        }

        if (language == CodeGraphLanguage.Python)
        {
            var first = importPath.Split('.')[0];
            if (PythonStdLibs.Contains(first))
            {
                return true;
            }
        }

        if (language == CodeGraphLanguage.Go)
        {
            if (importPath.StartsWith(".", StringComparison.Ordinal))
            {
                return false;
            }

            var mod = ctx.GetGoModule();
            if (mod is not null && (importPath == mod.ModulePath || importPath.StartsWith(mod.ModulePath + "/", StringComparison.Ordinal)))
            {
                return false;
            }

            if (importPath.Contains("/internal/", StringComparison.Ordinal))
            {
                return false;
            }

            return true;
        }

        if (language == CodeGraphLanguage.C || language == CodeGraphLanguage.Cpp)
        {
            // C/C++ standard-library headers — both C-style (<stdio.h>) and C++-style
            // (<cstdio>, <vector>). The extractor strips the <>/"" delimiters.
            if (CCppStdlibHeaders.Contains(importPath))
            {
                return true;
            }

            // A C++ header may be listed without its `.h` (e.g. "vector", "string").
            var withoutExt = importPath.EndsWith(".h", StringComparison.Ordinal) ? importPath[..^2] : importPath;
            if (CCppStdlibHeaders.Contains(withoutExt))
            {
                return true;
            }
        }

        return false;
    }

    private string? ResolveRelativeImport(string importPath, string fromDir, string language, CodeGraphResolutionContext ctx)
    {
        var projectRoot = ctx.GetProjectRoot();
        var extensions = Extensions(language);

        // Python dotted-relative (`from .certs import x`, `from ..pkg.mod import y`):
        // leading dots are PACKAGE levels; translate to a filesystem-relative path.
        if (language == CodeGraphLanguage.Python && importPath.StartsWith(".", StringComparison.Ordinal))
        {
            var dots = 0;
            while (dots < importPath.Length && importPath[dots] == '.')
            {
                dots++;
            }

            var up = Repeat("../", Math.Max(0, dots - 1)); // 1 dot = current dir
            var rest = importPath[dots..].Replace('.', '/'); // 'sub.mod' -> 'sub/mod'
            var pyBase = CodeGraphPosixPath.Resolve(fromDir, up + rest);
            var pyRel = CodeGraphPosixPath.Relative(projectRoot, pyBase);
            foreach (var ext in extensions)
            {
                if (ctx.FileExists(pyRel + ext))
                {
                    return pyRel + ext;
                }
            }

            if (pyRel.Length > 0 && ctx.FileExists(pyRel))
            {
                return pyRel;
            }

            return null;
        }

        var basePath = CodeGraphPosixPath.Resolve(fromDir, importPath);
        var relativePath = CodeGraphPosixPath.Relative(projectRoot, basePath);
        foreach (var ext in extensions)
        {
            var candidate = relativePath + ext;
            if (ctx.FileExists(candidate))
            {
                return candidate;
            }
        }

        if (ctx.FileExists(relativePath))
        {
            return relativePath;
        }

        return null;
    }

    private string? ResolveAliasedImport(string importPath, string projectRoot, string language, CodeGraphResolutionContext ctx)
    {
        var extensions = Extensions(language);

        string? TryWithExt(string basePath)
        {
            foreach (var ext in extensions)
            {
                var candidate = basePath + ext;
                if (ctx.FileExists(candidate))
                {
                    return candidate;
                }
            }

            return ctx.FileExists(basePath) ? basePath : null;
        }

        // 1. Project tsconfig/jsconfig paths.
        var aliasMap = ctx.GetProjectAliases();
        if (aliasMap is not null)
        {
            foreach (var c in CodeGraphPathAliases.ApplyAliases(importPath, aliasMap, projectRoot))
            {
                var hit = TryWithExt(c);
                if (hit is not null)
                {
                    return hit;
                }
            }
        }

        // 1.5 Workspace packages (`@scope/ui/widgets` → `packages/ui/widgets`).
        var workspaces = ctx.GetWorkspacePackages();
        if (workspaces is not null)
        {
            var baseDir = CodeGraphWorkspaces.ResolveImport(importPath, workspaces);
            if (baseDir is not null)
            {
                var hit = TryWithExt(baseDir);
                if (hit is not null)
                {
                    return hit;
                }
            }
        }

        // 2. Hard-coded fallback list.
        foreach (var (alias, replacement) in FallbackAliases)
        {
            if (importPath.StartsWith(alias, StringComparison.Ordinal))
            {
                var hit = TryWithExt(ReplaceFirst(importPath, alias, replacement));
                if (hit is not null)
                {
                    return hit;
                }
            }
        }

        // 3. Direct path.
        return TryWithExt(importPath);
    }

    // =====================================================================
    // Per-ecosystem cross-package resolution
    // =====================================================================

    // Go cross-package `pkga.FuncX` (import-resolver.ts:1898).
    private CodeGraphResolvedRef? ResolveGoCrossPackageReference(
        CodeGraphUnresolvedReference r, IReadOnlyList<CodeGraphImportMapping> imports, CodeGraphResolutionContext ctx)
    {
        var mod = ctx.GetGoModule();
        if (mod is null)
        {
            return null;
        }

        var dotIdx = r.ReferenceName.IndexOf('.');
        if (dotIdx <= 0)
        {
            return null;
        }

        var receiver = r.ReferenceName[..dotIdx];
        var memberName = r.ReferenceName[(dotIdx + 1)..];
        if (memberName.Length == 0)
        {
            return null;
        }

        foreach (var imp in imports)
        {
            if (imp.LocalName != receiver)
            {
                continue;
            }

            if (imp.Source != mod.ModulePath && !imp.Source.StartsWith(mod.ModulePath + "/", StringComparison.Ordinal))
            {
                continue;
            }

            var pkgDir = imp.Source == mod.ModulePath ? string.Empty : imp.Source[(mod.ModulePath.Length + 1)..];

            foreach (var node in ctx.GetNodesByName(memberName))
            {
                if (node.Language != CodeGraphLanguage.Go || !node.IsExported)
                {
                    continue;
                }

                var fp = node.FilePath.Replace('\\', '/');
                var lastSlash = fp.LastIndexOf('/');
                var fileDir = lastSlash >= 0 ? fp[..lastSlash] : string.Empty;
                if (fileDir == pkgDir)
                {
                    return new CodeGraphResolvedRef(node.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }
        }

        return null;
    }

    // Java/Kotlin imported reference — FQN → file-path suffix (import-resolver.ts:1824).
    private CodeGraphResolvedRef? ResolveJavaImportedReference(
        CodeGraphUnresolvedReference r, IReadOnlyList<CodeGraphImportMapping> imports, CodeGraphResolutionContext ctx)
    {
        if (imports.Count == 0)
        {
            return null;
        }

        var ext = r.Language == CodeGraphLanguage.Kotlin ? ".kt" : ".java";

        foreach (var imp in imports)
        {
            var matchesBare = imp.LocalName == r.ReferenceName;
            var matchesQualified = r.ReferenceName.StartsWith(imp.LocalName + ".", StringComparison.Ordinal);
            if (!matchesBare && !matchesQualified)
            {
                continue;
            }

            var fqnPath = imp.Source.Replace('.', '/') + ext;
            var memberName = matchesBare ? imp.LocalName : r.ReferenceName[(imp.LocalName.Length + 1)..];

            var candidates = ctx.GetNodesByName(memberName);
            foreach (var node in candidates)
            {
                if (node.Language != r.Language)
                {
                    continue;
                }

                var fp = node.FilePath.Replace('\\', '/');
                if (fp.EndsWith(fqnPath, StringComparison.Ordinal) || fp.EndsWith("/" + fqnPath, StringComparison.Ordinal))
                {
                    return new CodeGraphResolvedRef(node.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }

            // `import static com.example.Foo.bar;` — FQN tail is the member, prefix the owner.
            if (matchesBare)
            {
                var dot = imp.Source.LastIndexOf('.');
                if (dot > 0)
                {
                    var ownerFqn = imp.Source[..dot];
                    var ownerPath = ownerFqn.Replace('.', '/') + ext;
                    foreach (var node in candidates)
                    {
                        if (node.Language != r.Language)
                        {
                            continue;
                        }

                        var fp = node.FilePath.Replace('\\', '/');
                        if (fp.EndsWith(ownerPath, StringComparison.Ordinal) || fp.EndsWith("/" + ownerPath, StringComparison.Ordinal))
                        {
                            return new CodeGraphResolvedRef(node.Id, 0.9, CodeGraphResolvedBy.Import);
                        }
                    }
                }
            }
        }

        return null;
    }

    // Python qualified reference whose receiver is an imported MODULE (import-resolver.ts:1480).
    private CodeGraphResolvedRef? ResolvePythonModuleMember(
        CodeGraphUnresolvedReference r, IReadOnlyList<CodeGraphImportMapping> imports, CodeGraphResolutionContext ctx)
    {
        var dotIdx = r.ReferenceName.IndexOf('.');
        if (dotIdx <= 0)
        {
            return null;
        }

        var receiver = r.ReferenceName[..dotIdx];
        var member = r.ReferenceName[(dotIdx + 1)..].Split('.')[0];
        if (member.Length == 0)
        {
            return null;
        }

        var filePath = r.FilePath ?? string.Empty;
        foreach (var imp in imports)
        {
            if (imp.LocalName != receiver)
            {
                continue;
            }

            var modulePath = imp.IsNamespace
                ? imp.Source
                : imp.Source.EndsWith(".", StringComparison.Ordinal) ? imp.Source + imp.LocalName : imp.Source + "." + imp.LocalName;

            var resolvedPath = ResolveImportPath(modulePath, filePath, r.Language ?? CodeGraphLanguage.Python, ctx)
                ?? FindPythonModuleFile(modulePath, ctx, filePath)?.FilePath;
            if (resolvedPath is null || resolvedPath == r.FilePath)
            {
                continue;
            }

            foreach (var n in ctx.GetNodesInFile(resolvedPath))
            {
                if (n.Name == member &&
                    (n.Kind == CodeGraphNodeKind.Function || n.Kind == CodeGraphNodeKind.Class ||
                     n.Kind == CodeGraphNodeKind.Variable || n.Kind == CodeGraphNodeKind.Constant))
                {
                    return new CodeGraphResolvedRef(n.Id, 0.85, CodeGraphResolvedBy.Import);
                }
            }
        }

        return null;
    }

    // Python absolute dotted module import `import a.b.c` (import-resolver.ts:1674).
    private CodeGraphResolvedRef? ResolvePythonAbsoluteModule(CodeGraphUnresolvedReference r, CodeGraphResolutionContext ctx)
    {
        if (r.ReferenceKind != CodeGraphEdgeKind.Imports)
        {
            return null;
        }

        if (!r.ReferenceName.Contains('.'))
        {
            return null;
        }

        var hit = FindPythonModuleFile(r.ReferenceName, ctx, r.FilePath ?? string.Empty);
        return hit is not null ? new CodeGraphResolvedRef(hit.Id, 0.9, CodeGraphResolvedBy.Import) : null;
    }

    // Find the file node for a Python dotted module path `a.b.c` (import-resolver.ts:1650).
    private static CodeGraphNode? FindPythonModuleFile(string mod, CodeGraphResolutionContext ctx, string excludeFilePath)
    {
        if (mod.Length == 0 || mod.StartsWith(".", StringComparison.Ordinal))
        {
            return null;
        }

        var rel = mod.Replace('.', '/');
        var lastSeg = mod.Split('.')[^1];

        foreach (var n in ctx.GetNodesByName(lastSeg + ".py"))
        {
            if (n.Kind == CodeGraphNodeKind.File && n.FilePath != excludeFilePath && PathEndsWith(n.FilePath, rel + ".py"))
            {
                return n;
            }
        }

        foreach (var n in ctx.GetNodesByName("__init__.py"))
        {
            if (n.Kind == CodeGraphNodeKind.File && n.FilePath != excludeFilePath && PathEndsWith(n.FilePath, rel + "/__init__.py"))
            {
                return n;
            }
        }

        return null;
    }

    // Whole-module / namespace import → module file (import-resolver.ts:1589).
    private CodeGraphResolvedRef? ResolveModuleImportToFile(
        CodeGraphUnresolvedReference r, IReadOnlyList<CodeGraphImportMapping> imports, CodeGraphResolutionContext ctx)
    {
        if (r.ReferenceKind != CodeGraphEdgeKind.Imports)
        {
            return null;
        }

        if (r.ReferenceName.Contains('.'))
        {
            return null;
        }

        var filePath = r.FilePath ?? string.Empty;
        foreach (var imp in imports)
        {
            if (imp.LocalName != r.ReferenceName)
            {
                continue;
            }

            string modulePath;
            if (imp.IsNamespace || imp.IsDefault)
            {
                modulePath = imp.Source;
            }
            else if (r.Language == CodeGraphLanguage.Python)
            {
                modulePath = imp.Source.EndsWith(".", StringComparison.Ordinal) ? imp.Source + imp.LocalName : imp.Source + "." + imp.LocalName;
            }
            else
            {
                // A named TS/JS import binds a symbol, not a module.
                continue;
            }

            var resolvedPath = ResolveImportPath(modulePath, filePath, r.Language ?? CodeGraphLanguage.Unknown, ctx);
            if (resolvedPath is not null && resolvedPath != r.FilePath)
            {
                var fileNode = FirstFileNode(ctx.GetNodesInFile(resolvedPath));
                if (fileNode is not null)
                {
                    return new CodeGraphResolvedRef(fileNode.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }

            if (r.Language == CodeGraphLanguage.Python)
            {
                var modFile = FindPythonModuleFile(modulePath, ctx, filePath);
                if (modFile is not null)
                {
                    return new CodeGraphResolvedRef(modFile.Id, 0.9, CodeGraphResolvedBy.Import);
                }
            }
        }

        return null;
    }

    // Rust qualified reference `A::B::C` — map the MODULE prefix (`A::B`) to a file and
    // find the leaf symbol (`C`) in it. Returns null when the prefix isn't a real module
    // path (e.g. `Widget::new` — a struct, not a module), so associated-function calls
    // and enum-variant paths fall through untouched (import-resolver.ts:1764).
    private CodeGraphResolvedRef? ResolveRustPathReference(CodeGraphUnresolvedReference r, CodeGraphResolutionContext ctx)
    {
        var segments = new List<string>();
        foreach (var s in r.ReferenceName.Split("::"))
        {
            if (s.Length > 0)
            {
                segments.Add(s);
            }
        }

        if (segments.Count < 2)
        {
            return null;
        }

        var leaf = segments[^1];
        var modSegs = segments.GetRange(0, segments.Count - 1);

        var file = ResolveRustModuleFile(modSegs, r.FilePath ?? string.Empty, ctx);
        if (file is null || file == r.FilePath)
        {
            return null;
        }

        var target = FirstMatch(ctx.GetNodesInFile(file), n =>
            n.Name == leaf &&
            (n.Kind == CodeGraphNodeKind.Function || n.Kind == CodeGraphNodeKind.Struct ||
             n.Kind == CodeGraphNodeKind.Enum || n.Kind == CodeGraphNodeKind.Trait ||
             n.Kind == CodeGraphNodeKind.TypeAlias || n.Kind == CodeGraphNodeKind.Constant ||
             n.Kind == CodeGraphNodeKind.Method || n.Kind == CodeGraphNodeKind.Class ||
             n.Kind == CodeGraphNodeKind.Interface));
        return target is not null ? new CodeGraphResolvedRef(target.Id, 0.9, CodeGraphResolvedBy.Import) : null;
    }

    // The crate-root directory (holds lib.rs/main.rs), walking up from a file
    // (import-resolver.ts:1796).
    private static string? RustCrateRootDir(string fromFileAbs, CodeGraphResolutionContext ctx)
    {
        var projectRoot = ctx.GetProjectRoot();
        var dir = CodeGraphPosixPath.Dirname(fromFileAbs);
        for (var i = 0; i < 64; i++)
        {
            if (ctx.FileExists(RustToRel(projectRoot, CodeGraphPosixPath.Join(dir, "lib.rs"))) ||
                ctx.FileExists(RustToRel(projectRoot, CodeGraphPosixPath.Join(dir, "main.rs"))))
            {
                return dir;
            }

            var parent = CodeGraphPosixPath.Dirname(dir);
            if (parent == dir)
            {
                return null;
            }

            dir = parent;
        }

        return null;
    }

    // Directory under which the current file's module declares its SUBMODULES
    // (import-resolver.ts:1813). mod.rs / lib.rs / main.rs own their directory;
    // `foo.rs`'s submodules live in `foo/`.
    private static string RustSelfModuleDir(string fromFileAbs)
    {
        var baseName = LastSegment(fromFileAbs);
        var dir = CodeGraphPosixPath.Dirname(fromFileAbs);
        if (baseName == "mod.rs" || baseName == "lib.rs" || baseName == "main.rs")
        {
            return dir;
        }

        var stem = baseName.EndsWith(".rs", StringComparison.Ordinal) ? baseName[..^3] : baseName;
        return CodeGraphPosixPath.Join(dir, stem);
    }

    private static string RustToRel(string projectRoot, string abs) =>
        CodeGraphPosixPath.Relative(projectRoot, abs).Replace('\\', '/');

    // Resolve a Rust module path (segments WITHOUT the leaf symbol) to the file of the
    // last module segment — `crate::a::b` → `<crate>/a/b.rs` (or `.../b/mod.rs`). Anchors
    // on crate/self/super; a bare path in expression position is 2018 `self::`-relative,
    // so try self-relative FIRST, then crate-relative for 2015-edition/crate-root items.
    // External crate paths (`serde::de::Error`) miss both and fall through to
    // name-matching (import-resolver.ts:1826).
    private static string? ResolveRustModuleFile(List<string> segments, string fromFile, CodeGraphResolutionContext ctx)
    {
        if (segments.Count == 0)
        {
            return null;
        }

        var projectRoot = ctx.GetProjectRoot();
        var fromAbs = CodeGraphPosixPath.Join(projectRoot, fromFile);

        // Walk module segments down from startDir, mapping each to `<seg>.rs` or
        // `<seg>/mod.rs`. Null when startDir is null or any segment has no file.
        string? ResolveUnder(string? startDir, IReadOnlyList<string> rest)
        {
            if (startDir is null)
            {
                return null;
            }

            var dir = startDir;
            string? targetFile = null;
            foreach (var seg in rest)
            {
                if (seg == "self" || seg == "crate" || seg == "super")
                {
                    continue;
                }

                var asFile = RustToRel(projectRoot, CodeGraphPosixPath.Join(dir, seg + ".rs"));
                var asMod = RustToRel(projectRoot, CodeGraphPosixPath.Join(dir, seg + "/mod.rs"));
                if (ctx.FileExists(asFile))
                {
                    targetFile = asFile;
                }
                else if (ctx.FileExists(asMod))
                {
                    targetFile = asMod;
                }
                else
                {
                    return null;
                }

                dir = CodeGraphPosixPath.Join(dir, seg);
            }

            return targetFile;
        }

        var first = segments[0];
        if (first == "crate")
        {
            return ResolveUnder(RustCrateRootDir(fromAbs, ctx), segments.GetRange(1, segments.Count - 1));
        }

        if (first == "self")
        {
            return ResolveUnder(RustSelfModuleDir(fromAbs), segments.GetRange(1, segments.Count - 1));
        }

        if (first == "super")
        {
            var supers = 0;
            while (supers < segments.Count && segments[supers] == "super")
            {
                supers++;
            }

            string? dir = RustSelfModuleDir(fromAbs);
            for (var s = 0; s < supers && dir is not null; s++)
            {
                dir = CodeGraphPosixPath.Dirname(dir);
            }

            return ResolveUnder(dir, segments.GetRange(supers, segments.Count - supers));
        }

        return ResolveUnder(RustSelfModuleDir(fromAbs), segments)
            ?? ResolveUnder(RustCrateRootDir(fromAbs, ctx), segments);
    }

    // Lua/Luau `require(...)` → module file. Try `<path>.lua|.luau` and
    // `<path>/init.lua|.luau` as path suffixes (the module root — `lua/`, `src/`, … —
    // is project-specific); among suffix matches, the one sharing the longest prefix
    // with the requiring file wins, so instance-path requires resolve within the same
    // package (import-resolver.ts:1628).
    private static CodeGraphResolvedRef? ResolveLuaRequire(CodeGraphUnresolvedReference r, CodeGraphResolutionContext ctx)
    {
        var name = r.ReferenceName;
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        var baseRel = name.Contains('.') ? name.Replace('.', '/') : name;
        var suffixes = new[] { baseRel + ".lua", baseRel + ".luau", baseRel + "/init.lua", baseRel + "/init.luau" };
        var files = ctx.GetAllFiles();
        var fromPath = r.FilePath ?? string.Empty;

        static int Shared(string a, string b)
        {
            var i = 0;
            while (i < a.Length && i < b.Length && a[i] == b[i])
            {
                i++;
            }

            return i;
        }

        foreach (var suffix in suffixes)
        {
            string? best = null;
            var bestShared = -1;
            foreach (var f in files)
            {
                if (f != suffix && !f.EndsWith("/" + suffix, StringComparison.Ordinal))
                {
                    continue;
                }

                var s = Shared(f, fromPath);
                if (s > bestShared)
                {
                    bestShared = s;
                    best = f;
                }
            }

            if (best is null || best == fromPath)
            {
                continue;
            }

            var fileNode = FirstFileNode(ctx.GetNodesInFile(best));
            if (fileNode is not null)
            {
                // Confidence ≥ 0.9 so this deterministic path/suffix match wins over
                // name-matching (which otherwise self-matches the import node).
                return new CodeGraphResolvedRef(fileNode.Id, 0.9, CodeGraphResolvedBy.Import);
            }
        }

        return null;
    }

    // Find an exported symbol in `filePath`, chasing `export … from './other'` chains
    // until the original declaration is reached (import-resolver.ts:1963).
    private CodeGraphNode? FindExportedSymbol(
        string filePath, bool isDefault, bool isNamespace, string exportedName, string? memberName,
        string language, CodeGraphResolutionContext ctx, HashSet<string> visited, int depth)
    {
        if (depth > ReexportMaxDepth)
        {
            return null;
        }

        if (!visited.Add(filePath))
        {
            return null;
        }

        var nodesInFile = ctx.GetNodesInFile(filePath);

        // 1. Direct hit.
        if (isDefault)
        {
            CodeGraphNode? direct = FirstMatch(nodesInFile, n => n.IsExported && n.Kind == CodeGraphNodeKind.Component)
                ?? FirstMatch(nodesInFile, n => n.IsExported && (n.Kind == CodeGraphNodeKind.Function || n.Kind == CodeGraphNodeKind.Class));
            if (direct is not null)
            {
                return direct;
            }
        }
        else if (isNamespace && memberName is not null)
        {
            var direct = FirstMatch(nodesInFile, n => n.Name == memberName && n.IsExported);
            if (direct is not null)
            {
                return direct;
            }
        }
        else
        {
            var direct = FirstMatch(nodesInFile, n => n.Name == exportedName && n.IsExported);
            if (direct is not null)
            {
                return direct;
            }
        }

        // 2. Re-export hit.
        var reExports = ctx.GetReExports(filePath, language);
        if (reExports.Count == 0)
        {
            return null;
        }

        var targetName = isDefault ? "default" : exportedName;
        foreach (var rex in reExports)
        {
            if (rex.Kind == CodeGraphReExportKind.Named && rex.ExportedName == targetName)
            {
                var next = ResolveImportPath(rex.Source, filePath, language, ctx);
                if (next is null)
                {
                    continue;
                }

                var originalName = rex.OriginalName ?? string.Empty;
                var chained = FindExportedSymbol(
                    next, originalName == "default", false, originalName, null, language, ctx, visited, depth + 1);
                if (chained is not null)
                {
                    return chained;
                }
            }
        }

        // 3. Wildcard re-export.
        foreach (var rex in reExports)
        {
            if (rex.Kind == CodeGraphReExportKind.Wildcard)
            {
                var next = ResolveImportPath(rex.Source, filePath, language, ctx);
                if (next is null)
                {
                    continue;
                }

                var chained = FindExportedSymbol(next, isDefault, isNamespace, exportedName, memberName, language, ctx, visited, depth + 1);
                if (chained is not null)
                {
                    return chained;
                }
            }
        }

        return null;
    }

    // Resolve `Container.member` static access to the member node (import-resolver.ts:2069).
    private CodeGraphNode? ResolveStaticMember(CodeGraphNode container, CodeGraphUnresolvedReference r, string localName, CodeGraphResolutionContext ctx)
    {
        if (!StaticMemberContainers.Contains(container.Kind))
        {
            return null;
        }

        var member = r.ReferenceName[(localName.Length + 1)..].Split('.')[0];
        if (member.Length == 0)
        {
            return null;
        }

        var candidates = new List<CodeGraphNode>();
        foreach (var n in ctx.GetNodesByQualifiedName(container.QualifiedName + "::" + member))
        {
            if (n.FilePath == container.FilePath)
            {
                candidates.Add(n);
            }
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        if (r.ReferenceKind == CodeGraphEdgeKind.Calls)
        {
            var callable = FirstMatch(candidates, n => n.Kind == CodeGraphNodeKind.Method || n.Kind == CodeGraphNodeKind.Function);
            if (callable is not null)
            {
                return callable;
            }
        }

        return candidates[0];
    }

    // Pick the same-FQN candidate closest to `fromPath` by shared directory prefix,
    // preferring a Kotlin `expect` declaration on a tie (import-resolver.ts:1182).
    private static CodeGraphNode PickClosestJvmCandidate(IReadOnlyList<CodeGraphNode> candidates, string fromPath)
    {
        var fromDirs = DirSegments(fromPath);

        int SharedPrefix(string p)
        {
            var d = DirSegments(p);
            var shared = 0;
            var limit = Math.Min(fromDirs.Length, d.Length);
            for (var i = 0; i < limit; i++)
            {
                if (fromDirs[i] == d[i])
                {
                    shared++;
                }
                else
                {
                    break;
                }
            }

            return shared;
        }

        static bool IsExpect(CodeGraphNode n) => n.Decorators is not null && n.Decorators.Contains("expect");

        var best = candidates[0];
        var bestProx = SharedPrefix(best.FilePath);
        for (var i = 1; i < candidates.Count; i++)
        {
            var c = candidates[i];
            var prox = SharedPrefix(c.FilePath);
            if (prox > bestProx || (prox == bestProx && IsExpect(c) && !IsExpect(best)))
            {
                best = c;
                bestProx = prox;
            }
        }

        return best;
    }

    // =====================================================================
    // Per-language import extractors (import-resolver.ts:698, :802, :855, :911)
    // =====================================================================

    private static void ExtractJsImports(string content, List<CodeGraphImportMapping> mappings)
    {
        foreach (Match match in JsImportRegex.Matches(content))
        {
            var defaultImport = match.Groups[1];
            var namedImports = match.Groups[2];
            var star = match.Groups[3];
            var namespaceAlias = match.Groups[4];
            var source = match.Groups[5].Value;

            if (defaultImport.Success && defaultImport.Value.Length > 0)
            {
                mappings.Add(new CodeGraphImportMapping(defaultImport.Value, "default", source, true, false));
            }

            if (namedImports.Success && namedImports.Value.Length > 0)
            {
                foreach (var raw in namedImports.Value.Split(','))
                {
                    var name = raw.Trim();
                    if (name.Length == 0)
                    {
                        continue;
                    }

                    var aliasMatch = JsNamedAliasRegex.Match(name);
                    if (aliasMatch.Success)
                    {
                        mappings.Add(new CodeGraphImportMapping(aliasMatch.Groups[2].Value, aliasMatch.Groups[1].Value, source, false, false));
                    }
                    else
                    {
                        mappings.Add(new CodeGraphImportMapping(name, name, source, false, false));
                    }
                }
            }

            if (star.Success && namespaceAlias.Success && namespaceAlias.Value.Length > 0)
            {
                mappings.Add(new CodeGraphImportMapping(namespaceAlias.Value, "*", source, false, true));
            }
        }

        foreach (Match match in JsRequireRegex.Matches(content))
        {
            var defaultName = match.Groups[1];
            var destructured = match.Groups[2];
            var source = match.Groups[3].Value;

            if (defaultName.Success && defaultName.Value.Length > 0)
            {
                mappings.Add(new CodeGraphImportMapping(defaultName.Value, "default", source, true, false));
            }

            if (destructured.Success && destructured.Value.Length > 0)
            {
                foreach (var raw in destructured.Value.Split(','))
                {
                    var name = raw.Trim();
                    if (name.Length == 0)
                    {
                        continue;
                    }

                    var aliasMatch = JsDestructureAliasRegex.Match(name);
                    if (aliasMatch.Success)
                    {
                        mappings.Add(new CodeGraphImportMapping(aliasMatch.Groups[2].Value, aliasMatch.Groups[1].Value, source, false, false));
                    }
                    else
                    {
                        mappings.Add(new CodeGraphImportMapping(name, name, source, false, false));
                    }
                }
            }
        }
    }

    private static void ExtractPythonImports(string content, List<CodeGraphImportMapping> mappings)
    {
        foreach (Match match in PyFromImportRegex.Matches(content))
        {
            var source = match.Groups[1].Value;
            var imports = match.Groups[2].Value;
            foreach (var raw in imports.Split(','))
            {
                var name = raw.Trim();
                var aliasMatch = PyAliasRegex.Match(name);
                if (aliasMatch.Success)
                {
                    mappings.Add(new CodeGraphImportMapping(aliasMatch.Groups[2].Value, aliasMatch.Groups[1].Value, source, false, false));
                }
                else if (name.Length > 0 && name != "*")
                {
                    mappings.Add(new CodeGraphImportMapping(name, name, source, false, false));
                }
            }
        }

        foreach (Match match in PyImportRegex.Matches(content))
        {
            var source = match.Groups[1].Value;
            var alias = match.Groups[2];
            var localName = alias.Success && alias.Value.Length > 0 ? alias.Value : source.Split('.')[^1];
            mappings.Add(new CodeGraphImportMapping(localName, "*", source, false, true));
        }
    }

    private static void ExtractGoImports(string content, List<CodeGraphImportMapping> mappings)
    {
        foreach (Match match in GoSingleImportRegex.Matches(content))
        {
            var alias = match.Groups[1];
            var source = match.Groups[2].Value;
            var packageName = source.Split('/')[^1];
            var localName = alias.Success && alias.Value.Length > 0 ? alias.Value : packageName;
            mappings.Add(new CodeGraphImportMapping(localName, "*", source, false, true));
        }

        foreach (Match blockMatch in GoBlockImportRegex.Matches(content))
        {
            var block = blockMatch.Groups[1].Value;
            foreach (Match lineMatch in GoBlockLineRegex.Matches(block))
            {
                var alias = lineMatch.Groups[1];
                var source = lineMatch.Groups[2].Value;
                var packageName = source.Split('/')[^1];
                var localName = alias.Success && alias.Value.Length > 0 ? alias.Value : packageName;
                mappings.Add(new CodeGraphImportMapping(localName, "*", source, false, true));
            }
        }
    }

    private static void ExtractJavaImports(string content, List<CodeGraphImportMapping> mappings)
    {
        // Strip line and block comments so `// import foo;` doesn't false-match.
        var stripped = JavaBlockComment.Replace(content, string.Empty);
        stripped = JavaLineComment.Replace(stripped, string.Empty);

        foreach (Match match in JavaImportRegex.Matches(stripped))
        {
            var fqn = match.Groups[2].Value;
            // `import com.example.*;` — wildcard; punt to name-matching.
            if (fqn.EndsWith(".*", StringComparison.Ordinal))
            {
                continue;
            }

            var parts = fqn.Split('.');
            var localName = parts[^1];
            if (localName.Length == 0)
            {
                continue;
            }

            mappings.Add(new CodeGraphImportMapping(localName, localName, fqn, false, false));
        }
    }

    // PHP `use Namespace\Class;` / `use Namespace\Class as Alias;` extraction
    // (import-resolver.ts:1010).
    private static void ExtractPhpImports(string content, List<CodeGraphImportMapping> mappings)
    {
        foreach (Match match in PhpUseRegex.Matches(content))
        {
            var fullPath = match.Groups[1].Value;
            var alias = match.Groups[2];
            var className = fullPath.Split('\\')[^1];
            if (className.Length == 0)
            {
                continue;
            }

            mappings.Add(new CodeGraphImportMapping(
                alias.Success && alias.Value.Length > 0 ? alias.Value : className,
                className, fullPath, false, false));
        }
    }

    // C/C++ `#include` extraction (import-resolver.ts:974). Each include is a namespace
    // import (a header brings all its symbols into scope): exportedName '*', isNamespace
    // true. localName is the header basename without extension, so a `MyClass` reference
    // can match whichever include might provide it.
    private static void ExtractCppImports(string content, List<CodeGraphImportMapping> mappings)
    {
        foreach (Match match in CppIncludeRegex.Matches(content))
        {
            var modulePath = match.Groups[1].Value;
            var baseWithExt = LastSegment(modulePath);
            var basename = CppHeaderExtRegex.Replace(baseWithExt, string.Empty);
            mappings.Add(new CodeGraphImportMapping(
                basename.Length > 0 ? basename : modulePath, "*", modulePath, false, true));
        }
    }

    // Strip JS line + block comments while preserving string literals (import-resolver.ts:1020).
    private static string StripJsComments(string content)
    {
        var sb = new StringBuilder(content.Length);
        var i = 0;
        var n = content.Length;
        char? str = null;
        while (i < n)
        {
            var ch = content[i];
            if (str is not null)
            {
                sb.Append(ch);
                if (ch == '\\' && i + 1 < n)
                {
                    sb.Append(content[i + 1]);
                    i += 2;
                    continue;
                }

                if (ch == str)
                {
                    str = null;
                }

                i++;
                continue;
            }

            if (ch == '"' || ch == '\'' || ch == '`')
            {
                str = ch;
                sb.Append(ch);
                i++;
                continue;
            }

            if (ch == '/' && i + 1 < n && content[i + 1] == '/')
            {
                while (i < n && content[i] != '\n')
                {
                    i++;
                }

                continue;
            }

            if (ch == '/' && i + 1 < n && content[i + 1] == '*')
            {
                i += 2;
                while (i < n && !(content[i] == '*' && i + 1 < n && content[i + 1] == '/'))
                {
                    i++;
                }

                i += 2;
                continue;
            }

            sb.Append(ch);
            i++;
        }

        return sb.ToString();
    }

    // =====================================================================
    // Small helpers
    // =====================================================================

    private static bool IsJsFamily(string language) =>
        language == CodeGraphLanguage.TypeScript || language == CodeGraphLanguage.JavaScript ||
        language == CodeGraphLanguage.Tsx || language == CodeGraphLanguage.Jsx || language == CodeGraphLanguage.ArkTs;

    private static string[] Extensions(string language) =>
        ExtensionResolution.TryGetValue(language, out var exts) ? exts : Array.Empty<string>();

    // p === want || p.endsWith('/' + want)
    private static bool PathEndsWith(string p, string want) =>
        p == want || p.EndsWith("/" + want, StringComparison.Ordinal);

    // path.split('/').slice(0, -1) — directory segments minus the trailing filename.
    private static string[] DirSegments(string path)
    {
        var parts = path.Split('/');
        return parts.Length <= 1 ? Array.Empty<string>() : parts[..^1];
    }

    private static CodeGraphNode? FirstFileNode(IReadOnlyList<CodeGraphNode> nodes)
    {
        foreach (var n in nodes)
        {
            if (n.Kind == CodeGraphNodeKind.File)
            {
                return n;
            }
        }

        return null;
    }

    // The `basename`-named FILE node whose path is exactly `filePath` — the file→file
    // module-edge target (getNodesByName(base).find(n => kind==='file' && filePath===...)).
    private static CodeGraphNode? FindFileNode(string basename, string filePath, CodeGraphResolutionContext ctx)
    {
        foreach (var n in ctx.GetNodesByName(basename))
        {
            if (n.Kind == CodeGraphNodeKind.File && n.FilePath == filePath)
            {
                return n;
            }
        }

        return null;
    }

    // Last '/'-separated segment (the basename), or the whole string when there's no slash.
    private static string LastSegment(string path)
    {
        var idx = path.LastIndexOf('/');
        return idx >= 0 ? path[(idx + 1)..] : path;
    }

    private static CodeGraphNode? FirstMatch(IReadOnlyList<CodeGraphNode> nodes, Func<CodeGraphNode, bool> predicate)
    {
        foreach (var n in nodes)
        {
            if (predicate(n))
            {
                return n;
            }
        }

        return null;
    }

    private static string Repeat(string value, int count)
    {
        if (count <= 0)
        {
            return string.Empty;
        }

        var sb = new StringBuilder(value.Length * count);
        for (var i = 0; i < count; i++)
        {
            sb.Append(value);
        }

        return sb.ToString();
    }

    // JS String.prototype.replace(string, string) — first occurrence only.
    private static string ReplaceFirst(string value, string search, string replacement)
    {
        var idx = value.IndexOf(search, StringComparison.Ordinal);
        return idx < 0 ? value : value[..idx] + replacement + value[(idx + search.Length)..];
    }
}
