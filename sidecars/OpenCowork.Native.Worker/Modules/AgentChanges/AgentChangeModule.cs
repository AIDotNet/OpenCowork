internal sealed class AgentChangeModule : IWorkerModule
{
    public string Name => "agent-changes";

    public void Register(WorkerModuleContext context)
    {
        context.Register("agent-changes/list-session-hydrated", AgentChangeRuntimeTools.ListSessionHydrated);
        context.Register("agent-changes/get-hydrated", AgentChangeRuntimeTools.GetHydrated);
        context.Register("agent-changes/diff-local", AgentChangeRuntimeTools.DiffLocal);
        context.Register("agent-changes/rollback-local-change", AgentChangeRuntimeTools.RollbackLocalChange);
    }
}
