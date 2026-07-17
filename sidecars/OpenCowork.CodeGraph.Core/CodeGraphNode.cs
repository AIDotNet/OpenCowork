// Domain row type ≙ CodeGraph types.ts `Node` (one `nodes` row). IN-PROCESS ONLY —
// never handed to System.Text.Json (Decision 7); serialized results project it to
// CodeGraphNodeView at the tool boundary. Lines are 1-based, columns 0-based.
// Decorators / TypeParameters are the parsed string[] JSON columns; ReturnType is
// the v5 normalized return type (receiver inference, #645). Boolean flags map to the
// is_* INTEGER(0/1) columns. UpdatedAt is epoch-ms.
internal sealed record CodeGraphNode(
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
    long UpdatedAt);
