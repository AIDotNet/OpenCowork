internal sealed class GitModule : IWorkerModule
{
    public string Name => "git";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("git/exec-local", GitTools.ExecLocalAsync, lanePolicy: "project");
        context.RegisterJob("git/exec", GitTools.ExecAsync, lanePolicy: "project");
        context.RegisterJob("git/scan-repositories", GitTools.ScanRepositoriesAsync, lanePolicy: "project");
        context.RegisterJob("git/status-detailed", GitTools.StatusDetailedAsync, lanePolicy: "project");
        context.RegisterJob("git/query", GitTools.QueryAsync, lanePolicy: "project");
        context.RegisterJob("git/query-local", GitTools.QueryLocalAsync, lanePolicy: "project");
    }
}
