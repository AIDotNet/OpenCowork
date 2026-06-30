using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class ExtensionManifestStore
{
    private const string DataDirectoryName = ".open-cowork";
    private const string ExtensionsDirectoryName = "extensions";
    private const string ExtensionsStateFileName = "extensions.json";
    private const string ConfigFileName = "config.json";
    private const string ExtensionManifestFileName = "extension.json";

    public static NativeExtensionInstance FindExtensionOrThrow(string extensionId)
    {
        var normalizedId = NormalizeId(extensionId);
        if (!IsValidExtensionId(normalizedId))
        {
            throw new InvalidOperationException("Invalid extension id");
        }

        var extensionPath = ResolveExtensionPath(normalizedId);
        if (!File.Exists(Path.Combine(extensionPath, ExtensionManifestFileName)))
        {
            throw new InvalidOperationException($"Extension \"{normalizedId}\" not found");
        }

        var manifest = ReadManifest(extensionPath);
        if (!string.Equals(manifest.Id, normalizedId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Extension \"{normalizedId}\" manifest id mismatch");
        }

        var state = ReadState(normalizedId);
        var runtimeConfig = MergeRuntimeConfig(normalizedId, manifest, state.Config);
        return new NativeExtensionInstance(
            normalizedId,
            state.Enabled,
            runtimeConfig,
            manifest);
    }

    private static NativeExtensionManifest ReadManifest(string extensionPath)
    {
        var manifestPath = Path.Combine(extensionPath, ExtensionManifestFileName);
        using var document = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("extension.json must contain an object");
        }

        var schemaVersion = ReadInt(root, "schemaVersion", 0);
        if (schemaVersion != 1)
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

        var configSchema = ReadConfigSchema(root);
        var networkPermissions = ReadNetworkPermissions(root);
        var tools = ReadTools(root);
        if (tools.Count == 0)
        {
            throw new InvalidOperationException("extension must define at least one supported tool");
        }
        if (tools.Any(static tool => tool.Kind == "js") &&
            ReadString(root, "entry").Trim().Length == 0)
        {
            throw new InvalidOperationException("extension entry is required for js tools");
        }

        return new NativeExtensionManifest(
            schemaVersion,
            id,
            name,
            version,
            configSchema,
            networkPermissions,
            tools);
    }

    private static List<NativeExtensionConfigField> ReadConfigSchema(JsonElement root)
    {
        if (!root.TryGetProperty("configSchema", out var schema) || schema.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var fields = new List<NativeExtensionConfigField>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in schema.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var key = ReadString(item, "key").Trim();
            if (key.Length == 0)
            {
                continue;
            }
            if (!seen.Add(key))
            {
                throw new InvalidOperationException($"duplicate config key: {key}");
            }

            var type = ReadString(item, "type") == "secret" ? "secret" : "text";
            var defaultValue = item.TryGetProperty("defaultValue", out var defaultElement) &&
                defaultElement.ValueKind == JsonValueKind.String
                    ? defaultElement.GetString()
                    : null;
            fields.Add(new NativeExtensionConfigField(key, type, defaultValue));
        }

        return fields;
    }

    private static List<string> ReadNetworkPermissions(JsonElement root)
    {
        if (!root.TryGetProperty("permissions", out var permissions) ||
            permissions.ValueKind != JsonValueKind.Object ||
            !permissions.TryGetProperty("network", out var network) ||
            network.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var values = new List<string>();
        foreach (var item in network.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String &&
                item.GetString() is { } value &&
                value.Trim().Length > 0)
            {
                values.Add(value.Trim());
            }
        }
        return values;
    }

    private static List<NativeExtensionToolDefinition> ReadTools(JsonElement root)
    {
        if (!root.TryGetProperty("tools", out var toolsElement) || toolsElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("extension must define at least one tool");
        }

        var tools = new List<NativeExtensionToolDefinition>();
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
            if (kind == "js")
            {
                var handler = ReadString(item, "handler").Trim();
                if (handler.Length == 0)
                {
                    throw new InvalidOperationException($"js tool \"{name}\" requires handler");
                }
                tools.Add(new NativeExtensionToolDefinition(name, kind, null, handler));
                continue;
            }
            if (kind != "http")
            {
                throw new InvalidOperationException($"tool \"{name}\" kind must be \"http\" or \"js\"");
            }

            var http = ReadHttpDefinition(name, item);
            tools.Add(new NativeExtensionToolDefinition(name, kind, http, null));
        }

        return tools;
    }

    private static NativeExtensionHttpDefinition ReadHttpDefinition(string toolName, JsonElement tool)
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

        var headers = new Dictionary<string, string>(StringComparer.Ordinal);
        if (http.TryGetProperty("headers", out var headersElement) &&
            headersElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in headersElement.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.String)
                {
                    headers[property.Name] = property.Value.GetString() ?? string.Empty;
                }
            }
        }

        JsonElement? body = null;
        if (http.TryGetProperty("body", out var bodyElement))
        {
            body = bodyElement.Clone();
        }

        return new NativeExtensionHttpDefinition(method, url, headers, body);
    }

    private static ExtensionState ReadState(string extensionId)
    {
        var states = ReadJsonObject(ExtensionsStatePath());
        if (states is null ||
            !states.RootElement.TryGetProperty(extensionId, out var state) ||
            state.ValueKind != JsonValueKind.Object)
        {
            return new ExtensionState(false, new Dictionary<string, string>(StringComparer.Ordinal));
        }

        return new ExtensionState(
            ReadBool(state, "enabled", false),
            ReadStringMap(state, "config"));
    }

    private static Dictionary<string, string> MergeRuntimeConfig(
        string extensionId,
        NativeExtensionManifest manifest,
        IReadOnlyDictionary<string, string> stateConfig)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var secretKeys = new HashSet<string>(
            manifest.ConfigSchema
                .Where(static field => field.Type == "secret")
                .Select(static field => field.Key),
            StringComparer.Ordinal);

        foreach (var field in manifest.ConfigSchema)
        {
            result[field.Key] = field.DefaultValue ?? string.Empty;
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

    private static Dictionary<string, string> ReadFlatConfig()
    {
        using var document = ReadJsonObject(ConfigPath());
        if (document is null)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in document.RootElement.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                result[property.Name] = property.Value.GetString() ?? string.Empty;
            }
        }
        return result;
    }

    private static Dictionary<string, string> ReadStringMap(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var element) || element.ValueKind != JsonValueKind.Object)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                result[property.Name] = property.Value.GetString() ?? string.Empty;
            }
        }
        return result;
    }

    private static JsonDocument? ReadJsonObject(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
            {
                return null;
            }

            var document = JsonDocument.Parse(File.ReadAllBytes(filePath));
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                document.Dispose();
                return null;
            }
            return document;
        }
        catch
        {
            return null;
        }
    }

    private static string NormalizeId(string? value)
    {
        return (value ?? string.Empty).Trim().ToLowerInvariant();
    }

    private static bool IsValidExtensionId(string value)
    {
        return ExtensionIdRegex().IsMatch(value);
    }

    private static string ReadString(JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? string.Empty
                : string.Empty;
    }

    private static int ReadInt(JsonElement element, string name, int fallback)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.Number &&
            value.TryGetInt32(out var result)
                ? result
                : fallback;
    }

    private static bool ReadBool(JsonElement element, string name, bool fallback)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) &&
            value.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? value.GetBoolean()
                : fallback;
    }

    private static string ResolveExtensionPath(string extensionId)
    {
        var root = Path.GetFullPath(Path.Combine(ExtensionsDirectory(), extensionId));
        var extensionsRoot = Path.GetFullPath(ExtensionsDirectory());
        if (root != extensionsRoot && !root.StartsWith(extensionsRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Path escapes extension directory");
        }
        return root;
    }

    private static string DataDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            DataDirectoryName);
    }

    private static string ExtensionsDirectory()
    {
        return Path.Combine(DataDirectory(), ExtensionsDirectoryName);
    }

    private static string ExtensionsStatePath()
    {
        return Path.Combine(DataDirectory(), ExtensionsStateFileName);
    }

    private static string ConfigPath()
    {
        return Path.Combine(DataDirectory(), ConfigFileName);
    }

    private static string SecretConfigKey(string extensionId, string key)
    {
        return $"extension:{extensionId}:secret:{key}";
    }

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{1,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionIdRegex();

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex ToolNameRegex();

    private readonly record struct ExtensionState(
        bool Enabled,
        IReadOnlyDictionary<string, string> Config);
}
