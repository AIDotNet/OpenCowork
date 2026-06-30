internal sealed class AgentRuntimeModule : IWorkerModule
{
    public string Name => "agent-runtime";

    public void Register(WorkerModuleContext context)
    {
        context.Register("initialize", AgentRuntimeTools.Initialize);
        context.Register("ping", AgentRuntimeTools.Ping);
        context.Register("shutdown", AgentRuntimeTools.Shutdown);
        context.Register("capabilities/check", AgentRuntimeTools.CheckCapability);
        context.Register("agent/run", AgentRuntimeTools.RunAsync);
        context.Register("agent/cancel", AgentRuntimeTools.Cancel);
        context.Register("agent/append-messages", AgentRuntimeTools.AppendMessages);
        context.Register("agent/compress-context", AgentRuntimeContextCompression.CompressAsync);
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
