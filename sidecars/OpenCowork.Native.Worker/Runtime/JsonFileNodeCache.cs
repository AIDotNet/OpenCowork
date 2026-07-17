using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed class JsonFileNodeCache<TNode> where TNode : JsonNode
{
    private const long DefaultMaxCachedFileBytes = 2L * 1024 * 1024;
    private readonly long maxCachedFileBytes;
    private TNode? cached;
    private long cachedLength = -1;
    private long cachedWriteTicks = -1;

    public JsonFileNodeCache(long maxCachedFileBytes = DefaultMaxCachedFileBytes)
    {
        this.maxCachedFileBytes = Math.Max(0, maxCachedFileBytes);
    }

    public TNode? Read(
        string filePath,
        JsonValueKind expectedKind,
        Func<JsonElement, TNode?> clone,
        string label)
    {
        if (!File.Exists(filePath))
        {
            cached = null;
            cachedLength = -1;
            cachedWriteTicks = -1;
            return null;
        }

        try
        {
            var info = new FileInfo(filePath);
            if (cached is not null &&
                info.Length == cachedLength &&
                info.LastWriteTimeUtc.Ticks == cachedWriteTicks)
            {
                return (TNode)cached.DeepClone();
            }

            using var document = JsonDocument.Parse(File.ReadAllBytes(filePath));
            if (document.RootElement.ValueKind != expectedKind)
            {
                WorkerLog.Warn($"{label} has an invalid root type; ignoring content");
                return null;
            }

            var parsed = clone(document.RootElement);
            if (parsed is null)
            {
                return null;
            }
            Store(filePath, parsed);
            return parsed;
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"{label} read failed error={ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    public void Store(string filePath, TNode value)
    {
        var info = new FileInfo(filePath);
        cachedLength = info.Exists ? info.Length : -1;
        cachedWriteTicks = info.Exists ? info.LastWriteTimeUtc.Ticks : -1;
        cached = info.Exists && info.Length <= maxCachedFileBytes
            ? (TNode)value.DeepClone()
            : null;
    }
}
