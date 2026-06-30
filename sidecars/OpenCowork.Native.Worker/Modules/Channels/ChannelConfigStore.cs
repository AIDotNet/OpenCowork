using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class ChannelConfigStore
{
    private const string DataDirectoryName = ".open-cowork";
    private const string ConfigFileName = "plugins.json";
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
            return ToResponse(ReadPlugins());
        }
    }

    public static WorkerResponse Write(JsonElement parameters)
    {
        if (CloneElement(parameters) is not JsonArray plugins)
        {
            return ToResponse(Mutation(false, "Invalid channel plugin config"));
        }

        lock (Sync)
        {
            WritePlugins(plugins);
        }

        WorkerLog.Debug($"channel config write count={plugins.Count}");
        return ToResponse(Mutation(true, null));
    }

    public static WorkerResponse Get(JsonElement parameters)
    {
        var id = ReadId(parameters);
        if (string.IsNullOrWhiteSpace(id))
        {
            return ToResponse(new JsonObject { ["plugin"] = null });
        }

        lock (Sync)
        {
            foreach (var plugin in ReadPlugins())
            {
                if (plugin is JsonObject pluginObject &&
                    string.Equals(ReadString(pluginObject, "id"), id, StringComparison.Ordinal))
                {
                    return ToResponse(new JsonObject { ["plugin"] = plugin.DeepClone() });
                }
            }
        }

        return ToResponse(new JsonObject { ["plugin"] = null });
    }

    public static WorkerResponse Add(JsonElement parameters)
    {
        if (CloneElement(parameters) is not JsonObject plugin)
        {
            return ToResponse(Mutation(false, "Invalid channel plugin config"));
        }

        lock (Sync)
        {
            var plugins = ReadPlugins();
            plugins.Add((JsonNode?)plugin);
            WritePlugins(plugins);
        }

        WorkerLog.Debug($"channel config add id={ReadString(plugin, "id") ?? "<unknown>"}");
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
            return ToResponse(Mutation(false, "Invalid channel plugin update"));
        }

        lock (Sync)
        {
            var plugins = ReadPlugins();
            for (var index = 0; index < plugins.Count; index++)
            {
                if (plugins[index] is not JsonObject plugin ||
                    !string.Equals(ReadString(plugin, "id"), id, StringComparison.Ordinal))
                {
                    continue;
                }

                Merge(plugin, patch);
                WritePlugins(plugins);
                WorkerLog.Debug($"channel config update id={id}");
                return ToResponse(Mutation(true, null));
            }
        }

        return ToResponse(Mutation(false, "Plugin not found"));
    }

    public static WorkerResponse Remove(JsonElement parameters)
    {
        var id = ReadId(parameters);
        if (string.IsNullOrWhiteSpace(id))
        {
            return ToResponse(Mutation(false, "Invalid channel plugin id"));
        }

        lock (Sync)
        {
            var plugins = ReadPlugins();
            var removed = false;
            for (var index = plugins.Count - 1; index >= 0; index--)
            {
                if (plugins[index] is JsonObject plugin &&
                    string.Equals(ReadString(plugin, "id"), id, StringComparison.Ordinal))
                {
                    plugins.RemoveAt(index);
                    removed = true;
                }
            }

            if (removed)
            {
                WritePlugins(plugins);
                WorkerLog.Debug($"channel config remove id={id}");
            }
        }

        return ToResponse(Mutation(true, null));
    }

    internal static void ReplacePluginsFromSync(JsonArray plugins)
    {
        lock (Sync)
        {
            WritePlugins(plugins);
        }
    }

    private static JsonArray ReadPlugins()
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
                WorkerLog.Warn("channel config file is not an array; ignoring invalid content");
                return [];
            }

            return CloneElement(document.RootElement) as JsonArray ?? [];
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"channel config read failed error={ex.GetType().Name}: {ex.Message}");
            return [];
        }
    }

    private static void WritePlugins(JsonArray plugins)
    {
        var filePath = GetConfigPath();
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);

        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tempPath, plugins.ToJsonString(WriteOptions));
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
        return JsonNode.Parse(element.GetRawText());
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
