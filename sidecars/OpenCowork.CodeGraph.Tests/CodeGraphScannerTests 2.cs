using System.Diagnostics;
using System.Text;
using Xunit;

// =============================================================================
// Scanner end-to-end tests (WS-B) — the CodeGraphDirectoryScanner slice itself, over
// a real temp tree. The matcher/scope/defaults contract is pinned separately by
// ScanningTests.cs (the TDD oracle); these exercise what only the scanner owns:
//
//   * FS-walk discovery + nested `.gitignore` + default-ignore selection,
//   * byte reading with the >1 MB skip (MAX_FILE_SIZE),
//   * the custom-extension classifier surface,
//   * the git fast path (skipped when git is not on PATH).
//
// The `.gitignore`/default-ignore assertions hold whether the git fast path or the FS
// walk runs (both honor the same rules), so the first two are robust to the host temp
// dir happening to sit inside a git repo.
// =============================================================================

public sealed class CodeGraphFileClassifierTests
{
    private static readonly CodeGraphProjectConfig Empty = CodeGraphProjectConfig.Empty;

    [Fact]
    public void IsSourceFile_ByExtension()
    {
        Assert.True(CodeGraphFileClassifier.IsSourceFile("src/a.ts", Empty));
        Assert.True(CodeGraphFileClassifier.IsSourceFile("main.go", Empty));
        Assert.False(CodeGraphFileClassifier.IsSourceFile("README.txt", Empty));
        Assert.False(CodeGraphFileClassifier.IsSourceFile("noext", Empty));
    }

    [Fact]
    public void IsSourceFile_HonorsCustomExtensionOverrides()
    {
        var config = new CodeGraphProjectConfig(
            new Dictionary<string, string> { [".foo"] = CodeGraphLanguage.TypeScript },
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<string>());
        Assert.True(CodeGraphFileClassifier.IsSourceFile("x.foo", config));
        Assert.False(CodeGraphFileClassifier.IsSourceFile("x.foo", Empty));
    }

    [Fact]
    public void IsGenerated_And_IsTest()
    {
        Assert.True(CodeGraphFileClassifier.IsGenerated("api.pb.go"));
        Assert.False(CodeGraphFileClassifier.IsGenerated("api.go"));

        Assert.True(CodeGraphFileClassifier.IsTest("foo.test.ts"));
        Assert.True(CodeGraphFileClassifier.IsTest("src/__tests__/foo.ts"));
        Assert.False(CodeGraphFileClassifier.IsTest("src/foo.ts"));
    }
}

public sealed class CodeGraphDirectoryScannerTests
{
    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "codegraph-scan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static void Write(string root, string relPath, string content)
    {
        var abs = Path.Combine(root, relPath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
        File.WriteAllText(abs, content);
    }

    private static HashSet<string> ScanPaths(string root)
    {
        var scanned = CodeGraphDirectoryScanner.Instance.EnumerateFiles(root, CodeGraphProjectConfig.Load(root));
        return new HashSet<string>(scanned.Select(f => f.Path), StringComparer.Ordinal);
    }

    [Fact]
    public void Scan_FindsSource_ExcludesDefaultsAndGitignored()
    {
        var root = NewTempDir();
        try
        {
            Write(root, "src/index.ts", "export const x = 1\n");
            Write(root, "src/util.ts", "export const y = 2\n");
            Write(root, "node_modules/pkg/index.js", "module.exports = {}\n");
            Write(root, "dist/bundle.js", "//built\n");
            Write(root, "README.txt", "not source\n");
            Write(root, "secret.ts", "export const s = 'shh'\n");
            Write(root, ".gitignore", "secret.ts\n");
            // A nested .gitignore hides a subdir's own file.
            Write(root, "pkg/keep.ts", "export const k = 1\n");
            Write(root, "pkg/skip.ts", "export const s = 1\n");
            Write(root, "pkg/.gitignore", "skip.ts\n");

            var paths = ScanPaths(root);

            Assert.Contains("src/index.ts", paths);
            Assert.Contains("src/util.ts", paths);
            Assert.Contains("pkg/keep.ts", paths);
            Assert.DoesNotContain("node_modules/pkg/index.js", paths);
            Assert.DoesNotContain("dist/bundle.js", paths);
            Assert.DoesNotContain("README.txt", paths);   // not a source extension
            Assert.DoesNotContain("secret.ts", paths);     // root .gitignore
            Assert.DoesNotContain("pkg/skip.ts", paths);   // nested .gitignore
        }
        finally
        {
            CodeGraphTestSupport.DeleteDir(root);
        }
    }

    [Fact]
    public void Scan_ReadsBytes_AndSkipsFilesOverOneMegabyte()
    {
        var root = NewTempDir();
        try
        {
            Write(root, "small.ts", "export const x = 1\n");
            Write(root, "big.ts", new string('a', 1024 * 1024 + 16)); // >1 MB → skipped

            var scanned = CodeGraphDirectoryScanner.Instance.EnumerateFiles(root, CodeGraphProjectConfig.Load(root));
            var byPath = scanned.ToDictionary(f => f.Path, f => f.Bytes, StringComparer.Ordinal);

            Assert.True(byPath.ContainsKey("small.ts"));
            Assert.NotNull(byPath["small.ts"]);
            Assert.Equal("export const x = 1\n", Encoding.UTF8.GetString(byPath["small.ts"]!));
            Assert.False(byPath.ContainsKey("big.ts"));
        }
        finally
        {
            CodeGraphTestSupport.DeleteDir(root);
        }
    }

    [Fact]
    public void Scan_GitFastPath_RespectsGitignore()
    {
        if (!GitAvailable())
        {
            return; // git not on PATH — the FS-walk tests cover discovery
        }

        var root = NewTempDir();
        try
        {
            Git(root, "init");
            Write(root, "src/a.ts", "export const a = 1\n");
            Write(root, "src/b.ts", "export const b = 2\n");
            Write(root, "node_modules/dep/index.js", "x\n");
            Write(root, "ignored.ts", "export const i = 1\n");
            Write(root, ".gitignore", "ignored.ts\n");
            // Stage one file so the tracked (`ls-files -s`) branch also runs; the rest
            // stay untracked. Neither add nor ls-files needs a commit or user config.
            Git(root, "add", "src/a.ts");

            var paths = ScanPaths(root);

            Assert.Contains("src/a.ts", paths); // tracked
            Assert.Contains("src/b.ts", paths); // untracked, not ignored
            Assert.DoesNotContain("node_modules/dep/index.js", paths); // default-ignored
            Assert.DoesNotContain("ignored.ts", paths);                // .gitignore
        }
        finally
        {
            CodeGraphTestSupport.DeleteDir(root);
        }
    }

    private static bool GitAvailable()
    {
        try
        {
            return RunProcess("git", Path.GetTempPath(), "--version");
        }
        catch
        {
            return false;
        }
    }

    private static void Git(string cwd, params string[] args) => RunProcess("git", cwd, args);

    private static bool RunProcess(string file, string cwd, params string[] args)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = file,
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var arg in args)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

        try
        {
            process.Start();
        }
        catch
        {
            return false;
        }

        process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        process.WaitForExit(30_000);
        return process.HasExited && process.ExitCode == 0;
    }
}
