using Xunit;

// Port of CodeGraph `__tests__/db-perf.test.ts` (WS-B, M1).
//
// Regression coverage for the store's N+1 killer and its correctness invariants:
//   1. Batch GetNodesByIds — a Map keyed by id, missing ids simply absent, chunked
//      under the SQLite parameter ceiling, cache-aware.
//   2. INSERT OR REPLACE (InsertNode) invalidates the LRU cache so a stale row is
//      never served on the next GetNodeById.
//   3. InsertEdges validates endpoints against the DB (not the stale node cache) and
//      skips dangling edges instead of failing the batch.
//   4. Edge identity = (source, target, kind, IFNULL(line,-1), IFNULL(col,-1)),
//      enforced by the UNIQUE idx_edges_identity so INSERT OR IGNORE actually dedups.
//
// (db-perf.test.ts also covers deleteResolvedReferences chunking, runMaintenance, and
// the v6 migration; those are out of scope here — no migration chain in the port
// (Decision 18) and the ref/maintenance surface belongs to later M1/M4 suites.)

// ---------------------------------------------------------------------------
// getNodesByIds (batch lookup)
// ---------------------------------------------------------------------------
public sealed class CodeGraphGetNodesByIdsTests : IDisposable
{
    private readonly string dir;
    private readonly CodeGraphStore store;

    public CodeGraphGetNodesByIdsTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out dir);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(dir);
    }

    [Fact]
    public void ReturnsMapKeyedById_OneEntryPerExistingNode()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("n1"),
            CodeGraphTestSupport.MakeNode("n2"),
            CodeGraphTestSupport.MakeNode("n3")
        });

        var result = store.GetNodesByIds(new[] { "n1", "n2", "n3" });

        Assert.Equal(3, result.Count);
        Assert.Equal("n1", result["n1"].Name);
        Assert.Equal("n3", result["n3"].Name);
    }

    [Fact]
    public void OmitsMissingIds_NoNullsNoExceptions()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("n1"),
            CodeGraphTestSupport.MakeNode("n2")
        });

        var result = store.GetNodesByIds(new[] { "n1", "missing", "n2" });

        Assert.Equal(2, result.Count);
        Assert.False(result.ContainsKey("missing"));
        Assert.True(result.ContainsKey("n1"));
        Assert.True(result.ContainsKey("n2"));
    }

    [Fact]
    public void HandlesEmptyInputArray()
    {
        Assert.Empty(store.GetNodesByIds(Array.Empty<string>()));
    }

    [Fact]
    public void HandlesBatchesOverTheSqliteParameterLimit_Chunking()
    {
        // 1500 nodes; the helper chunks at ChunkSize (500) internally.
        var nodes = Enumerable.Range(0, 1500)
            .Select(i => CodeGraphTestSupport.MakeNode($"n{i}"))
            .ToList();
        store.InsertNodes(nodes);

        var ids = nodes.Select(n => n.Id).ToList();
        var result = store.GetNodesByIds(ids);

        Assert.Equal(1500, result.Count);
        // Spot-check the first / middle / last chunk.
        Assert.True(result.ContainsKey("n0"));
        Assert.True(result.ContainsKey("n750"));
        Assert.True(result.ContainsKey("n1499"));
    }

    [Fact]
    public void ServesCacheHitsFromMemory_QueriesOnlyTheMisses()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("n1"),
            CodeGraphTestSupport.MakeNode("n2"),
            CodeGraphTestSupport.MakeNode("n3")
        });

        // Warm the cache for n1 only.
        _ = store.GetNodeById("n1");

        // Replace the underlying row (raw SQL bypasses the LRU cache) so a
        // miss-vs-cache-hit is observable.
        store.ExecuteNonQuery(
            "UPDATE nodes SET name = $name WHERE id = $id",
            new CodeGraphSqlParam("$name", "changed"),
            new CodeGraphSqlParam("$id", "n1"));

        var result = store.GetNodesByIds(new[] { "n1", "n2" });

        // The cached n1 (still 'n1', not 'changed') must be returned; n2 is a miss.
        Assert.Equal("n1", result["n1"].Name);
        Assert.Equal("n2", result["n2"].Name);
    }
}

// ---------------------------------------------------------------------------
// insertNode cache invalidation
// ---------------------------------------------------------------------------
public sealed class CodeGraphCacheInvalidationTests : IDisposable
{
    private readonly string dir;
    private readonly CodeGraphStore store;

    public CodeGraphCacheInvalidationTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out dir);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(dir);
    }

    [Fact]
    public void DoesNotServeStaleCachedNodeAfterInsertOrReplace()
    {
        // Regression: InsertNode uses INSERT OR REPLACE; it must invalidate the LRU
        // entry, otherwise the next GetNodeById serves the pre-replace row until
        // eviction.
        store.InsertNode(CodeGraphTestSupport.MakeNode("n1", "oldName"));
        var beforeReplace = store.GetNodeById("n1");
        Assert.NotNull(beforeReplace);
        Assert.Equal("oldName", beforeReplace!.Name);

        store.InsertNode(CodeGraphTestSupport.MakeNode("n1", "newName", updatedAt: CodeGraphTestSupport.FixedClock + 1));
        var afterReplace = store.GetNodeById("n1");
        Assert.NotNull(afterReplace);
        Assert.Equal("newName", afterReplace!.Name);
    }
}

