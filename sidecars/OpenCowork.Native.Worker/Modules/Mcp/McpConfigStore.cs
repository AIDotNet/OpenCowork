using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class McpConfigStore
{
    private const string DataDirectoryName = ".open-cowork";
    private const string ConfigFileName = "mcp-servers.json";
    private static readonly object Sync = new();
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse List(JsonElement parameters)
    {
        lock (Sync)
        {
            return ToResponse(ReadServers());
        }
    }

    public static WorkerResponse Get(JsonElement parameters)
    {
        var id = ReadId(parameters);
        if (string.IsNullOrWhiteSpace(id))
        {
            return ToResponse(new JsonObject { ["server"] = null });
        }

        lock (Sync)
        {
            foreach (var server in ReadServers())
            {
                if (server is JsonObject serverObject &&
                    string.Equals(ReadString(serverObject, "id"), id, StringComparison.Ordinal))
                {
                    return ToResponse(new JsonObject { ["server"] = server.DeepClone() });
                }
            }
        }

        return ToResponse(new JsonObject { ["server"] = null });
    }

    public static WorkerResponse Add(JsonElement parameters)
    {
        if (CloneElement(parameters) is not JsonObject config)
        {
            return ToResponse(Mutation(false, "Invalid MCP server config"));
        }

        lock (Sync)
        {
            var servers = ReadServers();
            servers.Add((JsonNode?)config);
            WriteServers(servers);
        }

        WorkerLog.Debug($"mcp config add id={ReadString(config, "id") ?? "<unknown>"}");
        return ToResponse(Mutation(true, null));
    }

    public static WorkerResponse Update(JsonElement parameters)
    {
        var id = JsonHelpers.GetString(parameters, "id");
        if (string.IsNullOrWhiteSpace(id) ||
            parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("patch", out var patchElement) ||
            CloneElement(patchElement) is not JsonObject patch)
        {
            return ToResponse(Mutation(false, "Invalid MCP server update"));
        }

        lock (Sync)
        {
            var servers = ReadServers();
            for (var index = 0; index < servers.Count; index++)
            {
                if (servers[index] is not JsonObject server ||
                    !string.Equals(ReadString(server, "id"), id, StringComparison.Ordinal))
                {
                    continue;
                }

                Merge(server, patch);
                WriteServers(servers);
                WorkerLog.Debug($"mcp config update id={id}");
                return ToResponse(Mutation(true, null));
            }
        }

        return ToResponse(Mutation(false, "Server not found"));
    }

    public static WorkerResponse Remove(JsonElement parameters)
    {
        var id = ReadId(parameters);
        if (string.IsNullOrWhiteSpace(id))
        {
            return ToResponse(Mutation(false, "Invalid MCP server id"));
        }

        lock (Sync)
        {
            var servers = ReadServers();
            var removed = false;
            for (var index = servers.Count - 1; index >= 0; index--)
            {
                if (servers[index] is JsonObject server &&
                    string.Equals(ReadString(server, "id"), id, StringComparison.Ordinal))
                {
                    servers.RemoveAt(index);
                    removed = true;
                }
            }

            if (removed)
            {
                WriteServers(servers);
                WorkerLog.Debug($"mcp config remove id={id}");
            }
        }

        return ToResponse(Mutation(true, null));
    }

    private static JsonArray ReadServers()
    {
        var filePath = GetConfigPath();
        if (!File.Exists(filePath))
        {
            return [];
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(filePath));
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                WorkerLog.Warn("mcp config file is not an array; ignoring invalid content");
                return [];
            }

            return CloneElement(document.RootElement) as JsonArray ?? [];
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"mcp config read failed error={ex.GetType().Name}: {ex.Message}");
            return [];
        }
    }

    private static void WriteServers(JsonArray servers)
    {
        var filePath = GetConfigPath();
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);

        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tempPath, servers.ToJsonString(WriteOptions));
        File.Move(tempPath, filePath, true);
    }

    private static string GetConfigPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            DataDirectoryName,
            ConfigFileName);
    }

    private static JsonNode? CloneElement(JsonElement element)
    {
        return System.Text.Json.Nodes.JsonNode.Parse(element.GetRawText());
    }

    private static string? ReadId(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.String
            ? parameters.GetString()
            : JsonHelpers.GetString(parameters, "id");
    }

    private static string? ReadString(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) && value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    private static void Merge(JsonObject target, JsonObject patch)
    {
        foreach (var property in patch.ToArray())
        {
            target[property.Key] = property.Value?.DeepClone();
        }
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
        return WorkerResponse.RawJson(node.ToJsonString());
    }
}
