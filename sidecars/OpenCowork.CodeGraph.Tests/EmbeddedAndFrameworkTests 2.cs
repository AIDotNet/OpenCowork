using System.Text;
using Xunit;

// =============================================================================
// Embedded-extractor + new-framework-resolver goldens (WS-B follow-up). Covers the
// bespoke regex-only extractors wired into CodeGraphExtractor.ExtractFromSource
// (MyBatis mapper XML / Liquid / Delphi DFM — no tree-sitter grammar) and the two
// added framework resolvers (Play, GoFrame). Pure-function — no grammar required.
// =============================================================================
public sealed class CodeGraphEmbeddedExtractionTests
{
    // The embedded branch returns before any grammar lookup, so a bare registry and a
    // null extractor exercise exactly the wiring under test.
    private static readonly CodeGraphGrammarRegistry Grammars = new();

    private static CodeGraphExtractionResult Extract(string language, string filePath, string content) =>
        CodeGraphExtractor.ExtractFromSource(filePath, Encoding.UTF8.GetBytes(content), language, null, Grammars);

    // --- Routing: HasEmbeddedExtractor picks the right bespoke path ---
    [Theory]
    [InlineData("src/UserMapper.xml", CodeGraphLanguage.Xml, true)]
    [InlineData("theme/product.liquid", CodeGraphLanguage.Liquid, true)]
    [InlineData("forms/Main.dfm", CodeGraphLanguage.Pascal, true)]
    [InlineData("forms/Main.fmx", CodeGraphLanguage.Pascal, true)]
    [InlineData("units/Main.pas", CodeGraphLanguage.Pascal, false)] // Pascal source, not a form
    [InlineData("src/app.ts", CodeGraphLanguage.TypeScript, false)] // grammar language
    public void HasEmbeddedExtractor_RoutesByLanguageAndExtension(string path, string language, bool expected) =>
        Assert.Equal(expected, CodeGraphExtractor.HasEmbeddedExtractor(path, language));

    // --- MyBatis mapper XML -> statement nodes (the required golden) ---
    [Fact]
    public void MyBatis_MapperXml_EmitsStatementNodesAndIncludeRef()
    {
        const string xml =
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
            "<!DOCTYPE mapper PUBLIC \"-//mybatis.org//DTD Mapper 3.0//EN\" \"http://mybatis.org/dtd/mybatis-3-mapper.dtd\">\n" +
            "<mapper namespace=\"com.example.UserMapper\">\n" +
            "  <sql id=\"cols\">id, name, email</sql>\n" +
            "  <select id=\"findById\" resultType=\"com.example.User\">\n" +
            "    SELECT <include refid=\"cols\"/> FROM users WHERE id = #{id}\n" +
            "  </select>\n" +
            "</mapper>\n";

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Xml, "src/main/resources/UserMapper.xml", xml);

