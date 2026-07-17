using Xunit;

// =============================================================================
// M7-W1 import-resolver expansion goldens — the four branches the MVP deferred
// (Rust crate::/self::/super:: module paths, Lua/Luau require(...), Nix static
// path imports, PHP `use` mappings) plus ohpm oh-package.json5 workspaces.
// Mirrors the upstream expectations in import-resolver.ts (:46, :1372, :1436,
// :1445, :1010) and workspace-packages.ts (:68-:198). Same seeded-tier harness
// as CodeGraphResolutionSeededTests: a real temp store + real files on disk in
// the temp projectRoot (the resolver reads imports/config through the
// filesystem), no grammar needed.
// =============================================================================
public sealed class CodeGraphImportResolverExpansionTests : IDisposable
{
    private readonly CodeGraphStore store;
    private readonly string directory;

    public CodeGraphImportResolverExpansionTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out directory);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }

    private void WriteFile(string relativePath, string content)
    {
        var abs = Path.Combine(directory, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
        File.WriteAllText(abs, content);
    }

    private static CodeGraphUnresolvedReference Ref(
        string fromNodeId, string name, string kind, string filePath, string language, int line = 1)
        => new(
            FromNodeId: fromNodeId,
            ReferenceName: name,
            ReferenceKind: kind,
            Line: line,
            Column: 0,
            FilePath: filePath,
            Language: language,
            Candidates: null,
            RowId: null);

    private CodeGraphResolutionResult Resolve()
        => CodeGraphReferenceResolver.Create(store, directory)
            .ResolveAndPersistBatched(CancellationToken.None, 5000);

    // -------------------------------------------------------------------------
    // Rust: `crate::parser::parse` — module prefix maps to parser.rs, the leaf
    // symbol resolves inside it (import-resolver.ts:1764).
    // -------------------------------------------------------------------------
    [Fact]
    public void Rust_CratePath_ResolvesLeafSymbolInModuleFile()
    {
        WriteFile("lib.rs", "pub mod parser;\npub fn run() { crate::parser::parse(); }\n");
        WriteFile("parser.rs", "pub fn parse() {}\n");

        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:lib", "lib.rs", CodeGraphNodeKind.File, "lib.rs", 1, language: CodeGraphLanguage.Rust),
            CodeGraphTestSupport.MakeNode("func:run", "run", CodeGraphNodeKind.Function, "lib.rs", 2, language: CodeGraphLanguage.Rust),
            CodeGraphTestSupport.MakeNode("file:parser", "parser.rs", CodeGraphNodeKind.File, "parser.rs", 1, language: CodeGraphLanguage.Rust),
            CodeGraphTestSupport.MakeNode("func:parse", "parse", CodeGraphNodeKind.Function, "parser.rs", 1, language: CodeGraphLanguage.Rust, isExported: true)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("func:run", "crate::parser::parse", CodeGraphEdgeKind.Calls, "lib.rs", CodeGraphLanguage.Rust, line: 2)
        });

        var result = Resolve();

        Assert.Equal(1, result.Resolved);
        var edges = store.GetOutgoingEdges("func:run", new[] { CodeGraphEdgeKind.Calls });
        Assert.Contains(edges, e => e.Target == "func:parse");
    }

    // -------------------------------------------------------------------------
    // Rust: `super::util::helper` from a submodule anchors on the parent module
    // dir; `<seg>/mod.rs` is the fallback file shape (import-resolver.ts:1826).
    // -------------------------------------------------------------------------
    [Fact]
    public void Rust_SuperPath_ResolvesThroughModRs()
    {
        WriteFile("lib.rs", "pub mod util; pub mod worker;\n");
        WriteFile("util/mod.rs", "pub fn helper() {}\n");
        WriteFile("worker.rs", "pub fn work() { super::util::helper(); }\n");

        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:worker", "worker.rs", CodeGraphNodeKind.File, "worker.rs", 1, language: CodeGraphLanguage.Rust),
            CodeGraphTestSupport.MakeNode("func:work", "work", CodeGraphNodeKind.Function, "worker.rs", 1, language: CodeGraphLanguage.Rust),
            CodeGraphTestSupport.MakeNode("file:util", "mod.rs", CodeGraphNodeKind.File, "util/mod.rs", 1, language: CodeGraphLanguage.Rust),
            CodeGraphTestSupport.MakeNode("func:helper", "helper", CodeGraphNodeKind.Function, "util/mod.rs", 1, language: CodeGraphLanguage.Rust, isExported: true)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("func:work", "super::util::helper", CodeGraphEdgeKind.Calls, "worker.rs", CodeGraphLanguage.Rust)
        });

        var result = Resolve();

        Assert.Equal(1, result.Resolved);
        var edges = store.GetOutgoingEdges("func:work", new[] { CodeGraphEdgeKind.Calls });
        Assert.Contains(edges, e => e.Target == "func:helper");
    }

    // -------------------------------------------------------------------------
    // Lua: `require("telescope.config")` — dotted path becomes a /-suffix match
    // against the indexed file list (import-resolver.ts:1628).
    // -------------------------------------------------------------------------
    [Fact]
    public void Lua_Require_DottedPath_ResolvesToModuleFile()
    {
        WriteFile("main.lua", "local cfg = require(\"telescope.config\")\n");
        WriteFile("lua/telescope/config.lua", "return {}\n");

        store.UpsertFile(new CodeGraphFileRecord(
            "lua/telescope/config.lua", "0", CodeGraphLanguage.Lua, 10, 0, 0, 1, null));
        store.UpsertFile(new CodeGraphFileRecord(
            "main.lua", "0", CodeGraphLanguage.Lua, 10, 0, 0, 1, null));

        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:main", "main.lua", CodeGraphNodeKind.File, "main.lua", 1, language: CodeGraphLanguage.Lua),
            // `local cfg = require(...)` extracts a variable node in the requiring file —
            // its name is what lets the ref pass the knownNames pre-filter (as in the
            // upstream end-to-end fixture).
            CodeGraphTestSupport.MakeNode("var:cfg", "config", CodeGraphNodeKind.Variable, "main.lua", 1, language: CodeGraphLanguage.Lua),
            CodeGraphTestSupport.MakeNode("file:config", "config.lua", CodeGraphNodeKind.File, "lua/telescope/config.lua", 1, language: CodeGraphLanguage.Lua)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("file:main", "telescope.config", CodeGraphEdgeKind.Imports, "main.lua", CodeGraphLanguage.Lua)
        });

        var result = Resolve();

        Assert.Equal(1, result.Resolved);
        var edges = store.GetOutgoingEdges("file:main", new[] { CodeGraphEdgeKind.Imports });
        Assert.Contains(edges, e => e.Target == "file:config");
    }

    // -------------------------------------------------------------------------
    // Luau: an instance-path leaf (`Signal` from require(script.Parent.Signal))
    // suffix-matches `Signal.luau`; the longest-shared-prefix rule keeps it in
    // the requiring file's own package (import-resolver.ts:1628).
    // -------------------------------------------------------------------------
    [Fact]
    public void Luau_Require_InstancePathLeaf_PrefersSamePackage()
    {
        WriteFile("packages/net/init.luau", "local Signal = require(script.Parent.Signal)\n");
        WriteFile("packages/net/Signal.luau", "return {}\n");
        WriteFile("packages/other/Signal.luau", "return {}\n");

        foreach (var p in new[] { "packages/net/init.luau", "packages/net/Signal.luau", "packages/other/Signal.luau" })
        {
            store.UpsertFile(new CodeGraphFileRecord(p, "0", CodeGraphLanguage.Luau, 10, 0, 0, 1, null));
        }

        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:net", "init.luau", CodeGraphNodeKind.File, "packages/net/init.luau", 1, language: CodeGraphLanguage.Luau),
            // `local Signal = require(script.Parent.Signal)` — the local binding gets
            // the ref past the knownNames pre-filter (as in the upstream fixture).
            CodeGraphTestSupport.MakeNode("var:signal", "Signal", CodeGraphNodeKind.Variable, "packages/net/init.luau", 1, language: CodeGraphLanguage.Luau),
            CodeGraphTestSupport.MakeNode("file:signal", "Signal.luau", CodeGraphNodeKind.File, "packages/net/Signal.luau", 1, language: CodeGraphLanguage.Luau),
            CodeGraphTestSupport.MakeNode("file:signal-other", "Signal.luau", CodeGraphNodeKind.File, "packages/other/Signal.luau", 1, language: CodeGraphLanguage.Luau)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("file:net", "Signal", CodeGraphEdgeKind.Imports, "packages/net/init.luau", CodeGraphLanguage.Luau)
        });

        var result = Resolve();

        Assert.Equal(1, result.Resolved);
        var edges = store.GetOutgoingEdges("file:net", new[] { CodeGraphEdgeKind.Imports });
        Assert.Contains(edges, e => e.Target == "file:signal");
        Assert.DoesNotContain(edges, e => e.Target == "file:signal-other");
    }

    // -------------------------------------------------------------------------
    // Nix: `import ./lib.nix` resolves to the file node; a dynamic expression
    // (`./pkgs { }`) is NOT path-shaped and stays unresolved — parked failed,
    // never mis-connected (import-resolver.ts:46, :1372).
    // -------------------------------------------------------------------------
    [Fact]
    public void Nix_StaticPathImport_ResolvesFile_DynamicExprStaysUnresolved()
    {
        WriteFile("default.nix", "{ lib = import ./lib.nix; pkgs = import ./pkgs { }; }\n");
        WriteFile("lib.nix", "{ }\n");

        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("file:default", "default.nix", CodeGraphNodeKind.File, "default.nix", 1, language: CodeGraphLanguage.Nix),
            CodeGraphTestSupport.MakeNode("file:lib", "lib.nix", CodeGraphNodeKind.File, "lib.nix", 1, language: CodeGraphLanguage.Nix)
        });

        store.InsertUnresolvedRefsBatch(new[]
        {
            Ref("file:default", "./lib.nix", CodeGraphEdgeKind.Imports, "default.nix", CodeGraphLanguage.Nix),
            Ref("file:default", "./pkgs { }", CodeGraphEdgeKind.Imports, "default.nix", CodeGraphLanguage.Nix, line: 2)
        });

        var result = Resolve();

        Assert.Equal(1, result.Resolved);
        Assert.Equal(1, result.Unresolved);
        var edges = store.GetOutgoingEdges("file:default", new[] { CodeGraphEdgeKind.Imports });
        Assert.Contains(edges, e => e.Target == "file:lib");
        Assert.Single(edges);
    }

    // -------------------------------------------------------------------------
    // PHP: `use` statement extraction — plain and aliased forms
    // (import-resolver.ts:1010).
    // -------------------------------------------------------------------------
    [Fact]
    public void Php_UseStatements_ExtractToImportMappings()
    {
        const string content = "<?php\nuse App\\Models\\User;\nuse App\\Services\\Auth as AuthSvc;\n";

        var mappings = new CodeGraphImportResolver()
            .ExtractImportMappings("index.php", content, CodeGraphLanguage.Php);

        Assert.Equal(2, mappings.Count);
        Assert.Contains(mappings, m =>
            m.LocalName == "User" && m.ExportedName == "User" && m.Source == @"App\Models\User" &&
            !m.IsDefault && !m.IsNamespace);
        Assert.Contains(mappings, m =>
            m.LocalName == "AuthSvc" && m.ExportedName == "Auth" && m.Source == @"App\Services\Auth");
    }

    // -------------------------------------------------------------------------
    // ohpm: oh-package.json5 `file:` deps become workspace members with their
    // declared `main` as the entry file; a name with conflicting targets is
    // ambiguous and dropped; registry deps stay external
    // (workspace-packages.ts:68-:198).
    // -------------------------------------------------------------------------
    [Fact]
    public void Ohpm_FileDeps_LoadAsWorkspaceMembers_WithEntry_AmbiguousDropped()
    {
        WriteFile("entry/oh-package.json5",
            "{\n  // sibling module\n  \"dependencies\": {\n    \"data\": \"file:../core/data\",\n    \"@ohos/axios\": \"^2.0.0\",\n  },\n}\n");
        WriteFile("core/data/oh-package.json5", "{ \"main\": \"Index.ets\", \"dependencies\": {} }\n");
        WriteFile("samples/a/oh-package.json5", "{ \"dependencies\": { \"common\": \"file:./common\" } }\n");
        WriteFile("samples/b/oh-package.json5", "{ \"dependencies\": { \"common\": \"file:./lib\" } }\n");

        var ws = CodeGraphWorkspaces.Load(directory);

        Assert.NotNull(ws);
        Assert.Equal("core/data", ws!.ByName["data"]);
        Assert.False(ws.ByName.ContainsKey("common")); // ambiguous → dropped
        Assert.False(ws.ByName.ContainsKey("@ohos/axios")); // registry dep stays external
        Assert.NotNull(ws.EntryByName);
        Assert.Equal("core/data/Index.ets", ws.EntryByName!["data"]);

        // Bare name resolves to the declared entry; a subpath resolves directory-based.
        Assert.Equal("core/data/Index.ets", CodeGraphWorkspaces.ResolveImport("data", ws));
        Assert.Equal("core/data/sub", CodeGraphWorkspaces.ResolveImport("data/sub", ws));
    }
}
