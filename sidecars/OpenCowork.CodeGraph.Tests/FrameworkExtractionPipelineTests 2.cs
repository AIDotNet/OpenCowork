using System.Text;
using Xunit;

// -----------------------------------------------------------------------------
// Framework per-file Extract() pipeline test — the tree-sitter.ts:6632 merge.
// Proves the FULL wiring: pre-parse detection from the scanned file list
// (ensureDetectedFrameworks), per-file fw.Extract() during IndexAll, route nodes
// persisted with the file, and the route→handler reference resolving to an edge.
//
// Uses an express-shaped project: package.json declares the express dependency
// (the detector reads it from disk) and src/app.js registers a route whose
// handler is a named function in the same file.
//
// [Collection("CodeGraphHomeEnv")]: mutates the process-global CODEGRAPH_HOME.
// -----------------------------------------------------------------------------
[Collection("CodeGraphHomeEnv")]
public sealed class FrameworkExtractionPipelineTests
{
    [Fact]
    public async Task IndexAll_RunsFrameworkExtract_EmitsRouteNodes()
    {
        if (CodeGraphExtractionHarness.Grammars.GetLanguage(CodeGraphLanguage.JavaScript) is null)
        {
            return; // grammar not present in this environment — pipeline untestable
        }

        var temp = Path.Combine(Path.GetTempPath(), "cg-fwext-" + Guid.NewGuid().ToString("N"));
        var codegraphHome = Path.Combine(temp, "home");
        var project = Path.Combine(temp, "proj");
        Directory.CreateDirectory(Path.Combine(project, "src"));

        File.WriteAllText(
            Path.Combine(project, "package.json"),
            "{ \"name\": \"fixture\", \"dependencies\": { \"express\": \"^4.18.0\" } }",
            Encoding.UTF8);
        File.WriteAllText(
            Path.Combine(project, "src", "app.js"),
            "const express = require('express');\n" +
            "const app = express();\n" +
            "function listUsers(req, res) {\n" +
            "  res.json([]);\n" +
            "}\n" +
            "app.get('/users', listUsers);\n" +
            "app.listen(3000);\n",
            Encoding.UTF8);

        var previousHome = Environment.GetEnvironmentVariable("CODEGRAPH_HOME");
        Environment.SetEnvironmentVariable("CODEGRAPH_HOME", codegraphHome);
        CodeGraphEngine? engine = null;
        try
        {
            // Full default extractor registry (the harness one only registers the
            // languages its own tests exercise — no javascript); grammars from the
            // dylib-loading harness.
            engine = CodeGraphEngine.Init(
                project,
                extractors: CodeGraphExtractorRegistry.CreateDefault(),
                grammars: CodeGraphExtractionHarness.Grammars);
            var result = await engine.IndexAll();
            Assert.True(
                result.FilesIndexed >= 1,
                $"app.js should index — indexed={result.FilesIndexed} " +
                $"errors=[{string.Join(" | ", result.Errors.Select(e => e.Message))}]");

            // The express framework detected (package.json) + per-file Extract ran:
            // a `route` node for GET /users exists, stored with src/app.js.
            var routes = engine.GetNodesByKind(CodeGraphNodeKind.Route);
            Assert.NotEmpty(routes);
            var route = routes.FirstOrDefault(r => r.Name.Contains("/users", StringComparison.Ordinal));
            Assert.NotNull(route);
            Assert.Contains("app.js", route!.FilePath, StringComparison.Ordinal);

            // The route -> handler reference resolved to an edge onto listUsers.
            var handler = engine.GetNodesByName("listUsers").FirstOrDefault();
            Assert.NotNull(handler);
            var routeEdges = engine.GetOutgoingEdges(route.Id);
            Assert.Contains(routeEdges, e => e.Target == handler!.Id);
        }
        finally
        {
            engine?.Dispose();
            Environment.SetEnvironmentVariable("CODEGRAPH_HOME", previousHome);
            try { Directory.Delete(temp, recursive: true); } catch { /* best-effort */ }
        }
    }
}
