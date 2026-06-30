using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed class NativeSshConfigData
{
    public List<NativeSshConfigGroup> Groups { get; set; } = [];
    public List<NativeSshConfigConnection> Connections { get; set; } = [];
}

internal sealed class NativeSshConfigGroup
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
}

internal sealed class NativeSshConfigConnection
{
    public string Id { get; set; } = string.Empty;
    public string? GroupId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; } = 22;
    public string Username { get; set; } = string.Empty;
    public string AuthType { get; set; } = "password";
    public string? Password { get; set; }
    public string? PrivateKeyPath { get; set; }
    public string? Passphrase { get; set; }
    public string? StartupCommand { get; set; }
    public string? DefaultDirectory { get; set; }
    public string? ProxyJump { get; set; }
    public int KeepAliveInterval { get; set; } = 60;
    public int SortOrder { get; set; }
    public long? LastConnectedAt { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
}

internal sealed class NativeOpenSshHostConfig
{
    public string Host { get; set; } = string.Empty;
    public string? HostName { get; set; }
    public string? User { get; set; }
    public int? Port { get; set; }
    public string? IdentityFile { get; set; }
    public string? ProxyJump { get; set; }
}

internal static class SshConfigStore
{
    private const string ConfigFileName = ".open-cowork.json";
    private static readonly object Sync = new();
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse Snapshot(JsonElement parameters)
    {
        lock (Sync)
        {
            return ToResponse(ConfigToJson(ReadConfigUnlocked()));
        }
    }

    public static WorkerResponse WriteSnapshot(JsonElement parameters)
    {
        lock (Sync)
        {
            var next = ConfigFromElement(parameters);
            WriteConfigUnlocked(next);
            WorkerLog.Debug(
                $"ssh config write snapshot groups={next.Groups.Count} connections={next.Connections.Count}");
            return ToResponse(Mutation(true, null, next));
        }
    }

    public static WorkerResponse ListGroups(JsonElement parameters)
    {
        lock (Sync)
        {
            var result = new JsonArray(
                ReadConfigUnlocked()
                    .Groups
                    .OrderBy(group => group.SortOrder)
                    .Select(group => (JsonNode?)GroupToJson(group))
                    .ToArray());
            return ToResponse(result);
        }
    }

