using System.Text;
using Xunit;

// =============================================================================
// Extraction goldens (WS-B, M2). Two tiers, mirroring the CodeGraph suites the
// workstream inventory maps to M2 (workstreams/B §1.2, §2):
//
//   (a) PURE-FUNCTION unit (S1) — no grammar, always run. Port of
//       `extension-mapping.test.ts` (EXTENSION_MAP → language),
//       `generated-detection.test.ts` (isGenerated heuristics), and the language-
//       detection / isSourceFile slices of `extraction.test.ts`. These pin the
//       path-classification contract regardless of whether any native grammar is
//       present, so they are the de-risking first port (§2 M2.1).
//
//   (b) REAL-PARSE end-to-end (S3) — drives CodeGraphExtractor.ExtractFromSource
//       over a real tree-sitter parse of a small TS / Python / Go snippet and
//       asserts the emitted nodes, the `contains` edges, and the unresolved
//       call/import references (analysis/01 §2.4: extraction emits nodes +
//       contains edges + unresolvedReferences ONLY — calls/imports are NAME
//       strings, resolved to real edges later). Also pins node-id stability
//       across two runs (Decision 17 — the id formula must never drift).
//
// The .csproj copies the host RID's TreeSitter.DotNet native libraries beside the
// test binary so [LibraryImport] can load them. RealGrammars_AreLoaded makes missing
// assets fail clearly. The TSX regression below is also deliberately unguarded so a
// broken split-library binding cannot silently pass.
// =============================================================================

// -----------------------------------------------------------------------------
// Shared harness — a populated extractor registry (the language-config slice
// ships one ICodeGraphLanguageExtractor per grammar; the worker registers them —
// here the test does the same for the MVP-parse three) and a lazily-probed
// grammar registry.
// -----------------------------------------------------------------------------
internal static class CodeGraphExtractionHarness
{
    // One grammar registry for the whole run — GetLanguage caches handles and
    // remembers unavailability, so probing it repeatedly is cheap.
    internal static readonly CodeGraphGrammarRegistry Grammars = new();

    internal static CodeGraphExtractorRegistry BuildExtractors()
    {
        var registry = new CodeGraphExtractorRegistry();
        registry.Register(CodeGraphLanguage.TypeScript, CodeGraphTypeScriptExtractor.Instance);
        registry.Register(CodeGraphLanguage.Tsx, CodeGraphTypeScriptExtractor.Instance);
        registry.Register(CodeGraphLanguage.Python, CodeGraphPythonExtractor.Instance);
        registry.Register(CodeGraphLanguage.Go, CodeGraphGoExtractor.Instance);
        return registry;
    }

    // True when the native grammar for a language is loadable in this test host.
    internal static bool GrammarAvailable(string language) =>
        Grammars.GetLanguage(language) is not null;

    // Resolve the config from the registry (the wiring under test) and run the
    // real extraction entry point over a UTF-8 parse of the snippet.
    internal static CodeGraphExtractionResult Extract(string language, string filePath, string source)
    {
        ICodeGraphLanguageExtractor? extractor = BuildExtractors().Get(language);
        Assert.NotNull(extractor);
        byte[] utf8 = Encoding.UTF8.GetBytes(source);
        return CodeGraphExtractor.ExtractFromSource(filePath, utf8, language, extractor!, Grammars);
    }

    internal static bool HasNode(CodeGraphExtractionResult r, string kind, string name) =>
        r.Nodes.Any(n => n.Kind == kind && n.Name == name);

    internal static CodeGraphNode Node(CodeGraphExtractionResult r, string kind, string name) =>
        r.Nodes.Single(n => n.Kind == kind && n.Name == name);

    internal static bool HasContainsEdge(CodeGraphExtractionResult r, string sourceId, string targetId) =>
        r.Edges.Any(e => e.Kind == CodeGraphEdgeKind.Contains && e.Source == sourceId && e.Target == targetId);

    internal static bool HasRef(CodeGraphExtractionResult r, string kind, string name) =>
        r.UnresolvedReferences.Any(x => x.ReferenceKind == kind && x.ReferenceName == name);
}

