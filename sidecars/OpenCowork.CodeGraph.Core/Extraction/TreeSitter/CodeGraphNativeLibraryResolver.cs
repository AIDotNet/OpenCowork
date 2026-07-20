using System.Reflection;
using System.Runtime.InteropServices;

// Resolves the native tree-sitter libraries (libtree-sitter + the per-language
// grammars) from a configured directory. Packaged builds keep them in a grammars
// directory beside the worker; downloaded updates and dev builds can override it.
//
// The host points us at the grammar dir via OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR
// (see the app's codegraph-assets). Install() must run once, before any parse.
// A missing lib still falls back to default resolution (so a lib placed next to the
// binary keeps working), and a missing grammar disables only that language.
internal static class CodeGraphNativeLibraryResolver
{
    private static int _installed;

    public static void Install()
    {
        if (Interlocked.Exchange(ref _installed, 1) != 0) return;
        NativeLibrary.SetDllImportResolver(typeof(CodeGraphTsBindings).Assembly, Resolve);
    }

    private static nint Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        // Only intercept the tree-sitter family; everything else uses default resolution.
        if (!libraryName.StartsWith("tree-sitter", StringComparison.OrdinalIgnoreCase) &&
            !libraryName.StartsWith("libtree-sitter", StringComparison.OrdinalIgnoreCase))
        {
            return nint.Zero;
        }

        foreach (string dir in ProbeDirs())
        {
            foreach (string fileName in CandidateFileNames(libraryName))
            {
                string full = Path.Combine(dir, fileName);
                if (File.Exists(full) && NativeLibrary.TryLoad(full, out nint handle))
                {
                    return handle;
                }
            }
        }

        return nint.Zero; // fall back to the default loader
    }

    private static IEnumerable<string> ProbeDirs()
    {
        string? envDir = Environment.GetEnvironmentVariable("OPEN_COWORK_CODEGRAPH_GRAMMARS_DIR");
        if (!string.IsNullOrWhiteSpace(envDir))
        {
            yield return envDir;
        }

        string baseDir = AppContext.BaseDirectory;
        if (!string.IsNullOrEmpty(baseDir))
        {
            yield return Path.Combine(baseDir, "grammars");
            yield return baseDir;
        }
    }

    private static IEnumerable<string> CandidateFileNames(string libraryName)
    {
        // The [LibraryImport] name is the base ("tree-sitter", "tree-sitter-typescript").
        string bare = libraryName.StartsWith("lib", StringComparison.OrdinalIgnoreCase)
            ? libraryName[3..]
            : libraryName;

        if (OperatingSystem.IsMacOS())
        {
            yield return "lib" + bare + ".dylib";
            yield return bare + ".dylib";
        }
        else if (OperatingSystem.IsWindows())
        {
            yield return bare + ".dll";
            yield return "lib" + bare + ".dll";
        }
        else
        {
            yield return "lib" + bare + ".so";
            yield return bare + ".so";
        }
    }
}
