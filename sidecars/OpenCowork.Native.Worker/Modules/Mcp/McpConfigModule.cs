internal sealed class McpConfigModule : IWorkerModule
{
    public string Name => "mcp-config";

    public void Register(WorkerModuleContext context)
    {
        context.Register("mcp/config-list", McpConfigStore.List);
        context.Register("mcp/config-get", McpConfigStore.Get);
        context.Register("mcp/config-add", McpConfigStore.Add);
        context.Register("mcp/config-update", McpConfigStore.Update);
        context.Register("mcp/config-remove", McpConfigStore.Remove);
    }
}
