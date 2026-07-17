using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class SettingsStore
{
    private const string DataDirectoryName = ".open-cowork";
    private const string SettingsFileName = "settings.json";
    private static readonly object Sync = new();
    private static readonly JsonFileNodeCache<JsonObject> Cache = new();
    private static byte[]? cachedUtf8;
    private static long cachedUtf8Length = -1;
    private static long cachedUtf8WriteTicks = -1;
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse Read(JsonElement parameters)
    {
        lock (Sync)
        {
            return ReadRootResponse();
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
            if (string.IsNullOrWhiteSpace(key))
            {
                return ReadRootResponse();
            }

            using var document = JsonDocument.Parse(ReadRootUtf8());
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty(key, out var value)
                    ? WorkerResponse.DirectMessagePack(writer => writer.WriteJsonElement(value))
                    : WorkerResponse.DirectMessagePack(static writer => writer.WriteNil());
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
        return Cache.Read(
            filePath,
            JsonValueKind.Object,
            static element => CloneElement(element) as JsonObject,
            "settings file") ?? [];
    }

    private static void WriteRoot(JsonObject root)
    {
        var filePath = GetSettingsPath();
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);

        var tempPath = $"{filePath}.{Guid.NewGuid():N}.tmp";
        var utf8 = System.Text.Encoding.UTF8.GetBytes(root.ToJsonString(WriteOptions));
        File.WriteAllBytes(tempPath, utf8);
        File.Move(tempPath, filePath, true);
        Cache.Store(filePath, root);
        StoreUtf8Cache(filePath, utf8);
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
        return WorkerResponse.FromWriter(writer => node.WriteTo(writer));
    }

    private static WorkerResponse ReadRootResponse()
    {
        var utf8 = ReadRootUtf8();
        return utf8.Length == 0
            ? WorkerResponse.DirectMessagePack(static writer => writer.WriteMapHeader(0))
            : WorkerResponse.DirectMessagePackJson(utf8);
    }

    private static byte[] ReadRootUtf8()
    {
        var filePath = GetSettingsPath();
        if (!File.Exists(filePath))
        {
            cachedUtf8 = null;
            cachedUtf8Length = -1;
            cachedUtf8WriteTicks = -1;
            return [];
        }

        var info = new FileInfo(filePath);
        if (cachedUtf8 is not null &&
            info.Length == cachedUtf8Length &&
            info.LastWriteTimeUtc.Ticks == cachedUtf8WriteTicks)
        {
            return cachedUtf8;
        }

        var utf8 = File.ReadAllBytes(filePath);
        StoreUtf8Cache(filePath, utf8);
        return utf8;
    }

    private static void StoreUtf8Cache(string filePath, byte[] utf8)
    {
        cachedUtf8 = utf8;
        var info = new FileInfo(filePath);
        cachedUtf8Length = info.Exists ? info.Length : utf8.Length;
        cachedUtf8WriteTicks = info.Exists ? info.LastWriteTimeUtc.Ticks : -1;
    }
}
