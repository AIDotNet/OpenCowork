using System.Text;
using Xunit;

// =============================================================================
// Language-expansion real-parse tests (WS-B follow-up: C / C++ / PHP / Ruby /
// Scala). The extraction engine is language-agnostic — one engine + N config
// objects — so these tests drive a REAL tree-sitter parse of a small canonical
// snippet per language through CodeGraphExtractor.ExtractFromSource, resolving the
// config from the DEFAULT registry (CodeGraphExtractorRegistry.CreateDefault — the
// wiring under test) and the grammar from CodeGraphGrammarRegistry.
//
// The five grammar dylibs ship with TreeSitter.DotNet 1.3.0 (osx-arm64) and are
// copied beside the test bin by the .csproj (libtree-sitter*.dylib glob). Each
// per-language test self-guards on grammar availability (early return) so a host
// without the dylibs still runs the rest of the suite; NewLanguageGrammars_AreLoaded
// is the canary that pins their presence in the dev/CI environment.
// =============================================================================
internal static class CodeGraphExpansionHarness
{
    // One grammar registry for the run — GetLanguage caches handles / unavailability.
    internal static readonly CodeGraphGrammarRegistry Grammars = new();

    // The DEFAULT registry (CreateDefault) — exercises the language→config wiring the
    // five new registrations added.
    internal static readonly CodeGraphExtractorRegistry Extractors =
        CodeGraphExtractorRegistry.CreateDefault();

    internal static bool GrammarAvailable(string language) =>
        Grammars.GetLanguage(language) is not null;

    internal static CodeGraphExtractionResult Extract(string language, string filePath, string source)
    {
        ICodeGraphLanguageExtractor? extractor = Extractors.Get(language);
        Assert.NotNull(extractor);
        byte[] utf8 = Encoding.UTF8.GetBytes(source);
        return CodeGraphExtractor.ExtractFromSource(filePath, utf8, language, extractor!, Grammars);
    }

    internal static bool HasNode(CodeGraphExtractionResult r, string kind, string name) =>
        r.Nodes.Any(n => n.Kind == kind && n.Name == name);

    internal static bool HasRef(CodeGraphExtractionResult r, string kind, string name) =>
        r.UnresolvedReferences.Any(x => x.ReferenceKind == kind && x.ReferenceName == name);
}

public sealed class LanguageExpansionTests
{
    // Canary: green ⇒ all five new grammars loaded in this test host, so the parse
    // tests below exercise a real parse (mirrors ExtractionTests.RealGrammars_AreLoaded).
    [Fact]
    public void NewLanguageGrammars_AreLoaded()
    {
        Assert.NotNull(CodeGraphExpansionHarness.Grammars.GetLanguage(CodeGraphLanguage.C));
        Assert.NotNull(CodeGraphExpansionHarness.Grammars.GetLanguage(CodeGraphLanguage.Cpp));
        Assert.NotNull(CodeGraphExpansionHarness.Grammars.GetLanguage(CodeGraphLanguage.Php));
        Assert.NotNull(CodeGraphExpansionHarness.Grammars.GetLanguage(CodeGraphLanguage.Ruby));
        Assert.NotNull(CodeGraphExpansionHarness.Grammars.GetLanguage(CodeGraphLanguage.Scala));
    }

    // Registry wiring: CreateDefault resolves each new language to its config.
    [Fact]
    public void DefaultRegistry_WiresTheFiveNewLanguages()
    {
        CodeGraphExtractorRegistry r = CodeGraphExtractorRegistry.CreateDefault();
        Assert.Same(CodeGraphCExtractor.Instance, r.Get(CodeGraphLanguage.C));
        Assert.Same(CodeGraphCppExtractor.Instance, r.Get(CodeGraphLanguage.Cpp));
        Assert.Same(CodeGraphPhpExtractor.Instance, r.Get(CodeGraphLanguage.Php));
        Assert.Same(CodeGraphRubyExtractor.Instance, r.Get(CodeGraphLanguage.Ruby));
        Assert.Same(CodeGraphScalaExtractor.Instance, r.Get(CodeGraphLanguage.Scala));
    }

    // ----- C -----
    private const string CSource =
        "#include <stdio.h>\n" +
        "\n" +
        "int add(int a, int b) {\n" +
        "  return a + b;\n" +
        "}\n";

