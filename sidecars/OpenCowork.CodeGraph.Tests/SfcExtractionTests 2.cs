using System.Text;
using Xunit;

// =============================================================================
// Single-File-Component (Svelte / Vue / Astro) embedded-extractor + framework-
// resolver goldens. The extractors carve the <script>/frontmatter region, delegate
// it to the TS/JS tree-sitter engine, and OFFSET the returned line positions back to
// full-SFC coordinates — so the load-bearing assertion is that a function defined in
// a script/frontmatter block lands on its true SFC line, not its region-relative one.
//
// The delegation drives a REAL tree-sitter parse, so the offset tests are GATED on
// grammar availability (self-skip when the TS dylib is absent, like ExtractionTests).
// The resolver Name/Detect/Extract/Resolve tests are pure-function — always run.
// =============================================================================
public sealed class CodeGraphSfcExtractionTests
{
    private static CodeGraphExtractionResult Extract(string language, string filePath, string content) =>
        CodeGraphExtractor.ExtractFromSource(
            filePath, Encoding.UTF8.GetBytes(content), language, null, CodeGraphExtractionHarness.Grammars);

    // --- Routing: HasEmbeddedExtractor claims .svelte/.vue/.astro ---
    [Theory]
    [InlineData("src/App.svelte", CodeGraphLanguage.Svelte, true)]
    [InlineData("src/App.vue", CodeGraphLanguage.Vue, true)]
    [InlineData("src/pages/index.astro", CodeGraphLanguage.Astro, true)]
    [InlineData("src/app.ts", CodeGraphLanguage.TypeScript, false)] // grammar language, not embedded
    public void HasEmbeddedExtractor_ClaimsSfcLanguages(string path, string language, bool expected) =>
        Assert.Equal(expected, CodeGraphExtractor.HasEmbeddedExtractor(path, language));

    // The SFC component node is emitted with no grammar (pure regex), so this runs
    // even on a host without the TS dylib.
    [Fact]
    public void Svelte_AlwaysEmitsComponentNode()
    {
        const string svelte = "<script>\nfunction f() {}\n</script>\n<div />\n";
        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Svelte, "src/Widget.svelte", svelte);