// =============================================================================
// (a) Pure-function classification tests — no grammar required.
// =============================================================================
public sealed class CodeGraphExtractionDetectionTests
{
    // --- DetectLanguage: EXTENSION_MAP → language (extension-mapping.test.ts) ---
    [Theory]
    [InlineData("src/app.ts", CodeGraphLanguage.TypeScript)]
    [InlineData("src/app.tsx", CodeGraphLanguage.Tsx)]
    [InlineData("src/app.mts", CodeGraphLanguage.TypeScript)]
    [InlineData("src/app.cts", CodeGraphLanguage.TypeScript)]
    [InlineData("ui/comp.ets", CodeGraphLanguage.ArkTs)]
    [InlineData("src/app.js", CodeGraphLanguage.JavaScript)]
    [InlineData("src/app.mjs", CodeGraphLanguage.JavaScript)]
    [InlineData("src/app.cjs", CodeGraphLanguage.JavaScript)]
    [InlineData("src/app.jsx", CodeGraphLanguage.Jsx)]
    [InlineData("pkg/mod.py", CodeGraphLanguage.Python)]
    [InlineData("pkg/mod.pyw", CodeGraphLanguage.Python)]
    [InlineData("cmd/main.go", CodeGraphLanguage.Go)]
    [InlineData("src/lib.rs", CodeGraphLanguage.Rust)]
    [InlineData("com/Main.java", CodeGraphLanguage.Java)]
    [InlineData("core/util.c", CodeGraphLanguage.C)]
    [InlineData("core/util.h", CodeGraphLanguage.C)] // .h defaults to C (no source)
    [InlineData("core/util.cpp", CodeGraphLanguage.Cpp)]
    [InlineData("core/util.cc", CodeGraphLanguage.Cpp)]
    [InlineData("core/util.hpp", CodeGraphLanguage.Cpp)]
    [InlineData("app/Model.cs", CodeGraphLanguage.CSharp)]
    [InlineData("web/index.php", CodeGraphLanguage.Php)]
    [InlineData("drupal/foo.module", CodeGraphLanguage.Php)]
    [InlineData("app/user.rb", CodeGraphLanguage.Ruby)]
    [InlineData("ios/App.swift", CodeGraphLanguage.Swift)]
    [InlineData("android/Main.kt", CodeGraphLanguage.Kotlin)]
    [InlineData("lib/widget.dart", CodeGraphLanguage.Dart)]
    [InlineData("src/Main.scala", CodeGraphLanguage.Scala)]
    [InlineData("cfg/init.lua", CodeGraphLanguage.Lua)]
    [InlineData("ios/View.m", CodeGraphLanguage.ObjC)]
    [InlineData("contracts/Token.sol", CodeGraphLanguage.Solidity)]
    [InlineData("pkgs/default.nix", CodeGraphLanguage.Nix)]
    [InlineData("infra/main.tf", CodeGraphLanguage.Terraform)]
    [InlineData("notes.txt", CodeGraphLanguage.Unknown)]
    [InlineData("README.md", CodeGraphLanguage.Unknown)]
    [InlineData("Makefile", CodeGraphLanguage.Unknown)] // no extension → unknown
    public void DetectLanguage_MapsExtensionToLanguage(string path, string expected) =>
        Assert.Equal(expected, CodeGraphLanguageMap.DetectLanguage(path));

    // --- DetectLanguage: special filenames (grammars.ts special-case branches) ---
    [Theory]
    [InlineData("conf/routes", CodeGraphLanguage.Yaml)]        // Play routes (extensionless)
    [InlineData("app.routes", CodeGraphLanguage.Yaml)]         // included Play routes
    [InlineData("templates/product.json", CodeGraphLanguage.Liquid)]      // Shopify OS 2.0
    [InlineData("sections/header.json", CodeGraphLanguage.Liquid)]
    [InlineData("templates/customers/login.json", CodeGraphLanguage.Liquid)] // nested
    [InlineData("myapp.app.src", CodeGraphLanguage.Erlang)]    // OTP resource
    [InlineData("myapp.app", CodeGraphLanguage.Erlang)]
    [InlineData("config/settings.json", CodeGraphLanguage.Unknown)] // plain .json → not source
    public void DetectLanguage_HandlesSpecialFilenames(string path, string expected) =>
        Assert.Equal(expected, CodeGraphLanguageMap.DetectLanguage(path));

