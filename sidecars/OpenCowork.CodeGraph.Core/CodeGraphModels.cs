// M0 DTO contract for the CodeGraph engine. These are the shared shapes every agent's
// slice references (defined once here). Global namespace, every type prefixed CodeGraph*
// to avoid collisions — matches the main worker convention (no `namespace` declarations).
//
// Positional-record parameters (PascalCase) serialize as camelCase via the
// PropertyNamingPolicy configured in CodeGraphJsonContext; null members are omitted
// (DefaultIgnoreCondition = WhenWritingNull). Serialize with
// WorkerResponse.Json(result, CodeGraphJsonContext.Default.<TypeName>).

/// <summary>Result of the "codegraph/status" liveness probe (M0 stub).</summary>
internal sealed record CodeGraphStatusResult(bool Success, string Version, string Message);

/// <summary>
/// Result of the "codegraph/db-smoke" probe. Opens a temp graph DB via
/// CodeGraphConnectionFactory and runs a real FTS5 round-trip
/// (CREATE VIRTUAL TABLE t USING fts5(x) + INSERT + SELECT ... WHERE t MATCH ...)
/// plus `select sqlite_version()`, proving the e_sqlite3 bundle ships FTS5 at runtime.
/// Success/failure is modeled in the payload because WorkerResponse.Error resolves
/// (does not reject) on the JS side (analysis/06 §3.3).
/// </summary>
internal sealed record CodeGraphDbSmokeResult(
    bool Success,
    string? SqliteVersion,
    bool Fts5,
    string? Error);
