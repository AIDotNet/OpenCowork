internal static class AgentRuntimeIdentities
{
    public static string NewRunId()
    {
        return Guid.NewGuid().ToString();
    }

    public static string AssistantMessageIdForRun(string runId)
    {
        return $"asst:{runId}";
    }
}