    // --- DetectLanguage: .h C/C++/Obj-C content heuristic (looksLikeCpp/Objc) ---
    [Fact]
    public void DetectLanguage_H_UsesContentHeuristic()
    {
        Assert.Equal(CodeGraphLanguage.C, CodeGraphLanguageMap.DetectLanguage("lib/foo.h"));
        Assert.Equal(CodeGraphLanguage.C, CodeGraphLanguageMap.DetectLanguage("lib/foo.h", "int add(int a, int b);"));
        Assert.Equal(CodeGraphLanguage.Cpp, CodeGraphLanguageMap.DetectLanguage("lib/foo.h", "namespace ns { class Foo {}; }"));
        Assert.Equal(CodeGraphLanguage.Cpp, CodeGraphLanguageMap.DetectLanguage("lib/foo.h", "template <typename T> struct Box {};"));
        Assert.Equal(CodeGraphLanguage.ObjC, CodeGraphLanguageMap.DetectLanguage("lib/foo.h", "@interface Foo : NSObject\n@end"));
    }

    // --- IsSourceFile: derived from EXTENSION_MAP + special filenames ---
    [Theory]
    [InlineData("src/app.ts", true)]
    [InlineData("pkg/mod.py", true)]
    [InlineData("cmd/main.go", true)]
    [InlineData("src/lib.rs", true)]
    [InlineData("com/Main.java", true)]
    [InlineData("core/util.cpp", true)]
    [InlineData("app/Model.cs", true)]
    [InlineData("app/user.rb", true)]
    [InlineData("conf/routes", true)]                 // Play routes (extensionless)
    [InlineData("templates/product.json", true)]      // Shopify liquid json
    [InlineData("docs/README.md", false)]
    [InlineData("notes.txt", false)]
    [InlineData("data.json", false)]                  // plain .json is not indexable
    [InlineData("Makefile", false)]                   // no extension
    public void IsSourceFile_MatchesExtensionMapAndSpecials(string path, bool expected) =>
        Assert.Equal(expected, CodeGraphLanguageMap.IsSourceFile(path));

    // --- IsGeneratedFile: positive (generated-detection.ts GENERATED_PATTERNS) ---
    [Theory]
    [InlineData("api/service.pb.go")]
    [InlineData("api/service_grpc.pb.go")]
    [InlineData("api/thing.pulsar.go")]
    [InlineData("store/repo_mock.go")]
    [InlineData("store/repo_mocks.go")]
    [InlineData("mock_client.go")]                    // ^mock_ anchors at basename start
    [InlineData("graphql/types.generated.ts")]
    [InlineData("graphql/hooks.gen.tsx")]
    [InlineData("proto/service.pb.ts")]
    [InlineData("proto/service_pb.js")]
    [InlineData("proto/service_grpc_pb.ts")]
    [InlineData("vendor/lib.min.js")]
    [InlineData("gen/service_pb2.py")]
    [InlineData("gen/service_pb2_grpc.py")]
    [InlineData("gen/service_pb2.pyi")]
    [InlineData("proto/message.pb.cc")]
    [InlineData("proto/message.pb.h")]
    [InlineData("Grpc/Service.g.cs")]
    [InlineData("Grpc/ServiceGrpc.cs")]
    [InlineData("gen/MessageOuterClass.java")]
    [InlineData("gen/ServiceGrpc.java")]
    [InlineData("Sources/Message.pb.swift")]
    [InlineData("lib/model.g.dart")]
    [InlineData("lib/model.freezed.dart")]
    [InlineData("lib/api.chopper.dart")]
    [InlineData("src/schema.generated.rs")]
    public void IsGeneratedFile_TrueForToolGeneratedSuffixes(string path) =>
        Assert.True(CodeGraphGeneratedDetection.IsGeneratedFile(path), path);

