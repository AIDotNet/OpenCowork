using System.Text;
using Xunit;

// =============================================================================
// Grammar-expansion real-parse tests for the four languages added on top of the
// TreeSitter.DotNet 1.3.0 dylib set: Bash, Haskell, Julia (tree-sitter configs) and
// Razor (bespoke embedded extractor: markup directives + @code C# delegation).
//
// Bash/Haskell/Julia drive a REAL tree-sitter parse through
// CodeGraphExtractor.ExtractFromSource, resolving the config from the DEFAULT registry
// (CodeGraphExtractorRegistry.CreateDefault — the wiring under test) and the grammar
// from a shared CodeGraphGrammarRegistry. The libtree-sitter-bash/haskell/julia/razor
// dylibs ship with the package (osx-arm64) and are copied beside the test bin by the
// .csproj glob (libtree-sitter*.dylib). Each parse test self-guards on grammar
// availability so a host without the dylibs still runs the rest of the suite;
// ExpansionGrammars_AreLoaded is the canary that pins their presence.
//
// Razor is grammar-less (regex + C# delegation): the component node and directive refs
// always run; the @code delegation is gated on the C# grammar.
// =============================================================================
public sealed class GrammarExpansionTests
{
    private static readonly CodeGraphGrammarRegistry Grammars = new();
    private static readonly CodeGraphExtractorRegistry Extractors = CodeGraphExtractorRegistry.CreateDefault();

    private static bool Available(string language) => Grammars.GetLanguage(language) is not null;

    private static CodeGraphExtractionResult Extract(string language, string filePath, string source)
    {
        ICodeGraphLanguageExtractor? extractor = Extractors.Get(language);
        return CodeGraphExtractor.ExtractFromSource(
            filePath, Encoding.UTF8.GetBytes(source), language, extractor, Grammars);
    }

    private static bool HasNode(CodeGraphExtractionResult r, string kind, string name) =>
        r.Nodes.Any(n => n.Kind == kind && n.Name == name);

    private static bool HasRef(CodeGraphExtractionResult r, string kind, string name) =>
        r.UnresolvedReferences.Any(x => x.ReferenceKind == kind && x.ReferenceName == name);

    // Canary: green ⇒ all four expansion grammars loaded in this test host.
    [Fact]
    public void ExpansionGrammars_AreLoaded()
    {
        Assert.NotNull(Grammars.GetLanguage(CodeGraphLanguage.Bash));
        Assert.NotNull(Grammars.GetLanguage(CodeGraphLanguage.Haskell));
        Assert.NotNull(Grammars.GetLanguage(CodeGraphLanguage.Julia));
        Assert.NotNull(Grammars.GetLanguage(CodeGraphLanguage.Razor));
    }

    // Registry wiring: CreateDefault resolves the three tree-sitter languages to their
    // config (Razor is embedded — deliberately NOT registered here).
    [Fact]
    public void DefaultRegistry_WiresTheThreeGrammarLanguages()
    {
        CodeGraphExtractorRegistry r = CodeGraphExtractorRegistry.CreateDefault();
        Assert.Same(CodeGraphBashExtractor.Instance, r.Get(CodeGraphLanguage.Bash));
        Assert.Same(CodeGraphHaskellExtractor.Instance, r.Get(CodeGraphLanguage.Haskell));
        Assert.Same(CodeGraphJuliaExtractor.Instance, r.Get(CodeGraphLanguage.Julia));
        Assert.Null(r.Get(CodeGraphLanguage.Razor));
    }

    // Extension detection covers the new suffixes.
    [Theory]
    [InlineData("scripts/deploy.sh", CodeGraphLanguage.Bash)]
    [InlineData("scripts/lib.bash", CodeGraphLanguage.Bash)]
    [InlineData("src/Main.hs", CodeGraphLanguage.Haskell)]
    [InlineData("src/main.jl", CodeGraphLanguage.Julia)]
    [InlineData("Pages/Index.cshtml", CodeGraphLanguage.Razor)]
    [InlineData("Pages/Counter.razor", CodeGraphLanguage.Razor)]
    public void DetectLanguage_MapsNewExtensions(string path, string expected) =>
        Assert.Equal(expected, CodeGraphLanguageMap.DetectLanguage(path));

    // ----- Bash -----
    private const string BashSource =
        "#!/bin/bash\n" +
        "source ./lib.sh\n" +
        "function greet() {\n" +
        "  echo hi\n" +
        "}\n" +
        "other() {\n" +
        "  greet\n" +
        "}\n";

    [Fact]
    public void Bash_EmitsFunctions()
    {
        if (!Available(CodeGraphLanguage.Bash)) return;

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Bash, "scripts/deploy.sh", BashSource);

