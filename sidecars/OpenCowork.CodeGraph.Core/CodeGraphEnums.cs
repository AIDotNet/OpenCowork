// The three fixed vocabularies (Decision 16). Stored as TEXT; `enum` is banned so
// there is zero mapping cost at the SQLite boundary and the values are AOT-trivial.
// Each class exposes an `All` array that is the single source of truth the search
// query parser validates against. Values are verbatim from CodeGraph types.ts.

// NodeKind — 22 values (types.ts:18-41).
internal static class CodeGraphNodeKind
{
    public const string File = "file";
    public const string Module = "module";
    public const string Class = "class";
    public const string Struct = "struct";
    public const string Interface = "interface";
    public const string Trait = "trait";
    public const string Protocol = "protocol";
    public const string Function = "function";
    public const string Method = "method";
    public const string Property = "property";
    public const string Field = "field";
    public const string Variable = "variable";
    public const string Constant = "constant";
    public const string Enum = "enum";
    public const string EnumMember = "enum_member";
    public const string TypeAlias = "type_alias";
    public const string Namespace = "namespace";
    public const string Parameter = "parameter";
    public const string Import = "import";
    public const string Export = "export";
    public const string Route = "route";
    public const string Component = "component";

    public static readonly string[] All =
    {
        File, Module, Class, Struct, Interface, Trait, Protocol, Function, Method,
        Property, Field, Variable, Constant, Enum, EnumMember, TypeAlias, Namespace,
        Parameter, Import, Export, Route, Component
    };
}

// EdgeKind — 12 values (types.ts:48-60). FunctionRef is the internal-only
// ReferenceKind extra (a function name used as a value); it is NEVER an edges.kind
// value — resolution maps it to a `references` edge — so it is deliberately absent
// from `All` (types.ts:293-299).
internal static class CodeGraphEdgeKind
{
    public const string Contains = "contains";
    public const string Calls = "calls";
    public const string Imports = "imports";
    public const string Exports = "exports";
    public const string Extends = "extends";
    public const string Implements = "implements";
    public const string References = "references";
    public const string TypeOf = "type_of";
    public const string Returns = "returns";
    public const string Instantiates = "instantiates";
    public const string Overrides = "overrides";
    public const string Decorates = "decorates";

    public static readonly string[] All =
    {
        Contains, Calls, Imports, Exports, Extends, Implements, References,
        TypeOf, Returns, Instantiates, Overrides, Decorates
    };

    // ReferenceKind = EdgeKind | 'function_ref' (internal-only; maps to a
    // 'references' edge; NOT a valid edges.kind value).
    public const string FunctionRef = "function_ref";
}

// Language — 42 values (types.ts:66-109): 41 real languages + the `unknown`
// sentinel (reference/01 discrepancy note #1 reconciles the plan's "41").
internal static class CodeGraphLanguage
{
    public const string TypeScript = "typescript";
    public const string JavaScript = "javascript";
    public const string Tsx = "tsx";
    public const string Jsx = "jsx";
    public const string ArkTs = "arkts";
    public const string Python = "python";
    public const string Go = "go";
    public const string Rust = "rust";
    public const string Java = "java";
    public const string C = "c";
    public const string Cpp = "cpp";
    public const string CSharp = "csharp";
    public const string Razor = "razor";
    public const string Php = "php";
    public const string Ruby = "ruby";
    public const string Swift = "swift";
    public const string Kotlin = "kotlin";
    public const string Dart = "dart";
    public const string Svelte = "svelte";
    public const string Vue = "vue";
    public const string Astro = "astro";
    public const string Liquid = "liquid";
    public const string Pascal = "pascal";
    public const string Scala = "scala";
    public const string Lua = "lua";
    public const string Luau = "luau";
    public const string ObjC = "objc";
    public const string R = "r";
    public const string Solidity = "solidity";
    public const string Nix = "nix";
    public const string Yaml = "yaml";
    public const string Twig = "twig";
    public const string Xml = "xml";
    public const string Properties = "properties";
    public const string Cfml = "cfml";
    public const string CfScript = "cfscript";
    public const string CfQuery = "cfquery";
    public const string Cobol = "cobol";
    public const string VbNet = "vbnet";
    public const string Erlang = "erlang";
    public const string Terraform = "terraform";
    public const string Unknown = "unknown";

    public static readonly string[] All =
    {
        TypeScript, JavaScript, Tsx, Jsx, ArkTs, Python, Go, Rust, Java, C, Cpp,
        CSharp, Razor, Php, Ruby, Swift, Kotlin, Dart, Svelte, Vue, Astro, Liquid,
        Pascal, Scala, Lua, Luau, ObjC, R, Solidity, Nix, Yaml, Twig, Xml,
        Properties, Cfml, CfScript, CfQuery, Cobol, VbNet, Erlang, Terraform, Unknown
    };
}

// Optional helper vocabularies (reference/01 §2.1 — "may be modeled the same way,
// or left as bare strings"). Modeled here so callers avoid stringly-typed literals.
internal static class CodeGraphVisibility
{
    public const string Public = "public";
    public const string Private = "private";
    public const string Protected = "protected";
    public const string Internal = "internal";

    public static readonly string[] All = { Public, Private, Protected, Internal };
}

internal static class CodeGraphProvenance
{
    public const string TreeSitter = "tree-sitter";
    public const string Scip = "scip";
    public const string Heuristic = "heuristic";

    public static readonly string[] All = { TreeSitter, Scip, Heuristic };
}

// Traversal direction values used by CodeGraphTraversalOptions.Direction
// (types.ts TraversalOptions.direction). `outgoing` is the default.
internal static class CodeGraphTraversalDirection
{
    public const string Outgoing = "outgoing";
    public const string Incoming = "incoming";
    public const string Both = "both";
}
