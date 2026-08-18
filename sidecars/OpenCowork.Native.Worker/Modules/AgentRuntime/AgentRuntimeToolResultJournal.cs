using System.Text.Json;

/// <summary>
/// Read side of the per-tool durable journal (`runtime_tool_results`). The write side
/// lives on the emit path in <see cref="AgentRuntimeTools"/> so a result is on disk the
/// instant its tool finishes. This lookup lets the host reconcile a tool_use whose
/// tool_result never reached the messages table — after a renderer crash, an app kill,
/// or a worker recycle mid-turn — instead of telling the model the call was interrupted
/// and letting it silently re-run expensive work.
/// </summary>
internal static class AgentRuntimeToolResultJournal
{
    private const int MaxLookupIds = 256;

    public static WorkerResponse Lookup(JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId))
        {
            return WorkerResponse.Error("agent/tool-results-lookup requires sessionId");
        }

        var toolUseIds = ReadToolUseIds(parameters);
        if (toolUseIds.Count == 0)
        {
            return WorkerResponse.Json(
                new List<RuntimeToolResultRecord>(),
                WorkerJsonContext.Default.ListRuntimeToolResultRecord);
        }

        try
        {
            return WorkerResponse.Json(
                RuntimeJobStore.ListToolResults(sessionId, toolUseIds),
                WorkerJsonContext.Default.ListRuntimeToolResultRecord);
        }
        catch (Exception ex)
        {
            // Reconciliation is best-effort: an empty result falls back to the existing
            // "interrupted" healing path rather than blocking the next turn.
            WorkerLog.Warn(
                $"tool result journal lookup failed sessionId={sessionId} error={ex.Message}");
            return WorkerResponse.Json(
                new List<RuntimeToolResultRecord>(),
                WorkerJsonContext.Default.ListRuntimeToolResultRecord);
        }
    }

    private static List<string> ReadToolUseIds(JsonElement parameters)
    {
        var ids = new List<string>();
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("toolUseIds", out var array) ||
            array.ValueKind != JsonValueKind.Array)
        {
            return ids;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var element in array.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var id = element.GetString()?.Trim();
            if (string.IsNullOrEmpty(id) || !seen.Add(id))
            {
                continue;
            }
            ids.Add(id);
            if (ids.Count >= MaxLookupIds)
            {
                break;
            }
        }
        return ids;
    }
}