        // `function greet() { … }` and POSIX-form `other() { … }` both → function nodes.
        Assert.True(HasNode(r, CodeGraphNodeKind.Function, "greet"));
        Assert.True(HasNode(r, CodeGraphNodeKind.Function, "other"));
        Assert.All(r.Nodes, n => Assert.Equal(CodeGraphLanguage.Bash, n.Language));
    }

    // ----- Haskell -----
    private const string HaskellSource =
        "module Main where\n" +
        "import Data.List\n" +
        "\n" +
        "data Color = Red | Green\n" +
        "\n" +
        "greet :: String -> String\n" +
        "greet name = \"hi \" ++ name\n" +
        "\n" +
        "class Greetable a where\n" +
        "  greet2 :: a -> String\n";

    [Fact]
    public void Haskell_EmitsFunctionDataClassAndImport()
    {
        if (!Available(CodeGraphLanguage.Haskell)) return;

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Haskell, "src/Main.hs", HaskellSource);

        // The value binding `greet name = …` → a function; the `String -> String` type
        // expression reusing the same `function` rule must NOT leak a spurious node.
        Assert.True(HasNode(r, CodeGraphNodeKind.Function, "greet"));
        Assert.False(HasNode(r, CodeGraphNodeKind.Function, "String"));
        // `data Color` → class-like; `class Greetable` (a typeclass) → interface.
        Assert.True(HasNode(r, CodeGraphNodeKind.Class, "Color"));
        Assert.True(HasNode(r, CodeGraphNodeKind.Interface, "Greetable"));
        // `import Data.List` → import node + imports reference.
        Assert.True(HasNode(r, CodeGraphNodeKind.Import, "Data.List"));
        Assert.True(HasRef(r, CodeGraphEdgeKind.Imports, "Data.List"));
    }

    // ----- Julia -----
    private const string JuliaSource =
        "import Base\n" +
        "\n" +
        "function greet(name)\n" +
        "  return name\n" +
        "end\n" +
        "\n" +
        "struct Point\n" +
        "  x::Int\n" +
        "end\n" +
        "\n" +
        "abstract type Animal end\n";

    [Fact]
    public void Julia_EmitsFunctionStructAndImport()
    {
        if (!Available(CodeGraphLanguage.Julia)) return;

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Julia, "src/main.jl", JuliaSource);

        // `function greet(name) … end` → function (name is buried under signature >
        // call_expression > identifier, resolved by the config's ResolveName hook).
        Assert.True(HasNode(r, CodeGraphNodeKind.Function, "greet"));
        // `struct Point … end` → struct (minted by the VisitNode hook: the grammar
        // exposes no named body field, so the generic ExtractStruct can't see it).
        Assert.True(HasNode(r, CodeGraphNodeKind.Struct, "Point"));
        // `abstract type Animal end` → class-like base.
        Assert.True(HasNode(r, CodeGraphNodeKind.Class, "Animal"));
        // `import Base` → import.
        Assert.True(HasNode(r, CodeGraphNodeKind.Import, "Base"));
    }

    // ----- Razor (embedded) -----
    private const string RazorSource =
        "@model App.ViewModels.RegisterModel\n" +
        "@inject IUserService UserService\n" +
        "<MyWidget TItem=\"CatalogItem\" />\n" +
        "@code {\n" +
        "  private void Save() { UserService.Persist(new Dto()); }\n" +
        "}\n";

    // Routing: HasEmbeddedExtractor claims .cshtml/.razor.
    [Theory]
    [InlineData("Pages/Index.cshtml", CodeGraphLanguage.Razor, true)]
    [InlineData("Pages/Counter.razor", CodeGraphLanguage.Razor, true)]
    [InlineData("src/app.cs", CodeGraphLanguage.CSharp, false)]
    public void HasEmbeddedExtractor_ClaimsRazor(string path, string language, bool expected) =>
        Assert.Equal(expected, CodeGraphExtractor.HasEmbeddedExtractor(path, language));

    // The component node + markup directive refs are pure-regex (no grammar needed).
    [Fact]
    public void Razor_EmitsComponentAndDirectiveReferences()
    {
        CodeGraphExtractionResult r = CodeGraphExtractor.ExtractFromSource(
            "Pages/Register.razor", Encoding.UTF8.GetBytes(RazorSource),
            CodeGraphLanguage.Razor, null, Grammars);

        // Exactly one component node, named for the file (extension stripped).
        CodeGraphNode component = Assert.Single(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component);
        Assert.Equal("Register", component.Name);
        Assert.Equal(CodeGraphLanguage.Razor, component.Language);
        Assert.True(component.IsExported);

        // @model / @inject types (last namespace segment) + Blazor component tag + its
        // generic TItem arg all arrive as by-name `references`.
        Assert.True(HasRef(r, CodeGraphEdgeKind.References, "RegisterModel"));
        Assert.True(HasRef(r, CodeGraphEdgeKind.References, "IUserService"));
        Assert.True(HasRef(r, CodeGraphEdgeKind.References, "MyWidget"));
        Assert.True(HasRef(r, CodeGraphEdgeKind.References, "CatalogItem"));
    }

    // The @code { } C# block is delegated to the C# tree-sitter engine (refs only),
    // offset back to the .razor line — gated on the C# grammar.
    [Fact]
    public void Razor_CodeBlock_DelegatesToCSharp()
    {
        if (!Available(CodeGraphLanguage.CSharp)) return;

        CodeGraphExtractionResult r = CodeGraphExtractor.ExtractFromSource(
            "Pages/Register.razor", Encoding.UTF8.GetBytes(RazorSource),
            CodeGraphLanguage.Razor, null, Grammars);

        // The service call inside @code is attributed to the component as a `calls` ref,
        // reported on its real .razor line (5), not the synthetic-wrapper-relative line.
        CodeGraphUnresolvedReference call = Assert.Single(
            r.UnresolvedReferences,
            x => x.ReferenceKind == CodeGraphEdgeKind.Calls && x.ReferenceName == "UserService.Persist");
        Assert.Equal(5, call.Line);
        Assert.Equal(CodeGraphLanguage.Razor, call.Language);
    }
}
