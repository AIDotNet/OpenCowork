internal sealed class ShellModule : IWorkerModule
{
    public string Name => "shell";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("shell/exec", ShellTools.ExecAsync, lanePolicy: "project");
        context.Register("shell/abort", ShellTools.Abort);
    }
}
