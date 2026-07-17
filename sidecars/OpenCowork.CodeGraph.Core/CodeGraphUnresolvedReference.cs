// Domain row type ≙ CodeGraph types.ts `UnresolvedReference` (one `unresolved_refs`
// row). IN-PROCESS ONLY. Column ↔ unresolved_refs.col. ReferenceKind is
// EdgeKind | 'function_ref' (see CodeGraphEdgeKind.FunctionRef).
//
// RowId is unresolved_refs.id — the precise-cleanup target: post-pass cleanup
// deletes exactly this row so it never reaps sibling refs (same caller/callee at
// other call sites) a later batch has not attempted yet (#1269). It is null on an
// extraction-time value that has not been persisted.
//
// Status / NameTail are DB-managed v8 lifecycle fields absent from the TS domain
// type: a ref is inserted 'pending'; a completed resolution pass either DELETEs it
// (resolved) or marks it 'failed' with NameTail = last dotted segment so a later
// sync can retry it when a changed file adds a matching symbol (#1240). Defaults
// keep an extraction-time value constructible without touching the DB.
internal sealed record CodeGraphUnresolvedReference(
    string FromNodeId,
    string ReferenceName,
    string ReferenceKind,
    int Line,
    int Column,
    string? FilePath,
    string? Language,
    IReadOnlyList<string>? Candidates,
    long? RowId,
    string Status = "pending",
    string NameTail = "");
