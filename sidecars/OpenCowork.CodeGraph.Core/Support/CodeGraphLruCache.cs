// A small move-to-end LRU cache backed by a Dictionary + LinkedList, mirroring
// the CodeGraph TS QueryBuilder nodeCache (queries.ts:200-202, 679-688): a JS Map
// abused as an LRU with a hard cap (1000). Semantics reproduced exactly:
//   * a cache HIT moves the entry to the most-recently-used end (delete + re-set),
//   * Set past capacity evicts the least-recently-used (oldest) entry first,
//   * Remove / RemoveWhere back the write-path cache invalidation.
//
// Not thread-safe: the owning CodeGraphStore serializes all access to its single
// SQLite connection, so the cache inherits that single-threaded discipline. Keep
// it out of any parallel path.
internal sealed class CodeGraphLruCache<TKey, TValue>
    where TKey : notnull
{
    private readonly int capacity;
    private readonly Dictionary<TKey, LinkedListNode<Entry>> map;

    // First node = least-recently-used (eviction target); Last node = most-recent.
    private readonly LinkedList<Entry> order;

    public CodeGraphLruCache(int capacity)
    {
        if (capacity < 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(capacity), capacity, "LRU capacity must be >= 1.");
        }

        this.capacity = capacity;
        map = new Dictionary<TKey, LinkedListNode<Entry>>(capacity);
        order = new LinkedList<Entry>();
    }

    public int Count => map.Count;

    public int Capacity => capacity;

    // Cache hit: move the entry to the MRU end (the LRU "touch") and return true.
    public bool TryGet(TKey key, out TValue value)
    {
        if (map.TryGetValue(key, out var node))
        {
            order.Remove(node);
            order.AddLast(node);
            value = node.Value.Value;
            return true;
        }

        value = default!;
        return false;
    }

    // Insert or update, moving the entry to the MRU end; when a fresh key pushes
    // the cache over capacity, the LRU (front) entry is evicted first.
    public void Set(TKey key, TValue value)
    {
        if (map.TryGetValue(key, out var existing))
        {
            existing.Value = new Entry(key, value);
            order.Remove(existing);
            order.AddLast(existing);
            return;
        }

        if (map.Count >= capacity)
        {
            var oldest = order.First;
            if (oldest is not null)
            {
                order.RemoveFirst();
                map.Remove(oldest.Value.Key);
            }
        }

        var node = order.AddLast(new Entry(key, value));
        map[key] = node;
    }

    // Explicit invalidation (deleteNode / insertNode-or-replace / updateNode).
    public bool Remove(TKey key)
    {
        if (map.TryGetValue(key, out var node))
        {
            order.Remove(node);
            map.Remove(key);
            return true;
        }

        return false;
    }

    // Remove every entry whose (key, value) matches the predicate — the
    // deleteNodesByFile cache sweep (queries.ts:472-478). Collects matches from a
    // snapshot pass first so mutation during iteration is safe. Returns the count.
    public int RemoveWhere(Func<TKey, TValue, bool> predicate)
    {
        List<TKey>? doomed = null;
        foreach (var entry in order)
        {
            if (predicate(entry.Key, entry.Value))
            {
                (doomed ??= new List<TKey>()).Add(entry.Key);
            }
        }

        if (doomed is null)
        {
            return 0;
        }

        foreach (var key in doomed)
        {
            Remove(key);
        }

        return doomed.Count;
    }

    public void Clear()
    {
        map.Clear();
        order.Clear();
    }

    private readonly struct Entry
    {
        public Entry(TKey key, TValue value)
        {
            Key = key;
            Value = value;
        }

        public TKey Key { get; }

        public TValue Value { get; }
    }
}
