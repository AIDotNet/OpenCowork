using System.Text.Json.Serialization;

// Minimal source-gen JSON context for the SHARED runtime lib — just the base worker
// contract types the runtime itself serializes (ErrorResult via WorkerResponse.Error;
// StatusResult/WorkerRoutesResult for worker/ping + worker/routes when a SystemModule
// is added to the hosting binary). The main worker has its OWN 200-type WorkerJsonContext
// in a separate assembly — same name, different assembly, no conflict. Each hosting
// binary adds its own module DTO context (e.g. CodeGraphJsonContext) on top.
[JsonSourceGenerationOptions(
    GenerationMode = JsonSourceGenerationMode.Metadata,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(ErrorResult))]
[JsonSerializable(typeof(StatusResult))]
[JsonSerializable(typeof(WorkerRoutesResult))]
[JsonSerializable(typeof(SystemMemorySnapshot))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(List<string>), TypeInfoPropertyName = "ListString")]
internal sealed partial class WorkerJsonContext : JsonSerializerContext;