    [Fact]
    public void C_EmitsFunctionAndInclude()
    {
        if (!CodeGraphExpansionHarness.GrammarAvailable(CodeGraphLanguage.C)) return;

        CodeGraphExtractionResult r =
            CodeGraphExpansionHarness.Extract(CodeGraphLanguage.C, "core/util.c", CSource);

        // A top-level `function_definition` → a function node named `add`.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Function, "add"));
        // `#include <stdio.h>` → an import node + an `imports` reference.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Import, "stdio.h"));
        Assert.True(CodeGraphExpansionHarness.HasRef(r, CodeGraphEdgeKind.Imports, "stdio.h"));
        Assert.All(r.Nodes, n => Assert.Equal(CodeGraphLanguage.C, n.Language));
    }

    // ----- C++ -----
    private const string CppSource =
        "#include <string>\n" +
        "\n" +
        "class Greeter {\n" +
        "public:\n" +
        "  std::string greet(const std::string& name) {\n" +
        "    return name;\n" +
        "  }\n" +
        "};\n";

    [Fact]
    public void Cpp_EmitsClassAndMethod()
    {
        if (!CodeGraphExpansionHarness.GrammarAvailable(CodeGraphLanguage.Cpp)) return;

        CodeGraphExtractionResult r =
            CodeGraphExpansionHarness.Extract(CodeGraphLanguage.Cpp, "core/util.cpp", CppSource);

        // `class_specifier` with a body → a class node; the inline definition → a method.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Class, "Greeter"));
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Method, "greet"));
    }

    // ----- PHP -----
    private const string PhpSource =
        "<?php\n" +
        "namespace App;\n" +
        "\n" +
        "class User {\n" +
        "  public function getName(): string {\n" +
        "    return $this->name;\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Php_EmitsClassAndMethod()
    {
        if (!CodeGraphExpansionHarness.GrammarAvailable(CodeGraphLanguage.Php)) return;

        CodeGraphExtractionResult r =
            CodeGraphExpansionHarness.Extract(CodeGraphLanguage.Php, "web/User.php", PhpSource);

        // `class_declaration` → class node; `method_declaration` inside it → method.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Class, "User"));
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Method, "getName"));
        // The file-level `namespace App;` becomes a namespace node.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Namespace, "App"));
    }

    // ----- Ruby -----
    private const string RubySource =
        "class User\n" +
        "  def name\n" +
        "    @name\n" +
        "  end\n" +
        "end\n";

    [Fact]
    public void Ruby_EmitsClassAndMethod()
    {
        if (!CodeGraphExpansionHarness.GrammarAvailable(CodeGraphLanguage.Ruby)) return;

        CodeGraphExtractionResult r =
            CodeGraphExpansionHarness.Extract(CodeGraphLanguage.Ruby, "app/user.rb", RubySource);

        // `class` → class node; `method` inside it → method.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Class, "User"));
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Method, "name"));
    }

    // ----- Ruby module (VisitNode hook: module scope) -----
    private const string RubyModuleSource =
        "module Greetable\n" +
        "  def greet\n" +
        "    'hi'\n" +
        "  end\n" +
        "end\n";

    [Fact]
    public void Ruby_ModuleHook_EmitsModuleAndMethod()
    {
        if (!CodeGraphExpansionHarness.GrammarAvailable(CodeGraphLanguage.Ruby)) return;

        CodeGraphExtractionResult r =
            CodeGraphExpansionHarness.Extract(CodeGraphLanguage.Ruby, "app/greetable.rb", RubyModuleSource);

        // The VisitNode hook mints a `module` node and pushes it as a scope so the
        // `def greet` inside is a method (module is a class-like container).
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Module, "Greetable"));
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Method, "greet"));
    }

    // ----- Scala -----
    private const string ScalaSource =
        "object Main {\n" +
        "  def greet(name: String): String = name\n" +
        "}\n" +
        "\n" +
        "class Greeter {\n" +
        "  def hello(): String = \"hi\"\n" +
        "}\n";

    [Fact]
    public void Scala_EmitsObjectClassAndMethod()
    {
        if (!CodeGraphExpansionHarness.GrammarAvailable(CodeGraphLanguage.Scala)) return;

        CodeGraphExtractionResult r =
            CodeGraphExpansionHarness.Extract(CodeGraphLanguage.Scala, "src/Main.scala", ScalaSource);

        // `object_definition` and `class_definition` both extract as the class kind;
        // each `def` is a method inside its class-like scope.
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Class, "Main"));
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Class, "Greeter"));
        Assert.True(CodeGraphExpansionHarness.HasNode(r, CodeGraphNodeKind.Method, "greet"));
    }
}
