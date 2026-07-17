// =============================================================================
// ICodeGraphContextBuilder — the surgical-context contract the CodeGraphEngine facade
// depends on, IMPLEMENTED by the context slice (analysis/05 §2.7 / §6.5).
//
// This is the port of context/index.ts's ContextBuilder: the ~450-line multi-channel
// hybrid retriever (FindRelevantContext), the buildContext code-block assembler +
// markdown/JSON formatter, and getCode (config-leaf redaction, #383). The facade
// defines only the SHAPE so it compiles and runs today against the Noop builder; the
// real ContextBuilder is constructed by the scanning/context slice through
// CodeGraphContextBuilderFactory, which hands it the store + traverser it ranks over
// (≙ createContextBuilder(projectRoot, queries, traverser)).
//
// Async because the real implementation reads files off disk for code blocks and
// getCode; the CancellationToken (default) replaces the TS AbortSignal so a slow
// ranking pass can be cancelled by the run registry.
// =============================================================================
internal interface ICodeGraphContextBuilder
{
    // Assemble task context: entry points, expanded subgraph, extracted code blocks,
    // summary + stats. The facade's buildContext. (context/index.ts buildContext)
    Task<CodeGraphTaskContext> BuildContext(
        CodeGraphTaskInput input,
        CodeGraphBuildContextOptions? options = null,
        CancellationToken cancellationToken = default);

    // The multi-channel retriever: hybrid search + graph expansion → a relevant
    // subgraph. The facade's findRelevantContext. (context/index.ts findRelevantContext)
    Task<CodeGraphSubgraph> FindRelevantContext(
        string query,
        CodeGraphFindRelevantContextOptions? options = null,
        CancellationToken cancellationToken = default);

    // Source code for a node (its file lines start..end), or null. A config-leaf node
    // (#383) returns the key only, never the on-disk secret value. (context getCode)
    Task<string?> GetCode(string nodeId, CancellationToken cancellationToken = default);
}

// The factory the engine calls in Open/Init to build the context layer over the just-
// opened store (≙ TS wireLayers → createContextBuilder(projectRoot, queries,
// traverser)). Injected by the context slice; defaults to the Noop builder.
internal delegate ICodeGraphContextBuilder CodeGraphContextBuilderFactory(
    CodeGraphStore store,
    string projectRoot,
    CodeGraphTraverser traverser);

// ---------------------------------------------------------------------------
// Context option/result types (types.ts TaskInput/BuildContextOptions/TaskContext/
// FindRelevantContextOptions/CodeBlock). In-process; nullable option fields mean
// "unset" so the builder applies its own defaults (the TS `{...DEFAULTS, ...opts}`
// merge). Node projections use CodeGraphNodeView (Decision 7 — domain nodes never
// cross the tool boundary).
// ---------------------------------------------------------------------------

// TaskInput = string | { title, description? }. Modeled as a record; Of(...) mirrors
// the string form.
internal sealed record CodeGraphTaskInput(string Title, string? Description = null)
{
    public static CodeGraphTaskInput Of(string title) => new(title);

    public static CodeGraphTaskInput Of(string title, string? description) => new(title, description);
}

internal sealed class CodeGraphBuildContextOptions
{
    public int? MaxNodes { get; set; }

    public int? MaxCodeBlocks { get; set; }

    public int? MaxCodeBlockSize { get; set; }

    public bool? IncludeCode { get; set; }

    // "markdown" | "json"; default markdown.
    public string? Format { get; set; }

    public int? SearchLimit { get; set; }

    public int? TraversalDepth { get; set; }

    public double? MinScore { get; set; }
}

internal sealed class CodeGraphFindRelevantContextOptions
{
    public int? SearchLimit { get; set; }

    public int? TraversalDepth { get; set; }

    public int? MaxNodes { get; set; }

    public double? MinScore { get; set; }

    public IReadOnlyList<string>? EdgeKinds { get; set; }

    public IReadOnlyList<string>? NodeKinds { get; set; }
}

// One extracted code block. Node is the associated node view, when the block came
// from a specific node.
internal sealed record CodeGraphCodeBlock(
    string Content,
    string FilePath,
    int StartLine,
    int EndLine,
    string Language,
    CodeGraphNodeView? Node = null);

// buildContext result — the query, expanded subgraph, entry points, code blocks,
// touched files, summary, and rollup stats.
internal sealed record CodeGraphTaskContext(
    string Query,
    CodeGraphSubgraph Subgraph,
    IReadOnlyList<CodeGraphNodeView> EntryPoints,
    IReadOnlyList<CodeGraphCodeBlock> CodeBlocks,
    IReadOnlyList<string> RelatedFiles,
    string Summary,
    CodeGraphTaskContextStats Stats,
    // #687 dynamic-dispatch boundary notes (markdown), appended to explore output when
    // an entry point's body hits a runtime-dispatch site. Empty/null when none. Not
    // serialized to JSON (markdown-surface only).
    string? DynamicBoundaries = null);

internal sealed record CodeGraphTaskContextStats(
    int NodeCount,
    int EdgeCount,
    int FileCount,
    int CodeBlockCount,
    int TotalCodeSize);

// The trivial default so the facade compiles and runs before the context slice lands.
// It returns empty context / no code, so the read surface degrades gracefully instead
// of crashing. Replaced by the real ContextBuilder via the injected factory.
internal sealed class CodeGraphNoopContextBuilder : ICodeGraphContextBuilder
{
    public static readonly CodeGraphNoopContextBuilder Instance = new();

    public Task<CodeGraphTaskContext> BuildContext(
        CodeGraphTaskInput input,
        CodeGraphBuildContextOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var query = string.IsNullOrEmpty(input.Description) ? input.Title : $"{input.Title}\n{input.Description}";
        var context = new CodeGraphTaskContext(
            query,
            new CodeGraphSubgraph(),
            Array.Empty<CodeGraphNodeView>(),
            Array.Empty<CodeGraphCodeBlock>(),
            Array.Empty<string>(),
            Summary: string.Empty,
            new CodeGraphTaskContextStats(0, 0, 0, 0, 0));
        return Task.FromResult(context);
    }

    public Task<CodeGraphSubgraph> FindRelevantContext(
        string query,
        CodeGraphFindRelevantContextOptions? options = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(new CodeGraphSubgraph());

    public Task<string?> GetCode(string nodeId, CancellationToken cancellationToken = default) =>
        Task.FromResult<string?>(null);
}
