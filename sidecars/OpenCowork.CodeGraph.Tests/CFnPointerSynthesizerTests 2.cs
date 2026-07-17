using Xunit;

// =============================================================================
// CodeGraphCFnPointerSynthesizer goldens — the FULL faithful port of
// c-fnptr-synthesizer.ts, exercising the C-preprocessor front-end (macro
// expansion, object-macro type aliases, and the #include unit machinery) that
// the reduced port dropped. Grammar-free: the synthesizer works on RAW C text
// (comment-stripped + preprocessed), so these seed a tiny in-memory context with
// nodes + file contents and assert the fn-pointer dispatch edges it synthesizes.
//
// A minimal FakeContext serves GetAllFiles / ReadFile / FileExists / node lookups
// (mirrors the M7 niche-wiring fake). No store, no tree-sitter, no disk.
// =============================================================================
public sealed class CodeGraphCFnPointerSynthesizerTests
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

    private static CodeGraphNode Fn(string id, string name, string file, int line) =>
        CodeGraphTestSupport.MakeNode(id, name, CodeGraphNodeKind.Function, file, line, line, CodeGraphLanguage.C);

    private static CodeGraphNode Struct(string id, string name, string file, int start, int end) =>
        CodeGraphTestSupport.MakeNode(id, name, CodeGraphNodeKind.Struct, file, start, end, CodeGraphLanguage.C);

    // -------------------------------------------------------------------------
    // 1. MACRO-BUILT command table in a single C file. `#define CMD(name, fn)
    //    { name, fn }` builds `struct Cmd cmds[] = { CMD("get", getCmd), … }`.
    //    Without function-like macro expansion the entries read as opaque calls;
    //    with it, the positional `proc` slot yields getCmd/setCmd, and the
    //    dispatcher `c->proc(0)` resolves to both.
    // -------------------------------------------------------------------------
    [Fact]
    public void MacroBuiltTable_ResolvesFnPointerDispatch_ToMacroExpandedHandlers()
    {
        const string src =
            "typedef int (*CmdProc)(int);\n" +                                       // 1
            "struct Cmd { const char *name; CmdProc proc; };\n" +                    // 2
            "#define CMD(name, fn) { name, fn }\n" +                                 // 3
            "struct Cmd cmds[] = { CMD(\"get\", getCmd), CMD(\"set\", setCmd) };\n" + // 4
            "int getCmd(int x) { return x + 1; }\n" +                                // 5
            "int setCmd(int x) { return x + 2; }\n" +                                // 6
            "int run(struct Cmd *c) { return c->proc(0); }\n";                       // 7

        var nodes = new[]
        {
            Struct("struct:Cmd", "Cmd", "cmds.c", 2, 2),
            Fn("fn:getCmd", "getCmd", "cmds.c", 5),
            Fn("fn:setCmd", "setCmd", "cmds.c", 6),
            Fn("fn:run", "run", "cmds.c", 7)
        };

        var ctx = new FakeContext(
            new[] { "cmds.c" },
            new Dictionary<string, string> { ["cmds.c"] = src },
            nodes);

        var edges = new CodeGraphCFnPointerSynthesizer()
            .Synthesize(ctx, CancellationToken.None)
            .ToList();

        Assert.Contains(edges, e => e.Source == "fn:run" && e.Target == "fn:getCmd" && e.Kind == CodeGraphEdgeKind.Calls);
        Assert.Contains(edges, e => e.Source == "fn:run" && e.Target == "fn:setCmd" && e.Kind == CodeGraphEdgeKind.Calls);
        // The edge carries the (struct.field) provenance in metadata.
        Assert.All(
            edges.Where(e => e.Source == "fn:run"),
            e => Assert.Contains("Cmd.proc", e.Metadata ?? string.Empty));
    }

    // -------------------------------------------------------------------------
    // 2. #include unit machinery + object-macro type alias. The command table
    //    lives in a generated, NON-indexed `commands.def`; the macro `MAKE_CMD`
    //    and the struct-type alias `#define CMD_STRUCT Cmd` live in the includer.
    //    The include is scanned with the includer's effective macro env (BuildEnv),
    //    its struct type resolved through the object-macro alias (ResolveTypeName),
    //    and its `MAKE_CMD(…)` entries expanded — so the dispatcher in the includer
    //    resolves to the handlers registered from the included file.
    // -------------------------------------------------------------------------
    [Fact]
    public void IncludedGeneratedTable_WithMacroAliasAndExpansion_ResolvesDispatch()
    {
        const string mainSrc =
            "typedef int (*CmdProc)(int);\n" +                    // 1
            "struct Cmd { const char *name; CmdProc proc; };\n" + // 2
            "#define CMD_STRUCT Cmd\n" +                          // 3  object-macro type alias
            "#define MAKE_CMD(nm, fn) { nm, fn }\n" +             // 4  function-like macro
            "#include \"commands.def\"\n" +                      // 5  brings in the table
            "int getCmd(int x) { return x; }\n" +                // 6
            "int setCmd(int x) { return x; }\n" +                // 7
            "int run(struct Cmd *c) { return c->proc(0); }\n";   // 8

        // Generated table file — NOT in GetAllFiles (never indexed), read on demand.
        const string defSrc =
            "CMD_STRUCT cmdtable[] = {\n" +
            "  MAKE_CMD(\"get\", getCmd),\n" +
            "  MAKE_CMD(\"set\", setCmd)\n" +
            "};\n";

        var nodes = new[]
        {
            Struct("struct:Cmd", "Cmd", "main.c", 2, 2),
            Fn("fn:getCmd", "getCmd", "main.c", 6),
            Fn("fn:setCmd", "setCmd", "main.c", 7),
            Fn("fn:run", "run", "main.c", 8)
        };

        var ctx = new FakeContext(
            new[] { "main.c" }, // commands.def deliberately absent — a non-indexed include
            new Dictionary<string, string>
            {
                ["main.c"] = mainSrc,
                ["commands.def"] = defSrc
            },
            nodes);

        var edges = new CodeGraphCFnPointerSynthesizer()
            .Synthesize(ctx, CancellationToken.None)
            .ToList();

        Assert.Contains(edges, e => e.Source == "fn:run" && e.Target == "fn:getCmd" && e.Kind == CodeGraphEdgeKind.Calls);
        Assert.Contains(edges, e => e.Source == "fn:run" && e.Target == "fn:setCmd" && e.Kind == CodeGraphEdgeKind.Calls);
    }
}
