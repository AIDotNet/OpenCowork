using System.Collections.Concurrent;

internal static class AgentRuntimeDeliveryGuard
{
    private static readonly ConcurrentDictionary<string, byte> CronDeliveryUsedByRunId =
        new(StringComparer.Ordinal);

    public static bool IsUsed(string runId)
    {
        return !string.IsNullOrWhiteSpace(runId) && CronDeliveryUsedByRunId.ContainsKey(runId);
    }

    public static void MarkUsed(string runId)
    {
        if (!string.IsNullOrWhiteSpace(runId))
        {
            CronDeliveryUsedByRunId.TryAdd(runId, 1);
        }
    }

    public static void ClearRun(string runId)
    {
        if (!string.IsNullOrWhiteSpace(runId))
        {
            CronDeliveryUsedByRunId.TryRemove(runId, out _);
        }
    }
}
