using Xunit;

// =============================================================================
// M7 niche framework/synthesizer wiring goldens. These exercise the regex-only
// (grammar-free) surface of the niche resolvers/synthesizers plus the catalog
// registration, so they run on RAW text with no tree-sitter grammar present.
// =============================================================================
public sealed class CodeGraphNicheFrameworkWiringTests
{
    // Minimal in-memory context: only GetAllFiles / ReadFile matter for the Detect
    // paths under test; the rest return empty defaults (mirrors the Play test's fake).
    private sealed class FakeContext(IReadOnlyList<string> files, IReadOnlyDictionary<string, string> contents)
        : CodeGraphResolutionContext
    {
        public override IReadOnlyList<CodeGraphNode> GetNodesInFile(string filePath) => Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByName(string name) => Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByQualifiedName(string qualifiedName) => Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByKind(string kind) => Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByLowerName(string lowerName) => Array.Empty<CodeGraphNode>();

        public override bool FileExists(string filePath) => contents.ContainsKey(filePath);

        public override string? ReadFile(string filePath) => contents.TryGetValue(filePath, out string? c) ? c : null;

        public override string GetProjectRoot() => "/tmp/proj";

        public override IReadOnlyList<string> GetAllFiles() => files;

        public override IReadOnlyList<CodeGraphImportMapping> GetImportMappings(string filePath, string language) =>
            Array.Empty<CodeGraphImportMapping>();
    }

    // --- SwiftUI resolver: Detect() true on raw `import SwiftUI` source ---
    [Fact]
    public void SwiftUiResolver_Detect_TrueForImportSwiftUiSource()
    {
        const string swift =
            "import SwiftUI\n" +
            "\n" +
            "struct ContentView: View {\n" +
            "    var body: some View { Text(\"hi\") }\n" +
            "}\n";
        var ctx = new FakeContext(
            new[] { "Sources/ContentView.swift" },
            new Dictionary<string, string> { ["Sources/ContentView.swift"] = swift });

        Assert.True(new CodeGraphSwiftUiResolver().Detect(ctx));
    }

    // --- SwiftUI resolver: Extract() over raw text -> Component + @main App nodes ---
    [Fact]
    public void SwiftUiResolver_Extract_EmitsViewComponentAndAppEntryNodes()
    {
        var resolver = new CodeGraphSwiftUiResolver();
        const string swift =
            "import SwiftUI\n" +
            "\n" +
            "@main struct MyApp: App {\n" +
            "    var body: some Scene { WindowGroup { ContentView() } }\n" +
            "}\n" +
            "\n" +
            "struct ContentView: View {\n" +
            "    var body: some View { Text(\"hi\") }\n" +
            "}\n";

        CodeGraphFrameworkExtraction? ex = resolver.Extract("Sources/MyApp.swift", swift);

        Assert.NotNull(ex);
        Assert.Contains(ex!.Nodes, n => n.Kind == CodeGraphNodeKind.Component && n.Name == "ContentView" && n.Language == CodeGraphLanguage.Swift);
        Assert.Contains(ex.Nodes, n => n.Kind == CodeGraphNodeKind.Class && n.Name == "MyApp");
    }

    // --- Terraform resolver: Detect() true when a `.tf` file is present ---
    [Fact]
    public void TerraformResolver_Detect_TrueForTfFile()
    {
        const string tf =
            "resource \"aws_lambda_function\" \"api\" {\n" +
            "  function_name = var.name\n" +
            "}\n";
        var ctx = new FakeContext(
            new[] { "infra/main.tf" },
            new Dictionary<string, string> { ["infra/main.tf"] = tf });

        var resolver = new CodeGraphTerraformResolver();
        Assert.Equal("terraform", resolver.Name);
        Assert.True(resolver.Detect(ctx));
    }

    // --- Catalog wiring: the M7 niche resolvers + synthesizers are registered/active ---
    [Fact]
    public void Catalogs_ContainM7NicheResolversAndSynthesizers()
    {
        Assert.Contains(CodeGraphFrameworkResolverCatalog.All, r => r is CodeGraphTerraformResolver);
        Assert.Contains(CodeGraphFrameworkResolverCatalog.All, r => r is CodeGraphSwiftUiResolver);
        Assert.Contains(CodeGraphEdgeSynthesizerCatalog.All, s => s is CodeGraphFlutterBuildSynthesizer);
        Assert.Contains(CodeGraphEdgeSynthesizerCatalog.All, s => s is CodeGraphCFnPointerSynthesizer);
    }
}