        CodeGraphNode component = Assert.Single(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component);
        Assert.Equal("Widget", component.Name);
        Assert.Equal("src/Widget.svelte::Widget", component.QualifiedName);
        Assert.Equal(CodeGraphLanguage.Svelte, component.Language);
        Assert.True(component.IsExported);
        Assert.Equal(1, component.StartLine);
    }

    // The required golden: a <script> function is delegated to the TS engine and its
    // node lands on the true SFC line (offset-adjusted), NOT its region-relative line.
    [Fact]
    public void Svelte_ScriptFunction_IsExtractedAtOffsetAdjustedLine()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript))
        {
            return;
        }

        const string svelte =
            "<script lang=\"ts\">\n" +      // line 1
            "function greet(name: string): string {\n" + // line 2
            "  return sayHello(name)\n" +   // line 3
            "}\n" +                          // line 4
            "</script>\n" +                  // line 5
            "\n" +                            // line 6
            "<div>{greet('world')}</div>\n"; // line 7

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Svelte, "src/App.svelte", svelte);

        CodeGraphNode component = Assert.Single(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component);
        CodeGraphNode greet = Assert.Single(r.Nodes, n => n.Kind == CodeGraphNodeKind.Function && n.Name == "greet");

        // Delegated from the <script> at line 1, `greet` is on line 2 of the SFC.
        Assert.Equal(2, greet.StartLine);
        // Relabeled to the SFC language (not typescript) and carrying the .svelte path.
        Assert.Equal(CodeGraphLanguage.Svelte, greet.Language);
        Assert.Equal("src/App.svelte", greet.FilePath);
        // The component `contains` the delegated symbol.
        Assert.Contains(r.Edges, e =>
            e.Kind == CodeGraphEdgeKind.Contains && e.Source == component.Id && e.Target == greet.Id);
        // The call inside the function arrives as an unresolved `calls` reference.
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.Calls && x.ReferenceName == "sayHello");
    }

    // A <script setup> that is NOT the first block: the offset must include the
    // <template> lines above it (this is where a naive "add 1" or "start at 0" breaks).
    [Fact]
    public void Vue_ScriptSetupFunction_IsExtractedAtOffsetAdjustedLine()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript))
        {
            return;
        }

        const string vue =
            "<template>\n" +                 // line 1
            "  <div>{{ greet() }}</div>\n" + // line 2
            "</template>\n" +                // line 3
            "\n" +                            // line 4
            "<script setup lang=\"ts\">\n" + // line 5
            "function greet(): string {\n" + // line 6
            "  return 'hi'\n" +              // line 7
            "}\n" +                           // line 8
            "</script>\n";                    // line 9

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Vue, "src/App.vue", vue);

        CodeGraphNode greet = Assert.Single(r.Nodes, n => n.Kind == CodeGraphNodeKind.Function && n.Name == "greet");
        // The script starts at line 5, so `greet` is on line 6 — the offset must carry
        // the four template lines above the block.
        Assert.Equal(6, greet.StartLine);
        Assert.Equal(CodeGraphLanguage.Vue, greet.Language);

        // The template `<div>` is lowercase HTML (not a component ref); `greet()` in the
        // template is captured as a component/call ref by name only when PascalCase — it
        // is not here, so at minimum the component node exists and is named for the file.
        Assert.Contains(r.Nodes, n => n.Kind == CodeGraphNodeKind.Component && n.Name == "App");
    }

    // Astro frontmatter (--- fenced, no leading newline) delegated as TypeScript.
    [Fact]
    public void Astro_FrontmatterFunction_IsExtractedAtOffsetAdjustedLine()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.TypeScript))
        {
            return;
        }

        const string astro =
            "---\n" +                          // line 1 (opening fence)
            "function helper(): number {\n" +  // line 2
            "  return compute()\n" +           // line 3
            "}\n" +                             // line 4
            "---\n" +                           // line 5 (closing fence)
            "<div>{helper()}</div>\n";          // line 6

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Astro, "src/components/Card.astro", astro);

        CodeGraphNode helper = Assert.Single(r.Nodes, n => n.Kind == CodeGraphNodeKind.Function && n.Name == "helper");
        // Frontmatter content begins on line 2, so `helper` is on line 2 of the SFC.
        Assert.Equal(2, helper.StartLine);
        Assert.Equal(CodeGraphLanguage.Astro, helper.Language);
        Assert.Equal("src/components/Card.astro", helper.FilePath);
        // `compute()` inside the frontmatter is captured as a call reference.
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.Calls && x.ReferenceName == "compute");
    }

    // Template PascalCase tags become component references (resolved by the framework
    // resolver later). Pure-regex — no grammar needed.
    [Fact]
    public void Vue_TemplateComponentUsage_EmitsReference()
    {
        const string vue =
            "<template>\n" +
            "  <UserCard :id=\"1\" />\n" +
            "  <my-widget />\n" +
            "  <div />\n" +
            "</template>\n";

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Vue, "src/App.vue", vue);

        // PascalCase -> component ref; kebab-case folded to Pascal; native HTML skipped.
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.References && x.ReferenceName == "UserCard");
        Assert.Contains(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.References && x.ReferenceName == "MyWidget");
        Assert.DoesNotContain(r.UnresolvedReferences, x => x.ReferenceName == "div");
    }
}

