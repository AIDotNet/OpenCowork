using System.Text;
using System.Text.Json;
using Xunit;

// =============================================================================
// M5 tool-surface integration (WS-B). Exercises CodeGraphToolHandler END-TO-END,
// in-process (not through the socket): the envelope behavior that does not need a
// grammar (not_indexed success-shaped guidance, path_refusal hard error, the default
// tools-list surface) runs always; the indexed explore/search/status path opens a
// temp project with real TS source, indexes it through the facade, and asserts the
// tool handlers return well-formed results (explore of "greet" surfaces the symbol).
//
// Gated on the TypeScript grammar (self-skips otherwise, like the other real-parse
// tiers) so a host without the native dylibs still runs the envelope assertions.
// CODEGRAPH_HOME is redirected to a throwaway dir so the centralized graph DB never
// lands in the developer's real ~/.open-cowork/.
// =============================================================================
[Collection("CodeGraphHomeEnv")]
public sealed class ToolSurfaceTests
{
    private const string UtilTs =
        "export function greet(name: string): string {\n" +
        "  return 'hi ' + name\n" +
        "}\n";

    private const string MainTs =
        "import { greet } from './util'\n" +
        "\n" +
        "export function run(): string {\n" +
        "  return greet('world')\n" +
        "}\n";

    [Fact]
    public async Task ToolHandler_Envelopes_And_IndexedQueries_AreWellFormed()
    {
        // --- Envelope behavior (no grammar required) ----------------------------

        // The default agent surface is codegraph_explore ALONE, read-only annotated.
        var toolsList = CodeGraphToolDefs.ListDefault();
        Assert.True(toolsList.Success);
        Assert.Single(toolsList.Tools);
        Assert.Equal("codegraph_explore", toolsList.Tools[0].Name);
        Assert.True(toolsList.Tools[0].Annotations.ReadOnlyHint);
        Assert.False(toolsList.Tools[0].Annotations.DestructiveHint);

        // The full source-gen wire path (camelCase, nested inputSchema, the properties
        // dictionary, the enum member) — this is what actually crosses the socket.
        var allJson = JsonSerializer.Serialize(
            new CodeGraphToolsListResult(true, CodeGraphToolDefs.All()),
            CodeGraphJsonContext.Default.CodeGraphToolsListResult);
        Assert.Contains("codegraph_search", allJson, StringComparison.Ordinal);
        Assert.Contains("\"readOnlyHint\":true", allJson, StringComparison.Ordinal);
        Assert.Contains("\"inputSchema\"", allJson, StringComparison.Ordinal);
        Assert.Contains("\"enum\"", allJson, StringComparison.Ordinal);

        // A never-indexed root now AUTO-INDEXES on first use (index-on-first-use,
        // reference/04 §5). An empty dir indexes instantly, so the query proceeds and
        // returns a real success-shaped result (no matches; never isError).
        var neverIndexed = Path.Combine(Path.GetTempPath(), "codegraph-unindexed-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(neverIndexed);
        var notIndexed = CodeGraphToolHandler.Search(Args(("workingFolder", neverIndexed), ("query", "greet")));
        Assert.True(notIndexed.Success);
        Assert.False(notIndexed.IsError);
        Assert.True(
            notIndexed.ErrorKind is null || notIndexed.ErrorKind == CodeGraphErrorKind.NotIndexed,
            $"unexpected errorKind: {notIndexed.ErrorKind}");

        // no working folder at all -> also not_indexed (no default project).
        var noRoot = CodeGraphToolHandler.Search(Args(("query", "greet")));
        Assert.True(noRoot.Success);
        Assert.Equal(CodeGraphErrorKind.NotIndexed, noRoot.ErrorKind);

        // path_refusal -> HARD (isError), on a sensitive root (the user's home dir).
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(home))
        {
            var refused = CodeGraphToolHandler.Search(Args(("workingFolder", home), ("query", "greet")));
            Assert.False(refused.Success);
            Assert.True(refused.IsError);
            Assert.Equal(CodeGraphErrorKind.PathRefusal, refused.ErrorKind);
        }

        // --- Indexed queries (grammar-gated) ------------------------------------

        // Self-skip when the native TS grammar is absent — extraction would be a no-op.
        if (CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.TypeScript) is null)
        {
            return;
        }

