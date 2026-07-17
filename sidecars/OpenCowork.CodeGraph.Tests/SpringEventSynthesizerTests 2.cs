using Xunit;

// =============================================================================
// CodeGraphSpringEventSynthesizer golden — grammar-free (the synthesizer works on
// RAW Java text: comment-stripped publishers + annotation-block scans). Seeds a
// tiny in-memory context (the CFnPointer FakeContext pattern) with an
// @EventListener handler, an ApplicationListener<X> handler, and a
// publishEvent(new X(...)) dispatch site, then asserts the synthesized calls
// edges. No store, no tree-sitter, no disk.
// =============================================================================
public sealed class CodeGraphSpringEventSynthesizerTests
{
    private sealed class FakeContext : CodeGraphResolutionContext
    {
        private readonly IReadOnlyList<string> files;
        private readonly IReadOnlyDictionary<string, string> contents;
        private readonly IReadOnlyList<CodeGraphNode> nodes;

        public FakeContext(
            IReadOnlyList<string> files,
            IReadOnlyDictionary<string, string> contents,
            IReadOnlyList<CodeGraphNode> nodes)
        {
            this.files = files;
            this.contents = contents;
            this.nodes = nodes;
        }

        public override IReadOnlyList<CodeGraphNode> GetNodesInFile(string filePath) =>
            nodes.Where(n => n.FilePath == filePath).ToList();

        public override IReadOnlyList<CodeGraphNode> GetNodesByName(string name) =>
            nodes.Where(n => n.Name == name).ToList();

        public override IReadOnlyList<CodeGraphNode> GetNodesByQualifiedName(string qualifiedName) =>
            Array.Empty<CodeGraphNode>();

        public override IReadOnlyList<CodeGraphNode> GetNodesByKind(string kind) =>
            nodes.Where(n => n.Kind == kind).ToList();

        public override IReadOnlyList<CodeGraphNode> GetNodesByLowerName(string lowerName) =>
            Array.Empty<CodeGraphNode>();

        public override bool FileExists(string filePath) => contents.ContainsKey(filePath);

        public override string? ReadFile(string filePath) =>
            contents.TryGetValue(filePath, out var c) ? c : null;

        public override string GetProjectRoot() => "/tmp/proj";

        public override IReadOnlyList<string> GetAllFiles() => files;

        public override IReadOnlyList<CodeGraphImportMapping> GetImportMappings(string filePath, string language) =>
            Array.Empty<CodeGraphImportMapping>();
    }

    private static CodeGraphNode Method(string id, string name, string file, int start, int end, string? signature) =>
        CodeGraphTestSupport.MakeNode(
            id, name, CodeGraphNodeKind.Method, file, start, end, CodeGraphLanguage.Java)
        with
        { Signature = signature };

    // -------------------------------------------------------------------------
    // publishEvent(new PasswordChangedEvent(...)) in AccountService bridges to BOTH
    // listener shapes keyed by the event type: an `@EventListener` method (event
    // type from the first param of the signature; the method node's startLine is
    // the annotation line — Java nodes include leading annotations) and the older
    // `implements ApplicationListener<X>` onApplicationEvent method.
    // -------------------------------------------------------------------------
    [Fact]
    public void PublishEvent_BridgesToEventListenerAndApplicationListener()
    {
        const string publisherSrc =
            "public class AccountService {\n" +                                          // 1
            "    private final ApplicationEventPublisher eventPublisher;\n" +            // 2
            "    public void changePassword(String user) {\n" +                          // 3
            "        eventPublisher.publishEvent(new PasswordChangedEvent(this, user));\n" + // 4
            "    }\n" +                                                                  // 5
            "}\n";                                                                       // 6

        const string listenerSrc =
            "public class RememberMeTokenRevoker {\n" +                                  // 1
            "    @EventListener\n" +                                                     // 2
            "    public void onPasswordChanged(PasswordChangedEvent event) {\n" +        // 3
            "    }\n" +                                                                  // 4
            "}\n";                                                                       // 5

        const string appListenerSrc =
            "public class AuditLogger implements ApplicationListener<PasswordChangedEvent> {\n" + // 1
            "    public void onApplicationEvent(PasswordChangedEvent event) {\n" +       // 2
            "    }\n" +                                                                  // 3
            "}\n";                                                                       // 4

        var nodes = new[]
        {
            Method("m:changePassword", "changePassword", "AccountService.java", 3, 5,
                "void (String user)"),
            // startLine 2 = the @EventListener line (annotations are in the range).
            Method("m:onPasswordChanged", "onPasswordChanged", "RememberMeTokenRevoker.java", 2, 4,
                "void (PasswordChangedEvent event)"),
            Method("m:onApplicationEvent", "onApplicationEvent", "AuditLogger.java", 2, 3,
                "void (PasswordChangedEvent event)")
        };

        var ctx = new FakeContext(
            new[] { "AccountService.java", "RememberMeTokenRevoker.java", "AuditLogger.java" },
            new Dictionary<string, string>
            {
                ["AccountService.java"] = publisherSrc,
                ["RememberMeTokenRevoker.java"] = listenerSrc,
                ["AuditLogger.java"] = appListenerSrc
            },
            nodes);

        var edges = new CodeGraphSpringEventSynthesizer()
            .Synthesize(ctx, CancellationToken.None)
            .ToList();

        Assert.Equal(2, edges.Count);
        Assert.Contains(edges, e =>
            e.Source == "m:changePassword" && e.Target == "m:onPasswordChanged" &&
            e.Kind == CodeGraphEdgeKind.Calls);
        Assert.Contains(edges, e =>
            e.Source == "m:changePassword" && e.Target == "m:onApplicationEvent" &&
            e.Kind == CodeGraphEdgeKind.Calls);
        // Metadata carries the synthesizer name, the event type, and the dispatch site.
        Assert.All(edges, e =>
        {
            Assert.Contains("\"synthesizedBy\":\"spring-event\"", e.Metadata ?? string.Empty);
            Assert.Contains("\"via\":\"PasswordChangedEvent\"", e.Metadata ?? string.Empty);
            Assert.Contains("AccountService.java:4", e.Metadata ?? string.Empty);
        });
    }
}
