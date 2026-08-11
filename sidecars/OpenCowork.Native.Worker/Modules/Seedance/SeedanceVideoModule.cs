internal sealed class SeedanceVideoModule : IWorkerModule
{
    public string Name => "seedance-video";

    public void Register(WorkerModuleContext context)
    {
        context.RegisterJob("seedance-video/generate", SeedanceVideoTools.GenerateAsync);
        context.Register("seedance-video/status", SeedanceVideoTools.StatusAsync);
        context.RegisterJob("seedance-video/download", SeedanceVideoTools.DownloadAsync);
    }
}
