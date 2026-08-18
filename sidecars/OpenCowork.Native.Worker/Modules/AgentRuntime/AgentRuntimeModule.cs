internal sealed class AgentRuntimeModule : IWorkerModule
{
    public string Name => "agent-runtime";

    public void Register(WorkerModuleContext context)
    {
        AgentRuntimeDebugPayload.CleanupTempFiles();
        context.Register("initialize", AgentRuntimeTools.Initialize);
        context.Register("ping", AgentRuntimeTools.Ping);
        context.Register("shutdown", AgentRuntimeTools.Shutdown);
        context.Register("capabilities/check", AgentRuntimeTools.CheckCapability);
        context.RegisterJob(
            "agent/run",
            AgentRuntimeTools.ExecuteJobAsync,
            resultMode: "accepted",
            lanePolicy: "session");
        context.Register("agent/session-open", AgentRuntimeSessionHost.Open);
        context.RegisterJob(
            "agent/session-send",
            AgentRuntimeSessionHost.SendJobAsync,
            resultMode: "accepted",
            lanePolicy: "session");
        context.Register("agent/session-close", AgentRuntimeSessionHost.Close);
        context.Register("agent/cancel", AgentRuntimeTools.Cancel);
        context.Register("agent/cancel-subagent", AgentRuntimeTools.CancelSubAgent);
        context.Register("agent/request-stop", AgentRuntimeTools.RequestStop);
        context.Register("agent/append-messages", AgentRuntimeTools.AppendMessages);
        context.Register("agent/tool-results-lookup", AgentRuntimeToolResultJournal.Lookup);
        context.RegisterJob(
            "agent/compress-context",
            AgentRuntimeContextCompression.CompressAsync,
            lanePolicy: "session");
        context.Register("agent/debug-body-read", AgentRuntimeDebugPayload.ReadBody);
        context.Register("agent/reverse-response", AgentRuntimeTools.ReverseResponse);
        context.Register("agent/session-visibility", AgentRuntimeTools.SessionVisibility);
        context.Register("team-runtime/create", AgentRuntimeTeamRuntimeApi.Create);
        context.Register("team-runtime/delete", AgentRuntimeTeamRuntimeApi.Delete);
        context.Register("team-runtime/message-append", AgentRuntimeTeamRuntimeApi.AppendMessage);
        context.Register("team-runtime/snapshot", AgentRuntimeTeamRuntimeApi.Snapshot);
        context.Register("team-runtime/member-update", AgentRuntimeTeamRuntimeApi.UpdateMember);
        context.Register("team-runtime/manifest-update", AgentRuntimeTeamRuntimeApi.UpdateManifest);
        context.Register("team-runtime/messages-consume", AgentRuntimeTeamRuntimeApi.ConsumeMessages);
    }
}