// ---------------------------------------------------------------------------
// insertEdges endpoint validation
// ---------------------------------------------------------------------------
public sealed class CodeGraphInsertEdgesEndpointValidationTests : IDisposable
{
    private readonly string dir;
    private readonly CodeGraphStore store;

    public CodeGraphInsertEdgesEndpointValidationTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out dir);
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(dir);
    }

    [Fact]
    public void SkipsEdgesWithMissingEndpoints_InsteadOfFailingTheWholeBatch()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("source"),
            CodeGraphTestSupport.MakeNode("target"),
            CodeGraphTestSupport.MakeNode("other")
        });

        var exception = Record.Exception(() => store.InsertEdges(new[]
        {
            CodeGraphTestSupport.MakeEdge("source", "target", CodeGraphEdgeKind.Calls),
            CodeGraphTestSupport.MakeEdge("source", "missing-target", CodeGraphEdgeKind.Calls),
            CodeGraphTestSupport.MakeEdge("missing-source", "other", CodeGraphEdgeKind.References)
        }));
        Assert.Null(exception);

        var edges = store.GetOutgoingEdges("source");
        Assert.Single(edges);
        Assert.Equal("source", edges[0].Source);
        Assert.Equal("target", edges[0].Target);
        Assert.Equal(CodeGraphEdgeKind.Calls, edges[0].Kind);
    }

    [Fact]
    public void DoesNotTrustStaleCachedNodesWhenValidatingEndpoints()
    {
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("source"),
            CodeGraphTestSupport.MakeNode("target")
        });

        // Warm the cache with `target`, then delete the row out from under it (raw
        // SQL bypasses the cache).
        Assert.Equal("target", store.GetNodeById("target")!.Id);
        store.ExecuteNonQuery(
            "DELETE FROM nodes WHERE id = $id", new CodeGraphSqlParam("$id", "target"));

        // Endpoint validation must probe the DB (target is gone) — not the cache —
        // so the edge is skipped, not admitted (and no FK failure propagates).
        var exception = Record.Exception(() => store.InsertEdges(new[]
        {
            CodeGraphTestSupport.MakeEdge("source", "target", CodeGraphEdgeKind.Calls)
        }));
        Assert.Null(exception);
        Assert.Empty(store.GetOutgoingEdges("source"));
    }
}

// ---------------------------------------------------------------------------
// edge identity uniqueness (#1034)
//
// The edges table's UNIQUE idx_edges_identity — (source, target, kind,
// IFNULL(line,-1), IFNULL(col,-1)) — makes INSERT OR IGNORE actually dedup. Without
// it, two passes emitting the same logical edge admit byte-identical duplicate rows.
// ---------------------------------------------------------------------------
public sealed class CodeGraphEdgeIdentityTests : IDisposable
{
    private const string ExactMatchMeta = "{\"resolvedBy\":\"exact-match\"}";
    private const string ImportMeta = "{\"resolvedBy\":\"import\"}";

    private readonly string dir;
    private readonly CodeGraphStore store;

    public CodeGraphEdgeIdentityTests()
    {
        store = CodeGraphTestSupport.OpenTempStore(out dir);
        store.InsertNodes(new[]
        {
            CodeGraphTestSupport.MakeNode("A"),
            CodeGraphTestSupport.MakeNode("B")
        });
    }

    public void Dispose()
    {
        store.Dispose();
        CodeGraphTestSupport.DeleteDir(dir);
    }

    // ≙ db-perf.test.ts `mk(over)`: A→B references @153:12 with exact-match metadata.
    private static CodeGraphEdge Mk(int? line = 153, int? column = 12, string? metadata = ExactMatchMeta)
        => CodeGraphTestSupport.MakeEdge("A", "B", CodeGraphEdgeKind.References, line, column, metadata);

    private long EdgeCount() => CodeGraphTestSupport.CountRows(store, "edges");

    [Fact]
    public void FreshDatabaseHasTheIdentityIndex()
    {
        var name = store.ExecuteScalarString(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_identity'");
        Assert.Equal("idx_edges_identity", name);
    }

    [Fact]
    public void CollapsesByteIdenticalEdgesToASingleRow()
    {
        store.InsertEdges(new[] { Mk(), Mk(), Mk() });
        Assert.Equal(1, EdgeCount());
    }

    [Fact]
    public void DedupsWhenOnlyMetadataDiffers_SameStructuralIdentity()
    {
        store.InsertEdges(new[]
        {
            Mk(metadata: ExactMatchMeta),
            Mk(metadata: ImportMeta)
        });
        Assert.Equal(1, EdgeCount());
    }

    [Fact]
    public void KeepsEdgesThatDifferInLineOrCol_DistinctCallSitesAreNotDuplicates()
    {
        store.InsertEdges(new[]
        {
            Mk(column: 12),
            Mk(column: 99),
            Mk(line: 200, column: 1)
        });
        Assert.Equal(3, EdgeCount());
    }

    [Fact]
    public void DedupsCoordinateLessEdges_FoldingNullLineColViaIfNull()
    {
        store.InsertEdges(new[]
        {
            Mk(line: null, column: null),
            Mk(line: null, column: null)
        });
        Assert.Equal(1, EdgeCount());
    }

    [Fact]
    public void DedupsAcrossSeparateInsertCalls_StorageConstraintNotPerBatchDedup()
    {
        store.InsertEdges(new[] { Mk() });
        store.InsertEdges(new[] { Mk() });
        Assert.Equal(1, EdgeCount());
    }
}
