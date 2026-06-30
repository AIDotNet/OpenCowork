using System.Text.Json;

internal sealed record NativeExtensionToolExecutionResult(bool Success, string? Content, string? Error);

internal sealed record NativeExtensionInstance(
    string Id,
    bool Enabled,
    IReadOnlyDictionary<string, string> Config,
    NativeExtensionManifest Manifest);

internal sealed record NativeExtensionManifest(
    int SchemaVersion,
    string Id,
    string Name,
    string Version,
    IReadOnlyList<NativeExtensionConfigField> ConfigSchema,
    IReadOnlyList<string> NetworkPermissions,
    IReadOnlyList<NativeExtensionToolDefinition> Tools);

internal sealed record NativeExtensionConfigField(
    string Key,
    string Type,
    string? DefaultValue);

internal sealed record NativeExtensionToolDefinition(
    string Name,
    string Kind,
    NativeExtensionHttpDefinition? Http,
    string? Handler);

internal sealed record NativeExtensionHttpDefinition(
    string Method,
    string Url,
    IReadOnlyDictionary<string, string> Headers,
    JsonElement? Body);
