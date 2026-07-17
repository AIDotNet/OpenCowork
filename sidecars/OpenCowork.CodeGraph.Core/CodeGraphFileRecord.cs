// Domain row type ≙ CodeGraph types.ts `FileRecord` (one `files` row). IN-PROCESS
// ONLY. Change detection is by ContentHash (full lowercase hex sha256 of the file
// bytes), not mtime. Errors is the RAW JSON string from files.errors
// (ExtractionError[]), kept verbatim and never modeled (reference/01 §3). Size /
// ModifiedAt / IndexedAt are epoch-ms (Size in bytes).
internal sealed record CodeGraphFileRecord(
    string Path,
    string ContentHash,
    string Language,
    long Size,
    long ModifiedAt,
    long IndexedAt,
    int NodeCount,
    string? Errors);