    // --- IsGeneratedFile: negative (hand-written sources must NOT match) ---
    [Theory]
    [InlineData("api/service.go")]
    [InlineData("store/repo.go")]
    [InlineData("cmd/main.go")]
    [InlineData("src/app.ts")]
    [InlineData("src/helper.tsx")]
    [InlineData("src/bundle.js")]
    [InlineData("gen/service.py")]
    [InlineData("app/Model.cs")]
    [InlineData("lib/model.dart")]
    [InlineData("app/user.rb")]
    [InlineData("Sources/Message.swift")]
    [InlineData("src/lib.rs")]
    public void IsGeneratedFile_FalseForHandWrittenSources(string path) =>
        Assert.False(CodeGraphGeneratedDetection.IsGeneratedFile(path), path);

    // --- Extractor registry wiring (getLanguageExtractor parity) ---
    [Fact]
    public void ExtractorRegistry_ResolvesRegisteredLanguagesAndNullElse()
    {
        CodeGraphExtractorRegistry registry = CodeGraphExtractionHarness.BuildExtractors();

        Assert.Same(CodeGraphTypeScriptExtractor.Instance, registry.Get(CodeGraphLanguage.TypeScript));
        Assert.Same(CodeGraphTypeScriptExtractor.Instance, registry.Get(CodeGraphLanguage.Tsx));
        Assert.Same(CodeGraphPythonExtractor.Instance, registry.Get(CodeGraphLanguage.Python));
        Assert.Same(CodeGraphGoExtractor.Instance, registry.Get(CodeGraphLanguage.Go));
        Assert.True(registry.Contains(CodeGraphLanguage.Go));

        // A language with no registered config resolves to null (the indexer's
        // "unsupported → tracked-as-skipped" path).
        Assert.Null(registry.Get(CodeGraphLanguage.Unknown));
        Assert.Null(registry.Get(CodeGraphLanguage.Cobol));
    }
}

