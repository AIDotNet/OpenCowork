using System.Text;
using Xunit;

// =============================================================================
// CFML (ColdFusion) three-grammar dialect-switcher goldens (analysis/01 §R6). The
// CodeGraphCfmlEmbeddedExtractor sniffs bare-script vs tag-based CFML, then delegates
// <cfscript> bodies to the cfscript grammar and <cfquery> bodies to cfquery,
// offsetting delegated line positions back to full-file coordinates.
//
// The cfml/cfscript/cfquery grammars are NOT in the bootstrap set, so a real parse
// can't be exercised here. These tests cover the pure region-splitting / dispatch
// logic (IsBareScriptCfml) and the routing + grammar-degradation contract (a missing
// grammar returns partial/empty and NEVER throws). The delegation is grammar-gated,
// so any full-parse assertion self-skips when the grammar is absent.
// =============================================================================
public sealed class CodeGraphCfmlExtractionTests
{
    private static readonly CodeGraphGrammarRegistry Grammars = new();

    private static CodeGraphExtractionResult Extract(string language, string filePath, string content) =>
        CodeGraphExtractor.ExtractFromSource(filePath, Encoding.UTF8.GetBytes(content), language, null, Grammars);

    // --- Routing: HasEmbeddedExtractor claims .cfc/.cfm (cfml) and .cfs (cfscript) ---
    [Theory]
    [InlineData("model/UserService.cfc", CodeGraphLanguage.Cfml, true)]
    [InlineData("views/index.cfm", CodeGraphLanguage.Cfml, true)]
    [InlineData("scripts/util.cfs", CodeGraphLanguage.CfScript, true)]
    [InlineData("src/app.ts", CodeGraphLanguage.TypeScript, false)] // grammar language, not embedded
    public void HasEmbeddedExtractor_ClaimsCfmlLanguages(string path, string language, bool expected) =>
        Assert.Equal(expected, CodeGraphExtractor.HasEmbeddedExtractor(path, language));

    // --- IsBareScriptCfml: the dialect sniff that splits the two delegation paths ---
    [Theory]
    // Tag-based: first real token is `<`.
    [InlineData("<cfcomponent>\n<cffunction name=\"init\"></cffunction>\n</cfcomponent>", false)]
    [InlineData("  \n\t<cfif true><cfset x = 1></cfif>", false)]
    // Bare-script: first real token isn't `<`.
    [InlineData("component {\n  function init() {}\n}", true)]
    [InlineData("// a leading comment\ncomponent {}", true)]
    [InlineData("/* block\n comment */\ninterface {}", true)]
    // Comments/whitespace preceding a tag must not flip the verdict to script.
    [InlineData("// header\n<cfcomponent></cfcomponent>", false)]
    // Leading UTF-8 BOM is skipped before the first real token.
    [InlineData("\uFEFF<cfcomponent></cfcomponent>", false)]
    [InlineData("\uFEFFcomponent {}", true)]
    // Empty / whitespace-only → treated as script (no-op either way).
    [InlineData("", true)]
    [InlineData("   \n\t  ", true)]
    public void IsBareScriptCfml_ClassifiesFirstRealToken(string source, bool expected) =>
        Assert.Equal(expected, CodeGraphCfmlEmbeddedExtractor.IsBareScriptCfml(source));

    // --- Grammar-degradation: a missing grammar returns partial/empty, never throws ---
    // With no cfml/cfscript grammar in the bootstrap host, both dialect paths degrade
    // to a diagnostic with no nodes. When the grammars ARE present, we don't assert on
    // the parsed shape here — only that extraction stays exception-free.
    [Fact]
    public void TagBasedCfml_DegradesGracefully_WhenGrammarAbsent()
    {
        const string cfc =
            "<cfcomponent name=\"UserService\" extends=\"Base\">\n" +
            "  <cffunction name=\"save\" access=\"public\"></cffunction>\n" +
            "</cfcomponent>\n";

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.Cfml, "model/UserService.cfc", cfc);

        if (!Grammars.GetLanguage(CodeGraphLanguage.Cfml).HasValue)
        {
            Assert.Empty(r.Nodes);
            Assert.Contains(r.Errors, e => e.Code == "unsupported_language");
        }
    }

    [Fact]
    public void BareScriptCfml_DegradesGracefully_WhenGrammarAbsent()
    {
        const string cfc = "component {\n  function save() {}\n}\n";

        CodeGraphExtractionResult r = Extract(CodeGraphLanguage.CfScript, "scripts/util.cfs", cfc);

        if (!Grammars.GetLanguage(CodeGraphLanguage.CfScript).HasValue)
        {
            Assert.Empty(r.Nodes);
            Assert.Contains(r.Errors, e => e.Code == "grammar_unavailable");
        }
    }
}
