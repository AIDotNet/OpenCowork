using Xunit;

// =============================================================================
// Dynamic-dispatch boundary detection (#687) — grammar-free unit tests for
// CodeGraphDynamicBoundaries.ScanDynamicDispatch. The detector works on RAW source
// strings (no tree-sitter), so these run everywhere. They pin the load-bearing
// behaviors: a dynamic-dispatch site FIRES, a plain call does NOT, and comment/string
// stripping prevents false positives.
// =============================================================================
public sealed class DynamicBoundariesTests
{
    [Fact]
    public void FlagsComputedMemberCallWithStaticKey()
    {
        var body = "function dispatch(action) {\n  handlers['save'](payload);\n}";
        var matches = CodeGraphDynamicBoundaries.ScanDynamicDispatch(body, CodeGraphLanguage.TypeScript, 10);

        var hit = Assert.Single(matches);
        Assert.Equal("computed-call", hit.Form);
        Assert.Equal("save", hit.Key); // string literal key sliced from the ORIGINAL source.
        Assert.Equal(11, hit.Line);     // fileStartLine (10) + 1 newline before the site.
    }

    [Fact]
    public void FlagsEventEmitAndDynamicImport()
    {
        var emit = CodeGraphDynamicBoundaries.ScanDynamicDispatch(
            "function run() {\n  emitter.emit(eventName, payload);\n}", CodeGraphLanguage.JavaScript, 1);
        Assert.Contains(emit, m => m.Form == "var-key-dispatch");

        var dynImport = CodeGraphDynamicBoundaries.ScanDynamicDispatch(
            "async function load(name) {\n  const mod = await import(name);\n  return mod;\n}",
            CodeGraphLanguage.JavaScript,
            1);
        Assert.Contains(dynImport, m => m.Form == "dynamic-import");
    }

    [Fact]
    public void DoesNotFlagPlainFunctionCalls()
    {
        var body = "function handle(input) {\n  const x = compute(a, b);\n  return this.service.process(x);\n}";
        var matches = CodeGraphDynamicBoundaries.ScanDynamicDispatch(body, CodeGraphLanguage.TypeScript, 1);

        Assert.Empty(matches);
    }

    [Fact]
    public void DoesNotFlagCommentedOutOrStringEmbeddedDispatch()
    {
        // The computed call is commented out (line comment) and also appears inside a
        // string literal — comment/string stripping must blank both so neither fires.
        var body =
            "function handle(action) {\n"
            + "  // handlers[action.type](payload) is the old dynamic path\n"
            + "  const doc = \"handlers[action.type](payload)\";\n"
            + "  return direct(doc);\n"
            + "}";
        var matches = CodeGraphDynamicBoundaries.ScanDynamicDispatch(body, CodeGraphLanguage.TypeScript, 1);

        Assert.Empty(matches);
    }
}