        Assert.Empty(r.Errors);
        // One method-shaped node per <select>, qualified <namespace>::<id>.
        CodeGraphNode findById = r.Nodes.Single(n => n.Kind == CodeGraphNodeKind.Method && n.Name == "findById");
        Assert.Equal("com.example.UserMapper::findById", findById.QualifiedName);
        Assert.Equal(CodeGraphLanguage.Xml, findById.Language);
        // The <sql> fragment is a method-shaped node too.
        Assert.Contains(r.Nodes, n => n.Kind == CodeGraphNodeKind.Method && n.QualifiedName == "com.example.UserMapper::cols");
        // <include refid="cols"/> -> an unresolved reference to the SQL fragment.
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.References && x.ReferenceName == "com.example.UserMapper::cols");
        // The statement is contained by the mapper's file node.
        CodeGraphNode file = r.Nodes.Single(n => n.Kind == CodeGraphNodeKind.File);
        Assert.Contains(r.Edges, e => e.Kind == CodeGraphEdgeKind.Contains && e.Source == file.Id && e.Target == findById.Id);
    }

    // Non-mapper XML (pom.xml, Spring beans, …) tracks a lone file node, no symbols.
    [Fact]
    public void MyBatis_NonMapperXml_EmitsOnlyFileNode()
    {
        const string xml = "<project><modelVersion>4.0.0</modelVersion></project>\n";
        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Xml, "pom.xml", xml);
        CodeGraphNode only = Assert.Single(r.Nodes);
        Assert.Equal(CodeGraphNodeKind.File, only.Kind);
    }

    // --- Liquid template -> snippet reference + component node ---
    [Fact]
    public void Liquid_RenderTag_EmitsSnippetReference()
    {
        const string liquid = "<div>{% render 'product-card' %}</div>\n{% assign total = 0 %}\n";
        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Liquid, "sections/featured.liquid", liquid);

        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.References && x.ReferenceName == "snippets/product-card.liquid");
        Assert.Contains(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component && n.Name == "product-card");
        Assert.Contains(r.Nodes, n => n.Kind == CodeGraphNodeKind.Variable && n.Name == "total");
    }

    // --- Delphi DFM form -> component nodes + event-handler reference ---
    [Fact]
    public void Dfm_Form_EmitsComponentsAndEventHandlerRef()
    {
        const string dfm =
            "object Form1: TForm1\n" +
            "  object Button1: TButton\n" +
            "    OnClick = Button1Click\n" +
            "  end\n" +
            "end\n";
        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Pascal, "forms/Main.dfm", dfm);

        Assert.Contains(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component && n.Name == "Form1");
        Assert.Contains(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component && n.Name == "Button1");
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.References && x.ReferenceName == "Button1Click");
    }
}

// =============================================================================
// Play + GoFrame framework resolvers. These are instantiated directly (the lead
// wires them into CodeGraphFrameworkResolverCatalog separately), so the tests drive
// Extract / Resolve on the resolver instances.
// =============================================================================
public sealed class CodeGraphPlayResolverTests
{
    // A minimal in-memory resolution context — only GetNodesByName / GetNodesInFile
    // matter for the Play resolver's Resolve; the rest return empty defaults.
    private sealed class FakeContext(IReadOnlyList<CodeGraphNode> nodes) : CodeGraphResolutionContext
    {
        public override IReadOnlyList<CodeGraphNode> GetNodesInFile(string filePath)
        {
            var list = new List<CodeGraphNode>();
            foreach (CodeGraphNode n in nodes)
            {
                if (n.FilePath == filePath)
                {
                    list.Add(n);
                }
            }

            return list;
        }

        public override IReadOnlyList<CodeGraphNode> GetNodesByName(string name)
        {
            var list = new List<CodeGraphNode>();
            foreach (CodeGraphNode n in nodes)
            {
                if (n.Name == name)
                {
                    list.Add(n);
                }
            }

            return list;
        }

        public override IReadOnlyList<CodeGraphNode> GetNodesByQualifiedName(string qualifiedName) => Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByKind(string kind) => Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByLowerName(string lowerName) => Array.Empty<CodeGraphNode>();

        public override bool FileExists(string filePath) => false;

        public override string? ReadFile(string filePath) => null;

        public override string GetProjectRoot() => "/tmp/proj";

        public override IReadOnlyList<string> GetAllFiles() => Array.Empty<string>();

        public override IReadOnlyList<CodeGraphImportMapping> GetImportMappings(string filePath, string language) =>
            Array.Empty<CodeGraphImportMapping>();
    }

    [Fact]
    public void Name_IsPlay() => Assert.Equal("play", new CodeGraphPlayResolver().Name);

