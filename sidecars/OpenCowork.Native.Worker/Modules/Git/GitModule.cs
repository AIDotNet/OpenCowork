internal sealed class GitModule : IWorkerModule
{
    public string Name => "git";

    public void Register(WorkerModuleContext context)
    {
        context.Register("git/exec-local", GitTools.ExecLocalAsync);
        context.Register("git/exec", GitTools.ExecAsync);
        context.Register("git/scan-repositories", GitTools.ScanRepositoriesAsync);
        context.Register("git/status-detailed", GitTools.StatusDetailedAsync);
        context.Register("git/query", GitTools.QueryAsync);
        context.Register("git/query-local", GitTools.QueryLocalAsync);
    }
}
