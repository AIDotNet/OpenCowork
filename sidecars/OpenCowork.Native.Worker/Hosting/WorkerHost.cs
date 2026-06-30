internal sealed class WorkerHost
{
    private readonly LocalIpcWorkerServer server;

    internal WorkerHost(LocalIpcWorkerServer server)
    {
        this.server = server;
    }

    public static WorkerHost CreateDefault(WorkerEndpoint endpoint)
    {
        return new WorkerHostBuilder()
            .UseEndpoint(endpoint)
            .UseDefaultModules()
            .Build();
    }

    public Task RunAsync(CancellationToken cancellationToken = default)
    {
        return server.RunAsync(cancellationToken);
    }
}