    // The required golden: a Play route line -> a route node + a Controller.method ref.
    [Fact]
    public void Extract_RoutesFile_EmitsRouteNodesAndControllerRefs()
    {
        var resolver = new CodeGraphPlayResolver();
        const string routes =
            "# Home page\n" +
            "GET   /computers        controllers.Application.list(p: Int ?= 0)\n" +
            "POST  /computers        controllers.Application.save\n" +
            "->    /webjars           webjars.Routes\n";

        CodeGraphFrameworkExtraction? ex = resolver.Extract("conf/routes", routes);

        Assert.NotNull(ex);
        // Two route nodes (the `#` comment and the `->` include are skipped).
        Assert.Equal(2, ex!.Nodes.Count);
        Assert.All(ex.Nodes, n => Assert.Equal(CodeGraphNodeKind.Route, n.Kind));
        Assert.Contains(ex.Nodes, n => n.Name == "GET /computers" && n.Language == CodeGraphLanguage.Scala);
        // Each route references its handler as Controller.method (package prefix dropped).
        Assert.Contains(ex.References, r => r.ReferenceKind == CodeGraphEdgeKind.References && r.ReferenceName == "Application.list");
        Assert.Contains(ex.References, r => r.ReferenceName == "Application.save");
    }

    // The route's Controller.method ref resolves to the action method in the class.
    [Fact]
    public void Resolve_ControllerMethodRef_LinksToActionMethod()
    {
        var resolver = new CodeGraphPlayResolver();
        var ctx = new FakeContext(new[]
        {
            CodeGraphTestSupport.MakeNode("class:App", "Application", CodeGraphNodeKind.Class, "app/controllers/Application.scala", 3, language: CodeGraphLanguage.Scala),
            CodeGraphTestSupport.MakeNode("method:list", "list", CodeGraphNodeKind.Method, "app/controllers/Application.scala", 5, language: CodeGraphLanguage.Scala)
        });

        var reference = new CodeGraphUnresolvedReference(
            "route:conf/routes:2:GET:/computers", "Application.list", CodeGraphEdgeKind.References, 2, 0, "conf/routes", CodeGraphLanguage.Scala, null, null);

        CodeGraphResolvedRef? resolved = resolver.Resolve(reference, ctx);

        Assert.NotNull(resolved);
        Assert.Equal("method:list", resolved!.TargetId);
        Assert.Equal(CodeGraphResolvedBy.Framework, resolved.ResolvedBy);
        Assert.True(resolved.Confidence >= 0.9);
    }

    [Fact]
    public void ClaimsReference_MatchesControllerDotMethodOnly()
    {
        var resolver = new CodeGraphPlayResolver();
        Assert.True(resolver.ClaimsReference("Application.list"));
        Assert.False(resolver.ClaimsReference("plainName"));
    }
}

public sealed class CodeGraphGoFrameResolverTests
{
    [Fact]
    public void Name_IsGoframe() => Assert.Equal("goframe", new CodeGraphGoFrameResolver().Name);

    // A `g.Meta` struct tag -> a route node whose qualifiedName encodes the (package-
    // qualified) request type after the join marker. The route -> handler edge is
    // deferred to the synthesizer, so no references are emitted here.
    [Fact]
    public void Extract_GMetaStructTag_EmitsRouteNodeWithJoinMarker()
    {
        var resolver = new CodeGraphGoFrameResolver();
        const string go =
            "package v1\n" +
            "\n" +
            "type SignInReq struct {\n" +
            "\tg.Meta `path:\"/user/sign-in\" method:\"post\" tags:\"UserService\"`\n" +
            "\tName string\n" +
            "}\n";

        CodeGraphFrameworkExtraction? ex = resolver.Extract("api/user/v1/user.go", go);

        Assert.NotNull(ex);
        CodeGraphNode route = Assert.Single(ex!.Nodes);
        Assert.Equal(CodeGraphNodeKind.Route, route.Kind);
        Assert.Equal("POST /user/sign-in", route.Name);
        Assert.Contains(CodeGraphGoFrameResolver.GoframeRouteMarker + "v1.SignInReq", route.QualifiedName);
        Assert.Empty(ex.References);
    }
}
