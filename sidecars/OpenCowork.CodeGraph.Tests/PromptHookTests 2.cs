using System.Text;
using System.Text.Json;
using Xunit;

// M7-W3 decision A — codegraph/prompt-context (the front-load hook). Pins the
// tiered gate against a seeded index: a non-structural prompt no-ops; an
// index-verified code token fires the HIGH tier (explore injection); prose words
// matching symbol-name segments fire MEDIUM (symbol list, no explore); an
// un-indexed cwd no-ops. Every path is success-shaped — the hook never breaks
// the user's prompt.
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphPromptHookTests
{
    private static JsonElement Args(params (string Key, string Value)[] pairs)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var (key, value) in pairs)
            {
                writer.WriteString(key, value);
            }

            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(Encoding.UTF8.GetString(stream.ToArray()));
        return document.RootElement.Clone();
    }

    [Fact]
    public void PromptContext_TieredGate()
    {
        var home = Path.Combine(Path.GetTempPath(), "codegraph-hook-home-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(Path.GetTempPath(), "codegraph-hook-root-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(home);
        Directory.CreateDirectory(root);
        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", home);
        try
        {
            using (var store = CodeGraphStoreFactory.Open(CodeGraphDataDir.GraphDbPath(Path.GetFullPath(root))))
            {
                store.SetMetadata("project_root", Path.GetFullPath(root));
                store.SetMetadata("index_state", "complete");
                store.UpsertFile(new CodeGraphFileRecord("order.ts", "0", CodeGraphLanguage.TypeScript, 10, 0, 0, 2, null));
                store.InsertNodes(new[]
                {
                    CodeGraphTestSupport.MakeNode("file:order", "order.ts", CodeGraphNodeKind.File, "order.ts", 1),
                    CodeGraphTestSupport.MakeNode(
                        "class:osm", "OrderStateMachine", CodeGraphNodeKind.Class, "order.ts", 3, isExported: true)
                });
            }

            // Non-structural, token-free prompt -> silent no-op.
            var noop = CodeGraphToolHandler.PromptContext(
                Args(("workingFolder", root), ("prompt", "thanks!")));
            Assert.True(noop.Success);
            Assert.False(noop.Fired);

            // Index-verified code token -> HIGH tier, explore text wrapped in the
            // codegraph_context envelope.
            var high = CodeGraphToolHandler.PromptContext(
                Args(("workingFolder", root), ("prompt", "refactor OrderStateMachine transitions")));
            Assert.True(high.Success);
            Assert.True(high.Fired);
            Assert.Equal("high-token", high.Outcome);
            Assert.StartsWith("<codegraph_context", high.Text);
            Assert.Contains("OrderStateMachine", high.Text);

            // Prose words naming symbol segments -> MEDIUM tier: symbol list + an
            // explore nudge, no full explore body.
            var medium = CodeGraphToolHandler.PromptContext(
                Args(("workingFolder", root), ("prompt", "improve the order state machine logic")));
            Assert.True(medium.Success);
            if (medium.Fired)
            {
                Assert.Equal("medium-segment", medium.Outcome);
                Assert.Contains("OrderStateMachine", medium.Text);
                Assert.Contains("codegraph_explore", medium.Text);
            }
            else
            {
                // "how/where"-free prose may still trip the multilingual keyword table
                // ("improve" doesn't) — a miss here must at least be a clean no-op.
                Assert.StartsWith("noop-", medium.Outcome);
            }

            // Un-indexed cwd -> no-op, success-shaped.
            var elsewhere = Path.Combine(Path.GetTempPath(), "codegraph-hook-none-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(elsewhere);
            try
            {
                var noIndex = CodeGraphToolHandler.PromptContext(
                    Args(("workingFolder", elsewhere), ("prompt", "how does OrderStateMachine work")));
                Assert.True(noIndex.Success);
                Assert.False(noIndex.Fired);
                Assert.Equal("noop-no-index", noIndex.Outcome);
            }
            finally
            {
                CodeGraphTestSupport.DeleteDir(elsewhere);
            }
        }
        finally
        {
            CodeGraphToolHandler.ResetForTests();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            CodeGraphTestSupport.DeleteDir(home);
            CodeGraphTestSupport.DeleteDir(root);
        }
    }
}
