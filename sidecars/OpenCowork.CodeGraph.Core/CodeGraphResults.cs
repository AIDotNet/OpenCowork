using System.Text.Json;

// Result, query-option, and serializable-view types (reference/01 §2.3). The
// Subgraph / ExtractionResult working sets are IN-PROCESS ONLY (they hold domain
// nodes); everything a tool returns is a "view"-shaped DTO. Per Decision 7 the
// domain CodeGraphNode / CodeGraphEdge never cross System.Text.Json, so results
// embed CodeGraphNodeView / CodeGraphEdgeView projections instead.
//
// NOTE (M1): these result DTOs are NOT yet registered in CodeGraphJsonContext —
// the graph engine is internal at M1 and nothing here crosses IPC. The M4/M5 tool
// slices add the [JsonSerializable] entries when they wire the RPC surface.

// ---------------------------------------------------------------------------
// Traversal working set (in-process). Nodes is a Dictionary keyed by id — the
// analog of the TS `Map<string, Node>`. CHOICE: a Dictionary (not List+index).
// Traversal only ever ADDS nodes to it (never removes), so .NET Dictionary
// enumeration preserves insertion order in practice, matching the Map's ordered
// iteration the traversal/context code relies on. Roots holds entry-point ids.
// Confidence is 'high' | 'low' | null (retrieval-confidence for context queries).
// ---------------------------------------------------------------------------
internal sealed class CodeGraphSubgraph
{
    public Dictionary<string, CodeGraphNode> Nodes { get; } = new();

    public List<CodeGraphEdge> Edges { get; } = new();

    public List<string> Roots { get; } = new();

    public string? Confidence { get; set; }
}

// Extraction pipeline output (in-process). Projected to CodeGraphIndexResult at the
// facade. UnresolvedReferences carry no RowId yet (not persisted); Errors surface
// verbatim to the tool boundary.
internal sealed record CodeGraphExtractionResult(
    List<CodeGraphNode> Nodes,
    List<CodeGraphEdge> Edges,
    List<CodeGraphUnresolvedReference> UnresolvedReferences,
    List<CodeGraphExtractionError> Errors,
    double DurationMs);

// Serialized (files.errors echo + extraction diagnostics). Severity is
// 'error' | 'warning'.
internal sealed record CodeGraphExtractionError(
    string Message,
    string Severity,
    string? FilePath = null,
    int? Line = null,
    int? Column = null,
    string? Code = null);

// ---------------------------------------------------------------------------
// Query options (types.ts TraversalOptions / SearchOptions). Modeled as mutable
// option bags (nullable = "unset", so a consumer applies its own defaults, matching
// the TS `{ ...DEFAULT_OPTIONS, ...options }` merge). Kind/language lists are the
// TEXT constants from CodeGraphNodeKind / CodeGraphEdgeKind / CodeGraphLanguage.
// ---------------------------------------------------------------------------
internal sealed class CodeGraphTraversalOptions
{
    public int? MaxDepth { get; set; }

    public IReadOnlyList<string>? EdgeKinds { get; set; }

    public IReadOnlyList<string>? NodeKinds { get; set; }

    // One of CodeGraphTraversalDirection.{Outgoing,Incoming,Both}; default outgoing.
    public string? Direction { get; set; }

    public int? Limit { get; set; }

    public bool? IncludeStart { get; set; }
}

internal sealed class CodeGraphSearchOptions
{
    public IReadOnlyList<string>? Kinds { get; set; }

    public IReadOnlyList<string>? Languages { get; set; }

    public IReadOnlyList<string>? IncludePatterns { get; set; }

    public IReadOnlyList<string>? ExcludePatterns { get; set; }

    public int? Limit { get; set; }

    public int? Offset { get; set; }

    public bool? CaseSensitive { get; set; }
}

