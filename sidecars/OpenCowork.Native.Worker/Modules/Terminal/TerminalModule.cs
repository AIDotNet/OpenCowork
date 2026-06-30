internal sealed class TerminalModule : IWorkerModule
{
    public string Name => "terminal";

    public void Register(WorkerModuleContext context)
    {
        context.Register("terminal/create", TerminalTools.CreateAsync);
        context.Register("terminal/input", TerminalTools.InputAsync);
        context.Register("terminal/resize", TerminalTools.Resize);
        context.Register("terminal/kill", TerminalTools.Kill);
        context.Register("terminal/kill-all", TerminalTools.KillAll);
        context.Register("terminal/get", TerminalTools.Get);
        context.Register("terminal/list", TerminalTools.List);
    }
}