// =============================================================================
// Vue / Svelte / Astro framework resolvers. Instantiated directly (the lead wires
// them into CodeGraphFrameworkResolverCatalog separately).
// =============================================================================
public sealed class CodeGraphSfcResolverTests
{
    // Minimal in-memory context — GetNodesByName / GetNodesInFile / GetAllFiles /
    // FileExists cover every resolver path exercised here.
    private sealed class FakeContext(IReadOnlyList<CodeGraphNode> nodes, IReadOnlyList<string>? files = null)
        : CodeGraphResolutionContext
    {
        private readonly IReadOnlyList<string> files = files ?? Array.Empty<string>();

        public override IReadOnlyList<CodeGraphNode> GetNodesInFile(string filePath)
        {
            var list = new List<CodeGraphNode>();
            foreach (var n in nodes)
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
            foreach (var n in nodes)
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

        public override bool FileExists(string filePath) => files.Contains(filePath);

        public override string? ReadFile(string filePath) => null;

        public override string GetProjectRoot() => "/tmp/proj";

        public override IReadOnlyList<string> GetAllFiles() => files;

        public override IReadOnlyList<CodeGraphImportMapping> GetImportMappings(string filePath, string language) =>
            Array.Empty<CodeGraphImportMapping>();
    }

    private static CodeGraphUnresolvedReference Ref(string name, string kind, string filePath, string language) =>
        new("component:from", name, kind, 1, 0, filePath, language, null, null);

    // --- Names (reported to the lead for catalog wiring) ---
    [Fact]
    public void Names_AreVueSvelteAstro()
    {
        Assert.Equal("vue", new CodeGraphVueResolver().Name);
        Assert.Equal("svelte", new CodeGraphSvelteResolver().Name);
        Assert.Equal("astro", new CodeGraphAstroResolver().Name);
    }

    [Fact]
    public void Detect_MatchesByFileExtension()
    {
        var vueCtx = new FakeContext(Array.Empty<CodeGraphNode>(), new[] { "src/App.vue" });
        var svelteCtx = new FakeContext(Array.Empty<CodeGraphNode>(), new[] { "src/App.svelte" });
        var astroCtx = new FakeContext(Array.Empty<CodeGraphNode>(), new[] { "src/pages/index.astro" });

        Assert.True(new CodeGraphVueResolver().Detect(vueCtx));
        Assert.True(new CodeGraphSvelteResolver().Detect(svelteCtx));
        Assert.True(new CodeGraphAstroResolver().Detect(astroCtx));
        // A framework does not detect on an unrelated project.
        Assert.False(new CodeGraphVueResolver().Detect(svelteCtx));
    }

    // --- Framework-provided references resolve to the from-node (high confidence) ---
    [Fact]
    public void Resolve_FrameworkProvidedReferences_ResolveToFromNode()
    {
        var ctx = new FakeContext(Array.Empty<CodeGraphNode>());

        var vue = new CodeGraphVueResolver().Resolve(
            Ref("defineProps", CodeGraphEdgeKind.Calls, "src/App.vue", CodeGraphLanguage.Vue), ctx);
        Assert.NotNull(vue);
        Assert.Equal("component:from", vue!.TargetId);
        Assert.Equal(CodeGraphResolvedBy.Framework, vue.ResolvedBy);
        Assert.True(vue.Confidence >= 0.9);

        var svelte = new CodeGraphSvelteResolver().Resolve(
            Ref("$state", CodeGraphEdgeKind.Calls, "src/App.svelte", CodeGraphLanguage.Svelte), ctx);
        Assert.NotNull(svelte);
        Assert.Equal("component:from", svelte!.TargetId);

        var astro = new CodeGraphAstroResolver().Resolve(
            Ref("Astro.props", CodeGraphEdgeKind.References, "src/pages/index.astro", CodeGraphLanguage.Astro), ctx);
        Assert.NotNull(astro);
        Assert.Equal("component:from", astro!.TargetId);
    }

    // --- PascalCase component references resolve to a component node ---
    [Fact]
    public void Resolve_VueComponentCall_LinksToComponentNode()
    {
        var comp = CodeGraphTestSupport.MakeNode(
            "component:card", "UserCard", CodeGraphNodeKind.Component, "src/components/UserCard.vue", 1,
            language: CodeGraphLanguage.Vue);
        var ctx = new FakeContext(new[] { comp }, new[] { "src/components/UserCard.vue" });

        var resolved = new CodeGraphVueResolver().Resolve(
            Ref("UserCard", CodeGraphEdgeKind.Calls, "src/components/UserCard.vue", CodeGraphLanguage.Vue), ctx);

        Assert.NotNull(resolved);
        Assert.Equal("component:card", resolved!.TargetId);
        Assert.Equal(CodeGraphResolvedBy.Framework, resolved.ResolvedBy);
    }

    // --- File-based route extraction ---
    // The TS uses indexOf('/pages/') (leading slash required), so a real Nuxt path is
    // nested under a source dir — a root-level `pages/…` deliberately does not match.
    [Fact]
    public void Extract_VueNuxtPageRoute_EmitsRouteNode()
    {
        CodeGraphFrameworkExtraction? ex = new CodeGraphVueResolver().Extract("src/pages/users/[id].vue", string.Empty);
        Assert.NotNull(ex);
        CodeGraphNode route = Assert.Single(ex!.Nodes);
        Assert.Equal(CodeGraphNodeKind.Route, route.Kind);
        Assert.Equal("/users/:id", route.Name);
        Assert.Equal(CodeGraphLanguage.Vue, route.Language);
    }

    [Fact]
    public void Extract_VueNuxtApiRoute_EmitsRouteNode()
    {
        CodeGraphFrameworkExtraction? ex = new CodeGraphVueResolver().Extract("src/server/api/users/index.ts", string.Empty);
        Assert.NotNull(ex);
        Assert.Contains(ex!.Nodes, n => n.Kind == CodeGraphNodeKind.Route && n.Name == "/api/users");
    }

    [Fact]
    public void Extract_SvelteKitRoute_EmitsRouteNode()
    {
        CodeGraphFrameworkExtraction? ex = new CodeGraphSvelteResolver().Extract("src/routes/blog/[slug]/+page.svelte", string.Empty);
        Assert.NotNull(ex);
        CodeGraphNode route = Assert.Single(ex!.Nodes);
        Assert.Equal(CodeGraphNodeKind.Route, route.Kind);
        Assert.Equal("/blog/:slug", route.Name);
        Assert.Equal(CodeGraphLanguage.Svelte, route.Language);
    }

    // A non-route .svelte file (a plain component) yields no route node.
    [Fact]
    public void Extract_SvelteNonRouteFile_EmitsNoRoute()
    {
        CodeGraphFrameworkExtraction? ex = new CodeGraphSvelteResolver().Extract("src/lib/Button.svelte", string.Empty);
        Assert.NotNull(ex);
        Assert.Empty(ex!.Nodes);
    }

    [Fact]
    public void Extract_AstroPageRoute_EmitsRouteNode()
    {
        CodeGraphFrameworkExtraction? ex = new CodeGraphAstroResolver().Extract("src/pages/blog/[slug].astro", string.Empty);
        Assert.NotNull(ex);
        CodeGraphNode route = Assert.Single(ex!.Nodes);
        Assert.Equal(CodeGraphNodeKind.Route, route.Kind);
        Assert.Equal("/blog/:slug", route.Name);
        Assert.Equal(CodeGraphLanguage.Astro, route.Language);
    }

    // A catch-all dynamic segment maps to the `*param` form.
    [Fact]
    public void Extract_AstroCatchAllRoute_MapsToStarParam()
    {
        CodeGraphFrameworkExtraction? ex = new CodeGraphAstroResolver().Extract("src/pages/docs/[...path].astro", string.Empty);
        Assert.NotNull(ex);
        Assert.Contains(ex!.Nodes, n => n.Kind == CodeGraphNodeKind.Route && n.Name == "/docs/*path");
    }
}
