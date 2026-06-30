using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class QqSessionStore
{
    private const string DataDirectoryName = ".open-cowork";
    private const string QqBotDirectoryName = "qq-bot";
    private const string SessionsDirectoryName = "sessions";
    private const long SessionExpireMs = 5 * 60 * 1000;
    private static readonly object Sync = new();
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    public static WorkerResponse Load(JsonElement parameters)
    {
        var accountId = ReadAccountId(parameters);
        if (string.IsNullOrWhiteSpace(accountId))
        {
            return WorkerResponse.RawJson("null");
        }

        lock (Sync)
        {
            var filePath = GetSessionPath(accountId);
            if (!File.Exists(filePath))
            {
                return WorkerResponse.RawJson("null");
            }

            try
            {
                var node = JsonNode.Parse(File.ReadAllText(filePath)) as JsonObject;
                if (node is null)
                {
                    return WorkerResponse.RawJson("null");
                }

                var savedAt = ReadLong(node, "savedAt");
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (savedAt <= 0 || now - savedAt > SessionExpireMs)
                {
                    File.Delete(filePath);
                    WorkerLog.Debug($"qq session expired accountId={accountId}");
                    return WorkerResponse.RawJson("null");
                }

                if (string.IsNullOrWhiteSpace(ReadString(node, "sessionId")) ||
                    !HasNumber(node, "lastSeq"))
                {
                    return WorkerResponse.RawJson("null");
                }

                return ToResponse(node);
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"qq session load failed accountId={accountId} error={ex.GetType().Name}: {ex.Message}");
                return WorkerResponse.RawJson("null");
            }
        }
    }

    public static WorkerResponse Save(JsonElement parameters)
    {
        var accountId = JsonHelpers.GetString(parameters, "accountId");
        if (string.IsNullOrWhiteSpace(accountId) ||
            parameters.ValueKind != JsonValueKind.Object ||
            CloneElement(parameters) is not JsonObject state)
        {
            return ToResponse(Mutation(false, "Invalid QQ session state"));
        }

        lock (Sync)
        {
            try
            {
                Directory.CreateDirectory(GetSessionsDirectory());
                state["accountId"] = accountId;
                state["savedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                File.WriteAllText(GetSessionPath(accountId), state.ToJsonString(WriteOptions));
                WorkerLog.Debug($"qq session save accountId={accountId}");
                return ToResponse(Mutation(true, null));
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"qq session save failed accountId={accountId} error={ex.GetType().Name}: {ex.Message}");
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    public static WorkerResponse Clear(JsonElement parameters)
    {
        var accountId = ReadAccountId(parameters);
        if (string.IsNullOrWhiteSpace(accountId))
        {
            return ToResponse(Mutation(false, "Missing QQ session account id"));
        }

        lock (Sync)
        {
            try
            {
                var filePath = GetSessionPath(accountId);
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                }
                WorkerLog.Debug($"qq session clear accountId={accountId}");
                return ToResponse(Mutation(true, null));
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"qq session clear failed accountId={accountId} error={ex.GetType().Name}: {ex.Message}");
                return ToResponse(Mutation(false, ex.Message));
            }
        }
    }

    private static string? ReadAccountId(JsonElement parameters)
    {
        return parameters.ValueKind == JsonValueKind.String
            ? parameters.GetString()
            : JsonHelpers.GetString(parameters, "accountId");
    }

    private static string GetSessionPath(string accountId)
    {
        return Path.Combine(GetSessionsDirectory(), $"session-{SanitizeAccountId(accountId)}.json");
    }

    private static string GetSessionsDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            DataDirectoryName,
            QqBotDirectoryName,
            SessionsDirectoryName);
    }

    private static string SanitizeAccountId(string accountId)
    {
        var chars = accountId.Select(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '_' or '-'
                ? character
                : '_');
        return new string(chars.ToArray());
    }

    private static JsonNode? CloneElement(JsonElement element)
    {
        return JsonNode.Parse(element.GetRawText());
    }

    private static string ReadString(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : string.Empty;
    }

    private static long ReadLong(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<long>(out var result)
                ? result
                : 0;
    }

    private static bool HasNumber(JsonObject obj, string name)
    {
        return obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            (jsonValue.TryGetValue<long>(out _) || jsonValue.TryGetValue<double>(out _));
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
