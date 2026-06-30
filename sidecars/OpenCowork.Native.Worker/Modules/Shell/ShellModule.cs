internal sealed class ShellModule : IWorkerModule
{
    public string Name => "shell";

    public void Register(WorkerModuleContext context)
    {
        context.Register("shell/exec", ShellTools.ExecAsync);
        context.Register("shell/abort", ShellTools.Abort);
    }
}
