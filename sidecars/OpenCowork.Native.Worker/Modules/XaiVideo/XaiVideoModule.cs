internal sealed class XaiVideoModule : IWorkerModule
{
    public string Name => "xai-video";

    public void Register(WorkerModuleContext context)
    {
        context.Register("xai-video/generate", XaiVideoTools.GenerateAsync);
        context.Register("xai-video/status", XaiVideoTools.StatusAsync);
        context.Register("xai-video/download", XaiVideoTools.DownloadAsync);
    }
}
