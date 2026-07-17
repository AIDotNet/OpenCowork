// Domain row type ≙ CodeGraph types.ts `Edge` (one `edges` row). IN-PROCESS ONLY.
// The surrogate edges.id AUTOINCREMENT is NOT part of edge identity and is absent
// here — identity is the tuple (Source, Target, Kind, Line, Column). The mapper
// bridges the TS→DB name drift Edge.Column ↔ edges.col. Metadata is the RAW JSON
// string from edges.metadata, kept verbatim and never modeled (reference/01 §3);
// it is parsed to a JsonElement only at the tool boundary (CodeGraphEdgeView).
internal sealed record CodeGraphEdge(
    string Source,
    string Target,
    string Kind,
    string? Metadata,
    int? Line,
    int? Column,
    string? Provenance);