    public static WorkerResponse CreateGroup(JsonElement parameters)
    {
        try
        {
            lock (Sync)
            {
                var group = GroupFromElement(parameters);
                if (string.IsNullOrWhiteSpace(group.Id) || string.IsNullOrWhiteSpace(group.Name))
                {
                    return ToResponse(Mutation(false, "Invalid SSH group", null));
                }

                var config = ReadConfigUnlocked();
                config.Groups.RemoveAll(item => string.Equals(item.Id, group.Id, StringComparison.Ordinal));
                config.Groups.Add(group);
                WriteConfigUnlocked(config);
                WorkerLog.Debug($"ssh config group create id={group.Id}");
                return ToResponse(Mutation(true, null, config));
            }
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message, null));
        }
    }

    public static WorkerResponse UpdateGroup(JsonElement parameters)
    {
        try
        {
            var id = ReadId(parameters);
            if (string.IsNullOrWhiteSpace(id))
            {
                return ToResponse(Mutation(false, "Missing SSH group id", null));
            }

            lock (Sync)
            {
                var config = ReadConfigUnlocked();
                var group = config.Groups.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.Ordinal));
                if (group is null)
                {
                    return ToResponse(Mutation(false, "SSH group not found", config));
                }

                var patch = parameters.TryGetProperty("patch", out var patchElement) &&
                    patchElement.ValueKind == JsonValueKind.Object
                        ? patchElement
                        : parameters;
                if (JsonHelpers.GetString(patch, "name") is { Length: > 0 } name)
                {
                    group.Name = name;
                }
                if (TryGetInt(patch, "sortOrder", out var sortOrder))
                {
                    group.SortOrder = sortOrder;
                }
                if (TryGetLong(patch, "updatedAt", out var updatedAt))
                {
                    group.UpdatedAt = updatedAt;
                }

                WriteConfigUnlocked(config);
                WorkerLog.Debug($"ssh config group update id={id}");
                return ToResponse(Mutation(true, null, config));
            }
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message, null));
        }
    }

    public static WorkerResponse DeleteGroup(JsonElement parameters)
    {
        try
        {
            var id = ReadId(parameters);
            if (string.IsNullOrWhiteSpace(id))
            {
                return ToResponse(Mutation(false, "Missing SSH group id", null));
            }

            lock (Sync)
            {
                var config = ReadConfigUnlocked();
                config.Groups.RemoveAll(group => string.Equals(group.Id, id, StringComparison.Ordinal));
                foreach (var connection in config.Connections)
                {
                    if (string.Equals(connection.GroupId, id, StringComparison.Ordinal))
                    {
                        connection.GroupId = null;
                    }
                }
                WriteConfigUnlocked(config);
                WorkerLog.Debug($"ssh config group delete id={id}");
                return ToResponse(Mutation(true, null, config));
            }
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message, null));
        }
    }

    public static WorkerResponse ListConnections(JsonElement parameters)
    {
        lock (Sync)
        {
            var result = new JsonArray(
                ReadConfigUnlocked()
                    .Connections
                    .OrderBy(connection => connection.SortOrder)
                    .Select(connection => (JsonNode?)ConnectionToJson(connection))
                    .ToArray());
            return ToResponse(result);
        }
    }

    public static WorkerResponse GetConnection(JsonElement parameters)
    {
        var id = ReadId(parameters);
        lock (Sync)
        {
            var connection = ReadConfigUnlocked()
                .Connections
                .FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.Ordinal));
            return ToResponse(connection is null ? new JsonObject { ["connection"] = null } : new JsonObject
            {
                ["connection"] = ConnectionToJson(connection)
            });
        }
    }

    public static WorkerResponse CreateConnection(JsonElement parameters)
    {
        try
        {
            lock (Sync)
            {
                var connection = ConnectionFromElement(parameters);
                if (string.IsNullOrWhiteSpace(connection.Id) ||
                    string.IsNullOrWhiteSpace(connection.Name) ||
                    string.IsNullOrWhiteSpace(connection.Host) ||
                    string.IsNullOrWhiteSpace(connection.Username))
                {
                    return ToResponse(Mutation(false, "Invalid SSH connection", null));
                }

                var config = ReadConfigUnlocked();
                config.Connections.RemoveAll(item => string.Equals(item.Id, connection.Id, StringComparison.Ordinal));
                config.Connections.Add(connection);
                WriteConfigUnlocked(config);
                WorkerLog.Debug($"ssh config connection create id={connection.Id}");
                return ToResponse(Mutation(true, null, config));
            }
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message, null));
        }
    }

    public static WorkerResponse UpdateConnection(JsonElement parameters)
    {
        try
        {
            var id = ReadId(parameters);
            if (string.IsNullOrWhiteSpace(id))
            {
                return ToResponse(Mutation(false, "Missing SSH connection id", null));
            }

            lock (Sync)
            {
                var config = ReadConfigUnlocked();
                var connection = config.Connections.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.Ordinal));
                if (connection is null)
                {
                    return ToResponse(Mutation(false, "SSH connection not found", config));
                }

                var patch = parameters.TryGetProperty("patch", out var patchElement) &&
                    patchElement.ValueKind == JsonValueKind.Object
                        ? patchElement
                        : parameters;
                ApplyConnectionPatch(connection, patch);
                WriteConfigUnlocked(config);
                WorkerLog.Debug($"ssh config connection update id={id}");
                return ToResponse(Mutation(true, null, config));
            }
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message, null));
        }
    }

    public static WorkerResponse DeleteConnection(JsonElement parameters)
    {
        try
        {
            var id = ReadId(parameters);
            if (string.IsNullOrWhiteSpace(id))
            {
                return ToResponse(Mutation(false, "Missing SSH connection id", null));
            }

            lock (Sync)
            {
                var config = ReadConfigUnlocked();
                config.Connections.RemoveAll(connection => string.Equals(connection.Id, id, StringComparison.Ordinal));
                WriteConfigUnlocked(config);
                WorkerLog.Debug($"ssh config connection delete id={id}");
                return ToResponse(Mutation(true, null, config));
            }
        }
        catch (Exception ex)
        {
            return ToResponse(Mutation(false, ex.Message, null));
        }
    }

    public static WorkerResponse OpenSshHost(JsonElement parameters)
    {
        try
        {
            var alias = JsonHelpers.GetString(parameters, "alias") ??
                (parameters.ValueKind == JsonValueKind.String ? parameters.GetString() : null);
            if (string.IsNullOrWhiteSpace(alias))
            {
                return WorkerResponse.RawJson("null");
            }

            var configPath = JsonHelpers.GetString(parameters, "configPath") ??
                Path.Combine(HomeDirectory(), ".ssh", "config");
            var hosts = ParseOpenSshConfigFile(configPath, []);
            return hosts.TryGetValue(alias.Trim(), out var host)
                ? ToResponse(OpenSshHostToJson(host))
                : WorkerResponse.RawJson("null");
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"ssh openssh host parse failed error={ex.GetType().Name}: {ex.Message}");
            return WorkerResponse.RawJson("null");
        }
    }

    internal static NativeSshConfigData ReadConfig()
    {
        lock (Sync)
        {
            return CloneConfig(ReadConfigUnlocked());
        }
    }

    internal static void WriteConfig(NativeSshConfigData config)
    {
        lock (Sync)
        {
            WriteConfigUnlocked(CloneConfig(config));
        }
    }

    internal static NativeSshConfigData CloneConfig(NativeSshConfigData config)
    {
        return new NativeSshConfigData
        {
            Groups = config.Groups.Select(CloneGroup).ToList(),
            Connections = config.Connections.Select(CloneConnection).ToList()
        };
    }

    internal static JsonObject ConfigToJson(NativeSshConfigData config)
    {
        return new JsonObject
        {
            ["groups"] = new JsonArray(config.Groups.Select(group => (JsonNode?)GroupToJson(group)).ToArray()),
            ["connections"] = new JsonArray(
                config.Connections.Select(connection => (JsonNode?)ConnectionToJson(connection)).ToArray())
        };
    }

    internal static JsonObject GroupToJson(NativeSshConfigGroup group)
    {
        return new JsonObject
        {
            ["id"] = group.Id,
            ["name"] = group.Name,
            ["sortOrder"] = group.SortOrder,
            ["createdAt"] = group.CreatedAt,
            ["updatedAt"] = group.UpdatedAt
        };
    }

    internal static JsonObject ConnectionToJson(NativeSshConfigConnection connection)
    {
        return new JsonObject
        {
            ["id"] = connection.Id,
            ["groupId"] = connection.GroupId,
            ["name"] = connection.Name,
            ["host"] = connection.Host,
            ["port"] = connection.Port,
            ["username"] = connection.Username,
            ["authType"] = connection.AuthType,
            ["password"] = connection.Password,
            ["privateKeyPath"] = connection.PrivateKeyPath,
            ["passphrase"] = connection.Passphrase,
            ["startupCommand"] = connection.StartupCommand,
            ["defaultDirectory"] = connection.DefaultDirectory,
            ["proxyJump"] = connection.ProxyJump,
            ["keepAliveInterval"] = connection.KeepAliveInterval,
            ["sortOrder"] = connection.SortOrder,
            ["lastConnectedAt"] = connection.LastConnectedAt,
            ["createdAt"] = connection.CreatedAt,
            ["updatedAt"] = connection.UpdatedAt
        };
    }

    internal static NativeSshConfigGroup? GroupFromNode(JsonNode? node)
    {
        if (node is not JsonObject obj)
        {
            return null;
        }

        var id = ReadString(obj, "id");
        var name = ReadString(obj, "name");
        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        var createdAt = ReadLong(obj, "createdAt", Now());
        return new NativeSshConfigGroup
        {
            Id = id,
            Name = name,
            SortOrder = ReadInt(obj, "sortOrder", 0),
            CreatedAt = createdAt,
            UpdatedAt = ReadLong(obj, "updatedAt", createdAt)
        };
    }

    internal static NativeSshConfigConnection? ConnectionFromNode(JsonNode? node)
    {
        if (node is not JsonObject obj)
        {
            return null;
        }

        var id = ReadString(obj, "id");
        var name = ReadString(obj, "name");
        var host = ReadString(obj, "host");
        var username = ReadString(obj, "username");
        if (string.IsNullOrWhiteSpace(id) ||
            string.IsNullOrWhiteSpace(name) ||
            string.IsNullOrWhiteSpace(host) ||
            string.IsNullOrWhiteSpace(username))
        {
            return null;
        }

        var createdAt = ReadLong(obj, "createdAt", Now());
        return new NativeSshConfigConnection
        {
            Id = id,
            GroupId = ReadString(obj, "groupId"),
            Name = name,
            Host = host,
            Port = ReadInt(obj, "port", 22),
            Username = username,
            AuthType = NormalizeAuthType(ReadString(obj, "authType")),
            Password = ReadString(obj, "password"),
            PrivateKeyPath = ReadString(obj, "privateKeyPath"),
            Passphrase = ReadString(obj, "passphrase"),
            StartupCommand = ReadString(obj, "startupCommand"),
            DefaultDirectory = ReadString(obj, "defaultDirectory"),
            ProxyJump = ReadString(obj, "proxyJump"),
            KeepAliveInterval = ReadInt(obj, "keepAliveInterval", 60),
            SortOrder = ReadInt(obj, "sortOrder", 0),
            LastConnectedAt = ReadNullableLong(obj, "lastConnectedAt"),
            CreatedAt = createdAt,
            UpdatedAt = ReadLong(obj, "updatedAt", createdAt)
        };
    }

    internal static string NextId(string prefix)
    {
        var head = $"{prefix}-{Now()}-";
        return head + Guid.NewGuid().ToString("N")[..6];
    }

    internal static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    internal static WorkerResponse ToResponse(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString());
    }

    internal static JsonObject Mutation(bool success, string? error, NativeSshConfigData? config)
    {
        var result = new JsonObject { ["success"] = success };
        if (!string.IsNullOrWhiteSpace(error))
        {
            result["error"] = error;
        }
        if (config is not null)
        {
            result["config"] = ConfigToJson(config);
        }
        return result;
    }

    private static NativeSshConfigData ReadConfigUnlocked()
    {
        var filePath = GetConfigPath();
        if (!File.Exists(filePath))
        {
            return new NativeSshConfigData();
        }

        try
        {
            var root = ReadRootUnlocked();
            if (root["ssh"] is not JsonObject ssh)
            {
                return new NativeSshConfigData();
            }

            var config = new NativeSshConfigData();
            if (ssh["groups"] is JsonArray groups)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in groups)
                {
                    var group = GroupFromNode(item);
                    if (group is null || !seen.Add(group.Id))
                    {
                        continue;
                    }
                    config.Groups.Add(group);
                }
            }

            if (ssh["connections"] is JsonArray connections)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in connections)
                {
                    var connection = ConnectionFromNode(item);
                    if (connection is null || !seen.Add(connection.Id))
                    {
                        continue;
                    }
                    config.Connections.Add(connection);
                }
            }

            return config;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"ssh config read failed error={ex.GetType().Name}: {ex.Message}");
            return new NativeSshConfigData();
        }
    }

    private static void WriteConfigUnlocked(NativeSshConfigData config)
    {
        var root = ReadRootUnlocked();
        root["ssh"] = ConfigToJson(config);
        WriteRootUnlocked(root);
    }

    private static JsonObject ReadRootUnlocked()
    {
        var filePath = GetConfigPath();
        if (!File.Exists(filePath))
        {
            return [];
        }

        try
        {
            var root = JsonNode.Parse(File.ReadAllText(filePath)) as JsonObject;
            return root ?? [];
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"ssh config root read failed error={ex.GetType().Name}: {ex.Message}");
            return [];
        }
    }

    private static void WriteRootUnlocked(JsonObject root)
    {
        var filePath = GetConfigPath();
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tempPath, root.ToJsonString(WriteOptions));
        File.Move(tempPath, filePath, true);
    }

    private static NativeSshConfigData ConfigFromElement(JsonElement element)
    {
        var node = JsonNode.Parse(element.GetRawText()) as JsonObject ?? [];
        var config = new NativeSshConfigData();
        if (node["groups"] is JsonArray groups)
        {
            foreach (var item in groups)
            {
                if (GroupFromNode(item) is { } group)
                {
                    config.Groups.Add(group);
                }
            }
        }
        if (node["connections"] is JsonArray connections)
        {
            foreach (var item in connections)
            {
                if (ConnectionFromNode(item) is { } connection)
                {
                    config.Connections.Add(connection);
                }
            }
        }
        return config;
    }

    private static NativeSshConfigGroup GroupFromElement(JsonElement element)
    {
        return GroupFromNode(JsonNode.Parse(element.GetRawText())) ?? new NativeSshConfigGroup();
    }

    private static NativeSshConfigConnection ConnectionFromElement(JsonElement element)
    {
        return ConnectionFromNode(JsonNode.Parse(element.GetRawText())) ?? new NativeSshConfigConnection();
    }

    private static void ApplyConnectionPatch(NativeSshConfigConnection connection, JsonElement patch)
    {
        ApplyNullableStringPatch(patch, "groupId", value => connection.GroupId = value);
        ApplyStringPatch(patch, "name", value => connection.Name = value);
        ApplyStringPatch(patch, "host", value => connection.Host = value);
        if (TryGetInt(patch, "port", out var port))
        {
            connection.Port = port;
        }
        ApplyStringPatch(patch, "username", value => connection.Username = value);
        ApplyStringPatch(patch, "authType", value => connection.AuthType = NormalizeAuthType(value));
        ApplyNullableStringPatch(patch, "password", value => connection.Password = value);
        ApplyNullableStringPatch(patch, "privateKeyPath", value => connection.PrivateKeyPath = value);
        ApplyNullableStringPatch(patch, "passphrase", value => connection.Passphrase = value);
        ApplyNullableStringPatch(patch, "startupCommand", value => connection.StartupCommand = value);
        ApplyNullableStringPatch(patch, "defaultDirectory", value => connection.DefaultDirectory = value);
        ApplyNullableStringPatch(patch, "proxyJump", value => connection.ProxyJump = value);
        if (TryGetInt(patch, "keepAliveInterval", out var keepAliveInterval))
        {
            connection.KeepAliveInterval = keepAliveInterval;
        }
        if (TryGetInt(patch, "sortOrder", out var sortOrder))
        {
            connection.SortOrder = sortOrder;
        }
        if (TryGetLong(patch, "lastConnectedAt", out var lastConnectedAt))
        {
            connection.LastConnectedAt = lastConnectedAt;
        }
        else if (HasNullProperty(patch, "lastConnectedAt"))
        {
            connection.LastConnectedAt = null;
        }
        if (TryGetLong(patch, "updatedAt", out var updatedAt))
        {
            connection.UpdatedAt = updatedAt;
        }
    }

    private static void ApplyStringPatch(JsonElement element, string name, Action<string> apply)
    {
        if (JsonHelpers.GetString(element, name) is { } value)
        {
            apply(value);
        }
    }

    private static void ApplyNullableStringPatch(JsonElement element, string name, Action<string?> apply)
    {
        if (!element.TryGetProperty(name, out var property))
        {
            return;
        }

        apply(property.ValueKind == JsonValueKind.Null ? null : property.GetString());
    }

    private static bool HasNullProperty(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.Null;
    }

    private static NativeSshConfigGroup CloneGroup(NativeSshConfigGroup group)
    {
        return new NativeSshConfigGroup
        {
            Id = group.Id,
            Name = group.Name,
            SortOrder = group.SortOrder,
            CreatedAt = group.CreatedAt,
            UpdatedAt = group.UpdatedAt
        };
    }

    private static NativeSshConfigConnection CloneConnection(NativeSshConfigConnection connection)
    {
        return new NativeSshConfigConnection
        {
            Id = connection.Id,
            GroupId = connection.GroupId,
            Name = connection.Name,
            Host = connection.Host,
            Port = connection.Port,
            Username = connection.Username,
            AuthType = connection.AuthType,
            Password = connection.Password,
            PrivateKeyPath = connection.PrivateKeyPath,
            Passphrase = connection.Passphrase,
            StartupCommand = connection.StartupCommand,
            DefaultDirectory = connection.DefaultDirectory,
            ProxyJump = connection.ProxyJump,
            KeepAliveInterval = connection.KeepAliveInterval,
            SortOrder = connection.SortOrder,
            LastConnectedAt = connection.LastConnectedAt,
            CreatedAt = connection.CreatedAt,
            UpdatedAt = connection.UpdatedAt
        };
    }

    private static string NormalizeAuthType(string? value)
    {
        return value is "privateKey" or "agent" or "password" ? value : "password";
    }

    private static string? ReadId(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.String ? parameters.GetString() : JsonHelpers.GetString(parameters, "id");
    }

    private static string? ReadString(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    private static int ReadInt(JsonObject obj, string name, int fallback)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<int>(out var number)
                ? number
                : fallback;
    }

    private static long ReadLong(JsonObject obj, string name, long fallback)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<long>(out var number)
                ? number
                : fallback;
    }

    private static long? ReadNullableLong(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<long>(out var number)
                ? number
                : null;
    }

    private static bool TryGetInt(JsonElement element, string name, out int value)
    {
        value = 0;
        if (!element.TryGetProperty(name, out var property))
        {
            return false;
        }
        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out value))
        {
            return true;
        }
        if (property.ValueKind == JsonValueKind.String && int.TryParse(property.GetString(), out value))
        {
            return true;
        }
        return false;
    }

    private static bool TryGetLong(JsonElement element, string name, out long value)
    {
        value = 0;
        if (!element.TryGetProperty(name, out var property))
        {
            return false;
        }
        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out value))
        {
            return true;
        }
        if (property.ValueKind == JsonValueKind.String && long.TryParse(property.GetString(), out value))
        {
            return true;
        }
        return false;
    }

    private static string GetConfigPath()
    {
        return Path.Combine(HomeDirectory(), ConfigFileName);
    }

    private static string HomeDirectory()
    {
        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    private static string StripInlineComment(string value)
    {
        var index = value.IndexOf('#', StringComparison.Ordinal);
        return index >= 0 ? value[..index].Trim() : value.Trim();
    }

    private static string ParseOpenSshValue(string raw)
    {
        var trimmed = StripInlineComment(raw);
        if (trimmed.Length >= 2 &&
            ((trimmed.StartsWith('"') && trimmed.EndsWith('"')) ||
             (trimmed.StartsWith('\'') && trimmed.EndsWith('\''))))
        {
            return trimmed[1..^1];
        }
        return trimmed;
    }

    internal static string ExpandHome(string filePath)
    {
        if (filePath == "~")
        {
            return HomeDirectory();
        }
        if (filePath.StartsWith("~/", StringComparison.Ordinal) ||
            filePath.StartsWith("~\\", StringComparison.Ordinal))
        {
            return Path.Combine(HomeDirectory(), filePath[2..]);
        }
        return filePath;
    }

    private static IReadOnlyList<string> ResolveIncludePath(string baseDir, string includePath)
    {
        var expanded = ExpandHome(includePath);
        if (Path.IsPathRooted(expanded))
        {
            return expanded.Contains('*', StringComparison.Ordinal) ? [] : [expanded];
        }
        var absolute = Path.Combine(baseDir, expanded);
        return absolute.Contains('*', StringComparison.Ordinal) ? [] : [absolute];
    }

    private static Dictionary<string, NativeOpenSshHostConfig> ParseOpenSshConfigFile(
        string filePath,
        HashSet<string> visited)
    {
        var resolvedPath = ExpandHome(filePath);
        var hosts = new Dictionary<string, NativeOpenSshHostConfig>(StringComparer.Ordinal);
        if (!File.Exists(resolvedPath) || !visited.Add(resolvedPath))
        {
            return hosts;
        }

        var baseDir = Path.GetDirectoryName(resolvedPath) ?? HomeDirectory();
        var lines = File.ReadAllLines(resolvedPath);
        var currentAliases = new List<string>();
        var current = new NativeOpenSshHostConfig();

        void Flush()
        {
            if (currentAliases.Count == 0)
            {
                return;
            }

            foreach (var alias in currentAliases)
            {
                if (string.IsNullOrWhiteSpace(alias) ||
                    alias.Contains('*', StringComparison.Ordinal) ||
                    alias.Contains('?', StringComparison.Ordinal))
                {
                    continue;
                }

                hosts[alias] = new NativeOpenSshHostConfig
                {
                    Host = alias,
                    HostName = current.HostName,
                    User = current.User,
                    Port = current.Port,
                    IdentityFile = current.IdentityFile,
                    ProxyJump = current.ProxyJump
                };
            }
        }

        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#'))
            {
                continue;
            }

            var match = System.Text.RegularExpressions.Regex.Match(rawLine, @"^\s*(\S+)\s+(.*)$");
            if (!match.Success)
            {
                continue;
            }

            var key = match.Groups[1].Value;
            var value = ParseOpenSshValue(match.Groups[2].Value);
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (string.Equals(key, "include", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var includeFile in ResolveIncludePath(baseDir, value))
                {
                    foreach (var item in ParseOpenSshConfigFile(includeFile, visited))
                    {
                        hosts.TryAdd(item.Key, item.Value);
                    }
                }
                continue;
            }

            if (string.Equals(key, "host", StringComparison.OrdinalIgnoreCase))
            {
                Flush();
                currentAliases = value.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
                current = new NativeOpenSshHostConfig();
                continue;
            }

            if (currentAliases.Count == 0)
            {
                continue;
            }

            ApplyOpenSshHostField(current, key, value);
        }

        Flush();
        return hosts;
    }

    private static void ApplyOpenSshHostField(NativeOpenSshHostConfig target, string key, string value)
    {
        switch (key.ToLowerInvariant())
        {
            case "hostname":
                target.HostName = value;
                break;
            case "user":
                target.User = value;
                break;
            case "port":
                if (int.TryParse(value, out var port) && port > 0)
                {
                    target.Port = port;
                }
                break;
            case "identityfile":
                target.IdentityFile = ExpandHome(value);
                break;
            case "proxyjump":
                target.ProxyJump = value;
                break;
        }
    }

    private static JsonObject OpenSshHostToJson(NativeOpenSshHostConfig host)
    {
        return new JsonObject
        {
            ["host"] = host.Host,
            ["hostName"] = host.HostName,
            ["user"] = host.User,
            ["port"] = host.Port,
            ["identityFile"] = host.IdentityFile,
            ["proxyJump"] = host.ProxyJump
        };
    }
}
