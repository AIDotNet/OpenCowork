// =============================================================================
// ICodeGraphFileScanner — the file-discovery contract the CodeGraphEngine facade
// depends on, IMPLEMENTED by the scanning slice (analysis/05 §2.5 / §6.4).
//
// The scanner is the port of extraction/index.ts's scanDirectory: the git-fast-path
// `git ls-files` enumeration (+ FS-walk fallback), ScopeIgnore (defaults + nested
// .gitignore + include/exclude/includeIgnored), and embedded-repo/gitlink recursion.
// The facade defines only the SHAPE so it compiles and runs today against the trivial
// NoopFileScanner; the real DirectoryScanner is wired in by the scanning slice.
//
// Contract:
//   * `root` is the OS-native absolute project root (what the engine holds).
//   * Returned CodeGraphScannedFile.Path is a PROJECT-ROOT-RELATIVE POSIX path (the
//     stored graph-path form: forward slashes, no leading `./`) — the same string
//     that lands in nodes.file_path / files.path.
//   * Bytes is optional: a scanner that already read a file (e.g. from `git
//     show`/an in-memory overlay) may supply them; otherwise it leaves Bytes null and
//     the engine reads the file itself via CodeGraphPathSafety.ValidatePathWithinRoot.
// =============================================================================
internal interface ICodeGraphFileScanner
{
    // Enumerate the indexable files under `root`, honoring `config`
    // (extensions/include/exclude/includeIgnored). Pure discovery — no parsing.
    IReadOnlyList<CodeGraphScannedFile> EnumerateFiles(string root, CodeGraphProjectConfig config);
}

// One discovered file: its project-relative posix path, and optionally its already-read
// UTF-8 bytes (null ⇒ the engine reads it from disk). A record so the scanner slice
// can build them cheaply.
internal sealed record CodeGraphScannedFile(string Path, byte[]? Bytes = null);

// The trivial default so the facade compiles and runs before the scanning slice lands:
// it discovers nothing, so an IndexAll with it is a well-formed no-op (zero files
// indexed) rather than a crash. Replaced by the real DirectoryScanner via
// CodeGraphEngine.Open(scanner: …).
internal sealed class CodeGraphNoopFileScanner : ICodeGraphFileScanner
{
    public static readonly CodeGraphNoopFileScanner Instance = new();

    private CodeGraphNoopFileScanner()
    {
    }

    public IReadOnlyList<CodeGraphScannedFile> EnumerateFiles(string root, CodeGraphProjectConfig config) =>
        Array.Empty<CodeGraphScannedFile>();
}
