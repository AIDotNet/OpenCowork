using System.Text;
using System.Text.Json;
using Xunit;

// M7-W3 codegraph/analytics — the on-demand viz panels. Pins: a two-file import
// ring surfaces as a circular dependency; a non-exported, never-referenced
// function surfaces as dead code while a referenced one doesn't; totals match the
// (uncapped) list lengths on a small project.
[Collection("CodeGraphHomeEnv")]
public sealed class CodeGraphAnalyticsRpcTests
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
    public void Analytics_ReportsCycleAndDeadCode()
    {
        var home = Path.Combine(Path.GetTempPath(), "codegraph-analytics-home-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(Path.GetTempPath(), "codegraph-analytics-root-" + Guid.NewGuid().ToString("N"));
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
                store.UpsertFile(new CodeGraphFileRecord("a.ts", "0", CodeGraphLanguage.TypeScript, 10, 0, 0, 2, null));
                store.UpsertFile(new CodeGraphFileRecord("b.ts", "0", CodeGraphLanguage.TypeScript, 10, 0, 0, 2, null));
                store.InsertNodes(new[]
                {
                    CodeGraphTestSupport.MakeNode("file:a", "a.ts", CodeGraphNodeKind.File, "a.ts", 1),
                    CodeGraphTestSupport.MakeNode("file:b", "b.ts", CodeGraphNodeKind.File, "b.ts", 1),
                    CodeGraphTestSupport.MakeNode("func:orphan", "orphan", CodeGraphNodeKind.Function, "a.ts", 5),
                    CodeGraphTestSupport.MakeNode("func:used", "used", CodeGraphNodeKind.Function, "b.ts", 5),
                    CodeGraphTestSupport.MakeNode("func:main", "main", CodeGraphNodeKind.Function, "a.ts", 9)
                });
                store.InsertEdges(new[]
                {
                    // a.ts <-> b.ts import ring = one circular dependency.
                    CodeGraphTestSupport.MakeEdge("file:a", "file:b", CodeGraphEdgeKind.Imports, 1),
                    CodeGraphTestSupport.MakeEdge("file:b", "file:a", CodeGraphEdgeKind.Imports, 1),
                    // `used` has a non-contains incoming edge -> NOT dead.
                    CodeGraphTestSupport.MakeEdge("func:main", "func:used", CodeGraphEdgeKind.Calls, 10),
                    // contains edges don't count as usage.
                    CodeGraphTestSupport.MakeEdge("file:a", "func:orphan", CodeGraphEdgeKind.Contains)
                });
            }

            var result = CodeGraphToolHandler.Analytics(Args(("workingFolder", root)));

            Assert.True(result.Success);
            Assert.True(result.CircularTotal >= 1);
            Assert.Equal(result.CircularTotal, result.CircularDependencies.Count);
            Assert.Contains(result.CircularDependencies, c => c.Files.Contains("a.ts") && c.Files.Contains("b.ts"));

            Assert.Contains(result.DeadCode, d => d.Name == "orphan" && d.FilePath == "a.ts");
            Assert.DoesNotContain(result.DeadCode, d => d.Name == "used");
            Assert.Equal(result.DeadCodeTotal, result.DeadCode.Count);
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