        var root = Path.Combine(Path.GetTempPath(), "codegraph-tools-" + Guid.NewGuid().ToString("N"));
        var codegraphHome = Path.Combine(Path.GetTempPath(), "codegraph-home-" + Guid.NewGuid().ToString("N"));
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", codegraphHome);

        try
        {
            Directory.CreateDirectory(Path.Combine(root, "src"));
            File.WriteAllText(Path.Combine(root, "src", "util.ts"), UtilTs);
            File.WriteAllText(Path.Combine(root, "src", "main.ts"), MainTs);

            // Index through the facade (the proven path), then close so the tool handler
            // opens its own connection on the same centralized DB.
            using (var engine = CodeGraphEngine.Init(
                       root,
                       scanner: new RecursiveSourceFileScanner(),
                       extractors: CodeGraphExtractionHarness.BuildExtractors(),
                       grammars: CodeGraphExtractionHarness.Grammars))
            {
                var indexResult = await engine.IndexAll();
                Assert.Equal(2, indexResult.FilesIndexed);
                Assert.Equal("complete", engine.GetIndexState());
            }

            // explore of "greet" -> success-shaped markdown that names the symbol.
            var explore = CodeGraphToolHandler.Explore(Args(("workingFolder", root), ("query", "greet")));
            Assert.True(explore.Success);
            Assert.False(explore.IsError);
            Assert.Null(explore.ErrorKind);
            Assert.Contains("greet", explore.Text, StringComparison.Ordinal);

            // search of "greet" -> the symbol location.
            var search = CodeGraphToolHandler.Search(Args(("workingFolder", root), ("query", "greet")));
            Assert.True(search.Success);
            Assert.False(search.IsError);
            Assert.Contains("greet", search.Text, StringComparison.Ordinal);
            Assert.Contains("util.ts", search.Text, StringComparison.Ordinal);

            // status -> markdown health block reflecting the write.
            var status = CodeGraphToolHandler.Status(Args(("workingFolder", root)));
            Assert.True(status.Success);
            Assert.False(status.IsError);
            Assert.Contains("CodeGraph Status", status.Text, StringComparison.Ordinal);
            Assert.Contains("Index state: complete", status.Text, StringComparison.Ordinal);
            Assert.Contains("Files: 2", status.Text, StringComparison.Ordinal);
        }
        finally
        {
            CodeGraphToolHandler.ResetForTests();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(root);
            CodeGraphTestSupport.DeleteDir(codegraphHome);
        }
    }

    // Build a JsonElement args object from string key/value pairs (the wire shape the
    // handlers read via JsonHelpers). Clone() detaches it from the parsed document.
    private static JsonElement Args(params (string Key, string Value)[] pairs)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var (key, value) in pairs)
            {
                writer.WriteString(key, value);
            }

            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(Encoding.UTF8.GetString(stream.ToArray()));
        return document.RootElement.Clone();
    }

    // Minimal recursive source-file scanner (mirrors the FacadeContextSearchTests
    // stand-in): project-root-relative POSIX paths for source files, node_modules/.git
    // skipped. Bytes null => the engine reads the file itself.
    private sealed class RecursiveSourceFileScanner : ICodeGraphFileScanner
    {
        private static readonly HashSet<string> IgnoredDirs =
            new(StringComparer.Ordinal) { "node_modules", ".git", "dist", "out" };

        public IReadOnlyList<CodeGraphScannedFile> EnumerateFiles(string root, CodeGraphProjectConfig config)
        {
            var files = new List<CodeGraphScannedFile>();
            Walk(root, root, files);
            return files;
        }

        private static void Walk(string root, string dir, List<CodeGraphScannedFile> files)
        {
            foreach (var sub in Directory.EnumerateDirectories(dir))
            {
                if (!IgnoredDirs.Contains(Path.GetFileName(sub)))
                {
                    Walk(root, sub, files);
                }
            }

            foreach (var file in Directory.EnumerateFiles(dir))
            {
                var rel = Path.GetRelativePath(root, file).Replace('\\', '/');
                if (CodeGraphLanguageMap.IsSourceFile(rel))
                {
                    files.Add(new CodeGraphScannedFile(rel));
                }
            }
        }
    }
}
