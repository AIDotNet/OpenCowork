internal sealed class WorkerHostBuilder
{
    private readonly List<IWorkerModule> modules = [];
    private readonly HashSet<string> moduleNames = new(StringComparer.Ordinal);
    private WorkerEndpoint? endpoint;

    public WorkerHostBuilder UseDefaultModules()
    {
        foreach (var module in WorkerModuleCatalog.Default)
        {
            AddModule(module);
        }
        return this;
    }

    public WorkerHostBuilder AddModule(IWorkerModule module)
    {
        if (!moduleNames.Add(module.Name))
        {
            throw new InvalidOperationException($"Duplicate worker module: {module.Name}");
        }

        modules.Add(module);
        return this;
    }

    public WorkerHostBuilder UseEndpoint(WorkerEndpoint workerEndpoint)
    {
        endpoint = workerEndpoint;
        return this;
    }

    public WorkerHost Build()
    {
        if (endpoint is null)
        {
            throw new InvalidOperationException("Native worker IPC endpoint is required.");
        }

        var dispatcher = new WorkerDispatcher();
        var context = new WorkerModuleContext(dispatcher);

        foreach (var module in modules)
        {
            module.Register(context);
        }

        return new WorkerHost(new LocalIpcWorkerServer(dispatcher, endpoint));
    }
}
