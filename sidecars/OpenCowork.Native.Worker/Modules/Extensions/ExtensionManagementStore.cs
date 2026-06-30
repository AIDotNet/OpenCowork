using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;

internal static partial class ExtensionManifestStore
{
    private const string ExtensionsStorageFileName = "extensions-storage.json";
    private static readonly object ManagementSync = new();
    private static bool builtinsInitialized;
    private static readonly JsonSerializerOptions ManagementJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse List(JsonElement parameters)
    {
        lock (ManagementSync)
        {
            EnsureBuiltinExtensions(parameters);
            return ToResponse(ListExtensionsCore());
        }
    }

    public static WorkerResponse InstallFromFolder(JsonElement parameters)
    {
        try
        {
            var sourcePath = JsonHelpers.GetString(parameters, "sourcePath")?.Trim();
            if (string.IsNullOrWhiteSpace(sourcePath))
            {
                return ToResponse(Mutation(false, "Missing extension source path"));
            }

            sourcePath = Path.GetFullPath(sourcePath);
            if (!Directory.Exists(sourcePath))
            {
                return ToResponse(Mutation(false, $"Extension source folder not found: {sourcePath}"));
            }

            lock (ManagementSync)
            {
                var manifest = ReadNormalizedManifestNode(sourcePath);
                var id = ReadNodeString(manifest, "id");
                var targetPath = ResolveExtensionPath(id);
                if (Directory.Exists(targetPath))
                {
                    return ToResponse(Mutation(false, $"Extension \"{id}\" already exists"));
                }

                Directory.CreateDirectory(ExtensionsDirectory());
                CopyDirectory(sourcePath, targetPath);

                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var state = ReadStateRoot();
                state[id] = CreateState(manifest, enabled: false, now);
                WriteJsonNode(ExtensionsStatePath(), state);
                WorkerLog.Debug($"extension install id={id}");
            }

            return ToResponse(Mutation(true, null));
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    public static WorkerResponse Update(JsonElement parameters)
    {
        try
        {
            var id = NormalizeId(JsonHelpers.GetString(parameters, "id"));
            if (!IsValidExtensionId(id) ||
                parameters.ValueKind != JsonValueKind.Object ||
                !parameters.TryGetProperty("patch", out var patchElement) ||
                patchElement.ValueKind != JsonValueKind.Object)
            {
                return ToResponse(Mutation(false, "Invalid extension update"));
            }

            lock (ManagementSync)
            {
                var manifest = ReadNormalizedManifestNode(ResolveExtensionPath(id));
                var stateRoot = ReadStateRoot();
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var state = GetOrCreateState(stateRoot, id, manifest, enabled: false, now);

                if (patchElement.TryGetProperty("enabled", out var enabledElement) &&
                    enabledElement.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    state["enabled"] = enabledElement.GetBoolean();
                }

                if (patchElement.TryGetProperty("config", out var configElement) &&
                    configElement.ValueKind == JsonValueKind.Object)
                {
                    var currentRuntimeConfig = BuildRuntimeConfig(id, manifest, GetStateConfig(state));
                    foreach (var property in configElement.EnumerateObject())
                    {
                        if (property.Value.ValueKind == JsonValueKind.String)
                        {
                            currentRuntimeConfig[property.Name] = property.Value.GetString() ?? string.Empty;
                        }
                    }
                    state["config"] = SplitAndPersistConfig(id, manifest, currentRuntimeConfig);
                }

                state["updatedAt"] = now;
                WriteJsonNode(ExtensionsStatePath(), stateRoot);
                WorkerLog.Debug($"extension update id={id}");
            }

            return ToResponse(Mutation(true, null));
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    public static WorkerResponse Remove(JsonElement parameters)
    {
        try
        {
            var id = NormalizeId(parameters.ValueKind == JsonValueKind.String
                ? parameters.GetString()
                : JsonHelpers.GetString(parameters, "id"));
            if (!IsValidExtensionId(id))
            {
                return ToResponse(Mutation(false, "Invalid extension id"));
            }

            lock (ManagementSync)
            {
                JsonObject? manifest = null;
                var extensionPath = ResolveExtensionPath(id);
                if (File.Exists(Path.Combine(extensionPath, ExtensionManifestFileName)))
                {
                    manifest = ReadNormalizedManifestNode(extensionPath);
                }

                if (Directory.Exists(extensionPath))
                {
                    Directory.Delete(extensionPath, recursive: true);
                }

                var state = ReadStateRoot();
                state.Remove(id);
                WriteJsonNode(ExtensionsStatePath(), state);

                var storage = ReadStorageRoot();
                storage.Remove(id);
                WriteJsonNode(ExtensionsStoragePath(), storage);

                if (manifest is not null)
                {
                    foreach (var key in GetSecretKeys(manifest))
                    {
                        ConfigStore.DeleteKey(SecretConfigKey(id, key));
                    }
                }

                WorkerLog.Debug($"extension remove id={id}");
            }

            return ToResponse(Mutation(true, null));
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    public static WorkerResponse ResolvePath(JsonElement parameters)
    {
        try
        {
            var id = NormalizeId(parameters.ValueKind == JsonValueKind.String
                ? parameters.GetString()
                : JsonHelpers.GetString(parameters, "id"));
            if (!IsValidExtensionId(id))
            {
                return ToResponse(Mutation(false, "Invalid extension id"));
            }

            var path = ResolveExtensionPath(id);
            return ToResponse(new JsonObject
            {
                ["success"] = true,
                ["path"] = path
            });
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    public static WorkerResponse ReadAsset(JsonElement parameters)
    {
        try
        {
            var id = NormalizeId(JsonHelpers.GetString(parameters, "id"));
            var relativePath = JsonHelpers.GetString(parameters, "path") ?? string.Empty;
            if (!IsValidExtensionId(id))
            {
                return ToResponse(new JsonObject { ["error"] = "Invalid extension id" });
            }

            lock (ManagementSync)
            {
                _ = ReadNormalizedManifestNode(ResolveExtensionPath(id));
                var assetPath = ResolveExtensionAssetPath(id, relativePath);
                if (!File.Exists(assetPath))
                {
                    return ToResponse(new JsonObject { ["error"] = $"Asset not found: {relativePath}" });
                }

                return ToResponse(new JsonObject { ["content"] = File.ReadAllText(assetPath) });
            }
        }
        catch (Exception ex)
        {
            return ToResponse(new JsonObject { ["error"] = ex.Message });
        }
    }

    public static WorkerResponse StorageGet(JsonElement parameters)
    {
        try
        {
            var extensionId = NormalizeId(JsonHelpers.GetString(parameters, "extensionId"));
            var key = NormalizeStorageKey(JsonHelpers.GetString(parameters, "key"));
            lock (ManagementSync)
            {
                _ = ReadNormalizedManifestNode(ResolveExtensionPath(extensionId));
                var storage = ReadStorageRoot();
                return storage.TryGetPropertyValue(extensionId, out var extensionStorage) &&
                    extensionStorage is JsonObject extensionObject &&
                    extensionObject.TryGetPropertyValue(key, out var value) &&
                    value is not null
                        ? ToResponse(value.DeepClone())
                        : WorkerResponse.RawJson("null");
            }
        }
        catch (Exception ex)
        {
            return ToResponse(new JsonObject { ["error"] = ex.Message });
        }
    }

    public static WorkerResponse StorageSet(JsonElement parameters)
    {
        try
        {
            var extensionId = NormalizeId(JsonHelpers.GetString(parameters, "extensionId"));
            var key = NormalizeStorageKey(JsonHelpers.GetString(parameters, "key"));
            lock (ManagementSync)
            {
                _ = ReadNormalizedManifestNode(ResolveExtensionPath(extensionId));
                var storage = ReadStorageRoot();
                if (storage[extensionId] is not JsonObject extensionStorage)
                {
                    extensionStorage = [];
                    storage[extensionId] = extensionStorage;
                }

                extensionStorage[key] = parameters.TryGetProperty("value", out var valueElement)
                    ? CloneElement(valueElement)
                    : null;
                WriteJsonNode(ExtensionsStoragePath(), storage);
            }

            return ToResponse(Mutation(true, null));
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    public static WorkerResponse StorageDelete(JsonElement parameters)
    {
        try
        {
            var extensionId = NormalizeId(JsonHelpers.GetString(parameters, "extensionId"));
            var key = NormalizeStorageKey(JsonHelpers.GetString(parameters, "key"));
            lock (ManagementSync)
            {
                _ = ReadNormalizedManifestNode(ResolveExtensionPath(extensionId));
                var storage = ReadStorageRoot();
                if (storage[extensionId] is JsonObject extensionStorage)
                {
                    extensionStorage.Remove(key);
                    WriteJsonNode(ExtensionsStoragePath(), storage);
                }
            }

            return ToResponse(Mutation(true, null));
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message));
        }
    }

    private static JsonArray ListExtensionsCore()
    {
        var state = ReadStateRoot();
        var changed = false;
        var instances = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        Directory.CreateDirectory(ExtensionsDirectory());

        foreach (var directory in Directory.EnumerateDirectories(ExtensionsDirectory()))
        {
            var id = Path.GetFileName(directory);
            if (!File.Exists(Path.Combine(directory, ExtensionManifestFileName)))
            {
                continue;
            }

            try
            {
                var manifest = ReadNormalizedManifestNode(directory);
                if (!string.Equals(ReadNodeString(manifest, "id"), id, StringComparison.Ordinal))
                {
                    WorkerLog.Warn($"extension skipped id mismatch directory={id}");
                    continue;
                }

                seen.Add(id);
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var extensionState = GetOrCreateState(state, id, manifest, enabled: false, now);
                if (!state.ContainsKey(id))
                {
                    changed = true;
                }

                instances.Add((JsonNode?)new JsonObject
                {
                    ["id"] = id,
                    ["enabled"] = ReadNodeBool(extensionState, "enabled", false),
                    ["installedAt"] = ReadNodeLong(extensionState, "installedAt", now),
                    ["updatedAt"] = ReadNodeLong(extensionState, "updatedAt", now),
                    ["config"] = BuildRuntimeConfigNode(id, manifest, GetStateConfig(extensionState)),
                    ["manifest"] = manifest.DeepClone()
                });
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"extension load failed id={id} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        foreach (var property in state.ToArray())
        {
            if (!seen.Contains(property.Key))
            {
                state.Remove(property.Key);
                changed = true;
            }
        }

        if (changed)
        {
            WriteJsonNode(ExtensionsStatePath(), state);
        }

        return instances;
    }

    private static void EnsureBuiltinExtensions(JsonElement parameters)
    {
        if (builtinsInitialized)
        {
            return;
        }
        builtinsInitialized = true;

        var bundledDir = ResolveBundledExtensionsDirectory(parameters);
        if (bundledDir is null || !Directory.Exists(bundledDir))
        {
            return;
        }

        Directory.CreateDirectory(ExtensionsDirectory());
        var state = ReadStateRoot();
        var stateChanged = false;

        foreach (var sourceDir in Directory.EnumerateDirectories(bundledDir))
        {
            var directoryName = Path.GetFileName(sourceDir);
            if (!File.Exists(Path.Combine(sourceDir, ExtensionManifestFileName)))
            {
                continue;
            }

            try
            {
                var sourceManifest = ReadNormalizedManifestNode(sourceDir);
                var id = ReadNodeString(sourceManifest, "id");
                if (!string.Equals(id, directoryName, StringComparison.Ordinal))
                {
                    WorkerLog.Warn($"extension bundled skipped id mismatch directory={directoryName}");
                    continue;
                }

                var targetDir = ResolveExtensionPath(id);
                var shouldUpdate = ShouldUpdateExtension(sourceManifest, sourceDir, targetDir);
                if (shouldUpdate)
                {
                    ReplaceDirectory(sourceDir, targetDir);
                }

                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (state[id] is not JsonObject current)
                {
                    state[id] = CreateState(sourceManifest, enabled: true, now);
                    stateChanged = true;
                    continue;
                }

                var nextConfig = BuildStateConfigWithDefaults(sourceManifest, GetStateConfig(current));
                if (shouldUpdate || !JsonEquals(current["config"], nextConfig))
                {
                    current["config"] = nextConfig;
                    if (shouldUpdate)
                    {
                        current["updatedAt"] = now;
                    }
                    stateChanged = true;
                }
            }
            catch (Exception ex)
            {
                WorkerLog.Warn(
                    $"extension bundled init failed directory={directoryName} error={ex.GetType().Name}: {ex.Message}");
            }
        }

        if (stateChanged)
        {
            WriteJsonNode(ExtensionsStatePath(), state);
        }
    }

    private static string? ResolveBundledExtensionsDirectory(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("bundledDirCandidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        string? first = null;
        foreach (var candidate in candidates.EnumerateArray())
        {
            if (candidate.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var path = candidate.GetString();
            if (string.IsNullOrWhiteSpace(path))
            {
                continue;
            }

            var fullPath = Path.GetFullPath(path);
            first ??= fullPath;
            if (Directory.Exists(fullPath))
            {
                return fullPath;
            }
        }

        return first;
    }

    private static JsonObject ReadNormalizedManifestNode(string extensionDir)
    {
        var manifestPath = Path.Combine(extensionDir, ExtensionManifestFileName);
        using var document = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
        return NormalizeManifestNode(document.RootElement);
    }

    private static JsonObject NormalizeManifestNode(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("extension.json must contain an object");
        }

        if (ReadInt(root, "schemaVersion", 0) != 1)
        {
            throw new InvalidOperationException("extension schemaVersion must be 1");
        }

        var id = NormalizeId(ReadString(root, "id"));
        if (!IsValidExtensionId(id))
        {
            throw new InvalidOperationException("extension id must be 2-64 chars using lowercase letters, numbers, _ or -");
        }

        var name = ReadString(root, "name").Trim();
        var version = ReadString(root, "version").Trim();
        if (name.Length == 0)
        {
            throw new InvalidOperationException("extension name is required");
        }
        if (version.Length == 0)
        {
            throw new InvalidOperationException("extension version is required");
        }

        var tools = NormalizeTools(root);
        if (tools.Count == 0)
        {
            throw new InvalidOperationException("extension must define at least one tool");
        }
        var entry = ReadOptionalString(root, "entry");
        if (ToolsContainKind(tools, "js") && string.IsNullOrWhiteSpace(entry))
        {
            throw new InvalidOperationException("extension entry is required for js tools");
        }

        var manifest = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["id"] = id,
            ["name"] = name,
            ["version"] = version,
            ["tools"] = tools
        };

        if (ReadOptionalString(root, "description") is { Length: > 0 } description)
        {
            manifest["description"] = description;
        }
        if (entry is { Length: > 0 })
        {
            manifest["entry"] = entry;
        }

        var configSchema = NormalizeConfigSchema(root);
        if (configSchema.Count > 0)
        {
            manifest["configSchema"] = configSchema;
        }

        var network = NormalizeNetworkPermissions(root);
        if (network.Count > 0)
        {
            manifest["permissions"] = new JsonObject { ["network"] = network };
        }

        var renderers = NormalizeRenderers(root);
        if (renderers.Count > 0)
        {
            manifest["renderers"] = renderers;
        }

        var components = NormalizeComponents(root);
        if (components.Count > 0)
        {
            manifest["components"] = components;
        }

        return manifest;
    }

    private static JsonArray NormalizeConfigSchema(JsonElement root)
    {
        var result = new JsonArray();
        if (!root.TryGetProperty("configSchema", out var schema) || schema.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in schema.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var key = ReadString(item, "key").Trim();
            var label = ReadString(item, "label").Trim();
            if (label.Length == 0)
            {
                label = key;
            }
            if (key.Length == 0 || label.Length == 0)
            {
                continue;
            }
            if (!seen.Add(key))
            {
                throw new InvalidOperationException($"duplicate config key: {key}");
            }

            var field = new JsonObject
            {
                ["key"] = key,
                ["label"] = label,
                ["type"] = ReadString(item, "type") == "secret" ? "secret" : "text"
            };
            if (ReadBool(item, "required", false))
            {
                field["required"] = true;
            }
            AddOptionalString(field, item, "description");
            AddOptionalString(field, item, "placeholder");
            AddOptionalString(field, item, "defaultValue");
            result.Add((JsonNode?)field);
        }

        return result;
    }

    private static JsonArray NormalizeTools(JsonElement root)
    {
        if (!root.TryGetProperty("tools", out var toolsElement) || toolsElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("extension must define at least one tool");
        }

        var result = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in toolsElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var name = ReadString(item, "name").Trim();
            if (!ToolNameRegex().IsMatch(name))
            {
                throw new InvalidOperationException("invalid extension tool name");
            }
            if (!seen.Add(name))
            {
                throw new InvalidOperationException($"duplicate tool name: {name}");
            }

            var kind = ReadString(item, "kind").Trim();
            JsonObject tool;
            if (kind == "js")
            {
                var handler = ReadString(item, "handler").Trim();
                if (handler.Length == 0)
                {
                    throw new InvalidOperationException($"js tool \"{name}\" requires handler");
                }

                tool = new JsonObject
                {
                    ["name"] = name,
                    ["description"] = ReadOptionalString(item, "description") ?? name,
                    ["inputSchema"] = item.TryGetProperty("inputSchema", out var jsInputSchema) &&
                        jsInputSchema.ValueKind == JsonValueKind.Object
                            ? CloneElement(jsInputSchema)
                            : new JsonObject { ["type"] = "object" },
                    ["kind"] = "js",
                    ["handler"] = handler
                };
            }
            else if (kind == "http")
            {
                tool = new JsonObject
                {
                    ["name"] = name,
                    ["description"] = ReadOptionalString(item, "description") ?? name,
                    ["inputSchema"] = item.TryGetProperty("inputSchema", out var inputSchema) &&
                        inputSchema.ValueKind == JsonValueKind.Object
                            ? CloneElement(inputSchema)
                            : new JsonObject { ["type"] = "object" },
                    ["kind"] = "http",
                    ["http"] = NormalizeHttpDefinition(name, item)
                };
            }
            else
            {
                throw new InvalidOperationException($"tool \"{name}\" kind must be \"http\" or \"js\"");
            }
            if (item.TryGetProperty("readOnly", out var readOnly) &&
                readOnly.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                tool["readOnly"] = readOnly.GetBoolean();
            }
            result.Add((JsonNode?)tool);
        }

        return result;
    }

    private static JsonObject NormalizeHttpDefinition(string toolName, JsonElement tool)
    {
        if (!tool.TryGetProperty("http", out var http) || http.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException($"http tool \"{toolName}\" requires http.method and http.url");
        }

        var method = ReadString(http, "method").Trim().ToUpperInvariant();
        if (method.Length == 0)
        {
            method = "GET";
        }

        var url = ReadString(http, "url").Trim();
        if (url.Length == 0)
        {
            throw new InvalidOperationException($"http tool \"{toolName}\" requires http.method and http.url");
        }

        var result = new JsonObject
        {
            ["method"] = method,
            ["url"] = url
        };

        if (http.TryGetProperty("headers", out var headers) && headers.ValueKind == JsonValueKind.Object)
        {
            var headerObject = new JsonObject();
            foreach (var property in headers.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.String)
                {
                    headerObject[property.Name] = property.Value.GetString() ?? string.Empty;
                }
            }
            if (headerObject.Count > 0)
            {
                result["headers"] = headerObject;
            }
        }

        if (http.TryGetProperty("body", out var body))
        {
            result["body"] = CloneElement(body);
        }

        return result;
    }

    private static bool ToolsContainKind(JsonArray tools, string kind)
    {
        foreach (var item in tools)
        {
            if (item is JsonObject tool &&
                tool.TryGetPropertyValue("kind", out var kindNode) &&
                string.Equals(kindNode?.GetValue<string>(), kind, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static JsonArray NormalizeNetworkPermissions(JsonElement root)
    {
        var result = new JsonArray();
        if (!root.TryGetProperty("permissions", out var permissions) ||
            permissions.ValueKind != JsonValueKind.Object ||
            !permissions.TryGetProperty("network", out var network) ||
            network.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in network.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String &&
                item.GetString() is { } value &&
                value.Trim().Length > 0)
            {
                result.Add((JsonNode?)JsonValue.Create(value.Trim()));
            }
        }
        return result;
    }

    private static JsonArray NormalizeRenderers(JsonElement root)
    {
        var result = new JsonArray();
        if (!root.TryGetProperty("renderers", out var renderers) || renderers.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in renderers.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }
            var name = ReadString(item, "name").Trim();
            var entry = ReadString(item, "entry").Trim();
            if (name.Length == 0 || entry.Length == 0)
            {
                continue;
            }
            if (!seen.Add(name))
            {
                throw new InvalidOperationException($"duplicate renderer name: {name}");
            }
            result.Add((JsonNode?)new JsonObject
            {
                ["name"] = name,
                ["type"] = "html",
                ["entry"] = entry
            });
        }
        return result;
    }

    private static JsonArray NormalizeComponents(JsonElement root)
    {
        var result = new JsonArray();
        if (!root.TryGetProperty("components", out var components) || components.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in components.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }
            var name = ReadString(item, "name").Trim();
            var entry = ReadString(item, "entry").Trim();
            if (name.Length == 0 || entry.Length == 0)
            {
                continue;
            }
            if (!seen.Add(name))
            {
                throw new InvalidOperationException($"duplicate component name: {name}");
            }
            var component = new JsonObject
            {
                ["name"] = name,
                ["type"] = "html",
                ["entry"] = entry
            };
            AddOptionalString(component, item, "title");
            AddOptionalString(component, item, "description");
            result.Add((JsonNode?)component);
        }
        return result;
    }

    private static JsonObject ReadStateRoot()
    {
        return ReadJsonNodeObject(ExtensionsStatePath());
    }

    private static JsonObject ReadStorageRoot()
    {
        return ReadJsonNodeObject(ExtensionsStoragePath());
    }

    private static JsonObject ReadJsonNodeObject(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
            {
                return [];
            }
            return System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(filePath)) as JsonObject ?? [];
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"extension json read failed path={filePath} error={ex.GetType().Name}: {ex.Message}");
            return [];
        }
    }

    private static void WriteJsonNode(string filePath, JsonNode node)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tempPath, node.ToJsonString(ManagementJsonOptions));
        File.Move(tempPath, filePath, true);
    }

    private static JsonObject GetOrCreateState(
        JsonObject stateRoot,
        string id,
        JsonObject manifest,
        bool enabled,
        long now)
    {
        if (stateRoot[id] is JsonObject state)
        {
            return state;
        }

        state = CreateState(manifest, enabled, now);
        stateRoot[id] = state;
        return state;
    }

    private static JsonObject CreateState(JsonObject manifest, bool enabled, long now)
    {
        return new JsonObject
        {
            ["enabled"] = enabled,
            ["installedAt"] = now,
            ["updatedAt"] = now,
            ["config"] = BuildStateConfigWithDefaults(manifest, new Dictionary<string, string>(StringComparer.Ordinal))
        };
    }

    private static Dictionary<string, string> GetStateConfig(JsonObject state)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (state["config"] is not JsonObject config)
        {
            return result;
        }

        foreach (var property in config)
        {
            if (property.Value is JsonValue jsonValue &&
                jsonValue.TryGetValue<string>(out var text))
            {
                result[property.Key] = text;
            }
        }
        return result;
    }

    private static Dictionary<string, string> BuildRuntimeConfig(
        string extensionId,
        JsonObject manifest,
        IReadOnlyDictionary<string, string> stateConfig)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var secretKeys = GetSecretKeys(manifest).ToHashSet(StringComparer.Ordinal);

        if (manifest["configSchema"] is JsonArray schema)
        {
            foreach (var item in schema.OfType<JsonObject>())
            {
                var key = ReadNodeString(item, "key");
                if (key.Length > 0)
                {
                    result[key] = ReadNodeString(item, "defaultValue");
                }
            }
        }

        foreach (var item in stateConfig)
        {
            if (!secretKeys.Contains(item.Key))
            {
                result[item.Key] = item.Value;
            }
        }

        foreach (var key in secretKeys)
        {
            result[key] = ConfigStore.GetStringValue(SecretConfigKey(extensionId, key));
        }

        return result;
    }

    private static JsonObject BuildRuntimeConfigNode(
        string extensionId,
        JsonObject manifest,
        IReadOnlyDictionary<string, string> stateConfig)
    {
        var runtime = BuildRuntimeConfig(extensionId, manifest, stateConfig);
        var result = new JsonObject();
        foreach (var item in runtime)
        {
            result[item.Key] = item.Value;
        }
        return result;
    }

    private static JsonObject BuildStateConfigWithDefaults(
        JsonObject manifest,
        IReadOnlyDictionary<string, string> currentConfig)
    {
        var result = new JsonObject();
        if (manifest["configSchema"] is JsonArray schema)
        {
            foreach (var item in schema.OfType<JsonObject>())
            {
                var key = ReadNodeString(item, "key");
                if (key.Length > 0)
                {
                    result[key] = ReadNodeString(item, "defaultValue");
                }
            }
        }

        foreach (var item in currentConfig)
        {
            result[item.Key] = item.Value;
        }
        return result;
    }

    private static JsonObject SplitAndPersistConfig(
        string extensionId,
        JsonObject manifest,
        IReadOnlyDictionary<string, string> nextConfig)
    {
        var secretKeys = GetSecretKeys(manifest).ToHashSet(StringComparer.Ordinal);
        var stateConfig = new JsonObject();
        foreach (var item in nextConfig)
        {
            if (secretKeys.Contains(item.Key))
            {
                ConfigStore.SetValue(SecretConfigKey(extensionId, item.Key), JsonValue.Create(item.Value));
            }
            else
            {
                stateConfig[item.Key] = item.Value;
            }
        }
        return stateConfig;
    }

    private static IEnumerable<string> GetSecretKeys(JsonObject manifest)
    {
        if (manifest["configSchema"] is not JsonArray schema)
        {
            yield break;
        }

        foreach (var item in schema.OfType<JsonObject>())
        {
            if (ReadNodeString(item, "type") == "secret")
            {
                var key = ReadNodeString(item, "key");
                if (key.Length > 0)
                {
                    yield return key;
                }
            }
        }
    }

    private static bool ShouldUpdateExtension(JsonObject sourceManifest, string sourceDir, string targetDir)
    {
        if (!File.Exists(Path.Combine(targetDir, ExtensionManifestFileName)))
        {
            return true;
        }

        try
        {
            var targetManifest = ReadNormalizedManifestNode(targetDir);
            if (ReadNodeString(targetManifest, "version") != ReadNodeString(sourceManifest, "version"))
            {
                return true;
            }

            return !string.Equals(
                ComputeDirectoryFingerprint(sourceDir),
                ComputeDirectoryFingerprint(targetDir),
                StringComparison.Ordinal);
        }
        catch
        {
            return true;
        }
    }

    private static string ComputeDirectoryFingerprint(string rootDir)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];

        foreach (var file in Directory.EnumerateFiles(rootDir, "*", SearchOption.AllDirectories)
                     .OrderBy(path => Path.GetRelativePath(rootDir, path), StringComparer.Ordinal))
        {
            var relativePath = Path.GetRelativePath(rootDir, file).Replace('\\', '/');
            var pathBytes = System.Text.Encoding.UTF8.GetBytes(relativePath);
            hash.AppendData(pathBytes);
            hash.AppendData(new byte[] { 0 });

            using var stream = File.OpenRead(file);
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                hash.AppendData(buffer, 0, read);
            }

            hash.AppendData(new byte[] { 0xff });
        }

        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static void CopyDirectory(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var directory in Directory.EnumerateDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(targetDir, Path.GetRelativePath(sourceDir, directory)));
        }
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            var targetFile = Path.Combine(targetDir, Path.GetRelativePath(sourceDir, file));
            Directory.CreateDirectory(Path.GetDirectoryName(targetFile)!);
            File.Copy(file, targetFile, overwrite: true);
        }
    }

    private static void ReplaceDirectory(string sourceDir, string targetDir)
    {
        if (Directory.Exists(targetDir))
        {
            Directory.Delete(targetDir, recursive: true);
        }
        CopyDirectory(sourceDir, targetDir);
    }

    private static string ResolveExtensionAssetPath(string extensionId, string relativePath)
    {
        var root = Path.GetFullPath(ResolveExtensionPath(extensionId));
        var target = Path.GetFullPath(Path.Combine(root, relativePath));
        if (target != root && !target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Path escapes extension directory");
        }
        if (Directory.Exists(target))
        {
            throw new InvalidOperationException($"Asset not found: {relativePath}");
        }
        return target;
    }

    private static string NormalizeStorageKey(string? value)
    {
        var key = (value ?? string.Empty).Trim();
        if (key.Length == 0 || key.Length > 256)
        {
            throw new InvalidOperationException("Extension storage key must be 1-256 characters");
        }
        return key;
    }

    private static string ExtensionsStoragePath()
    {
        return Path.Combine(DataDirectory(), ExtensionsStorageFileName);
    }

    private static JsonNode? CloneElement(JsonElement element)
    {
        return System.Text.Json.Nodes.JsonNode.Parse(element.GetRawText());
    }

    private static string? ReadOptionalString(JsonElement element, string name)
    {
        var value = ReadString(element, name).Trim();
        return value.Length == 0 ? null : value;
    }

    private static void AddOptionalString(JsonObject target, JsonElement element, string name)
    {
        if (ReadOptionalString(element, name) is { Length: > 0 } value)
        {
            target[name] = value;
        }
    }

    private static string ReadNodeString(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : string.Empty;
    }

    private static bool ReadNodeBool(JsonObject obj, string name, bool fallback)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<bool>(out var result)
                ? result
                : fallback;
    }

    private static long ReadNodeLong(JsonObject obj, string name, long fallback)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<long>(out var result)
                ? result
                : fallback;
    }

    private static bool JsonEquals(JsonNode? left, JsonNode? right)
    {
        return (left?.ToJsonString(ManagementJsonOptions) ?? "null") ==
            (right?.ToJsonString(ManagementJsonOptions) ?? "null");
    }

    private static JsonObject Mutation(bool success, string? error)
    {
        var result = new JsonObject { ["success"] = success };
        if (!string.IsNullOrWhiteSpace(error))
        {
            result["error"] = error;
        }
        return result;
    }

    private static WorkerResponse ToResponse(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString(ManagementJsonOptions));
    }
}