// =============================================================================
// (b) Real-parse tests — drive a native tree-sitter parse. Gated on grammar
// availability (dylibs copied beside the test bin).
// =============================================================================
public sealed class CodeGraphExtractionParseTests
{
    // Availability canary: green ⇒ the TS/TSX/Python/Go grammars loaded and the parse
    // tests below exercised a real parse. Red ⇒ the native dylibs are not on the
    // test host's load path (see the .csproj copy item). TSX also has a mandatory
    // parse regression below because its grammar ships in a separate native library.
    [Fact]
    public void RealGrammars_AreLoaded()
    {
        Assert.NotNull(CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.TypeScript));
        Assert.NotNull(CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.Tsx));
        Assert.NotNull(CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.Python));
        Assert.NotNull(CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.Go));
    }

    // ----- TypeScript -----

    private const string TsSource =
        "import { readFile } from 'fs'\n" +
        "\n" +
        "export function greet(name: string): string {\n" +
        "  return sayHello(name)\n" +
        "}\n" +
        "\n" +
        "export class Greeter {\n" +
        "  greeting: string\n" +
        "  greet(): string {\n" +
        "    return greet(this.greeting)\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void TypeScript_EmitsFunctionClassContainsAndRefs()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript)) return;

        CodeGraphExtractionResult r =
            CodeGraphExtractionHarness.Extract(CodeGraphLanguage.TypeScript, "src/greeter.ts", TsSource);

        // The top-level function, the class, and the class method are all nodes.
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Function, "greet"));
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Class, "Greeter"));
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Method, "greet"));

        // Every emitted node is TypeScript and carries the file's path.
        Assert.All(r.Nodes, n => Assert.Equal(CodeGraphLanguage.TypeScript, n.Language));
        Assert.All(r.Nodes, n => Assert.Equal("src/greeter.ts", n.FilePath));

        // The exported function is a `contains` child of the file node.
        CodeGraphNode file = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.File, "greeter.ts");
        CodeGraphNode func = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Function, "greet");
        Assert.Equal("file:src/greeter.ts", file.Id);
        Assert.True(CodeGraphExtractionHarness.HasContainsEdge(r, file.Id, func.Id));
        Assert.True(func.IsExported);

        // The class contains its method (a structural `contains` edge).
        CodeGraphNode cls = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Class, "Greeter");
        CodeGraphNode method = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Method, "greet");
        Assert.True(CodeGraphExtractionHarness.HasContainsEdge(r, cls.Id, method.Id));

        // Import + call arrive as unresolved references (name strings, not ids).
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Imports, "fs"));
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "sayHello"));
    }

    [Fact]
    public void Tsx_ParsesJsxWithoutErrorsAndEmitsFunction()
    {
        const string source =
            "export function App(): JSX.Element {\n" +
            "  return <main data-kind=\"app\">Hello</main>\n" +
            "}\n";

        // This test intentionally has no availability guard. TSX is shipped as a
        // separate native library from TypeScript, so a missing library or a binding
        // to the TypeScript dylib must fail instead of silently skipping coverage.
        nint? grammar = CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.Tsx);
        Assert.NotNull(grammar);

        CodeGraphSourceText sourceText = CodeGraphSourceText.FromUtf8(Encoding.UTF8.GetBytes(source));
        using (CodeGraphTsParser parser = new())
        {
            parser.SetLanguage(grammar!.Value);
            using CodeGraphTsTree tree = parser.Parse(sourceText);
            Assert.Equal("program", tree.RootNode.Type);
            Assert.False(tree.RootNode.HasError);
        }

        CodeGraphExtractionResult result =
            CodeGraphExtractionHarness.Extract(CodeGraphLanguage.Tsx, "src/App.tsx", source);

        Assert.Empty(result.Errors);
        Assert.True(CodeGraphExtractionHarness.HasNode(result, CodeGraphNodeKind.Function, "App"));
        Assert.All(result.Nodes, node => Assert.Equal(CodeGraphLanguage.Tsx, node.Language));
    }

    // ----- Python -----

    private const string PySource =
        "import os\n" +
        "\n" +
        "def greet(name):\n" +
        "    return say_hello(name)\n" +
        "\n" +
        "class Greeter:\n" +
        "    def greet(self):\n" +
        "        return greet(self.name)\n";

    [Fact]
    public void Python_EmitsFunctionClassContainsAndRefs()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Python)) return;

        CodeGraphExtractionResult r =
            CodeGraphExtractionHarness.Extract(CodeGraphLanguage.Python, "pkg/greeter.py", PySource);

        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Function, "greet"));
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Class, "Greeter"));
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Method, "greet"));

        CodeGraphNode file = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.File, "greeter.py");
        CodeGraphNode func = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Function, "greet");
        Assert.True(CodeGraphExtractionHarness.HasContainsEdge(r, file.Id, func.Id));

        CodeGraphNode cls = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Class, "Greeter");
        CodeGraphNode method = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Method, "greet");
        Assert.True(CodeGraphExtractionHarness.HasContainsEdge(r, cls.Id, method.Id));

        // `import os` → one import ref; `say_hello(...)` → a call ref.
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Imports, "os"));
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "say_hello"));
    }

    // ----- Go -----

    private const string GoSource =
        "package main\n" +
        "\n" +
        "import \"fmt\"\n" +
        "\n" +
        "func Greet(name string) string {\n" +
        "\treturn fmt.Sprintf(\"hi %s\", name)\n" +
        "}\n" +
        "\n" +
        "type Greeter struct {\n" +
        "\tname string\n" +
        "}\n";

    [Fact]
    public void Go_EmitsFunctionStructContainsAndRefs()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Go)) return;

        CodeGraphExtractionResult r =
            CodeGraphExtractionHarness.Extract(CodeGraphLanguage.Go, "cmd/greeter.go", GoSource);

        // Go has no classes: `type Greeter struct` is a struct node (type_spec →
        // ResolveTypeAliasKind == "struct"); `func Greet` is a function node.
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Function, "Greet"));
        Assert.True(CodeGraphExtractionHarness.HasNode(r, CodeGraphNodeKind.Struct, "Greeter"));

        CodeGraphNode file = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.File, "greeter.go");
        CodeGraphNode func = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Function, "Greet");
        Assert.True(CodeGraphExtractionHarness.HasContainsEdge(r, file.Id, func.Id));

        // Capitalized identifier ⇒ exported (Go visibility rule).
        Assert.True(func.IsExported);

        // `import "fmt"` → import ref; `fmt.Sprintf(...)` → a receiver-qualified call ref.
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Imports, "fmt"));
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "fmt.Sprintf"));
    }

    // ----- Function-refs (callback-as-value) & value-refs (same-file const reads) -----

    private const string FnRefSource =
        "function onData(value: string): void {\n" +
        "  log(value)\n" +
        "}\n" +
        "\n" +
        "function setup(): void {\n" +
        "  subscribe(onData)\n" +
        "  subscribe(unknownCb)\n" +
        "}\n";

    [Fact]
    public void TypeScript_CapturesCallbackAsFunctionRef()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript)) return;

        CodeGraphExtractionResult r =
            CodeGraphExtractionHarness.Extract(CodeGraphLanguage.TypeScript, "src/events.ts", FnRefSource);

        // `onData` is a same-file function passed as a call-argument VALUE → it survives
        // the flushFnRefCandidates gate as a `function_ref` unresolved reference
        // (analysis/01 §2.1: callback-as-value, ReferenceKind 'function_ref').
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.FunctionRef, "onData"));

        // …attributed to the enclosing `setup` function (the fromNodeId).
        CodeGraphNode setup = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Function, "setup");
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.FunctionRef &&
            x.ReferenceName == "onData" &&
            x.FromNodeId == setup.Id);

        // `unknownCb` is neither defined in-file nor imported → gated out (no function_ref).
        Assert.False(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.FunctionRef, "unknownCb"));

        // function_ref is NEVER a real edge at extraction time — the contract stays
        // nodes + contains/value-ref edges + unresolvedReferences (resolution promotes it).
        Assert.DoesNotContain(r.Edges, e => e.Kind == CodeGraphEdgeKind.FunctionRef);
    }

    private const string ValueRefSource =
        "const MAX_RETRIES = 3\n" +
        "\n" +
        "export function retry(): number {\n" +
        "  return MAX_RETRIES\n" +
        "}\n";

    [Fact]
    public void TypeScript_EmitsSameFileValueReferenceEdge()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript)) return;

        CodeGraphExtractionResult r =
            CodeGraphExtractionHarness.Extract(CodeGraphLanguage.TypeScript, "src/retry.ts", ValueRefSource);

        // The file-scope constant and its reader function are both nodes.
        CodeGraphNode konst = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Constant, "MAX_RETRIES");
        CodeGraphNode retry = CodeGraphExtractionHarness.Node(r, CodeGraphNodeKind.Function, "retry");

        // flushValueRefs emits a same-file `references` edge reader → const, tagged
        // metadata {valueRef:true} (analysis/01 §2.4 — a direct edge extraction emits, so
        // impact analysis catches "change this constant, affect its readers").
        CodeGraphEdge? valueRef = r.Edges.FirstOrDefault(e =>
            e.Kind == CodeGraphEdgeKind.References &&
            e.Source == retry.Id &&
            e.Target == konst.Id);
        Assert.NotNull(valueRef);
        Assert.Contains("valueRef", valueRef!.Metadata!);
    }

    // ----- Node-id stability (Decision 17: the id formula must never drift) -----

    [Fact]
    public void NodeIds_AreStableAcrossTwoRuns()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript) ||
            !CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Python) ||
            !CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Go))
        {
            return;
        }

        AssertIdsStable(CodeGraphLanguage.TypeScript, "src/greeter.ts", TsSource);
        AssertIdsStable(CodeGraphLanguage.Python, "pkg/greeter.py", PySource);
        AssertIdsStable(CodeGraphLanguage.Go, "cmd/greeter.go", GoSource);
    }

    private static void AssertIdsStable(string language, string filePath, string source)
    {
        List<string> first =
            CodeGraphExtractionHarness.Extract(language, filePath, source).Nodes.Select(n => n.Id).ToList();
        List<string> second =
            CodeGraphExtractionHarness.Extract(language, filePath, source).Nodes.Select(n => n.Id).ToList();

        Assert.NotEmpty(first);
        // Same nodes, same order, same ids — the id is a pure function of
        // (filePath, kind, name, startLine), so two parses of identical bytes match.
        Assert.Equal(first, second);
    }
}