// ---------------------------------------------------------------------------
// Serializable views — the wire projections embedded in result DTOs. Same fields
// as the domain records, minus the opaque metadata (surfaced as JsonElement? only
// when a caller needs it). From(...) builds a view from a domain value; edge
// metadata stays null there (the raw string is parsed to JsonElement only at the
// boundary that actually needs it).
// ---------------------------------------------------------------------------
internal sealed record CodeGraphNodeView(
    string Id,
    string Kind,
    string Name,
    string QualifiedName,
    string FilePath,
    string Language,
    int StartLine,
    int EndLine,
    int StartColumn,
    int EndColumn,
    string? Docstring,
    string? Signature,
    string? Visibility,
    bool IsExported,
    bool IsAsync,
    bool IsStatic,
    bool IsAbstract,
    IReadOnlyList<string>? Decorators,
    IReadOnlyList<string>? TypeParameters,
    string? ReturnType,
    long UpdatedAt)
{
    public static CodeGraphNodeView From(CodeGraphNode node) => new(
        node.Id,
        node.Kind,
        node.Name,
        node.QualifiedName,
        node.FilePath,
        node.Language,
        node.StartLine,
        node.EndLine,
        node.StartColumn,
        node.EndColumn,
        node.Docstring,
        node.Signature,
        node.Visibility,
        node.IsExported,
        node.IsAsync,
        node.IsStatic,
        node.IsAbstract,
        node.Decorators,
        node.TypeParameters,
        node.ReturnType,
        node.UpdatedAt);
}

internal sealed record CodeGraphEdgeView(
    string Source,
    string Target,
    string Kind,
    int? Line,
    int? Column,
    string? Provenance,
    JsonElement? Metadata = null)
{
    public static CodeGraphEdgeView From(CodeGraphEdge edge) => new(
        edge.Source,
        edge.Target,
        edge.Kind,
        edge.Line,
        edge.Column,
        edge.Provenance);
}

// { node, edge } pair used by CodeGraphContext incoming/outgoing refs.
internal sealed record CodeGraphNodeEdge(CodeGraphNodeView Node, CodeGraphEdgeView Edge);

// ---------------------------------------------------------------------------
// Serialized result DTOs.
// ---------------------------------------------------------------------------

// A search hit. Score is a relative rank only — NOT normalized (the FTS path
// returns an unbounded BM25 magnitude; fuzzy/exact paths return ~0-1).
internal sealed record CodeGraphSearchResult(
    CodeGraphNodeView Node,
    double Score,
    IReadOnlyList<string>? Highlights = null);

// Prompt-hook segment match (name_segment_vocab gate). Always verified to exist in
// `nodes` at the time it is returned. StartLine is 1-based.
internal sealed record CodeGraphSegmentMatch(
    string Name,
    string Kind,
    string FilePath,
    int StartLine,
    IReadOnlyList<string> MatchedWords);

// getContext result — focal symbol plus its structural + reference neighborhood.
internal sealed record CodeGraphContext(
    CodeGraphNodeView Focal,
    IReadOnlyList<CodeGraphNodeView> Ancestors,
    IReadOnlyList<CodeGraphNodeView> Children,
    IReadOnlyList<CodeGraphNodeEdge> IncomingRefs,
    IReadOnlyList<CodeGraphNodeEdge> OutgoingRefs,
    IReadOnlyList<CodeGraphNodeView> Types,
    IReadOnlyList<CodeGraphNodeView> Imports);

// Graph statistics (single-pass counts + grouped breakdowns). DbSizeBytes is the
// on-disk size; LastUpdated is epoch-ms.
internal sealed record CodeGraphStats(
    int NodeCount,
    int EdgeCount,
    int FileCount,
    IReadOnlyDictionary<string, int> NodesByKind,
    IReadOnlyDictionary<string, int> EdgesByKind,
    IReadOnlyDictionary<string, int> FilesByLanguage,
    long DbSizeBytes,
    long LastUpdated);

// Facade results (NOT in types.ts — facade-level). Load-bearing minimum fields;
// M4/M1 pins the exact set against index.ts.
internal sealed record CodeGraphIndexResult(
    int FilesIndexed,
    int NodesCreated,
    int EdgesCreated,
    int UnresolvedCount,
    double DurationMs,
    IReadOnlyList<CodeGraphExtractionError> Errors);

internal sealed record CodeGraphSyncResult(
    int FilesChanged,
    int FilesAdded,
    int FilesRemoved,
    int NodesUpdated,
    int EdgesUpdated,
    double DurationMs);
