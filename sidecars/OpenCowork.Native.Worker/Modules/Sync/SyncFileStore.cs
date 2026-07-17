using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class SyncFileStore
{
    private const string FileDomain = "file";
    private const string DataDirectoryName = ".open-cowork";
    private const string PromptCacheInstallIdConfigKey = "opencowork-prompt-cache-install-id";
    private const int DefaultCapturePageSize = 100;
    private const int MaxCapturePageSize = 500;
    private const long MaxSyncFileBytes = 16L * 1024 * 1024;

    private static readonly string[] DataFileIncludes =
    [
        "settings.json",
        "config.json",
        "plugins.json",
        "SOUL.md",
        "USER.md",
        "MEMORY.md"
    ];

    private static readonly string[] DataDirectoryIncludes = ["agents", "commands", "prompts", "memory", "ai-provider"];
    private static readonly string[] LocalOnlyConfigKeys = [PromptCacheInstallIdConfigKey];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    private static readonly JsonSerializerOptions StableJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<WorkerResponse> CaptureAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        try
        {
            var cursor = JsonHelpers.GetString(parameters, "cursor") ?? string.Empty;
            var limit = Math.Clamp(
                JsonHelpers.GetInt(parameters, "limit", DefaultCapturePageSize),
                1,
                MaxCapturePageSize);
            var page = await CaptureRecordsPageAsync(
                NormalizeRelativePath(cursor),
                limit,
                context.CancellationToken);
            return WriteCapturePage(page, null);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"sync file capture failed error={ex.GetType().Name}: {ex.Message}");
            return WriteCapturePage(new SyncFileCapturePage([], null, true), ex.Message);
        }
    }

    public static async Task<WorkerResponse> ApplyAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var changed = 0;
        var settingsChanged = false;

        try
        {
            foreach (var record in ReadRecords(parameters))
            {
                context.CancellationToken.ThrowIfCancellationRequested();
                if (!string.Equals(ReadString(record, "domain"), FileDomain, StringComparison.Ordinal))
                {
                    continue;
                }

                if (record["value"] is not JsonObject)
                {
                    throw new InvalidOperationException(
                        $"Invalid file sync record: {ReadString(record, "recordId") ?? "<unknown>"}");
                }

                var relativePath = ReadRecordRelativePath(record);
                if (!ShouldIncludeDataRelativePath(relativePath))
                {
                    throw new InvalidOperationException($"Refusing to write unsupported sync file: {relativePath}");
                }

                await ApplyRecordAsync(record, relativePath, context.CancellationToken);
                changed += 1;
                settingsChanged = settingsChanged || string.Equals(relativePath, "settings.json", StringComparison.Ordinal);
            }

            WorkerLog.Debug($"sync files apply changed={changed} settingsChanged={settingsChanged}");
            return ToResponse(Mutation(true, changed, settingsChanged, null));
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"sync files apply failed error={ex.GetType().Name}: {ex.Message}");
            return ToResponse(Mutation(false, changed, settingsChanged, ex.Message));
        }
    }

    public static Task<WorkerResponse> DeleteAsync(
        JsonElement parameters,
        WorkerRequestContext context)
    {
        var changed = 0;
        var settingsChanged = false;

        try
        {
            foreach (var recordId in ReadRecordIds(parameters))
            {
                context.CancellationToken.ThrowIfCancellationRequested();
                var relativePath = NormalizeRelativePath(recordId);
                if (!ShouldIncludeDataRelativePath(relativePath))
                {
                    continue;
                }

                if (string.Equals(relativePath, "plugins.json", StringComparison.Ordinal))
                {
                    ChannelConfigStore.ReplacePluginsFromSync([]);
                    changed += 1;
                    continue;
                }

                if (string.Equals(relativePath, "config.json", StringComparison.Ordinal))
                {
                    var localOnlyRoot = BuildLocalOnlyConfigRoot();
                    if (localOnlyRoot.Count > 0)
                    {
                        ConfigStore.ReplaceRootFromSync(localOnlyRoot);
                    }
                    else if (ResolveDataRelativePath(relativePath) is { } configPath &&
                        File.Exists(configPath))
                    {
                        File.Delete(configPath);
                    }
                    changed += 1;
                    continue;
                }

                var targetPath = ResolveDataRelativePath(relativePath);
                if (targetPath is null || !File.Exists(targetPath))
                {
                    continue;
                }

                File.Delete(targetPath);
                changed += 1;
                settingsChanged = settingsChanged ||
                    string.Equals(relativePath, "settings.json", StringComparison.Ordinal);
            }

            WorkerLog.Debug($"sync files delete changed={changed} settingsChanged={settingsChanged}");
            return Task.FromResult(ToResponse(Mutation(true, changed, settingsChanged, null)));
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"sync files delete failed error={ex.GetType().Name}: {ex.Message}");
            return Task.FromResult(ToResponse(Mutation(false, changed, settingsChanged, ex.Message)));
        }
    }

    private static async Task<SyncFileCapturePage> CaptureRecordsPageAsync(
        string cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        var records = new List<SyncFileCapturedRecord>(limit);
        using var enumerator = EnumerateSyncFilesAfter(cursor).GetEnumerator();
        while (records.Count < limit && enumerator.MoveNext())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var filePath = enumerator.Current.FilePath;
            var relativePath = enumerator.Current.RelativePath;
            var length = new FileInfo(filePath).Length;
            if (length > MaxSyncFileBytes)
            {
                throw new InvalidOperationException(
                    $"Sync file exceeds the {MaxSyncFileBytes} byte limit: {relativePath}");
            }

            var data = Convert.ToBase64String(await ReadFileBytesForSyncAsync(
                relativePath,
                filePath,
                cancellationToken));
            var updatedAt = (long)Math.Floor(
                (File.GetLastWriteTimeUtc(filePath) - DateTime.UnixEpoch).TotalMilliseconds);

            records.Add(new SyncFileCapturedRecord(
                relativePath,
                data,
                HashFileValue(relativePath, data),
                updatedAt));
        }

        var hasMore = enumerator.MoveNext();
        var nextCursor = hasMore && records.Count > 0 ? records[^1].RelativePath : null;
        WorkerLog.Debug(
            $"sync file capture records={records.Count} done={!hasMore} cursorSet={nextCursor is not null}");
        return new SyncFileCapturePage(records, nextCursor, !hasMore);
    }

    private static async Task ApplyRecordAsync(
        JsonObject record,
        string relativePath,
        CancellationToken cancellationToken)
    {
        var targetPath = ResolveDataRelativePath(relativePath);
        if (targetPath is null)
        {
            throw new InvalidOperationException($"Invalid sync file path: {relativePath}");
        }

        var data = ReadRecordData(record);
        var buffer = string.IsNullOrEmpty(data) ? Array.Empty<byte>() : Convert.FromBase64String(data);

        if (string.Equals(relativePath, "settings.json", StringComparison.Ordinal))
        {
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer)) is not JsonObject settingsRoot)
            {
                throw new InvalidOperationException("Invalid settings sync file");
            }

            SettingsStore.ReplaceRootFromSync(settingsRoot);
            return;
        }

        if (string.Equals(relativePath, "config.json", StringComparison.Ordinal))
        {
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer)) is not JsonObject configRoot)
            {
                throw new InvalidOperationException("Invalid config sync file");
            }

            PreserveLocalConfigValues(configRoot);
            ConfigStore.ReplaceRootFromSync(configRoot);
            return;
        }

        if (string.Equals(relativePath, "plugins.json", StringComparison.Ordinal))
        {
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer)) is not JsonArray plugins)
            {
                throw new InvalidOperationException("Invalid channel plugin sync file");
            }

            ChannelConfigStore.ReplacePluginsFromSync(plugins);
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        var tempPath = $"{targetPath}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllBytesAsync(tempPath, buffer, cancellationToken);
        File.Move(tempPath, targetPath, true);
    }

    private static async Task<byte[]> ReadFileBytesForSyncAsync(
        string relativePath,
        string filePath,
        CancellationToken cancellationToken)
    {
        var bytes = await File.ReadAllBytesAsync(filePath, cancellationToken);
        if (!string.Equals(relativePath, "config.json", StringComparison.Ordinal))
        {
            return bytes;
        }

        if (JsonNode.Parse(Encoding.UTF8.GetString(bytes)) is not JsonObject configRoot)
        {
            throw new InvalidOperationException("Invalid config sync file");
        }

        RemoveLocalOnlyConfigValues(configRoot);
        return Encoding.UTF8.GetBytes(configRoot.ToJsonString(JsonOptions));
    }

    private static void PreserveLocalConfigValues(JsonObject nextConfig)
    {
        var localConfig = ConfigStore.ReadRootSnapshot();
        PreserveLocalSyncDeviceId(nextConfig, localConfig);

        RemoveLocalOnlyConfigValues(nextConfig);
        CopyLocalOnlyConfigValues(localConfig, nextConfig);
    }

    private static void PreserveLocalSyncDeviceId(JsonObject nextConfig, JsonObject localConfig)
    {
        if (nextConfig["sync"] is not JsonObject nextSync)
        {
            return;
        }

        var localDeviceId = ReadNodeString(localConfig["sync"] as JsonObject, "deviceId");
        nextSync["deviceId"] = string.IsNullOrWhiteSpace(localDeviceId)
            ? Guid.NewGuid().ToString()
            : localDeviceId;
    }

    private static JsonObject BuildLocalOnlyConfigRoot()
    {
        var root = new JsonObject();
        CopyLocalOnlyConfigValues(ConfigStore.ReadRootSnapshot(), root);
        return root;
    }

    private static void RemoveLocalOnlyConfigValues(JsonObject config)
    {
        foreach (var key in LocalOnlyConfigKeys)
        {
            config.Remove(key);
        }
    }

    private static void CopyLocalOnlyConfigValues(JsonObject source, JsonObject target)
    {
        foreach (var key in LocalOnlyConfigKeys)
        {
            if (source.TryGetPropertyValue(key, out var value) && value is not null)
            {
                target[key] = value.DeepClone();
            }
        }
    }

    private static IEnumerable<string> WalkFiles(string rootPath)
    {
        if (File.Exists(rootPath))
        {
            yield return rootPath;
            yield break;
        }

        if (!Directory.Exists(rootPath))
        {
            yield break;
        }

        foreach (var entry in Directory
            .EnumerateFileSystemEntries(rootPath)
            .OrderBy(static entry => entry, StringComparer.Ordinal))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                continue;
            }

            if ((attributes & FileAttributes.Directory) != 0)
            {
                foreach (var child in WalkFiles(entry))
                {
                    yield return child;
                }
            }
            else
            {
                yield return entry;
            }
        }
    }

    private static IEnumerable<SyncFilePath> EnumerateSyncFilesAfter(string cursor)
    {
        var dataDir = GetDataDir();
        var roots = DataFileIncludes
            .Concat(DataDirectoryIncludes)
            .OrderBy(static value => value, StringComparer.Ordinal);
        foreach (var root in roots)
        {
            foreach (var filePath in WalkFiles(Path.Combine(dataDir, root)))
            {
                var relativePath = GetDataRelativePath(filePath);
                if (relativePath is null ||
                    !ShouldIncludeDataRelativePath(relativePath) ||
                    string.Compare(relativePath, cursor, StringComparison.Ordinal) <= 0)
                {
                    continue;
                }

                yield return new SyncFilePath(filePath, relativePath);
            }
        }
    }

    private static IEnumerable<JsonObject> ReadRecords(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("records", out var recordsElement) ||
            recordsElement.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var recordElement in recordsElement.EnumerateArray())
        {
            if (CloneElement(recordElement) is JsonObject record)
            {
                yield return record;
            }
        }
    }

    private static IEnumerable<string> ReadRecordIds(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("recordIds", out var idsElement) ||
            idsElement.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var idElement in idsElement.EnumerateArray())
        {
            if (idElement.ValueKind == JsonValueKind.String &&
                idElement.GetString() is { Length: > 0 } id)
            {
                yield return id;
            }
        }
    }

    private static string ReadRecordRelativePath(JsonObject record)
    {
        var recordId = ReadString(record, "recordId") ?? string.Empty;
        if (record["value"] is JsonObject value &&
            ReadNodeString(value, "path") is { Length: > 0 } path)
        {
            return NormalizeRelativePath(path);
        }

        return NormalizeRelativePath(recordId);
    }

    private static string ReadRecordData(JsonObject record)
    {
        return record["value"] is JsonObject value
            ? ReadNodeString(value, "data") ?? string.Empty
            : string.Empty;
    }

    private static string? GetDataRelativePath(string filePath)
    {
        var relativePath = Path.GetRelativePath(GetDataDir(), filePath);
        if (string.IsNullOrEmpty(relativePath) ||
            relativePath.StartsWith("..", StringComparison.Ordinal) ||
            Path.IsPathRooted(relativePath))
        {
            return null;
        }

        return NormalizeRelativePath(relativePath);
    }

    private static string? ResolveDataRelativePath(string relativePath)
    {
        if (Path.IsPathRooted(relativePath))
        {
            return null;
        }

        var normalized = NormalizeRelativePath(relativePath);
        if (string.IsNullOrEmpty(normalized) ||
            normalized.StartsWith("/", StringComparison.Ordinal) ||
            normalized.Split('/').Any(part => part == ".."))
        {
            return null;
        }

        return Path.Combine(new[] { GetDataDir() }.Concat(normalized.Split('/')).ToArray());
    }

    private static bool ShouldIncludeDataRelativePath(string relativePath)
    {
        var normalized = NormalizeRelativePath(relativePath);
        if (DataFileIncludes.Contains(normalized, StringComparer.Ordinal))
        {
            return true;
        }

        return DataDirectoryIncludes.Any(dir =>
            string.Equals(normalized, dir, StringComparison.Ordinal) ||
            normalized.StartsWith($"{dir}/", StringComparison.Ordinal));
    }

    private static string NormalizeRelativePath(string relativePath)
    {
        return relativePath.Replace('\\', '/');
    }

    private static string GetDataDir()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            DataDirectoryName);
    }

    private static string HashValue(JsonNode? value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(StableStringify(value)));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string HashFileValue(string relativePath, string base64Data)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendUtf8(hash, "{\"data\":\"");
        AppendUtf8Chunked(hash, base64Data);
        AppendUtf8(hash, $"\",\"path\":{QuoteString(relativePath)}}}");
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static void AppendUtf8(IncrementalHash hash, string value)
    {
        hash.AppendData(Encoding.UTF8.GetBytes(value));
    }

    private static void AppendUtf8Chunked(IncrementalHash hash, string value)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(32 * 1024);
        try
        {
            var offset = 0;
            while (offset < value.Length)
            {
                var charCount = Math.Min(16 * 1024, value.Length - offset);
                var byteCount = Encoding.UTF8.GetBytes(
                    value.AsSpan(offset, charCount),
                    buffer.AsSpan());
                hash.AppendData(buffer.AsSpan(0, byteCount));
                offset += charCount;
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static WorkerResponse WriteCapturePage(SyncFileCapturePage page, string? error)
    {
        return WorkerResponse.DirectMessagePack(writer =>
        {
            writer.WriteMapHeader(5);
            writer.WriteString("success");
            writer.WriteBoolean(error is null);
            writer.WriteString("records");
            writer.WriteArrayHeader(page.Records.Count);
            foreach (var record in page.Records)
            {
                writer.WriteMapHeader(5);
                writer.WriteString("domain");
                writer.WriteString(FileDomain);
                writer.WriteString("recordId");
                writer.WriteString(record.RelativePath);
                writer.WriteString("hash");
                writer.WriteString(record.Hash);
                writer.WriteString("value");
                writer.WriteMapHeader(2);
                writer.WriteString("path");
                writer.WriteString(record.RelativePath);
                writer.WriteString("data");
                writer.WriteString(record.Base64Data);
                writer.WriteString("updatedAt");
                writer.WriteInt64(record.UpdatedAt);
            }
            writer.WriteString("nextCursor");
            if (page.NextCursor is { Length: > 0 })
            {
                writer.WriteString(page.NextCursor);
            }
            else
            {
                writer.WriteNil();
            }
            writer.WriteString("done");
            writer.WriteBoolean(page.Done);
            writer.WriteString("error");
            if (error is { Length: > 0 })
            {
                writer.WriteString(error);
            }
            else
            {
                writer.WriteNil();
            }
        });
    }

    private static string StableStringify(JsonNode? value)
    {
        if (value is null)
        {
            return "null";
        }

        if (value is JsonArray array)
        {
            return $"[{string.Join(",", array.Select(StableStringify))}]";
        }

        if (value is JsonObject obj)
        {
            return "{" + string.Join(
                ",",
                obj.OrderBy(property => property.Key, StringComparer.Ordinal)
                    .Select(property => $"{QuoteString(property.Key)}:{StableStringify(property.Value)}")) + "}";
        }

        return value.ToJsonString(StableJsonOptions);
    }

    private static string QuoteString(string value)
    {
        using var stream = new MemoryStream();
        using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        });
        writer.WriteStringValue(value);
        writer.Flush();
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static JsonNode? CloneElement(JsonElement element)
    {
        return JsonNode.Parse(element.GetRawText());
    }

    private static string? ReadString(JsonObject obj, string name)
    {
        return ReadNodeString(obj, name);
    }

    private static string? ReadNodeString(JsonObject? obj, string name)
    {
        return obj is not null &&
            obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    private static JsonObject Mutation(bool success, int changed, bool settingsChanged, string? error)
    {
        var result = new JsonObject
        {
            ["success"] = success,
            ["changed"] = changed,
            ["settingsChanged"] = settingsChanged
        };
        if (!string.IsNullOrWhiteSpace(error))
        {
            result["error"] = error;
        }
        return result;
    }

    private static WorkerResponse ToResponse(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString(JsonOptions));
    }

    private sealed record SyncFilePath(string FilePath, string RelativePath);

    private sealed record SyncFileCapturedRecord(
        string RelativePath,
        string Base64Data,
        string Hash,
        long UpdatedAt);

    private sealed record SyncFileCapturePage(
        List<SyncFileCapturedRecord> Records,
        string? NextCursor,
        bool Done);
}
