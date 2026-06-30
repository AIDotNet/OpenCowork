internal sealed class WebModule : IWorkerModule
{
    public string Name => "web";

    public void Register(WorkerModuleContext context)
    {
        context.Register("web/search", WebRuntime.SearchAsync);
        context.Register("web/fetch", WebRuntime.FetchAsync);
    }
}
