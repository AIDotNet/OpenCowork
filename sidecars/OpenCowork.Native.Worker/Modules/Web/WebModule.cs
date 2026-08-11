internal sealed class WebModule : IWorkerModule
{
    public string Name => "web";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("web/search", WebRuntime.SearchAsync);
        context.RegisterJob("web/fetch", WebRuntime.FetchAsync);
    }
}
