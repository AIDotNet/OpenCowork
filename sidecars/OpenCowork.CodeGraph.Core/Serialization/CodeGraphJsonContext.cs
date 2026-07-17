using System.Text.Json.Serialization;

// Dedicated AOT source-generation context for CodeGraph DTOs (analysis/06 §4.2 and
// M0-A step A2 both prescribe a dedicated context rather than appending to
// WorkerJsonContext). Options mirror WorkerJsonContext exactly: Metadata generation
// mode, PascalCase C# props -> camelCase JSON, and null members omitted.
//
// Every serialized type needs its own [JsonSerializable] entry; each future List<T>
// result needs a SEPARATE entry with a stable TypeInfoPropertyName = "ListCodeGraphX"
// (mirror WorkerJsonContext's ListProjectRow pattern). Access the generated metadata
// via CodeGraphJsonContext.Default.<TypeName>.
[JsonSourceGenerationOptions(
    GenerationMode = JsonSourceGenerationMode.Metadata,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(CodeGraphStatusResult))]
[JsonSerializable(typeof(CodeGraphDbSmokeResult))]
// List<string> underpins the reflection-free string[] JSON-column codec in
// CodeGraphStore (nodes.decorators / nodes.type_parameters / unresolved_refs.
// candidates). Required because JsonSerializerIsReflectionEnabledByDefault=false:
// every (de)serialize must resolve a source-gen JsonTypeInfo. TypeInfoPropertyName
// mirrors WorkerJsonContext's "ListX" convention (reference/01 §3).
[JsonSerializable(typeof(List<string>), TypeInfoPropertyName = "ListString")]
internal sealed partial class CodeGraphJsonContext : JsonSerializerContext;
