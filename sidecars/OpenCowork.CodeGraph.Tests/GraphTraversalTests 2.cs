using Xunit;

// Port of CodeGraph `__tests__/graph.test.ts` (WS-B, M1).
//
// graph.test.ts builds a 4-file TS repo and `indexAll()`s it, then queries the
// traverser/graph facade. Extraction is M2 — not available yet — so per WS-B §3.2
// this port SEEDS the equivalent symbol graph directly into a real store (the
// invariants under test are the traversal ones, not the extractor's). The seed
// reproduces the fixture's cross-file relationships:
//
//   base.ts      class BaseClass { value; getValue() }   interface Printable { print() }
//   derived.ts   class DerivedClass extends BaseClass implements Printable
//                  { name; print(){ getName(); getValue() } getName() }
//   utils.ts     formatValue()  processValue(){ formatValue() }  doubleValue()  unusedHelper()
//   main.ts      main(){ new DerivedClass(); print(); processValue(doubleValue(getValue())) }
//
// The #1086–#1090 edge-completeness / node-limit regressions build their own tiny
// topologies per test and live in CodeGraphTraversalRegressionTests below.

// ---------------------------------------------------------------------------
// Seeded fixture — a real temp-dir store holding the base/derived/utils/main graph,
// plus the traverser + graph-query facade wired over it. Disposed per test class
// instance (xUnit new-per-test == Vitest beforeEach/afterEach).
// ---------------------------------------------------------------------------
internal sealed class CodeGraphSeededGraph : IDisposable
{
    // Stable node ids (extraction would hash these; the exact id is immaterial —
    // every query below finds nodes by kind+name, exactly like graph.test.ts).
    internal const string FileBase = "file:base";
    internal const string FileDerived = "file:derived";
    internal const string FileUtils = "file:utils";
    internal const string FileMain = "file:main";
    internal const string BaseClass = "class:BaseClass";
    internal const string ValueField = "field:value";
    internal const string GetValue = "method:getValue";
    internal const string Printable = "iface:Printable";
    internal const string DerivedClass = "class:DerivedClass";
    internal const string NameField = "field:name";
    internal const string Print = "method:print";
    internal const string GetName = "method:getName";
    internal const string FormatValue = "func:formatValue";
    internal const string ProcessValue = "func:processValue";
    internal const string DoubleValue = "func:doubleValue";
    internal const string UnusedHelper = "func:unusedHelper";
    internal const string Main = "func:main";

    private readonly string directory;

    internal CodeGraphStore Store { get; }

    internal CodeGraphTraverser Traverser { get; }

    internal CodeGraphQueryManager Queries { get; }

