internal sealed class SystemModule : IWorkerModule
{
    public string Name => "system";

    public void Register(WorkerModuleContext context)
    {
        context.Register("worker/ping", _ =>
            WorkerResponse.Json(
                new StatusResult(true, Environment.ProcessId),
                WorkerJsonContext.Default.StatusResult));
        context.Register("worker/routes", _ =>
            WorkerResponse.Json(
                new WorkerRoutesResult(context.GetRegisteredMethods()),
                WorkerJsonContext.Default.WorkerRoutesResult));
    }
}
