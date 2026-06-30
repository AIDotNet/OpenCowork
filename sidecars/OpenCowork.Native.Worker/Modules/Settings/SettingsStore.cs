using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class SettingsStore
{
    private const string DataDirectoryName = ".open-cowork";
    private const string SettingsFileName = "settings.json";
    private static readonly object Sync = new();
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse Read(JsonElement parameters)
    {
        lock (Sync)
        {
            return ToResponse(ReadRoot());
        }
    }

    public static WorkerResponse Write(JsonElement parameters)
    {
        if (CloneElement(parameters) is not JsonObject root)
        {
            return ToResponse(Mutation(false, "Invalid settings root"));
        }

        lock (Sync)
        {
            WriteRoot(root);
        }

        WorkerLog.Debug("settings write root");
        return ToResponse(Mutation(true, null));
    }

    public static WorkerResponse Get(JsonElement parameters)
    {
        var key = ReadKey(parameters);
        lock (Sync)
        {
            var root = ReadRoot();
            if (string.IsNullOrWhiteSpace(key))
            {
                return ToResponse(root);
            }

            return root.TryGetPropertyValue(key, out var value) && value is not null
                ? ToResponse(value.DeepClone())
                : WorkerResponse.RawJson("null");
        }
    }

    public static WorkerResponse Set(JsonElement parameters)
    {
        var key = JsonHelpers.GetString(parameters, "key");
        if (string.IsNullOrWhiteSpace(key))
        {
            return ToResponse(Mutation(false, "Missing settings key"));
        }

        lock (Sync)
        {
            var root = ReadRoot();
            if (!parameters.TryGetProperty("value", out var valueElement) ||
                valueElement.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                root.Remove(key);
                WorkerLog.Debug($"settings delete key={key}");
            }
            else
            {
                root[key] = CloneElement(valueElement);
                WorkerLog.Debug($"settings set key={key}");
            }
            WriteRoot(root);
        }

        return ToResponse(Mutation(true, null));
    }

    public static WorkerResponse Delete(JsonElement parameters)
    {
        var key = ReadKey(parameters);
        if (string.IsNullOrWhiteSpace(key))
        {
            return ToResponse(Mutation(false, "Missing settings key"));
        }

        lock (Sync)
        {
            var root = ReadRoot();
            root.Remove(key);
            WriteRoot(root);
        }

        WorkerLog.Debug($"settings delete key={key}");
        return ToResponse(Mutation(true, null));
    }

    internal static void ReplaceRootFromSync(JsonObject root)
    {
        lock (Sync)
        {
            WriteRoot(root);
        }
    }

    private static JsonObject ReadRoot()
    {
        var filePath = GetSettingsPath();
        if (!File.Exists(filePath))
        {
            return [];
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(filePath));
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                WorkerLog.Warn("settings file is not an object; ignoring invalid content");
                return [];
            }

            return CloneElement(document.RootElement) as JsonObject ?? [];
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"settings read failed error={ex.GetType().Name}: {ex.Message}");
            return [];
        }
    }

    private static void WriteRoot(JsonObject root)
    {
        var filePath = GetSettingsPath();
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);

        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tempPath, root.ToJsonString(WriteOptions));
        File.Move(tempPath, filePath, true);
    }

    private static string GetSettingsPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            DataDirectoryName,
            SettingsFileName);
    }

    private static JsonNode? CloneElement(JsonElement element)
    {
        return JsonNode.Parse(element.GetRawText());
    }

    private static string? ReadKey(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.String
            ? parameters.GetString()
            : JsonHelpers.GetString(parameters, "key");
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
        return WorkerResponse.RawJson(node.ToJsonString(WriteOptions));
    }
}
