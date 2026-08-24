/// <summary>
/// Composition root for the HTTP transport.
///
/// Mirrors what <c>WorkerHostBuilder.Build()</c> does — one dispatcher, every module in
/// <see cref="WorkerModuleCatalog.Default"/> registered against it — and then serves it
/// over HTTP instead of the local IPC sockets. The builder in the shared submodule is
/// hard-wired to <c>LocalIpcWorkerServer</c>, so the swap lives here rather than as a
/// two-repo change; module registration order is identical, which matters because the
/// durable scheduler binds only after every Job route exists.
/// </summary>
internal sealed class HttpWorkerHost
{
    private readonly HttpWorkerServer server;

    private HttpWorkerHost(HttpWorkerServer server)
    {
        this.server = server;
    }

    public static HttpWorkerHost CreateDefault(HttpWorkerEndpoint endpoint)
    {
        var dispatcher = new WorkerDispatcher();
        var context = new WorkerModuleContext(dispatcher);
        var moduleNames = new HashSet<string>(StringComparer.Ordinal);

        foreach (var module in WorkerModuleCatalog.Default)
        {
            if (!moduleNames.Add(module.Name))
            {
                throw new InvalidOperationException($"Duplicate worker module: {module.Name}");
            }
            module.Register(context);
        }

        return new HttpWorkerHost(new HttpWorkerServer(dispatcher, endpoint));
    }

    public Task RunAsync(CancellationToken cancellationToken = default)
    {
        return server.RunAsync(cancellationToken);
    }
}