    internal CodeGraphSeededGraph()
    {
        Store = CodeGraphTestSupport.OpenTempStore(out directory);

        var nodes = new List<CodeGraphNode>
        {
            CodeGraphTestSupport.MakeNode(FileBase, "base.ts", CodeGraphNodeKind.File, "src/base.ts", 1),
            CodeGraphTestSupport.MakeNode(FileDerived, "derived.ts", CodeGraphNodeKind.File, "src/derived.ts", 1),
            CodeGraphTestSupport.MakeNode(FileUtils, "utils.ts", CodeGraphNodeKind.File, "src/utils.ts", 1),
            CodeGraphTestSupport.MakeNode(FileMain, "main.ts", CodeGraphNodeKind.File, "src/main.ts", 1),
            CodeGraphTestSupport.MakeNode(BaseClass, "BaseClass", CodeGraphNodeKind.Class, "src/base.ts", 2, isExported: true),
            CodeGraphTestSupport.MakeNode(ValueField, "value", CodeGraphNodeKind.Field, "src/base.ts", 3),
            CodeGraphTestSupport.MakeNode(GetValue, "getValue", CodeGraphNodeKind.Method, "src/base.ts", 8),
            CodeGraphTestSupport.MakeNode(Printable, "Printable", CodeGraphNodeKind.Interface, "src/base.ts", 15, isExported: true),
            CodeGraphTestSupport.MakeNode(DerivedClass, "DerivedClass", CodeGraphNodeKind.Class, "src/derived.ts", 4, isExported: true),
            CodeGraphTestSupport.MakeNode(NameField, "name", CodeGraphNodeKind.Field, "src/derived.ts", 5),
            CodeGraphTestSupport.MakeNode(Print, "print", CodeGraphNodeKind.Method, "src/derived.ts", 12),
            CodeGraphTestSupport.MakeNode(GetName, "getName", CodeGraphNodeKind.Method, "src/derived.ts", 17),
            CodeGraphTestSupport.MakeNode(FormatValue, "formatValue", CodeGraphNodeKind.Function, "src/utils.ts", 2, isExported: true),
            CodeGraphTestSupport.MakeNode(ProcessValue, "processValue", CodeGraphNodeKind.Function, "src/utils.ts", 6, isExported: true),
            CodeGraphTestSupport.MakeNode(DoubleValue, "doubleValue", CodeGraphNodeKind.Function, "src/utils.ts", 11, isExported: true),
            // unusedHelper is deliberately NOT exported and has no incoming refs (dead code).
            CodeGraphTestSupport.MakeNode(UnusedHelper, "unusedHelper", CodeGraphNodeKind.Function, "src/utils.ts", 16),
            CodeGraphTestSupport.MakeNode(Main, "main", CodeGraphNodeKind.Function, "src/main.ts", 4, isExported: true)
        };
        Store.InsertNodes(nodes);

        var edges = new List<CodeGraphEdge>
        {
            // Structural containment (file -> symbol, class -> member).
            CodeGraphTestSupport.MakeEdge(FileBase, BaseClass, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileBase, Printable, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(BaseClass, ValueField, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(BaseClass, GetValue, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileDerived, DerivedClass, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(DerivedClass, NameField, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(DerivedClass, Print, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(DerivedClass, GetName, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileUtils, FormatValue, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileUtils, ProcessValue, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileUtils, DoubleValue, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileUtils, UnusedHelper, CodeGraphEdgeKind.Contains),
            CodeGraphTestSupport.MakeEdge(FileMain, Main, CodeGraphEdgeKind.Contains),

            // Type hierarchy.
            CodeGraphTestSupport.MakeEdge(DerivedClass, BaseClass, CodeGraphEdgeKind.Extends),
            CodeGraphTestSupport.MakeEdge(DerivedClass, Printable, CodeGraphEdgeKind.Implements),

            // Call graph.
            CodeGraphTestSupport.MakeEdge(ProcessValue, FormatValue, CodeGraphEdgeKind.Calls, line: 8),
            CodeGraphTestSupport.MakeEdge(Main, Print, CodeGraphEdgeKind.Calls, line: 7),
            CodeGraphTestSupport.MakeEdge(Main, ProcessValue, CodeGraphEdgeKind.Calls, line: 9),
            CodeGraphTestSupport.MakeEdge(Main, DoubleValue, CodeGraphEdgeKind.Calls, line: 9, column: 20),
            CodeGraphTestSupport.MakeEdge(Print, GetName, CodeGraphEdgeKind.Calls, line: 13),
            CodeGraphTestSupport.MakeEdge(Print, GetValue, CodeGraphEdgeKind.Calls, line: 13, column: 30),

            // main constructs DerivedClass -> instantiates (counts as a call, #774).
            CodeGraphTestSupport.MakeEdge(Main, DerivedClass, CodeGraphEdgeKind.Instantiates, line: 6)
        };
        Store.InsertEdges(edges);

        Traverser = new CodeGraphTraverser(Store);
        Queries = new CodeGraphQueryManager(Store);
    }

    // Mirror `cg.getNodesByKind(kind).find(n => n.name === name)` — exercises the
    // real GetNodesByKind read path rather than reusing seed handles.
    internal CodeGraphNode NodeByName(string kind, string name)
        => Store.GetNodesByKind(kind).Single(n => n.Name == name);

    public void Dispose()
    {
        Store.Dispose();
        CodeGraphTestSupport.DeleteDir(directory);
    }
}

public sealed class CodeGraphGraphTraversalTests : IDisposable
{
    private readonly CodeGraphSeededGraph graph = new();

    public void Dispose() => graph.Dispose();

    // ----- traverse() -----

    [Fact]
    public void TraverseBfs_FromStartNode_CollectsReachableNodesAndRecordsRoot()
    {
        var main = graph.NodeByName(CodeGraphNodeKind.Function, "main");

        var subgraph = graph.Traverser.TraverseBFS(
            main.Id,
            new CodeGraphTraversalOptions
            {
                MaxDepth = 2,
                Direction = CodeGraphTraversalDirection.Outgoing
            });

        Assert.True(subgraph.Nodes.Count > 0);
        Assert.Contains(main.Id, subgraph.Roots);
    }

    [Fact]
    public void TraverseBfs_RespectsMaxDepth_DeeperIsSupersetSized()
    {
        var main = graph.NodeByName(CodeGraphNodeKind.Function, "main");

        var shallow = graph.Traverser.TraverseBFS(
            main.Id, new CodeGraphTraversalOptions { MaxDepth = 1 });
        var deep = graph.Traverser.TraverseBFS(
            main.Id, new CodeGraphTraversalOptions { MaxDepth = 3 });

        Assert.True(deep.Nodes.Count >= shallow.Nodes.Count);
    }

    [Fact]
    public void TraverseBfs_IncomingDirection_FindsCallers()
    {
        var formatValue = graph.NodeByName(CodeGraphNodeKind.Function, "formatValue");

        var subgraph = graph.Traverser.TraverseBFS(
            formatValue.Id,
            new CodeGraphTraversalOptions
            {
                MaxDepth = 2,
                Direction = CodeGraphTraversalDirection.Incoming
            });

        // processValue calls formatValue -> reachable via an incoming edge.
        Assert.True(subgraph.Nodes.Count > 0);
        Assert.True(subgraph.Nodes.ContainsKey(CodeGraphSeededGraph.ProcessValue));
    }

    // ----- getContext() -----

    [Fact]
    public void GetContext_ReturnsFocalWithStructuralAndReferenceNeighborhood()
    {
        var derived = graph.NodeByName(CodeGraphNodeKind.Class, "DerivedClass");

        var context = graph.Queries.GetContext(derived.Id);

        Assert.NotNull(context.Focal);
        Assert.Equal(derived.Id, context.Focal.Id);
        Assert.NotNull(context.Ancestors);
        Assert.NotNull(context.Children);
        Assert.NotNull(context.IncomingRefs);
        Assert.NotNull(context.OutgoingRefs);
        // main `new DerivedClass()` is an incoming (non-contains) reference.
        Assert.Contains(context.IncomingRefs, r => r.Node.Name == "main");
        // extends BaseClass / implements Printable are outgoing (non-contains) refs.
        Assert.Contains(context.OutgoingRefs, r => r.Node.Name == "BaseClass");
    }

    [Fact]
    public void GetContext_ThrowsForNonExistentNode()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => graph.Queries.GetContext("non-existent-id"));
        Assert.Contains("Node not found", ex.Message);
    }

    // ----- getCallGraph() -----

    [Fact]
    public void GetCallGraph_IncludesFocalNode()
    {
        var processValue = graph.NodeByName(CodeGraphNodeKind.Function, "processValue");

        var callGraph = graph.Traverser.GetCallGraph(processValue.Id, 2);

        Assert.True(callGraph.Nodes.Count > 0);
        Assert.True(callGraph.Nodes.ContainsKey(processValue.Id));
    }

    // ----- getTypeHierarchy() -----

    [Fact]
    public void GetTypeHierarchy_ReturnsClassAndItsSupertypes()
    {
        var derived = graph.NodeByName(CodeGraphNodeKind.Class, "DerivedClass");

        var hierarchy = graph.Traverser.GetTypeHierarchy(derived.Id);

        Assert.True(hierarchy.Nodes.Count > 0);
        Assert.True(hierarchy.Nodes.ContainsKey(derived.Id));
        // extends BaseClass climbs into the hierarchy.
        Assert.True(hierarchy.Nodes.ContainsKey(CodeGraphSeededGraph.BaseClass));
    }

    [Fact]
    public void GetTypeHierarchy_EmptyForNonExistentNode()
    {
        var hierarchy = graph.Traverser.GetTypeHierarchy("non-existent-id");

        Assert.Empty(hierarchy.Nodes);
        Assert.Empty(hierarchy.Edges);
    }

    // ----- getCallers() / getCallees() -----

    [Fact]
    public void GetCallers_FindsCallingFunction()
    {
        var formatValue = graph.NodeByName(CodeGraphNodeKind.Function, "formatValue");

        var callers = graph.Traverser.GetCallers(formatValue.Id);

        // processValue calls formatValue.
        Assert.Contains("processValue", callers.Select(c => c.Node.Name));
    }

    [Fact]
    public void GetCallees_FindsCalledFunction()
    {
        var processValue = graph.NodeByName(CodeGraphNodeKind.Function, "processValue");

        var callees = graph.Traverser.GetCallees(processValue.Id);

        Assert.Contains("formatValue", callees.Select(c => c.Node.Name));
    }

    [Fact]
    public void InstantiationCountsAsCallerAndCalleeOfTheClass_774()
    {
        var derived = graph.NodeByName(CodeGraphNodeKind.Class, "DerivedClass");
        var main = graph.NodeByName(CodeGraphNodeKind.Function, "main");

        // main() does `new DerivedClass(...)`: constructing a class is calling its
        // constructor, so main is a caller of DerivedClass and DerivedClass is a
        // callee of main (the `instantiates` edge is walked by callers/callees).
        var callerNames = graph.Traverser.GetCallers(derived.Id).Select(c => c.Node.Name);
        Assert.Contains("main", callerNames);

        var calleeNames = graph.Traverser.GetCallees(main.Id).Select(c => c.Node.Name);
        Assert.Contains("DerivedClass", calleeNames);
    }

    // ----- getImpactRadius() -----

    [Fact]
    public void GetImpactRadius_IncludesFocalAndDependents()
    {
        var formatValue = graph.NodeByName(CodeGraphNodeKind.Function, "formatValue");

        var impact = graph.Traverser.GetImpactRadius(formatValue.Id, 3);

        Assert.True(impact.Nodes.Count > 0);
        Assert.True(impact.Nodes.ContainsKey(formatValue.Id));
    }

    [Fact]
    public void GetImpactRadius_DoesNotClimbContainsToSiblingMembers_536()
    {
        var getName = graph.NodeByName(CodeGraphNodeKind.Method, "getName");
        var derived = graph.NodeByName(CodeGraphNodeKind.Class, "DerivedClass");

        var impact = graph.Traverser.GetImpactRadius(getName.Id, 3);

        // The containing class must NOT be dragged into impact by the structural
        // `contains` edge — climbing it would re-expand every sibling method and
        // explode impact for a leaf symbol (#536).
        Assert.False(impact.Nodes.ContainsKey(derived.Id));
    }

    // ----- findPath() -----

    [Fact]
    public void FindPath_ConnectedNodes_ReturnsOrderedPath()
    {
        var processValue = graph.NodeByName(CodeGraphNodeKind.Function, "processValue");
        var formatValue = graph.NodeByName(CodeGraphNodeKind.Function, "formatValue");

        // processValue -> formatValue via a `calls` edge (outgoing).
        var path = graph.Traverser.FindPath(processValue.Id, formatValue.Id);

        Assert.NotNull(path);
        Assert.Equal(processValue.Id, path![0].Node.Id);
        Assert.Equal(formatValue.Id, path[^1].Node.Id);
    }

    [Fact]
    public void FindPath_DisconnectedNodes_ReturnsNull()
    {
        Assert.Null(graph.Traverser.FindPath("non-existent-1", "non-existent-2"));
    }

    // ----- getAncestors() / getChildren() -----

    [Fact]
    public void GetAncestors_ClimbsContainmentHierarchy()
    {
        var print = graph.NodeByName(CodeGraphNodeKind.Method, "print");

        var ancestors = graph.Traverser.GetAncestors(print.Id);

        // print's immediate container is DerivedClass (then the file above it).
        Assert.Contains("DerivedClass", ancestors.Select(a => a.Name));
    }

    [Fact]
    public void GetChildren_ReturnsContainedMembers()
    {
        var derived = graph.NodeByName(CodeGraphNodeKind.Class, "DerivedClass");

        var children = graph.Traverser.GetChildren(derived.Id);

        Assert.Contains("print", children.Select(c => c.Name));
    }
}

// ===========================================================================
// Traversal edge-completeness & node-limit regressions (#1086–#1090).
//
// Each test constructs a tiny deterministic topology in a fresh store and drives
// the traverser directly — the C# analog of graph.test.ts's `tGraph()` over an
// in-memory query stub, except (WS-B) the store is real so the shipping code path
// is what gets tested.
// ===========================================================================
public sealed class CodeGraphTraversalRegressionTests
{
    // Seed a fresh store with the given nodes + edges and hand back a traverser.
    // Caller disposes the store; the temp dir is registered for cleanup on dispose.
    private static (CodeGraphStore store, CodeGraphTraverser traverser, string dir) Build(
        IReadOnlyList<CodeGraphNode> nodes,
        IReadOnlyList<CodeGraphEdge> edges)
    {
        var store = CodeGraphTestSupport.OpenTempStore(out var dir);
        store.InsertNodes(nodes);
        store.InsertEdges(edges);
        return (store, new CodeGraphTraverser(store), dir);
    }

    // Minimal node stub — the traversal only reads id/kind/name.
    private static CodeGraphNode N(string id, string kind = CodeGraphNodeKind.Function)
        => CodeGraphTestSupport.MakeNode(id, id, kind, $"src/{id}.ts", 1);

    [Fact]
    public void TraverseBfs_KeepsEveryParallelEdgeToTheSameTarget_1090()
    {
        // A reaches B via both `calls` and `references` — two distinct edges.
        var (store, traverser, dir) = Build(
            new[] { N("A"), N("B") },
            new[]
            {
                CodeGraphTestSupport.MakeEdge("A", "B", CodeGraphEdgeKind.Calls, line: 1),
                CodeGraphTestSupport.MakeEdge("A", "B", CodeGraphEdgeKind.References, line: 2)
            });
        try
        {
            var sub = traverser.TraverseBFS(
                "A", new CodeGraphTraversalOptions { Direction = CodeGraphTraversalDirection.Outgoing });

            var kinds = sub.Edges
                .Where(e => e.Source == "A" && e.Target == "B")
                .Select(e => e.Kind)
                .OrderBy(k => k, StringComparer.Ordinal)
                .ToArray();

            // Pre-fix: only the higher-priority `calls` edge survived; `references` was dropped.
            Assert.Equal(new[] { CodeGraphEdgeKind.Calls, CodeGraphEdgeKind.References }, kinds);
            Assert.True(sub.Nodes.ContainsKey("B"));
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }

    [Fact]
    public void TraverseBfs_KeepsTwoSameKindEdgesOnDifferentLines_1090()
    {
        var (store, traverser, dir) = Build(
            new[] { N("A"), N("B") },
            new[]
            {
                CodeGraphTestSupport.MakeEdge("A", "B", CodeGraphEdgeKind.Calls, line: 3),
                CodeGraphTestSupport.MakeEdge("A", "B", CodeGraphEdgeKind.Calls, line: 7)
            });
        try
        {
            var sub = traverser.TraverseBFS(
                "A", new CodeGraphTraversalOptions { Direction = CodeGraphTraversalDirection.Outgoing });

            Assert.Equal(2, sub.Edges.Count(e => e.Source == "A" && e.Target == "B"));
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }

    [Fact]
    public void TraverseBfs_DoesNotOvershootLimitOnHighDegreeNode_1087()
    {
        var neighbors = new[] { "B", "C", "D", "E", "F" };
        var nodes = new List<CodeGraphNode> { N("A") };
        nodes.AddRange(neighbors.Select(n => N(n)));
        var edges = neighbors.Select(n => CodeGraphTestSupport.MakeEdge("A", n, CodeGraphEdgeKind.Calls)).ToArray();

        var (store, traverser, dir) = Build(nodes, edges);
        try
        {
            var sub = traverser.TraverseBFS(
                "A",
                new CodeGraphTraversalOptions
                {
                    Limit = 3,
                    Direction = CodeGraphTraversalDirection.Outgoing
                });

            // Pre-fix: all 5 neighbors were added in one pass → 6 nodes despite limit 3.
            Assert.True(sub.Nodes.Count <= 3);
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }

    [Fact]
    public void TraverseDfs_DoesNotOvershootLimitOnHighDegreeNode_1088()
    {
        var neighbors = new[] { "B", "C", "D", "E", "F" };
        var nodes = new List<CodeGraphNode> { N("A") };
        nodes.AddRange(neighbors.Select(n => N(n)));
        var edges = neighbors.Select(n => CodeGraphTestSupport.MakeEdge("A", n, CodeGraphEdgeKind.Calls)).ToArray();

        var (store, traverser, dir) = Build(nodes, edges);
        try
        {
            var sub = traverser.TraverseDFS(
                "A",
                new CodeGraphTraversalOptions
                {
                    Limit = 2,
                    Direction = CodeGraphTraversalDirection.Outgoing
                });

            Assert.True(sub.Nodes.Count <= 2);
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }

    [Fact]
    public void GetCallers_ReturnsEachCallerOnce_ReachedViaMultipleEdges_1086()
    {
        // Y calls X at two sites and also references it — three incoming edges.
        var (store, traverser, dir) = Build(
            new[] { N("X"), N("Y") },
            new[]
            {
                CodeGraphTestSupport.MakeEdge("Y", "X", CodeGraphEdgeKind.Calls, line: 1),
                CodeGraphTestSupport.MakeEdge("Y", "X", CodeGraphEdgeKind.Calls, line: 2),
                CodeGraphTestSupport.MakeEdge("Y", "X", CodeGraphEdgeKind.References, line: 3)
            });
        try
        {
            var callers = traverser.GetCallers("X"); // default maxDepth = 1

            // Pre-fix: Y appeared three times (depth guard returned before visited.add).
            Assert.Equal(new[] { "Y" }, callers.Select(c => c.Node.Id).ToArray());
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }

    [Fact]
    public void GetCallees_ReturnsEachCalleeOnce_ReachedViaMultipleEdges_1086()
    {
        var (store, traverser, dir) = Build(
            new[] { N("X"), N("Y") },
            new[]
            {
                CodeGraphTestSupport.MakeEdge("X", "Y", CodeGraphEdgeKind.Calls, line: 1),
                CodeGraphTestSupport.MakeEdge("X", "Y", CodeGraphEdgeKind.Calls, line: 2)
            });
        try
        {
            var callees = traverser.GetCallees("X");

            Assert.Equal(new[] { "Y" }, callees.Select(c => c.Node.Id).ToArray());
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }

    [Fact]
    public void GetImpactRadius_KeepsDirectEdgeIntoNodeAlreadyCollectedViaAnotherPath_1089()
    {
        // Class P contains method M. Q calls both M and P. Reaching M first collects
        // Q; the pre-fix `!nodes.has()` gate then dropped the direct Q→P edge.
        var (store, traverser, dir) = Build(
            new[] { N("P", CodeGraphNodeKind.Class), N("M", CodeGraphNodeKind.Method), N("Q") },
            new[]
            {
                CodeGraphTestSupport.MakeEdge("P", "M", CodeGraphEdgeKind.Contains),
                CodeGraphTestSupport.MakeEdge("Q", "M", CodeGraphEdgeKind.Calls, line: 1),
                CodeGraphTestSupport.MakeEdge("Q", "P", CodeGraphEdgeKind.Calls, line: 2)
            });
        try
        {
            var sub = traverser.GetImpactRadius("P", 2);

            Assert.True(sub.Nodes.ContainsKey("Q"));
            Assert.Contains(sub.Edges, e => e.Source == "Q" && e.Target == "M" && e.Kind == CodeGraphEdgeKind.Calls);
            // The regression: this direct dependency edge used to vanish.
            Assert.Contains(sub.Edges, e => e.Source == "Q" && e.Target == "P" && e.Kind == CodeGraphEdgeKind.Calls);
        }
        finally
        {
            store.Dispose();
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }
}
